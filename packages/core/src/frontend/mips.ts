// asmlift ISA frontend — MIPS-II (IDO 7.1, N64). Input is DISASSEMBLED text
// (`mips-linux-gnu-objdump -d --no-show-raw-insn`), since IDO emits no textual asm.
//
// The MIPS-specific concern is the DELAY SLOT: the instruction textually AFTER a control
// transfer executes BEFORE the transfer takes effect (on both the taken and fall-through
// paths). It is therefore lifted into the branching block, sequenced right before the branch —
// EXCEPT that a conditional branch reads its comparison operands as of the branch, so those
// SSA values are captured BEFORE the delay slot runs, then the delay slot executes, then the
// `cond_br` is emitted. A `jr ra` return's delay slot (which computes the return value) runs
// first, then the value is read. Branch-likely ops (`beql`/`bnel`…, which annul the delay slot
// when not taken) and calls (`jal`) are out of scope — both loud-fail (the control-transfer
// pre-scan in `lift`).
//
// Comparison model: MIPS fuses compare-and-branch, so a branch lowers directly to an icmp
// (the branch mnemonics are signed/equality only). `bltz/bgez/blez/bgtz` compare against zero; `beq/bne`
// compare two registers; `beqz/bnez` test a register (or fold a preceding `slt` — `slt at,rs,
// rt; beqz at,L` means "branch when !(rs<rt)", i.e. the negated compare). A materialised `slt`
// with no consuming branch (e.g. `return a>b` → `slt v0,a1,a0`) stays an icmp value. Unsigned
// compares (`sltu`/`sltiu`) lower to `icmp_ult`; recover types their operands u32 so the backend
// re-emits `sltu` (the operator is the same `<` — the signedness lives in the operand types).
import { Fn, Op, Successor, Value, mkOp, mkValue } from '../ir/core';
import { NEGATED_ICMP, type Opcode } from '../ir/opcodes';
import { T } from '../ir/types';
import type { Prototypes } from '../proto';
import type { TargetDescription } from '../target';
import { type AsmData, readJumpTable, textRelocAt } from './asmdata';
import { type DisasmInstr, parseImm, parseMem, parseDisasm as parseSharedDisasm, sliceSymbol } from './disasm';
import { mkEmitKit, pushSwitchBr } from './emit';
import { FrontendUnsupportedError } from './errors';
import { assertInputFormat } from './format';
import type { Frontend } from './frontend';
import { makeHighHalves } from './high-half';
import { opaqueDest } from './opaque';
import { isSplatMips, parseSplatMips } from './splat';
import { abiSortEntryParams, stackSlotKey } from './ssa';
import { makeSsaBuilder } from './ssa';

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

const isZero = (r: string) => r === 'zero' || r === '$0';
// The stack pointer (`$29`). A `sw/lw` through it is not a store/load through a data pointer — it
// is a spill/reload of a stack SLOT (an argument home slot or a local). See emitStore/emitLoad.
const isStackPtr = (r: string) => r === 'sp' || r === '$sp' || r === '$29';
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
// switch dispatch (its block is pruned as unreachable) or has already loud-failed in `lift`.
const isReturn = (ins: Instr) => ins.mnemonic === 'jr';
const isUncond = (ins: Instr) => ins.mnemonic === 'b' || ins.mnemonic === 'j';
const isCond = (ins: Instr) => ins.mnemonic in COND_Z || ins.mnemonic in COND_RR;
const isXfer = (ins: Instr) => isReturn(ins) || isUncond(ins) || isCond(ins);

// Shared objdump scaffolding (frontend/disasm.ts): parseImm/parseMem/parseDisasm. MIPS needs no
// reloc or hint-suffix handling; register-scaled indices are materialised by IDO as explicit
// `sll`+`addu` before the access, so no `base+index` addressing form appears in parseMem input.
const parseDisasm = (disasm: string): Instr[] => parseSharedDisasm(disasm);

// Bridge an object file's `.text` relocation records onto the instructions they fill, so the
// high/low fold reads ONE carrier (`ins.reloc`) whichever dialect the input arrived in — the same
// carrier frontend/ppc.ts reads, folded by the same shared invariant (frontend/high-half.ts). The
// Splat dialect spells `%hi`/`%lo` in the operand text and writes its own records
// (frontend/splat.ts); objdump hides the symbol in the relocation table, which is what this reads.
//
// EVERY HI16/LO16 IS CARRIED, WHATEVER IT NAMES, and that includes a SECTION symbol (`.data`,
// `.rodata` — a file-static array, a string literal, any anonymous datum). Excluding those left the
// pair raw, and raw means the `lui`'s link-time placeholder — the literal 0 in a relocatable object
// — standing in for the address: `*(u8 *)(0 + i)` compiles, so nothing downstream ever complains.
// That is the forbidden class, and the only way to close it is to put every record in front of the
// fold and its choke point.
//
// WHETHER THE NAME CAN BE WRITTEN DOWN is a different question, and on MIPS a different seam
// answers it. A section name is never a C identifier, so a recovered `.data` access is LOUD twice
// over: rank-declare.ts refuses the declaration and REPORTS the name to the caller, and the
// candidate's own source does not compile. That is strictly more than a frontend refusal would say,
// and it is what the mapless-decls tests are designed around.
//
// So this frontend does NOT clone frontend/ppc.ts's naming-policy refusal, and the reason is
// measured rather than assumed. Of the 20,262 distinct symbols a `.text` HI16/LO16 names across the
// three N64 checkouts, `classifyRelocSymbol` answers `plain` for 20,245, `section-local` for 4
// (`.text`/`.data`/`.rodata`/`.bss`, handled above) and `cpp-mangled` for 13 — and all 13 of those
// are ORDINARY C NAMES (`game_GameFrame__1F`, `ovl__0078CB80_VRAM`) that the policy's
// `__<digit>` class-scope marker misreads. Adopting it here would refuse 13 names C spells
// perfectly well and buy nothing: the kind it exists for, a mwcc vtable that would otherwise
// COMPILE, has no inhabitant on this ISA.
//
// A recovered JUMP TABLE's dispatch is untouched by this: Regime B reads the table through
// `asmdata.ts` and prunes the dispatch block, so its `lui %hi(.rodata)` never reaches `decode`.
//
// `R_MIPS_GOT16`/`R_MIPS_CALL16`/`R_MIPS_GPREL16` are PIC/small-data access, already refused by the
// `gp`-as-data guard; widening this carrier to them would trade those messages for worse ones
// without recovering an address, so they stay where they are.
//
// THE ADDEND IS NOT ON THE RECORD. MIPS objects are REL: the relocation has no addend field, and
// the address's low bits live in the two instruction immediates (`(hi_imm << 16) + (s16)lo_imm`).
// PowerPC is RELA and carries it on the record, which is the one place the two folds diverge. A
// MIPS record that DOES carry an addend is therefore not the format assumed here, and refuses.
function attachMipsRelocs(name: string, instrs: Instr[], ad: AsmData): void {
  const byAddr = new Map(instrs.map((ins) => [ins.addr, ins]));
  for (const r of ad.relocs) {
    if (r.section !== '.text' || (r.type !== 'R_MIPS_HI16' && r.type !== 'R_MIPS_LO16')) {
      continue;
    }
    const ins = byAddr.get(r.offset);
    if (!ins) {
      continue; // a relocation in another function's slice, or on a pruned dispatch
    }
    if (r.addend !== 0) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': relocation '${r.type} ${r.sym}' at 0x${r.offset.toString(16)} carries an addend ` +
          `(0x${r.addend.toString(16)}), but MIPS relocations are REL and hold the addend in the instruction ` +
          `fields — this object is not the assumed format`,
      );
    }
    // At most one relocation per instruction — the same invariant disasm.ts and frontend/splat.ts
    // enforce on their own inputs, and for the same reason: keeping the last would leave one
    // symbol standing for the other's operand, silently.
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
  delay: Instr | null; // delay-slot instruction (executes before the transfer)
}

// Mnemonics whose destination is `ops[0]` (a plain register write) — the subset the jump-table
// backward trace chases (index/base/address/load). Stores, branches, `jr`, `nop`, `div`/`mult`
// (hi/lo writers) are absent, so `destReg` returns null for them and the trace never mis-attributes.
const WRITES_D = new Set([
  'lui',
  'lw',
  'lh',
  'lhu',
  'lb',
  'lbu',
  'sll',
  'srl',
  'sra',
  'sllv',
  'srlv',
  'srav',
  'addu',
  'add',
  'addiu',
  'addi',
  'subu',
  'sub',
  'or',
  'ori',
  'and',
  'andi',
  'xor',
  'xori',
  'nor',
  'move',
  'li',
  'slt',
  'sltu',
  'slti',
  'sltiu',
  'mflo',
  'mfhi',
  'mul',
]);
const destReg = (ins: Instr): string | null => (WRITES_D.has(ins.mnemonic) ? ins.ops[0] : null);

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
}

function recoverMipsJumpTables(instrs: Instr[], ad: AsmData): Map<number, MipsJT> {
  // Nearest def of `reg` strictly before index `p`, not crossing a control transfer (so the trace
  // stays inside the dispatch's extended block). Returns the instruction index, or -1.
  const defBefore = (reg: string, p: number): number => {
    for (let j = p - 1; j >= 0; j--) {
      if (isXfer(instrs[j])) {
        return -1;
      }
      if (destReg(instrs[j]) === reg) {
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

  const out = new Map<number, MipsJT>();
  for (let i = 0; i < instrs.length; i++) {
    const jr = instrs[i];
    if (jr.mnemonic !== 'jr' || jr.ops[0] === 'ra') {
      continue;
    }
    let rV = jr.ops[0];
    // Optional IDO `+gp`: `addu rV, rL, gp` before the load — the loaded value is the other operand.
    let ldIdx = defBefore(rV, i);
    if (ldIdx >= 0 && instrs[ldIdx].mnemonic === 'addu') {
      const [a, b] = [instrs[ldIdx].ops[1], instrs[ldIdx].ops[2]];
      if (a === 'gp' || b === 'gp') {
        rV = a === 'gp' ? b : a;
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
      table: { sym: string; addend: number } | null = null;
    for (const [idxCand, baseCand] of [
      [oa, ob],
      [ob, oa],
    ] as const) {
      const si = defBefore(idxCand, aIdx);
      const bi2 = defBefore(baseCand, aIdx);
      if (si < 0 || bi2 < 0) {
        continue;
      }
      const sll = instrs[si];
      if (sll.mnemonic !== 'sll' || (sll.ops[2] !== '0x2' && sll.ops[2] !== '2')) {
        continue;
      } // index*4
      const tb = tableBaseOf(instrs[bi2]);
      if (!tb) {
        continue;
      }
      scrutReg = sll.ops[1];
      table = tb;
      break;
    }
    if (!scrutReg || !table) {
      continue;
    }
    // Bounds: `sltiu tmp, scrutReg, N ; beqz tmp, DEF` — the guard whose delay-slot-consuming branch
    // block will emit the switch_br. Scan back for the sltiu on the scrutinee.
    let bounds: { addr: number; n: number; def: number } | null = null;
    for (let j = aIdx; j >= 0; j--) {
      const c = instrs[j];
      if (c.mnemonic === 'sltiu' && c.ops[1] === scrutReg) {
        const tmp = c.ops[0];
        // the beqz reading tmp (the block terminator); it may follow the sltiu directly.
        for (let k = j + 1; k < instrs.length && k <= j + 3; k++) {
          if (instrs[k].mnemonic === 'beqz' && instrs[k].ops[0] === tmp && instrs[k].target !== undefined) {
            // `sltiu tmp, scrut, N` bounds `scrut < N` — the immediate IS the case count (unlike PPC's
            // `cmplwi rS, N-1` which uses the max index). So N = the immediate, not immediate+1.
            bounds = { addr: instrs[k].addr, n: parseImm(c.ops[2]), def: instrs[k].target! };
            break;
          }
        }
        break;
      }
    }
    if (!bounds || bounds.n < 2) {
      continue;
    }
    const caseAddrs = readJumpTable(ad, table.sym, table.addend, bounds.n);
    if (!caseAddrs) {
      continue;
    }
    out.set(bounds.addr, { scrutReg, caseAddrs, defaultAddr: bounds.def, jrAddr: jr.addr });
  }
  return out;
}

// Split the instruction stream into basic blocks. Delay slots are consumed into their
// branching block; leaders are the entry, every branch target, and each conditional branch's
// fall-through. Unreachable trailing blocks (padding `nop`s) are dropped.
function toBlocks(
  instrs: Instr[],
  jts: Map<number, MipsJT>,
): { blocks: MipsBlock[]; succAddrs: Map<MipsBlock, number[]> } {
  const consumed = new Set<number>();
  instrs.forEach((ins, i) => {
    if (isXfer(ins)) {
      consumed.add(i + 1);
    }
  });

  const leaders = new Set<number>(instrs.length ? [instrs[0].addr] : []);
  instrs.forEach((ins, i) => {
    if ((isCond(ins) || isUncond(ins)) && ins.target !== undefined) {
      leaders.add(ins.target);
    }
    if (isCond(ins) && instrs[i + 2]) {
      leaders.add(instrs[i + 2].addr);
    } // fall-through
  });
  // A recovered jump table makes its case + default targets leaders (the bounds block's `switch_br`
  // successors); the dispatch block then becomes unreachable and is pruned below.
  for (const jt of jts.values()) {
    for (const a of jt.caseAddrs) {
      leaders.add(a);
    }
    leaders.add(jt.defaultAddr);
  }

  const blocks: MipsBlock[] = [];
  let cur: MipsBlock | null = null;
  for (let i = 0; i < instrs.length; i++) {
    if (consumed.has(i)) {
      continue;
    } // delay slot: handled with its branch
    const ins = instrs[i];
    if (cur === null || leaders.has(ins.addr)) {
      cur = { startAddr: ins.addr, body: [], branch: null, delay: null };
      blocks.push(cur);
    }
    if (isXfer(ins)) {
      cur.branch = ins;
      cur.delay = instrs[i + 1] ?? null;
      cur = null;
    } else {
      cur.body.push(ins);
    }
  }

  // Successor addresses per block (before reachability pruning).
  const succAddrs = new Map<MipsBlock, number[]>();
  for (const b of blocks) {
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
    } else {
      const fall = (b.delay ? b.delay.addr : br.addr) + 4; // instruction after the delay slot
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

/** Lift disassembled MIPS text → an L1 Fn with block-argument SSA. `prototypes` reserved for
 *  call arity (calls are a later milestone). */
export function lift(
  name: string,
  asm: string,
  target: TargetDescription,
  _prototypes: Prototypes = {},
  asmData?: AsmData,
): Fn {
  // Two input dialects reach this frontend: `objdump -d` text (IDO/KMC — no compiler-emitted asm),
  // and Splat-disassembled `.s` (pmret-style N64 projects). Splat is normalised to the SAME
  // DisasmInstr[] shape (frontend/splat.ts) so everything below is dialect-agnostic.
  const splat = isSplatMips(asm);
  if (!splat) {
    assertInputFormat('mips', 'objdump', asm);
  }
  // ONE function only — an absent symbol declines loud (either dialect's slicer enforces this).
  const instrs = splat ? parseSplatMips(asm, name) : parseDisasm(sliceSymbol(asm, name));
  if (instrs.length === 0) {
    throw new FrontendUnsupportedError(`cannot lift '${name}': no instructions found in the input text`);
  }
  // Regime B: recover jump tables from the `jr`-dispatch idiom + the AsmData table. A recovered
  // dispatch's `jr` is subsumed into a `switch_br` (emitted from its bounds block), so it is
  // exempted from the loud-fail below; an UNrecovered `jr <non-ra>` still fails loud.
  const jts = asmData ? recoverMipsJumpTables(instrs, asmData) : new Map<number, MipsJT>();
  const recoveredJr = new Set([...jts.values()].map((j) => j.jrAddr));
  // Carry the object's relocations on the instructions they fill (objdump dialect only — Splat
  // text spells the halves and writes its own records). Runs AFTER jump-table recovery, so that
  // reads `.text` relocs pristine and a recovered table base is decided before any of this.
  if (!splat && asmData) {
    attachMipsRelocs(name, instrs, asmData);
  }
  // TRUSTWORTHINESS: fail LOUD on a control transfer this frontend cannot model — the `opaque`
  // path cannot catch these (implicit or no register destination). `jal`/`jalr` clobber `v0`
  // implicitly, so dropping a call fabricates `v0` from a stale value; a `jr` to anything but `ra`
  // (jump table / computed goto) is not a plain return. Calls are a later milestone; until then
  // they are a catchable "out of scope" signal, mirroring the PPC frontend.
  for (const ins of instrs) {
    if (ins.mnemonic === 'jal' || ins.mnemonic === 'jalr') {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': function call '${ins.mnemonic}' at 0x${ins.addr.toString(16)} — MIPS calls not yet modelled`,
      );
    }
    if (ins.mnemonic === 'jr' && ins.ops[0] !== 'ra' && !recoveredJr.has(ins.addr)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': indirect jump 'jr ${ins.ops[0] ?? ''}' at 0x${ins.addr.toString(16)} — jump tables / tail calls not supported`,
      );
    }
    // CATCH-ALL (mirrors the PPC denylist): an unmodelled control-transfer mnemonic would otherwise
    // fall through to `emitOpaqueDest` and have its BRANCH silently dropped (no register dest for
    // the opaque guard to catch). Bites the branch-LIKELY forms (`beql`/`bnel`/`b*zl`, which annul
    // the delay slot when not taken) and coprocessor branches (`bc1t`/`bc1f`…). `break` is a trap,
    // not a branch.
    const isBranchish = (ins.mnemonic[0] === 'b' && ins.mnemonic !== 'break') || ins.mnemonic[0] === 'j';
    if (isBranchish && !isXfer(ins) && ins.mnemonic !== 'jal' && ins.mnemonic !== 'jalr') {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': unmodelled control transfer '${ins.mnemonic}' at 0x${ins.addr.toString(16)} ` +
          `— branch-likely / coprocessor branch not supported`,
      );
    }
  }
  const { blocks, succAddrs } = toBlocks(instrs, jts);
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

  // NO FRAME PARTITION IS CLAIMED, so every def-less slot read refuses (frontend/ssa.ts,
  // LiveInModel). This frontend has no frame bound at all — `addiu sp,sp,±N` is transparent and
  // every word sp-relative access becomes `sp@<rawOff>` — so its slot keys span O32's CALLER-owned
  // register-parameter home area and the incoming stack arguments above it, where a def-less read
  // is argument 5, not an uninitialised local.
  //
  // Claiming one needs the frame SIZE those offsets are measured against, which is not computed
  // here, plus ensureParam for the register half. The ranges themselves are known: O32 reserves
  // `[0,16)` as the caller-owned home area (in NEITHER range — caller-owned, but not an argument)
  // with stack arguments from 16 up, which is what `mips32be.cspec`'s `<localrange>` and stack
  // `<pentry offset="16">` encode.
  const ssa = makeSsaBuilder(name, blocks.length, preds);
  const { irBlocks, readVar, writeVar, paramReg } = ssa;
  const RET = target.returnReg;
  const ARG_REGS = target.argRegs;

  // The pending `%hi` halves of this function's global addresses, keyed by the SSA VALUE each `lui`
  // defines — see frontend/high-half.ts for why a register-keyed map cannot answer the question,
  // and frontend/ppc.ts for the other frontend folding the same invariant. FUNCTION-scoped, because
  // a value is: SSA is what decides whether a half reaches a given `%lo`, so a pair split across
  // blocks folds when the half provably reaches, and refuses when what arrives is the block
  // parameter standing for a merge.
  const highHalves = makeHighHalves({
    hi: '%hi',
    lo: '%lo',
    fail: (message) => {
      throw new FrontendUnsupportedError(message);
    },
  });

  // SOUNDNESS GUARD. The word stack-slot model (emitLoad/emitStore) is safe ONLY when every
  // sp-relative access in the function is word-width. If a SUB-WORD sp access aliases a word slot
  // (`sw a0,4(sp)` then `lbu v0,4(sp)`), routing the word store to an SSA slot while the sub-word
  // reload stays on the memory path DROPS the store and reads uninitialised memory — a silent
  // miscompile that ALSO masks the struct-overlap loud-fail (raise/structs.ts). So if ANY sub-word
  // sp access exists, disable slot-modelling for the whole function: everything sp-relative falls
  // back to the memory path, which loud-fails on a genuine overlap instead of miscompiling.
  const spSlotSafe = !instrs.some(
    (ins) =>
      SUBWORD_MEM.has(ins.mnemonic) && ins.ops.length > 0 && isStackPtr(parseMem(ins.ops[ins.ops.length - 1]).base),
  );

  // Hardware divide state (capabilities.hwDivide). MIPS `div`/`divu rs,rt` set the hi/lo pair
  // implicitly; a later `mflo`/`mfhi` reads the quotient/remainder. FUNCTION-scoped: GCC schedules
  // the `mflo` into a SEPARATE block after the trap-check branch (`bnez rt; break 7`), so a
  // block-local record would see `null` at the cross-block `mflo` and emit an opaque `?`. The div's
  // operand Values are SSA-global, so consuming them in a later block is sound. A `mult`/`multu`
  // overwrites the same hi/lo pair, so it clears this (below) — whichever divide/multiply ran most
  // recently owns the next `mf*`, the true hardware semantics.
  let divState: { rs: Value; rt: Value; signed: boolean } | null = null;

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
      // (`addiu a0,sp,8` = `&local`) — not modellable without a stack abstraction. Fabricating a
      // value for `sp` invents a PHANTOM leading parameter that shifts every real argument — a
      // silent miscompile. Fail LOUD instead, mirroring the PPC frontend's r1. Frame setup/teardown
      // (`addiu sp,sp,±N`) and word spill/reload slots are handled before `read`.
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
      // A register holding the high half of an address is NOT a value — `lui` defines only a
      // link-time placeholder, and in a relocatable object the immediate it printed is 0. Refuse
      // rather than hand back that 0 dressed as the program's answer. The legitimate consumers
      // (`addiu %lo`, a `%lo` load/store base) reach the half through `foldLoHalf` instead.
      return highHalves.guardRead(name, r, readVar(r, bi));
    };
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

    // Where a refusal about ONE INSTRUCTION starts, spelled exactly as frontend/ppc.ts spells it —
    // the artifact's decline text is read row by row across both ISAs.
    const site = (ins: Instr) => `cannot lift '${name}': '${ins.mnemonic}' at 0x${ins.addr.toString(16)}`;
    // Set by every case entitled to fold a relocation, cleared per instruction — see the choke
    // point at the end of `decode`.
    let relocTaken = false;
    // EVERY immediate this frontend turns into a value goes through here. objdump prints them as
    // numbers, so a non-numeric one means the operand is not an immediate at all — a relocation
    // spelling the reader failed to resolve, a label — and bare `parseImm` answers NaN, which
    // `constVal(NaN << 16)` and `constVal(NaN)` both render as the literal 0. That is the same
    // silent substitution the relocation fold exists to close, one level down, so it refuses.
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
      if (destReg(ins) === 'gp') {
        return;
      }
      switch (ins.mnemonic) {
        case 'nop':
          break;
        case 'move':
          write(d, read(s));
          break; // pseudo: addu/or rD,rS,zero
        case 'li':
          write(d, constVal(imm(ins, s)));
          break; // pseudo: load immediate
        // `lui rD, hi` loads the 16-bit immediate into the UPPER half (mirrors PPC `lis`). Alone it
        // is the high half of a 32-bit literal; the following `ori`/`addiu` supplies the low half
        // and raise/const.ts folds the const/const pair into one 32-bit const — the form that
        // recompiles to this exact `lui;ori`.
        case 'lui':
          // `lui rD, %hi(SYM)` is the HIGH HALF of a global's address. rD is defined as a
          // PLACEHOLDER value, not a number: in a relocatable object the immediate objdump printed
          // is 0, and the address lives in the relocation records. Every way that placeholder could
          // escape is closed in frontend/high-half.ts; the `gaddr` itself is emitted at the `%lo`
          // that completes the address. The MIPS half contributes `hi_imm << 16` to the addend —
          // MIPS relocations are REL, so the addend is in the fields (see attachMipsRelocs).
          if (ins.reloc?.type === 'R_MIPS_HI16') {
            relocTaken = true;
            const hi = mkValue(T.unk(32));
            highHalves.record(hi, {
              sym: ins.reloc.sym,
              addend: imm(ins, s ?? '0') << 16,
              addr: ins.addr,
              mnemonic: ins.mnemonic,
              consumed: false,
            });
            write(d, hi);
            break;
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
          // `addiu rD, rHi, %lo(SYM)` completes a global's address begun by a `lui %hi(SYM)`:
          // rD = &SYM (+ a byte offset into it). Emits the shared `gaddr` op.
          if (ins.reloc?.type === 'R_MIPS_LO16') {
            const { base: g, off } = foldLoHalf(ins, s, imm(ins, t));
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
        case 'add':
          emitBin('add', d, read(s), read(t));
          break;
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
        default:
          emitOpaqueDest(ins);
          break; // unmodelled: an honest opaque, never a silent drop
      }
      // THE CHOKE POINT (mirrors the PPC frontend). Everything above either folded the relocation or
      // threw; one still sitting here was DROPPED, and a dropped relocation leaves the immediate
      // objdump printed — the literal 0 — standing in for the address. That is the forbidden class:
      // it compiles, so nothing downstream ever complains. An unmodelled `%lo` consumer (`lwc1`,
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
      // THE RELOCATION FIRST. An unmodelled `%lo` consumer (`lwc1`, `swc1`) reaches here, and
      // `opaqueDest` would refuse it for the lesser reason — "no register destination" — or, for a
      // form that HAS one, degrade it to an opaque and lose the global access with it. Naming the
      // relocation is what tells a reader which capability is missing.
      if (ins.reloc) {
        relocPlaceholder(ins);
      }
      // storeClass: unmodelled MIPS stores — incl. the unaligned pair swl/swr and the FPU stores,
      // whose FIRST token is a register (a SOURCE, not a dest) that would otherwise fabricate an
      // opaque write to it while dropping the real memory write.
      // skipSafe `break`: the compiler-emitted divide-by-zero guard trap inside the hw-divide
      // idiom (KMC GCC `break 0x7`); recompiling the recovered `/` regenerates it, so it is
      // transparent by the same modelling as the divide itself (byte-exactness proven by the
      // hw-divide suites). Any other no-destination effect (syscall, cache, sync) throws.
      const od = opaqueDest(ins.mnemonic, ins.ops, {
        isReg: isMipsReg,
        isZero,
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
    // `%lo` completes the address a `lui %hi` began. THE PAIRING IS A PROOF, not a guess: the value
    // `rHi` holds HERE must be the very placeholder a `lui` defined, and both relocations must name
    // the same symbol. `readVar` — not `read`, which refuses a half — is what answers, so a pair
    // separated by unrelated instructions folds while a register reused between the halves does not,
    // and a half that reaches only through a merge or a loop header arrives as the block parameter
    // standing for the join, which is not a half and refuses.
    const foldLoHalf = (ins: Instr, rHi: string, loImm: number): { base: Value; off: number } => {
      relocTaken = true;
      const lo = ins.reloc!;
      const hi = highHalves.get(readVar(rHi, bi));
      if (!hi || hi.sym !== lo.sym) {
        throw new FrontendUnsupportedError(
          `${site(ins)} carries the '%lo' half of ` +
            `'${lo.sym}' but ${rHi} ` +
            (hi
              ? `holds the high half of '${hi.sym}'`
              : `holds no high half here — a reused register, a missing '%hi', or a '%hi' that reaches ` +
                `this instruction only through a merge or a loop header, where what the register holds ` +
                `is the block parameter standing for the join and not the half`) +
            ` — this frontend will not guess at the pair`,
        );
      }
      // The addend is split across the two instruction immediates because MIPS is REL.
      const off = hi.addend + loImm;
      if (off < 0) {
        throw new FrontendUnsupportedError(
          `${site(ins)} completes '${lo.sym}' at ` +
            `byte offset ${off} — an address BELOW the symbol (an index-biased array base) is not yet modelled`,
        );
      }
      hi.consumed = true;
      return { base: emitGaddr(lo.sym), off };
    };
    // A displacement memory operand whose base is a `%hi` half: resolve it to the global's address
    // plus the access offset. A non-`%lo` instruction returns null (the caller falls through to the
    // ordinary `off(base)` path).
    const globalBase = (ins: Instr, mem: string): { base: Value; off: number } | null => {
      if (ins.reloc?.type !== 'R_MIPS_LO16') {
        return null;
      }
      const { off, base } = parseMem(mem);
      return foldLoHalf(ins, base, off);
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
      // A word reload from a stack slot is transparent to dataflow — the SAME value spilled — so
      // route it through the slot SSA variable, not a `load` through `sp` (which would make `sp` a
      // spurious pointer parameter). Compiler spills/reloads are always word-width; sub-word `sp`
      // access is not spill output, so it stays on the memory path.
      if (spSlotSafe && isStackPtr(base) && width === 4) {
        // SOUNDNESS GUARD (mirrors PPC frameLoad): only route through the slot SSA var if that slot was
        // actually STORED (has a reaching def). A word `lw` from an sp offset that was NEVER spilled is an
        // incoming STACK-PASSED argument (5th+ param, O32) or an uninitialised local — neither modelled.
        // Without this, readVar would FABRICATE a phantom entry parameter for the slot, silently emitting a
        // function of wrong arity that returns the wrong argument. Loud-fail instead of miscompiling.
        //
        // Those two cases are SEPARABLE, and the Thumb frontend now separates them (frontend/thumb.ts,
        // incomingArgIndex): a slot at or above the callee's own frame cannot have been written by this
        // function, so it is an incoming argument; below the frame top it is a local. Doing the same here
        // needs O32's own frame rule — the 16-byte home area means a stack argument is NOT simply "above
        // the frame", so the Thumb arithmetic does not carry over — plus ssa.ensureParam for the register
        // half. Until then this stays one loud decline for both.
        if (!ssa.hasReachingDef(stackSlot(off), bi)) {
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
      // A word spill to a stack slot (an argument home slot `sw a0,0(sp)`, or a local): record the
      // slot's value in SSA, do NOT emit a `store` through `sp`. A never-reloaded spill (the ABI
      // home-slot store) then has no uses and simply drops. See isStackPtr / spSlotSafe.
      if (spSlotSafe && isStackPtr(base) && width === 4) {
        writeVar(stackSlot(off), bi, read(srcReg));
        return;
      }
      ops.push(mkOp('store', { operands: [read(base), read(srcReg)], attrs: { off, width } }));
    };

    for (const ins of b.body) {
      decode(ins);
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

    // Recovered dense switch: run the `beqz` delay slot first — on IDO it computes the DEFAULT
    // return value (`li v0,-1`, read by the default block); on KMC it is the now-dead index shift —
    // then dispatch a `switch_br` over the scrutinee (N case blocks, dense 0..N-1, + default).
    const jt = br ? jts.get(br.addr) : undefined;
    if (jt) {
      if (b.delay) {
        decode(b.delay);
      }
      pushSwitchBr(ops, readVar(jt.scrutReg, bi), [...jt.caseAddrs, jt.defaultAddr].map(succ));
      return;
    }

    if (br && isCond(br)) {
      const cond = condValue(br, ops, read, constVal, cmpDef);
      if (b.delay) {
        decode(b.delay);
      }
      const fall = (b.delay ? b.delay.addr : br.addr) + 4;
      ops.push(mkOp('cond_br', { operands: [cond], successors: [succ(br.target!), succ(fall)] }));
      return;
    }
    if (b.delay) {
      decode(b.delay);
    } // unconditional / return: delay slot just executes first

    if (!br || isReturn(br)) {
      // A HIGH HALF IN v0 IS NOT A RETURN VALUE. `v0` is both MIPS's return register and the
      // register IDO most often parks a `lui %hi` base in, so a VOID function routinely ends with a
      // half still sitting there (`lui v0,%hi(g); lw v1,%lo(g)(v0); … ; sw v1,%lo(g)(v0)`). Counting
      // that def would make the function return the placeholder; rejecting it gives the honest void
      // return. PowerPC needs no such predicate here — `r3` is not mwcc's habitual `lis` base — but
      // it passes the same one to its call-arity count, for the same reason.
      const retOps = ssa.hasReachingDef(RET, bi, (v) => !highHalves.has(v)) ? [readVar(RET, bi)] : [];
      if (!br) {
        ops.push(mkOp('br', { successors: [succ(succAddrs.get(b)![0])] }));
      } // fall-through
      else {
        ops.push(mkOp('ret', { operands: retOps }));
      }
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
  ssa.finish();
  highHalves.assertNoneEscaped(name, irBlocks);

  // ABI-ordered entry parameters (a0, a1, …) — a callee-saved copy can read a later argument
  // register first. Only the true entry (no predecessors) is sorted; a loop header's phis are
  // index-aligned with predecessor args and must not be reordered.
  const entry = irBlocks[0];
  // non-ABI live-in ranks FIRST (indexOf's -1) — deliberate MIPS/PPC tie-break; Thumb's is 99/last
  abiSortEntryParams(entry, preds[0].length > 0, (v) => ARG_REGS.indexOf(paramReg.get(v) ?? ''));
  return ssa.fn;
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
