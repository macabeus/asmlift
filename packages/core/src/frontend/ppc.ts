// asmlift ISA frontend — PowerPC (GameCube/Wii, Metrowerks CodeWarrior `mwcceppc`). Input is
// disassembled text (`powerpc-eabi-objdump -d -r -M gekko --no-show-raw-insn`), parsed by the
// shared `parseDisasm` with the reloc + branch-hint options enabled. `-M gekko` is part of that
// contract, not decoration: the generic PowerPC dialect decodes Gekko's paired-single opcodes as
// POWER VSX, naming another register file at another offset. It is also the dialect that prints
// the branch-prediction hint suffixes (`beq-`, `bdnz+`) `hintSuffixes` strips below.
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
//    prototype (falling back to argument-register liveness). The frame bookkeeping — `stwu r1`,
//    the link-register save, callee-saved saves — is transparent to dataflow, so a value in a
//    callee-saved register survives the call; a word stored to the frame with a value is a
//    stack-slot variable (`frameStore`).
//  • RECORD FORM (`.` = the Rc bit, e.g. `andi.`/`add.`) also sets cr0 from a signed compare of
//    the result against 0; that implicit compare is wired so a following `beq`/`bne` fuses.
//
// TRUSTWORTHINESS: an unmodelled instruction with a register destination emits an `opaque` value
// that fails LOUD downstream read or not; an unmodelled CONTROL TRANSFER throws
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
import { type Prototypes, declaredArgWidths, declaredReturnWidth } from '../proto';
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
import { inheritFlags } from './flags-edge';
import { assertInputFormat } from './format';
import type { Frontend } from './frontend';
import { makeHighHalves } from './high-half';
import { opaqueDest } from './opaque';
import { unspellableReason } from './reloc-symbol';
import { abiSortEntryParams, mintArgSlotHoles, registerArgSlots, stackSlotKey } from './ssa';
import { clobberedByCall, makeSsaBuilder } from './ssa';

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

/** A compare a `cr` field holds: its operands and signedness, which the reading branch turns into a
 *  condition. */
type CrCompare = { lhs: Value; rhs: Value; signed: boolean };

/** What a block leaves in the condition register for a successor to inherit. `fields` holds, per
 *  field, the compare it holds, or the sentence saying what overwrote it. A field absent from the map
 *  never held a compare on the chain of edges that reached here, and `none` is why: the sentence
 *  from the block where that chain started. */
type CrExit = { fields: ReadonlyMap<string, CrCompare | string>; none: string };

/** The `cr` fields the EABI makes volatile across a call: cr0, cr1 and cr5–cr7. The callee may
 *  write any of them, so a compare in one does not survive a `bl`. cr2–cr4 are nonvolatile. */
const CR_VOLATILE = ['cr0', 'cr1', 'cr5', 'cr6', 'cr7'] as const;

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
    const [lis, lwzx, mtctr] = [instrs[i - 5], instrs[i - 2], instrs[i - 1]];
    // The index is scaled and the table's low half formed in either order: mwcc 2.4.2 emits the
    // `slwi` first, GC/1.2.5n the `addi`. The two instructions are independent.
    const [slwi, addi] =
      instrs[i - 4].mnemonic === 'slwi' ? [instrs[i - 4], instrs[i - 3]] : [instrs[i - 3], instrs[i - 4]];
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
    // The table's base is the same `@ha`/`@l` pair the address fold consumes and must show the same
    // evidence — both relocation types, one symbol, one addend — so a dispatch is never recovered
    // from two instructions that never addressed the table together. It stays a separate pairing:
    // it runs before the blocks exist, and it wants the table's NAME, for `readJumpTable`, not its
    // address. It skips the naming policy deliberately — a table base is read here as data, never
    // written into the candidate as an identifier — so the `@N` and `.`-prefixed symbols the
    // address fold must refuse (292 of the corpus's `ADDR16` relocations) are harmless here.
    const tableSym = lis.reloc?.sym;
    if (
      lis.ops[0] !== rT ||
      !tableSym ||
      lis.reloc?.type !== 'R_PPC_ADDR16_HA' ||
      addi.reloc?.type !== 'R_PPC_ADDR16_LO' ||
      addi.reloc.sym !== tableSym ||
      addi.reloc.addend !== lis.reloc.addend
    ) {
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

/** Where r1 stands, relative to its value at entry, just BEFORE an instruction runs: a byte count
 *  (0 before the frame push, -N after `stwu r1,-N(r1)`), or why it is not known there.
 *
 *  A frame slot has to be named by its offset from the ENTRY r1, because the compilers disagree on
 *  which side of the push they save the link register. mwcc 2.4.x pushes first and saves at
 *  `N+4(r1)`; mwcc 2.3.3 saves at `4(r1)` BEFORE `stwu r1,-N(r1)` and restores from `N+4(r1)`. That is
 *  one word of the caller's frame spelled at two offsets, and an offset from the CURRENT r1 reads it
 *  as two different words.
 *
 *  Forward dataflow over the block graph, per instruction. Only the two forms a compiler uses to
 *  move r1 are counted: `stwu r1,-N(r1)` from the entry value, and `addi r1,r1,N`. Anything else
 *  that writes r1 — a second push, an `addi r1,rX,N` from another register, an `mr r1,r11` — makes
 *  the displacement unknown from there on, and so does a join whose predecessors arrive at
 *  different depths. Unknown is not a refusal by itself: a displacement nothing reads decides
 *  nothing. The frame accesses and the push that DO read it refuse loud (`lift`, `entryOffset`). */
function r1Displacements(blocks: PpcBlock[], succIdx: number[][]): Map<Instr, number | string> {
  const at = new Map<Instr, number | string>();
  const into: Array<number | string | undefined> = blocks.map(() => undefined);
  // The first reason a block's displacement became unknown is the one kept: it is the earliest cause.
  const meet = (bi: number, d: number | string): boolean => {
    const old = into[bi];
    let next = d;
    if (typeof old === 'string' || old === d) {
      next = old;
    } else if (typeof old === 'number' && typeof d === 'number') {
      const where = blocks[bi].startAddr >= 0 ? `0x${blocks[bi].startAddr.toString(16)}` : 'a synthesized return';
      next = `the paths into ${where} arrive with r1 at two depths (${old} and ${d} bytes from its entry value)`;
    }
    into[bi] = next;
    return next !== old;
  };
  const writesR1 = (ins: Instr) => ins.ops[0] === 'r1' && !/^(st|cmp|tw|mt|dc|ic)/.test(ins.mnemonic);
  meet(0, 0);
  const work = [0];
  while (work.length) {
    const bi = work.pop()!;
    let d = into[bi]!;
    for (const ins of [...blocks[bi].body, ...(blocks[bi].branch ? [blocks[bi].branch] : [])]) {
      at.set(ins, d);
      const where = `0x${ins.addr.toString(16)}`;
      if (ins.mnemonic === 'stwu' && ins.ops[0] === 'r1' && parseMem(ins.ops[1]).base === 'r1') {
        d =
          d === 0
            ? parseMem(ins.ops[1]).off
            : `the frame push at ${where} is a second one (r1 already moved from its entry value)`;
      } else if (ins.mnemonic === 'addi' && ins.ops[0] === 'r1' && ins.ops[1] === 'r1' && !ins.reloc) {
        d = typeof d === 'number' ? d + parseImm(ins.ops[2]) : d;
      } else if (writesR1(ins)) {
        d = `'${ins.mnemonic} ${ins.ops.join(',')}' at ${where} sets r1 to a value this frontend does not track`;
      }
    }
    for (const s of succIdx[bi]) {
      if (meet(s, d)) {
        work.push(s);
      }
    }
  }
  return at;
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
  // A data reloc on an instruction whose decode did not TAKE it means objdump printed a LINK-TIME
  // placeholder (`lis r4,0` + R_PPC_ADDR16_HA sym): the real value is the symbol's half, and
  // lifting the 0 silently reads the wrong address — plausible-but-wrong C, the forbidden class.
  // The jump-table idiom's own @tbl pair never reaches this guard: a recovered dispatch block
  // is the bounds branch's replaced fall-through, pruned as unreachable before decode.
  //
  // TWO refusals, because they are different problems and the reader acts on them differently. A
  // symbol the naming policy calls unspellable (frontend/reloc-symbol.ts) is a DEAD END: recovering
  // the address perfectly would still leave a name no C source can write, so no amount of lifting
  // opens the row. A spellable symbol is a CAPABILITY GAP: the address is recoverable and the row
  // waits on the fold. Saying which one a row hit is the whole value of the message.
  const relocSite = (ins: Instr) => `cannot lift '${name}': '${ins.mnemonic}' at 0x${ins.addr.toString(16)}`;
  /** Whether the decode of the instruction in hand has TAKEN its relocation. `decode` asks once, of
   *  every modelled instruction, so a relocation no case consumed refuses instead of being dropped.
   *  A per-case guard would only cover the cases that remember to carry one, and every other
   *  instruction would lift its printed placeholder as a value (`andi. r3,r3,0` under an
   *  `R_PPC_EMB_SDA21` is `a0 & 0`). An UNmodelled instruction refuses earlier and for a better
   *  reason: `lfs`/`lfd` under either relocation name the float gap, not this one. */
  let relocTaken = false;
  /** The symbol a relocation names, once the naming policy has passed it. Every recovery below goes
   *  through here FIRST, so an unspellable name can never reach the declaration minter looking like
   *  an ordinary identifier — recovering the address is only half of being able to write it down. */
  const spellableSym = (ins: Instr): string => {
    relocTaken = true;
    const sym = ins.reloc?.sym ?? '';
    const why = unspellableReason(sym);
    if (why) {
      throw new PpcUnsupportedError(`${relocSite(ins)} ${why}`);
    }
    return sym;
  };
  const relocPlaceholder = (ins: Instr): never => {
    throw new PpcUnsupportedError(
      `${relocSite(ins)} carries a data relocation ('${spellableSym(ins)}') — the printed immediate ` +
        `is a link-time placeholder, not the value`,
    );
  };
  // TRUSTWORTHINESS: fail loud on an unmodelled control transfer rather than dropping it (which
  // would silently miscompile the control flow). CTR-counted loops and indirect branches land here.
  for (const ins of instrs) {
    if (ins.mnemonic.startsWith('b') && !isModeledBranch(ins)) {
      if (ins.mnemonic === 'bctr' && recoveredBctr.has(ins.addr)) {
        continue;
      } // recovered switch dispatch
      throw new PpcUnsupportedError(
        `cannot lift '${name}': unmodelled control transfer '${ins.mnemonic}' at 0x${ins.addr.toString(16)} ` +
          (ins.mnemonic === 'blrl' || ins.mnemonic === 'bctrl'
            ? `(an indirect call — a virtual dispatch or a call through a pointer — is not yet supported)`
            : `(CTR-counted loop or indirect branch — mwcc -O4 loop unrolling is not yet supported)`),
      );
    }
  }
  const { blocks, succIdx } = toBlocks(instrs, name, jts);
  // PREHEADER. A function whose first block is a branch target (`do b = b * b; while (--n);` is a
  // loop at the entry) would take its parameters as that loop header's phis. An empty block ahead
  // of it becomes the entry, and its live-ins are the function's parameters (frontend/ssa.ts
  // `ArgSlots`). It starts where the function does, which is what its label says.
  if (succIdx.some((ss) => ss.includes(0))) {
    blocks.unshift({ startAddr: blocks[0].startAddr, body: [], branch: null });
    succIdx.forEach((ss, i) => (succIdx[i] = ss.map((j) => j + 1)));
    succIdx.unshift([1]);
  }

  const r1At = r1Displacements(blocks, succIdx);

  const preds: number[][] = blocks.map(() => []);
  blocks.forEach((_, i) => {
    for (const s of succIdx[i]) {
      preds[s].push(i);
    }
  });

  const ssa = makeSsaBuilder(name, blocks.length, preds);
  const { irBlocks, readVar, writeVar, paramReg } = ssa;

  /** The HIGH half of a relocated address, per value standing for one. The invariant, and every
   *  way a placeholder could leak past it, lives in frontend/high-half.ts — shared with
   *  frontend/mips.ts, which folds the same two-instruction address under `%hi`/`%lo`.
   *
   *  `lis rD,SYM@ha` produces no VALUE: `@ha` is `((SYM + 0x8000) >> 16) & 0xffff`, a number that
   *  means nothing until the sign-extended `@l` half completes it, and in a relocatable object both
   *  printed immediates are 0 anyway — the address lives entirely in the two relocation records.
   *  The `gaddr` is emitted where the `@l` lands, the same choice frontend/mips.ts makes for
   *  `lui %hi`.
   *
   *  PowerPC is RELA, so the addend rides on the relocation record and is copied straight in; MIPS
   *  is REL and must read it out of the two instruction immediates. That is the one place the two
   *  folds diverge, and it is a relocation-format fact rather than a preference. */
  const highHalves = makeHighHalves({
    hi: '@ha',
    hiArticle: 'an',
    lo: '@l',
    fail: (message) => {
      throw new PpcUnsupportedError(message);
    },
  });
  /** Reading a register AS A VALUE. A register holding a high half is not one, so this refuses loud
   *  rather than handing back a plausible number standing for an address. `foldLoHalf` is the only
   *  code entitled to look at a high half, which is why it reaches `readVar` directly. */
  const readReg = (r: string, at: number): Value => highHalves.guardRead(name, r, readVar(r, at));
  /** The return address `mflr rD` copies out of the link register, per value standing for one, with
   *  the address of the `mflr`. Like a high half it is a definition and not a value: storing it to
   *  the frame is the LR save (`frameStore`), and moving it back with `mtlr` is the return. Any other
   *  use is a function reading its own return address (MP4's `asm { mflr retaddr }` does, to tag
   *  an allocation with its caller), which no C expression spells, so that use refuses once the
   *  function is built. A no-op `mflr` would leave rD holding its previous value, and the body's
   *  read of it would lift as that value: a phantom parameter for r31, nothing at all for r3. */
  const returnAddresses = new Map<Value, number>();
  const RET = target.returnReg;
  const ARG_REGS = target.argRegs;
  const CALL_CLOBBERS = clobberedByCall(target);

  // Best-effort call arity when a callee has no prototype: the count of contiguous argument
  // registers (r3..) with a VALUE reaching the call. A prototype's `params` is authoritative when
  // supplied; this liveness heuristic covers the rest.
  //
  // A pending `@ha` high half is a def but not a value, and it must not raise the count: a `lis`
  // hoisted into the prologue leaves its half in r4 across an intervening call, and counted, it
  // makes `strlen(s)` into `strlen(s, <half>)` — which then refuses at the read. Measured on
  // `pikmin:searchKanjiCode__FUs`, whose `lis r4` at 0x4 pairs only at 0x28, past the `bl strlen`.
  //
  // A GAP REFUSES. The count is contiguous, so an argument register with nothing reaching it ends
  // it — and one is empty for two opposite reasons. Either the call really takes that few
  // arguments, or the register still holds this function's own untouched incoming argument, a value
  // the machine passes on that SSA has no definition for because nothing ever wrote it. When a
  // LATER argument register does hold a value the second reading is the only one left, and taking
  // the first drops that argument and every one after it: `ac-decomp:evw_anime_colreg_manual` sets
  // up seven registers for `evw_color_set` and, with r4 at its incoming value, lifts to
  // `evw_color_set(a0);` — its divide, its multiply and five arguments gone. Which reading it is
  // cannot be decided here — the function's own arity is exactly what is missing — so this refuses
  // and names the gap rather than guessing. A prototype answers it (`declaredArgWidths` is asked
  // first), and this scan is never weighed against one: it is a guess, and a guess that cannot
  // fail cannot witness a width a declaration left open.
  const fallbackArgc = (bi: number, at: number): number => {
    const holdsValue = (k: number) => ssa.hasReachingDef(ARG_REGS[k], bi, (v) => !highHalves.has(v));
    let n = 0;
    while (n < ARG_REGS.length && holdsValue(n)) {
      n++;
    }
    for (let k = n + 1; k < ARG_REGS.length; k++) {
      if (holdsValue(k)) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': the call at 0x${at.toString(16)} has no prototype, ${ARG_REGS[k]} holds a ` +
            `value and ${ARG_REGS[n]} holds none — an argument register left at its incoming value and one ` +
            `the call does not pass look the same here, so the argument count is not decidable`,
        );
      }
    }
    return n;
  };

  // THE FRAME, as two kinds of word slot, each named by its offset from the ENTRY r1
  // (`r1Displacements`).
  //
  // A SAVE holds an entry value that is no C value: a callee-saved register's, or the link
  // register's word. Nothing but the caller reads it back, so its restore — a load into the register
  // it was saved from — is dropped, and a load into any other register refuses. Function-scoped, so
  // a save in the prologue matches a restore in any epilogue.
  //
  // Every other word store is a VALUE — an argument's home, or a live value spilled — and it is the
  // shared stack-slot variable (`stackSlotKey`, frontend/ssa.ts) MIPS and Thumb use. A reload into
  // any register reads it; a reload on a path that never stored it refuses in the builder, which
  // is path-sensitive where a table filled in walk order is not; a store nothing reloads refuses at
  // the end of `lift`.
  //
  // A slot is one kind for the whole function: a word both saved and stored with a value has no
  // single reading, and refuses.
  const saveSlots = new Map<number, string>();
  const valueSlots = new Map<number, { addr: number; mem: string; read: boolean }>();
  const refuseMixedSlot = (ins: Instr, mem: string, off: number, kind: 'save' | 'value') => {
    if (kind === 'save' ? valueSlots.has(off) : saveSlots.has(off)) {
      throw new PpcUnsupportedError(
        `cannot lift '${name}': local stack frames not supported — '${mem}' at 0x${ins.addr.toString(16)} ` +
          `is a word this function both saves a register in and stores a value to`,
      );
    }
  };
  /** The slot an r1-relative operand names: its offset from the entry r1. Where r1's displacement is
   *  not known, no offset can be named, and a save or restore there refuses rather than being
   *  matched against a slot it may not be. */
  const entryOffset = (ins: Instr, mem: string): number => {
    const d = r1At.get(ins);
    if (typeof d !== 'number') {
      throw new PpcUnsupportedError(
        `cannot lift '${name}': stack-frame access '${mem}' at 0x${ins.addr.toString(16)} — the stack ` +
          `pointer's offset from its entry value is not known there: ${d ?? 'the instruction is unreachable'}`,
      );
    }
    return parseMem(mem).off + d;
  };
  // `stmw rS,D(r1)` saves rS..r31 into consecutive words from D; `lmw rD,D(r1)` restores the same
  // range.
  const frameRange = (firstReg: string, off: number): Array<{ off: number; reg: string }> => {
    const first = Number(firstReg.slice(1));
    const slots: Array<{ off: number; reg: string }> = [];
    for (let r = first; r <= 31; r++) {
      slots.push({ off: off + (r - first) * 4, reg: `r${r}` });
    }
    return slots;
  };

  // What each filled block left in the condition register. Written as blocks are filled, so a lookup
  // finds only blocks filled earlier, which is what `inheritFlags` needs to tell "not known" from
  // "none".
  const exitCr = new Map<number, CrExit>();
  const blockLabel = (bi: number): string =>
    blocks[bi].startAddr >= 0
      ? `${name}+0x${blocks[bi].startAddr.toString(16)}`
      : `the return block '${name}' synthesizes`;

  const fillBlock = (b: PpcBlock, bi: number) => {
    const ops = irBlocks[bi].ops;
    const succ = (j: number): Successor => ({ block: irBlocks[j], args: [] });

    // A synthetic conditional-return block: just return the current return register.
    if (b.synthReturn) {
      const retOps = ssa.hasReachingDef(RET, bi) ? [readReg(RET, bi)] : [];
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
      return readReg(r, bi);
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
    // A word store/load based on r1: a SAVE or a VALUE slot (see `saveSlots` above). Returns false
    // for any other base, which is ordinary memory.
    const frameStore = (ins: Instr, srcReg: string, mem: string): boolean => {
      if (parseMem(mem).base !== 'r1') {
        return false;
      }
      const off = entryOffset(ins, mem);
      const isArg = ARG_REGS.includes(srcReg);
      // A save stores what the register held at entry (nothing defined it on any path) or the
      // return address `mflr` copied into it (the only definition on every path). An argument
      // register nothing defined holds the argument, which is a value.
      const noValueReaches = !ssa.hasReachingDef(srcReg, bi, (v) => !returnAddresses.has(v));
      if (noValueReaches && (!isArg || ssa.hasReachingDef(srcReg, bi))) {
        refuseMixedSlot(ins, mem, off, 'save');
        saveSlots.set(off, srcReg);
        return true;
      }
      refuseMixedSlot(ins, mem, off, 'value');
      // An argument moved to its home is not an argument set up for the next call.
      const v = (isArg ? ssa.entryValue(srcReg, bi) : undefined) ?? readReg(srcReg, bi);
      writeVar(stackSlotKey(off), bi, v);
      if (!valueSlots.has(off)) {
        valueSlots.set(off, { addr: ins.addr, mem, read: false });
      }
      return true;
    };
    const frameLoad = (ins: Instr, dstReg: string, mem: string): boolean => {
      if (parseMem(mem).base !== 'r1') {
        return false;
      }
      const off = entryOffset(ins, mem);
      const saved = saveSlots.get(off);
      if (saved === dstReg) {
        return true;
      }
      if (saved !== undefined) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': reload of '${mem}' into ${dstReg}, a slot ${saved} was saved into — the ` +
            `word holds the caller's ${saved}, which no C value names`,
        );
      }
      const slot = valueSlots.get(off);
      if (slot === undefined || !ssa.hasReachingDef(stackSlotKey(off), bi)) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': reload of a stack local ('${mem}') — local stack frames not supported`,
        );
      }
      slot.read = true;
      write(dstReg, readVar(stackSlotKey(off), bi));
      return true;
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
    // emit an honest `opaque` instead, which fails LOUD at assertResolved whether or not anything
    // reads that register (see frontend/opaque.ts for the policy).
    const emitOpaqueDest = (ins: Instr) => {
      // storeClass: every PPC store mnemonic is st* — an unmodelled one (`stwbrx`, `sthbrx`, …)
      // must throw, never skip (its first token is the SOURCE register).
      const od = opaqueDest(ins.mnemonic, ins.ops, {
        isReg,
        // The floating-point register file. `isReg` is `r\d+`, so an `fN` operand is invisible to
        // it: `fadds f1,f1,f2` reads as "no register destination" and `fcmpo cr0,f1,f2` as the same
        // thing about a CONDITION register, when both are one missing file. `stfs`/`stfd` reach
        // this arm ahead of `^st` deliberately — they are refused for the file they move, not for
        // the memory they move it to.
        //
        // NO SIGIL, WHICH IS THE OPPOSITE OF THE MIPS CHOICE, and it needs its own argument because
        // PowerPC objdump prints an FPU register bare (`f1`) and has no sigil to require. The
        // collision the MIPS predicate pays a sigil to avoid is live here in principle — objdump
        // writes a branch target as bare lower-case hex, so `f0`/`f4`/`f8` are addresses AND
        // matches. What makes it unreachable is not this pattern but the branch handling above: a
        // `b*` mnemonic in `isModeledBranch` is decoded as a transfer or a call and never falls to
        // `emitOpaqueDest`, and every other `b*` is refused by the whole-function control-transfer
        // pre-pass before a block is even filled. Those two are exhaustive over the mnemonics that
        // can carry an address, so no operand reaching this policy is one. `test/fp-refusal.test.ts`
        // pins it, and moving the FPU check into a pre-pass ahead of that one turns it red.
        fpReg: /^f\d+$/i,
        // The FPSCR moves that name no `fN` operand at all: `mtfsfi 7,0` takes a field number,
        // `mtfsb0`/`mtfsb1` a bit number, `mcrfs cr0,cr1` two condition registers. Without this
        // they read as "no register destination to degrade", which is the message that hides a
        // missing file behind the shape of the instruction. `mffs f0` and `mtfsf 0xff,f0` DO name
        // one and are `fpReg`'s.
        fpControl: /^(mtfsfi|mtfsb0|mtfsb1|mcrfs)$/i,
        storeClass: /^st/i,
        skipSafe: /^nop$/i,
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
    // Materialise the address of a named global — the same `gaddr` op the MIPS and Thumb frontends
    // emit, which the structurer lowers to `SYM`, `((T *)&SYM)[i]` or `&SYM`.
    const emitGaddr = (sym: string): Value => {
      const g = mkValue(T.unk(32));
      ops.push(mkOp('gaddr', { results: [g], attrs: { sym } }));
      return g;
    };
    // `lwz rD,0(0)` under an `R_PPC_EMB_SDA21` relocation is a SMALL-DATA access. Both printed
    // fields are link-time placeholders: the linker substitutes r13/r2 for the base register and a
    // section-relative displacement for the offset, so the address is exactly `&SYM` plus the
    // relocation's own addend. Because the printed operand is discarded rather than read, one that
    // is NOT the expected placeholder refuses — a field this code ignores must be one that provably
    // says nothing.
    const sdaAccess = (ins: Instr, mem: string): { base: Value; off: number } | null => {
      if (ins.reloc?.type !== 'R_PPC_EMB_SDA21') {
        return null;
      }
      if (mem !== '0(0)') {
        throw new PpcUnsupportedError(
          `${relocSite(ins)} carries a small-data relocation ('${ins.reloc.sym}') but its memory ` +
            `operand is '${mem}', not the expected '0(0)' placeholder`,
        );
      }
      return { base: emitGaddr(spellableSym(ins)), off: ins.reloc.addend };
    };
    // The base value + byte offset of a displacement memory operand: a small-data global, or an
    // ordinary register base. Read BEFORE a store's source register, because read order decides
    // block-parameter layout.
    const memOperand = (ins: Instr, mem: string): { base: Value; off: number } => {
      const sda = sdaAccess(ins, mem);
      if (sda) {
        return sda;
      }
      assertOrdinaryMem(mem);
      const { off, base } = parseMem(mem);
      return { base: read(base), off };
    };
    // `addi rD,rHi,SYM@l` — the LOW half that completes a `lis rHi,SYM@ha`. Returns `&SYM`.
    //
    // The pairing is PROVEN, not guessed: the value rHi holds HERE must be the very placeholder a
    // `lis` defined, and the two relocations must name the same symbol with the same addend.
    // Asking SSA for that value is what makes it a proof — a redefinition on any path that reaches
    // this read produces a different value (a block parameter, at a merge), which is not in
    // `highHalves` and so refuses. Nothing consults adjacency or distance, which is why a pair eleven
    // instructions apart folds — 26% of the corpus's pairs are not adjacent — while a register
    // reused between the halves refuses.
    //
    // BLOCK IDENTITY IT DOES CONSULT, through SSA and not directly, and the refusal has to say so.
    // `readVar` during block FILLING answers from what is sealed: a chain of single-predecessor
    // blocks walks back to the `lis` and folds, but a read at a JOIN gets the block parameter that
    // stands for the merge, and in an unsealed loop header an incomplete one — neither is in
    // `highHalves`. So an `@ha` hoisted above a loop with its `@l` in the body refuses, and so does a
    // pair split across a diamond even when BOTH paths carry the same half. Over a 29,850-function
    // sweep this refusal has 0 inhabitants (`assertNoneEscaped` has 113), so the residual is
    // written down rather than built.
    const foldLoHalf = (ins: Instr, rHi: string, imm: string): Value => {
      relocTaken = true;
      const lo = ins.reloc!;
      if (parseImm(imm) !== 0) {
        throw new PpcUnsupportedError(
          `${relocSite(ins)} carries the '@l' half of '${lo.sym}' but its immediate is '${imm}', ` +
            `not the expected 0 placeholder`,
        );
      }
      // The per-ISA rest of the match: PowerPC is RELA, so the two records must agree on the addend
      // as well as the symbol — two `@ha`/`@l` pairs into the same array at different offsets are
      // different addresses.
      const hi = highHalves.pair(relocSite(ins), rHi, readVar(rHi, bi), lo.sym, (h) => h.addend === lo.addend);
      return emitGaddr(hi.sym);
    };
    const emitLoad = (ins: Instr, d: string, mem: string, width: number, signed: boolean) => {
      const { base, off } = memOperand(ins, mem);
      emit('load', d, [base], { off, width, signed });
    };
    const emitStore = (ins: Instr, srcReg: string, mem: string, width: number) => {
      const { base, off } = memOperand(ins, mem);
      ops.push(mkOp('store', { operands: [base, read(srcReg)], attrs: { off, width } }));
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
    //
    // A block starts with what its predecessor left, under the edge rule both frontends share
    // (`inheritFlags`, frontend/flags-edge.ts): one predecessor, already filled, not a jump-table
    // dispatch. The edge out of a CONDITIONAL branch carries too, because a `bc` writes no CR field:
    // mwcc's switch dispatch `cmpwi r0,1; beq- case1; bge- default` reads one compare from the
    // `beq-` and then from the `bge-` on its fall-through, which begins a block of its own.
    //
    // The clobber rule is this frontend's own: a compare writes its field, a record-form op writes
    // cr0, and a call destroys every volatile field (CR_VOLATILE). A field something else wrote holds
    // the sentence saying so rather than an entry, so the branch that reads it can name the writer.
    // Every other instruction that writes a CR field (`crxor`, `mtcrf`, `fcmpu`, …) names no
    // register destination and is refused outright by the opaque policy, so it never reaches here.
    const inherited = inheritFlags(bi, {
      preds,
      exit: exitCr,
      label: blockLabel,
      dispatches: (i) => {
        const pbr = blocks[i].branch;
        return pbr !== null && jts.has(pbr.addr);
      },
      refusesConditional: () => false,
    });
    const cmpDef = new Map<string, CrCompare | string>(typeof inherited === 'string' ? [] : inherited.fields);
    const noCmpWhy = typeof inherited === 'string' ? inherited : inherited.none;
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
      relocTaken = false;
      switch (mnem) {
        case 'nop':
          break;
        // --- call + frame/link-register bookkeeping ---
        // `bl <sym>`: read the argument registers (r3..), produce the return value in r3. The
        // callee symbol comes from the relocation (ins.reloc), and the caller-saved set is recorded
        // as destroyed (`ssa.noteCall`, below) — a read of one past here names bytes the callee
        // overwrote, and it has a reaching definition all the same.
        case 'bl': {
          relocTaken = ins.reloc?.type === 'R_PPC_REL24';
          const sym = ins.reloc?.sym ?? 'func';
          // ONE QUESTION, ONE ANSWER, AND THE OTHER FRONTEND ASKS IT THE SAME WAY. A declaration
          // states C PARAMETERS and a call site walks argument REGISTERS; `proto.ts`
          // `declaredArgWidths` converts between them and `frontend/thumb.ts` reads the same
          // answer out of the same function. A user-supplied fact that two frontends convert
          // differently is a bug wherever it is read second.
          //
          // A SPELLING NOTHING CAN SIZE STATES NO LAYOUT, so `declaredArgWidths` abstains for the
          // whole list and this falls to `fallbackArgc` — the guess a callee with no prototype gets,
          // which reads each argument register through `readGuessedArg` so `finish()` can retract
          // the ones a call destroyed. A declaration is not an excuse to ASSERT registers whose
          // count came out of the same guess.
          //
          // A PARAMETER WIDER THAN A REGISTER TRAVELS IN A PAIR, and this frontend has no pair.
          // Every argument register it reads becomes its own value, so a declaration that spends
          // two registers on one parameter is honoured by handing the callee one HALF — the high
          // half here, since PowerPC is big-endian — and losing the other. That is a compiling,
          // plausible, wrong program rather than a gap, so it refuses too.
          //
          // `Object.hasOwn` because `prototypes` is caller-supplied JSON read by symbol name: a
          // callee named `toString` otherwise reads a `Function` off `Object.prototype`.
          const widths = declaredArgWidths(Object.hasOwn(prototypes, sym) ? prototypes[sym] : undefined);
          let declared: number | undefined;
          if (widths !== undefined) {
            const wideAt = widths.findIndex((w) => w > 32);
            if (wideAt >= 0) {
              throw new PpcUnsupportedError(
                `cannot lift '${name}': one half of a 64-bit value would be handed to '${sym}' — its parameter ` +
                  `${wideAt + 1} is declared wider than a register, and this frontend passes each argument ` +
                  'register as its own value rather than building the pair the ABI passes it in',
              );
            }
            // Every width here is a single register — the refusal above is what makes that true —
            // so the parameter count and the argument-register count are the same number.
            declared = widths.length;
          }
          // THE SAME RULE ON THE WAY BACK, and it needs its own refusal because the declaration
          // reaches the candidate whether or not this frontend can act on it. `FnProto.returns`
          // states how many registers a callee hands back, `frontend/thumb.ts` reads the pair, and
          // `l3/symbol-refs.ts` prints `long long g(void);` into the candidate's own translation
          // unit on EVERY target. This frontend reads the return register alone, so honouring the
          // declaration silently would lift `return g();` off r3 — the HIGH half on big-endian
          // PowerPC — under a declaration that makes `return g();` mean the LOW one. Same source,
          // opposite value, compiles, no gap: the outcome the parameter refusal above exists to
          // prevent, arriving through the return.
          //
          // The other half of the pair already refuses (`r4 is read on a path where a call has
          // destroyed it`), so this is the arm that was left, not a second reading of one gap.
          const returned = declaredReturnWidth(Object.hasOwn(prototypes, sym) ? prototypes[sym] : undefined);
          if (returned !== undefined && returned > 32) {
            throw new PpcUnsupportedError(
              `cannot lift '${name}': '${sym}' would hand back one half of a 64-bit value — its return is ` +
                'declared wider than a register, and this frontend reads the return register as the whole ' +
                'value rather than building the pair the ABI hands back',
            );
          }
          const argc = declared ?? fallbackArgc(bi, ins.addr);
          const args: Value[] = [];
          // A GUESSED arity ASKS whether the caller set a register up and `finish()` answers by
          // dropping the ones a call has been through; a DECLARED one asserts it, so a destroyed
          // register read for it is a wrong value nothing retracts. See SsaBuilder.readGuessedArg.
          for (let k = 0; k < argc; k++) {
            const r = ARG_REGS[k];
            args.push(declared === undefined ? highHalves.guardRead(name, r, ssa.readGuessedArg(r, bi)) : read(r));
          }
          // Pushed with `tmp` rather than `emit` so the result register is written separately from
          // the op — r3.. are volatile under the EABI, so a GUESSED arity that counted a register
          // set up before an intervening call passes an argument the caller never set up
          // (`finish()` cuts those back — frontend/ssa.ts), and the call's OWN result is the
          // CALLEE's write, so `noteCall` records the clobber after it rather than before.
          const res = kit.tmp('call', args, { target: sym });
          if (declared === undefined) {
            ssa.recordGuessedCall(ops[ops.length - 1], bi, { argRegs: ARG_REGS, returnReg: RET });
          }
          write(RET, res);
          ssa.noteCall(bi, CALL_CLOBBERS);
          for (const cr of CR_VOLATILE) {
            cmpDef.set(
              cr,
              `the call at 0x${ins.addr.toString(16)} destroyed it (the EABI does not preserve ${cr} across a call)`,
            );
          }
          break;
        }
        // Stack-frame + link-register bookkeeping. `stwu r1,-N(r1)` / `addi r1,r1,N` adjust the frame
        // pointer; `mflr` copies the return address out (`returnAddresses`) and `mtlr` puts it back.
        // A word store or load on r1 is a save or a value slot (`frameStore`/`frameLoad`); `stmw`
        // records save slots.
        // The GENERAL form `stwu rS,D(rA)` (base ≠ r1) is a real store-with-BASE-UPDATE
        // (`*(rA+D)=rS; rA+=D`) — neither effect is modelled here, so loud-fail rather than drop both.
        // The push itself must be the only one, taken from the entry r1: every slot is named by its
        // offset from there (`r1Displacements`), and a push from anywhere else moves that origin.
        case 'stwu':
          if (parseMem(s).base === 'r1') {
            if (d !== 'r1' || r1At.get(ins) !== 0) {
              throw new PpcUnsupportedError(
                `cannot lift '${name}': '${ins.mnemonic} ${ins.ops.join(',')}' at 0x${ins.addr.toString(16)} ` +
                  `is not the one frame push from the entry stack pointer — ` +
                  `${d !== 'r1' ? `it stores ${d}, not the back chain` : `r1 had already moved (${r1At.get(ins)})`}`,
              );
            }
            break;
          }
          throw new PpcUnsupportedError(
            `cannot lift '${name}': stwu with update on ${parseMem(s).base} (store-with-base-update) not modelled`,
          );
        case 'mflr': {
          const lr = mkValue(T.unk(32));
          returnAddresses.set(lr, ins.addr);
          write(d, lr);
          break;
        }
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
            for (const slot of frameRange(d, entryOffset(ins, s))) {
              refuseMixedSlot(ins, s, slot.off, 'save');
              saveSlots.set(slot.off, slot.reg);
            }
            break;
          }
          assertOrdinaryMem(s);
          emitOpaqueDest(ins);
          break;
        // The restore half: `frameLoad` judges each word it reads, exactly as for a single `lwz`.
        case 'lmw':
          if (parseMem(s).base === 'r1') {
            for (const slot of frameRange(d, parseMem(s).off)) {
              frameLoad(ins, slot.reg, `${slot.off}(r1)`);
            }
            break;
          }
          assertOrdinaryMem(s);
          emitOpaqueDest(ins);
          break;
        case 'mr':
          write(d, read(s));
          break; // move register (or rD,rS,rS)
        case 'li':
          // SDA21 ADDRESS formation encodes rA=0, so objdump prints `li rD,0` + R_PPC_EMB_SDA21:
          // the linker rewrites it to `addi rD,r13,SYM@sdarx`, i.e. rD = &SYM. Same relocation and
          // same recovery as the memory form above — only the field it lands in differs.
          if (ins.reloc?.type === 'R_PPC_EMB_SDA21') {
            if (parseImm(s) !== 0) {
              throw new PpcUnsupportedError(
                `${relocSite(ins)} carries a small-data relocation ('${ins.reloc.sym}') but its ` +
                  `immediate is '${s}', not the expected 0 placeholder`,
              );
            }
            const g = emitGaddr(spellableSym(ins));
            if (ins.reloc.addend === 0) {
              write(d, g);
            } else {
              emitBin('add', d, g, constVal(ins.reloc.addend));
            }
            break;
          }
          write(d, constVal(parseImm(s)));
          break; // load immediate (addi rD,0,imm)
        case 'lis':
          // `lis rD,SYM@ha` is the high half of an absolute address, and the ONLY instruction that
          // carries `R_PPC_ADDR16_HA` in this corpus. rD is defined as a placeholder — see
          // `highHalves`.
          if (ins.reloc?.type === 'R_PPC_ADDR16_HA') {
            if (parseImm(s) !== 0) {
              throw new PpcUnsupportedError(
                `${relocSite(ins)} carries the '@ha' half of '${ins.reloc.sym}' but its immediate ` +
                  `is '${s}', not the expected 0 placeholder`,
              );
            }
            const hi = mkValue(T.unk(32));
            highHalves.record(hi, {
              sym: spellableSym(ins),
              addend: ins.reloc.addend,
              addr: ins.addr,
              mnemonic: ins.mnemonic,
            });
            write(d, hi);
            break;
          }
          write(d, constVal((parseImm(s) << 16) >> 0));
          break; // load immediate shifted
        case 'add':
        case 'addo':
          emitBin('add', d, read(s), read(t));
          break;
        // `addi r1,r1,N` is frame teardown (skip); any other addi is a real add-immediate.
        case 'addi':
        case 'addic':
          // The STACK POINTER first, before any fold looks at the operands. `addi r1,r1,N` is frame
          // teardown and is skipped; a relocation on it is no known compiler's output, and folding
          // one would write an address into r1 and let the function lift as if the teardown had
          // happened — silent, and about the frame rather than the value.
          if (d === 'r1') {
            if (ins.reloc) {
              throw new PpcUnsupportedError(
                `${relocSite(ins)} carries a relocation ('${ins.reloc.sym}') on a stack-pointer ` +
                  `adjust — an address built in r1 is not a shape this frontend models`,
              );
            }
            break;
          }
          // `addi rD,rHi,SYM@l` completes the address a `lis` began: rD = &SYM (+ the relocation's
          // addend). It is the only `@l` consumer modelled here. The others — `ori`, `addic`, and
          // the `@l`-in-a-displacement form (1,935 integer load/store sites across the three
          // checkouts, plus the float loads) — are left unbuilt per docs/level-tower.md's "earn the
          // level": no row in this benchmark reaches them. Each refuses at its own guard, and a
          // high half none of them consumed is caught by `readReg` or by the dangling-`@ha` check.
          if (mnem === 'addi' && ins.reloc?.type === 'R_PPC_ADDR16_LO') {
            const g = foldLoHalf(ins, s, t);
            if (ins.reloc.addend === 0) {
              write(d, g);
            } else {
              emitBin('add', d, g, constVal(ins.reloc.addend));
            }
            break;
          }
          // An rA field of 0 is the literal 0, not r0: `addi rD,0,SIMM` is `li`. A disassembler that
          // prints it as `addi rD,r0,SIMM` still means the constant.
          if (mnem === 'addi' && s === 'r0') {
            write(d, constVal(parseImm(t)));
            break;
          }
          // `addi rD,rS,0` is a register move: rS + 0 is rS, as Thumb's `add rD,rS,#0` is
          // (frontend/thumb.ts). mwcc 2.3.3 spells its moves this way. Lifted as an add, the `+ 0`
          // makes a pointer an integer sum, and C++ will not pass `(u32)&table + 0` as a
          // `const char *`. `addic` sets the carry and is not a move.
          if (mnem === 'addi' && parseImm(t) === 0) {
            write(d, read(s));
            break;
          }
          emitBin('add', d, read(s), constVal(parseImm(t)));
          break;
        // add immediate SHIFTED — the register-based `%ha` anchor: mwcc derives an absolute base
        // from a scaled index (`addis r4,r3,-32736` = r3 + 0x80200000). The jump-table lis/addi
        // pair recognizer is the only reloc-carrying consumer; an addis over a register is plain
        // arithmetic, and a reloc-carrying one never gets here — the choke point in `decode` takes
        // it.
        case 'addis':
          if (s === 'r0') {
            write(d, constVal((parseImm(t) << 16) >> 0)); // `addis rD,0,SIMM` is `lis`, as for `addi`
            break;
          }
          emitBin('add', d, read(s), constVal((parseImm(t) << 16) >> 0));
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
          // `ori rD,rA,sym@l` is the other `@l` half-former, unbuilt per "earn the level"; one that
          // carries a relocation refuses at the choke point rather than becoming an `or` of 0.
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
        // Word load/store: an r1-relative word is a frame slot (frameStore/frameLoad); otherwise it is
        // ordinary memory.
        case 'lwz':
          if (frameLoad(ins, d, s)) {
            break;
          }
          emitLoad(ins, d, s, 4, true);
          break;
        case 'lha':
          emitLoad(ins, d, s, 2, true);
          break;
        case 'lhz':
          emitLoad(ins, d, s, 2, false);
          break;
        case 'lbz':
          emitLoad(ins, d, s, 1, false);
          break;
        case 'stw':
          if (frameStore(ins, d, s)) {
            break;
          }
          emitStore(ins, d, s, 4);
          break;
        case 'sth':
          emitStore(ins, d, s, 2);
          break;
        case 'stb':
          emitStore(ins, d, s, 1);
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
      } else if (rc) {
        cmpDef.set(
          'cr0',
          `'${ins.mnemonic}' at 0x${ins.addr.toString(16)} wrote it from no value this frontend models`,
        );
      }
      // THE CHOKE POINT. Everything above either took the relocation or threw; a relocation still
      // sitting here was dropped, and a dropped relocation is the printed placeholder standing in
      // for an address — the forbidden class.
      if (ins.reloc && !relocTaken) {
        relocPlaceholder(ins);
      }
    };

    for (const ins of b.body) {
      decode(ins);
    }
    // No terminator writes a CR field (a `bc` reads one, `bdnz` writes CTR), so the state after the
    // body is the state at the block's exit. Recorded for EVERY block, including those whose edges
    // `inheritFlags` will refuse: the edge rule lives in one place, and a second copy of it here
    // could disagree with the first.
    exitCr.set(bi, { fields: cmpDef, none: noCmpWhy });

    const br = b.branch;
    // Recovered dense switch: the bounds block dispatches a `switch_br` over the scrutinee — N case
    // blocks (dense 0..N-1) then the default (last successor). The `cmplwi`/`bgt` and the elided
    // dispatch (`lis…lwzx;mtctr;bctr`) are subsumed.
    const jt = br ? jts.get(br.addr) : undefined;
    if (jt) {
      pushSwitchBr(
        ops,
        readReg(jt.scrutReg, bi),
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
      ops.push(mkOp('sub', { operands: [readReg('ctr', bi), constVal(1)], results: [dec] }));
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
      if (typeof cmp === 'string') {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': conditional branch '${base}' tests ${crName}, but ${cmp}`,
        );
      }
      if (!cmp) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': conditional branch '${base}' has no reaching compare (${crName}): ${noCmpWhy}`,
        );
      }
      const table = !cmp.signed ? COND_UNSIGNED : COND_SIGNED;
      const cond = mkCmp(ops, table[base], cmp.lhs, cmp.rhs);
      ops.push(mkOp('cond_br', { operands: [cond], successors: succIdx[bi].map((j) => succ(j)) }));
      return;
    }
    if (!br || isReturn(br)) {
      if (!br && succIdx[bi].length) {
        ops.push(mkOp('br', { attrs: { fallthrough: true }, successors: [succ(succIdx[bi][0])] }));
        return;
      }
      const retOps = ssa.hasReachingDef(RET, bi) ? [readReg(RET, bi)] : [];
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
  // A high half no `@l` ever completed — every `@l` consumer this frontend does not model (`ori`, a
  // float load's displacement) lands here, which is what keeps "not modelled" from becoming "not
  // emitted".
  highHalves.assertAllConsumed(name);
  // A value stored to the frame that nothing reloads is either a home the body never reads or an
  // OUTGOING stack argument (`stw r4,8(r1)` before a nine-argument `bl` passes the ninth in the
  // callee's parameter area, as ac-decomp's `aQMgr_order_decide_trade_*` do). The two are the same
  // store, and dropping the second loses an argument.
  for (const { addr, mem, read } of valueSlots.values()) {
    if (!read) {
      throw new PpcUnsupportedError(
        `cannot lift '${name}': local stack frames not supported — '${mem}' is stored at 0x${addr.toString(16)} ` +
          `and never read back, and an unread home and a call's argument passed on the stack are the same store`,
      );
    }
  }
  const argSlots = registerArgSlots(ARG_REGS);
  mintArgSlotHoles(ssa, preds[0].length > 0, argSlots);
  ssa.finish();
  highHalves.assertNoneEscaped(name, irBlocks);
  // Checked on the finished function, after `finish` pruned the joins nothing reads, because a
  // return address reaches a use through a join's incoming arguments as well as directly.
  for (const b of irBlocks) {
    for (const op of b.ops) {
      const lr = [...op.operands, ...op.successors.flatMap((s) => s.args)].find((v) => returnAddresses.has(v));
      if (lr !== undefined) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': the return address the 'mflr' at 0x${returnAddresses.get(lr)!.toString(16)} ` +
            `copies out is used as a value — a function reading its own return address has no C spelling`,
        );
      }
    }
  }

  abiSortEntryParams(irBlocks[0], preds[0].length > 0, paramReg, argSlots);
  return ssa.fn;
}

function mkCmp(ops: Op[], opc: Opcode, l: Value, r: Value): Value {
  const v = mkValue(T.unk(32));
  ops.push(mkOp(opc, { operands: [l, r], results: [v] }));
  return v;
}

/** The PowerPC / CodeWarrior frontend, registered for the `ppc` target. */
export const ppcFrontend: Frontend = { id: 'ppc', inputFormat: 'objdump', lift };
