// asmlift ISA frontend — MIPS-II (IDO 7.1, N64). Input is DISASSEMBLED text
// (`mips-linux-gnu-objdump -d --no-show-raw-insn`), since IDO emits no textual asm.
//
// The MIPS-specific concern is the DELAY SLOT: the instruction textually AFTER a control
// transfer executes BEFORE the transfer takes effect (on both the taken and fall-through
// paths). It is therefore lifted into the branching block, sequenced right before the branch —
// EXCEPT that a conditional branch reads its comparison operands as of the branch, so those
// SSA values are captured BEFORE the delay slot runs, then the delay slot executes, then the
// `cond_br` is emitted. A `jr ra` return's delay slot (which computes the return value) runs
// first, then the value is read. A call's (`jal`) delay slot runs before the call, so it can set
// an argument up. A branch-likely (`beql`/`bnel`…) annuls its slot when not taken, so the slot is
// a block of its own on the taken edge (`toBlocks`).
//
// Comparison model: MIPS fuses compare-and-branch, so a branch lowers directly to an icmp
// (the branch mnemonics are signed/equality only). `bltz/bgez/blez/bgtz` compare against zero; `beq/bne`
// compare two registers; `beqz/bnez` test a register (or fold a preceding `slt` — `slt at,rs,
// rt; beqz at,L` means "branch when !(rs<rt)", i.e. the negated compare). A materialised `slt`
// with no consuming branch (e.g. `return a>b` → `slt v0,a1,a0`) stays an icmp value. Unsigned
// compares (`sltu`/`sltiu`) lower to `icmp_ult`; recover types their operands u32 so the backend
// re-emits `sltu` (the operator is the same `<` — the signedness lives in the operand types).
import { type Block, Fn, Op, Successor, Value, mkOp, mkValue } from '../ir/core';
import { NEGATED_ICMP, type Opcode } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Prototypes, declaresVoidReturn, ownReturnWidth, wordsOf } from '../proto';
import type { ContextGlobals } from '../proto-context';
import type { SymbolMap } from '../symbols';
import type { TargetDescription } from '../target';
import { type AsmData, readJumpTable, textRelocAt } from './asmdata';
import { callDeclarations, foldByValueArgs } from './call-plan';
import { pinDeadReads } from './dead-reads';
import { pinDeviceAccesses } from './device-pins';
import {
  type DisasmInstr,
  parseImm,
  parseMem,
  parseDisasm as parseSharedDisasm,
  sliceSymbol,
  symbolStart,
} from './disasm';
import { mkEmitKit, pushSwitchBr } from './emit';
import { type FrontendRefusal, FrontendUnsupportedError } from './errors';
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
import { opaqueDest } from './opaque';
import { MIPS_FP_REG, isSplatMips, mipsEvenFpKey, parseSplatMips } from './splat';
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

// A control transfer with its comparison opcode for "branch taken" (against a second register
// or, for the *z forms, against zero).
const COND_Z: Record<string, Opcode> = {
  beqz: 'icmp_eq',
  bnez: 'icmp_ne',
  blez: 'icmp_sle',
  bgtz: 'icmp_sgt',
  bltz: 'icmp_slt',
  bgez: 'icmp_sge',
};
const COND_RR: Record<string, Opcode> = { beq: 'icmp_eq', bne: 'icmp_ne' };
// BRANCH-LIKELY → the ordinary branch it tests the same way. The difference is the delay slot:
// a likely branch NULLIFIES its slot when the branch is not taken, so the slot is conditional code
// (see `toBlocks`, which gives it its own block on the taken edge). `beqzl`/`bnezl` are objdump's
// printing of `beql`/`bnel` against `$0`; both spellings appear in the corpus.
const LIKELY_BASE: Record<string, string> = {
  beql: 'beq',
  bnel: 'bne',
  beqzl: 'beqz',
  bnezl: 'bnez',
  blezl: 'blez',
  bgtzl: 'bgtz',
  bltzl: 'bltz',
  bgezl: 'bgez',
};
// A coprocessor-1 branch tests an FP condition code (`fcc`) that `c.cond.s/d` sets. Neither the
// code nor the compare is modelled, so these refuse whether or not they are also likely.
const isFpCondBranch = (m: string) => m.startsWith('bc1');

/** The FPU arithmetic this frontend lifts, onto the float opcodes (`mov.s`/`mov.d` are copies and
 *  have none), with the precision each computes in: `.s` single, `.d` double, one per function
 *  (`frontend/fpu.ts` `fpPrecision`). Every other FPU instruction — the conversions, the moves to and
 *  from the integer file and memory, the compares — keeps the register-file refusal `opaqueDest`
 *  gives it, and so does one of these naming an odd register (a double's second half, or a single
 *  this frontend does not key) or a target with no `fpu` homes. `docs/floating-point.md` says what
 *  the next layer is. */
const FP_ARITH: Readonly<Record<string, { op: Opcode | 'copy'; width: 32 | 64 }>> = {
  'add.s': { op: 'fadd', width: 32 },
  'sub.s': { op: 'fsub', width: 32 },
  'mul.s': { op: 'fmul', width: 32 },
  'div.s': { op: 'fdiv', width: 32 },
  'neg.s': { op: 'fneg', width: 32 },
  'mov.s': { op: 'copy', width: 32 },
  'add.d': { op: 'fadd', width: 64 },
  'sub.d': { op: 'fsub', width: 64 },
  'mul.d': { op: 'fmul', width: 64 },
  'div.d': { op: 'fdiv', width: 64 },
  'neg.d': { op: 'fneg', width: 64 },
  'mov.d': { op: 'copy', width: 64 },
};
const FP_ARITH_MNEMONICS: ReadonlySet<string> = new Set(Object.keys(FP_ARITH));
/** A key the SSA builder holds for the FPU's file: `mipsEvenFpKey`'s canonical spelling. */
const isFpKey = (k: string) => /^\$f\d+$/.test(k);

const isZero = (r: string) => r === 'zero' || r === '$0';
// The stack pointer (`$29`). A `sw/lw` through it is not a store/load through a data pointer — it
// is a spill/reload of a stack SLOT (an argument home slot or a local). See emitStore/emitLoad.
const isStackPtr = (r: string) => r === 'sp' || r === '$sp' || r === '$29';
// Where O32 puts a call's argument k ≥ 4: the caller's outgoing area keeps `[0,16)` as the home of
// a0..a3, and argument k is the word at `16 + 4(k − 4)` above the `sp` the call is made at.
// Compiled on ido7.1, gcc2.7.2kmc and gcc2.7.2: `g(a, b, 1, 2, 3)` stores the 3 to `16(sp)`.
const STACK_ARGS_AT = 16;
// SSA-variable name for the stack slot at a constant `sp`-offset. Distinct namespace from the
// register names (which are alphabetic / `$N`), so it never collides with a real register var.
const stackSlot = stackSlotKey; // shared spelling: frontend/ssa.ts
// Sub-word memory mnemonics (widths 1 and 2). Used by the `spSlotSafe` guard in `lift`: a sub-word
// `sp`-relative access means the word stack-slot model is unsafe for that function.
const SUBWORD_MEM = new Set(['lb', 'lbu', 'lh', 'lhu', 'sb', 'sh']);
// A MIPS register operand — a named reg (`a0`,`v0`,`t7`,`at`,`sp`,`ra`,`zero`) or `$N`. Excludes
// immediates, hex, memory `off(base)`, and branch targets, so the unhandled-op guard only taints a
// genuine register destination.
const isMipsReg = (s: string | undefined): s is string =>
  /^(\$\d+|[a-z][a-z0-9]*)$/i.test(s ?? '') && !/^0x/i.test(s ?? '');
// `jr ra`. A non-ra `jr` also lands here, but by block-fill time it is either a recovered
// switch dispatch (its block is pruned as unreachable, which `refuseReachableDispatch` checks) or
// has already loud-failed in `lift`.
const isReturn = (ins: Instr) => ins.mnemonic === 'jr';
const isUncond = (ins: Instr) => ins.mnemonic === 'b' || ins.mnemonic === 'j';
const isCond = (ins: Instr) => ins.mnemonic in COND_Z || ins.mnemonic in COND_RR;
const isXfer = (ins: Instr) => isReturn(ins) || isUncond(ins) || isCond(ins);
// ANY instruction that redirects control, modelled or not: on MIPS that is the whole `b*` space
// (minus the `break` trap) plus `j*`. `isXfer` is the subset this frontend models; this is the
// superset the refusals and the delay-slot guards have to reason about.
const isControlTransfer = (ins: Instr) =>
  (ins.mnemonic[0] === 'b' && ins.mnemonic !== 'break') || ins.mnemonic[0] === 'j';

// Shared objdump scaffolding (frontend/disasm.ts): parseImm/parseMem/parseDisasm. MIPS needs no
// reloc or hint-suffix handling; register-scaled indices are materialised by IDO as explicit
// `sll`+`addu` before the access, so no `base+index` addressing form appears in parseMem input.
// A zero word IS an instruction here — `sll zero,zero,0`, which objdump prints as `nop` — so the
// runs of them objdump elides as `...` (GCC's `mflo` hazard pads) come back as the nops they are.
const parseDisasm = (disasm: string): Instr[] => parseSharedDisasm(disasm, { zeroWord: 'nop' });

// Bridge an object file's `.text` relocation records onto the instructions they fill, so the
// high/low fold reads ONE carrier (`ins.reloc`) whichever dialect the input arrived in — the same
// carrier frontend/ppc.ts reads, folded by the same shared invariant (frontend/high-half.ts). The
// Splat dialect spells `%hi`/`%lo` in the operand text and writes its own records
// (frontend/splat.ts); objdump hides the symbol in the relocation table, which is what this reads.
//
// EVERY HI16/LO16 IS CARRIED, WHATEVER IT NAMES, and that includes a SECTION symbol (`.data`,
// `.rodata` — a file-static array, a string literal, any anonymous datum). A record left off the
// carrier leaves its pair raw, and raw is the `lui`'s link-time placeholder — the literal 0 in a
// relocatable object — standing in for the address, which `*(u8 *)(0 + i)` renders and the compiler
// accepts. Only a carrier that holds every record can put the fold's refusals in front of them.
//
// WHETHER THE NAME CAN BE WRITTEN DOWN is a different question, and this frontend does NOT adopt
// frontend/ppc.ts's naming-policy refusal for it. A section name is never a C identifier, so a
// recovered `.data` access is already LOUD twice over downstream: rank-declare.ts refuses the
// declaration and REPORTS the name to the caller, and the candidate's own source does not compile
// — strictly more than a frontend refusal would say, and what the mapless-decls tests are built
// around. The rest of the policy has nothing to refuse here, measured rather than assumed: of the
// 20,262 distinct symbols a `.text` HI16/LO16 names across the three N64 checkouts,
// `classifyRelocSymbol` answers `plain` for 20,245, `section-local` for 4 and `cpp-mangled` for 13
// — and all 13 are ORDINARY C NAMES (`game_GameFrame__1F`, `ovl__0078CB80_VRAM`) that the policy's
// `__<digit>` class-scope marker misreads. Adopting it would refuse 13 names C spells perfectly
// well and buy nothing: the kind it exists for, a mwcc vtable that would otherwise COMPILE, has no
// inhabitant on this ISA.
//
// A recovered JUMP TABLE's dispatch is untouched: Regime B reads the table through `asmdata.ts` and
// prunes the dispatch block, so its `lui %hi(.rodata)` never reaches `decode`.
//
// `R_MIPS_26` is a `jal`'s callee, and a `j`'s target where the jump stays in this section. objdump
// prints the field, which in a relocatable object is the addend and not the address, so the callee
// is read off this record alone.
//
// `R_MIPS_GOT16`/`R_MIPS_CALL16`/`R_MIPS_GPREL16` are PIC/small-data access, already refused by the
// `gp`-as-data guard; widening this carrier to them would trade those messages for worse ones
// without recovering an address.
//
// THE ADDEND IS NOT ON THE RECORD. MIPS objects are REL: the relocation has no addend field and the
// address's low bits live in the two instruction immediates, so a record that DOES carry an addend
// is not the format assumed here, and refuses.
function attachMipsRelocs(name: string, instrs: Instr[], ad: AsmData): void {
  const byAddr = new Map(instrs.map((ins) => [ins.addr, ins]));
  for (const r of ad.relocs) {
    if (r.section !== '.text' || (r.type !== 'R_MIPS_HI16' && r.type !== 'R_MIPS_LO16' && r.type !== 'R_MIPS_26')) {
      continue;
    }
    const ins = byAddr.get(r.offset);
    if (!ins) {
      // A `.text` record describes the whole section, so most belong to the object's OTHER
      // functions and are not this slice's business. One that lands INSIDE the slice and still
      // matches no instruction means the relocation table and this disassembly disagree about
      // addressing, and the half it describes would stay raw — so refuse rather than skip it.
      if (r.offset >= instrs[0].addr && r.offset <= instrs[instrs.length - 1].addr) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': relocation '${r.type} ${r.sym}' at 0x${r.offset.toString(16)} falls inside the ` +
            `function (0x${instrs[0].addr.toString(16)}..0x${instrs[instrs.length - 1].addr.toString(16)}) but on no ` +
            `instruction — the relocation table and this disassembly disagree about addressing`,
        );
      }
      continue;
    }
    if (r.addend !== 0) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': relocation '${r.type} ${r.sym}' at 0x${r.offset.toString(16)} carries an addend ` +
          `(0x${r.addend.toString(16)}), but MIPS relocations are REL and hold the addend in the instruction ` +
          `fields — this object is not the assumed format`,
      );
    }
    // At most one relocation per instruction — the same invariant disasm.ts and frontend/splat.ts
    // enforce on their own inputs: the carrier is one field, so keeping the last would leave one
    // symbol standing for the other's operand.
    if (ins.reloc) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': two relocations on one instruction ('${ins.mnemonic}' at ` +
          `0x${ins.addr.toString(16)}): '${ins.reloc.type} ${ins.reloc.sym}' and '${r.type} ${r.sym}'`,
      );
    }
    ins.reloc = { type: r.type, sym: r.sym, addend: 0 };
  }
}

interface MipsBlock {
  startAddr: number;
  body: Instr[]; // computation instructions (excludes the branch and its delay slot)
  branch: Instr | null; // terminating control transfer, or null for a pure fall-through
  // The word at `branch + 4`, which this block runs after its branch. NULL for a branch-LIKELY:
  // its slot is NULLIFIED when the branch is not taken, so it does not run in this block at all —
  // it is its own block at `branch + 4`, reached only by the taken edge, which then jumps on to
  // the branch's target.
  delay: Instr | null;
  delayAnnulled: boolean;
}

// Mnemonics whose FIRST operand is a source, never a destination: the stores, the branches that
// compare it, and the moves and products that read it.
const SOURCE_FIRST = /^(s[bhwd]|sw[lr]|sc|s[wd]c1|b\w*|j|jr|mult|multu|div|divu|mt\w+|ctc1|t\w+|cache|sync)$/;

/** THE INTEGER REGISTER AN INSTRUCTION WRITES, or null — the one classifier every reader here asks
 *  (the jump-table trace, the `gp` skip, the frame-depth walk, the save scan, the 64-bit return
 *  check), so no two of them can disagree on a mnemonic.
 *
 *  A DENY-LIST: every instruction writes its first operand unless it is one of `SOURCE_FIRST`'s.
 *  Every reader asks "is this the write of r?", and an unknown write answered no would be stepped
 *  past as though r still held what came before, so the default is the answer that stops them. A
 *  call writes `ra`, whatever it names first (`jal f`, and `jalr rs` with the implicit `ra`). */
const writtenReg = (ins: Instr): string | null => {
  if (ins.mnemonic === 'jalr') {
    return ins.ops.length > 1 ? ins.ops[0] : 'ra';
  }
  if (isCallInstr(ins)) {
    return 'ra';
  }
  return SOURCE_FIRST.test(ins.mnemonic) || !isMipsReg(ins.ops[0]) ? null : ins.ops[0];
};

/** A call: every instruction that links into `ra` — `jal`, `jalr`, and the linking branches. */
const isCallInstr = (ins: Instr) => /^(jal|jalr|bal|bgezall?|bltzall?)$/.test(ins.mnemonic);

/** The register a register COPY reads — `move rD,rS`, or `addu`/`add`/`or` with `zero` beside it,
 *  which is how Splat and IDO spell the same move — or undefined for any other instruction. */
const copiedReg = (ins: Instr): string | undefined => {
  const [, s, t] = ins.ops;
  if (ins.mnemonic === 'move') {
    return s;
  }
  if (!/^(addu|add|or)$/.test(ins.mnemonic) || s === undefined || t === undefined) {
    return undefined;
  }
  return isZero(t) ? s : isZero(s) ? t : undefined;
};

// A recovered dense-switch jump table (Regime B), keyed
// by the BOUNDS branch (`beqz tmp, DEF`) whose block emits the `switch_br`. Two idioms are
// handled: IDO gp-relative (`lw base,0(gp)` GOT16; `addu rV,rV,gp`
// after the load) and KMC absolute (`lui base` HI16). Delay slots are honoured — the `beqz` delay
// slot (which on IDO carries the DEFAULT return value `li v0,-1`) still executes before the
// `switch_br`.
interface MipsJT {
  scrutReg: string;
  caseAddrs: number[];
  defaultAddr: number;
  jrAddr: number;
  /** The start of the bounds block when its `sltiu` runs on the edges into it, not inside it
   *  (`mipsBounds`); null otherwise. */
  entry: number | null;
  /** The base register and table of a dispatch whose block does not form its base (KMC and gcc
   *  2.7.2 hoist the `lui`/`addiu` pair into a loop's preheader): `lift` proves the base reaches it
   *  (frontend/jump-table.ts). Null when the pruned block forms the base itself. */
  hoisted: HoistedDispatch | null;
}

/** A MIPS jump table's bounds guard for the dispatch whose `jr` is at `i`: `sltiu tmp,scrutReg,N`
 *  then `beqz tmp,DEF`, where the beqz is the nearest transfer before the `jr`. `at` is the beqz's
 *  index.
 *
 *  The `sltiu` is the last write of `tmp` on EVERY path into the beqz, so it is found per entry of
 *  the beqz's block, and every entry must run the same one: inside the block, after nothing that
 *  writes `tmp` or the scrutinee (IDO schedules `move s0,a1` between the two); or, where the block
 *  holds none, as the last word each edge into it runs. IDO rotates a `while` loop so that both of
 *  its entries do: the bounds `sltiu` sits in the delay slot of the loop-entry `beqz` (which runs it
 *  on the fall-through) and in the LIKELY slot of the latch `bnezl` (which runs it on the taken edge
 *  alone). An edge whose last word is not that `sltiu` — the not-taken edge of a likely branch, a
 *  call's return, the function's entry — leaves `tmp` unknown, and declines. `likely` holds the
 *  branch-likely addresses `normaliseBranchLikely` rewrote. */
function mipsBounds(
  instrs: Instr[],
  i: number,
  scrutReg: string,
  likely: ReadonlySet<number>,
): { at: number; addr: number; n: number; def: number; entry: number | null } | null {
  let k = i - 1;
  while (k >= 0 && !isControlTransfer(instrs[k])) {
    k--;
  }
  const beqz = instrs[k];
  if (!beqz || beqz.mnemonic !== 'beqz' || beqz.target === undefined) {
    return null;
  }
  const tmp = beqz.ops[0];
  const isBound = (c: Instr | undefined) => c?.mnemonic === 'sltiu' && c.ops[0] === tmp && c.ops[1] === scrutReg;
  const bound = (c: Instr, entry: number | null) => {
    // `sltiu tmp, scrut, N` bounds `scrut < N`: the immediate IS the case count (PPC's `cmplwi`
    // states the max index).
    const n = parseImm(c.ops[2]);
    return n < 2 ? null : { at: k, addr: beqz.addr, n, def: beqz.target!, entry };
  };
  const isTarget = (addr: number) => instrs.some((x) => x.target === addr);
  // The beqz's block: back to a branch target, or to the word after a transfer's delay slot.
  let s = k;
  while (
    s > 0 &&
    !isTarget(instrs[s].addr) &&
    !isControlTransfer(instrs[s - 1]) &&
    !(s > 1 && isControlTransfer(instrs[s - 2]))
  ) {
    s--;
  }
  for (let j = k - 1; j >= s; j--) {
    const c = instrs[j];
    if (isBound(c)) {
      return bound(c, null);
    }
    if (writtenReg(c) === tmp || writtenReg(c) === scrutReg) {
      return null;
    }
  }
  // No `sltiu` in the block: the last word each edge into it runs.
  const last: Array<Instr | undefined> = [];
  const p = instrs[s - 1];
  const t = instrs[s - 2];
  if (p === undefined || isControlTransfer(p)) {
    return null;
  }
  if (t !== undefined && isControlTransfer(t)) {
    // `p` is a delay slot: the fall-through edge runs it after a branch that is neither likely (its
    // not-taken edge annuls the slot) nor a call (which returns here from the callee); a jump has no
    // fall-through edge at all.
    if (likely.has(t.addr) || isCallInstr(t)) {
      return null;
    }
    if (!isUncond(t) && !isReturn(t)) {
      last.push(p);
    }
  } else {
    last.push(p);
  }
  // A taken edge runs the branch's delay slot, a likely one's included.
  instrs.forEach((x, o) => {
    if (x.target === instrs[s].addr) {
      last.push(isCallInstr(x) ? undefined : instrs[o + 1]);
    }
  });
  const first = last[0];
  if (
    first === undefined ||
    !isBound(first) ||
    !last.every((c) => c !== undefined && c.ops.join() === first.ops.join() && c.mnemonic === 'sltiu')
  ) {
    return null;
  }
  return bound(first, instrs[s].addr);
}

function recoverMipsJumpTables(instrs: Instr[], ad: AsmData, likely: ReadonlySet<number>): Map<number, MipsJT> {
  // Nearest def of `reg` strictly before index `p`, not crossing a control transfer (so the trace
  // stays inside the dispatch's extended block). Returns the instruction index, or -1.
  const defBefore = (reg: string, p: number): number => {
    for (let j = p - 1; j >= 0; j--) {
      if (isXfer(instrs[j])) {
        return -1;
      }
      if (writtenReg(instrs[j]) === reg) {
        return j;
      }
    }
    return -1;
  };
  // Is `ins` a table-base materialisation (`lui rB,hi` HI16, or `lw rB,0(gp)` GOT16) with a `.text`
  // relocation into a data section? Returns {sym, addend} locating the table, or null.
  const tableBaseOf = (ins: Instr): { sym: string; addend: number } | null => {
    const isLui = ins.mnemonic === 'lui';
    const isGpLw = ins.mnemonic === 'lw' && ins.ops[1] !== undefined && parseMem(ins.ops[1]).base === 'gp';
    if (!isLui && !isGpLw) {
      return null;
    }
    const r = textRelocAt(ad, ins.addr);
    if (!r) {
      return null;
    }
    const sec = ad.symbols.get(r.sym)?.section ?? r.sym; // ".rodata" section symbol → ".rodata"
    if (!/^\.(rodata|rdata|sdata2?|data)$/.test(sec)) {
      return null;
    }
    return { sym: r.sym, addend: r.addend };
  };

  /** The table a base formed OUTSIDE the dispatch block addresses, as far as the instructions say:
   *  every `addiu rB,rH,%lo` in the function, with the `lui rH,%hi` nearest before it, must name
   *  one table, or the guess is left undecided. KMC and gcc 2.7.2 form the base in a loop's
   *  preheader. Only a guess — `lift` pairs the halves and proves the base reaches the dispatch
   *  (frontend/jump-table.ts). The table's offset is the pair's own `%hi`/`%lo` halves, as REL
   *  relocations carry it. */
  const hoistedTable = (rB: string): TableKey | null =>
    agreedTable(
      instrs.flatMap((x, q) => {
        const lo = x.mnemonic === 'addiu' && x.ops[0] === rB ? textRelocAt(ad, x.addr) : null;
        if (lo?.type !== 'R_MIPS_LO16') {
          return [];
        }
        let p = q - 1;
        while (p >= 0 && writtenReg(instrs[p]) !== x.ops[1]) {
          p--;
        }
        const hi = p >= 0 && instrs[p].mnemonic === 'lui' ? tableBaseOf(instrs[p]) : null;
        if (!hi || hi.sym !== lo.sym) {
          return [{ sym: '', addend: NaN }];
        }
        const half = (o: string) => parseImm(o) & 0xffff;
        return [{ sym: hi.sym, addend: hi.addend + ((half(instrs[p].ops[1]) << 16) + ((half(x.ops[2]) << 16) >> 16)) }];
      }),
    );

  const out = new Map<number, MipsJT>();
  for (let i = 0; i < instrs.length; i++) {
    const jr = instrs[i];
    if (jr.mnemonic !== 'jr' || jr.ops[0] === 'ra') {
      continue;
    }
    let rV = jr.ops[0];
    // Optional IDO `+gp`: `addu rV, rL, gp` before the load — the loaded value is the other operand.
    let ldIdx = defBefore(rV, i);
    let gpIdx = -1;
    if (ldIdx >= 0 && instrs[ldIdx].mnemonic === 'addu') {
      const [a, b] = [instrs[ldIdx].ops[1], instrs[ldIdx].ops[2]];
      if (a === 'gp' || b === 'gp') {
        rV = a === 'gp' ? b : a;
        gpIdx = ldIdx;
        ldIdx = defBefore(rV, ldIdx);
      }
    }
    if (ldIdx < 0 || instrs[ldIdx].mnemonic !== 'lw') {
      continue;
    } // rV = *(rAddr)
    const mem = parseMem(instrs[ldIdx].ops[1]);
    if (mem.off !== 0) {
      continue;
    }
    const aIdx = defBefore(mem.base, ldIdx); // rAddr = base + index
    if (aIdx < 0 || instrs[aIdx].mnemonic !== 'addu') {
      continue;
    }
    const [oa, ob] = [instrs[aIdx].ops[1], instrs[aIdx].ops[2]];
    // One operand is the shifted index (`sll rIdx, scrut, 2` — identity guard), the other the table base.
    let scrutReg: string | null = null,
      table: { sym: string; addend: number } | null = null,
      sllIdx = -1,
      baseIdx = -1,
      hoisted: HoistedDispatch | null = null;
    for (const [idxCand, baseCand] of [
      [oa, ob],
      [ob, oa],
    ] as const) {
      const si = defBefore(idxCand, aIdx);
      const bi2 = defBefore(baseCand, aIdx);
      // A base the dispatch's block does not form is a HOISTED one (`hoistedTable`).
      const out = bi2 < 0 && si >= 0 ? hoistedTable(baseCand) : null;
      if (si < 0 || (bi2 < 0 && !out)) {
        continue;
      }
      const sll = instrs[si];
      if (sll.mnemonic !== 'sll' || (sll.ops[2] !== '0x2' && sll.ops[2] !== '2')) {
        continue;
      } // index*4
      const tb = out ?? tableBaseOf(instrs[bi2]);
      if (!tb) {
        continue;
      }
      scrutReg = sll.ops[1];
      table = tb;
      [sllIdx, baseIdx] = [si, bi2];
      hoisted = out ? { reg: baseCand, table: out } : null;
      break;
    }
    if (!scrutReg || !table) {
      continue;
    }
    // Bounds: `sltiu tmp, scrutReg, N ; beqz tmp, DEF`, the beqz the nearest transfer before the
    // dispatch. Its block emits the `switch_br`, reading the scrutinee where the beqz reads `tmp`.
    const bounds = mipsBounds(instrs, i, scrutReg, likely);
    if (!bounds) {
      continue;
    }
    // THE DISPATCH BLOCK — after the bounds branch's delay slot, through the `jr` and its own slot —
    // is pruned unread once the table is recovered, so it may hold the idiom and nothing else:
    // anything more would be dropped. Nothing may branch into it past the bounds check, the `jr`'s
    // slot must be empty, and nothing from the bounds slot on may rewrite the scrutinee before the
    // `sll` scales it (IDO's in-place `sll` IN the slot is that `sll`).
    const k = bounds.at;
    const idiom = new Set([ldIdx, aIdx, gpIdx, sllIdx, baseIdx]);
    if (
      instrs[i + 1]?.mnemonic !== 'nop' ||
      entersBetween(instrs, instrs[k].addr, instrs[i + 1].addr) ||
      instrs.slice(k + 2, i).some((_, o) => !idiom.has(k + 2 + o)) ||
      instrs.slice(k + 1, sllIdx).some((x) => writtenReg(x) === scrutReg)
    ) {
      continue;
    }
    const caseAddrs = readJumpTable(ad, table.sym, table.addend, bounds.n);
    if (!caseAddrs) {
      continue;
    }
    out.set(bounds.addr, {
      scrutReg,
      caseAddrs,
      defaultAddr: bounds.def,
      jrAddr: jr.addr,
      entry: bounds.entry,
      hoisted,
    });
  }
  // A bound read off its block's ENTRY EDGES holds only for the edges `mipsBounds` saw. A table's
  // arm is an edge too, and no table existed while it looked: one landing there declines.
  const arms = new Set([...out.values()].flatMap((jt) => [...jt.caseAddrs, jt.defaultAddr]));
  for (const [addr, jt] of out) {
    if (jt.entry !== null && arms.has(jt.entry)) {
      out.delete(addr);
    }
  }
  return out;
}

// BRANCH-LIKELY → the ordinary branch that tests the same way, in place, returning the addresses
// rewritten. The mnemonic is all that differs in the COMPARISON; what differs in the FLOW is the
// delay slot, which `toBlocks` then places on the taken edge alone.
//
// Refuses, by name, every shape that placement cannot model. A nullified slot read as an ordinary
// always-executed one is not a cosmetic error: `absi` would return `-x` for every `x >= 0`, and a
// store in such a slot would be performed on a path that never performs it. That is C which
// compiles and is wrong — strictly worse than the decline it would replace.
function normaliseBranchLikely(name: string, instrs: Instr[], startAddr: number): Set<number> {
  const likely = instrs.filter((ins) => ins.mnemonic in LIKELY_BASE);
  if (likely.length === 0) {
    return new Set();
  }
  const refusal = (ins: Instr, why: string) =>
    new FrontendUnsupportedError(
      `cannot lift '${name}': branch-likely '${ins.mnemonic}' at 0x${ins.addr.toString(16)} — ${why}`,
    );
  // Every address this function branches to, the likely branches' own targets included: one that
  // jumps to its OWN slot is the same hazard as some other branch landing there. A recovered jump
  // table's arms are not in here — they do not exist until `recoverMipsJumpTables` has run, so
  // `lift` checks them against the slot addresses this returns.
  const targets = new Set(instrs.map((ins) => ins.target).filter((t): t is number => t !== undefined));
  // BY ADDRESS, never by array position: reading a branch's array NEIGHBOUR as its delay slot puts
  // an arm the function always runs onto the taken edge of a branch that never guarded it, which is
  // C that compiles and is wrong. The two readings agree only while the list has a word per
  // address, which is what `parseDisasm` guarantees by refusing a listing it cannot account for.
  const at = new Map(instrs.map((ins) => [ins.addr, ins]));
  const hex = (a: number) => `0x${a.toString(16)}`;
  const rewritten = new Set<number>();
  for (const br of likely) {
    const slot = at.get(br.addr + 4);
    const fallThrough = at.get(br.addr + 8);
    const prev = at.get(br.addr - 4);
    if (br.target === undefined) {
      throw refusal(br, 'the branch target is not a resolved address');
    }
    if (slot === undefined) {
      throw refusal(br, `the disassembly has no instruction at ${hex(br.addr + 4)} to be its delay slot`);
    }
    if (fallThrough === undefined) {
      throw refusal(br, `the disassembly has no instruction at ${hex(br.addr + 8)} for the not-taken edge to land on`);
    }
    if (prev === undefined && br.addr !== startAddr) {
      // WHAT PRECEDES IT DECIDES WHETHER IT MAY BE PLACED AT ALL, so an unreadable predecessor is
      // not a detail to shrug at: a likely branch sitting in some transfer's delay slot has no
      // block of its own to put a slot in. The function's own first word is the one address with
      // nothing before it, and that is read off the objdump HEADER — not off the first line
      // parsed, which is the same thing only when the listing spells that word.
      throw refusal(br, `the disassembly has no instruction at ${hex(br.addr - 4)}, so what precedes it is unknown`);
    }
    if (prev !== undefined && isControlTransfer(prev)) {
      throw refusal(br, `it sits in the delay slot of '${prev.mnemonic}', so its own slot has no block to live in`);
    }
    if (isControlTransfer(slot)) {
      throw refusal(
        br,
        `the delay slot is itself a control transfer ('${slot.mnemonic}'), which the ISA leaves undefined`,
      );
    }
    // The slot's block is entered ONLY by this branch's taken edge. Anything else arriving there
    // would run the slot with no branch conditioning it, and then take the branch's target.
    if (targets.has(slot.addr)) {
      throw refusal(br, 'another branch targets the delay slot, which would run it unconditioned');
    }
    br.mnemonic = LIKELY_BASE[br.mnemonic];
    rewritten.add(br.addr);
  }
  return rewritten;
}

// EVERY control transfer this frontend models has a delay slot — the word at `branch + 4`, which
// runs after it — and every conditional branch's not-taken edge lands on the word at `branch + 8`.
// `toBlocks` places both, so a listing that does not spell them refuses here rather than there:
// with the word missing, the slot would be taken from whatever came next and the not-taken edge
// would silently lose its successor. A branch-LIKELY asks the same two questions in its own words,
// before the rewrite, because for it they decide conditional execution rather than placement.
function checkDelaySlots(name: string, instrs: Instr[]): void {
  const at = new Set(instrs.map((ins) => ins.addr));
  const hex = (a: number) => `0x${a.toString(16)}`;
  for (const ins of instrs) {
    if (!isXfer(ins)) {
      continue;
    }
    if (!at.has(ins.addr + 4)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': '${ins.mnemonic}' at ${hex(ins.addr)} — the disassembly has no ` +
          `instruction at ${hex(ins.addr + 4)} to be its delay slot`,
      );
    }
    if (isCond(ins) && !at.has(ins.addr + 8)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': '${ins.mnemonic}' at ${hex(ins.addr)} — the disassembly has no ` +
          `instruction at ${hex(ins.addr + 8)} for the not-taken edge to land on`,
      );
    }
  }
}

/** WHETHER THE RETURN ENDING BLOCK `bi` MAY HAND BACK A 64-BIT PAIR, read off the asm: O32 returns
 *  one in v0:v1, the low word in v1, and v1 is also ordinary scratch, so the question is what each
 *  write of v1 that reaches the return was made for. Two answers say "the low word":
 *
 *  - NOTHING IN THE FUNCTION READS IT, on any path from it. An optimising compiler computes no
 *    dead value, so a write no instruction reads is one the caller reads (`lw v0,16(sp);
 *    lw v1,20(sp)` for `return e;`, `mflo v1` for a product). A loop's induction update is read
 *    round the back edge, and a value one arm of a branch reads is read, so neither counts.
 *  - IT IS AN `addu`/`addiu` WHOSE SUM IS COMPARED, unsigned, against what it added: the carry out
 *    of a 64-bit add's low word into its high one (`addu v1,a3,a0; sltu t,v1,a0`, `addiu v1,a1,5;
 *    sltiu t,v1,5`). A pointer bound check compares the sum against something else (`addu v1,a1,a0;
 *    sltu v0,v0,v1`). A function that computes a carry and returns only the high word is declined
 *    with the pairs — loud, and the price of one rule.
 *  - IT IS A COPY OF A REGISTER THAT STILL HOLDS THE SAME VALUE wherever v1 is read: the reads
 *    could have named the source, so the copy is made for the caller (`move v1,a3; jr ra;
 *    sw v1,4(a0)` for `*p = x; return x;`). A copy made because its source is about to be
 *    overwritten (a swap, a pointer bumped after its old value is kept), or read past a join, is
 *    scratch.
 *
 *  A call ends a path either way: it destroys v1 (`clobberedByCall`), and its delay slot runs
 *  before it. The entry ends the backward walk, since what v1 held there is no value this
 *  function computed. */
function v1MayHoldLowWord(blocks: readonly MipsBlock[], preds: readonly (readonly number[])[], bi: number): boolean {
  const readsV1 = (ins: Instr) => {
    const dest = writtenReg(ins) !== null && writtenReg(ins) === ins.ops[0];
    return ins.ops.some((o, k) => !(dest && k === 0) && (o === 'v1' || /\(v1\)$/.test(o)));
  };
  // Each block in execution order: a call's delay slot runs before the call.
  const runs = blocks.map((b) => {
    const seq = [...b.body, ...(b.branch ? [b.branch] : []), ...(b.delay ? [b.delay] : [])];
    for (let k = 0; k + 1 < seq.length; k++) {
      if (isCallInstr(seq[k])) {
        [seq[k], seq[k + 1]] = [seq[k + 1], seq[k]];
        k++;
      }
    }
    return seq;
  });
  const succs = blocks.map((): number[] => []);
  preds.forEach((ps, to) => ps.forEach((from) => succs[from].push(to)));
  // What follows the write at `runs[at][k]` on every path, up to a call or the next write of v1:
  // the instructions that read it, and whether register `src` is written meanwhile.
  const after = (at: number, k: number, src: string | undefined) => {
    const readers: Instr[] = [];
    let srcWritten = false;
    const seen = new Set<number>();
    const from = (blk: number, start: number) => {
      for (const ins of runs[blk].slice(start)) {
        if (readsV1(ins)) {
          readers.push(ins);
        }
        if (isCallInstr(ins) || writtenReg(ins) === 'v1') {
          return;
        }
        srcWritten ||= src !== undefined && writtenReg(ins) === src;
      }
      for (const n of succs[blk]) {
        if (!seen.has(n)) {
          seen.add(n);
          from(n, 0);
        }
      }
    };
    from(at, k + 1);
    return { readers, srcWritten };
  };
  const lowWord = (at: number, k: number): boolean => {
    const ins = runs[at][k];
    const [, x, y] = ins.ops;
    // A register copy's source, unless that is zero (a constant).
    const copied = copiedReg(ins);
    const src = copied === undefined || isZero(copied) ? undefined : copied;
    const { readers, srcWritten } = after(at, k, src);
    // The carry compares the sum against what was added: `sltu t,v1,X` for `addu v1,X,Y` (either
    // addend other than v1 itself), `sltiu t,v1,k` for `addiu v1,X,k`.
    const carries = (r: Instr) =>
      r.ops[1] === 'v1' &&
      ((ins.mnemonic === 'addu' && r.mnemonic === 'sltu' && r.ops[2] !== 'v1' && [x, y].includes(r.ops[2])) ||
        (ins.mnemonic === 'addiu' && r.mnemonic === 'sltiu' && parseImm(r.ops[2] ?? '') === parseImm(y ?? '')));
    // A copy is judged only where its every read follows it in its own block: a read past a join
    // is where a compiler coalesces each arm's value into one register (`addu v1,a1,zero` on one
    // arm, `ori v1,a1,0xe000` on the other), which is scratch.
    const local = readers.every((r) => runs[at].indexOf(r) > k);
    return readers.length === 0 || readers.some(carries) || (src !== undefined && !srcWritten && local);
  };
  // Every write of v1 that reaches the end of `bi`, walking back.
  const seen = new Set<number>();
  const back = (at: number, end: number): boolean => {
    for (let k = end - 1; k >= 0; k--) {
      const ins = runs[at][k];
      if (isCallInstr(ins)) {
        return false;
      }
      if (writtenReg(ins) === 'v1') {
        return lowWord(at, k);
      }
    }
    return preds[at].some((p) => !seen.has(p) && (seen.add(p), back(p, runs[p].length)));
  };
  return back(bi, runs[bi].length);
}

/** THE FRAME DEPTH AT EACH INSTRUCTION: how many bytes below the `sp` the function was entered
 *  with it runs, so an `off(sp)` it makes names entry-relative byte `off - depth`. Exact or absent —
 *  null wherever one number per instruction is not proven, and every reader then keeps its refusal.
 *
 *  Proven for the frame every compiler here builds: at most one `addiu sp,sp,-N`, in the entry
 *  block (anywhere in it, IDO's leaves load before they push), and `addiu sp,sp,N` only in a block
 *  that returns, after which the block runs at depth 0. The entry runs from depth 0 and every other
 *  block from N, which holds because the entry runs once and every other block is reached through
 *  it. Refused: any other write to `sp`, a second push, a push outside the entry or in an entry a
 *  branch re-enters (the preheader's case), a pop of another size or in a block that does not
 *  return. */
function frameDepths(blocks: readonly MipsBlock[], entryReentered: boolean): ReadonlyMap<Instr, number> | null {
  const depths = new Map<Instr, number>();
  const adjust = (ins: Instr): number | null | undefined => {
    if (!isStackPtr(writtenReg(ins) ?? '')) {
      return undefined; // leaves sp alone
    }
    const by = parseImm(ins.ops[2] ?? '');
    return (ins.mnemonic === 'addiu' || ins.mnemonic === 'addi') && isStackPtr(ins.ops[1] ?? '') && Number.isFinite(by)
      ? by
      : null;
  };
  const pushes = blocks.flatMap((b) => [...b.body, ...(b.delay ? [b.delay] : [])]).filter((i) => (adjust(i) ?? 0) < 0);
  if (pushes.length > 1) {
    return null;
  }
  const size = pushes.length === 1 ? -adjust(pushes[0])! : 0;
  for (const [bi, b] of blocks.entries()) {
    let depth = bi === 0 ? 0 : size;
    for (const ins of [...b.body, ...(b.delay ? [b.delay] : [])]) {
      depths.set(ins, depth);
      const by = adjust(ins);
      if (by === undefined) {
        continue;
      }
      if (by === null) {
        return null;
      }
      if (by < 0 && (bi !== 0 || entryReentered || depth !== 0)) {
        return null;
      }
      if (by > 0 && (by !== depth || b.branch === null || !isReturn(b.branch))) {
        return null;
      }
      depth -= by;
    }
  }
  return depths;
}

// Split the instruction stream into basic blocks. Delay slots are consumed into their
// branching block; leaders are the entry, every branch target, and each conditional branch's
// fall-through. A branch-LIKELY's slot is not consumed — it becomes its own block (see
// `normaliseBranchLikely`). Unreachable trailing blocks (padding `nop`s) are dropped.
function toBlocks(
  instrs: Instr[],
  jts: Map<number, MipsJT>,
  likelyAddrs: Set<number>,
): { blocks: MipsBlock[]; succAddrs: Map<MipsBlock, number[]> } {
  // BY ADDRESS, never by array position — the placement rule is the same one `normaliseBranchLikely`
  // states, and `checkDelaySlots` has already refused every transfer whose words are not there.
  const at = new Map(instrs.map((ins) => [ins.addr, ins]));
  const consumed = new Set<number>();
  for (const ins of instrs) {
    if (isXfer(ins) && !likelyAddrs.has(ins.addr)) {
      consumed.add(ins.addr + 4);
    }
  }

  const leaders = new Set<number>(instrs.length ? [instrs[0].addr] : []);
  for (const ins of instrs) {
    if ((isCond(ins) || isUncond(ins)) && ins.target !== undefined) {
      leaders.add(ins.target);
    }
    if (isCond(ins)) {
      leaders.add(ins.addr + 8);
    } // fall-through: past the branch and its slot
    if (likelyAddrs.has(ins.addr)) {
      leaders.add(ins.addr + 4);
    } // the nullified slot's own block
  }
  // A recovered jump table makes its case + default targets leaders (the bounds block's `switch_br`
  // successors); the dispatch block then becomes unreachable and is pruned below.
  for (const jt of jts.values()) {
    for (const a of jt.caseAddrs) {
      leaders.add(a);
    }
    leaders.add(jt.defaultAddr);
  }

  const blocks: MipsBlock[] = [];
  // Where a nullified slot's block goes once the slot has run: its branch's target.
  const slotGoto = new Map<number, number>();
  let cur: MipsBlock | null = null;
  for (const ins of instrs) {
    if (consumed.has(ins.addr)) {
      continue;
    } // delay slot: handled with its branch
    if (cur === null || leaders.has(ins.addr)) {
      cur = { startAddr: ins.addr, body: [], branch: null, delay: null, delayAnnulled: false };
      blocks.push(cur);
    }
    if (isXfer(ins)) {
      cur.branch = ins;
      if (likelyAddrs.has(ins.addr)) {
        cur.delayAnnulled = true;
        slotGoto.set(ins.addr + 4, ins.target!);
      } else {
        cur.delay = at.get(ins.addr + 4) ?? null;
      }
      cur = null;
    } else {
      cur.body.push(ins);
    }
  }

  // Successor addresses per block (before reachability pruning).
  const succAddrs = new Map<MipsBlock, number[]>();
  for (const b of blocks) {
    const goto = slotGoto.get(b.startAddr);
    if (goto !== undefined) {
      succAddrs.set(b, [goto]);
      continue;
    } // a nullified slot's block: run the slot, then take the branch
    const br = b.branch;
    const jt = br ? jts.get(br.addr) : undefined;
    if (jt) {
      succAddrs.set(b, [...jt.caseAddrs, jt.defaultAddr]);
      continue;
    } // switch_br dispatcher
    if (!br) {
      const lastBody = b.body[b.body.length - 1];
      succAddrs.set(b, lastBody ? [lastBody.addr + 4] : []); // fall into next block
    } else if (isReturn(br)) {
      succAddrs.set(b, []);
    } else if (isUncond(br)) {
      succAddrs.set(b, br.target !== undefined ? [br.target] : []);
    } else if (b.delayAnnulled) {
      // branch-likely: TAKEN runs the nullified slot's block, NOT-TAKEN skips straight past it
      succAddrs.set(b, [br.addr + 4, br.addr + 8]);
    } else {
      const fall = br.addr + 8; // past the branch and its delay slot
      succAddrs.set(b, br.target !== undefined ? [br.target, fall] : [fall]);
    }
  }

  // Keep only blocks reachable from the entry (drops trailing padding blocks).
  const byAddr = new Map(blocks.map((b) => [b.startAddr, b]));
  const reachable = new Set<MipsBlock>();
  const queue: MipsBlock[] = blocks.length ? [blocks[0]] : [];
  while (queue.length) {
    const b = queue.pop()!;
    if (reachable.has(b)) {
      continue;
    }
    reachable.add(b);
    for (const a of succAddrs.get(b)!) {
      const nb = byAddr.get(a);
      if (nb) {
        queue.push(nb);
      }
    }
  }
  return { blocks: blocks.filter((b) => reachable.has(b)), succAddrs };
}

/** Lift disassembled MIPS text → an L1 Fn with block-argument SSA. `prototypes` declares each
 *  callee's arity (`frontend/call-plan.ts`).
 *
 *  AT MOST TWICE, as on Thumb (`frontend/frame-objects.ts` `liftWithRelift`): where the frame-object audit answers
 *  that a callee may write the local area without bound, or that nothing escapes and the per-object
 *  model does not describe it, it asks for the area kept as one object, and the second lift's audit
 *  judges it so and refuses rather than asking again. */
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
    liftOnce(name, asm, target, prototypes, asmData, symbols, context, oneObject),
  );
}

function liftOnce(
  name: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  asmData: AsmData | undefined,
  symbols: SymbolMap | undefined,
  context: ContextGlobals | undefined,
  oneObject: FrameRange | undefined,
): Fn | FrameObjectRelift {
  // Two input dialects reach this frontend: `objdump -d` text (IDO/KMC — no compiler-emitted asm),
  // and Splat-disassembled `.s` (pmret-style N64 projects). Splat is normalised to the SAME
  // DisasmInstr[] shape (frontend/splat.ts) so everything below is dialect-agnostic.
  const splat = isSplatMips(asm);
  if (!splat) {
    assertInputFormat('mips', 'objdump', asm);
  }
  // ONE function only — an absent symbol declines loud (either dialect's slicer enforces this).
  const sliced = splat ? asm : sliceSymbol(asm, name);
  const instrs = splat ? parseSplatMips(asm, name) : parseDisasm(sliced);
  if (instrs.length === 0) {
    throw new FrontendUnsupportedError(`cannot lift '${name}': no instructions found in the input text`);
  }
  // Headerless input — a raw fragment, and every Splat listing — says where the function starts
  // only by its first line.
  const startAddr = (splat ? undefined : symbolStart(sliced)) ?? instrs[0].addr;
  // An FP condition-code branch is a DIFFERENT gap from a branch-likely, and saying so is what lets
  // each be worked on alone: `bc1fl` is both, and the condition code blocks it either way. Asked
  // FIRST, before the likely rewrite, so that a function carrying both reports the FP gap rather
  // than whatever the likely placement happens to say about the other branch.
  for (const ins of instrs) {
    if (isFpCondBranch(ins.mnemonic)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': floating-point condition-code branch '${ins.mnemonic}' at 0x${ins.addr.toString(16)} ` +
          `— the FP condition code is not modelled`,
      );
    }
  }
  // BRANCH-LIKELY is rewritten to its ordinary branch FIRST, so everything downstream — jump-table
  // recovery's block-boundary walk included — sees one branch vocabulary. What stays special is the
  // slot, and `toBlocks` is where that is placed.
  const likelyAddrs = normaliseBranchLikely(name, instrs, startAddr);
  // Regime B: recover jump tables from the `jr`-dispatch idiom + the AsmData table. A recovered
  // dispatch's `jr` is subsumed into a `switch_br` (emitted from its bounds block), so it is
  // exempted from the loud-fail below; an UNrecovered `jr <non-ra>` still fails loud.
  const jts = asmData ? recoverMipsJumpTables(instrs, asmData, likelyAddrs) : new Map<number, MipsJT>();
  const recoveredJr = new Set([...jts.values()].map((j) => j.jrAddr));
  // THE TWO WAYS A RECOVERED TABLE MEETS AN ANNULLED SLOT, neither of which `normaliseBranchLikely`
  // can see: the table does not exist while it runs. (1) The dispatch's bounds branch emits a
  // `switch_br`, which runs its delay slot unconditionally — a nullified slot is not that. (2) An
  // arm of the table lands ON a nullified slot, which would run the slot with no branch
  // conditioning it and then jump to that branch's target: `case 1:` would take the taken arm's
  // value where the hardware runs the slot and falls on through. Neither idiom has ever been seen
  // in the corpus; refuse rather than answer either one wrong.
  const jtArms = new Set([...jts.values()].flatMap((jt) => [...jt.caseAddrs, jt.defaultAddr]));
  for (const addr of likelyAddrs) {
    if (jts.has(addr)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': branch-likely at 0x${addr.toString(16)} — a recovered switch's bounds branch cannot annul its delay slot`,
      );
    }
    if (jtArms.has(addr + 4)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': branch-likely at 0x${addr.toString(16)} — a recovered switch arm lands on its delay slot, which would run it unconditioned`,
      );
    }
  }
  // Carry the object's relocations on the instructions they fill (objdump dialect only — Splat
  // text spells the halves and writes its own records). Runs AFTER jump-table recovery, so that
  // reads `.text` relocs pristine and a recovered table base is decided before any of this.
  if (!splat && asmData) {
    attachMipsRelocs(name, instrs, asmData);
  }
  // TRUSTWORTHINESS: fail LOUD on a control transfer this frontend cannot model — the `opaque`
  // path cannot catch these (implicit or no register destination). A `jalr` clobbers `v0`
  // implicitly, so dropping it fabricates `v0` from a stale value, and the callee it reaches is a
  // register's value; a `jr` to anything but `ra` (jump table / computed goto) is not a plain
  // return. `jal` is lowered where its block is filled (`lowerJal`).
  for (const ins of instrs) {
    if (ins.mnemonic === 'jalr') {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': function call '${ins.mnemonic}' at 0x${ins.addr.toString(16)} — MIPS calls not yet modelled`,
      );
    }
    // A `j` relocated against a symbol leaves this section's code for another function's, which is
    // a tail call; the target objdump prints is the field, not the address.
    if (ins.mnemonic === 'j' && ins.reloc !== undefined && !ins.reloc.sym.startsWith('.')) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': 'j' at 0x${ins.addr.toString(16)} jumps to '${ins.reloc.sym}' — a tail call into ` +
          'another function is not modelled',
      );
    }
    if (ins.mnemonic === 'jr' && ins.ops[0] !== 'ra' && !recoveredJr.has(ins.addr)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': indirect jump 'jr ${ins.ops[0] ?? ''}' at 0x${ins.addr.toString(16)} — jump tables / tail calls not supported`,
      );
    }
    // CATCH-ALL (mirrors the PPC denylist): an unmodelled control-transfer mnemonic would otherwise
    // fall through to `emitOpaqueDest` and have its BRANCH silently dropped (no register dest for
    // the opaque guard to catch). `break` is a trap, not a branch.
    if (isControlTransfer(ins) && !isXfer(ins) && ins.mnemonic !== 'jal' && ins.mnemonic !== 'jalr') {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': unmodelled control transfer '${ins.mnemonic}' at 0x${ins.addr.toString(16)} ` +
          `— not a modelled branch form`,
      );
    }
  }
  checkDelaySlots(name, instrs);
  const { blocks, succAddrs } = toBlocks(instrs, jts, likelyAddrs);
  // `isReturn` reads every surviving non-`ra` `jr` as a return, which holds only while each
  // recovered dispatch's block is pruned (frontend/jump-table.ts).
  refuseReachableDispatch(name, blocks, recoveredJr, (m) => {
    throw new FrontendUnsupportedError(m);
  });
  // PREHEADER, as in frontend/ppc.ts: an entry that is a branch target gets an empty block ahead of
  // it, whose live-ins are the function's parameters. One word below the function, so it falls
  // through to it.
  const entryReentered = blocks.some((b) => succAddrs.get(b)!.includes(blocks[0].startAddr));
  if (entryReentered) {
    const ph: MipsBlock = {
      startAddr: blocks[0].startAddr - 4,
      body: [],
      branch: null,
      delay: null,
      delayAnnulled: false,
    };
    succAddrs.set(ph, [blocks[0].startAddr]);
    blocks.unshift(ph);
  }
  const idxOf = new Map(blocks.map((b, i) => [b.startAddr, i]));

  // CFG predecessors by block index.
  const preds: number[][] = blocks.map(() => []);
  blocks.forEach((b, i) => {
    for (const a of succAddrs.get(b)!) {
      const j = idxOf.get(a);
      if (j !== undefined) {
        preds[j].push(i);
      }
    }
  });

  // THE SLOT MODEL CLAIMS ONE PARTITION, `ownedLocals` (`ownedFrame`, below): a def-less read of a
  // word this function provably owns is an uninitialised local, and any other def-less slot read
  // refuses (frontend/ssa.ts, LiveInModel) unless `emitLoad` places it. It declares no
  // `declaredLocals`, so no slot is stamped a declaration rank. A slot key is the RAW `sp@<off>`; what the offset
  // names is read through the frame depth (`frameDepths`, below): a word at or past entry + 16 is
  // incoming stack argument k, read and written as `@sarg<k>` (`incomingStackKey`; O32's `<pentry
  // offset="16">` in `mips32be.cspec`), and `[0,16)` at entry is the caller-owned home of a0..a3,
  // which is in neither range. A function that takes a frame address gets a local area as well
  // (`measureO32Frame`, `compilerBehaviors.o32LocalArea`), whose accesses are memory through an
  // `laddr` the shared frame-object audit proves, as on Thumb.
  //
  // THE REGISTER HALF of the live-in model IS claimed: a def-less read of a register O32 passes no
  // argument in, and that is scratch or the prologue saved (`prologueSavedRegs`), is an
  // uninitialised local (`registerLiveIns`, frontend/ssa.ts, as on Thumb and PPC). The saves are
  // measured HERE, before any block is lowered, because the builder evaluates the model once, at
  // its first use, while `saveSlots` below fills progressively.
  const fpType = fpPrecision(instrs, (m) => FP_ARITH[m]?.width);
  const savedRegs = prologueSavedRegs([...blocks[0].body, ...(blocks[0].delay ? [blocks[0].delay] : [])], target);
  // The frame half is measured further down (`ownedFrame`), once the frame depths are; a model the
  // builder asks for before that claims no frame, which only refuses more.
  let ownedFrameOf: (() => { from: number; to: number } | undefined) | undefined;
  const ssa = makeSsaBuilder(
    name,
    blocks.length,
    preds,
    () => {
      const owned = ownedFrameOf?.();
      return { ...registerLiveIns(target, savedRegs), ...(owned === undefined ? {} : { ownedLocals: owned }) };
    },
    (k) => (isFpKey(k) ? (fpType ?? T.f32()) : undefined),
  );
  const { irBlocks, readVar, writeVar, paramReg } = ssa;
  const RET = target.returnReg;
  // Whether this function's own declaration says its return fits one word (`v1MayHoldLowWord`):
  // void, or a scalar or pointer no wider than 32 bits. An aggregate says nothing here. A declared
  // WIDER return is refused for every frontend after the lift (pipeline.ts
  // `refuseNarrowReturnsOfWideDeclaration`), so this only clears the asm rule, never requires it.
  const own = prototypes[name];
  const ownWidth = ownReturnWidth(own);
  const ownReturnFitsAWord = declaresVoidReturn(own) || (ownWidth !== undefined && ownWidth <= 32);
  const ARG_REGS = target.argRegs;
  const fpu = target.fpu;
  const floatReturn = writesFloatReturn(
    blocks.flatMap((b) => (b.delay ? [...b.body, b.delay] : b.body)),
    FP_ARITH_MNEMONICS,
    mipsEvenFpKey,
    fpu,
  );

  // The pending `%hi` halves of this function's global addresses, keyed by the SSA VALUE each `lui`
  // defines (frontend/high-half.ts holds the invariant and why a register-keyed map cannot answer
  // the question; frontend/ppc.ts folds the same one). FUNCTION-scoped, because a value is: a pair
  // split across blocks folds when SSA says the half reaches, and refuses when what arrives is the
  // block parameter standing for a merge.
  /** This frontend's refusal, for the shared code that refuses on its behalf. */
  const fail: FrontendRefusal = (message) => {
    throw new FrontendUnsupportedError(message);
  };
  const highHalves = makeHighHalves({ hi: '%hi', hiArticle: 'a', lo: '%lo', fail });
  /** The jump-table bases a recovered dispatch reads from outside its own block — the `%lo` that
   *  completes one defines no value but the base (frontend/jump-table.ts). */
  const tableBases = makeTableBases(
    [...jts.values()].flatMap((j) => (j.hoisted ? [j.hoisted] : [])),
    fail,
  );
  /** What this frontend defines registers with that is no argument: a pending `%hi` half and a
   *  table base. */
  const placeholders = {
    has: (v: Value) => highHalves.has(v) || tableBases.has(v),
    guardRead: (n: string, r: string, v: Value) => tableBases.guardRead(n, r, highHalves.guardRead(n, r, v)),
  };
  // O32 passes the words past a0..a3 on the stack and returns a word in v0. This lowering builds no
  // register pair and receives no struct through a hidden pointer, so the plan refuses both. A call
  // through an argument register bounds no arity here: a leading float leaves a0 free.
  const calls = callDeclarations(
    name,
    target,
    prototypes,
    { pairs: false, memoryReturn: false, stackArgs: true, voidReturn: true, argRegisterBoundsArity: false },
    fail,
  );
  // The first instruction naming the FPU's file, a data register or the control register. A call
  // in a function that has one refuses: which floating-point registers a callee reads, returns in
  // and destroys is not modelled. A float that crosses the call untouched in $f12 or $f0 names no
  // register here, so only the callee's declaration shows it (`plan`).
  const fpuInstr = instrs.find(
    (ins) => /^(cfc1|ctc1)$/i.test(ins.mnemonic) || ins.ops.some((o) => MIPS_FP_REG.test(o)),
  );

  // THE FRAME A CALL'S STACK ARGUMENTS ARE STAGED IN: the bytes one `addiu sp,sp,-N` pushed. Its
  // outgoing area is `[16, N)`; a word at or above N is this function's own incoming home area, which
  // IDO stores a0..a3 to, so it is never an argument of a call made here. Undefined where the
  // function pushes no frame or more than one.
  const pushes = instrs.filter(
    (ins) =>
      (ins.mnemonic === 'addiu' || ins.mnemonic === 'addi') &&
      isStackPtr(ins.ops[0]) &&
      isStackPtr(ins.ops[1] ?? '') &&
      parseImm(ins.ops[2] ?? '') < 0,
  );
  const frameSize = pushes.length === 1 ? -parseImm(pushes[0].ops[2]) : undefined;
  const depthAt = frameDepths(blocks, entryReentered);
  // AN INCOMING STACK WORD HAS ONE NAME, `@sarg<k>`, for its loads AND its stores: O32 passes
  // argument word k >= 4 at entry sp + 16 + 4(k-4), above the caller's 16-byte home of a0..a3, and
  // a word slot there is keyed by that entry-relative position (`frameDepths`), never by the raw
  // `sp@<off>` of the depth it was reached at. A function that assigns to its stack parameter (IDO
  // stores it back in place: `if (a) e = b;` is `beqz a0; sw a1,40(sp)`) is then the same SSA
  // variable as one that assigns to a register parameter: a read no store reaches is the caller's
  // argument through the ordinary live-in path, and one a store reaches on some paths is the merge
  // of the two. The store keeps no memory effect, which is sound because nothing else reads the
  // word: the caller never reads its outgoing area back (`compilerBehaviors` on all three O32
  // compilers, measured), a sub-word or FPU access to it turns the slot model off or refuses
  // (`spSlotSafe`, the FP arm), and taking its address refuses (it is outside the local area).
  // Undefined for every other word, and wherever the depth walk could not measure the frame.
  const incomingStackKey = (ins: Instr, off: number): string | undefined => {
    const depth = depthAt?.get(ins);
    const entryOff = depth === undefined ? undefined : off - depth;
    return entryOff === undefined ? undefined : incomingStackArgKey(entryOff, STACK_ARGS_AT, ARG_REGS.length);
  };

  // THE FRAME'S SAVES. A word store of `ra`, or of a register O32 does not let a callee destroy,
  // made while the register still holds what the caller left in it, is a SAVE: the word holds the
  // caller's value, which no C value names, so the store mints no parameter. The reload into the
  // same register is the restore, and what it writes refuses any use, as a `%hi` half does: a read
  // at once, a use reached through a merge once the function is built. A reload into another
  // register refuses. Every other word store is a VALUE slot, and a slot is one kind for the whole
  // function. Keyed by the raw `sp` offset, as every slot here is, so a prologue save matches an
  // epilogue restore in any block.
  const saveSlots = new Map<number, string>();
  const valueSlots = new Set<number>();
  const restores = new Map<Value, { reg: string; addr: number }>();
  // A `$`-spelt operand is an FPU register or a bare number, and the target's list names neither.
  const savedByCallee = (r: string) =>
    r === 'ra' || (!r.startsWith('$') && !target.callerSaved.includes(r) && !['zero', 'sp', 'gp'].includes(r));
  const refuseMixedSlot = (ins: Instr, mem: string, off: number, kind: 'save' | 'value') => {
    if (kind === 'save' ? valueSlots.has(off) : saveSlots.has(off)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': local stack frames not supported — '${mem}' at 0x${ins.addr.toString(16)} ` +
          `is a word this function both saves a register in and stores a value to`,
      );
    }
  };

  // THE LOCAL AREA, where a function takes a frame address (`measureO32Frame`): every `off(sp)`
  // access inside it is MEMORY, read and written through an `laddr` the frame-object audit then
  // proves, and every one outside it keeps the slot model below. Null where no frame address is
  // taken, or the frame is one this cannot partition, and then every capture keeps the
  // sp-as-data refusal.
  const code = blocks.flatMap((b) => [...b.body, ...(b.delay ? [b.delay] : [])]);
  /** The stack words a `jal`'s callee takes, by its declaration; null where nothing declares it. */
  const stackWordsOf = (callee: string | undefined): number | null => {
    const declared = callee === undefined ? null : calls.declaredCall(callee);
    return declared === null ? null : Math.max(0, wordsOf(declared.widths, target) - ARG_REGS.length);
  };
  const frame = measureO32Frame({
    name,
    code,
    entry: [...blocks[0].body, ...(blocks[0].delay ? [blocks[0].delay] : [])],
    depthAt,
    frameSize,
    rule: target.compilerBehaviors.o32LocalArea,
    stackWordsOf,
    savedByCallee,
    splat,
  });
  /** Whether `off(sp)` at `ins` is an access inside the local area, refusing one that straddles its
   *  edge: half memory and half slot is neither. */
  const inLocalArea = (ins: Instr, off: number, width: number): boolean => {
    // The area is in post-push offsets, and `off` is the access's own: before the push (IDO's
    // leaves load first) or after the pop it names the byte `size - depth` higher, so an incoming
    // stack word read at entry as `lw t6,16(sp)` is not the local a later `0(sp)` stores, whatever
    // the raw numbers say. `measureO32Frame` refuses an access at another depth whose TRUE position
    // lies in the area, so one at another depth is never in it.
    if (frame === null || depthAt?.get(ins) !== frame.size) {
      return false;
    }
    if (off >= frame.area.to || off + width <= frame.area.from) {
      return false;
    }
    if (off < frame.area.from || off + width > frame.area.to) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': address-taken stack local — '${ins.mnemonic}' at 0x${ins.addr.toString(16)} reaches across an edge of the ` +
          `local area, sp+${frame.area.from} up to sp+${frame.area.to} — part memory, part slot`,
      );
    }
    return true;
  };

  // SOUNDNESS GUARD. The word stack-slot model (emitLoad/emitStore) is safe ONLY when every
  // sp-relative access it keys is word-width. If a SUB-WORD sp access aliases a word slot
  // (`sw a0,4(sp)` then `lbu v0,4(sp)`), routing the word store to an SSA slot while the sub-word
  // reload stays on the memory path DROPS the store and reads uninitialised memory — a silent
  // miscompile that ALSO masks the struct-overlap loud-fail (raise/structs.ts). So if ANY sub-word
  // sp access exists OUTSIDE the local area, disable slot-modelling for the whole function:
  // everything sp-relative falls back to the memory path, which loud-fails on a genuine overlap
  // instead of miscompiling. One inside it is memory like every access there (`inLocalArea`).
  const spSlotSafe = !code.some((ins) => {
    if (!SUBWORD_MEM.has(ins.mnemonic) || ins.ops.length === 0) {
      return false;
    }
    const { base, off } = parseMem(ins.ops[ins.ops.length - 1]);
    return isStackPtr(base) && !inLocalArea(ins, off, ins.mnemonic.includes('b') ? 1 : 2);
  });

  // THE FRAME HALF of the live-in model (`LiveInModel.ownedLocals`), in the raw `sp@<off>` keys
  // the slot model uses: the words of the one frame this function pushed that it OWNS, so that a
  // def-less read of one is an uninitialised local — IDO homes `int r; if (a > 0) r = a*2;` in
  // `4(sp)` of an 8-byte leaf frame and reads it back on the path that never stored it. A word no
  // store reaches on ANY path is the same local (`uninit_spill` reads `36(sp)` and `0(sp)`, which
  // no instruction stores), as on Thumb (`lowerLoad`).
  //
  // WHAT ELSE COULD HAVE WRITTEN THE WORD is the whole soundness of it, and the claim is made only
  // where the answer is "nothing":
  //   • another function holding a frame address — none is taken (`takesFrameAddress`), so the
  //     frame-object audit has nothing to retract;
  //   • a CALLEE, which O32 lets write the bottom of this frame: it stores its a0..a3 into the
  //     home words `[0,16)` (IDO: `sw a2,40(sp)` in its own frame) and assigns a stack parameter in
  //     place (`compilerBehaviors.localsAboveOutgoingArea`'s probe). So a function that calls owns
  //     only the words past its widest call's outgoing area, `[16 + 4·words, frameSize)`, and one
  //     whose callee no declaration sizes claims nothing. A leaf owns the whole frame;
  //   • the same raw offset at ANOTHER depth — the key is the raw offset, so a word reached before
  //     the push or after the pop names other storage under the same spelling. Every `sp` access
  //     must run at the frame's own depth, save the incoming stack words that are keyed `@sarg<k>`.
  // The caller's home `[frameSize, frameSize + 16)` is in no range, so a def-less read there still
  // refuses. Sub-word frame traffic turns the slot model off (`spSlotSafe`) and claims nothing.
  let ownedMemo: { range: { from: number; to: number } | undefined } | undefined;
  const ownedFrame = (): { from: number; to: number } | undefined =>
    (ownedMemo ??= { range: measureOwnedFrame() }).range;
  const measureOwnedFrame = (): { from: number; to: number } | undefined => {
    if (frameSize === undefined || depthAt === null || !spSlotSafe || code.some(takesFrameAddress)) {
      return undefined;
    }
    for (const ins of code) {
      const last = ins.ops[ins.ops.length - 1] ?? '';
      if (!last.includes('(') || !isStackPtr(parseMem(last).base) || depthAt.get(ins) === frameSize) {
        continue;
      }
      if (ins.mnemonic === 'lw' || ins.mnemonic === 'sw') {
        if (incomingStackKey(ins, parseMem(last).off) !== undefined) {
          continue;
        }
      }
      return undefined;
    }
    // A declaration the call lowering cannot carry out refuses THERE, in its own words; measured
    // here first, it claims nothing rather than pre-empting that refusal with another.
    let outgoing: ReturnType<typeof o32OutgoingArea>;
    try {
      outgoing = o32OutgoingArea(code, stackWordsOf, splat);
    } catch (e) {
      if (e instanceof FrontendUnsupportedError) {
        return undefined;
      }
      throw e;
    }
    return outgoing.unsized === undefined && outgoing.end < frameSize
      ? { from: outgoing.end, to: frameSize }
      : undefined;
  };
  ownedFrameOf = ownedFrame;

  // Hardware divide state (capabilities.hwDivide). MIPS `div`/`divu rs,rt` set the hi/lo pair
  // implicitly; a later `mflo`/`mfhi` reads the quotient/remainder. FUNCTION-scoped: GCC schedules
  // the `mflo` into a SEPARATE block after the trap-check branch (`bnez rt; break 7`), so a
  // block-local record would see `null` at the cross-block `mflo` and emit an opaque `?`. The div's
  // operand Values are SSA-global, so consuming them in a later block is sound. A `mult`/`multu`
  // overwrites the same hi/lo pair, so it clears this (below) — whichever divide/multiply ran most
  // recently owns the next `mf*`, the true hardware semantics.
  let divState: { rs: Value; rt: Value; signed: boolean } | null = null;
  // The frame offset each `laddr` this lift emitted names, and the deferred `sp + index` sums
  // (`emitLaddr`, `materialize`) — function-scoped, since a register holding one crosses blocks.
  const laddrAt = new Map<Value, number>();
  const frameSums = new Map<Value, FrameSum>();
  // Every capture this lift moved into another (`addiu rD,rCapture,k` re-minted as the `laddr` of
  // the sum, or `addu` deferring one into a `FrameSum`), handed to the audit as Thumb hands its
  // own: a base only the move read names no object, so the audit drops it rather than judging a
  // dead `laddr` as a capture (`foldMovedCaptures`).
  const movedCaptures = new Set<Value>();

  const fillBlock = (b: MipsBlock, bi: number) => {
    const ops = irBlocks[bi].ops;
    // Materialise the address of a named global — the same `gaddr` op the Thumb frontend emits; the
    // structurer lowers a load/store through it to `SYM` (scalar) or `((T *)&SYM)[i]` (aggregate).
    const emitGaddr = (sym: string): Value => {
      const g = mkValue(T.unk(32));
      ops.push(mkOp('gaddr', { results: [g], attrs: { sym } }));
      return g;
    };
    const read = (r: string): Value => {
      if (isZero(r)) {
        return constVal(0);
      }
      // Reading `sp` as a DATA operand means frame-pointer arithmetic or an address-taken local
      // (`addiu a0,sp,8` = `&local`). Fabricating a value for `sp` invents a PHANTOM leading
      // parameter that shifts every real argument — a silent miscompile. Fail LOUD instead,
      // mirroring the PPC frontend's r1. Frame setup/teardown (`addiu sp,sp,±N`), word spill/reload
      // slots and, where `measureO32Frame` drew a local area, frame captures are handled before `read`.
      if (isStackPtr(r)) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': stack pointer used as data (address-taken local / frame arithmetic) — local stack frames not supported`,
        );
      }
      // `gp` writes (the PIC prologue) are skipped as transparent; a `gp` READ that survives here is a
      // PIC/small-data global access (`lw x,off(gp)`) this frontend does not model — the recovered
      // jump-table dispatch's own `lw …,0(gp)` is elided, so reaching this is a genuine decline, not a
      // switch. Fail LOUD rather than fabricate a phantom `gp` parameter (mirrors the sp guard above).
      if (r === 'gp') {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': gp used as data (PIC / small-data global access) — not supported`,
        );
      }
      // A register holding the high half of an address is NOT a value. The legitimate consumers
      // (`addiu %lo`, a `%lo` load/store base) reach the half through `foldLoHalf` instead.
      const v = readVar(r, bi);
      const sum = frameSums.get(v);
      if (sum !== undefined) {
        return materialize(sum, 0);
      }
      const restore = restores.get(v);
      if (restore) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': ${r} is read after the 'lw' at 0x${restore.addr.toString(16)} restores the ` +
            `caller's ${restore.reg} into it — no C value names it`,
        );
      }
      return placeholders.guardRead(name, r, v);
    };
    // A FRAME ADDRESS AS DATA. `addiu rD,sp,k` and `move rD,sp` name frame offset k, and lower to
    // an `laddr` the frame-object audit proves. `addu rD,sp,rX` — in either operand order — names
    // `sp + rX`, a runtime index from the frame base, and that sum is DEFERRED: the access through
    // it says which object it indexes, since `lw v0,24(v0)` after `addu v0,sp,t6` is `a[i]` on an
    // array at sp+24 (IDO), not at sp+0. So the register holds a `FrameSum`, and each use builds
    // `laddr(base + displacement) + index` there — an access at its displacement, any other use at
    // 0. A capture or sum moved by a constant is the same capture at the sum. Where a frame address
    // lies against the local area is the shared audit's to judge (`FRAME_OBJECT_AUDIT`,
    // frontend/frame-objects.ts `frameObjects`), as on Thumb: below it or above it refuses.
    const emitLaddr = (k: number): Value => {
      const v = mkValue(T.unk(32));
      ops.push(mkOp('laddr', { results: [v], attrs: { off: k } }));
      laddrAt.set(v, k);
      return v;
    };
    const materialize = (sum: FrameSum, displacement: number): Value => {
      const v = mkValue(T.unk(32));
      ops.push(mkOp('add', { operands: [emitLaddr(sum.base + displacement), sum.index], results: [v] }));
      return v;
    };
    const deferSum = (base: number, index: Value): Value => {
      const v = mkValue(T.unk(32));
      frameSums.set(v, { base, index });
      return v;
    };
    // What a register holds when it may be a frame address, unguarded — `read` then guards and
    // materializes everything else.
    const rawFrame = (r: string | undefined): Value | undefined =>
      frame === null || r === undefined || isZero(r) || isStackPtr(r) || r === 'gp' ? undefined : readVar(r, bi);
    // `slt`-family results, so a following `beqz`/`bnez` can fold into one compare.
    //
    // Keyed by the SSA VALUE the compare produced, never by its register. Keying by register is the
    // bug: `slt v0,a0,a1; xori v0,v0,1; beqz v0,L` (a materialised `a0 >= a1` that a branch then
    // tests — IDO's spelling, and a live benchmark row) redefines v0, and a register-keyed record
    // folds the branch against the DEAD `slt`, silently emitting the INVERTED condition. A value
    // cannot go stale that way: `condValue` resolves the branch's register to whatever value reaches
    // it and looks THAT up, so a redefinition simply misses and the honest `icmp_eq(rX, 0)` is
    // emitted. It also needs no invalidation discipline to be maintained by every future writer —
    // which matters, because `write` is NOT the only path that redefines a register (`lui
    // rD,%hi(SYM)` deliberately reassigns rD's meaning without it).
    const cmpDef = new Map<Value, { opcode: string; lhs: Value; rhs: Value }>();
    const write = (r: string, v: Value) => {
      if (!isZero(r)) {
        writeVar(r, bi, v);
      }
    };
    // Shared emitter kit (frontend/emit.ts) — the ISA-specific readers/guards stay above.
    const kit = mkEmitKit(ops, write);
    const constVal = kit.cnst;
    const emitBin = kit.bin;
    // `divState` (the hardware-divide hi/lo record) is FUNCTION-scoped — see its declaration above
    // the per-block loop. It materializes the typed `sdiv`/`udiv` (lo) or `smod`/`umod` (hi) at the
    // `mf*` that consumes it, so an unused half never emits a dead op.
    // Hardware multiply state: `mult`/`multu rs,rt` (2-operand — BOTH are sources, no register
    // dest) set the hi/lo pair; a following `mflo`/`mfhi` reads the product low/high word. Distinct
    // from the 3-operand MIPS32 pseudo `mul rd,rs,rt` (writes rd directly). Block-local
    // DELIBERATELY (unlike divState): a cross-block `mult`/`mflo` pair has no observed inhabitant,
    // and the miss degrades to a LOUD opaque, never silence.
    let mulState: { rs: Value; rt: Value; signed: boolean } | null = null;
    const emitCmp = (opc: Opcode, d: string, lhs: Value, rhs: Value) => {
      const v = mkValue(T.unk(32));
      ops.push(mkOp(opc, { operands: [lhs, rhs], results: [v] }));
      write(d, v);
      cmpDef.set(v, { opcode: opc, lhs, rhs });
    };

    // Where a refusal about ONE INSTRUCTION starts, spelled as frontend/ppc.ts spells it — the
    // artifact's decline text is read row by row across both ISAs.
    const site = (ins: Instr) => `cannot lift '${name}': '${ins.mnemonic}' at 0x${ins.addr.toString(16)}`;
    // Set by every case entitled to fold a relocation, cleared per instruction, and answered by
    // `relocPlaceholder`.
    let relocTaken = false;
    // EVERY immediate this frontend turns into a value goes through here. objdump prints them as
    // numbers, so a non-numeric one means the operand is not an immediate at all — a relocation
    // spelling the reader failed to resolve, a label — and bare `parseImm` answers NaN, which
    // `constVal` renders as the literal 0. That is the relocation fold's own failure one level
    // down, so it refuses instead.
    const imm = (ins: Instr, text: string | undefined): number => {
      const v = parseImm(text ?? '');
      if (!Number.isFinite(v)) {
        throw new FrontendUnsupportedError(
          `${site(ins)} has the non-numeric ` +
            `immediate '${text ?? ''}' where a number belongs — this frontend will not read it as one`,
        );
      }
      return v;
    };
    const decode = (ins: Instr) => {
      const [d, s, t] = ins.ops;
      relocTaken = false;
      // The GOT/small-data base register `gp` is set up by IDO's PIC prologue (`lui gp; addiu gp,gp,lo;
      // addu gp,gp,t9`, an `_gp_disp` HI16/LO16 pair). It is a RELOCATION base, never program data — and
      // reading `t9` for the `addu` would fabricate a phantom leading parameter (like the sp/r1 guards).
      // Its only real use, the GOT table-base `lw ...,0(gp)` in a jump-table dispatch, is subsumed by the
      // recovered `switch_br` (that block is elided). So a write to `gp` is transparent: skip it.
      if (writtenReg(ins) === 'gp') {
        return;
      }
      switch (ins.mnemonic) {
        case 'nop':
          break;
        case 'move': {
          // pseudo: addu/or rD,rS,zero
          if (frame !== null && isStackPtr(s)) {
            write(d, emitLaddr(0));
            break;
          }
          const raw = rawFrame(s);
          write(d, raw !== undefined && frameSums.has(raw) ? raw : read(s));
          break;
        }
        case 'li':
          write(d, constVal(imm(ins, s)));
          break; // pseudo: load immediate
        // `lui rD, hi` loads the 16-bit immediate into the UPPER half (mirrors PPC `lis`). Alone it
        // is the high half of a 32-bit literal; the following `ori`/`addiu` supplies the low half
        // and raise/const.ts folds the const/const pair into one 32-bit const — the form that
        // recompiles to this exact `lui;ori`.
        case 'lui':
          // `lui rD, %hi(SYM)` is the HIGH HALF of a global's address, so rD is defined as a
          // PLACEHOLDER value rather than a number (frontend/high-half.ts) and the `gaddr` itself
          // is emitted at the `%lo` that completes the address. Being REL, this half contributes
          // `hi_imm << 16` to the addend.
          if (ins.reloc?.type === 'R_MIPS_HI16') {
            relocTaken = true;
            const hi = mkValue(T.unk(32));
            highHalves.record(hi, {
              sym: ins.reloc.sym,
              addend: imm(ins, s ?? '0') << 16,
              addr: ins.addr,
              mnemonic: ins.mnemonic,
            });
            write(d, hi);
            break;
          }
          // `lui rD, 0x0` WITHOUT a relocation is not code any compiler wrote: `lui` of zero
          // writes zero, which `move rD,zero` says in one instruction. What does print it is a
          // relocatable object's UNRELOCATED high half, whose symbol lives in a record this lift
          // was never handed — the side table is optional, and a caller may simply not pass one.
          // Every refusal above covers a relocation that ARRIVED and was dropped; this covers the
          // one that never arrived, so `*(T *)0` is not the answer either way. A non-zero `lui` is
          // a genuine absolute address or literal high half (a linked dump, `lui;ori`).
          if (imm(ins, s) === 0) {
            throw new FrontendUnsupportedError(
              `${site(ins)} loads the high half 0x0 with no relocation on it — that is an ` +
                `unrelocated placeholder, not the value; the object's R_MIPS_HI16/LO16 records were not supplied ` +
                `with this disassembly (pass the object's \`objdump -s -r -t\` side table)`,
            );
          }
          write(d, constVal((imm(ins, s) << 16) >> 0));
          break;
        case 'addiu':
        case 'addi':
          // `addiu sp,sp,±N` is frame setup/teardown — transparent to dataflow (the stack-slot model
          // keys slots by literal sp-offset, so the frame base never needs a value). Skip it,
          // mirroring PPC's `addi r1`. Any OTHER read of sp falls through to `read`, which loud-fails.
          if (isStackPtr(d)) {
            break;
          }
          if (frame !== null && ins.reloc === undefined) {
            if (isStackPtr(s)) {
              write(d, emitLaddr(imm(ins, t)));
              break;
            }
            const raw = rawFrame(s)!;
            const at = raw === undefined ? undefined : laddrAt.get(raw);
            if (at !== undefined) {
              movedCaptures.add(raw!);
              write(d, emitLaddr(at + imm(ins, t)));
              break;
            }
            const sum = raw === undefined ? undefined : frameSums.get(raw);
            if (sum !== undefined) {
              write(d, deferSum(sum.base + imm(ins, t), sum.index));
              break;
            }
          }
          // `addiu rD, rHi, %lo(SYM)` completes a global's address begun by a `lui %hi(SYM)`:
          // rD = &SYM (+ a byte offset into it). Emits the shared `gaddr` op.
          if (ins.reloc?.type === 'R_MIPS_LO16') {
            const at = pairLoHalf(ins, s, imm(ins, t));
            // The base of a jump table a dispatch reads from outside its block is no value but the
            // table base (frontend/jump-table.ts), which only that dispatch may take.
            const table = { sym: ins.reloc.sym, addend: at };
            if (tableBases.wants(table)) {
              const base = mkValue(T.unk(32));
              tableBases.record(base, table, ins.addr);
              write(d, base);
              break;
            }
            const { base: g, off } = addressAt(ins, at);
            // `&SYM` (offset 0), or `&SYM + N` for a byte offset into the global. The `add` tree is
            // folded byte-correctly by memAccess when this address is a load/store base; if it
            // instead ESCAPES as a value, `assertDerefsTyped` declines it (the byte offset would
            // element-scale in C) — see the interior-global-pointer guard there.
            off !== 0 ? emitBin('add', d, g, constVal(off)) : write(d, g);
            break;
          }
          if (isZero(s)) {
            write(d, constVal(imm(ins, t)));
            break;
          } // li idiom
          emitBin('add', d, read(s), constVal(imm(ins, t)));
          break;
        case 'addu':
        case 'add': {
          // `addu rD,sp,zero` is Splat's spelling of objdump's `move rD,sp`: the frame base.
          if (frame !== null && isStackPtr(copiedReg(ins) ?? '')) {
            write(d, emitLaddr(0));
            break;
          }
          if (frame !== null && t !== undefined && isStackPtr(s) !== isStackPtr(t) && !isZero(isStackPtr(s) ? t : s)) {
            write(d, deferSum(0, read(isStackPtr(s) ? t : s)));
            break;
          }
          const [rs, rt] = [rawFrame(s), rawFrame(t)];
          const capturedAt = (v: Value | undefined) => (v === undefined ? undefined : laddrAt.get(v));
          const [cs, ct] = [capturedAt(rs), capturedAt(rt)];
          if ((cs === undefined) !== (ct === undefined)) {
            movedCaptures.add((cs === undefined ? rt : rs)!);
            write(d, deferSum((cs ?? ct)!, read(cs === undefined ? s : t)));
            break;
          }
          emitBin('add', d, read(s), read(t));
          break;
        }
        case 'subu':
        case 'sub':
          emitBin('sub', d, read(s), read(t));
          break;
        case 'mul':
          emitBin('mul', d, read(s), read(t));
          break; // MIPS32 3-operand: rd = rs*rt
        case 'mult':
        case 'multu': // 2-operand: hi/lo = d*s (both sources)
          mulState = { rs: read(d), rt: read(s), signed: ins.mnemonic === 'mult' };
          divState = null;
          break; // overwrites hi/lo
        // Hardware divide: `div zero,rs,rt` (raw two-operand form; `zero` rd = no pseudo mflo).
        // Record the operands; the following mflo/mfhi picks quotient vs remainder. The 3-operand
        // pseudo (`div rd,rs,rt`, rd≠zero) additionally writes the quotient to rd. GATED on
        // `capabilities.hwDivide`: a `div` on a target that declares no hardware divider is a
        // genuine anomaly, so it degrades to a loud `opaque` rather than being silently modelled.
        case 'div':
        case 'divu': {
          if (!target.capabilities.hwDivide) {
            divState = null;
            emitOpaqueDest(ins);
            break;
          }
          const signed = ins.mnemonic === 'div';
          divState = { rs: read(s), rt: read(t), signed };
          if (!isZero(d)) {
            emitBin(signed ? 'sdiv' : 'udiv', d, divState.rs, divState.rt);
          }
          break;
        }
        case 'mflo': // quotient, or product low word
          if (divState) {
            emitBin(divState.signed ? 'sdiv' : 'udiv', d, divState.rs, divState.rt);
          } else if (mulState) {
            emitBin('mul', d, mulState.rs, mulState.rt);
          } else {
            emitOpaqueDest(ins);
          }
          break;
        case 'mfhi': // remainder, or product HIGH word (magic-div)
          if (divState) {
            emitBin(divState.signed ? 'smod' : 'umod', d, divState.rs, divState.rt);
          } else if (mulState) {
            emitBin(mulState.signed ? 'mulh' : 'mulhu', d, mulState.rs, mulState.rt);
          } // → magicdiv
          else {
            emitOpaqueDest(ins);
          }
          break;
        case 'and':
          emitBin('and', d, read(s), read(t));
          break;
        case 'andi':
          emitBin('and', d, read(s), constVal(imm(ins, t)));
          break;
        case 'or':
          if (frame !== null && isStackPtr(copiedReg(ins) ?? '')) {
            write(d, emitLaddr(0)); // `or rD,sp,zero`, IDO's spelling of the same move
            break;
          }
          isZero(t) ? write(d, read(s)) : emitBin('or', d, read(s), read(t));
          break;
        case 'ori':
          emitBin('or', d, read(s), constVal(imm(ins, t)));
          break;
        case 'xor':
          emitBin('xor', d, read(s), read(t));
          break;
        case 'xori':
          emitBin('xor', d, read(s), constVal(imm(ins, t)));
          break;
        // `nor rD, x, zero` / `nor rD, zero, x` = ~x (GCC emits the zero in EITHER operand — e.g.
        // its branchless `x<0?0:x` uses `nor v0,zero,a0`; IDO tends to put zero second).
        case 'nor': {
          if (isZero(t)) {
            emitUn('not', d, read(s));
            break;
          }
          if (isZero(s)) {
            emitUn('not', d, read(t));
            break;
          }
          // true 2-source nor: rD = ~(rS | rT), two ops.
          const orRes = mkValue(T.unk(32));
          ops.push(mkOp('or', { operands: [read(s), read(t)], results: [orRes] }));
          emitUn('not', d, orRes);
          break;
        }
        case 'sll':
          kit.shImm('shl', d, read(s), imm(ins, t));
          break;
        case 'srl':
          kit.shImm('shr_u', d, read(s), imm(ins, t));
          break;
        case 'sra':
          kit.shImm('shr_s', d, read(s), imm(ins, t));
          break;
        // Variable shift `<op>v rD, rT, rS` = rD = rT <shift> rS: VALUE is rT (=s), AMOUNT is rS
        // (=t) — value-then-amount, unlike `slt rD,rS,rT`.
        case 'sllv':
          emitBin('shl', d, read(s), read(t));
          break; // rD = rT << rS
        case 'srlv':
          emitBin('shr_u', d, read(s), read(t));
          break;
        case 'srav':
          emitBin('shr_s', d, read(s), read(t));
          break;
        case 'negu':
        case 'neg':
          emitUn('neg', d, read(s));
          break;
        case 'not':
          emitUn('not', d, read(s));
          break; // pseudo (nor rD,rS,zero)
        case 'slt':
          emitCmp('icmp_slt', d, read(s), read(t));
          break;
        case 'slti':
          emitCmp('icmp_slt', d, read(s), constVal(imm(ins, t)));
          break;
        case 'sltu':
          emitCmp('icmp_ult', d, read(s), read(t));
          break;
        case 'sltiu':
          emitCmp('icmp_ult', d, read(s), constVal(imm(ins, t)));
          break;
        // typed memory: `off(base)` addressing. Width/signedness come from the mnemonic; the
        // base is typed a pointer-to-element during recovery, mirroring the Thumb frontend.
        case 'lw':
          emitLoad(ins, d, s, 4, true);
          break;
        case 'lh':
          emitLoad(ins, d, s, 2, true);
          break;
        case 'lhu':
          emitLoad(ins, d, s, 2, false);
          break;
        case 'lb':
          emitLoad(ins, d, s, 1, true);
          break;
        case 'lbu':
          emitLoad(ins, d, s, 1, false);
          break;
        case 'sw':
          emitStore(ins, d, s, 4);
          break; // d = source reg, s = off(base)
        case 'sh':
          emitStore(ins, d, s, 2);
          break;
        case 'sb':
          emitStore(ins, d, s, 1);
          break;
        // A call reaches here only from a delay slot (the fill loop lowers every other one), and a
        // transfer in a delay slot is one the ISA leaves undefined.
        case 'jal':
          throw new FrontendUnsupportedError(`${site(ins)} sits in the delay slot of a transfer`);
        case 'add.s':
        case 'sub.s':
        case 'mul.s':
        case 'div.s':
        case 'neg.s':
        case 'mov.s':
        case 'add.d':
        case 'sub.d':
        case 'mul.d':
        case 'div.d':
        case 'neg.d':
        case 'mov.d':
          emitFpArith(ins);
          break;
        default:
          emitOpaqueDest(ins);
          break; // unmodelled: an honest opaque, never a silent drop
      }
      // THE CHOKE POINT (mirrors the PPC frontend). Every case above either folded the relocation
      // or threw, so one still sitting here was DROPPED. An unmodelled `%lo` consumer (`lwc1`,
      // `swc1`, `ori`) lands here, which is what keeps "not modelled" from becoming "not emitted".
      if (ins.reloc && !relocTaken) {
        relocPlaceholder(ins);
      }
    };
    // A relocation no case folded. The printed immediate is a link-time placeholder — the literal 0
    // in a relocatable object — so finishing the lift would put that 0 where the symbol belongs.
    const relocPlaceholder = (ins: Instr): never => {
      const r = ins.reloc!;
      throw new FrontendUnsupportedError(
        `${site(ins)} carries '${r.type}' against ` +
          `'${r.sym}' but is not a modelled consumer of it — the printed immediate is a link-time ` +
          `placeholder, not the value`,
      );
    };
    // TRUSTWORTHINESS GUARD (mirrors the PPC frontend): an unmodelled instruction must not silently
    // drop its destination register — emit an honest `opaque`, which fails LOUD at assertResolved
    // whether or not anything reads that register (see frontend/opaque.ts for the policy).
    const emitOpaqueDest = (ins: Instr) => {
      // THE RELOCATION FIRST. `opaqueDest` would refuse an unmodelled `%lo` consumer for the
      // lesser reason — "no register destination" — or, for a form that HAS one, degrade it to an
      // opaque and lose the global access with it. Naming the relocation says which capability is
      // missing.
      if (ins.reloc) {
        relocPlaceholder(ins);
      }
      // storeClass: unmodelled MIPS stores, whose FIRST token is a register (a SOURCE, not a dest)
      // that would otherwise fabricate an opaque write to it while dropping the real memory write.
      // `swc1`/`sdc1` are in the list and are NOT reached by any spelling `fpReg` covers — an FPU
      // store's `rt` is an FP register by ISA, so the arm above claims it first — but that is a
      // claim about the PREDICATE, not about the ISA, and it is false for every register spelling
      // the predicate misses: the store then arrives here and is named by the memory it writes
      // instead of by the file it moves. So they are kept as a live backstop, and
      // `test/fp-refusal.test.ts` asserts the FP arm wins on each spelling rather than assuming it.
      // Everything else here is genuinely reachable: `swl`/`swr` are the unaligned pair, `sc`/`sd*`
      // the rest.
      // skipSafe `break`: the compiler-emitted divide-by-zero guard trap inside the hw-divide
      // idiom (KMC GCC `break 0x7`); recompiling the recovered `/` regenerates it, so it is
      // transparent by the same modelling as the divide itself (byte-exactness proven by the
      // hw-divide suites). Any other no-destination effect (syscall, cache, sync) throws.
      const od = opaqueDest(ins.mnemonic, ins.ops, {
        isReg: isMipsReg,
        isZero,
        // The coprocessor-1 register file. `isMipsReg` rejects `$f12` — the `$`-prefixed forms it
        // takes are the numeric GPRs (`$4`) — so without this arm an `add.s` is refused for the
        // lesser reason, "no register destination", while `mfc1 v0,$f12` has a destination it
        // ACCEPTS and would build an opaque whose source list quietly omits the register the
        // instruction actually read. The file is what is missing; say so.
        //
        // BOTH DIALECTS AND EVERY SPELLING, which is why this is `frontend/splat.ts`'s exported
        // constant and not a literal: the reader decides which tokens still carry a sigil when they
        // get here, so a predicate written twice is a predicate that can disagree with itself, and
        // each half of that disagreement is silent. Its docblock lists the spellings and says why
        // the sigil is required.
        fpReg: MIPS_FP_REG,
        // The FPU CONTROL register, which both moves spell `$31` — a GPR-shaped token no register
        // predicate can tell from an integer one. `ctc1`'s first operand is its SOURCE, so this
        // also stops an opaque being fabricated on a register the instruction only reads.
        fpControl: /^(cfc1|ctc1)$/i,
        storeClass: /^(sb|sh|sw|swl|swr|sc|sd|sdl|sdr|swc1|sdc1)$/i,
        skipSafe: /^(nop|ssnop|break)$/i,
        context: `${name} @0x${ins.addr.toString(16)}`,
      });
      if (!od) {
        return;
      } // $zero write or skip-safe (opaqueDest threw otherwise)
      const res = mkValue(T.unk(32));
      // carry the mnemonic so annotate mode can name the gap (`ASMLIFT_ERROR("unmodelled 'lwl'")`)
      ops.push(mkOp('opaque', { operands: od.srcRegs.map(read), results: [res], attrs: { mnemonic: ins.mnemonic } }));
      write(od.dst, res);
    };
    const emitUn = kit.un;
    // Arithmetic on the FPU's file, keyed by `mipsEvenFpKey` so both dialects' spellings of one
    // register are one SSA variable. Anything it cannot key — an odd half, a target with no float
    // homes — keeps the register-file refusal.
    const emitFpArith = (ins: Instr) => {
      const keys = ins.ops.map(mipsEvenFpKey);
      if (fpu === undefined || keys.length === 0 || keys.some((k) => k === null)) {
        emitOpaqueDest(ins);
        return;
      }
      if (fpType === null) {
        refuseBothPrecisions(name, ins.mnemonic);
      }
      const [dst, ...srcs] = keys as string[];
      const { op } = FP_ARITH[ins.mnemonic];
      if (op === 'copy') {
        write(dst, read(srcs[0]));
        return;
      }
      const v = mkValue(fpType);
      ops.push(mkOp(op, { operands: srcs.map(read), results: [v] }));
      write(dst, v);
    };
    // `%lo` completes the address a `lui %hi` began. The pairing asks SSA — through `readVar`, not
    // `read`, which refuses a half — what `rHi` holds HERE, so a pair separated by unrelated
    // instructions folds while a register reused between the halves does not, and a half that
    // arrives only through a merge or a loop header comes back as the block parameter standing for
    // the join, which is not a half and refuses.
    const foldLoHalf = (ins: Instr, rHi: string, loImm: number): { base: Value; off: number } =>
      addressAt(ins, pairLoHalf(ins, rHi, loImm));
    /** `&SYM + off`, for the `%lo` at `ins` that completed it. */
    const addressAt = (ins: Instr, off: number): { base: Value; off: number } => {
      const lo = ins.reloc!;
      if (off < 0) {
        throw new FrontendUnsupportedError(
          `${site(ins)} completes '${lo.sym}' at ` +
            `byte offset ${off} — an address BELOW the symbol (an index-biased array base) is not yet modelled`,
        );
      }
      return { base: emitGaddr(lo.sym), off };
    };
    /** The byte offset into its symbol of the address the `%lo` at `ins` completes, the pair proven. */
    const pairLoHalf = (ins: Instr, rHi: string, loImm: number): number => {
      relocTaken = true;
      const hi = highHalves.pair(site(ins), rHi, readVar(rHi, bi), ins.reloc!.sym);
      // The addend is split across the two instruction immediates because MIPS is REL.
      return hi.addend + loImm;
    };
    // A displacement memory operand whose base is a `%hi` half: the global's address plus the
    // access offset. A non-`%lo` instruction returns null (the caller falls through to the ordinary
    // `off(base)` path).
    const globalBase = (ins: Instr, mem: string): { base: Value; off: number } | null => {
      if (ins.reloc?.type !== 'R_MIPS_LO16') {
        return null;
      }
      const { off, base } = parseMem(mem);
      return foldLoHalf(ins, base, off);
    };
    // The address an access in the local area, or through a frame sum, is made at — undefined for
    // every other access. A register the prologue SAVES may not be stored there: the save area is
    // outside it by construction, so a save inside it is a frame this does not describe.
    const frameAccess = (ins: Instr, base: string, off: number, width: number, stored?: string) => {
      if (isStackPtr(base)) {
        if (!inLocalArea(ins, off, width)) {
          return undefined;
        }
        if (stored !== undefined && savedByCallee(stored) && ssa.holdsEntryValue(stored, bi)) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': address-taken stack local — '${ins.mnemonic}' at 0x${ins.addr.toString(16)} saves the caller's ${stored} inside the local area, a frame this does not describe`,
          );
        }
        return emitLaddr(off);
      }
      const raw = rawFrame(base);
      const sum = raw === undefined ? undefined : frameSums.get(raw);
      return sum === undefined ? undefined : materialize(sum, off);
    };
    const emitLoad = (ins: Instr, d: string, mem: string, width: number, signed: boolean) => {
      const g = globalBase(ins, mem);
      if (g) {
        const res = mkValue(T.unk(32));
        ops.push(mkOp('load', { operands: [g.base], results: [res], attrs: { off: g.off, width, signed } }));
        write(d, res);
        return;
      }
      const { off, base } = parseMem(mem);
      // An access inside the local area, or through a frame sum, is MEMORY (`inLocalArea`).
      const at = frameAccess(ins, base, off, width);
      if (at !== undefined) {
        const res = mkValue(T.unk(32));
        ops.push(mkOp('load', { operands: [at], results: [res], attrs: { off: 0, width, signed } }));
        write(d, res);
        return;
      }
      // A word reload from a stack slot is transparent to dataflow — the SAME value spilled — so
      // route it through the slot SSA variable, not a `load` through `sp` (which would make `sp` a
      // spurious pointer parameter). Compiler spills/reloads are always word-width; sub-word `sp`
      // access is not spill output, so it stays on the memory path.
      if (spSlotSafe && isStackPtr(base) && width === 4) {
        const saved = saveSlots.get(off);
        if (saved !== undefined) {
          if (saved !== d) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': reload of '${mem}' into ${d}, a slot ${saved} was saved into — the ` +
                `word holds the caller's ${saved}, which no C value names`,
            );
          }
          const caller = mkValue(T.unk(32));
          restores.set(caller, { reg: d, addr: ins.addr });
          write(d, caller);
          return;
        }
        // SOUNDNESS GUARD (mirrors PPC frameLoad): only route through the slot SSA var if that slot was
        // actually STORED (has a reaching def). A word `lw` from an sp offset that was NEVER spilled is an
        // incoming STACK-PASSED argument (5th+ param, O32) or an uninitialised local. Without this,
        // readVar would FABRICATE a phantom entry parameter for the slot, silently emitting a function
        // of wrong arity that returns the wrong argument.
        //
        // The two are told apart by where the word is (`incomingStackKey`): a word at or past entry +
        // 16 is that argument, `@sarg<k>`, a parameter through the ordinary live-in path, as on
        // Thumb, merged with whatever this function stored there. Everything else keeps the
        // decline: a word of this frame, of the home area, or at an unproven depth. A sub-word or
        // floating-point incoming argument never reaches here (the `spSlotSafe` guard and the FP
        // arm).
        const incoming = incomingStackKey(ins, off);
        if (incoming !== undefined) {
          write(d, readVar(incoming, bi));
          return;
        }
        // A word of the frame this function OWNS (`ownedFrame`) that no store reaches is an
        // uninitialised local, which `readVar` answers with `undef` through the live-in model.
        const owned = ownedFrame();
        const ownsWord =
          owned !== undefined && depthAt?.get(ins) === frameSize && off >= owned.from && off + 4 <= owned.to;
        if (!ownsWord && !ssa.hasReachingDef(stackSlot(off), bi)) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': load from stack slot sp@${off} that was never stored ` +
              `(stack-passed argument beyond the 4 register args, or an address-taken/uninitialised local) — not modelled`,
          );
        }
        write(d, readVar(stackSlot(off), bi));
        return;
      }
      const res = mkValue(T.unk(32));
      ops.push(mkOp('load', { operands: [read(base)], results: [res], attrs: { off, width, signed } }));
      write(d, res);
    };
    const emitStore = (ins: Instr, srcReg: string, mem: string, width: number) => {
      const g = globalBase(ins, mem);
      if (g) {
        ops.push(mkOp('store', { operands: [g.base, read(srcReg)], attrs: { off: g.off, width } }));
        return;
      }
      const { off, base } = parseMem(mem);
      const at = frameAccess(ins, base, off, width, srcReg);
      if (at !== undefined) {
        ops.push(mkOp('store', { operands: [at, read(srcReg)], attrs: { off: 0, width } }));
        return;
      }
      // A word spill to a stack slot (an argument home slot `sw a0,0(sp)`, or a local): record the
      // slot's value in SSA, do NOT emit a `store` through `sp`. A never-reloaded spill (the ABI
      // home-slot store) then has no uses and simply drops. See isStackPtr / spSlotSafe.
      if (spSlotSafe && isStackPtr(base) && width === 4) {
        if (savedByCallee(srcReg) && ssa.holdsEntryValue(srcReg, bi)) {
          refuseMixedSlot(ins, mem, off, 'save');
          saveSlots.set(off, srcReg);
          return;
        }
        refuseMixedSlot(ins, mem, off, 'value');
        valueSlots.add(off);
        // an assignment to an incoming stack parameter is that parameter's SSA variable
        writeVar(incomingStackKey(ins, off) ?? stackSlot(off), bi, read(srcReg));
        return;
      }
      ops.push(mkOp('store', { operands: [read(base), read(srcReg)], attrs: { off, width } }));
    };

    // A CALL, WITH ITS DELAY SLOT RUN FIRST: the word at `jal + 4` executes before the callee is
    // entered, so it can set an argument up (KMC stores argument 5 there). The plan answers what
    // the callee's declaration says (`frontend/call-plan.ts`); what is O32's alone is here: where
    // argument k ≥ 4 lives, and the guess that cannot see past a3.
    const lowerJal = (ins: Instr) => {
      const at = `0x${ins.addr.toString(16)}`;
      const callee = jalCallee(ins, splat);
      if (callee?.startsWith('.')) {
        throw new FrontendUnsupportedError(
          `${site(ins)} is relocated against the section '${callee}' — a callee known only by its offset ` +
            'in a section has no name to call it by',
        );
      }
      if (callee === undefined || !/^[A-Za-z_]\w*$/.test(callee)) {
        throw new FrontendUnsupportedError(
          `${site(ins)} has no callee symbol — no R_MIPS_26 relocation names it, and its operand ` +
            `'${ins.ops[0] ?? ''}' is not a name`,
        );
      }
      if (fpuInstr !== undefined) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': '${fpuInstr.mnemonic}' at 0x${fpuInstr.addr.toString(16)} uses the FPU and ` +
            `'jal' at ${at} makes a call — the floating-point registers a call reads, returns in and destroys ` +
            'are not modelled',
        );
      }
      if (frameSize === undefined) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': the call at ${at} is made in a frame that is not one 'addiu sp,sp,-N', so ` +
            'where its outgoing stack arguments end is not known',
        );
      }
      calls.lower({
        callee,
        ssa,
        bi,
        read,
        write,
        // ARGUMENT WORD k ≥ 4 travels in `16+4(k-4)(sp)`, inside the one frame this function pushed
        stackWord: (k) => {
          const off = STACK_ARGS_AT + 4 * (k - ARG_REGS.length);
          if (off >= frameSize) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': outgoing stack argument ${k + 1} of '${callee}' at ${at} travels in ` +
                `${off}(sp), past the ${frameSize}-byte frame this function pushed`,
            );
          }
          if (!valueSlots.has(off) || !ssa.hasReachingDef(stackSlot(off), bi)) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': outgoing stack argument ${k + 1} of '${callee}' at ${at} travels in ` +
                `${off}(sp), and no value stored there reaches the call`,
            );
          }
          return readVar(stackSlot(off), bi);
        },
        // a pending `%hi` half and a table base are no argument
        placeholders,
        guess: {
          // a gap in the argument registers refuses, naming this address (`fallbackArgc`)
          at: ins.addr,
          // A GUESS THAT FILLS a0..a3 CANNOT SAY WHERE THE LIST ENDS: a word of the outgoing area that
          // reaches the call is argument 5 onward, or a local the compiler put there.
          refuse: (argc) => {
            // …and with a local area a guess says less still. A word staged for the call above the
            // home area may be MEMORY there, which the slot test below cannot see; and a word
            // staged below it reaches the call whether or not a3 is set, since an 8-aligned
            // argument (`long long`, a struct holding one) skips a3 for the stack.
            if (frame !== null) {
              if (argc >= ARG_REGS.length) {
                throw new FrontendUnsupportedError(
                  `cannot lift '${name}': outgoing stack arguments not modelled — the undeclared call to '${callee}' ` +
                    `at ${at} fills a0..a3 in a frame whose local area holds a captured address, so where its ` +
                    'stack words end is not known',
                );
              }
              const staged = [...valueSlots]
                .filter(
                  (off) => off >= STACK_ARGS_AT && off < frame.area.from && ssa.hasReachingDef(stackSlot(off), bi),
                )
                .sort((x, y) => x - y)[0];
              if (staged !== undefined) {
                throw new FrontendUnsupportedError(
                  `cannot lift '${name}': outgoing stack arguments not modelled — the word stored to ${staged}(sp), ` +
                    `below the local area, reaches the undeclared call to '${callee}' at ${at}, where a stack ` +
                    'argument travels',
                );
              }
            }
            if (argc < ARG_REGS.length) {
              return;
            }
            const passed = [...valueSlots]
              .filter((off) => off >= STACK_ARGS_AT && off < frameSize && ssa.hasReachingDef(stackSlot(off), bi))
              .sort((x, y) => x - y)[0];
            if (passed !== undefined) {
              throw new FrontendUnsupportedError(
                `cannot lift '${name}': outgoing stack arguments not modelled — the undeclared call to '${callee}' ` +
                  `at ${at} fills a0..a3, and the word stored to ${passed}(sp) reaches it where an argument past ` +
                  'the registers travels',
              );
            }
          },
        },
      });
      // hi and lo are the callee's to overwrite
      divState = null;
      mulState = null;
    };
    for (let i = 0; i < b.body.length; i++) {
      const ins = b.body[i];
      if (ins.mnemonic !== 'jal') {
        decode(ins);
        continue;
      }
      const slot = b.body[i + 1];
      if (slot?.addr !== ins.addr + 4) {
        throw new FrontendUnsupportedError(
          `${site(ins)} — its delay slot at 0x${(ins.addr + 4).toString(16)} is not the next instruction of ` +
            'its block (a branch target, a control transfer, or missing), so it does not run before this call alone',
        );
      }
      decode(slot);
      i++;
      lowerJal(ins);
    }

    // Terminator. For a conditional branch, capture the comparison operands from the register
    // state BEFORE the delay slot runs, then run the delay slot, then emit the cond_br.
    const br = b.branch;
    // A branch target must land on a block boundary. If it does not (an out-of-range / mid-instruction
    // target — a tail branch out of the function, or flow this frontend hasn't recovered), fail LOUD
    // and catchably here rather than building a successor to `undefined` and surfacing as the opaque
    // internal `verify` error "successor of 'cond_br' is not a block of this fn".
    const succ = (addr: number): Successor => {
      const j = idxOf.get(addr);
      if (j === undefined) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': branch to 0x${addr.toString(16)} is not a block boundary ` +
            `(out-of-range / mid-instruction target — tail branch or unrecovered control flow)`,
        );
      }
      return { block: irBlocks[j], args: [] };
    };

    // Recovered dense switch: dispatch a `switch_br` over the scrutinee (N case blocks, dense
    // 0..N-1, + default). The scrutinee is the value the `sltiu` bounded, so it is read BEFORE the
    // `beqz` delay slot runs, as a conditional branch reads its operands: IDO can scale the index
    // IN PLACE there (`sll t6,t6,2`), and reading after the slot would switch on `k << 2` over the
    // unscaled labels 0..N-1. The slot still runs, because it can also compute the DEFAULT value
    // (IDO's `li v0,-1`, read by the default block).
    const jt = br ? jts.get(br.addr) : undefined;
    if (jt) {
      const scrut = readVar(jt.scrutReg, bi);
      if (b.delay) {
        decode(b.delay);
      }
      if (jt.hoisted) {
        tableBases.demand(jt.hoisted, bi, jt.jrAddr);
      }
      pushSwitchBr(ops, scrut, [...jt.caseAddrs, jt.defaultAddr].map(succ));
      return;
    }

    if (br && isCond(br)) {
      const cond = condValue(br, ops, read, constVal, cmpDef);
      // A NULLIFIED slot is not decoded here: it is its own block on the taken edge, and the
      // not-taken edge skips past it (toBlocks). Every pass after this one sees ordinary
      // conditional execution.
      if (b.delayAnnulled) {
        ops.push(mkOp('cond_br', { operands: [cond], successors: [succ(br.addr + 4), succ(br.addr + 8)] }));
        return;
      }
      if (b.delay) {
        decode(b.delay);
      }
      ops.push(mkOp('cond_br', { operands: [cond], successors: [succ(br.target!), succ(br.addr + 8)] }));
      return;
    }
    if (b.delay) {
      decode(b.delay);
    } // unconditional / return: delay slot just executes first

    if (!br || isReturn(br)) {
      // A HIGH HALF IN v0 IS NOT A RETURN VALUE. `v0` is both MIPS's return register and an
      // ordinary caller-saved scratch, so a void function can end with a half still live in it
      // (`lui v0,%hi(g); lw v1,%lo(g)(v0); … ; sw v1,%lo(g)(v0)`). Counting that def hands the
      // placeholder to the `ret` op, and the whole function then declines at `assertNoneEscaped` —
      // loud, but for a merge that never happened. Rejecting it gives the honest void return.
      // PowerPC reads its return register through the guard, so the refusal it would get is already
      // the right one; it passes this same predicate to its call-arity count.
      //
      // NOR IS WHAT A VOID CALLEE LEFT IN v0. The call writes no v0 and destroys it, and `holdsValue`
      // ends a path there, so a function that ends on that call returns nothing.
      if (!br) {
        // A nullified slot's block leaves by its branch's TARGET, which need not be the next
        // address, so `fallthrough` is claimed only where control really does fall through.
        const to = succAddrs.get(b)![0];
        const next = (b.body[b.body.length - 1]?.addr ?? b.startAddr) + 4;
        ops.push(mkOp('br', { attrs: to === next ? { fallthrough: true } : {}, successors: [succ(to)] }));
        return;
      }
      // A FLOAT RETURN is decided for the whole function (frontend/fpu.ts `writesFloatReturn`), and
      // then `v0` is scratch like any other integer register.
      const returnsWord = !floatReturn && ssa.holdsValue(RET, bi, (v) => !placeholders.has(v));
      // A 64-BIT INTEGER RETURN COMES BACK IN v0:v1, the high word in v0, and this lowering returns
      // one word: returning v0 alone hands back the high word with the low one dropped, a function
      // that compiles and returns the wrong value (`long long f(int a, int b, int c, int d,
      // long long e) { return e; }` read as `return a4;`). Where v1 was last written for the caller
      // (`v1MayHoldLowWord`) this refuses, unless the function's own declaration says the return
      // fits a word. Modelling the pair is the capability this stands in for.
      if (returnsWord && !ownReturnFitsAWord && v1MayHoldLowWord(blocks, preds, bi)) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': the return at 0x${br.addr.toString(16)} may hand back the halves of a 64-bit pair ` +
            'in v0:v1 (v1 is written for the caller, and nothing declares a return no wider than a word), and this ' +
            'lowering returns one word',
        );
      }
      const retOps = floatReturn ? [read(fpu!.returnReg)] : returnsWord ? [readVar(RET, bi)] : [];
      ops.push(mkOp('ret', { operands: retOps }));
      return;
    }
    // unconditional branch
    ops.push(mkOp('br', { successors: [succ(br.target!)] }));
  };

  blocks.forEach((b, bi) => {
    fillBlock(b, bi);
    ssa.markFilled(bi);
  });
  highHalves.assertAllConsumed(name);
  tableBases.prove(name, ssa);
  const argSlots = o32ArgSlots(name, fpuArgSlots(name, fpu, ARG_REGS, isFpKey, fpType), ARG_REGS);
  mintArgSlotHoles(ssa, preds[0].length > 0, argSlots);
  ssa.finish();
  highHalves.assertNoneEscaped(name, irBlocks);
  tableBases.assertNoneEscaped(name, irBlocks);
  for (const blk of irBlocks) {
    const used = [
      ...blk.params,
      ...blk.ops.flatMap((op) => [...op.operands, ...op.results, ...op.successors.flatMap((s) => s.args)]),
    ];
    const restore = used.map((v) => restores.get(v)).find((r) => r !== undefined);
    if (restore) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': the caller's ${restore.reg}, which the 'lw' at 0x${restore.addr.toString(16)} ` +
          `restores, reaches a value this function computes with — no C value names it`,
      );
    }
  }

  // A struct passed by value becomes the one object its words hold (call-plan.ts `foldByValueArgs`)
  // before the audit judges the frame objects, as on Thumb.
  foldByValueArgs(name, irBlocks, calls, { symbols, context });

  if (frame !== null) {
    refuseEscapedFrameSums(name, irBlocks, frameSums);
    // Prove every `laddr` names storage of this frame at a shape the machine states, or decline
    // (`auditFrameObjects`); an accepted function then gets the device pin the audit answers.
    const verdict = FRAME_OBJECT_AUDIT.run({
      name,
      irBlocks,
      ownedLocals: frame.area,
      declaredLocals: frame.area,
      usedSlotOffsets: new Set([...valueSlots].filter((o) => o < frame.size)),
      capturedObjectIsTheWholeFrame: false,
      movedCaptures,
      returnsWithoutHiddenPointer: calls.returnsWithoutHiddenPointer,
      symbols,
      target,
      oneObject,
    });
    if (verdict !== undefined && 'oneObject' in verdict) {
      return verdict;
    }
    if (verdict !== undefined) {
      pinDeviceAccesses(irBlocks, verdict, target, symbols);
    }
  }
  pinDeadReads(irBlocks, target, {
    own: prototypes[name],
    atUndeclaredCall: calls.heldAtUndeclaredCall,
    spilled: ssa.frameWrites,
    declarations: { symbols, context },
  });

  abiSortEntryParams(irBlocks[0], preds[0].length > 0, paramReg, argSlots);
  return ssa.fn;
}

/** `sp + index`, deferred to its use (`materialize`): the frame offset it starts from and the index. */
interface FrameSum {
  readonly base: number;
  readonly index: Value;
}

/** A frame sum is a VALUE no op defines — every use builds its own `laddr` and `add` — so one that
 *  reached a phi, or anything else the fill did not materialize, refuses. */
function refuseEscapedFrameSums(name: string, irBlocks: readonly Block[], sums: ReadonlyMap<Value, FrameSum>): void {
  for (const blk of irBlocks) {
    for (const op of blk.ops) {
      if ([...op.operands, ...op.successors.flatMap((x) => x.args)].some((v) => sums.has(v))) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': address-taken stack local — a frame address plus a runtime index reaches \`${op.opcode}\` across a join, ` +
            'which object it indexes is not known there',
        );
      }
    }
  }
}

/** An instruction that takes a frame address as data: `addiu rD,sp,k`, `move rD,sp`, or `addu
 *  rD,sp,rX` in either operand order. */
function takesFrameAddress(ins: Instr): boolean {
  const [d, s, t] = ins.ops;
  if (d === undefined || isStackPtr(d)) {
    return false;
  }
  if (ins.mnemonic === 'addiu' || ins.mnemonic === 'addi' || ins.mnemonic === 'move') {
    return isStackPtr(s ?? '');
  }
  if (ins.mnemonic === 'or') {
    return isStackPtr(copiedReg(ins) ?? '');
  }
  return (
    (ins.mnemonic === 'addu' || ins.mnemonic === 'add') && t !== undefined && isStackPtr(s ?? '') !== isStackPtr(t)
  );
}

/** THE REGISTERS THE PROLOGUE SAVES: a word store to `sp` of a register O32 makes a callee
 *  preserve, in the entry block (its delay slot included — the slot of a branch-likely is its own
 *  block, so never this one) before any instruction NAMES that register, read or written. What it
 *  stores is then what the caller left there, which is the half of `LiveInModel.uninitRegs` the
 *  frontend owes: a compiler homes a local in a callee-saved register only after saving it, so a
 *  def-less read of a saved one is that local, uninitialised, and of an unsaved one stays the
 *  parameter it would have been. "Nothing named it first" is PPC's condition
 *  (`prologueSavedRegs` there): a read before the store would be a use of the caller's value. A
 *  re-entered entry gets an empty preheader as `blocks[0]`, so it measures no save at all. */
function prologueSavedRegs(entry: readonly Instr[], target: TargetDescription): ReadonlySet<string> {
  const saved = new Set<string>();
  const named = new Set<string>();
  const calleeSaved = (r: string) => isMipsReg(r) && !r.startsWith('$') && !target.callerSaved.includes(r);
  for (const ins of entry) {
    const [src, mem] = ins.ops;
    if (ins.mnemonic === 'sw' && src !== undefined && mem !== undefined && isStackPtr(parseMem(mem).base)) {
      if (calleeSaved(src) && !named.has(src)) {
        saved.add(src);
      }
    }
    for (const op of ins.ops) {
      const reg = op.includes('(') ? parseMem(op).base : op;
      if (isMipsReg(reg)) {
        named.add(reg);
      }
    }
    const w = writtenReg(ins);
    if (w !== null) {
      named.add(w);
    }
  }
  return saved;
}

/** The local area of a function that takes a frame address (`o32LocalArea`), and the depth every
 *  access it routes runs at — or null, which leaves every capture its sp-as-data refusal. Null
 *  where nothing takes a frame address; where the depth walk is unproven or the frame is not one
 *  push; where a capture runs at another depth; where the target states no layout or leaves no
 *  area; and where an `sp` access at another depth lands on the area's bytes, which the routing by
 *  raw offset would then misname.
 *
 *  The outgoing area ends past the widest call's stack words, read off each callee's declaration
 *  (`stackWordsOf`). A CALL NO DECLARATION SIZES refuses here, where the number is computed, rather
 *  than relying on its own lowering to refuse it: gcc stages `fp(1, 2, 3, 4, x)`'s fifth word at
 *  sp+16 and puts the local at sp+24, so an extent read without that call would draw the area over
 *  the staged word. A call through a register (`jalr`) or a linking branch always refuses. A `jal`
 *  to an undeclared callee refuses where the area depends on its extent — where drawing the
 *  outgoing area up to the lowest save would move it. That is gcc's layout, whose locals start
 *  where the outgoing area ends: `tl(1, 2, 3, (long long)x)` to an unprototyped `tl` skips a3 and
 *  stages x at sp+16..24, which no guess of a0..a3 sees. IDO's area starts above the saves, which
 *  the outgoing area lies below whatever its extent, so there the undeclared call costs nothing.
 *  The saves are the prologue's: a store of `ra` or a callee-saved register in the entry block
 *  before anything writes it. */
/** THE OUTGOING ARGUMENT AREA OF AN O32 FRAME, the part of it a callee may write: the a0..a3 home
 *  words `[0,16)` and the widest call's stack words past them, by each callee's declaration. `end`
 *  is where it stops, 0 in a leaf. `unsized` is the first call no declaration sizes (a `jal` nothing
 *  declares, or a call through a register), counted in `end` as taking no stack words: what that
 *  costs is each caller's to decide — `measureO32Frame` refuses where it could move the local area,
 *  and `ownedFrame` claims no frame at all. */
function o32OutgoingArea(
  code: readonly Instr[],
  stackWordsOf: (callee: string | undefined) => number | null,
  splat: boolean,
): { end: number; unsized: Instr | undefined } {
  const calls = code.filter(isCallInstr);
  const words = calls.map((ins) => (ins.mnemonic === 'jal' ? stackWordsOf(jalCallee(ins, splat)) : null));
  return {
    end: calls.length === 0 ? 0 : STACK_ARGS_AT + 4 * Math.max(0, ...words.map((w) => w ?? 0)),
    unsized: calls.find((_, k) => words[k] === null),
  };
}

export function measureO32Frame({
  name,
  code,
  entry,
  depthAt,
  frameSize,
  rule,
  stackWordsOf,
  savedByCallee,
  splat,
}: {
  name: string;
  code: readonly Instr[];
  entry: readonly Instr[];
  depthAt: ReadonlyMap<Instr, number> | null;
  frameSize: number | undefined;
  rule: TargetDescription['compilerBehaviors']['o32LocalArea'];
  /** The stack words a `jal`'s callee takes, by its declaration; null where nothing declares it. */
  stackWordsOf: (callee: string | undefined) => number | null;
  savedByCallee: (r: string) => boolean;
  splat: boolean;
}): { area: FrameRange; size: number } | null {
  const captures = code.filter(takesFrameAddress);
  if (captures.length === 0 || depthAt === null || frameSize === undefined) {
    return null;
  }
  if (captures.some((ins) => depthAt.get(ins) !== frameSize)) {
    return null;
  }
  const unsized = code.find((ins) => isCallInstr(ins) && ins.mnemonic !== 'jal');
  if (unsized !== undefined) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': outgoing stack arguments not modelled — the call '${unsized.mnemonic}' at ` +
        `0x${unsized.addr.toString(16)} has no declaration to size its stack words by, in a frame whose local ` +
        'area holds a captured address',
    );
  }
  const written = new Set<string>();
  const saves: number[] = [];
  for (const ins of entry) {
    const mem = ins.mnemonic === 'sw' ? parseMem(ins.ops[1] ?? '') : undefined;
    if (mem !== undefined && isStackPtr(mem.base) && savedByCallee(ins.ops[0]) && !written.has(ins.ops[0])) {
      saves.push(mem.off);
    } else if (writtenReg(ins) !== null) {
      written.add(writtenReg(ins)!);
    }
  }
  const { end: outgoingEnd, unsized: undeclared } = o32OutgoingArea(code, stackWordsOf, splat);
  const area = o32LocalArea(rule, { frameSize, outgoingEnd, saves });
  if (area === null) {
    return null;
  }
  if (undeclared !== undefined) {
    const widest = o32LocalArea(rule, {
      frameSize,
      outgoingEnd: Math.max(outgoingEnd, Math.min(frameSize, ...saves)),
      saves,
    });
    if (widest?.from !== area.from || widest.to !== area.to) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': outgoing stack arguments not modelled — nothing declares the callee of the \`jal\` at ` +
          `0x${undeclared.addr.toString(16)}, so how many stack words it takes is unknown, and this compiler's local ` +
          'area starts past them',
      );
    }
  }
  for (const ins of code) {
    const last = ins.ops[ins.ops.length - 1] ?? '';
    const depth = depthAt.get(ins);
    if (!/\(/.test(last) || !isStackPtr(parseMem(last).base) || depth === frameSize) {
      continue;
    }
    if (landsOnArea(area, parseMem(last).off - depth! + frameSize, 4)) {
      return null;
    }
  }
  return { area, size: frameSize };
}

/** A `jal`'s callee: the Splat operand, or the R_MIPS_26 record's symbol. */
function jalCallee(ins: Instr, splat: boolean): string | undefined {
  return splat ? ins.ops[0] : ins.reloc?.type === 'R_MIPS_26' ? ins.reloc.sym : undefined;
}

/** THE LOCAL AREA OF AN O32 FRAME, `[from, to)` in post-push `sp` offsets: where this compiler
 *  keeps the locals and spill temps (`compilerBehaviors.o32LocalArea`), so where a captured frame
 *  address may name a local and nothing else does. Below it is the outgoing area, which ends at
 *  `outgoingEnd` — 0 in a function that makes no call, else the 16-byte home of a0..a3 and then
 *  every stack word a call takes; above it, or below it on IDO, the registers the prologue saved at
 *  `saves`. Null where the target states no layout, or the area is empty. */
function o32LocalArea(
  rule: TargetDescription['compilerBehaviors']['o32LocalArea'],
  { frameSize, outgoingEnd, saves }: { frameSize: number; outgoingEnd: number; saves: readonly number[] },
): FrameRange | null {
  if (rule === 'above-outgoing-area') {
    return areaAboveOutgoing({ frameSize, outgoingEnd, saves, align: 8 });
  }
  if (rule === 'above-saved-registers') {
    const area = { from: Math.max(outgoingEnd, ...saves.map((o) => o + 4)), to: frameSize };
    return area.from < area.to ? area : null;
  }
  return null;
}

/** O32's slots: the shared register-then-stack-word rule (`stackArgSlots`), with a floating-point
 *  register read beside a stack word refused — where a float shadows the integer slots ahead of
 *  the stack words is not modelled here. */
function o32ArgSlots(name: string, regs: ArgSlots, argRegs: readonly string[]): ArgSlots {
  return stackArgSlots(regs, argRegs, (readKeys, top) => {
    const float = readKeys.find(isFpKey);
    if (float !== undefined) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': ${float} carries a floating-point argument beside the incoming stack argument ` +
          `${top + 1} — which integer slots the float takes ahead of the stack words is not modelled`,
      );
    }
  });
}

// Build the "branch taken" condition value for a conditional branch (emitting the icmp op).
function condValue(
  br: Instr,
  ops: Op[],
  read: (r: string) => Value,
  constVal: (n: number) => Value,
  cmpDef: Map<Value, { opcode: string; lhs: Value; rhs: Value }>,
): Value {
  const mk = (opc: Opcode, l: Value, r: Value): Value => {
    const v = mkValue(T.unk(32));
    ops.push(mkOp(opc, { operands: [l, r], results: [v] }));
    return v;
  };
  if (br.mnemonic in COND_RR) {
    return mk(COND_RR[br.mnemonic], read(br.ops[0]), read(br.ops[1]));
  }
  // *z forms compare a register against zero — except beqz/bnez may fold a preceding `slt`.
  // Resolve the register to its reaching VALUE first: that is the fold's key (so a redefinition
  // between the compare and the branch misses instead of folding stale), and it is also what
  // routes the operand through `read`'s loud guards (sp / `%hi` / `gp` used as data) on every
  // path — the fold used to bypass them by never reading the register at all.
  const rsv = read(br.ops[0]);
  const folded = cmpDef.get(rsv);
  if (folded && br.mnemonic === 'bnez') {
    return rsv;
  } // branch when slt is true
  if (folded && br.mnemonic === 'beqz') {
    return mk(NEGATED_ICMP[folded.opcode], folded.lhs, folded.rhs);
  } // …when false
  return mk(COND_Z[br.mnemonic], rsv, constVal(0));
}

/** The MIPS-II / IDO frontend, registered for the `mips` target. */
export const mipsFrontend: Frontend = { id: 'mips', inputFormat: 'objdump', lift };

/** Internal surface for this module's own tests, and for nothing else (`frontend/frame-objects.ts`
 *  says why it is not a plain export). */
export const __testing = { o32LocalArea };
