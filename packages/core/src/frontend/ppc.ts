// asmlift ISA frontend — PowerPC (GameCube/Wii, Metrowerks CodeWarrior `mwcceppc`). Input is
// disassembled text (`powerpc-eabi-objdump -d --no-show-raw-insn`), parsed by the shared
// `parseDisasm` with the reloc + branch-hint options enabled.
//
// ISA facts that shape this frontend:
//  • NO DELAY SLOTS — a block simply ends at its terminator.
//  • CONDITION REGISTERS, FUSED — a compare (`cmpw`/`cmpwi`; unsigned `cmplw`/`cmplwi`) is tracked
//    and the branch that reads it fuses into a single `cond_br icmp_*`. The branch MNEMONIC
//    carries the sense (`bge` ⇒ `icmp_sge`), so no negation fold is needed; an unsigned compare
//    picks the unsigned icmp row.
//  • CONDITIONAL RETURN — `cmpwi r3,0; bgelr` is "if cr0≥0, return r3". The `bXXlr` forms become a
//    cond_br to a SYNTHETIC return block, so the structurer sees an ordinary divergent-if.
//  • EXTENDED MNEMONICS — objdump prints the simplified forms: `mr`, `li`, `subf` (reversed
//    operands: `subf rD,rA,rB` = rB−rA), `not`, and the rotate-and-mask family.
//    `slwi`/`srwi`/`clrlwi`/`clrrwi` and rotate-0 `rlwinm` are exact; a non-zero-rotate `rlwinm`
//    lowers only as the right-shift bitfield extract `(x>>n)&mask` (ME=31, non-wrapping); a
//    genuine rotate/insert stays an opaque.
//  • CALLS (`bl`) — the callee symbol comes from the interleaved `R_PPC_REL24` relocation (an
//    unresolved `bl` in a .o encodes a 0 placeholder); arguments come from r3.. per the callee
//    prototype (falling back to argument-register liveness). The frame — `stwu r1`, `mflr`/`mtlr`,
//    r1-relative spills — is transparent to dataflow, so a value in a callee-saved register
//    survives the call.
//  • RECORD FORM (`.` = the Rc bit, e.g. `andi.`/`add.`) also sets cr0 from a signed compare of
//    the result against 0; that implicit compare is wired so a following `beq`/`bne` fuses.
//
// TRUSTWORTHINESS: an unmodelled instruction with a register destination emits an `opaque` value
// (dead ⇒ vanishes, live ⇒ fails LOUD downstream); an unmodelled CONTROL TRANSFER throws
// PpcUnsupportedError in `lift`. Never plausible-but-wrong C.
//
// Scope: straight-line + `if`/diamond integer functions (incl. the conditional-return idiom),
// non-recursive `bl` calls, recovered dense-switch jump tables, and CTR-counted `bdnz` loops
// (`mtctr` seeds a `ctr` pseudo-register). Returns through r3. Out of scope, failing loud: the
// conditional-CTR forms (`bdz`/`bdnzt`/…), an unrecovered `bctr`, and a `bdnz` with no reaching
// `mtctr`. NOTE mwcc at -O4 aggressively UNROLLS loops into a `bdnz` main loop + a remainder
// loop; an unrolled loop recovers as the unrolled form (sound, rarely a match).
import { Fn, Op, Successor, Value, mkOp, mkValue } from '../ir/core';
import type { Opcode } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Prototypes, protoArity } from '../proto';
import type { TargetDescription } from '../target';
import { type AsmData, readJumpTable } from './asmdata';
import {
  type DisasmInstr,
  parseImm,
  parseDisasm as parseSharedDisasm,
  parseMem as parseSharedMem,
  sliceSymbol,
} from './disasm';
import { mkEmitKit, pushSwitchBr } from './emit';
import { FrontendUnsupportedError } from './errors';
import { assertInputFormat } from './format';
import type { Frontend } from './frontend';
import { opaqueDest } from './opaque';
import { abiSortEntryParams } from './ssa';
import { makeSsaBuilder } from './ssa';

type Instr = DisasmInstr;

// Branch-condition mnemonic → the icmp for its TAKEN edge, split by compare signedness. PowerPC's
// branch already names the relation (no negation fold needed). `signed` picks the row.
const COND_SIGNED: Record<string, Opcode> = {
  blt: 'icmp_slt',
  ble: 'icmp_sle',
  bgt: 'icmp_sgt',
  bge: 'icmp_sge',
  beq: 'icmp_eq',
  bne: 'icmp_ne',
};
const COND_UNSIGNED: Record<string, Opcode> = {
  blt: 'icmp_ult',
  ble: 'icmp_ule',
  bgt: 'icmp_ugt',
  bge: 'icmp_uge',
  beq: 'icmp_eq',
  bne: 'icmp_ne',
};
const CONDS = new Set(Object.keys(COND_SIGNED));

// Out-of-scope control flow (conditional-CTR forms `bdz`/`bdnzt`/…, indirect `bctr`/`bctrl`, …).
// PowerPC branch mnemonics all start with `b`; anything not in `isModeledBranch` is a real branch
// this frontend cannot lower, and silently dropping a branch is a silent miscompile — so `lift`
// throws a catchable "out of scope" signal instead. Subclasses the shared frontend signal so
// consumers can `instanceof FrontendUnsupportedError`; `.name` kept for stable stub text.
export class PpcUnsupportedError extends FrontendUnsupportedError {
  constructor(message: string) {
    super(message);
    this.name = 'PpcUnsupportedError';
  }
}

const isReturn = (ins: Instr) => ins.mnemonic === 'blr';
const isUncond = (ins: Instr) => ins.mnemonic === 'b';
const isCond = (ins: Instr) => CONDS.has(ins.mnemonic) && ins.target !== undefined;
// Conditional return, e.g. `bgelr`/`bltlr`: a cond mnemonic with the `lr` suffix and no target.
const condReturnBase = (ins: Instr): string | null => {
  if (!ins.mnemonic.endsWith('lr')) {
    return null;
  }
  const base = 'b' + ins.mnemonic.slice(1, -2);
  return CONDS.has(base) ? base : null;
};
const isCondReturn = (ins: Instr) => condReturnBase(ins) !== null;
// `bdnz L` — CTR ← CTR−1; branch to L if CTR ≠ 0. The ONLY CTR form modelled — `bdz`, the
// conditional-CTR forms (`bdnzt`/`bdzf`/…), and the indirect `bctr`/`bctrl` fail loud (below).
// A `bdnz` with no target is malformed.
const isCtrLoop = (ins: Instr) => ins.mnemonic === 'bdnz' && ins.target !== undefined;
const isXfer = (ins: Instr) => isReturn(ins) || isUncond(ins) || isCond(ins) || isCondReturn(ins) || isCtrLoop(ins);
// `bl` is a CALL (mid-block, control returns), not a block transfer, so it is modelled but not in
// isXfer. Every other `b*` mnemonic is a branch we can lower iff it is one of these forms.
const isModeledBranch = (ins: Instr) => isXfer(ins) || ins.mnemonic === 'bl';

const isReg = (s: string | undefined): s is string => /^r\d+$/.test(s ?? '');

// Shared objdump scaffolding (frontend/disasm.ts). parseMem narrowed to `r\d+` bases — a
// non-register base is an SDA/global placeholder assertOrdinaryMem declines.
const parseMem = (operand: string): { off: number; base: string } => parseSharedMem(operand, /r\d+/);

// 32-bit mask with bits [mb..me] set (PowerPC bit numbering: 0 = MSB). Wraps when mb > me.
const rlwinmMask = (mb: number, me: number): number => {
  let m = 0;
  for (let b = 0; b < 32; b++) {
    const set = mb <= me ? b >= mb && b <= me : b >= mb || b <= me;
    if (set) {
      m |= 0x80000000 >>> b;
    }
  }
  return m >>> 0;
};

// Shared objdump scaffolding (frontend/disasm.ts), with the two PPC extras threaded as options:
// reloc lines (`-r` — the callee symbol for a `bl` whose encoded offset is a placeholder) and
// branch-prediction hint suffixes (`blt-`/`bge+` — a hint, not a different instruction; without
// stripping, the mnemonic misses the cond tables and the branch is silently dropped).
const parseDisasm = (disasm: string): Instr[] => parseSharedDisasm(disasm, { relocs: true, hintSuffixes: true });

interface PpcBlock {
  startAddr: number;
  body: Instr[];
  branch: Instr | null; // terminating transfer (or null for a pure fall-through)
  synthReturn?: boolean; // a synthetic block that just returns the return register
}

// A recovered dense-switch jump table (Regime B), keyed
// by the BOUNDS branch (`bgt DEF`) whose block emits the `switch_br`. `caseAddrs[k]` is the `.text`
// address of case `k` (dense 0..N-1); `bctrAddr` is the elided dispatch's indirect jump. The mwcc
// idiom:
//   cmplwi rS,N-1 ; bgt DEF                                        (bounds)
//   lis rT,0 [ADDR16_HA @tbl] ; slwi rIdx,rS,2 ; addi rB,rT,0 [ADDR16_LO @tbl]
//   ; lwzx rV,rB,rIdx ; mtctr rV ; bctr                           (dispatch — table in .data)
interface PpcJT {
  scrutReg: string;
  caseAddrs: number[];
  defaultAddr: number;
  bctrAddr: number;
}

// Recover mwcc jump tables from the dispatch idiom + the AsmData side-table. Fail-closed: any
// deviation from the exact idiom, or a table that doesn't resolve to N in-function targets, declines
// (→ the `bctr` loud-fail fires). Index IDENTITY guard: `slwi rIdx,rS,2` must be the bounds-checked
// scrutinee scaled only by <<2 — no xor/neg/extra op.
function recoverPpcJumpTables(instrs: Instr[], ad: AsmData): Map<number, PpcJT> {
  const out = new Map<number, PpcJT>();
  for (let i = 5; i < instrs.length; i++) {
    if (instrs[i].mnemonic !== 'bctr') {
      continue;
    }
    const [lis, slwi, addi, lwzx, mtctr] = [instrs[i - 5], instrs[i - 4], instrs[i - 3], instrs[i - 2], instrs[i - 1]];
    if (
      lis.mnemonic !== 'lis' ||
      slwi.mnemonic !== 'slwi' ||
      addi.mnemonic !== 'addi' ||
      lwzx.mnemonic !== 'lwzx' ||
      mtctr.mnemonic !== 'mtctr'
    ) {
      continue;
    }
    const rV = mtctr.ops[0];
    if (lwzx.ops[0] !== rV) {
      continue;
    } // rV = mem[rB + rIdx]
    const [rB, rIdx] = [lwzx.ops[1], lwzx.ops[2]];
    if (slwi.ops[0] !== rIdx || (slwi.ops[2] !== '2' && slwi.ops[2] !== '0x2')) {
      continue;
    } // identity: rIdx = rS<<2
    const scrutReg = slwi.ops[1];
    if (addi.ops[0] !== rB || parseImm(addi.ops[2]) !== 0) {
      continue;
    } // rB = &table (lo) + 0
    const rT = addi.ops[1];
    const tableSym = lis.sym; // ADDR16_HA/LO @tbl (from inline -r reloc)
    if (lis.ops[0] !== rT || !tableSym || addi.sym !== tableSym) {
      continue;
    }
    // Bounds: the nearest preceding `cmplwi scrutReg,N-1 ; bgt DEF` guard. The `bgt` is itself a
    // transfer, so match the pair directly (the cmplwi sits one instruction behind it); a different
    // transfer before the guard ⇒ decline.
    let bounds: { addr: number; n: number; def: number } | null = null;
    for (let j = i - 6; j >= 1; j--) {
      const bgt = instrs[j];
      if (bgt.mnemonic === 'bgt' && bgt.target !== undefined) {
        const c = instrs[j - 1];
        if (c && c.mnemonic === 'cmplwi' && c.ops[c.ops.length - 2] === scrutReg) {
          bounds = { addr: bgt.addr, n: parseImm(c.ops[c.ops.length - 1]) + 1, def: bgt.target };
        }
        break;
      }
      if (isXfer(bgt)) {
        break;
      }
    }
    if (!bounds || bounds.n < 2) {
      continue;
    }
    const caseAddrs = readJumpTable(ad, tableSym, 0, bounds.n);
    if (!caseAddrs) {
      continue;
    }
    out.set(bounds.addr, { scrutReg, caseAddrs, defaultAddr: bounds.def, bctrAddr: instrs[i].addr });
  }
  return out;
}

// Split into basic blocks and compute successor block INDICES (order [taken, fall] for a cond
// branch/return). Conditional-return branches get a synthetic return block as their taken edge.
// A recovered jump table (`jts`, keyed by bounds-branch addr) turns its bounds block into a
// `switch_br` dispatcher: the case + default addresses become leaders and its only successors.
function toBlocks(instrs: Instr[], name: string, jts: Map<number, PpcJT>): { blocks: PpcBlock[]; succIdx: number[][] } {
  const leaders = new Set<number>(instrs.length ? [instrs[0].addr] : []);
  instrs.forEach((ins, i) => {
    if ((isCond(ins) || isUncond(ins) || isCtrLoop(ins)) && ins.target !== undefined) {
      leaders.add(ins.target);
    }
    if ((isCond(ins) || isCondReturn(ins) || isCtrLoop(ins)) && instrs[i + 1]) {
      leaders.add(instrs[i + 1].addr);
    } // fall-through
  });
  for (const jt of jts.values()) {
    for (const a of jt.caseAddrs) {
      leaders.add(a);
    }
    leaders.add(jt.defaultAddr);
  }

  const blocks: PpcBlock[] = [];
  let cur: PpcBlock | null = null;
  for (const ins of instrs) {
    if (cur === null || leaders.has(ins.addr)) {
      cur = { startAddr: ins.addr, body: [], branch: null };
      blocks.push(cur);
    }
    if (isXfer(ins)) {
      cur.branch = ins;
      cur = null;
    } else {
      cur.body.push(ins);
    }
  }

  const idxOf = new Map(blocks.map((b, i) => [b.startAddr, i]));
  const fallAddr = (b: PpcBlock) => (b.branch ?? b.body[b.body.length - 1]).addr + 4;
  const succIdx: number[][] = blocks.map(() => []);
  blocks.forEach((b, i) => {
    const br = b.branch;
    // Recovered switch: the bounds block dispatches to its case blocks + default (the `cmplwi`/`bgt`
    // and the elided dispatch block are subsumed into a `switch_br`). Every case/default addr is a
    // leader, so all resolve; a target that is not a block boundary makes it malformed → loud-fail.
    const jt = br ? jts.get(br.addr) : undefined;
    if (jt) {
      const succ = [...jt.caseAddrs, jt.defaultAddr].map((a) => idxOf.get(a));
      if (succ.some((x) => x === undefined)) {
        throw new PpcUnsupportedError(`cannot lift '${name}': jump-table target is not a block boundary`);
      }
      succIdx[i] = succ as number[];
      return;
    }
    if (!br) {
      const j = idxOf.get(fallAddr(b));
      if (j !== undefined) {
        succIdx[i] = [j];
      }
      return;
    }
    if (isReturn(br)) {
      succIdx[i] = [];
      return;
    }
    if (isUncond(br)) {
      const j = idxOf.get(br.target!);
      succIdx[i] = j !== undefined ? [j] : [];
      return;
    }
    if (isCondReturn(br)) {
      const synth: PpcBlock = { startAddr: -1 - blocks.length, body: [], branch: null, synthReturn: true };
      const si = blocks.length;
      blocks.push(synth);
      succIdx.push([]);
      const fall = idxOf.get(br.addr + 4); // fall = instruction after the cond-return (no delay slot)
      succIdx[i] = fall !== undefined ? [si, fall] : [si];
      return;
    }
    // conditional branch to a label: [taken, fall]. Both must land on block boundaries; otherwise the
    // branch leaves the function (a tail branch) or targets unrecovered flow — fail LOUD and catchably
    // rather than silently dropping an edge (which surfaces as an opaque `verify` successor-count error).
    const taken = idxOf.get(br.target!);
    const fall = idxOf.get(br.addr + 4);
    if (taken === undefined || fall === undefined) {
      throw new PpcUnsupportedError(
        `cannot lift '${name}': conditional branch '${br.mnemonic}' at 0x${br.addr.toString(16)} ` +
          `has a target/fall-through that is not a block boundary (tail branch or unrecovered control flow)`,
      );
    }
    succIdx[i] = [taken, fall];
  });

  // Prune to blocks reachable from entry (drops trailing padding). Reindex succ accordingly.
  const reachable = new Set<number>();
  const queue = blocks.length ? [0] : [];
  while (queue.length) {
    const i = queue.pop()!;
    if (reachable.has(i)) {
      continue;
    }
    reachable.add(i);
    for (const s of succIdx[i]) {
      queue.push(s);
    }
  }
  const keep = blocks.map((_, i) => i).filter((i) => reachable.has(i));
  const remap = new Map(keep.map((old, neu) => [old, neu]));
  return {
    blocks: keep.map((i) => blocks[i]),
    succIdx: keep.map((i) => succIdx[i].map((s) => remap.get(s)!)),
  };
}

/** Lift disassembled PowerPC text → an L1 Fn with block-argument SSA. `asmData` (optional) supplies
 *  the data-section jump table for dense-switch (Regime-B) recovery; absent ⇒ a `bctr` dispatch
 *  loud-fails. */
export function lift(
  name: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes = {},
  asmData?: AsmData,
): Fn {
  assertInputFormat('ppc', 'objdump', asm);
  const instrs = parseDisasm(sliceSymbol(asm, name)); // ONE function only — an absent symbol declines loud
  if (instrs.length === 0) {
    throw new PpcUnsupportedError(`cannot lift '${name}': no instructions found in the input text`);
  }
  // Regime B: recover mwcc jump tables from the `bctr` dispatch idiom + the AsmData table. A
  // recovered dispatch's `bctr` is subsumed into a `switch_br` (emitted from its bounds block), so
  // it is exempted from the loud-fail below; an UNrecovered `bctr` still fails loud.
  const jts = asmData ? recoverPpcJumpTables(instrs, asmData) : new Map<number, PpcJT>();
  const recoveredBctr = new Set([...jts.values()].map((j) => j.bctrAddr));
  // TRUSTWORTHINESS: fail loud on an unmodelled control transfer rather than dropping it (which
  // would silently miscompile the control flow). CTR-counted loops and indirect branches land here.
  for (const ins of instrs) {
    if (ins.mnemonic.startsWith('b') && !isModeledBranch(ins)) {
      if (ins.mnemonic === 'bctr' && recoveredBctr.has(ins.addr)) {
        continue;
      } // recovered switch dispatch
      throw new PpcUnsupportedError(
        `cannot lift '${name}': unmodelled control transfer '${ins.mnemonic}' at 0x${ins.addr.toString(16)} ` +
          `(CTR-counted loop or indirect branch — mwcc -O4 loop unrolling is not yet supported)`,
      );
    }
  }
  const { blocks, succIdx } = toBlocks(instrs, name, jts);

  const preds: number[][] = blocks.map(() => []);
  blocks.forEach((_, i) => {
    for (const s of succIdx[i]) {
      preds[s].push(i);
    }
  });

  const ssa = makeSsaBuilder(name, blocks.length, preds);
  const { irBlocks, readVar, writeVar, paramReg } = ssa;
  const RET = target.returnReg;
  const ARG_REGS = target.argRegs;

  // Best-effort call arity when a callee has no prototype: the count of contiguous argument
  // registers (r3..) with a value reaching the call. A prototype's `params` is authoritative
  // when supplied; this liveness heuristic covers the rest.
  const fallbackArgc = (bi: number): number => {
    let n = 0;
    while (n < ARG_REGS.length && ssa.hasReachingDef(ARG_REGS[n], bi)) {
      n++;
    }
    return n;
  };

  // Frame slots (r1-relative offsets) that hold a TRANSPARENT save — a callee-saved register's
  // entry value or the saved link register. A reload from one of these is dropped (the value is
  // unchanged, so the in-register SSA value already carries it). Function-scoped so a save in the
  // prologue block matches a restore in a different epilogue block. Any OTHER r1 access is a genuine
  // local spill / address-taken stack object this frontend cannot model — those fail LOUD (below),
  // never silently drop, because a dropped local spill is a silent miscompile.
  const savedSlots = new Set<number>();

  const fillBlock = (b: PpcBlock, bi: number) => {
    const ops = irBlocks[bi].ops;
    const succ = (j: number): Successor => ({ block: irBlocks[j], args: [] });

    // A synthetic conditional-return block: just return the current return register.
    if (b.synthReturn) {
      const retOps = ssa.hasReachingDef(RET, bi) ? [readVar(RET, bi)] : [];
      ops.push(mkOp('ret', { operands: retOps }));
      return;
    }

    // `lastDef` is the value most recently written to a register in this instruction — used to
    // wire a record-form op's implicit cr0 side effect (see the `rc` handling in `decode`).
    let lastDef: Value | null = null;
    // Reading r1 (the stack pointer) as a DATA operand means frame-pointer arithmetic or an
    // address-taken local (`addi r3,r1,8` = `&local`) — not modellable without a stack abstraction,
    // and fabricating a value for r1 silently miscompiles. Fail LOUD. (Frame bookkeeping never
    // reaches here: stwu / addi r1 / mflr / mtlr / r1-relative spills are handled before `read`.)
    const read = (r: string): Value => {
      if (r === 'r1') {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': stack pointer r1 used as data (address-taken local / frame arithmetic) — not supported`,
        );
      }
      return readVar(r, bi);
    };
    // Ordinary memory must be based on a real register that is not the frame pointer. A non-register
    // base is an SDA/global-relative access (`stw r0,0(0)` — the base field is a 0 placeholder the
    // relocation fills at link); a base of r1 that reaches here is a sub-word frame slot. Both are
    // unmodelled — fail LOUD rather than fabricate a bogus pointer parameter or field.
    const assertOrdinaryMem = (mem: string) => {
      const { base } = parseMem(mem);
      if (!isReg(base)) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': non-register memory base ('${mem}') — SDA/global-relative access not supported`,
        );
      }
      if (base === 'r1') {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': sub-word stack-frame access ('${mem}') — local stack frames not supported`,
        );
      }
    };
    // A word store/load based on r1. Returns true if it is TRANSPARENT frame bookkeeping (skip):
    // a save of a register with no reaching def (callee-saved entry value / saved lr), or a reload
    // from a recorded save slot. A store of a LIVE (reaching-def) value is a real local spill →
    // fail LOUD. A reload from an unrecorded slot is a genuine stack local → fail LOUD.
    const frameStore = (srcReg: string, mem: string): boolean => {
      const { base, off } = parseMem(mem);
      if (base !== 'r1') {
        return false;
      }
      if (!ssa.hasReachingDef(srcReg, bi)) {
        savedSlots.add(off);
        return true;
      }
      throw new PpcUnsupportedError(
        `cannot lift '${name}': spill of a live value to the stack ('${srcReg},${mem}') — local stack frames not supported`,
      );
    };
    const frameLoad = (mem: string): boolean => {
      const { base, off } = parseMem(mem);
      if (base !== 'r1') {
        return false;
      }
      if (savedSlots.has(off)) {
        return true;
      }
      throw new PpcUnsupportedError(
        `cannot lift '${name}': reload of a stack local ('${mem}') — local stack frames not supported`,
      );
    };
    const write = (r: string, v: Value) => {
      writeVar(r, bi, v);
      lastDef = v;
    };
    // Shared emitter kit (frontend/emit.ts) — the ISA-specific readers/guards stay above.
    const kit = mkEmitKit(ops, write);
    const constVal = kit.cnst;
    const emit = kit.emit;
    // TRUSTWORTHINESS GUARD: an unmodelled instruction must not silently drop its destination —
    // emit an honest `opaque` instead: dead ⇒ DCE'd; live ⇒ assertResolved fails LOUD (see
    // frontend/opaque.ts for the policy).
    const emitOpaqueDest = (ins: Instr) => {
      // storeClass: every PPC store mnemonic is st* — an unmodelled one (`stwbrx`, `sthbrx`, …)
      // must throw, never skip (its first token is the SOURCE register).
      const od = opaqueDest(ins.mnemonic, ins.ops, {
        isReg,
        storeClass: /^st/,
        skipSafe: /^nop$/,
        context: `${name} @0x${ins.addr.toString(16)}`,
      });
      if (!od) {
        return;
      } // skip-safe only (opaqueDest throws on any other no-destination instruction)
      // carry the mnemonic so annotate mode can name the gap (`ASMLIFT_ERROR("unmodelled 'xori'")`)
      emit('opaque', od.dst, od.srcRegs.map(read), { mnemonic: ins.mnemonic });
    };
    const emitBin = kit.bin;
    const emitUn = kit.un;
    // Unwritten temporaries for the complemented-logic decodes: the value feeds a following op,
    // it is not itself a register destination.
    const binTmp = (opc: Opcode, x: Value, y: Value): Value => kit.tmp(opc, [x, y]);
    const notOf = (r: string): Value => {
      const v = mkValue(T.unk(32));
      ops.push(mkOp('not', { operands: [read(r)], results: [v] }));
      return v;
    };
    const emitShImm = kit.shImm;
    const emitLoad = (d: string, mem: string, width: number, signed: boolean) => {
      assertOrdinaryMem(mem);
      const { off, base } = parseMem(mem);
      emit('load', d, [read(base)], { off, width, signed });
    };
    const emitStore = (srcReg: string, mem: string, width: number) => {
      assertOrdinaryMem(mem);
      const { off, base } = parseMem(mem);
      ops.push(mkOp('store', { operands: [read(base), read(srcReg)], attrs: { off, width } }));
    };
    // Register+register INDEXED addressing (`lwzx rD,rA,rB` = *(rA+rB), `stwx rS,rA,rB` = *(rA+rB)=rS).
    // This is how mwcc emits EVERY variable-index array access (scalar and struct) — with rB the scaled
    // index. Decode to `add(rA,rB)` + a zero-offset load/store, the exact shape recognizeArrays
    // consumes (and raise/struct-arrays.ts targets), so `a[i]`
    // recovers from here.
    const addrX = (rA: string, rB: string): Value => {
      const addr = mkValue(T.unk(32));
      ops.push(mkOp('add', { operands: [read(rA), read(rB)], results: [addr] }));
      return addr;
    };
    const emitLoadX = (d: string, rA: string, rB: string, width: number, signed: boolean) => {
      emit('load', d, [addrX(rA, rB)], { off: 0, width, signed });
    };
    const emitStoreX = (srcReg: string, rA: string, rB: string, width: number) => {
      ops.push(mkOp('store', { operands: [addrX(rA, rB), read(srcReg)], attrs: { off: 0, width } }));
    };

    // cr-field compare state, so a following branch fuses. Keyed by cr name ("cr0" default).
    const cmpDef = new Map<string, { lhs: Value; rhs: Value; signed: boolean }>();
    // One operand-grammar normalizer for the four compare decodes: `cmpX rA,…` (cr0 implicit)
    // or `cmpX crN,rA,…` → the cr field, the lhs register token, and the rhs token (register or
    // immediate — the case reads/parses it).
    const parseCmpOps = (cmpOps: string[]): { cr: string; lhsTok: string; rhsTok: string } => {
      const hasCr = cmpOps[0]?.startsWith('cr') ?? false;
      const args = hasCr ? cmpOps.slice(1) : cmpOps;
      return { cr: hasCr ? cmpOps[0] : 'cr0', lhsTok: args[0], rhsTok: args[args.length - 1] };
    };
    const recordCmp = (cr: string, lhs: Value, rhs: Value, signed: boolean) => {
      cmpDef.set(cr, { lhs, rhs, signed });
    };

    const decode = (ins: Instr) => {
      const [d, s, t] = ins.ops;
      // Record form: a trailing `.` (the Rc bit) means the op ALSO sets cr0 from a signed compare
      // of its result against 0 (e.g. `andi.`, `addic.`). Decode the base op, then record that
      // implicit cr0 compare so a following `beq`/`bne` fuses. `mnem` is the base mnemonic the
      // switch dispatches on.
      const rc = ins.mnemonic.length > 1 && ins.mnemonic.endsWith('.');
      const mnem = rc ? ins.mnemonic.slice(0, -1) : ins.mnemonic;
      lastDef = null;
      switch (mnem) {
        case 'nop':
          break;
        // --- call + frame/link-register bookkeeping ---
        // `bl <sym>`: read the argument registers (r3..), produce the return value in r3. The
        // callee symbol comes from the relocation (ins.sym); caller-saved clobbering is implicit
        // (anything live across the call has already been moved to a callee-saved register).
        case 'bl': {
          const sym = ins.sym ?? 'func';
          const argc = protoArity(prototypes[sym]) ?? fallbackArgc(bi);
          const args: Value[] = [];
          for (let k = 0; k < argc; k++) {
            args.push(read(ARG_REGS[k]));
          }
          emit('call', RET, args, { target: sym });
          break;
        }
        // Stack-frame + link-register bookkeeping. `stwu r1,-N(r1)` / `addi r1,r1,N` adjust the frame
        // pointer; `mflr`/`mtlr` save/restore the return address. Transparent. Register saves/restores
        // (individual r1 spills, and `stmw`/`lmw` of a callee-saved range) are transparent ONLY when
        // they move an unchanged entry value — `frameStore`/`frameLoad` enforce that (a spill of a
        // LIVE value fails loud); `stmw`/`lmw` record/consume the slot directly.
        // The GENERAL form `stwu rS,D(rA)` (base ≠ r1) is a real store-with-BASE-UPDATE
        // (`*(rA+D)=rS; rA+=D`) — neither effect is modelled here, so loud-fail rather than drop both.
        case 'stwu':
          if (parseMem(s).base === 'r1') {
            break;
          }
          throw new PpcUnsupportedError(
            `cannot lift '${name}': stwu with update on ${parseMem(s).base} (store-with-base-update) not modelled`,
          );
        case 'mflr':
        case 'mtlr':
          break;
        // `mtctr rS` initialises the CTR loop counter — track it as the `ctr` pseudo-register so
        // the `bdnz` back-branch reads/decrements it. (A recovered switch dispatch's mtctr block is
        // elided; a leftover mtctr is inert if nothing reads `ctr`.) `mfctr` (CTR→GPR, rare) stays
        // opaque via the default case.
        case 'mtctr':
          writeVar('ctr', bi, read(d));
          break;
        case 'stmw':
          if (parseMem(s).base === 'r1') {
            savedSlots.add(parseMem(s).off);
            break;
          }
          assertOrdinaryMem(s);
          emitOpaqueDest(ins);
          break;
        case 'lmw':
          if (parseMem(s).base === 'r1') {
            break;
          }
          assertOrdinaryMem(s);
          emitOpaqueDest(ins);
          break;
        case 'mr':
          write(d, read(s));
          break; // move register (or rD,rS,rS)
        case 'li':
          write(d, constVal(parseImm(s)));
          break; // load immediate (addi rD,0,imm)
        case 'lis':
          write(d, constVal((parseImm(s) << 16) >> 0));
          break; // load immediate shifted
        case 'add':
        case 'addo':
          emitBin('add', d, read(s), read(t));
          break;
        // `addi r1,r1,N` is frame teardown (skip); any other addi is a real add-immediate.
        case 'addi':
        case 'addic':
          if (d === 'r1') {
            break;
          }
          emitBin('add', d, read(s), constVal(parseImm(t)));
          break;
        case 'subf':
        case 'subfc':
        case 'subfo':
          emitBin('sub', d, read(t), read(s));
          break; // rD = rB - rA (reversed)
        case 'subfic':
          emitBin('sub', d, constVal(parseImm(t)), read(s));
          break; // rD = imm - rA
        case 'neg':
          emitUn('neg', d, read(s));
          break;
        case 'mullw':
        case 'mullwo':
          emitBin('mul', d, read(s), read(t));
          break;
        case 'mulli':
          emitBin('mul', d, read(s), constVal(parseImm(t)));
          break;
        // High word of the 32x32->64 product — the magic-number division idiom: mwcc lowers `x/C`
        // to `mulhw(x,M)` plus shifts/corrections. Transient decode; raise/magicdiv.ts rewrites the
        // DAG to `sdiv/udiv(x, const C)`. A `mulh`/`mulhu` that escapes recovery has no C spelling
        // → loud-fail. Record forms `mulhw.`/`mulhwu.` arrive as the `.`-stripped `mnem`.
        case 'mulhw':
          emitBin('mulh', d, read(s), read(t));
          break;
        case 'mulhwu':
          emitBin('mulhu', d, read(s), read(t));
          break;
        // Hardware divide: `divw rD,rA,rB` = rA/rB (signed), `divwu` = unsigned. Unlike MIPS there
        // is NO hi/lo pair — the quotient lands directly in rD. The `o` (overflow-enable) suffix is
        // a flag bit, semantically identical for the quotient. Classic PPC has no hardware remainder
        // op (a `%` is `divw` + `mullw` + `subf`), so no smod/umod here.
        case 'divw':
        case 'divwo':
          emitBin('sdiv', d, read(s), read(t));
          break;
        case 'divwu':
        case 'divwuo':
          emitBin('udiv', d, read(s), read(t));
          break;
        case 'and':
          emitBin('and', d, read(s), read(t));
          break;
        case 'andi':
        case 'andic':
          emitBin('and', d, read(s), constVal(parseImm(t)));
          break;
        case 'or':
          emitBin('or', d, read(s), read(t));
          break;
        case 'ori':
          emitBin('or', d, read(s), constVal(parseImm(t)));
          break;
        case 'xor':
          emitBin('xor', d, read(s), read(t));
          break;
        case 'xori':
          emitBin('xor', d, read(s), constVal(parseImm(t)));
          break;
        case 'not':
          emitUn('not', d, read(s));
          break; // nor rD,rS,rS
        case 'nor':
          s === t ? emitUn('not', d, read(s)) : emitOpaqueDest(ins);
          break; // true 2-reg nor: unmodelled
        // Complemented-logic forms, decoded to the idiomatic C the compiler re-emits:
        //   andc rD,rA,rB = rA & ~rB    orc rD,rA,rB = rA | ~rB
        //   eqv  rD,rA,rB = ~(rA ^ rB)  nand rD,rA,rB = ~(rA & rB)
        // Appear in branchless clamps/masks (e.g. `x & ~(x>>31)` uses andc).
        case 'andc':
          emitBin('and', d, read(s), notOf(t));
          break;
        case 'orc':
          emitBin('or', d, read(s), notOf(t));
          break;
        case 'eqv':
          emitUn('not', d, binTmp('xor', read(s), read(t)));
          break;
        case 'nand':
          emitUn('not', d, binTmp('and', read(s), read(t)));
          break;
        // Sign-extend byte/halfword to 32 bits: `extsb rD,rS` = (s32)(s8)rS, `extsh` = (s32)(s16)rS.
        // `sext` carries the NARROW width; structure/backend spell it `(s8)e` / `(s16)e`.
        case 'extsb':
          emit('sext', d, [read(s)], { width: 8 });
          break;
        case 'extsh':
          emit('sext', d, [read(s)], { width: 16 });
          break;
        case 'slw':
          emitBin('shl', d, read(s), read(t));
          break;
        case 'srw':
          emitBin('shr_u', d, read(s), read(t));
          break;
        case 'sraw':
          emitBin('shr_s', d, read(s), read(t));
          break;
        case 'slwi':
          emitShImm('shl', d, read(s), parseImm(t));
          break;
        case 'srwi':
          emitShImm('shr_u', d, read(s), parseImm(t));
          break;
        case 'srawi':
          emitShImm('shr_s', d, read(s), parseImm(t));
          break;
        case 'rotlw':
          // rotate left by register — the C rotate idiom round-trips under mwcc (verified)
          emitBin('rotl', d, read(s), read(t));
          break;
        case 'rotlwi':
          emitShImm('rotl', d, read(s), parseImm(t));
          break;
        case 'cntlzw': {
          // count leading zeros — transient (see ir/opcodes.ts): the CNTLZW_EQ0 pattern folds
          // the ==0/`!` idiom; a bare survivor gaps loud at the structurer.
          emit('clz', d, [read(s)]);
          break;
        }
        // rotate-and-mask, rotate 0 only: `clrlwi rD,rS,n` = rS & (~0>>>n); `clrrwi` = rS & (~0<<n).
        case 'clrlwi':
          emitBin('and', d, read(s), constVal((0xffffffff >>> parseImm(t)) >>> 0));
          break;
        case 'clrrwi':
          emitBin('and', d, read(s), constVal((0xffffffff << parseImm(t)) >>> 0));
          break;
        case 'rlwinm': {
          const [sh, mb, me] = [parseImm(ins.ops[2]), parseImm(ins.ops[3]), parseImm(ins.ops[4])];
          // `rlwinm rD,rS,SH,MB,ME` = rotl(rS,SH) & mask(MB,ME). Three cases we can lower exactly:
          //  • SH==0            — a pure masked AND.
          //  • right-shift EXTRACT `(x>>n)&m` — ME==31 and the field does not wrap (SH+MB>=32): the
          //    compiler's form for `(x>>n)&mask`, with n=32-SH and mask=mask(MB,31). Emit the shift
          //    then the AND — the faithful, idiomatic C that recompiles to this exact rlwinm.
          //  • anything else (a genuine rotate / bitfield insert) stays an opaque — loud, not dropped.
          if (sh === 0) {
            emitBin('and', d, read(s), constVal(rlwinmMask(mb, me)));
            break;
          }
          if (me === 31 && sh + mb >= 32) {
            const shifted = mkValue(T.unk(32));
            ops.push(mkOp('shr_u', { operands: [read(s)], results: [shifted], attrs: { imm: (32 - sh) & 31 } }));
            emitBin('and', d, shifted, constVal(rlwinmMask(mb, 31)));
            break;
          }
          emitOpaqueDest(ins);
          break;
        }
        // Word load/store: a transparent frame save/restore is skipped; a live-value spill or a
        // stack local fails loud (frameStore/frameLoad); otherwise it is ordinary memory.
        case 'lwz':
          if (frameLoad(s)) {
            break;
          }
          emitLoad(d, s, 4, true);
          break;
        case 'lha':
          emitLoad(d, s, 2, true);
          break;
        case 'lhz':
          emitLoad(d, s, 2, false);
          break;
        case 'lbz':
          emitLoad(d, s, 1, false);
          break;
        case 'stw':
          if (frameStore(d, s)) {
            break;
          }
          emitStore(d, s, 4);
          break;
        case 'sth':
          emitStore(d, s, 2);
          break;
        case 'stb':
          emitStore(d, s, 1);
          break;
        // Register+register indexed forms (variable-index array access). Widths/signedness mirror the
        // displacement loads/stores above; `lhax` is the sign-extending halfword (algebraic).
        case 'lwzx':
          emitLoadX(d, s, t, 4, true);
          break;
        case 'lhax':
          emitLoadX(d, s, t, 2, true);
          break;
        case 'lhzx':
          emitLoadX(d, s, t, 2, false);
          break;
        case 'lbzx':
          emitLoadX(d, s, t, 1, false);
          break;
        case 'stwx':
          emitStoreX(d, s, t, 4);
          break;
        case 'sthx':
          emitStoreX(d, s, t, 2);
          break;
        case 'stbx':
          emitStoreX(d, s, t, 1);
          break;
        // rhs is evaluated BEFORE lhs in each case: reads create Braun-SSA phis on demand, so read
        // order affects block-param layout.
        case 'cmpw': {
          const c = parseCmpOps(ins.ops);
          const rhs = read(c.rhsTok);
          recordCmp(c.cr, read(c.lhsTok), rhs, true);
          break;
        }
        case 'cmpwi': {
          const c = parseCmpOps(ins.ops);
          const rhs = constVal(parseImm(c.rhsTok));
          recordCmp(c.cr, read(c.lhsTok), rhs, true);
          break;
        }
        case 'cmplw': {
          const c = parseCmpOps(ins.ops);
          const rhs = read(c.rhsTok);
          recordCmp(c.cr, read(c.lhsTok), rhs, false);
          break;
        }
        case 'cmplwi': {
          const c = parseCmpOps(ins.ops);
          const rhs = constVal(parseImm(c.rhsTok));
          recordCmp(c.cr, read(c.lhsTok), rhs, false);
          break;
        }
        default:
          emitOpaqueDest(ins);
          break; // unmodelled: an honest opaque, never a silent drop
      }
      // A record-form op sets cr0 from a signed compare of its result against 0. Wire that so the
      // next branch reading cr0 fuses (`andi. r0,r3,1; beq …` → `if ((a0 & 1) == 0)`).
      if (rc && lastDef) {
        cmpDef.set('cr0', { lhs: lastDef, rhs: constVal(0), signed: true });
      }
    };

    for (const ins of b.body) {
      decode(ins);
    }

    const br = b.branch;
    // Recovered dense switch: the bounds block dispatches a `switch_br` over the scrutinee — N case
    // blocks (dense 0..N-1) then the default (last successor). The `cmplwi`/`bgt` and the elided
    // dispatch (`lis…lwzx;mtctr;bctr`) are subsumed.
    const jt = br ? jts.get(br.addr) : undefined;
    if (jt) {
      pushSwitchBr(
        ops,
        readVar(jt.scrutReg, bi),
        succIdx[bi].map((j) => succ(j)),
      );
      return;
    }
    // `bdnz L`: CTR ← CTR−1; branch to L while CTR ≠ 0. Modelled as an explicit decrement of the
    // `ctr` pseudo-register plus a `cond_br` on `ctr ≠ 0`, which the structurer renders as a loop.
    // succIdx is [taken=back-edge, fall=exit], so the taken predicate is `ctr ≠ 0`. Loud-fail
    // without a reaching `mtctr`: no recoverable trip count means no sound loop.
    if (br && br.mnemonic === 'bdnz') {
      if (!ssa.hasReachingDef('ctr', bi)) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': 'bdnz' at 0x${br.addr.toString(16)} without a reaching 'mtctr' ` +
            `(CTR loop count not recoverable)`,
        );
      }
      // CTR is VOLATILE across calls (the ABI marks it caller-saved): a `bl` or re-seeding `mtctr`
      // inside the loop body clobbers the hardware CTR, making the modelled down-count wrong —
      // loud-fail rather than emit a confident-but-wrong count (hand-written asm can do this even
      // though a conforming compiler won't). The loop body is the natural loop of the back-edge:
      // header (bdnz's target) plus every block reaching the `bdnz` latch without passing back
      // through the header. The preheader holding the count `mtctr` is NOT in the body — exempt.
      const header = succIdx[bi][0];
      const body = new Set<number>([header]);
      for (const stack = [bi]; stack.length;) {
        const n = stack.pop()!;
        if (body.has(n) && n !== bi) {
          continue;
        }
        body.add(n);
        if (n !== header) {
          for (const p of preds[n]) {
            stack.push(p);
          }
        }
      }
      for (const n of body) {
        const bad = blocks[n].body.find((i) => i.mnemonic === 'bl' || i.mnemonic === 'bctrl' || i.mnemonic === 'mtctr');
        if (bad) {
          throw new PpcUnsupportedError(
            `cannot lift '${name}': CTR loop body contains '${bad.mnemonic}' at 0x${bad.addr.toString(16)} ` +
              `which clobbers CTR (loop trip count not recoverable)`,
          );
        }
      }
      const dec = mkValue(T.unk(32));
      ops.push(mkOp('sub', { operands: [readVar('ctr', bi), constVal(1)], results: [dec] }));
      writeVar('ctr', bi, dec);
      const cond = mkCmp(ops, 'icmp_ne', dec, constVal(0));
      ops.push(mkOp('cond_br', { operands: [cond], successors: succIdx[bi].map((j) => succ(j)) }));
      return;
    }
    if (br && (isCond(br) || isCondReturn(br))) {
      const base = isCondReturn(br) ? condReturnBase(br)! : br.mnemonic;
      // The branch names its cr field as the first operand when not cr0.
      const crName = br.ops[0]?.startsWith('cr') ? br.ops[0] : 'cr0';
      const cmp = cmpDef.get(crName);
      // `cmpDef` is block-local; a compare split from its branch by a block boundary is a
      // cross-block cr dependency this frontend does not model. Decline loud.
      if (!cmp) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': conditional branch '${base}' has no reaching compare (${crName}) in its block`,
        );
      }
      const table = !cmp.signed ? COND_UNSIGNED : COND_SIGNED;
      const cond = mkCmp(ops, table[base], cmp.lhs, cmp.rhs);
      ops.push(mkOp('cond_br', { operands: [cond], successors: succIdx[bi].map((j) => succ(j)) }));
      return;
    }
    if (!br || isReturn(br)) {
      if (!br && succIdx[bi].length) {
        ops.push(mkOp('br', { successors: [succ(succIdx[bi][0])] }));
        return;
      }
      const retOps = ssa.hasReachingDef(RET, bi) ? [readVar(RET, bi)] : [];
      ops.push(mkOp('ret', { operands: retOps }));
      return;
    }
    // unconditional branch
    ops.push(mkOp('br', { successors: [succ(succIdx[bi][0])] }));
  };

  blocks.forEach((b, bi) => {
    fillBlock(b, bi);
    ssa.markFilled(bi);
  });
  ssa.finish();

  // ABI-ordered entry parameters (r3, r4, …) — a callee-saved copy can read a later argument
  // register first, so sort the true entry's params by argument-register index.
  const entry = irBlocks[0];
  // non-ABI live-in ranks FIRST (indexOf's -1) — deliberate MIPS/PPC tie-break; Thumb's is 99/last
  abiSortEntryParams(entry, preds[0].length > 0, (v) => ARG_REGS.indexOf(paramReg.get(v) ?? ''));
  return ssa.fn;
}

function mkCmp(ops: Op[], opc: Opcode, l: Value, r: Value): Value {
  const v = mkValue(T.unk(32));
  ops.push(mkOp(opc, { operands: [l, r], results: [v] }));
  return v;
}

/** The PowerPC / CodeWarrior frontend, registered for the `ppc` target. */
export const ppcFrontend: Frontend = { id: 'ppc', inputFormat: 'objdump', lift };
