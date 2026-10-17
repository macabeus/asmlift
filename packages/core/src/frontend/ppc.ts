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
//    stack-slot variable (`frameStore`). Inside the local area of a function that takes a frame
//    address (`measurePpcFrame`), every access is memory through a frame object the shared audit
//    proves instead.
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
import { Block, Fn, Op, Successor, Value, mkOp, mkValue, replaceAllUsesWith } from '../ir/core';
import { deletableWhenDead, spelledWhenDead } from '../ir/discipline';
import type { Opcode } from '../ir/opcodes';
import { T } from '../ir/types';
import { demangle } from '../mangle';
import { type FnProto, type Prototypes, declaredWidth, declaresVoidReturn, isFloatingSpelling } from '../proto';
import type { ContextGlobals } from '../proto-context';
import { registerSaveRoutineOf } from '../runtime-helpers';
import type { SymbolMap } from '../symbols';
import type { TargetDescription } from '../target';
import { type AsmData, readJumpTable } from './asmdata';
import { type CallDeclarations, type ParamClass, callDeclarations } from './call-plan';
import { type Declarations, leftInDiscardRegister, pinDeadReads, unreadPairHalf } from './dead-reads';
import { pinDeviceAccesses } from './device-pins';
import {
  type DisasmInstr,
  parseImm,
  parseDisasm as parseSharedDisasm,
  parseMem as parseSharedMem,
  sliceSymbol,
} from './disasm';
import { mkEmitKit, pushSwitchBr } from './emit';
import { type FrontendRefusal, FrontendUnsupportedError } from './errors';
import { inheritFlags } from './flags-edge';
import { assertInputFormat } from './format';
import { fpPrecision, fpuArgSlots, refuseBothPrecisions, writesFloatReturn } from './fpu';
import {
  FRAME_OBJECT_AUDIT,
  type FrameObjectRelift,
  type FrameRange,
  areaAboveOutgoing,
  landsOnArea,
  liftWithRelift,
} from './frame-objects';
import type { Frontend } from './frontend';
import { makeHighHalves } from './high-half';
import {
  type HoistedDispatch,
  type TableKey,
  agreedTable,
  entersBetween,
  makeTableBases,
  refuseReachableDispatch,
} from './jump-table';
import { makeLocalStatics, readObjectLocalObject } from './local-object';
import { opaqueDest } from './opaque';
import { classifyRelocSymbol, unspellableReason } from './reloc-symbol';
import {
  type ArgSlots,
  abiSortEntryParams,
  incomingStackArgKey,
  mintArgSlotHoles,
  stackArgSlots,
  stackSlotKey,
} from './ssa';
import { makeSsaBuilder, registerLiveIns } from './ssa';

type Instr = DisasmInstr;

/** The instructions that READ the carry bit (each also writes it), and every other writer of it. */
const CARRY_READERS = /^(adde|addme|addze|subfe|subfme|subfze)o?$/;
const CARRY_WRITERS = /^(addc|addco|addic|subfc|subfco|subfic|srawi|sraw|mtxer|mcrxr)$/;

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

/** The FPU arithmetic this frontend lifts, onto the float opcodes, with the precision each computes
 *  in; `fmr` is a copy and has no opcode. `fneg` and `fmr` carry no precision at all — an FPR holds a
 *  double either way — so they take the function's (`frontend/fpu.ts` `fpPrecision`); in a function
 *  of only those, the floats state none (`T.fUnstated`), because the float and double spellings of a
 *  negation or a copy compile to one object. Everything else in the file keeps the register-file refusal `opaqueDest` gives it: `frsp`, the
 *  loads and stores, the conversions, the compares, the fused multiply-adds, paired singles — and a
 *  record form (`fadds.`), which sets `cr1`. */
const FP_ARITH: Readonly<Record<string, { op: Opcode | 'copy'; width: 32 | 64 | null }>> = {
  fadds: { op: 'fadd', width: 32 },
  fsubs: { op: 'fsub', width: 32 },
  fmuls: { op: 'fmul', width: 32 },
  fdivs: { op: 'fdiv', width: 32 },
  fadd: { op: 'fadd', width: 64 },
  fsub: { op: 'fsub', width: 64 },
  fmul: { op: 'fmul', width: 64 },
  fdiv: { op: 'fdiv', width: 64 },
  fneg: { op: 'fneg', width: null },
  fmr: { op: 'copy', width: null },
};
const FP_ARITH_MNEMONICS: ReadonlySet<string> = new Set(Object.keys(FP_ARITH));

/** An FPU register: the token, and the key the SSA builder holds it under. ONE predicate for the
 *  decode above and the register-file refusal below (`fpReg`), so a token one of them reads as an
 *  FPR cannot be one the other does not. */
const PPC_FP_REG = /^f\d+$/;
const isFpKey = (k: string) => PPC_FP_REG.test(k);

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
// by the BOUNDS branch (`bgt DEF`, or `bgtlr`) whose block emits the `switch_br`. `caseAddrs[k]` is the `.text`
// address of case `k` (dense 0..N-1); `bctrAddr` is the elided dispatch's indirect jump. The mwcc
// idiom:
//   cmplwi rS,N-1 ; bgt DEF                                        (bounds)
//   lis rT,0 [ADDR16_HA @tbl] ; slwi rIdx,rS,2 ; addi rB,rT,0 [ADDR16_LO @tbl]
//   ; lwzx rV,rB,rIdx ; mtctr rV ; bctr                           (dispatch — table in .data)
// mwcc schedules other words into the bounds pair (`boundsCompare`), orders the dispatch's freely,
// and 2.3.3 forms the table base outside the dispatch (`hoistedTable`).
interface PpcJT {
  scrutReg: string;
  /** The bounds compare's address: nothing may enter after it, up to the `bctr`. */
  cmpAddr: number;
  caseAddrs: number[];
  /** The default arm's address, or null for a `bgtlr` bound: out-of-range values return. */
  defaultAddr: number | null;
  bctrAddr: number;
  /** The base register and table of a dispatch whose block does not form its base (mwcc 2.3.3
   *  hoists the `lis`/`addi` pair out of a loop): `lift` proves the base reaches it
   *  (frontend/jump-table.ts). Null when the pruned block forms the base itself. */
  hoisted: HoistedDispatch | null;
}

/** The `cr` field a compare writes or a conditional branch reads: its first operand when it names
 *  one, else cr0. */
const crFieldOf = (ins: Instr): string => (ins.ops[0]?.startsWith('cr') ? ins.ops[0] : 'cr0');

/** Whether `ins` may write a CR field. A DENY-LIST, so an unknown writer stops the reader rather
 *  than being stepped past: the compares, the record forms (`.`), the CR-logical and move-to-CR
 *  forms, and every branch — a `bl` destroys the volatile fields. */
const mayWriteCr = (ins: Instr): boolean =>
  /^(cmp|fcmp|cr|mcr|mtcr|b)/.test(ins.mnemonic) || ins.mnemonic.endsWith('.');

/** Whether `ins` may write GPR `r`. A DENY-LIST like mips.ts's `writtenReg`: an instruction writes
 *  its first operand unless it is a store, compare, trap, move-to-special or cache op; an update form
 *  (`lwzu`, `stwux`) also writes its base, `lmw rD` writes rD..r31, and any branch may (a call
 *  clobbers the volatile registers). */
const mayWriteGpr = (ins: Instr, r: string): boolean => {
  const m = ins.mnemonic;
  if (m.startsWith('b')) {
    return true;
  }
  if (m === 'lmw') {
    return /^r\d+$/.test(r) && Number(r.slice(1)) >= Number(ins.ops[0]?.slice(1));
  }
  if (/^(l|st)\w*ux?$/.test(m) && ins.ops.slice(1).some((o) => new RegExp(`\\b${r}\\b`).test(o))) {
    return true;
  }
  return !/^(st|cmp|fcmp|tw|mt|dc|ic|sync|isync|eieio)/.test(m) && ins.ops[0] === r;
};

/** The bounds compare of a jump table, or null: the `cmplwi rS,N-1` the bounds branch at `j` reads,
 *  with its address and the case count `n` it states. Scanned back inside the branch's block, past
 *  instructions that write neither a CR field nor `rS` — mwcc schedules the default's value or the
 *  LR save between the two — and it must set the CR field the branch tests. The first CR writer met
 *  decides: any other one, or a write of `rS` after the compare, declines. So does a branch landing
 *  after the compare, up to the bounds branch itself: that path brings a CR field of its own, and the
 *  `switch_br` would bound it by a compare it never ran (`entersBetween`). */
function boundsCompare(instrs: Instr[], j: number, scrutReg: string): { addr: number; n: number } | null {
  const crField = crFieldOf(instrs[j]);
  for (let k = j - 1; k >= 0 && !isXfer(instrs[k]); k--) {
    const c = instrs[k];
    if (c.mnemonic === 'cmplwi' && c.ops[c.ops.length - 2] === scrutReg && crFieldOf(c) === crField) {
      return entersBetween(instrs, c.addr, instrs[j].addr)
        ? null
        : { addr: c.addr, n: parseImm(c.ops[c.ops.length - 1]) + 1 };
    }
    if (mayWriteCr(c) || mayWriteGpr(c, scrutReg)) {
      return null;
    }
  }
  return null;
}

/** The table a base formed OUTSIDE the dispatch block addresses, as far as the instructions say:
 *  every `addi rB,rX,SYM@l` in the function must name one table, or the guess is left undecided.
 *  mwcc 2.3.3 forms the base once at entry and dispatches from a loop. Only a guess — `lift` pairs
 *  the halves and proves the base reaches the dispatch (frontend/jump-table.ts). */
const hoistedTable = (instrs: Instr[], rB: string): TableKey | null =>
  agreedTable(
    instrs.flatMap((x) =>
      x.mnemonic === 'addi' && x.ops[0] === rB && x.reloc?.type === 'R_PPC_ADDR16_LO' && parseImm(x.ops[2]) === 0
        ? [{ sym: x.reloc.sym, addend: x.reloc.addend }]
        : [],
    ),
  );

// Recover mwcc jump tables from the dispatch idiom + the AsmData side-table. Fail-closed: any
// deviation from the idiom, or a table that doesn't resolve to N in-function targets, declines
// (→ the `bctr` loud-fail fires). Index IDENTITY guard: `slwi rIdx,rS,2` must be the bounds-checked
// scrutinee scaled only by <<2 — no xor/neg/extra op.
function recoverPpcJumpTables(instrs: Instr[], ad: AsmData): Map<number, PpcJT> {
  const out = new Map<number, PpcJT>();
  for (let i = 0; i < instrs.length; i++) {
    if (instrs[i].mnemonic !== 'bctr') {
      continue;
    }
    // THE DISPATCH BLOCK: after the bounds branch, the nearest transfer before the `bctr`.
    let j = i - 1;
    while (j >= 0 && !isXfer(instrs[j])) {
      j--;
    }
    const bgt = instrs[j];
    // `bgt DEF`, or `bgtlr` when the default arm is the return itself: mwcc bounds a switch whose
    // default falls straight out of a leaf that way.
    if (!bgt || !((bgt.mnemonic === 'bgt' && bgt.target !== undefined) || bgt.mnemonic === 'bgtlr')) {
      continue;
    }
    // Each piece of the idiom is the LAST write of its register inside the block, so nothing between
    // a def and its reader can have changed it. The order varies: mwcc 2.4.2 scales the index first,
    // GC/1.2.5n forms the table's low half first.
    const defIn = (r: string, before: number): number => {
      for (let k = before - 1; k > j; k--) {
        if (mayWriteGpr(instrs[k], r)) {
          return k;
        }
      }
      return -1;
    };
    const mi = i - 1;
    const mtctr = instrs[mi];
    if (mtctr?.mnemonic !== 'mtctr' || mi <= j) {
      continue;
    }
    const li = defIn(mtctr.ops[0], mi); // rV = mem[rB + rIdx]
    const lwzx = instrs[li];
    if (lwzx?.mnemonic !== 'lwzx') {
      continue;
    }
    const [rB, rIdx] = [lwzx.ops[1], lwzx.ops[2]];
    const si = defIn(rIdx, li);
    const slwi = instrs[si];
    if (slwi?.mnemonic !== 'slwi' || (slwi.ops[2] !== '2' && slwi.ops[2] !== '0x2')) {
      continue;
    } // identity: rIdx = rS<<2
    const scrutReg = slwi.ops[1];
    const ai = defIn(rB, li);
    const lisI = ai < 0 ? -1 : defIn(instrs[ai].ops[1], ai);
    const hoisted = ai < 0 ? hoistedTable(instrs, rB) : null;
    let table: TableKey | null = hoisted;
    if (ai >= 0) {
      const [lis, addi] = [instrs[lisI], instrs[ai]];
      // The table's base is the same `@ha`/`@l` pair the address fold consumes and must show the
      // same evidence — both relocation types, one symbol, one addend — so a dispatch is never
      // recovered from two instructions that never addressed the table together. It stays a
      // separate pairing: it runs before the blocks exist, and it wants the table's NAME, for
      // `readJumpTable`, not its address. It skips the naming policy deliberately — a table base is
      // read here as data, never written into the candidate as an identifier — so the `@N` and
      // `.`-prefixed symbols the address fold must refuse (292 of the corpus's `ADDR16` relocations)
      // are harmless here.
      table =
        addi.mnemonic === 'addi' &&
        parseImm(addi.ops[2]) === 0 &&
        lis?.mnemonic === 'lis' &&
        lis.ops[0] === addi.ops[1] &&
        lis.reloc?.type === 'R_PPC_ADDR16_HA' &&
        addi.reloc?.type === 'R_PPC_ADDR16_LO' &&
        addi.reloc.sym === lis.reloc.sym &&
        addi.reloc.addend === lis.reloc.addend
          ? { sym: lis.reloc.sym, addend: lis.reloc.addend }
          : null;
    }
    if (table === null) {
      continue;
    }
    // The block is pruned unread once the table is recovered, so it may hold the idiom and nothing
    // else, nothing may branch into it past the bounds check, and none of the idiom may rewrite the
    // scrutinee before the `slwi` scales it — the `switch_br` reads it at the bounds branch.
    const idiom = new Set(hoisted === null ? [lisI, si, ai, li, mi] : [si, li, mi]);
    if (
      instrs.slice(j + 1, i).some((_, o) => !idiom.has(j + 1 + o)) ||
      instrs.slice(j + 1, si).some((x) => mayWriteGpr(x, scrutReg)) ||
      entersBetween(instrs, bgt.addr, instrs[i].addr)
    ) {
      continue;
    }
    const bound = boundsCompare(instrs, j, scrutReg);
    if (bound === null || bound.n < 2) {
      continue;
    }
    const caseAddrs = readJumpTable(ad, table.sym, table.addend, bound.n);
    if (!caseAddrs) {
      continue;
    }
    out.set(bgt.addr, {
      scrutReg,
      cmpAddr: bound.addr,
      caseAddrs,
      defaultAddr: bgt.target ?? null,
      bctrAddr: instrs[i].addr,
      hoisted: hoisted === null ? null : { reg: rB, table: hoisted },
    });
  }
  // A table's case is a branch target too, which `entersBetween` cannot see before the tables are
  // read: one landing between a table's bounds compare and its indirect jump — its own table's or
  // another's — enters that window as a branch would, and that table declines.
  const cases = [...out.values()].flatMap((jt) => jt.caseAddrs);
  for (const [at, jt] of out) {
    if (cases.some((a) => a > jt.cmpAddr && a <= jt.bctrAddr)) {
      out.delete(at);
    }
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
    if (jt.defaultAddr !== null) {
      leaders.add(jt.defaultAddr);
    }
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
  /** A conditional return's taken edge: a block of its own that returns, appended past the real ones.
   *  Its index. */
  const synthReturn = (): number => {
    blocks.push({ startAddr: -1 - blocks.length, body: [], branch: null, synthReturn: true });
    succIdx.push([]);
    return blocks.length - 1;
  };
  blocks.forEach((b, i) => {
    const br = b.branch;
    // Recovered switch: the bounds block dispatches to its case blocks + default (the `cmplwi`/`bgt`
    // and the elided dispatch block are subsumed into a `switch_br`). Every case/default addr is a
    // leader, so all resolve; a target that is not a block boundary makes it malformed → loud-fail.
    const jt = br ? jts.get(br.addr) : undefined;
    if (jt) {
      const succ: Array<number | undefined> = jt.caseAddrs.map((a) => idxOf.get(a));
      if (jt.defaultAddr !== null) {
        succ.push(idxOf.get(jt.defaultAddr));
      } else {
        // A `bgtlr` bound: the default edge is a synthetic return, as for any conditional return.
        succ.push(synthReturn());
      }
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
      const si = synthReturn();
      const fall = idxOf.get(br.addr + 4); // fall = instruction after the cond-return (no delay slot)
      succIdx[i] = fall !== undefined ? [si, fall] : [si];
      return;
    }
    // conditional branch to a label: [taken, fall]. Both must land on block boundaries; otherwise the
    // branch falls off the function's end or targets unrecovered flow — fail LOUD and catchably
    // rather than silently dropping an edge (which surfaces as an opaque `verify` successor-count error).
    // A branch out of the function, relocated or not, has already refused as a tail call (`liftPrelude`).
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

/** The PPC EABI's small-data base registers: r13 points into `.sdata`/`.sbss` and r2 into
 *  `.sdata2`/`.sbss2`, both set once by the runtime's startup code and never by a compiled function.
 *  A compiled access names its symbol in an `R_PPC_EMB_SDA21` relocation, which this frontend reads
 *  instead of the base (`sdaAccess`). A base read as a VALUE — `lbzx r0,r3,r13`, which mwcc 2.4.7
 *  emits for `playerOrderNew[j - 1]` (MP4 `OrderPlayers`), or `lwz r3,-0x7ff0(r13)` in a linked image —
 *  has no C spelling here, and the SSA builder would otherwise read the def-less register as an
 *  invented parameter. It refuses, as MIPS refuses `gp` used as data. */
const SMALL_DATA_BASES: readonly string[] = ['r13', 'r2'];

/** The link register's save word, as an offset from the entry r1: the second word of the caller's
 *  frame header, after the back chain. mwcc 2.3.3 spells it `4(r1)` before the push and 2.4.x
 *  `N+4(r1)` after it (`r1Displacements`). */
const LR_SAVE_WORD = 4;
/** The caller's parameter area, as an offset from the entry r1: past the back chain and the link
 *  register's save word, the words a call takes past its eight argument registers. */
const PARAM_AREA_AT = 8;

/** The register save or restore routine a `bl` calls (runtime-helpers.ts `RegisterSaveRoutines`),
 *  named by its `R_PPC_REL24`, or null for any other `bl`. Only the relocation names it: a `bl` with
 *  none — a linked image, or an objdump without `-r` — is no routine, and `case 'bl'` refuses it
 *  there as a call with no callee symbol. */
const saveRoutineOf = (target: TargetDescription, ins: Instr) =>
  ins.mnemonic === 'bl' && ins.reloc?.type === 'R_PPC_REL24'
    ? registerSaveRoutineOf(target.registerSaveRoutines, ins.reloc.sym)
    : null;

/** A general register a callee must preserve: one the EABI neither passes an argument in, nor lets
 *  a callee destroy, nor reserves (r1, and the small-data bases). `prologueSavedRegs` counts the
 *  first store of ANY register in `regs`; only these are saves of the caller's value in `offsets`. */
const isCalleeSaved = (target: TargetDescription, r: string): boolean =>
  isReg(r) &&
  r !== 'r1' &&
  !SMALL_DATA_BASES.includes(r) &&
  !target.argRegs.includes(r) &&
  !target.callerSaved.includes(r);

/** WHAT THE PROLOGUE SAVED, AND WHERE. `regs` is the save half of the register partition
 *  (frontend/ssa.ts, `LiveInModel.uninitRegs`). A register the ABI passes no argument in is an
 *  uninitialised local only where the compiler could home a local there, which it may do only after
 *  saving it; without this, an uninitialised local in a callee-saved register lifts as an extra
 *  PARAMETER (`int x; if (s) x = k(a); return k(a) + x;` would take a third).
 *
 *  Read off the ENTRY block, the one every path starts with: `stmw rS,D(r1)` saves rS..r31, a GPR
 *  save routine rNN..r31, and `stw rN,D(r1)` rN. A register counts as saved only where NO earlier
 *  instruction names it, as an operand or as a memory base, read or written. That is what a save
 *  is: the first thing the function does with the register. A write before the store makes the
 *  `stw` a spill; a READ before it is asm handed a live value there, which the save then preserves
 *  — the very case the save half exists to keep a parameter for, so it must not count.
 *
 *  NOT Thumb's rule (`savedRegs` in frontend/thumb.ts), which ends the measurement at the end of the
 *  LEADING run of saves. mwcc interleaves its saves with the body's first instructions
 *  (`stw r31,12(r1); mr r31,r3; stw r30,8(r1)`), and the save routine's `addi r11,r1,N` need not sit
 *  next to its `bl`, so a leading run would drop saves the prologue really makes. The two rules
 *  agree on what they let through: no instruction before a counted save touches the register. The
 *  operand text can only over-name (a register spelt in a branch target names nothing), which
 *  under-states the set — the direction that keeps a parameter.
 *
 *  `offsets` are where the saves of the caller's values lie, as entry-r1 offsets, which bound the
 *  local area from above (`measurePpcFrame`): each `stw` of a callee-saved register (`isCalleeSaved`)
 *  the same first-naming rule counts, each such word of a `stmw`, each word a save routine stores
 *  below its frame address (`addi r11,r1,N`), and each floating-point save (`stfd`, or the FPR
 *  routine), which this frontend refuses elsewhere but which still bounds where a local may lie.
 *  Null where a save's offset cannot be named: r1's depth at it, or the routine's frame address, is
 *  unknown. */
function prologueSavedRegs(
  entry: readonly Instr[],
  target: TargetDescription,
  r1At: ReadonlyMap<Instr, number | string>,
): { regs: ReadonlySet<string>; offsets: number[] | null } {
  const regs = new Set<string>();
  const named = new Set<string>();
  const offsets: number[] = [];
  let unnamed = false;
  const word = (off: number | null) => {
    if (off === null) {
      unnamed = true;
    } else {
      offsets.push(off);
    }
  };
  let frameAddress: number | null = null;
  for (const ins of entry) {
    const [d, s] = ins.ops;
    const depth = r1At.get(ins);
    const routine = saveRoutineOf(target, ins);
    if (ins.mnemonic === 'addi' && d === target.registerSaveRoutines?.frameReg && s === 'r1') {
      frameAddress = typeof depth === 'number' ? depth + parseImm(ins.ops[2]) : null;
    } else if (routine) {
      if (!routine.restore) {
        const bytes = routine.fpr ? 8 : 4;
        for (let k = routine.first; k <= 31; k++) {
          if (!routine.fpr && !named.has(`r${k}`)) {
            regs.add(`r${k}`);
          }
          word(frameAddress === null ? null : frameAddress - bytes * (32 - k));
        }
      }
    } else if (/^(stw|stmw|stfd)$/.test(ins.mnemonic) && s?.includes('(') && parseMem(s).base === 'r1') {
      const first = ins.mnemonic === 'stmw' ? Number(d.slice(1)) : 0;
      const n = ins.mnemonic === 'stmw' ? 32 - first : 1;
      for (let k = 0; k < n; k++) {
        const reg = ins.mnemonic === 'stmw' ? `r${first + k}` : d;
        if (ins.mnemonic !== 'stfd' && !named.has(reg)) {
          regs.add(reg);
        }
        if (ins.mnemonic === 'stfd' || (isCalleeSaved(target, reg) && !named.has(reg))) {
          word(typeof depth === 'number' ? parseMem(s).off + depth + 4 * k : null);
        }
      }
    }
    for (const op of ins.ops) {
      const reg = op.includes('(') ? parseMem(op).base : op;
      if (isReg(reg)) {
        named.add(reg);
      }
    }
  }
  return { regs, offsets: unnamed ? null : offsets };
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
  // A block whose displacement is unknown stays unknown, under the first reason found.
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

/** What the link-register proof knows at one point: what the link register holds (`lr`: null where
 *  it is still the caller's return address on every path, else the instruction that put something
 *  else there on some path), which general registers hold a copy of the return address on every
 *  path (`regs`), and whether the link register's save word does (`slot`). */
interface LrState {
  readonly lr: Instr | null;
  readonly regs: ReadonlySet<string>;
  readonly slot: boolean;
}

/** EVERY RETURN OF THIS FUNCTION JUMPS THROUGH THE CALLER'S RETURN ADDRESS, or the lift declines —
 *  PowerPC's half of what `refuseReturnsNotThroughCallersLr` asks of Thumb (frontend/thumb.ts).
 *
 *  `blr` and a conditional return (`beqlr`) read as returns from the instruction alone, and each is
 *  one only where the link register holds the address this function was called with. A forward
 *  dataflow over the blocks tracks where that address is:
 *    • the link register holds it at entry; a `bl` writes it (a call, and a register save or restore
 *      routine too), and an `mtlr rS` puts back whatever rS holds;
 *    • `mflr rD` copies it into rD, `mr` copies it on, and any other write to a register loses it —
 *      an ordinary call loses every register the EABI lets a callee destroy, a save routine none, and
 *      a GPR restore routine the r{first}..r31 it reloads, as `lmw` does;
 *    • a `stw` of a register holding it into the link register's save word (`LR_SAVE_WORD`, named
 *      from the entry r1 through `r1At`) puts it in that word, and a `lwz` from that word copies it
 *      back out. Any other store reaching those bytes, a store through r1 at an unknown depth, a call
 *      made before the frame push (the callee saves ITS return address in that very word), and a
 *      save routine whose frame address could reach it all overwrite it.
 *  Paths meet by agreement: the link register, a register or the word holds the address only if it
 *  does on every path in.
 *
 *  So `li r3,7; mtlr r4; blr`, `lwz r0,0(r3); mtlr r0; blr`, `mflr r0; addi r0,r0,4; mtlr r0; blr`, an
 *  `mtlr` on one path only, and a `bl` with no saved address put back before the `blr` all decline,
 *  where mwcc's `mflr r0; stw r0,N+4(r1)` … `lwz r0,N+4(r1); mtlr r0; blr` (2.3.3 saves at `4(r1)`
 *  before the push) and a leaf that never names the link register are returns. No compiler emits a
 *  violation; hand-written asm can, and it would otherwise lift as a C `return`.
 *
 *  Returned per instruction that reads the link register as the return address where it may not be
 *  that, with the instruction that put something else there on some path: a return, and an `mflr`
 *  after a `bl` (its copy would be taken for the return address, and is the address after the `bl`
 *  instead). Absent everywhere else. Blocks no path from the entry reaches are not asked: they never
 *  run.
 *
 *  NOT ASKED: a store through a register holding a frame address (`addi r3,r1,N`) is not traced to
 *  the save word. A compiler addresses that word only through r1. */
function linkRegisterProof(
  blocks: PpcBlock[],
  succIdx: number[][],
  r1At: ReadonlyMap<Instr, number | string>,
  target: TargetDescription,
): Map<Instr, Instr> {
  const at = new Map<Instr, Instr>();
  const destroyed = new Set(['r0', ...target.argRegs, ...target.callerSaved]);
  const frameReg = target.registerSaveRoutines?.frameReg;
  const join = (a: LrState, b: LrState): LrState => ({
    lr: a.lr ?? b.lr,
    regs: new Set([...a.regs].filter((r) => b.regs.has(r))),
    slot: a.slot && b.slot,
  });
  const same = (a: LrState, b: LrState) =>
    a.lr === b.lr && a.slot === b.slot && a.regs.size === b.regs.size && [...a.regs].every((r) => b.regs.has(r));
  // The bytes `[lo, hi)` a store through r1 writes, as entry-r1 offsets, or null where r1's depth is
  // not known there or the address takes an index register.
  const storedRange = (ins: Instr): [number, number] | null => {
    const d = r1At.get(ins);
    const mem = ins.ops[1];
    if (typeof d !== 'number' || !mem?.includes('(')) {
      return null;
    }
    const mn = ins.mnemonic;
    const width =
      mn === 'stmw'
        ? 4 * (32 - Number(ins.ops[0].slice(1)))
        : /^stb/.test(mn)
          ? 1
          : /^sth/.test(mn)
            ? 2
            : /^stfd/.test(mn)
              ? 8
              : 4;
    const lo = parseMem(mem).off + d;
    return [lo, lo + width];
  };
  const namesR1 = (ins: Instr) => ins.ops.some((op) => (op.includes('(') ? parseMem(op).base : op) === 'r1');

  const run = (bi: number, inState: LrState, record: boolean): LrState => {
    let { lr, slot } = inState;
    const regs = new Set(inState.regs);
    let frameAddress: number | null = null;
    for (const ins of [...blocks[bi].body, ...(blocks[bi].branch ? [blocks[bi].branch] : [])]) {
      const mn = ins.mnemonic;
      const [d, s] = ins.ops;
      if (
        record &&
        ((mn === 'mflr' && lr?.mnemonic === 'bl') || ((isReturn(ins) || isCondReturn(ins)) && lr !== null))
      ) {
        at.set(ins, lr!);
      }
      if (mn === 'bl') {
        const routine = saveRoutineOf(target, ins);
        lr = ins;
        if (routine) {
          // A save routine stores below its frame address; a restore routine writes no memory.
          const bytes = routine.fpr ? 8 : 4;
          if (
            !routine.restore &&
            (frameAddress === null ||
              (frameAddress - bytes * (32 - routine.first) < LR_SAVE_WORD + 4 && frameAddress > LR_SAVE_WORD))
          ) {
            slot = false;
          }
          // A GPR restore routine reloads r{first}..r31 from their save words, as `lmw` does: none of
          // them holds the return address after it, whatever was copied into them before.
          if (routine.restore && !routine.fpr) {
            for (const r of [...regs]) {
              if (Number(r.slice(1)) >= routine.first) {
                regs.delete(r);
              }
            }
          }
        } else {
          for (const r of destroyed) {
            regs.delete(r);
          }
          if (r1At.get(ins) === 0 || typeof r1At.get(ins) !== 'number') {
            slot = false;
          }
        }
        continue;
      }
      if (mn === 'mtlr') {
        lr = regs.has(d) ? null : ins;
        continue;
      }
      if (mn === 'mflr') {
        if (lr === null) {
          regs.add(d);
        } else {
          regs.delete(d);
        }
        continue;
      }
      if (/^st/.test(mn)) {
        if (namesR1(ins)) {
          const range = storedRange(ins);
          if (mn === 'stw' && range !== null && range[0] === LR_SAVE_WORD && regs.has(d)) {
            slot = true;
          } else if (range === null || (range[0] < LR_SAVE_WORD + 4 && range[1] > LR_SAVE_WORD)) {
            slot = false;
          }
        }
        // An update form writes its base register.
        if (/^st\w*ux?$/.test(mn)) {
          regs.delete(s?.includes('(') ? parseMem(s).base : s);
        }
        continue;
      }
      if (/^(cmp|tw|mt|dc|ic|b|sync|isync|eieio)/.test(mn)) {
        continue;
      }
      if (mn === 'lmw' || /^lsw/.test(mn)) {
        const first = mn === 'lmw' ? Number(d.slice(1)) : 0;
        for (const r of [...regs]) {
          if (Number(r.slice(1)) >= first) {
            regs.delete(r);
          }
        }
        continue;
      }
      const copies =
        (mn === 'mr' && regs.has(s)) ||
        (mn === 'or' && s === ins.ops[2] && regs.has(s)) ||
        (mn === 'lwz' &&
          slot &&
          s?.includes('(') &&
          parseMem(s).base === 'r1' &&
          typeof r1At.get(ins) === 'number' &&
          parseMem(s).off + (r1At.get(ins) as number) === LR_SAVE_WORD);
      if (frameReg !== undefined && mn === 'addi' && d === frameReg && s === 'r1' && !ins.reloc) {
        const depth = r1At.get(ins);
        frameAddress = typeof depth === 'number' ? depth + parseImm(ins.ops[2]) : null;
      } else if (d === frameReg) {
        frameAddress = null;
      }
      if (isReg(d)) {
        regs.delete(d);
      }
      // A load with update writes its base register too.
      if (/^l\w*ux?$/.test(mn) && mn !== 'lux') {
        regs.delete(s?.includes('(') ? parseMem(s).base : s);
      }
      if (copies && isReg(d)) {
        regs.add(d);
      }
    }
    return { lr, regs, slot };
  };

  const into: Array<LrState | undefined> = blocks.map(() => undefined);
  into[0] = { lr: null, regs: new Set(), slot: false };
  const work = [0];
  while (work.length) {
    const bi = work.pop()!;
    const out = run(bi, into[bi]!, false);
    for (const s of succIdx[bi]) {
      const prev = into[s];
      const next = prev === undefined ? out : join(prev, out);
      if (prev === undefined || !same(prev, next)) {
        into[s] = next;
        work.push(s);
      }
    }
  }
  // Ask each reader once the states are settled, so a reason names the fixed point's writer.
  into.forEach((st, bi) => {
    if (st !== undefined) {
      run(bi, st, true);
    }
  });
  return at;
}

/** The sub-word load and store mnemonics this frontend lifts. */
const SUBWORD_MEM: ReadonlySet<string> = new Set(['lbz', 'lha', 'lhz', 'stb', 'sth']);

/** An instruction that takes a frame address as data: `addi rD,r1,k`. The register save routines'
 *  `addi r11,r1,N` is frame bookkeeping (`frame-address` in `nonValues`), not a capture. */
const takesFrameAddress = (ins: Instr, frameReg: string | undefined): boolean =>
  ins.mnemonic === 'addi' && ins.ops[1] === 'r1' && ins.ops[0] !== 'r1' && ins.ops[0] !== frameReg && !ins.reloc;

/** THE LOCAL AREA of a function that takes a frame address, reaches its frame below a word, or
 *  keeps a dead local there, and the size of the one frame it pushes — or null, which leaves every
 *  such access the refusal it had without one. Null where none of the three happens; where the
 *  function does not push exactly one frame, with `stwu r1,-N(r1)` at entry depth; where a capture
 *  runs at another depth; where the target states no layout, a save's offset cannot be named, or
 *  no area is left; and where an r1 access at another depth lands on the area's bytes
 *  (`landsOnArea`), which the routing by post-push offset would then misname.
 *
 *  The area starts where the caller's parameter area does (`PARAM_AREA_AT`), past the back chain
 *  and the link-register save word, and runs to the lowest save (`compilerBehaviors.linkageLocalArea`,
 *  `areaAboveOutgoing`). The measured rule puts it past the widest call's stack words too; no call
 *  this frontend lowers takes any, so a call whose declaration may take some refuses here, where the
 *  area is drawn: one declared with more parameter words than argument registers, with a 64-bit parameter (the EABI
 *  aligns a pair to an odd register, so a packed word count does not say where the stack words
 *  start), or with more floating parameters than f1..f8. So does a declared parameter that is a
 *  struct or union passed by value (`ParamClass` `by-value`), which mwcc passes as the address of a
 *  copy in this area (`tb(1, b)` copies `b` to r1+8 and passes `addi r4,r1,8` at -O4,p) — a copy no
 *  source declares, whose address the lift would pass where the callee takes the struct — and one
 *  nothing sizes (`unsized`), which may be that, a pair or a stack word.
 *
 *  A CALL NOTHING DECLARES IS NOT PROVEN CLEAR OF THE AREA HERE, and neither does its lowering's
 *  guess prove it: the guess refuses a call whose guessed arity reaches seven argument registers
 *  (`lift`, the guess's `refuse`), but it counts only the registers this function sets, none it
 *  passes straight through, so `g9(a, …, h, 77)` with r3..r10 untouched passes it and the word at
 *  r1+8 is g9's ninth argument, inside the area. What refuses that call is the shared audit
 *  (frame-objects.ts `storedNeverRead`): the store to r1+8 reaches the call unread, below every
 *  area word a load after a call proves a local's (`compilerBehaviors.localsAboveOutgoingArea`).
 *  That audit is the backstop this partition rests on for an undeclared callee; a change to the
 *  guess or to the audit's survivor rule moves it.
 *
 *  A word stored to the frame that no word load reads back, in a function that makes no call, is a
 *  DEAD LOCAL: no callee can take it as a stack argument. A tail branch, which would hand this
 *  frame's caller's parameter area to another function, refuses before this runs (`liftPrelude`).
 *  It lifts as a store to a frame object, and what reaches the C is then the shared lift's, as for
 *  the same store on Thumb and MIPS: a fixed-offset scalar becomes a local, which the dead-store
 *  pass drops (`l3/dce.ts`) unless its value is a read it keeps (`sp8 = *a0`), so `int v; v = x;`
 *  at -O0,p lifts to an empty body and a `volatile` local's stores are lost with it — no code can
 *  observe that word — and only a store at a runtime index stays one, into the frame array. A dead
 *  local alone draws the area only where one lies inside it. */
function measurePpcFrame({
  name,
  blocks,
  saves,
  r1At,
  target,
  calls,
  fail,
}: {
  name: string;
  blocks: readonly PpcBlock[];
  /** the prologue's save words, as entry-r1 offsets (`prologueSavedRegs`) */
  saves: readonly number[] | null;
  r1At: ReadonlyMap<Instr, number | string>;
  target: TargetDescription;
  calls: CallDeclarations;
  fail: FrontendRefusal;
}): { area: FrameRange; size: number } | null {
  const code = blocks.flatMap((b) => [...b.body, ...(b.branch ? [b.branch] : [])]);
  const bls = blocks.flatMap((b) => b.body).filter((ins) => ins.mnemonic === 'bl' && !saveRoutineOf(target, ins));
  const frameReg = target.registerSaveRoutines?.frameReg;
  const r1Mem = (ins: Instr) => {
    const last = ins.ops[ins.ops.length - 1] ?? '';
    return last.includes('(') && parseMem(last).base === 'r1' && ins.mnemonic !== 'stwu' ? parseMem(last) : undefined;
  };
  const captures = code.filter((ins) => takesFrameAddress(ins, frameReg));
  const subword = code.filter((ins) => SUBWORD_MEM.has(ins.mnemonic) && r1Mem(ins) !== undefined);
  const entryOff = (ins: Instr) => {
    const at = r1At.get(ins);
    return typeof at === 'number' ? r1Mem(ins)!.off + at : undefined;
  };
  const loadedWords = new Set(
    code.flatMap((ins) => {
      const at = r1Mem(ins) && /^(lwz|lmw)$/.test(ins.mnemonic) ? entryOff(ins) : undefined;
      return at === undefined
        ? []
        : ins.mnemonic === 'lmw'
          ? [...Array(32 - Number(ins.ops[0].slice(1))).keys()].map((k) => at + 4 * k)
          : [at];
    }),
  );
  const deadStores =
    bls.length > 0
      ? []
      : code.filter(
          (ins) => ins.mnemonic === 'stw' && r1Mem(ins) !== undefined && !loadedWords.has(entryOff(ins) ?? NaN),
        );
  if (captures.length === 0 && subword.length === 0 && deadStores.length === 0) {
    return null;
  }
  const pushes = code.filter((ins) => ins.mnemonic === 'stwu' && ins.ops[0] === 'r1');
  if (pushes.length !== 1 || r1At.get(pushes[0]) !== 0 || parseMem(pushes[0].ops[1]).base !== 'r1') {
    return null;
  }
  const size = -parseMem(pushes[0].ops[1]).off;
  if (!(size > 0) || captures.some((ins) => r1At.get(ins) !== -size) || saves === null) {
    return null;
  }
  const area = target.compilerBehaviors.linkageLocalArea
    ? areaAboveOutgoing({ frameSize: size, outgoingEnd: PARAM_AREA_AT, saves: saves.map((o) => o + size), align: 4 })
    : null;
  if (area === null) {
    return null;
  }
  for (const ins of code) {
    const off = r1Mem(ins) === undefined || r1At.get(ins) === -size ? undefined : entryOff(ins);
    if (off !== undefined && landsOnArea(area, off + size, 4)) {
      return null;
    }
  }
  // Drawn for dead stores alone, the area must hold one: a save the prologue made is no local.
  const inArea = (ins: Instr) => {
    const at = (entryOff(ins) ?? NaN) + size;
    return at >= area.from && at < area.to;
  };
  if (captures.length === 0 && subword.length === 0 && !deadStores.some(inArea)) {
    return null;
  }
  const fprArgs = target.fpu?.argRegs.length ?? 0;
  for (const ins of bls) {
    const callee = ins.reloc?.sym ?? '';
    const params = calls.declaredParams(callee);
    if (params === null) {
      continue;
    }
    const at = `'${callee}', called at 0x${ins.addr.toString(16)},`;
    const copied = params.findIndex((p) => p.kind === 'by-value');
    if (copied >= 0) {
      fail(
        `cannot lift '${name}': address-taken stack local — ${at} takes its parameter ${copied + 1} as ` +
          `'${params[copied].spelling}', which no word holds: a struct or union passed by value, which this compiler ` +
          "passes as the address of a copy in the caller's local area — not modelled",
      );
    }
    const count = (kind: ParamClass) => params.filter((p) => p.kind === kind).length;
    const unsized = params.findIndex((p) => p.kind === 'unsized');
    const why =
      count('wide') > 0
        ? 'a 64-bit parameter, which the EABI places in an aligned register pair or on the stack'
        : count('word') > target.argRegs.length
          ? `${count('word')} parameter words and the argument registers carry ${target.argRegs.length}`
          : count('float') > fprArgs
            ? `${count('float')} floating parameters and the floating-point argument registers carry ${fprArgs}`
            : unsized >= 0
              ? `its parameter ${unsized + 1} as '${params[unsized].spelling}', which nothing here sizes: a word, a ` +
                'pair, a stack word or a by-value copy in the local area'
              : undefined;
    if (why !== undefined) {
      fail(
        `cannot lift '${name}': outgoing stack arguments not modelled — ${at} is declared with ${why}, and this ` +
          "compiler's local area starts past the stack words a call takes",
      );
    }
  }
  return { area, size };
}

/** What a call's lowering on this frontend carries out (`CallLowering`): no pair, no stack word, no
 *  struct returned through memory. */
const PPC_CALL_LOWERING = {
  pairs: false,
  memoryReturn: false,
  stackArgs: false,
  voidReturn: false,
  argRegisterBoundsArity: false,
} as const;

/** This frontend's refusal, for the shared code that refuses on its behalf. */
const ppcRefusal: FrontendRefusal = (message) => {
  throw new PpcUnsupportedError(message);
};

/** WHAT `lift` READS OFF THE TEXT BEFORE IT DECODES AN INSTRUCTION: the control transfers it
 *  refuses, the blocks (with the preheader), r1's depth at each instruction, the prologue's saves,
 *  the callees' declarations, and the local area those draw (`measurePpcFrame`). `lift` and
 *  `__testing.frameOf` both run it, so the area a test pins is the one the lift draws. */
function liftPrelude(
  name: string,
  instrs: Instr[],
  target: TargetDescription,
  prototypes: Prototypes,
  jts: Map<number, PpcJT>,
) {
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
          (ins.mnemonic === 'blrl' || ins.mnemonic === 'bctrl'
            ? `(an indirect call — a virtual dispatch or a call through a pointer — is not yet supported)`
            : `(CTR-counted loop or indirect branch — mwcc -O4 loop unrolling is not yet supported)`),
      );
    }
  }
  // A BRANCH OUT OF THE FUNCTION is a tail call: the callee takes over this frame's caller's
  // parameter area as its own, so a word stored there may be its stack argument, and the call
  // itself would be dropped. objdump prints one either at an address outside the function or,
  // relocated, at its own address, which would read as a loop. A conditional branch out
  // (`beq- g`, `R_PPC_REL14`) and a `bdnz` out are tail calls too.
  const tail = instrs.find(
    (i) =>
      (isUncond(i) || isCond(i) || isCtrLoop(i)) &&
      (i.reloc !== undefined || (i.target !== undefined && !instrs.some((j) => j.addr === i.target))),
  );
  if (tail !== undefined) {
    throw new PpcUnsupportedError(
      `cannot lift '${name}': the '${tail.mnemonic}' at 0x${tail.addr.toString(16)} leaves the function` +
        (tail.reloc ? ` for '${tail.reloc.sym}'` : '') +
        ' — a tail call is not modelled',
    );
  }
  const { blocks, succIdx } = toBlocks(instrs, name, jts);
  refuseReachableDispatch(name, blocks, recoveredBctr, ppcRefusal);
  const entryBody = blocks[0].body;
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
  const saves = prologueSavedRegs(entryBody, target, r1At);
  const calls = callDeclarations(name, target, prototypes, PPC_CALL_LOWERING, ppcRefusal);
  // THE LOCAL AREA, where a function takes a frame address, reaches its frame below a word, or
  // keeps a dead local there (`measurePpcFrame`, `compilerBehaviors.linkageLocalArea`): every r1
  // access inside it, any width, is MEMORY through an `laddr` the shared frame-object audit then
  // proves, as on Thumb and MIPS, and every word access outside it keeps the slot model. Null where
  // neither happens, or the frame is one this cannot partition, and then every capture keeps its
  // r1-as-data refusal and every sub-word access its own.
  const frame = measurePpcFrame({
    name,
    blocks,
    saves: saves.offsets,
    r1At,
    target,
    calls,
    fail: ppcRefusal,
  });
  return { blocks, succIdx, r1At, savedRegs: saves.regs, calls, frame };
}

/** Lift disassembled PowerPC text → an L1 Fn with block-argument SSA. `asmData` (optional) supplies
 *  the data-section jump table for dense-switch (Regime-B) recovery; absent ⇒ a `bctr` dispatch
 *  loud-fails.
 *
 *  AT MOST TWICE, as on Thumb and MIPS (`frontend/frame-objects.ts` `liftWithRelift`): where the
 *  frame-object audit answers that a callee may write the local area without bound, or that nothing
 *  escapes and the per-object model does not describe it, it asks for the area kept as one object,
 *  and the second lift's audit judges it so and refuses rather than asking again. */
export function lift(
  name: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes = {},
  asmData?: AsmData,
  symbols?: SymbolMap,
  context?: ContextGlobals,
): Fn {
  return liftWithRelift(name, (oneObject) =>
    liftOnce(name, asm, target, prototypes, asmData, { symbols, context }, oneObject),
  );
}

function liftOnce(
  name: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  asmData: AsmData | undefined,
  declarations: Declarations,
  oneObject: FrameRange | undefined,
): Fn | FrameObjectRelift {
  assertInputFormat('ppc', 'objdump', asm);
  const instrs = parseDisasm(sliceSymbol(asm, name)); // ONE function only — an absent symbol declines loud
  if (instrs.length === 0) {
    throw new PpcUnsupportedError(`cannot lift '${name}': no instructions found in the input text`);
  }
  // Regime B: recover mwcc jump tables from the `bctr` dispatch idiom + the AsmData table. A
  // recovered dispatch's `bctr` is subsumed into a `switch_br` (emitted from its bounds block), so
  // it is exempted from the loud-fail below; an UNrecovered `bctr` still fails loud.
  const jts = asmData ? recoverPpcJumpTables(instrs, asmData) : new Map<number, PpcJT>();
  // A data reloc on an instruction whose decode did not TAKE it means objdump printed a LINK-TIME
  // placeholder (`lis r4,0` + R_PPC_ADDR16_HA sym): the real value is the symbol's half, and
  // lifting the 0 silently reads the wrong address — plausible-but-wrong C, the forbidden class.
  // The jump-table idiom's own @tbl pair never reaches this guard: a recovered dispatch block
  // is the bounds branch's replaced fall-through, pruned as unreachable before decode, and a
  // hoisted pair is decoded into a table base (`tableBases`).
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
  const statics = makeLocalStatics();
  /** The symbol a relocation names, once the naming policy has passed it. Every recovery below goes
   *  through here FIRST, so an unspellable name can never reach the declaration minter looking like
   *  an ordinary identifier — recovering the address is only half of being able to write it down.
   *
   *  A function-scope static is the one kind no `extern` can name that a lift can still WRITE: the
   *  function defines it, so its definition, read out of the side table, is recorded beside the Fn
   *  under the linker name the IR keeps, and structure spells it by its source name. */
  const spellableSym = (ins: Instr): string => {
    relocTaken = true;
    const sym = ins.reloc?.sym ?? '';
    if (classifyRelocSymbol(sym) === 'local-static') {
      const read = asmData
        ? readObjectLocalObject(asmData, sym, name)
        : { refused: "whose definition needs the object's data, which this lift was not given" };
      if ('refused' in read) {
        throw new PpcUnsupportedError(`${relocSite(ins)} names a function-scope static ('${sym}') ${read.refused}`);
      }
      return statics.define(read);
    }
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
  const fail = ppcRefusal;
  const { blocks, succIdx, r1At, savedRegs, calls, frame } = liftPrelude(name, instrs, target, prototypes, jts);
  const lrUnproven = linkRegisterProof(blocks, succIdx, r1At, target);

  const preds: number[][] = blocks.map(() => []);
  blocks.forEach((_, i) => {
    for (const s of succIdx[i]) {
      preds[s].push(i);
    }
  });

  const fpu = target.fpu;
  // A CALL IN A FUNCTION THAT COMPUTES ON FLOATS refuses — at the float instruction, so a refusal
  // the stream reaches first keeps its own reason: which FPRs a callee destroys, which it reads as
  // float arguments and which it returns in are all unmodelled, so a float live across a call — or
  // handed to one in f1 — would resolve to a value the callee overwrote or be dropped. Both scans
  // read the blocks the entry reaches: a `bl` on no path makes no call.
  const reached = blocks.flatMap((b) => b.body);
  // A register save routine is no call: it moves only the registers it saves (`saveRoutine`).
  const callInsn = reached.find((ins) => ins.mnemonic === 'bl' && !saveRoutineOf(target, ins));
  const floatReturn = writesFloatReturn(reached, FP_ARITH_MNEMONICS, (t) => (isFpKey(t) ? t : null), fpu);
  const fpType = fpPrecision(reached, (m) => FP_ARITH[m]?.width);

  // THE LIVE-IN MODEL is the register half only (this frontend claims no frame partition): a
  // def-less read of a register the ABI passes no argument in, and that the prologue saved or the
  // ABI lets a callee use unsaved, is an uninitialised local. `registerLiveIns` (frontend/ssa.ts)
  // composes it, as it does for Thumb. The FPU's callee-saved half is not measured, so f14..f31 keep
  // the treatment a target claiming no partition gets.
  const ssa = makeSsaBuilder(
    name,
    blocks.length,
    preds,
    () => registerLiveIns(target, savedRegs),
    (k) => (isFpKey(k) ? (fpType ?? T.f32()) : undefined),
  );
  const { irBlocks, readVar, writeVar, paramReg } = ssa;

  /** Where an r1 access of `width` bytes at `ins` lies in the local area: its post-push offset, or
   *  undefined for one outside it. An access across the area's edge refuses: half memory and half
   *  slot is neither. `measurePpcFrame` refuses a frame where an access at another depth lands in
   *  the area, so one inside it runs at the frame's own depth. */
  const inLocalArea = (ins: Instr, mem: string, width: number): number | undefined => {
    const depth = r1At.get(ins);
    if (frame === null || parseMem(mem).base !== 'r1' || typeof depth !== 'number') {
      return undefined;
    }
    const at = parseMem(mem).off + depth + frame.size;
    if (at >= frame.area.to || at + width <= frame.area.from) {
      return undefined;
    }
    if (at < frame.area.from || at + width > frame.area.to) {
      fail(
        `cannot lift '${name}': address-taken stack local — '${ins.mnemonic}' at 0x${ins.addr.toString(16)} reaches ` +
          `across an edge of the local area, r1+${frame.area.from} up to r1+${frame.area.to} — part memory, part slot`,
      );
    }
    return at;
  };
  // The frame offset each `laddr` this lift emitted names — function-scoped, since a register
  // holding one crosses blocks — and every capture moved into another (`addi rD,rCapture,k`
  // re-minted as the `laddr` of the sum), handed to the audit so a base only the move read is
  // dropped rather than judged as a capture (`foldMovedCaptures`).
  const laddrAt = new Map<Value, number>();
  const movedCaptures = new Set<Value>();

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
    fail,
  });
  /** The jump-table bases a recovered dispatch reads from outside its own block — the `@l` that
   *  completes one defines no value but the base (frontend/jump-table.ts). */
  const tableBases = makeTableBases(
    [...jts.values()].flatMap((j) => (j.hoisted ? [j.hoisted] : [])),
    fail,
  );
  /** What this frontend defines registers with that is no argument: a pending `@ha` half and a
   *  table base. */
  const placeholders = {
    has: (v: Value) => highHalves.has(v) || tableBases.has(v),
    guardRead: (n: string, r: string, v: Value) => tableBases.guardRead(n, r, highHalves.guardRead(n, r, v)),
  };
  /** Reading a register AS A VALUE. A register holding a high half is not one, so this refuses loud
   *  rather than handing back a plausible number standing for an address. `foldLoHalf` is the only
   *  code entitled to look at a high half, which is why it reaches `readVar` directly. */
  const readReg = (r: string, at: number): Value => {
    if (SMALL_DATA_BASES.includes(r)) {
      fail(
        `cannot lift '${name}': ${r} (the small-data base) used as data — an access the relocation ` +
          `does not name is not modelled`,
      );
    }
    const v = placeholders.guardRead(name, r, readVar(r, at));
    const nv = nonValues.get(v);
    if (nv !== undefined && NON_VALUE_RULES[nv.kind].refuseAtRead) {
      refuseNonValue(nv);
    }
    return v;
  };
  /** Reading r1 (the stack pointer) as a DATA operand means frame-pointer arithmetic or an
   *  address-taken local (`addi r3,r1,8` = `&local`) — not modellable without a stack abstraction,
   *  and fabricating a value for r1 silently miscompiles. */
  const r1AsData = (): never =>
    fail(
      `cannot lift '${name}': stack pointer r1 used as data (address-taken local / frame arithmetic) — not supported`,
    );
  /** An `mflr` reached by a `bl` with no `mtlr` since, or a return the link-register proof could
   *  not show jumps through the caller's return address (`linkRegisterProof`). */
  const refuseOverwrittenLink = (ins: Instr) => {
    const by = lrUnproven.get(ins);
    const at = (i: Instr) => `'${i.mnemonic}' at 0x${i.addr.toString(16)}`;
    if (by === undefined) {
      return;
    }
    if (ins.mnemonic === 'mflr') {
      fail(
        `cannot lift '${name}': the ${at(ins)} reads the link register the ${at(by)} overwrote on some path, ` +
          `with no 'mtlr' since — the return address is lost there`,
      );
    }
    if (by.mnemonic === 'bl') {
      fail(
        `cannot lift '${name}': the ${at(ins)} may not return through the caller's link register — the ` +
          `${at(by)} overwrote it on some path, and no 'mtlr' put the saved return address back`,
      );
    }
    fail(
      `cannot lift '${name}': the ${at(ins)} may not return through the caller's link register — on some ` +
        `path the ${at(by)} put ${by.ops[0]} there, which does not hold the return address an 'mflr' copied ` +
        `out or its reload from the link register's save word`,
    );
  };
  /** DEFINITIONS THAT ARE NOT VALUES: the frame bookkeeping this frontend erases. Each kind is
   *  written into a register as an ordinary SSA definition, so SSA answers whether one reaches a use,
   *  and is keyed by that value, as the high halves are (frontend/high-half.ts). Its one legitimate
   *  consumer looks it up here; every other use refuses through `refuseNonValue`,
   *  checked at a read (`readReg`) where the kind says so and, always, on the finished function
   *  (`assertNoNonValueEscaped`), because a use can reach through a join's incoming arguments, which
   *  no read sees. A new kind is one more member of the union, one rule and one refusal, and the
   *  three checks cover it. The high halves keep their own module only because MIPS shares it.
   *
   *  - `frame-address`: what `addi r11,r1,N` forms — its offset from the entry r1 (or why that is not
   *    known there) and the address of the `addi`. Its one consumer is a register save or restore
   *    routine (`saveRoutineOf`), which takes it in the target's `registerSaveRoutines.frameReg`, so
   *    that register is the only destination deferred; every other `addi rD,r1,N` refuses where it
   *    stands. Any other use is the frame read as data, and refuses as the `addi` itself would. One
   *    no routine took refuses too, even where nothing reads it (`assertNonValuesConsumed`). A `bl`
   *    to the routine that carries no relocation (a linked image, or objdump without `-r`) never gets
   *    that far: it is no routine, and `case 'bl'` refuses it as a call with no callee symbol.
   *  - `restored`: the caller's value a restore puts back in a callee-saved register
   *    (`restoreFrom`). No C value names it, so it has no consumer.
   *  - `return-address`: what `mflr rD` copies out of the link register, with the address of the
   *    `mflr`. Storing it to the link register's save word is the LR save (`frameStore`), and moving
   *    it back with `mtlr` is the return. Any other use is a function reading its own return address
   *    (MP4's `asm { mflr retaddr }` does, to tag an allocation with its caller), which no C
   *    expression spells: a store elsewhere refuses at once, anything else once the function is
   *    built. A read alone does not refuse, so a copy (`mr`) still carries it to its save. */
  type NonValue =
    | { kind: 'frame-address'; off: number | string; addr: number }
    | { kind: 'restored'; reg: string; addr: number }
    | { kind: 'return-address'; addr: number };
  const NON_VALUE_RULES: Record<NonValue['kind'], { refuseAtRead: boolean; mustBeConsumed: boolean }> = {
    'frame-address': { refuseAtRead: true, mustBeConsumed: true },
    restored: { refuseAtRead: true, mustBeConsumed: false },
    'return-address': { refuseAtRead: false, mustBeConsumed: false },
  };
  const nonValues = new Map<Value, NonValue>();
  /** The non-values their consumer took (only `frame-address` has one that must). */
  const consumedNonValues = new Set<Value>();
  /** The non-value of kind `k` that `v` stands for, or undefined. */
  const nonValueOf = <K extends NonValue['kind']>(v: Value, k: K): Extract<NonValue, { kind: K }> | undefined => {
    const nv = nonValues.get(v);
    return nv?.kind === k ? (nv as Extract<NonValue, { kind: K }>) : undefined;
  };
  const refuseNonValue = (nv: NonValue): never => {
    switch (nv.kind) {
      case 'frame-address':
        return r1AsData();
      case 'restored':
        return fail(
          `cannot lift '${name}': ${nv.reg} is read after the restore at 0x${nv.addr.toString(16)} put the ` +
            `caller's ${nv.reg} back — no C value names it`,
        );
      case 'return-address':
        return fail(
          `cannot lift '${name}': the return address the 'mflr' at 0x${nv.addr.toString(16)} ` +
            `copies out is used as a value — a function reading its own return address has no C spelling`,
        );
    }
  };
  /** Checked on the finished function, after `finish` pruned the joins nothing reads. */
  const assertNoNonValueEscaped = (fnBlocks: Block[]) => {
    for (const b of fnBlocks) {
      for (const op of b.ops) {
        for (const v of [...op.operands, ...op.successors.flatMap((s) => s.args)]) {
          const nv = nonValues.get(v);
          if (nv !== undefined) {
            refuseNonValue(nv);
          }
        }
      }
    }
  };
  const assertNonValuesConsumed = () => {
    for (const [v, nv] of nonValues) {
      if (NON_VALUE_RULES[nv.kind].mustBeConsumed && !consumedNonValues.has(v)) {
        refuseNonValue(nv);
      }
    }
  };
  const RET = target.returnReg;
  const ARG_REGS = target.argRegs;

  // THE FRAME, as two kinds of word slot, each named by its offset from the ENTRY r1
  // (`r1Displacements`).
  //
  // A SAVE holds an entry value that is no C value: a callee-saved register's, the link register's
  // word, or the back chain the frame push stores (the caller's r1). Nothing but the caller reads it
  // back. Its restore — a load into the register it was saved from — puts the caller's value back,
  // which no C value names, so a read of the register after it refuses (`restored` in
  // `nonValues`); a load into any other register refuses at once. Function-scoped, so a save in the
  // prologue matches a restore in any epilogue.
  //
  // ONE SAVE AND ONE RESTORE, whichever instruction does it: `stmw`/`lmw`, a single `stw`/`lwz`
  // and a register save routine all go through `saveInto` and `restoreFrom`. A single `stw` is the
  // one save that may also be a spill: of a register this function already wrote, it stores a
  // value. A `stmw` or a routine has no such reading, and saving a written register refuses.
  //
  // Every other word store is a VALUE — an argument's home, or a live value spilled — and it is the
  // shared stack-slot variable (`stackSlotKey`, frontend/ssa.ts) MIPS and Thumb use. A reload into
  // any register reads it; a reload on a path that never stored it refuses in the builder; a store
  // nothing reloads refuses at the end of `lift`.
  //
  // A slot is one kind for the whole function: a word both saved and stored with a value has no
  // single reading, and refuses.
  const saveSlots = new Map<number, string>();
  // AN INCOMING STACK WORD HAS ONE NAME, `@sarg<k>`, for its loads and its stores: the EABI passes
  // integer argument word k >= 8 at entry r1 + 8 + 4(k - 8), in the caller's parameter area past
  // its back chain and link-register save word (`corpus/probe-mwcc-frame.c`, `in9`/`in10`). A read
  // no store reaches is the caller's argument through the ordinary live-in path, and a store makes
  // the parameter an assigned one, as Thumb and MIPS name it. Words only: a sub-word incoming
  // argument (`lha 10(r1)` for a `short`) refuses as a sub-word frame access, a float past f8 is
  // loaded with the unmodelled `lfs`/`lfd`, and a function reading one beside a float argument or
  // declared with a 64-bit or floating parameter refuses (`ppcArgSlots`). Undefined for every
  // other word.
  const incomingStackKey = (entryOff: number): string | undefined =>
    incomingStackArgKey(entryOff, PARAM_AREA_AT, ARG_REGS.length);
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

  // A FLOAT RETURN is decided for the whole function (frontend/fpu.ts `writesFloatReturn`), and then
  // r3 is scratch like any other integer register. A table base left in r3 is no return value, as a
  // pending half is none (`placeholders`); reading one would refuse, and a merge of one with a value
  // still does.
  const returnOperands = (bi: number): Value[] =>
    floatReturn
      ? [readReg(fpu!.returnReg, bi)]
      : ssa.hasReachingDef(RET, bi, (v) => !placeholders.has(v))
        ? [readReg(RET, bi)]
        : [];
  // A RETURN NOTHING WROTE r3 FOR STILL RETURNS r3 — the caller's value, which on PowerPC is the
  // first argument. `int f(int a, int x) { if (x) return a; … return 5; }` is `cmpwi r4,0 ; bnelr`:
  // that path neither reads nor writes r3, so `returnOperands` finds no definition and returns
  // nothing, while every other path returns a word — C that falls off the end of an `int` function,
  // and that loses `a`. Whether the function returns a word is known only once every block is
  // filled, so a bare return is recorded here and given r3's entry value after the fill
  // (`returnUntouchedArg`) when another return hands back a word. Only where r3 still holds the
  // entry value on every path into it: a path a call destroyed r3 on returns nothing a C expression
  // names, and stays bare.
  //
  // AND ONLY WHERE r3 IS AN ARGUMENT AT ALL (`r3IsAnArgument`). "r3 still holds what the caller
  // left" says nothing about whether the caller left anything: `void f(void) { if (gA & 2) return;
  // gB++; }` uses r3 as a temporary on the other path, so that path "returns a word", and filling
  // the bare return would mint a parameter the ABI never passed — `f(s32 a0)`, which contradicts a
  // declared `void f(void)` (the candidate does not compile) and a C++ `__Fv` mangling.
  const bareReturns: Array<{ op: Op; bi: number }> = [];
  const wordReturns: number[] = [];
  // What r4, the second register of an r3:r4 return, may hold at each word return where no
  // declaration pins the width (frontend/dead-reads.ts `unreadPairHalf`).
  const unreadHigh = new Set<Value>();
  // Each of those word returns: what r3 returns there and what r4 may hold (`computedPairHalf`).
  const pairReturns: PairReturn[] = [];
  // Every value a compare consumed, whether or not a branch reads the field it set: a compare
  // nothing reads leaves no op, so this is the only record that the value was used
  // (frontend/dead-reads.ts `compared`).
  const compared = new Set<Value>();
  // Every value a carry reader consumed by folding it away: the constant a `subfze` reads, and the
  // `rB - 1` a `subfe rD,rA,rB` cancels. The machine read them, and no op says so (`computedPairHalf`).
  const readWithoutOp = new Set<Value>();
  // Every `subfc`/`subfic` difference whose carry a reader turned into a 0/1 truth value: the
  // difference may be the by-product of a 32-bit compare, not the low word of a 64-bit result,
  // which `computedPairHalf` settles (`TruthDifference`). `carrySource` maps each carry compare to
  // the difference its writer computed, and `truthPending` each reader result one step short of
  // the truth value to it.
  const truthDifferences: TruthDifference[] = [];
  const carrySource = new Map<Value, Value>();
  const truthPending = new Map<Value, { diff: Value; via: 'neg' | 'and1' }>();
  // Every load into the register the compiler discards an unused read into at a level that keeps a
  // plain one (`compilerBehaviors.discardsUnusedReadsInto`, frontend/dead-reads.ts `discarded`).
  const discarded = new Set<Value>();
  const discardReg = target.compilerBehaviors.discardsUnusedReadsInto;
  // Every value written to a register other than the discard register: `leftInDiscardRegister`
  // takes out of `discarded` each load one of them derives from, which mwcc put in a home.
  const writtenElsewhere: Value[] = [];
  // A `subfze` over a register this block takes in from another block: modelled as `~rA + CA`, and
  // kept only where `ssa.finish` resolves rA to one constant on every path in (`subfze` case below).
  const joinedCarryConsts: { ins: Instr; not: Op; add: Op; ca: Value }[] = [];
  let wordReturn = false;
  const emitReturn = (ops: Op[], bi: number) => {
    const op = mkOp('ret', { operands: returnOperands(bi) });
    ops.push(op);
    if (floatReturn) {
      return;
    }
    if (op.operands.length > 0) {
      wordReturn = true;
      wordReturns.push(bi);
      const high = new Set<Value>();
      unreadPairHalf(ssa, prototypes[name], ARG_REGS[1], bi, high);
      high.forEach((v) => unreadHigh.add(v));
      pairReturns.push({ word: op.operands[0], high });
    } else {
      bareReturns.push({ op, bi });
    }
  };
  /** Whether every word return hands back a value computed ONLY to be returned: on every path into
   *  it, r3's last write is an op with no effect and no memory read (`spelledWhenDead` answers no)
   *  whose value nothing but a return reads, directly or through the joins that carry it there.
   *
   *  The evidence is the compiler's, the claim `spelledWhenDead` already rests on: an optimizing
   *  compiler deletes a pure computation nobody reads, so one that survives with a return as its
   *  only reader was written for that return, and the function returns a word. `int f(int a) {
   *  switch (gS) { case 0: return 3; … } return a; }` is `li r3,3 ; blr` on every case and a bare
   *  `blr` out of range. A temporary is read again (`lwz r3,gB ; addi r0,r3,1`), and a
   *  call's result and a load are excluded — a void function's call leaves its callee's result in
   *  r3, and a discarded `volatile` read is a load nobody reads — so `void f(void) { if (gA & 2)
   *  return; gB++; }` still answers no.
   *
   *  What it cannot tell apart is an `int f(void)` with a path that falls off its end: that path
   *  returns whatever the caller left in r3 too, and is lifted as returning it — the bytes' own
   *  behaviour, at the cost of a parameter the source did not name. A CodeWarrior C++ symbol says
   *  so where there is one (`__Fv`), and a declaration always decides first. */
  const r3WrittenToReturn = (): boolean => {
    if (wordReturns.length === 0) {
      return false;
    }
    const defOp = new Map<Value, Op>();
    const incoming = new Map<Value, Value[]>();
    const uses = new Map<Value, Array<Op | Value | undefined>>();
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
      const l = m.get(k);
      if (l) {
        l.push(v);
      } else {
        m.set(k, [v]);
      }
    };
    for (const blk of irBlocks) {
      for (const op of blk.ops) {
        op.results.forEach((r) => defOp.set(r, op));
        op.operands.forEach((v) => push(uses, v, op));
        for (const s of op.successors) {
          s.args.forEach((v, i) => {
            const p = s.block.params[i] as Value | undefined;
            push(uses, v, p);
            if (p !== undefined) {
              push(incoming, p, v);
            }
          });
        }
      }
    }
    // A join is followed to what it merges, and every value on the way may have only returns, or
    // joins that are themselves read only by returns, as readers. A cycle adds nothing the first
    // visit did not judge.
    const returnOnly = (v: Value, seen: Set<Value>): boolean => {
      if (seen.has(v)) {
        return true;
      }
      seen.add(v);
      return (uses.get(v) ?? []).every(
        (u) => u !== undefined && ('opcode' in u ? u.opcode === 'ret' : returnOnly(u, seen)),
      );
    };
    const computed = (v: Value, seen: Set<Value>): boolean => {
      if (seen.has(v)) {
        return true;
      }
      seen.add(v);
      if (!returnOnly(v, new Set())) {
        return false;
      }
      const op = defOp.get(v);
      if (op !== undefined) {
        return !spelledWhenDead(op);
      }
      // an entry parameter (the caller's value) merges nothing
      const ins = incoming.get(v);
      return ins !== undefined && ins.every((a) => computed(a, seen));
    };
    return wordReturns.every((bi) => ssa.everyReachingDef(RET, bi, (v) => computed(v, new Set())));
  };
  /** Whether the caller passes r3, so a bare return of it hands back an argument. A declaration
   *  decides when there is one: a non-void return and at least one integer-class parameter (the
   *  first such takes r3) or a nonzero register count. Without one, only the body can show it: r3
   *  is already an entry parameter, or a higher argument register is live in, which puts an
   *  argument in r3 by position (the obligation `mintArgSlotHoles` discharges), or every word
   *  return hands back a value computed only to be returned (`r3WrittenToReturn`) — then the
   *  function returns a word, and a bare return of it hands back what the caller left in r3. */
  const r3IsAnArgument = (): boolean => {
    const own = prototypes[name];
    if (declaresVoidReturn(own)) {
      return false;
    }
    if (typeof own?.params === 'number') {
      return own.params > 0;
    }
    if (Array.isArray(own?.params)) {
      return own.params.some((t) => declaredWidth(t) !== undefined);
    }
    const live = new Set(irBlocks[0].params.map((p) => paramReg.get(p)));
    if (ARG_REGS.some((r) => live.has(r))) {
      return true;
    }
    // A CodeWarrior C++ symbol is a declaration of its own parameters: `ksNesInit13__Fv` is a free
    // function of none, which no body evidence overrides.
    const mangled = demangle(name);
    return !(mangled !== null && mangled.cls === undefined && mangled.params.length === 0) && r3WrittenToReturn();
  };
  const returnUntouchedArg = () => {
    if (!wordReturn || bareReturns.length === 0 || !r3IsAnArgument()) {
      return;
    }
    for (const { op, bi } of bareReturns) {
      const v = ssa.entryValue(RET, bi);
      if (v !== undefined) {
        op.operands = [v];
      }
    }
  };

  const fillBlock = (b: PpcBlock, bi: number) => {
    const ops = irBlocks[bi].ops;
    const succ = (j: number): Successor => ({ block: irBlocks[j], args: [] });

    // A synthetic conditional-return block: just return the current return register.
    if (b.synthReturn) {
      emitReturn(ops, bi);
      return;
    }

    // `lastDef` is the value most recently written to a register in this instruction — used to
    // wire a record-form op's implicit cr0 side effect (see the `rc` handling in `decode`).
    let lastDef: Value | null = null;
    // r1 read as data fails LOUD (`r1AsData`). Frame bookkeeping never reaches here: stwu / addi r1
    // / mflr / mtlr / r1-relative spills / the save routines' frame address are handled before `read`.
    const read = (r: string): Value => {
      if (r === 'r1') {
        r1AsData();
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
    /** The instruction a save or restore refusal names. */
    const site = (ins: Instr) =>
      `the '${ins.mnemonic}'${ins.mnemonic === 'bl' && ins.reloc ? ` to '${ins.reloc.sym}'` : ''} at 0x${ins.addr.toString(16)}`;
    /** Save `reg`'s entry value into the save slot at entry offset `off`, named `mem` in `ins`. */
    const saveInto = (ins: Instr, reg: string, off: number, mem: string) => {
      if (ssa.hasReachingDef(reg, bi)) {
        // A read leaves a definition too: the entry value, as a parameter, since `prologueSavedRegs`
        // does not count a save after a read.
        throw new PpcUnsupportedError(
          ssa.hasReachingDef(reg, bi, (v) => !paramReg.has(v))
            ? `cannot lift '${name}': ${site(ins)} saves ${reg} after this function wrote it, so '${mem}' holds a ` +
                `value, not the caller's ${reg}`
            : `cannot lift '${name}': ${site(ins)} saves ${reg} after this function read it — a value handed ` +
                `over in a register no argument is passed in, which a compiled prologue saves before any use`,
        );
      }
      refuseMixedSlot(ins, mem, off, 'save');
      saveSlots.set(off, reg);
    };
    /** Restore `reg` from the save slot at `off`: it must be the slot `reg` was saved into, and `reg`
     *  then holds the caller's value again. r1 is no SSA register: its reload is the back chain the
     *  frame push stored, and `r1Displacements` tracks it instead. */
    const restoreFrom = (ins: Instr, reg: string, off: number, mem: string) => {
      const saved = saveSlots.get(off);
      if (saved !== reg) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': reload of '${mem}' into ${reg}, ` +
            (saved === undefined
              ? `a word nothing saved it into (${site(ins)})`
              : `a slot ${saved} was saved into — the word holds the caller's ${saved}, which no C value ` +
                `names (${site(ins)})`),
        );
      }
      if (reg !== 'r1') {
        const caller = mkValue(T.unk(32));
        nonValues.set(caller, { kind: 'restored', reg, addr: ins.addr });
        writeVar(reg, bi, caller);
      }
    };
    // A word store/load based on r1: a SAVE or a VALUE slot (see `saveSlots` above). Returns false
    // for any other base, which is ordinary memory.
    const frameStore = (ins: Instr, srcReg: string, mem: string): boolean => {
      if (parseMem(mem).base !== 'r1' || inLocalArea(ins, mem, 4) !== undefined) {
        return false;
      }
      const off = entryOffset(ins, mem);
      const isArg = ARG_REGS.includes(srcReg);
      // The LR SAVE stores the return address `mflr` copied out, and only into the link register's
      // save word, 4 bytes above the entry r1. Anywhere else the word is a value — past the push,
      // 8 bytes up is the callee's parameter area, where it is a ninth argument — and a register
      // holding the return address on some paths and another value on others is not a save at all.
      const isReturnAddress = (v: Value) => nonValueOf(v, 'return-address') !== undefined;
      if (ssa.hasReachingDef(srcReg, bi, isReturnAddress)) {
        const mixed = ssa.hasReachingDef(srcReg, bi, (v) => !isReturnAddress(v));
        if (mixed || off !== LR_SAVE_WORD) {
          throw new PpcUnsupportedError(
            `cannot lift '${name}': the store to '${mem}' at 0x${ins.addr.toString(16)} is not the link ` +
              `register's save — ${
                mixed
                  ? `${srcReg} holds the return address an 'mflr' copies out on some paths and another value on others`
                  : `the return address an 'mflr' copies out lands ${off} bytes from the entry r1, not in the ` +
                    `save word ${LR_SAVE_WORD} bytes up, so it is used as a value`
              }`,
          );
        }
        refuseMixedSlot(ins, mem, off, 'save');
        saveSlots.set(off, srcReg);
        return true;
      }
      // Any other save stores what the register held at entry: nothing defined it on any path. An
      // argument register nothing defined holds the argument, which is a value.
      if (!isArg && !ssa.hasReachingDef(srcReg, bi)) {
        saveInto(ins, srcReg, off, mem);
        return true;
      }
      refuseMixedSlot(ins, mem, off, 'value');
      // An argument moved to its home is not an argument set up for the next call.
      const v = (isArg ? ssa.entryValue(srcReg, bi) : undefined) ?? readReg(srcReg, bi);
      // An assignment to an incoming stack parameter is that parameter's SSA variable, and no call
      // made here takes the word: it is the caller's (a tail branch, whose callee would read the
      // same words as its own stack arguments, refuses in `liftPrelude`).
      const incoming = incomingStackKey(off);
      if (incoming !== undefined) {
        writeVar(incoming, bi, v);
        return true;
      }
      writeVar(stackSlotKey(off), bi, v);
      if (!valueSlots.has(off)) {
        valueSlots.set(off, { addr: ins.addr, mem, read: false });
      }
      return true;
    };
    const frameLoad = (ins: Instr, dstReg: string, mem: string): boolean => {
      if (parseMem(mem).base !== 'r1' || inLocalArea(ins, mem, 4) !== undefined) {
        return false;
      }
      const off = entryOffset(ins, mem);
      if (saveSlots.has(off)) {
        restoreFrom(ins, dstReg, off, mem);
        return true;
      }
      const incoming = incomingStackKey(off);
      if (incoming !== undefined) {
        write(dstReg, readVar(incoming, bi));
        return true;
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
      if (discardReg !== undefined && r !== discardReg) {
        writtenElsewhere.push(v);
      }
    };
    // A `bl` into a register save or restore routine is frame bookkeeping, not a call: it writes no
    // register this function reads (only the link register, already copied out — which
    // `linkRegisterProof` checks), so nothing is destroyed and r0 keeps the return address
    // `mflr` put there. A SAVE records a save slot per word, at the routine's fixed offsets below the
    // frame address in r11; a RESTORE must find the same register in every word it reloads. It
    // refuses where:
    //   • r11 does not hold one frame address on every path into the call, or a call destroyed it on
    //     the way (`useOutsideOps`; and a frame address no routine takes refuses at the end of `lift`);
    //   • r1's displacement at the `addi` is not known, so no slot can be named;
    //   • the routine's number is outside r14..r31 (no such runtime routine);
    //   • it moves floating-point registers (named, not modelled);
    //   • a register it saves was written or read first, or a word it restores was not saved from
    //     that register — `saveInto` and `restoreFrom`, the rules every save and restore keeps.
    const saveRoutine = (ins: Instr, r: NonNullable<ReturnType<typeof saveRoutineOf>>) => {
      const at = `the 'bl' to '${r.sym}' at 0x${ins.addr.toString(16)}`;
      if (r.first < 14 || r.first > 31 || ins.reloc!.addend !== 0) {
        throw new PpcUnsupportedError(`cannot lift '${name}': ${at} names no register save routine of the runtime`);
      }
      // The FPR half is named and refused. Every compiled function that calls it (doubles live
      // across a call, a 24-float leaf; 2.4.2 and 2.4.7 at -O4,p, 2.3.3 at -O4,s) already declines
      // on the unmodelled `stfd`/`lfd` or on a float live across a call, and no row calls it, so a
      // model of its 8-byte slots would be a model no lift has checked.
      if (r.fpr) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': ${at} saves or restores floating-point registers — not modelled`,
        );
      }
      const fr = target.registerSaveRoutines!.frameReg;
      const base = ssa.hasReachingDef(fr, bi, (v) => !nonValueOf(v, 'frame-address')) ? undefined : readVar(fr, bi);
      const frame = base === undefined ? undefined : nonValueOf(base, 'frame-address');
      if (frame === undefined) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': ${at} does not find one frame address ('addi ${fr},r1,N') in ${fr} on every path`,
        );
      }
      consumedNonValues.add(base!);
      // If a call between the `addi` and here destroyed r11, the routine would store through what the
      // callee left there: the builder refuses that read once it knows it was used.
      ssa.useOutsideOps(base!, bi);
      if (typeof frame.off !== 'number') {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': ${at} saves below the frame address formed at 0x${frame.addr.toString(16)}, where ` +
            `the stack pointer's offset from its entry value is not known: ${frame.off}`,
        );
      }
      for (let k = r.first; k <= 31; k++) {
        const disp = -4 * (32 - k);
        (r.restore ? restoreFrom : saveInto)(ins, `r${k}`, frame.off + disp, `${disp}(${fr})`);
      }
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
        fpReg: PPC_FP_REG,
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
    // A FRAME ADDRESS AS DATA: post-push offset k of the local area, lowered to the `laddr` the
    // frame-object audit proves (`FRAME_OBJECT_AUDIT`, frontend/frame-objects.ts `frameObjects`),
    // which also judges where it lies against the area: below it or above it refuses.
    const emitLaddr = (k: number): Value => {
      const v = mkValue(T.unk(32));
      ops.push(mkOp('laddr', { results: [v], attrs: { off: k } }));
      laddrAt.set(v, k);
      return v;
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
    const memOperand = (ins: Instr, mem: string, width: number): { base: Value; off: number } => {
      const sda = sdaAccess(ins, mem);
      if (sda) {
        return sda;
      }
      const local = inLocalArea(ins, mem, width);
      if (local !== undefined) {
        return { base: emitLaddr(local), off: 0 };
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
    /** `addi rD,rHi,SYM@l` completing the base of a jump table a dispatch reads from outside its
     *  block: the pair is proven as `foldLoHalf` proves it, and rD holds the table base. */
    const foldTableBase = (ins: Instr, rHi: string): Value | null => {
      const lo = ins.reloc!;
      const key = { sym: lo.sym, addend: lo.addend };
      if (!tableBases.wants(key)) {
        return null;
      }
      relocTaken = true;
      highHalves.pair(relocSite(ins), rHi, readVar(rHi, bi), lo.sym, (h) => h.addend === lo.addend);
      const v = mkValue(T.unk(32));
      tableBases.record(v, key, ins.addr);
      return v;
    };
    const emitLoad = (ins: Instr, d: string, mem: string, width: number, signed: boolean) => {
      const { base, off } = memOperand(ins, mem, width);
      const v = emit('load', d, [base], { off, width, signed });
      if (d === discardReg) {
        discarded.add(v);
      }
    };
    const emitStore = (ins: Instr, srcReg: string, mem: string, width: number) => {
      const { base, off } = memOperand(ins, mem, width);
      // A register the prologue saves is saved above the local area by construction, so its
      // entry value stored inside it is a frame this does not describe.
      if (
        inLocalArea(ins, mem, width) !== undefined &&
        isCalleeSaved(target, srcReg) &&
        !ssa.hasReachingDef(srcReg, bi)
      ) {
        fail(
          `cannot lift '${name}': address-taken stack local — '${ins.mnemonic}' at 0x${ins.addr.toString(16)} stores ` +
            `the caller's ${srcReg} inside the local area, a frame this does not describe`,
        );
      }
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
      const v = emit('load', d, [addrX(rA, rB)], { off: 0, width, signed });
      if (d === discardReg) {
        discarded.add(v);
      }
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
      compared.add(lhs).add(rhs);
    };

    // The carry bit, XER[CA], as a 0/1 value. mwcc computes a materialised compare branch-free
    // through it (`subfc` then `subfe`/`subfze`/`adde`/`addze`), so a reader needs the comparison
    // the writer left there. Three writers are modelled, each as the compare its carry IS:
    //   subfc rD,rA,rB   rD = rB - rA          CA = rB >=u rA
    //   subfic rD,rA,K   rD = K - rA           CA = K >=u rA   (K == 0: rA == 0)
    //   addic rD,rA,K    rD = rA + K           CA = carry of the unsigned add (K == -1: rA != 0)
    // The compare is built at its reader, so a carry nothing reads adds no op. A carry is
    // UNKNOWN, and its reader refuses naming why, when no instruction of this block set it (a carry
    // across a block edge is not modelled), a call clobbered it, or a writer this frontend does not
    // model set it: `srawi`/`sraw` (the signed `/2^k` round-up), `addc` (the low half of a 64-bit
    // add), and the extended forms, whose own carry-out is a high word's. An `addic` carry is
    // read only as a compare (`subfe`, `subfze`): `adde`/`addze` over it is the high word of
    // mwcc 2.4.x's 64-bit add of a constant, which is not built, so they refuse it as they refuse
    // an `addc` carry.
    type Carry = { make: () => Value; addic: boolean } | { why: string };
    let carry: Carry = { why: 'nothing in its own block set it (a carry across a block edge is not modelled)' };
    const setCarry = (make: () => Value, addic = false) => {
      carry = { make, addic };
    };
    /** The carry, as the compare that set it. `wide` marks an extended add (`adde`/`addze`), which
     *  over an `addic` carry is the high word of a 64-bit add. */
    const readCarry = (ins: Instr, wide = false): Value => {
      const why =
        'why' in carry
          ? carry.why
          : wide && carry.addic
            ? 'an addic set it: an extended add over that carry is the high word of a 64-bit add, which is not modelled'
            : undefined;
      if (why !== undefined) {
        throw new PpcUnsupportedError(
          `cannot lift '${name}': the '${ins.mnemonic}' at 0x${ins.addr.toString(16)} ` +
            `reads the carry bit (XER[CA]), and ${why}`,
        );
      }
      return (carry as { make: () => Value }).make();
    };
    /** The value of `v` when this block defines it as a `const`. */
    const constIn = (v: Value): number | undefined => {
      const def = ops.find((o) => o.results[0] === v);
      return def?.opcode === 'const' ? (def.attrs.value as number) : undefined;
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
      // Every carry writer and every call leaves the carry unknown unless its case below models it.
      const clobberCarry = (how: string) => {
        carry = { why: `the '${ins.mnemonic}' at 0x${ins.addr.toString(16)} ${how}` };
      };
      if (CARRY_WRITERS.test(mnem)) {
        clobberCarry('set it, a carry this frontend does not model');
      } else if (/^b.*l$/.test(mnem)) {
        clobberCarry('is a call, which clobbers it');
      }
      switch (mnem) {
        case 'nop':
          break;
        // --- call + frame/link-register bookkeeping ---
        // `bl <sym>`: read the argument registers (r3..), produce the return value in r3. The
        // callee symbol comes from the relocation (ins.reloc), and the caller-saved set is recorded
        // as destroyed (`calls.lower`) — a read of one past here names bytes the callee overwrote,
        // and it has a reaching definition all the same.
        case 'bl': {
          relocTaken = ins.reloc?.type === 'R_PPC_REL24';
          const routine = saveRoutineOf(target, ins);
          if (routine) {
            saveRoutine(ins, routine);
            break;
          }
          // A `bl` no relocation names is a call the assembler resolved to an offset in this
          // section — into this function's own body, or to a neighbour — and has no name to call.
          if (ins.reloc?.type !== 'R_PPC_REL24') {
            throw new PpcUnsupportedError(
              `cannot lift '${name}': the 'bl' at 0x${ins.addr.toString(16)} has no callee symbol — no ` +
                `R_PPC_REL24 relocation names it, so it calls an offset in this section, which has no name to call it by`,
            );
          }
          const sym = ins.reloc.sym;
          calls.lower({
            callee: sym,
            ssa,
            bi,
            read,
            write,
            // a pending `@ha` half and a table base are no argument
            placeholders,
            guess: {
              // a gap in the argument registers refuses, naming this address (`fallbackArgc`)
              at: ins.addr,
              // A GUESS THAT FILLS EVERY ARGUMENT REGISTER CANNOT SAY WHERE THE LIST ENDS. The ninth
              // argument travels in the callee's parameter area, 8 bytes above the pushed r1 (past the
              // back chain and the LR save word), and a value stored there that reaches the call is that
              // argument or a local the compiler put in the same words. Reading the word back, before or
              // after the call, does not decide it, so the end-of-lift check for a store nothing reloads
              // is not enough here. Without a prototype this refuses; a declared arity says which.
              //
              // A guess of seven is the same question for one shape. A 64-bit argument takes an aligned
              // register pair, so one that follows seven words skips r10 and fills the first two words
              // of the parameter area (mwcc 2.3.3 builds `g(1, 2, 3, 4, 5, 6, 7, x)` with `long long x`
              // that way). A single word there cannot be an argument after seven: the eighth word would
              // have gone in r10.
              refuse: (argc) => {
                if (argc < ARG_REGS.length - 1) {
                  return;
                }
                // The same question decides where the local area starts: past the widest call's
                // stack words, so a guess that cannot say whether this call takes any cannot draw it.
                if (frame !== null) {
                  fail(
                    `cannot lift '${name}': outgoing stack arguments not modelled — nothing declares '${sym}', called at ` +
                      `0x${ins.addr.toString(16)} with ${argc} argument registers filled, so whether it takes stack words ` +
                      `is unknown, and this compiler's local area starts past them`,
                  );
                }
                const depth = r1At.get(ins);
                const reaching = (off: number) => valueSlots.has(off) && ssa.hasReachingDef(stackSlotKey(off), bi);
                const inParamArea = (off: number) =>
                  typeof depth !== 'number' || (off >= depth + PARAM_AREA_AT && off < 0);
                const word = [...valueSlots.keys()].find((off) => inParamArea(off) && reaching(off));
                const passed =
                  argc === ARG_REGS.length || typeof depth !== 'number'
                    ? word
                    : reaching(depth + PARAM_AREA_AT) && reaching(depth + PARAM_AREA_AT + 4)
                      ? depth + PARAM_AREA_AT
                      : undefined;
                if (passed !== undefined) {
                  const slot = valueSlots.get(passed)!;
                  throw new PpcUnsupportedError(
                    `cannot lift '${name}': outgoing stack arguments not modelled — the undeclared call to '${sym}' at ` +
                      `0x${ins.addr.toString(16)} fills ${argc} argument registers, and the value ` +
                      `stored to '${slot.mem}' at 0x${slot.addr.toString(16)} reaches it in the callee's ` +
                      `parameter area, where an argument past the registers travels`,
                  );
                }
              },
            },
          });
          for (const cr of CR_VOLATILE) {
            cmpDef.set(
              cr,
              `the call at 0x${ins.addr.toString(16)} destroyed it (the EABI does not preserve ${cr} across a call)`,
            );
          }
          break;
        }
        // Stack-frame + link-register bookkeeping. `stwu r1,-N(r1)` / `addi r1,r1,N` adjust the frame
        // pointer; `mflr` copies the return address out (a `return-address` in `nonValues`) and `mtlr`
        // puts it back.
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
            // The push also STORES: the entry r1, at its new top, which is the entry offset of `s`
            // because r1 has not moved yet. A value stored there before the push is overwritten, and
            // a load from it afterwards reads the caller's r1.
            refuseMixedSlot(ins, s, parseMem(s).off, 'save');
            saveSlots.set(parseMem(s).off, 'r1');
            break;
          }
          throw new PpcUnsupportedError(
            `cannot lift '${name}': stwu with update on ${parseMem(s).base} (store-with-base-update) not modelled`,
          );
        case 'mflr': {
          refuseOverwrittenLink(ins);
          const lr = mkValue(T.unk(32));
          nonValues.set(lr, { kind: 'return-address', addr: ins.addr });
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
            if (inLocalArea(ins, s, 4 * (32 - Number(d.slice(1)))) !== undefined) {
              fail(
                `cannot lift '${name}': address-taken stack local — the 'stmw' at 0x${ins.addr.toString(16)} saves ` +
                  `into the local area, a frame this does not describe`,
              );
            }
            const off = entryOffset(ins, s);
            const depth = off - parseMem(s).off;
            for (const slot of frameRange(d, off)) {
              saveInto(ins, slot.reg, slot.off, `${slot.off - depth}(r1)`);
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
              const word = `${slot.off}(r1)`;
              if (inLocalArea(ins, word, 4) !== undefined) {
                fail(
                  `cannot lift '${name}': address-taken stack local — the 'lmw' at 0x${ins.addr.toString(16)} ` +
                    `reloads ${slot.reg} out of '${word}', inside the local area, a frame this does not describe`,
                );
              }
              frameLoad(ins, slot.reg, word);
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
            // A jump table's own name is read as data and never written down, so the naming policy
            // does not ask it; RELA pairs a half only with a low half of the same symbol and addend,
            // and that one, with no immediate of its own, makes a table base (`foldTableBase`).
            const table = tableBases.wants({ sym: ins.reloc.sym, addend: ins.reloc.addend });
            relocTaken = true;
            const hi = mkValue(T.unk(32));
            highHalves.record(hi, {
              sym: table ? ins.reloc.sym : spellableSym(ins),
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
          // A capture, `addi rD,r1,k`, is the `laddr` of the local area's offset k, where the frame
          // has one (`measurePpcFrame`); without one it reaches `read`'s r1-as-data refusal. A capture
          // moved by a constant is the capture at the sum.
          if (frame !== null && takesFrameAddress(ins, target.registerSaveRoutines?.frameReg)) {
            write(d, emitLaddr(parseImm(t) + (r1At.get(ins) as number) + frame.size));
            break;
          }
          if (
            frame !== null &&
            mnem === 'addi' &&
            !ins.reloc &&
            isReg(s) &&
            s !== 'r0' &&
            s !== 'r1' &&
            !SMALL_DATA_BASES.includes(s)
          ) {
            const raw = readVar(s, bi);
            const at = laddrAt.get(raw);
            if (at !== undefined) {
              movedCaptures.add(raw);
              write(d, emitLaddr(at + parseImm(t)));
              break;
            }
          }
          if (mnem === 'addi' && d === target.registerSaveRoutines?.frameReg && s === 'r1' && !ins.reloc) {
            const v = mkValue(T.unk(32));
            const depth = r1At.get(ins);
            nonValues.set(v, {
              kind: 'frame-address',
              off: typeof depth === 'number' ? depth + parseImm(t) : (depth ?? 'the instruction is unreachable'),
              addr: ins.addr,
            });
            write(d, v);
            break;
          }
          // `addi rD,rHi,SYM@l` completes the address a `lis` began: rD = &SYM (+ the relocation's
          // addend). It is the only `@l` consumer modelled here. The others — `ori`, `addic`, and
          // the `@l`-in-a-displacement form (1,935 integer load/store sites across the three
          // checkouts, plus the float loads) — are left unbuilt per docs/level-tower.md's "earn the
          // level": no row in this benchmark reaches them. Each refuses at its own guard, and a
          // high half none of them consumed is caught by `readReg` or by the dangling-`@ha` check.
          if (mnem === 'addi' && ins.reloc?.type === 'R_PPC_ADDR16_LO') {
            const base = parseImm(t) === 0 ? foldTableBase(ins, s) : null;
            if (base !== null) {
              write(d, base);
              break;
            }
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
          {
            const a = read(s);
            const k = parseImm(t);
            emitBin('add', d, a, constVal(k));
            if (mnem === 'addic') {
              // a + K carries out exactly when a >=u 2^32 - K; K == 0 never carries.
              setCarry(
                () =>
                  k === 0
                    ? constVal(0)
                    : k === -1
                      ? kit.tmp('icmp_ne', [a, constVal(0)])
                      : kit.tmp('icmp_uge', [a, constVal((2 ** 32 - (k >>> 0)) | 0)]),
                true,
              );
            }
          }
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
        case 'subfo':
        case 'subfc':
        case 'subfco': {
          const b = read(t);
          const a = read(s);
          const diff = emitBin('sub', d, b, a);
          if (mnem.startsWith('subfc')) {
            setCarry(() => {
              const c = kit.tmp('icmp_uge', [b, a]);
              carrySource.set(c, diff);
              return c;
            });
          }
          break; // rD = rB - rA (reversed)
        }
        case 'subfic': {
          const k = constVal(parseImm(t));
          const a = read(s);
          const diff = emitBin('sub', d, k, a);
          setCarry(() => {
            const c = parseImm(t) === 0 ? kit.tmp('icmp_eq', [a, constVal(0)]) : kit.tmp('icmp_uge', [k, a]);
            carrySource.set(c, diff);
            return c;
          });
          break; // rD = imm - rA
        }
        // The carry READERS, each over the carry its block's writer left (`readCarry`):
        //   subfe rD,rA,rB = ~rA + rB + CA      adde rD,rA,rB = rA + rB + CA
        //   subfze rD,rA   = ~rA + CA           addze rD,rA   = rA + CA
        // Two `subfe` shapes are modelled, both of whose register halves cancel: `subfe rD,rY,rY`
        // (~y + y = -1, so CA - 1, reading no rY — mwcc writes it over a register holding anything,
        // the return address included) and `subfe rD,rA,rB` with rA = rB - 1 (~(x-1) + x = 0, so
        // CA). Any other `subfe` is the high half of a 64-bit subtract, and `subfze` over a register
        // that is no constant is a 64-bit negate: both stay unmodelled, as do `addme`/`subfme`.
        case 'subfe': {
          if (s === t) {
            const c = readCarry(ins);
            const r = emitBin('add', d, c, constVal(-1));
            const diff = carrySource.get(c);
            if (diff !== undefined) {
              truthPending.set(r, { diff, via: 'neg' }); // CA - 1; its negation is the 0/1 `rA <u rB`
            }
            break;
          }
          const b = read(t);
          const def = ops.find((o) => o.results[0] === read(s));
          if (def?.opcode === 'add' && def.operands[0] === b && constIn(def.operands[1]) === -1) {
            readWithoutOp.add(def.results[0]);
            write(d, readCarry(ins));
            break;
          }
          emitOpaqueDest(ins);
          break;
        }
        case 'subfze': {
          const x = read(s);
          const k = constIn(x);
          if (k !== undefined) {
            readWithoutOp.add(x);
            const ca = readCarry(ins);
            ~k === 0 ? write(d, ca) : emitBin('add', d, constVal(~k), ca);
            break;
          }
          // mwcc hoists the constant out of a loop (`li r3,-1` ahead of the loop, `subfze r0,r3` in
          // its body), so the register comes in through a join. Whether every path brings the same
          // constant is known only once every block is filled; the exact `~rA + CA` stands until then.
          // The value may also come down through blocks with one predecessor from the block that set
          // it, so only a value this block computes is settled here; an entry parameter is the
          // caller's value, never a constant, and the settling refuses it.
          if (bi === 0 || ops.some((o) => o.results.includes(x))) {
            emitOpaqueDest(ins);
            break;
          }
          const ca = readCarry(ins);
          const inv = mkValue(T.unk(32));
          const not = mkOp('not', { operands: [x], results: [inv] });
          ops.push(not);
          emitBin('add', d, inv, ca);
          joinedCarryConsts.push({ ins, not, add: ops[ops.length - 1], ca });
          break;
        }
        case 'adde':
          emitBin('add', d, binTmp('add', read(s), read(t)), readCarry(ins, true));
          break;
        case 'addze': {
          const c = readCarry(ins, true);
          const r = emitBin('add', d, read(s), c);
          const diff = carrySource.get(c);
          if (diff !== undefined) {
            truthPending.set(r, { diff, via: 'and1' }); // mwcc's signed compare keeps bit 0 of this
          }
          break;
        }
        case 'neg': {
          const x = read(s);
          const n = emitUn('neg', d, x);
          if (truthPending.get(x)?.via === 'neg') {
            truthDifferences.push({ diff: truthPending.get(x)!.diff, carry: x, truth: n });
          }
          break;
        }
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
        case 'clrlwi': {
          const x = read(s);
          const m = emitBin('and', d, x, constVal((0xffffffff >>> parseImm(t)) >>> 0));
          if (parseImm(t) === 31 && truthPending.get(x)?.via === 'and1') {
            truthDifferences.push({ diff: truthPending.get(x)!.diff, carry: x, truth: m });
          }
          break;
        }
        case 'clrrwi':
          emitBin('and', d, read(s), constVal((0xffffffff << parseImm(t)) >>> 0));
          break;
        case 'rlwinm': {
          const [sh, mb, me] = [parseImm(ins.ops[2]), parseImm(ins.ops[3]), parseImm(ins.ops[4])];
          // `rlwinm rD,rS,SH,MB,ME` = rotl(rS,SH) & mask(MB,ME). Three cases we can lower exactly:
          //  • SH==0            — a pure masked AND.
          //  • right-shift EXTRACT `(x>>n)&m` — the field lies in the SH bits the rotate brings round
          //    from the top (MB >= 32-SH, MB <= ME): the compiler's form for `(x>>n)&mask`, with
          //    n=32-SH and mask=mask(MB,ME). Emit the shift then the AND — the faithful, idiomatic C
          //    that recompiles to this exact rlwinm. Where that field is the one bit x's sign bit
          //    lands on (MB == ME == 32-SH) it is `(x >>u 31) << (SH-1)`: mwcc merges a shift of a
          //    0/1 value into its extract (`(a < b) << 3` ends `rlwinm r3,r0,4,28,28` on 2.4.x), and
          //    the `srwi 31` the branch-free compare folds read is then whole (pattern/engine.ts
          //    MWCC_COMPARE_PATTERNS).
          //  • left-shift INSERT `(x&m)<<SH` — the field lies wholly in the bits the shift fills
          //    (MB <= ME <= 31-SH): `(x & (mask >> SH)) << SH`, mwcc's form for a masked value moved
          //    up (`(a < b) << 5` over 2.3.3's `& 1` ends `rlwinm r3,r0,5,26,26`).
          //  • anything else (a genuine rotate / bitfield insert) stays an opaque — loud, not dropped.
          if (sh === 0) {
            emitBin('and', d, read(s), constVal(rlwinmMask(mb, me)));
            break;
          }
          if (mb === me && mb === 32 - sh && sh > 1) {
            const sign = mkValue(T.unk(32));
            ops.push(mkOp('shr_u', { operands: [read(s)], results: [sign], attrs: { imm: 31 } }));
            emitShImm('shl', d, sign, sh - 1);
            break;
          }
          if (mb <= me && me <= 31 - sh) {
            const masked = mkValue(T.unk(32));
            ops.push(mkOp('and', { operands: [read(s), constVal(rlwinmMask(mb, me) >>> sh)], results: [masked] }));
            emitShImm('shl', d, masked, sh);
            break;
          }
          if (mb <= me && sh + mb >= 32) {
            const shifted = mkValue(T.unk(32));
            ops.push(mkOp('shr_u', { operands: [read(s)], results: [shifted], attrs: { imm: (32 - sh) & 31 } }));
            emitBin('and', d, shifted, constVal(rlwinmMask(mb, me)));
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
        case 'fadds':
        case 'fsubs':
        case 'fmuls':
        case 'fdivs':
        case 'fadd':
        case 'fsub':
        case 'fmul':
        case 'fdiv':
        case 'fneg':
        case 'fmr': {
          const { op } = FP_ARITH[mnem];
          if (rc || fpu === undefined || ins.ops.length === 0 || !ins.ops.every(isFpKey)) {
            emitOpaqueDest(ins);
            break;
          }
          if (callInsn) {
            throw new PpcUnsupportedError(
              `cannot lift '${name}': '${ins.mnemonic}' computes on a float and '${callInsn.mnemonic}' at ` +
                `0x${callInsn.addr.toString(16)} makes a call — the floating-point registers a call reads, returns ` +
                `in and destroys are not modelled`,
            );
          }
          if (fpType === null) {
            refuseBothPrecisions(name, ins.mnemonic);
          }
          const [dst, ...srcs] = ins.ops;
          if (op === 'copy') {
            writeVar(dst, bi, read(srcs[0]));
            break;
          }
          const v = mkValue(fpType);
          ops.push(mkOp(op, { operands: srcs.map(read), results: [v] }));
          writeVar(dst, bi, v);
          break;
        }
        default:
          emitOpaqueDest(ins);
          break; // unmodelled: an honest opaque, never a silent drop
      }
      if (CARRY_READERS.test(mnem)) {
        clobberCarry('set it as the carry out of an extended add or subtract, which is not modelled');
      }
      // A record-form op sets cr0 from a signed compare of its result against 0. Wire that so the
      // next branch reading cr0 fuses (`andi. r0,r3,1; beq …` → `if ((a0 & 1) == 0)`).
      if (rc && lastDef) {
        cmpDef.set('cr0', { lhs: lastDef, rhs: constVal(0), signed: true });
        compared.add(lastDef);
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
    // Asked before the jump-table lowering: a table whose bound is a conditional return
    // (`cmplwi rS,N; bgtlr`) lowers that return as the switch's default edge, and it jumps through
    // whatever the link register holds there exactly as a plain `bgtlr` does.
    if (br && (isReturn(br) || isCondReturn(br))) {
      refuseOverwrittenLink(br);
    }
    if (jt) {
      if (jt.hoisted) {
        tableBases.demand(jt.hoisted, bi, jt.bctrAddr);
      }
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
      // A LAST block with no terminator runs off the end of the text: the input stops before the
      // function does (a dump split at a foreign label, a hand-supplied fragment), and what
      // follows is unknown. Lifting it as a return invents one. Thumb refuses the same way.
      if (!br) {
        const last = b.body[b.body.length - 1];
        fail(
          `cannot lift '${name}': control falls off the end (the block at 0x${b.startAddr.toString(16)} has no ` +
            `terminator and no successor${last ? `; its last instruction is at 0x${last.addr.toString(16)}` : ''})`,
        );
      }
      emitReturn(ops, bi);
      return;
    }
    // unconditional branch
    ops.push(mkOp('br', { successors: [succ(succIdx[bi][0])] }));
  };

  blocks.forEach((b, bi) => {
    fillBlock(b, bi);
    ssa.markFilled(bi);
  });
  returnUntouchedArg();
  // A high half no `@l` ever completed — every `@l` consumer this frontend does not model (`ori`, a
  // float load's displacement) lands here, which is what keeps "not modelled" from becoming "not
  // emitted".
  highHalves.assertAllConsumed(name);
  tableBases.prove(name, ssa);
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
  const argSlots = ppcArgSlots(name, fpuArgSlots(name, fpu, ARG_REGS, isFpKey, fpType), ARG_REGS, prototypes[name]);
  mintArgSlotHoles(ssa, preds[0].length > 0, argSlots);
  const droppedPairHalf = computedPairHalf(
    irBlocks,
    pairReturns,
    target.compilerBehaviors.keepsUnusedReads === true
      ? (v) => paramReg.get(v) === RET && irBlocks[0].params.includes(v)
      : undefined,
    truthDifferences,
    (v) => compared.has(v) || readWithoutOp.has(v) || ssa.frameWrites.has(v),
  );
  ssa.finish();
  resolveJoinedCarryConsts(name, ssa.fn, joinedCarryConsts);
  if (droppedPairHalf) {
    throw new PpcUnsupportedError(
      `cannot lift '${name}': at a word return no declaration sizes, r4 holds a value this function computed ` +
        'and nothing reads, which is the other word of a 64-bit return (r3:r4); returning r3 alone would drop it',
    );
  }
  highHalves.assertNoneEscaped(name, irBlocks);
  tableBases.assertNoneEscaped(name, irBlocks);
  // A non-value reaches a use through a join's incoming arguments as well as directly (`nonValues`).
  assertNoNonValueEscaped(irBlocks);
  assertNonValuesConsumed();

  if (frame !== null) {
    // Prove every `laddr` names storage of this frame at a shape the machine states, or decline
    // (`auditFrameObjects`); an accepted function then gets the device pin the audit answers. The
    // slot model's words are named from the pushed r1, as the audit names every offset.
    const verdict = FRAME_OBJECT_AUDIT.run({
      name,
      irBlocks,
      ownedLocals: frame.area,
      declaredLocals: frame.area,
      usedSlotOffsets: new Set(
        [...valueSlots.keys()].map((o) => o + frame.size).filter((o) => o >= 0 && o < frame.size),
      ),
      capturedObjectIsTheWholeFrame: false,
      movedCaptures,
      returnsWithoutHiddenPointer: calls.returnsWithoutHiddenPointer,
      symbols: undefined,
      target,
      oneObject,
    });
    if (verdict !== undefined && 'oneObject' in verdict) {
      return verdict;
    }
    if (verdict !== undefined) {
      pinDeviceAccesses(irBlocks, verdict, target, undefined);
    }
  }
  pinDeadReads(irBlocks, target, {
    name,
    own: prototypes[name],
    atWordReturn: unreadHigh,
    atUndeclaredCall: calls.heldAtUndeclaredCall,
    compared,
    spilled: ssa.frameWrites,
    discarded: leftInDiscardRegister(irBlocks, discarded, writtenElsewhere),
    declarations,
  });

  abiSortEntryParams(irBlocks[0], preds[0].length > 0, paramReg, argSlots);
  ssa.fn.localObjects = statics.finish();
  return ssa.fn;
}

/** WHETHER A WORD RETURN'S r4 WAS COMPUTED FOR NOTHING, which the lift refuses. `returns` holds,
 *  for each word return no declaration pins the width of, the word r3 returns and what r4, the
 *  second register of an r3:r4 return, may hold there (frontend/dead-reads.ts `unreadPairHalf`).
 *  Where one of those values is the result of an op that nothing reads — directly, or through joins
 *  nothing reads — the compiler computed it for the caller: an optimizing compiler deletes a pure
 *  computation nobody reads, so a value that survives in r4 with no reader is the other word of a
 *  64-bit return, and returning r3 alone drops it. mwcc's `(unsigned long long)a - b` is `subfc
 *  r4,r4,r3; subfe r3,r4,r4`, whose high word is the very `subfe` a 32-bit `-(a < b)` is, and `long
 *  long x = a; if (c) x = -x; return x;` joins `0 - a` into r4 below the branch; both would lift as
 *  their high word.
 *
 *  AT A LEVEL THAT KEEPS DEAD CODE (`entryWord` given, where `keepsUnusedReads` holds) that premise
 *  fails for a parameter: mwcc -O0 keeps `b = a + 1;` in b's register r4. There a return whose r3
 *  is still the entry value (`entryWord`, directly or through joins of only it) is not asked, since
 *  -O0 spells a 64-bit op as both words' ops and writes r3 even where its word is unchanged (`x |
 *  0xff` is `or r4,r4,r5; or r3,r3,r0` with r0 = 0), in every 64-bit shape measured on 2.4.2, 2.4.7
 *  and 2.3.3. At -O4 an untouched r3 is evidence of nothing: `((u64)a << 32) | (b + 1)` is `addi
 *  r4,r4,1`. A dead parameter store beside a computed r3 (`b = a * 3; return a + 1;`) still
 *  refuses.
 *
 *  Asked BEFORE `ssa.finish`, while every join is still a parameter with its incoming values wired,
 *  so a join the trivial-phi pass would fold is walked, not lost, and refused AFTER it, so an
 *  unmodelled instruction or an unresolved `subfze` keeps its own message. `exemptValue` names a
 *  value the machine did use where the lift left no op for the use: one a compare consumed (`compared`),
 *  one a carry reader folded away (`readWithoutOp`: ac-decomp's `mSP_GetRealShopLevel` returns `(x
 *  >= 25000)` as `li r4,-1; subfc r0,r0,r3; subfze r3,r4`), a `subfc`/`subfic` difference whose
 *  carry a reader turned into a 0/1 truth value (`truthDifferences`, kept only where that reader is
 *  the carry's sole consumer in its block and neither is r3's word: 2.3.3's `a + (a < b)` is
 *  `subfc r4,r4,r3; subfe r0,r0,r0; neg r0,r0; add r3,r3,r0` over the dead `b`, and the signed one
 *  keeps bit 0 of an `addze`; a 64-bit high word reads the borrow as `CA - 1`, which r3 returns),
 *  and one stored to the frame (`frameWrites`). A function that holds an
 *  unmodelled instruction is not asked: the `opaque` may read r4 without naming it, and it declines
 *  under its own name. A value r4 holds that the function did not compute — its entry value, the
 *  caller's `a` that `long long z(unsigned a) { return a; }` moves there — is not seen, and that
 *  word return still drops the low word. */
type PairReturn = { word: Value; high: ReadonlySet<Value> };
/** A `subfc`/`subfic` difference (`diff`) whose carry a reader made a 0/1 truth value: `carry` is
 *  the `subfe rX,rY,rY` (CA - 1) or `addze` result, `truth` the `neg` or `clrlwi 31` over it. */
type TruthDifference = { diff: Value; carry: Value; truth: Value };
function computedPairHalf(
  blocks: readonly Block[],
  returns: readonly PairReturn[],
  entryWord: ((v: Value) => boolean) | undefined,
  truthDifferences: readonly TruthDifference[],
  exemptValue: (v: Value) => boolean,
): boolean {
  if (returns.every((r) => r.high.size === 0) || blocks.some((b) => b.ops.some((o) => o.opcode === 'opaque'))) {
    return false;
  }
  const defOf = new Map<Value, Op>();
  const blockOf = new Map<Op, Block>();
  const incoming = new Map<Value, Value[]>();
  // Every reader of each value: the ops that take it as an operand, a join argument counting as one.
  const readers = new Map<Value, number>();
  const readBy = (v: Value) => readers.set(v, (readers.get(v) ?? 0) + 1);
  for (const b of blocks) {
    for (const o of b.ops) {
      blockOf.set(o, b);
      o.results.forEach((r) => defOf.set(r, o));
      o.operands.forEach(readBy);
      for (const succ of o.successors) {
        succ.args.forEach((a, i) => {
          readBy(a);
          const p = succ.block.params[i];
          incoming.set(p, [...(incoming.get(p) ?? []), a]);
        });
      }
    }
  }
  // What r3 may hold at a word return: the word itself, and every value a join of it carries in.
  const returned = new Set<Value>();
  const toReturn = returns.map((r) => r.word);
  while (toReturn.length > 0) {
    const v = toReturn.pop()!;
    if (!returned.has(v)) {
      returned.add(v);
      toReturn.push(...(incoming.get(v) ?? []));
    }
  }
  // A truth value's difference is the compare's by-product only where nothing else saw the carry:
  // the reader is its sole consumer and runs in its block, so on every path the difference takes,
  // and neither the carry nor the truth value is what r3 returns. mwcc's `u64 d = (u64)a - b; *p =
  // -(int)(d >> 32); return d;` is `subfc r4,r4,r3; subfe r3,r4,r4; neg r0,r3`: that `subfe` is
  // the high word, the `neg` beside it is a second reader, and r4 is the low word.
  const comparedDifference = new Set<Value>();
  for (const { diff, carry, truth } of truthDifferences) {
    const reader = defOf.get(truth);
    const writer = defOf.get(carry);
    if (
      reader !== undefined &&
      writer !== undefined &&
      reader.operands.filter((x) => x === carry).length === 1 &&
      readers.get(carry) === 1 &&
      !exemptValue(carry) &&
      blockOf.get(reader) === blockOf.get(writer) &&
      !returned.has(carry) &&
      !returned.has(truth)
    ) {
      comparedDifference.add(diff);
    }
  }
  const exempt = (v: Value) => exemptValue(v) || comparedDifference.has(v);
  // What some kept op reads, through the joins that carry it there.
  const read = new Set<Value>();
  const work: Value[] = [];
  const mark = (v: Value) => {
    if (!read.has(v)) {
      read.add(v);
      work.push(v);
    }
  };
  for (const b of blocks) {
    for (const o of b.ops) {
      if (!deletableWhenDead(o)) {
        o.operands.forEach(mark);
      }
    }
  }
  while (work.length > 0) {
    const v = work.pop()!;
    defOf.get(v)?.operands.forEach(mark);
    incoming.get(v)?.forEach(mark);
  }
  const seen = new Set<Value>();
  const computedForNothing = (v: Value): boolean => {
    if (seen.has(v) || read.has(v) || exempt(v)) {
      return false;
    }
    seen.add(v);
    const def = defOf.get(v);
    if (def !== undefined) {
      return def.opcode !== 'undef';
    }
    return (incoming.get(v) ?? []).some(computedForNothing);
  };
  // Whether `v` is r3's entry value on every path: directly, or through joins of nothing else.
  const entry = (v: Value, on: Set<Value>): boolean => {
    if (entryWord!(v)) {
      return true;
    }
    const ins = incoming.get(v);
    if (ins === undefined || on.has(v)) {
      return ins !== undefined;
    }
    on.add(v);
    return ins.every((x) => entry(x, on));
  };
  return returns.some(
    (r) => !(entryWord !== undefined && entry(r.word, new Set())) && [...r.high].some(computedForNothing),
  );
}

/** Settle each `subfze rD,rA` whose rA came in through a join (the `subfze` decode): where every
 *  path brings the same constant K — the join's incoming values followed back, each a `const` or a
 *  join of its own, a cycle adding nothing — the `~rA + CA` becomes `~K + CA`, which is CA itself
 *  for mwcc's `li -1`. Anything else refuses, as an unmodelled `subfze` does in its own block: over
 *  a register that is no constant it is the high half of a 64-bit negate. */
function resolveJoinedCarryConsts(
  name: string,
  fn: Fn,
  pending: readonly { ins: Instr; not: Op; add: Op; ca: Value }[],
): void {
  if (pending.length === 0) {
    return;
  }
  const defs = new Map<Value, Op>();
  const incoming = new Map<Value, Value[]>();
  for (const b of fn.blocks) {
    for (const o of b.ops) {
      o.results.forEach((r) => defs.set(r, o));
      for (const succ of o.successors) {
        succ.args.forEach((a, i) => {
          const p = succ.block.params[i];
          incoming.set(p, [...(incoming.get(p) ?? []), a]);
        });
      }
    }
  }
  // The one constant `v` is on every path, `null` where it is none, `undefined` where only a cycle
  // brings it (which says nothing).
  const constantOf = (v: Value, seen: Set<Value>): number | null | undefined => {
    const def = defs.get(v);
    if (def !== undefined) {
      return def.opcode === 'const' && typeof def.attrs.value === 'number' ? def.attrs.value | 0 : null;
    }
    const ins = incoming.get(v);
    if (ins === undefined) {
      return null; // an entry parameter
    }
    if (seen.has(v)) {
      return undefined;
    }
    seen.add(v);
    let k: number | undefined;
    for (const a of ins) {
      const c = constantOf(a, seen);
      if (c === null || (c !== undefined && k !== undefined && c !== k)) {
        return null;
      }
      k ??= c;
    }
    return k ?? null;
  };
  for (const { ins, not, add, ca } of pending) {
    const k = constantOf(not.operands[0], new Set());
    if (k === null || k === undefined) {
      throw new PpcUnsupportedError(
        `cannot lift '${name}': unmodelled instruction '${ins.mnemonic}' at 0x${ins.addr.toString(16)} — it reads ` +
          `${ins.ops[1]}, which is not one constant on every path into its block, and a subfze over a register is the ` +
          'upper word of a 64-bit negate',
      );
    }
    const home = fn.blocks.find((b) => b.ops.includes(add))!;
    if (~k === 0) {
      replaceAllUsesWith(fn, add.results[0], ca);
      home.ops.splice(home.ops.indexOf(add), 1);
      home.ops.splice(home.ops.indexOf(not), 1);
    } else {
      Object.assign(not, { opcode: 'const', operands: [], attrs: { value: ~k } });
    }
  }
}

function mkCmp(ops: Op[], opc: Opcode, l: Value, r: Value): Value {
  const v = mkValue(T.unk(32));
  ops.push(mkOp(opc, { operands: [l, r], results: [v] }));
  return v;
}

/** The EABI's slots: the shared register-then-stack-word rule (`stackArgSlots`), refusing a stack
 *  word read beside a floating-point argument — the FPRs are a separate file, so where a float
 *  parameter falls among the integer ones is not in the object — or in a function whose own
 *  declaration has a 64-bit or floating parameter, which takes words the integer count does not. */
function ppcArgSlots(name: string, regs: ArgSlots, argRegs: readonly string[], own: FnProto | undefined): ArgSlots {
  return stackArgSlots(regs, argRegs, (readKeys, top) => {
    const float = readKeys.find(isFpKey);
    const declared = Array.isArray(own?.params)
      ? own.params.find((p) => isFloatingSpelling(p) || (declaredWidth(p) ?? 0) > 32)
      : undefined;
    if (float !== undefined || declared !== undefined) {
      throw new PpcUnsupportedError(
        `cannot lift '${name}': incoming stack argument ${top + 1} is read beside ` +
          (float !== undefined ? `the floating-point argument in ${float}` : `a parameter declared '${declared}'`) +
          ` — which words that argument takes ahead of the stack words is not modelled`,
      );
    }
  });
}

/** The PowerPC / CodeWarrior frontend, registered for the `ppc` target. */
export const ppcFrontend: Frontend = { id: 'ppc', inputFormat: 'objdump', lift };

/** Internal surface for this module's own tests, and for nothing else (`frontend/frame-objects.ts`
 *  says why it is not a plain export). */
export const __testing = {
  PARAM_AREA_AT,
  /** the local area `lift` draws for one function of objdump text (`liftPrelude`), or its refusal */
  frameOf: (name: string, asm: string, target: TargetDescription, prototypes: Prototypes = {}, asmData?: AsmData) => {
    const instrs = parseDisasm(sliceSymbol(asm, name));
    const jts = asmData ? recoverPpcJumpTables(instrs, asmData) : new Map<number, PpcJT>();
    return liftPrelude(name, instrs, target, prototypes, jts).frame;
  },
};
