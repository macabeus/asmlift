// asmlift ISA frontend — ARMv4T / Thumb (agbcc). Decode GNU-as text → CFG of basic
// blocks → L1 with multi-block SSA via Braun et al. 2013 ("Simple and Efficient
// Construction of SSA Form"), emitting block-arguments at joins.
//
// `cmp`+`b<cond>` become `cond_br` over a real join. Loops: a back-edge target is read
// before its back-edge predecessor is filled, so Braun's incomplete-phi + sealBlock
// schedule handles it — a block's phis are wired only once all its predecessors are
// filled. Trivial phis (one real operand) are removed afterwards so a loop-invariant
// register does not leak a spurious block parameter.
//
// Callee-saved stack frames: `push`/`pop` (and the `pop {rN}; bx rN` return idiom) are
// transparent to dataflow — the pushed registers are restored to the same values, and a
// callee-saved register is always written in the body before it is read — so no explicit
// modelling is needed; they simply fall through the decode/fill switch. Because agbcc may
// copy a callee-saved argument (e.g. into r4) before touching r0, entry parameters are
// ordered by ABI register (r0, r1, …), not by the order they were first read.
import { Block, Fn, Op, Successor, Value, mkOp, mkValue } from '../ir/core';
import type { Opcode } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Prototypes, protoArity } from '../proto';
import { RUNTIME_HELPERS } from '../raise/softdiv';
import { type SymbolMap, lookupInterior, lookupSymbol } from '../symbols';
import type { TargetDescription } from '../target';
import type { AsmData } from './asmdata';
import { pushSwitchBr } from './emit';
import { FrontendUnsupportedError } from './errors';
import { assertInputFormat } from './format';
import type { Frontend } from './frontend';
import { opaqueDest } from './opaque';
import { abiSortEntryParams, fallbackArgc, makeSsaBuilder, slotKeyOffset, stackSlotKey } from './ssa';

interface Instr {
  /** the CANONICAL spelling — legacy names are normalised (see LEGACY_MNEMONICS) so that every
   *  consumer matches one name. */
  mnemonic: string;
  ops: string[];
  /** the spelling the input file actually used, present only when normalisation changed it.
   *  Messages must use this: a decline naming `ldrsh` for a file containing `ldsh` sends the
   *  reader looking for an instruction that is not there. */
  asWritten?: string;
}
interface AsmBlock {
  label: string;
  instrs: Instr[];
}

// Alternative mnemonic spellings, normalised at the single point where an instruction enters the
// IR. Each maps to a name the decode switch below already handles.
//
// These are not "similar" instructions — each pair is ONE instruction with two accepted spellings.
// The ARM7TDMI Technical Reference Manual (ARM DDI 0029G) gives a single encoding for each:
// Figure 1-6 "Thumb instruction set formats" lists Format 08 "Load and store sign-extended byte and
// halfword" (0101 H S 1 Ro Rb Rd) and Format 15 "Multiple load and store" (1100 L Rb Rlist), and
// Table 1-7 "Thumb instruction set summary" spells them `LDRSH Rd, [Rb, Ro]`, `LDRSB Rd, [Rb, Ro]`,
// `LDMIA Rb!, <reglist>` and `STMIA Rb!, <reglist>`. Older ARM7TDMI documentation used LDSH/LDSB,
// which is where the short spellings come from; the stack-suffix forms (FD, EA) are the same
// instructions named after the stack discipline they implement.
//
// Confirmed with this project's own toolchain — same encoding, and gba-kit executes them with the
// same architectural effect (sign extension, transfers, base writeback):
//
//     ldsh  / ldrsh        885e / 885e        ldm   / ldmia / ldmfd   01c9 / 01c9 / 01c9
//     ldsb  / ldrsb        8856 / 8856        stm   / stmia / stmea   01c1 / 01c1 / 01c1
//
// Measured on the Klonoa: Empire of Dreams disassembly (luvdis, 469 .s files): `ldsh` 292 and
// `ldsb` 180 against `ldrsh` 0 and `ldrsb` 12 — the same tool emits both spellings for the signed
// byte load — and `ldm` 12 / `stm` 34 against `ldmia` 0 / `stmia` 0. The UAL names this frontend
// cased for the multiple forms never appear in that corpus at all.
//
// These are PURE SYNONYMS — identical operands — which is why they belong in a table here rather
// than in decode arms like MIPS's `move` or PPC's `slwi`. That distinction, and why there is no
// shared alias helper across the three frontends, is written up once in ./opaque.ts.
//
// This table is about COVERAGE, not soundness: a spelling missing from it declines loudly like any
// other unmodelled instruction, and listing one buys that the function LIFTS instead. Every load
// spelling ARMv4T Thumb accepts is listed, because declining a whole function over a synonym is a
// poor trade. Note what may NOT justify an omission: "`as` rejects it, so it cannot appear". This
// frontend parses TEXT — from luvdis/objdump/IDA/Ghidra and hand-written .s — so what some
// assembler accepts says nothing about what it will be handed.
//
// `stmfd` is deliberately absent, and the asymmetry is real rather than an oversight: `stmfd` IS
// `stmdb` (decrement-before), and ARMv4T Thumb has no decrement-before store — so there is nothing
// to normalise it TO. A fact about the instruction set, not about an assembler. It declines.
//
// Null-prototype so that an inherited key (`constructor`, `toString`) cannot be mistaken for an
// entry. Unreachable from real assembly, but the lookup should not depend on that.
const LEGACY_MNEMONICS: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  ldsh: 'ldrsh',
  ldsb: 'ldrsb',
  ldm: 'ldmia',
  ldmfd: 'ldmia',
  stm: 'stmia',
  stmea: 'stmia',
});

// An offset far above the frame cannot be an argument — agbcc passes at most a handful on the
// stack, and an absurd index would mint a signature with hundreds of parameters from one bad
// offset. 16 is well past any real agbcc call and still refuses nonsense loudly.
//
// It bounds TOTAL arity, register arguments included (12 stack slots on a 4-register ABI), because
// that is the unit the index it is compared against is counted in. A refusal bound, not an ABI
// fact: nothing may read it as a statement about how many arguments the convention allows.
const MAX_RECOVERED_ARITY = 16;

function canonicalMnemonic(mn: string): string {
  return LEGACY_MNEMONICS[mn] ?? mn;
}

// Map a Thumb conditional-branch mnemonic to the icmp opcode for "branch taken". The signed forms
// (`blt`/`ble`/`bgt`/`bge`) follow a signed `cmp`; the UNSIGNED forms carry the carry/borrow sense:
// `bhi` = unsigned > (higher), `bls` = unsigned <= (lower-or-same), `bcc`/`blo` = unsigned <
// (carry-clear / lower), `bcs`/`bhs` = unsigned >= (carry-set / higher-or-same).
const COND_OPCODE: Record<string, Opcode> = {
  beq: 'icmp_eq',
  bne: 'icmp_ne',
  blt: 'icmp_slt',
  ble: 'icmp_sle',
  bgt: 'icmp_sgt',
  bge: 'icmp_sge',
  bhi: 'icmp_ugt',
  bls: 'icmp_ule',
  bcc: 'icmp_ult',
  blo: 'icmp_ult',
  bcs: 'icmp_uge',
  bhs: 'icmp_uge',
};

// Classify a block-terminating control transfer, or `null` for a non-transfer instruction (the block
// falls through). The SINGLE source of truth for "what ends a Thumb block and how", used by decode
// (block splitting), succLabels (CFG edges), the fill loop (skip transfers), and the terminator
// emitter — so a transfer form can't be modelled in one place and missed in another. A return via a
// restored link register is distinguished from a COMPUTED/loaded PC write (jump table / computed
// goto / register tail call), which this frontend does not model and must LOUD-FAIL rather than
// silently drop — mirroring the MIPS `jr` and PPC `bctr` guards. (agbcc dispatches a dense switch
// via `mov pc, rN`.)
type XferKind = 'return' | 'uncond' | 'cond' | 'indirect';
function classifyXfer(ins: Instr): XferKind | null {
  const mn = ins.mnemonic;
  if (mn === 'b') {
    return 'uncond';
  }
  if (COND_OPCODE[mn]) {
    return 'cond';
  }
  // `bx rN`: agbcc's return is `bx lr` or `pop {rN}; bx rN` (rN holds the restored LR) — a return.
  // (agbcc emits jump tables via `mov pc`, NOT `bx`; a computed tail-call `bx rN` is out of scope and
  // would need call modelling — accepted limitation, not a jump-table dispatch form.)
  if (mn === 'bx') {
    return 'return';
  }
  // A write to PC is a control transfer. `mov pc, lr` restores the link register → return; any other
  // computed/loaded PC write (`mov pc, rN` rN≠lr, `ldr pc, …`, `add/sub pc, …`) is an indirect jump.
  //
  // BY REGISTER, NOT BY ALIAS. `pc` and `r15` are one register, and `readData` already says so; here
  // the alias decides CONTROL FLOW, so missing it does not degrade — the write is not a transfer at
  // all, the terminator never forms, and execution runs on into the next block. `mov r15, lr` mid
  // function deleted the early return outright AND minted a phantom parameter for the `lr` read that
  // was left behind, with no diagnostic. `lr`/`r14` is the same question one operand over, and it is
  // the safe half: missing it reads as an indirect jump, which declines loud.
  const dest = ins.ops[0]?.replace(/[[\]]/g, '');
  if (dest === 'pc' || dest === 'r15') {
    if ((mn === 'mov' || mn === 'movs') && (ins.ops[1] === 'lr' || ins.ops[1] === 'r14')) {
      return 'return';
    }
    return 'indirect';
  }
  // `pop {…, pc}` restores the saved LR into PC → return. `ldmia rN!, {…, pc}` is a return iff the base
  // is sp (a stack unwind); any other base is a computed multi-load jump → indirect. The register
  // list is EXPANDED first, so `pc` inside a fused range (`{r4-pc}`) is seen — an unexpanded
  // detection silently deleted the return.
  const popsPc =
    (mn === 'pop' || mn === 'ldmia' || mn === 'ldmfd') &&
    expandRegList(
      ins.ops
        .join(' ')
        .replace(/[{}!]/g, '')
        .split(/[,\s]+/)
        .filter(Boolean),
    ).includes('pc');
  if (popsPc) {
    if (mn === 'pop') {
      return 'return';
    }
    return ins.ops[0]?.replace(/!$/, '') === 'sp' ? 'return' : 'indirect';
  }
  return null;
}

// A raw immediate's value. Case-insensitive on the radix because gas accepts `0X` and `parseInt`
// with the wrong one reads `#0X1` as 0 — see `immEq` below for why this stays loose about binary,
// octal and expressions, and which callers therefore have to refuse rather than ask this.
const imm = (s: string) => parseInt(s.replace(/^#/, ''), /0[xX]/.test(s) ? 16 : 10);

// AN IMMEDIATE IS A NUMBER, NOT A SPELLING, and which spelling appears is the producer's choice
// rather than the machine's. Counting the gated shapes (`add`/`rsb rD, rS, #0`) over the vendored
// checkouts, every producer writes `#0` — sa3's split 11158, sa3's build 9837, klonoa's build 1072,
// and `#0x0` not once between them — EXCEPT klonoa's own disassembly, which writes `#0x0` 3533
// times against 36. So an idiom keyed on the token is off for one whole project in silence, which
// is what this predicate exists to stop. `#2`, `#0x2` and `#0x02` are likewise one shift, and the
// jump-table shift recogniser used to compare the operand text and so rejected the third.
//
// The operand must be a plain integer LITERAL, and that shape check is the whole point of this
// helper rather than an incidental guard. `imm()` is `parseInt`, which stops at the first character
// it cannot consume — `#0b1` and `#0.5` read as 0, `#010` as 10 where gas means 8 — and it reads
// `#2*2` as 2, which is not malformed but an expression gas
// accepts and assembles to `lsls r0, r1, #4`. Matching it as a shift by two would recover a switch
// whose stride is wrong by a factor of four: the emitted C is entirely ordinary and dispatches to
// the wrong BLOCK, with no marker. `#2+1`, `#2-1` and `#2<<1` are the same trap. An adversarial
// probe found this after the first cut of this helper shipped with exactly that hole, and the test
// that claimed to pin the property sampled only `#3`/`#0x3`/`#0x1`/`r2` and so passed anyway.
//
// Anything that is not a bare decimal or hex literal therefore fails this test — which is a
// DECLINE only where the caller declines, and the three callers differ. The jump-table recogniser
// returns null; the `add` and `rsb` copy/negate arms fall through to their own lowering, and for
// `add`/`sub` that lowering is `constVal(imm(…))`, which is loose. So a non-match is a refusal at
// two of the three sites and a possibly-wrong constant at the third; `#0b1` renders `+ 0` there.
// The hole is `imm`'s rather than this predicate's, and a characterization test pins it.
//
// The refused class that DOES occur is the signed literal: 722 negative immediates across the
// corpus (`#-0x4` ×287, `#-0x004`, …), all of them inert here because neither 0 nor 2 is negative —
// but `imm` reads them correctly and this does not, so the two disagree on a populated class and a
// future `want` has to know that.
//
// One divergence is knowingly left in, and it is inert at both values this is used with.
// A leading zero means octal to gas and decimal to `Number`, so `#010` is 8 there and 10 here —
// but for `want === 2` both readings fail and the dispatch declines either way, and for
// `want === 0` every octal spelling of zero (`#0`, `#00`, `#000`) is zero under both. A `want`
// other than those two has to revisit this, because for e.g. `want === 8` the readings disagree.
const IMM_LITERAL = /^#\s*(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;
const immEq = (op: string | undefined, want: number): boolean =>
  op !== undefined && IMM_LITERAL.test(op) && Number(op.slice(1).trim()) === want;

// Expand fused register-range tokens (`r4-r7` → r4,r5,r6,r7) in a register list. Ranges are
// numeric-endpoint only (`rN-rM`); a range whose endpoint is an ALIAS (`r4-pc`/`-lr`/`-sp`) is
// ambiguous and left UNEXPANDED — but its endpoints ARE surfaced as separate tokens so pc/lr
// detection sees them, and any consumer that needs the exact list rejects the leftover `-` token
// loudly rather than treating the fused range as one phantom register.
// Null-prototype for the same reason LEGACY_MNEMONICS has one: this table is consulted with `in`
// to decide whether a reglist token is a DEFINITE register, and an inherited key (`constructor`,
// `toString`) answering true would let a junk token pass that test instead of poisoning the frame
// depth. Unreachable from real assembly; the guarantee should not depend on that.
const REG_NUM: Record<string, number> = Object.assign(Object.create(null), { sp: 13, lr: 14, pc: 15 });

// Registers Thumb-1's `push` cannot name, in every spelling this ISA's asm uses for them. Saving
// one takes agbcc's `mov rLow, rHi; push {rLow}`, which is why the prologue's save set has to read
// the `mov` as well as the list (see `savedRegs`). Spellings, not numbers: nothing here normalises
// a register name, so `sl` and `r10` are separate keys everywhere the frontend uses one.
const HIGH_REGS: ReadonlySet<string> = new Set(['r8', 'r9', 'r10', 'r11', 'r12', 'sb', 'sl', 'fp', 'ip']);

// Thumb-1 data-processing mnemonics that write the condition flags when their destination is a LOW
// register — which is all of them on this ISA, `s`-suffix or not (the assembler picks the encoding).
// Used to invalidate a pending compare: see the decode loop. `cmp`/`cmn`/`tst` are absent on purpose
// — they set flags but define no register, and `cmp` is the very instruction that seeds the pending
// compare. Loads, stores, push/pop, `bl` and the high-register forms leave the flags alone.
const FLAG_SETTING = new Set([
  'mov',
  'movs',
  'add',
  'adds',
  'sub',
  'subs',
  'lsl',
  'lsls',
  'lsr',
  'lsrs',
  'asr',
  'asrs',
  'neg',
  'negs',
  'rsb',
  'rsbs',
  'mvn',
  'mvns',
  'bic',
  'bics',
  'ror',
  'rors',
  'mul',
  'muls',
  'and',
  'ands',
  'orr',
  'orrs',
  'eor',
  'eors',
  'adc',
  'adcs',
  'sbc',
  'sbcs',
]);
const regNum = (r: string) => (r[0] === 'r' ? Number(r.slice(1)) : REG_NUM[r]);
function expandRegList(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const dash = t.indexOf('-');
    if (dash === -1) {
      out.push(t);
      continue;
    }
    const lo = t.slice(0, dash);
    const hi = t.slice(dash + 1);
    const a = regNum(lo);
    const b = regNum(hi);
    if (/^r\d+$/.test(lo) && /^r\d+$/.test(hi) && Number.isFinite(a) && Number.isFinite(b) && a <= b) {
      for (let i = a; i <= b; i++) {
        out.push(`r${i}`);
      }
    } else {
      // alias-endpoint or malformed range: surface both endpoints (so pc/lr is visible) AND keep
      // the raw token (so a list consumer sees the unexpanded `-` and declines).
      out.push(lo, hi, t);
    }
  }
  return out;
}

// Expand a register list and vouch that every entry is a DEFINITE register, or return null.
//
// The two consumers tokenize differently (the ldm/stm arm has a base register to slice off, the
// frame walk does not), so each keeps its own tokenizing — but the VALIDATION has to be one
// function, because the two hand-rolled versions had drifted to unequal strength. The frame walk
// required every token to be a real register; the ldm/stm arm only rejected a leftover `-`, so
// `ldmia r1!, {foo}` lifted and emitted `s32 f(s32 a0, s32 a1) { return a0; }` — a parameter
// fabricated from a token that names no register, which is the phantom this frontend's guards
// exist to prevent.
//
// An unexpandable range leaves its raw `-` token (see expandRegList) and fails here; so does an
// unknown alias, which a `Number.isNaN(regNum(t))` test would MISS, since regNum returns undefined
// for one and `Number.isNaN(undefined)` is false. An empty list is a malformed list, not an empty
// transfer. Lowercase-only is deliberate and free: an uppercase mnemonic declines as unmodelled
// long before either consumer runs.
function definiteRegList(tokens: string[]): string[] | null {
  const list = expandRegList(tokens);
  if (list.length === 0) {
    return null;
  }
  return list.every((s) => /^r\d+$/.test(s) || s in REG_NUM) ? list : null;
}

// Split an operand list on commas that are NOT inside brackets, so a memory operand like
// `[r0, #0x8]` (base + offset) stays a single token instead of being torn at its comma.
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0,
    cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out;
}

// Parse a Thumb memory addressing operand `[base]` or `[base, #off]` into base register +
// constant byte offset. (Register-scaled indices like `[base, r1, lsl #2]` are not handled
// yet — agbcc materialises those as explicit add/lsl before the load in the cases we target.)
function parseAddr(operand: string): { base: string; off: number; regOff?: string } {
  const inner = operand.replace(/[[\]]/g, '').trim();
  const parts = inner.split(',').map((s) => s.trim());
  const base = parts[0];
  // `[rB, rX]` — REGISTER-offset addressing. Surfaced to the caller so load/store DECLINE
  // loud: silently reading `[rB]` (the old behavior) dropped the index — a silent miscompile.
  if (parts[1] !== undefined && !parts[1].startsWith('#')) {
    return { base, off: 0, regOff: parts[1] };
  }
  const off = parts[1]?.startsWith('#') ? imm(parts[1]) : 0;
  return { base, off };
}

/** Parse one function's GNU-as text into labelled basic blocks + the CFG, plus the inline `.word`
 *  data tables (label → the list of label operands under it) — the jump-table target arrays agbcc
 *  emits in `.text` (Regime B). Non-`.word` directives are skipped, EXCEPT sub-word data
 *  directives, which fail loud: disassembler-extracted asm (pret projects' `.s` splits) spells
 *  raw undecoded instructions as `.2byte 0xD101` — skipping one would silently delete a branch.
 *
 *  Two input dialects share this parser: agbcc compiler output (`.thumb_func` + `.L` labels) and
 *  pret-project splits (luvdis-extracted: `thumb_func_start NAME` macros, `_08xxxxxx` labels,
 *  `LABEL: .4byte VALUE` literal pools on one line). The pret function macros are bookkeeping
 *  (they expand to `.align`/`.global`/`.thumb_func`/`.type`) except for the mode they declare:
 *  `arm_func_start` marks an ARM-mode body this Thumb frontend must refuse to lift. */
interface FlatItem {
  label?: string;
  instr?: Instr;
  /** a data directive's payload, kept in-stream so byte layout is computable */
  data?: { halfwords: boolean; values: string[]; inCode: boolean };
}

function decode(name: string, asm: string): { blocks: AsmBlock[]; dataWords: Map<string, string[]> } {
  // Flatten to (label | instr | data) items, then split into blocks at labels / after branches.
  // `.word LABEL` directives are captured into dataWords keyed by the most recent label (the
  // jump table); ALL word/halfword data also stays in-stream as items, so the raw-halfword and
  // pc-relative resolution below can compute byte-accurate layout.
  let flat: FlatItem[] = [];
  const dataWords = new Map<string, string[]>();
  const funcLabels: string[] = []; // labels marked as function starts (.thumb_func / pret macros)
  const armLabels = new Set<string>(); // function starts declared ARM-mode (arm_func_start)
  const subwordData = new Map<string, string>(); // label → sub-word data directive under it
  // Directives whose byte size we cannot know, recorded by allFlat POSITION so the layout check
  // is scoped to the SELECTED function's slice — a `.align` between two functions must not
  // poison a sibling that needs byte-accurate layout.
  const hazards: { at: number; what: string }[] = [];
  let dataLabel: string | null = null;
  let pendingFn = false;
  let pendingArm = false;
  for (const rawLine of asm.split('\n')) {
    let rest = rawLine.split('@')[0].trim();
    if (!rest) {
      continue;
    }
    // A label may share the line with what follows it (pret pools: `_08x: .4byte 0x…`) — peel it.
    const lm = rest.match(/^([A-Za-z_.$][\w.$]*):\s*(.*)$/);
    if (lm) {
      const lab = lm[1];
      if (pendingFn || pendingArm) {
        funcLabels.push(lab);
        if (pendingArm) {
          armLabels.add(lab);
        }
        pendingFn = pendingArm = false;
      }
      dataLabel = lab;
      flat.push({ label: lab });
      rest = lm[2];
      if (!rest) {
        continue;
      }
    }
    if (rest.startsWith('.')) {
      if (rest === '.thumb_func') {
        pendingFn = true;
      }
      const wm = rest.match(/^\.(word|4byte|long)\s+(.+)$/);
      if (wm) {
        const values = wm[2].split(',').map((w) => w.trim()); // one-per-line and comma lists
        if (dataLabel) {
          const arr = dataWords.get(dataLabel) ?? dataWords.set(dataLabel, []).get(dataLabel)!;
          arr.push(...values);
        }
        flat.push({ data: { halfwords: false, values, inCode: dataLabel === null } });
        continue;
      }
      const hw = rest.match(/^\.(2byte|hword|short)\s+(.+)$/);
      if (hw) {
        // In the instruction stream these are raw undecoded instructions (luvdis emits branches
        // this way) — kept as items and DECODED (or declined) below. Under a label: a sub-word
        // data table — declines below iff the selected function references it.
        if (dataLabel !== null) {
          subwordData.set(dataLabel, hw[1]);
        }
        flat.push({
          data: { halfwords: true, values: hw[2].split(',').map((w) => w.trim()), inCode: dataLabel === null },
        });
        continue;
      }
      const raw = rest.match(
        /^\.(byte|ascii|asciz|string|space|skip|quad|8byte|octa|double|float|single|incbin|fill|zero)\b/,
      );
      if (raw) {
        if (dataLabel === null) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': raw data directive '.${raw[1]}' in the code stream — ` +
              `it may encode an instruction the disassembler left undecoded (skipping it would silently delete its effect)`,
          );
        }
        subwordData.set(dataLabel, raw[1]);
        hazards.push({ at: flat.length - 1, what: `.${raw[1]}` }); // byte size unknown / non-word
        continue;
      }
      if (/^\.align\b/.test(rest)) {
        hazards.push({ at: flat.length - 1, what: '.align' });
      }
      continue; // other directives skipped
    }
    // pret function macros (asm/macros.inc): pure bookkeeping except the declared mode.
    const macro = rest.match(/^(non_word_aligned_thumb_func_start|thumb_func_start|arm_func_start)\s+\S+$/);
    if (macro) {
      pendingFn = macro[1] !== 'arm_func_start';
      pendingArm = macro[1] === 'arm_func_start';
      continue;
    }
    if (/^(thumb_func_end|arm_func_end)\b/.test(rest)) {
      continue;
    }
    const m = rest.match(/^(\w+)\s*(.*)$/);
    if (!m) {
      continue;
    }
    dataLabel = null; // a real instruction ends a data run
    const canon = canonicalMnemonic(m[1]);
    flat.push({
      instr: {
        mnemonic: canon,
        ops: m[2] ? splitOperands(m[2]) : [],
        ...(canon === m[1] ? {} : { asWritten: m[1] }),
      },
    });
  }
  if (
    armLabels.has(name) ||
    (funcLabels.length === 1 && armLabels.has(funcLabels[0]) && !flat.some((f) => f.label === name))
  ) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': ARM-mode function (arm_func_start) — this frontend lifts Thumb only`,
    );
  }

  // FUNCTION SELECTION. `.thumb_func`-marked labels are function starts; when any exist, the
  // requested `name` must resolve to exactly one of them and the text is sliced to it — emitting
  // some OTHER symbol's body under `name` is precisely the silent miscompile the cardinal rule
  // forbids. A fragment with no `.thumb_func` markers is lifted whole, as a single body.
  //
  // A slice may END without a terminator because the function genuinely FALLS THROUGH into the
  // next `.thumb_func` entry (a shared tail — splitters mark the tail as its own function). The
  // build below then retries with the slice extended through that next function: the machine
  // code executed IS the continuation, so including it is the faithful lift. Falling into an
  // ARM-mode function declines.
  const allFlat = flat;
  let sliceStart = 0;
  let boundaries: number[] = [allFlat.length];
  if (funcLabels.length > 0) {
    const fi = funcLabels.indexOf(name);
    if (fi !== -1) {
      sliceStart = allFlat.findIndex((f) => f.label === name);
      const starts = funcLabels
        .map((l) => allFlat.findIndex((f) => f.label === l))
        .filter((s) => s > sliceStart)
        .sort((a, b) => a - b);
      boundaries = [...starts, allFlat.length];
    } else if (funcLabels.length >= 2) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': not a function label in this asm (functions present: ${funcLabels.join(', ')})`,
      );
    } else if (allFlat.some((f) => f.label === name)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': '${name}' is a label here but not a function (the function is '${funcLabels[0]}')`,
      );
    } else {
      // `name` absent entirely + exactly one function: an intentional rename of that function —
      // slice from its start so preceding data labels never masquerade as its code.
      sliceStart = allFlat.findIndex((f) => f.label === funcLabels[0]);
      boundaries = [allFlat.length];
    }
  }
  let boundaryIdx = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    flat = allFlat.slice(sliceStart, boundaries[boundaryIdx]);

    // Sub-word data tables are unmodelled: lifting a load through one fabricates values (the old
    // silent-skip emitted wrong-but-compiling code). Decline iff the SELECTED code reaches such a
    // table — via a direct label operand, or via a literal-pool word naming the table's symbol.
    if (subwordData.size > 0) {
      const reachable = new Set<string>();
      const labelShape = /^([A-Za-z_.$][\w.$]*)/;
      for (const f of flat) {
        if (f.label && dataWords.has(f.label)) {
          for (const w of dataWords.get(f.label)!) {
            const wm = w.match(labelShape);
            if (wm) {
              reachable.add(wm[1]);
            }
          }
        }
        for (const op of f.instr?.ops ?? []) {
          const om = op.match(labelShape);
          if (om) {
            reachable.add(om[1]);
          }
        }
      }
      for (const [lab, directive] of subwordData) {
        if (reachable.has(lab)) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': reads the sub-word data table '${lab}' (.${directive}) — sub-word table data is not modelled`,
          );
        }
      }
    }

    // ── luvdis raw-encoding mode ─────────────────────────────────────────────────────────────
    // Disassembler-extracted splits carry two things only byte-accurate LAYOUT can resolve:
    // raw branch halfwords (`.2byte 0xD10E` — the target exists only as an encoded offset) and
    // pc-relative literal loads (`ldr rD, [pc, #off]` into an unlabelled pool). Both are decoded
    // here against computed byte offsets and rewritten into the labelled forms the rest of the
    // frontend already models; anything the decoder cannot prove declines loud.
    const isPcRelLdr = (ins?: Instr) =>
      ins?.mnemonic === 'ldr' && /^\[pc,\s*#(0x[0-9a-fA-F]+|\d+)\]$/.test(ins.ops[1] ?? '');
    const needsLayout = flat.some((f) => (f.data?.inCode ?? false) || isPcRelLdr(f.instr));
    if (needsLayout) {
      // Only a hazard WITHIN this function's slice makes its layout unknowable.
      const sliceHazard = hazards.find((h) => h.at >= sliceStart && h.at < boundaries[boundaryIdx]);
      if (sliceHazard) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': raw-encoded input needs byte-accurate layout, but '${sliceHazard.what}' makes item sizes unknowable`,
        );
      }
      // Byte offset of every item (Thumb-1: 2 bytes per instruction, `bl` is the 4-byte pair).
      const itemOff: number[] = [];
      const labelOff = new Map<string, number>();
      const codeStart = new Set<number>(); // offsets that begin an instruction or carry a label
      let off = 0;
      flat.forEach((f, i) => {
        itemOff[i] = off;
        if (f.label && !labelOff.has(f.label)) {
          labelOff.set(f.label, off);
          codeStart.add(off);
        }
        if (f.instr) {
          codeStart.add(off);
          off += f.instr.mnemonic === 'bl' ? 4 : 2;
        }
        if (f.data) {
          off += f.data.values.length * (f.data.halfwords ? 2 : 4);
        }
      });
      const labelAt = new Map<number, string>();
      for (const [lab, lo] of labelOff) {
        if (!labelAt.has(lo)) {
          labelAt.set(lo, lab);
        }
      }
      // Thumb-1 branch encodings this frontend models (cond codes 4–7 = mi/pl/vs/vc have no
      // lifted comparison semantics here; 14 is undefined, 15 is swi — all decline).
      const COND_MN = ['beq', 'bne', 'bcs', 'bcc', '', '', '', '', 'bhi', 'bls', 'bge', 'blt', 'bgt', 'ble'];
      const decodeHalfword = (v: number, at: number): { mnemonic: string; target: number } | null => {
        if (v >= 0xd000 && v <= 0xddff) {
          const mn = COND_MN[(v >> 8) & 0xf];
          if (!mn) {
            return null;
          }
          const d = (v & 0xff) - (v & 0x80 ? 0x100 : 0);
          return { mnemonic: mn, target: at + 4 + d * 2 };
        }
        if (v >= 0xe000 && v <= 0xe7ff) {
          const d = (v & 0x7ff) - (v & 0x400 ? 0x800 : 0);
          return { mnemonic: 'b', target: at + 4 + d * 2 };
        }
        return null;
      };
      // Pass 1: decode every in-code halfword; collect synthesized labels for branch targets.
      const synthLabels = new Map<number, string>(); // target offset → label to ensure there
      const decoded = new Map<number, Instr>(); // flat index → replacement branch instr
      flat.forEach((f, i) => {
        if (!f.data?.inCode) {
          return;
        }
        if (!f.data.halfwords) {
          return; // unlabelled word pool — layout bytes only (reached via [pc, #off] below)
        }
        f.data.values.forEach((raw, k) => {
          const at = itemOff[i] + k * 2;
          const v = parseInt(raw, 16);
          const br = Number.isFinite(v) ? decodeHalfword(v, at) : null;
          if (!br) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': raw halfword '${raw}' in the code stream is not a decodable branch — ` +
                `skipping it would silently delete its effect`,
            );
          }
          if (!codeStart.has(br.target)) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': raw branch '${raw}' targets byte offset 0x${br.target.toString(16)}, which is not an instruction boundary`,
            );
          }
          if (f.data!.values.length > 1) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': multi-value raw halfword directive mixing branches is not supported`,
            );
          }
          const lab = labelAt.get(br.target) ?? synthLabels.get(br.target) ?? `.Lraw_${br.target.toString(16)}`;
          synthLabels.set(br.target, lab);
          decoded.set(i, { mnemonic: br.mnemonic, ops: [lab] });
        });
      });
      // Pass 2: pc-relative literal loads → rewrite to a synthesized pool label so the existing
      // resolvePoolConst/resolvePoolSymbol machinery applies. `(pc & ~3) + off` depends on the
      // function's absolute alignment (mod 4) — derived STRUCTURALLY: pool words are 4-aligned in
      // the ROM, so the file-relative offset of any `.4byte` word fixes the base parity (the
      // luvdis `@ address` comments are not trusted).
      let basePar: number | undefined;
      flat.forEach((g, j) => {
        if (g.data && !g.data.halfwords) {
          const p = (4 - (itemOff[j] % 4)) % 4;
          if (basePar === undefined) {
            basePar = p;
          } else if (basePar !== p) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': literal pools at inconsistent alignments — cannot determine the function's base alignment`,
            );
          }
        }
      });
      flat.forEach((f, i) => {
        if (!isPcRelLdr(f.instr)) {
          return;
        }
        if (basePar === undefined) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': pc-relative literal load with no literal pool in the function to resolve into`,
          );
        }
        const imm = parseInt(
          f.instr!.ops[1].match(/#(0x[0-9a-fA-F]+|\d+)/)![1],
          f.instr!.ops[1].includes('0x') ? 16 : 10,
        );
        const wordOff = ((basePar + itemOff[i] + 4) & ~3) - basePar + imm;
        // locate the word: a 4-byte data item covering [wordOff, wordOff+4)
        let value: string | undefined;
        flat.forEach((g, j) => {
          if (!g.data || g.data.halfwords) {
            return;
          }
          const rel = wordOff - itemOff[j];
          if (rel >= 0 && rel < g.data.values.length * 4 && rel % 4 === 0) {
            value = g.data.values[rel / 4];
          }
        });
        if (value === undefined) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': pc-relative load at offset 0x${itemOff[i].toString(16)} resolves to byte offset ` +
              `0x${wordOff.toString(16)}, which is not a word in a literal pool`,
          );
        }
        const poolLab = `.Lpcpool_${wordOff.toString(16)}`;
        dataWords.set(poolLab, [value]);
        f.instr = { mnemonic: 'ldr', ops: [f.instr!.ops[0], poolLab] };
      });
      // Pass 3: rebuild flat — insert synthesized target labels, replace decoded halfwords.
      const next: FlatItem[] = [];
      flat.forEach((f, i) => {
        const lab = synthLabels.get(itemOff[i]);
        if (lab && f.label !== lab && !labelAt.has(itemOff[i])) {
          next.push({ label: lab });
        }
        const br = decoded.get(i);
        if (br) {
          next.push({ instr: br });
        } else {
          next.push(f);
        }
      });
      flat = next;
    }

    const blocks: AsmBlock[] = [];
    const fallsIntoData = new Set<string>(); // blocks whose straight-line next bytes are data
    let cur: AsmBlock | null = null;
    let anon = 0,
      first = true;
    for (const f of flat) {
      if (f.label) {
        cur = { label: f.label, instrs: [] };
        blocks.push(cur);
        first = false;
        continue;
      }
      if (f.data) {
        // Data in the stream: never part of a block. Find the nearest preceding block WITH
        // instructions (a bare `LABEL:` on the data — a labelled pool/table — pushes an empty
        // block that must NOT hide the real code block behind it; skipping that was the silent
        // deletion of a branch that fell into labelled data). If that block's straight-line path
        // continues (open, or a conditional branch), it falls into these bytes — record it;
        // reachable ⇒ decline below, unreachable ⇒ luvdis pool-alignment padding, pruned.
        let prev: AsmBlock | null = cur && cur.instrs.length > 0 ? cur : null;
        for (let j = blocks.length - 1; prev === null && j >= 0; j--) {
          if (blocks[j].instrs.length > 0) {
            prev = blocks[j];
          }
        }
        if (prev) {
          const k = classifyXfer(prev.instrs[prev.instrs.length - 1]);
          if (k === null || k === 'cond') {
            fallsIntoData.add(prev.label);
          }
        }
        cur = null;
        continue;
      }
      if (!cur) {
        cur = { label: first ? name : `.L_anon${anon++}`, instrs: [] };
        blocks.push(cur);
        first = false;
      }
      cur.instrs.push(f.instr!);
      // Any control transfer ends a block (see classifyXfer — the single source of truth: `b`, a
      // conditional branch, a `bx`/PC-write return, and a computed/loaded PC write).
      if (classifyXfer(f.instr!)) {
        cur = null;
      }
    }
    // Raw data INTERLEAVED with instructions under one label: the lifted block would silently
    // omit whatever the data encodes — decline instead.
    const mixed = blocks.find((b) => b.instrs.length > 0 && subwordData.has(b.label));
    if (mixed) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': block '${mixed.label}' interleaves raw data (.${subwordData.get(mixed.label)}) with instructions`,
      );
    }
    // Two labels on the same instruction (`.LCB80:` immediately followed by `.L7:`) make the first
    // an ALIAS of the second, not a block of its own — agbcc emits exactly that when a long-jump
    // helper label lands on an existing one. The empty block is dropped just below, so a branch
    // naming the alias would afterwards resolve to nothing and decline as a dangling target. Point
    // those branches at the block the label actually names, before anything reads the CFG.
    // A label naming DATA is emphatically NOT an alias, and this is the guard the whole pass turns
    // on. Decode pushes an empty block for a literal-pool / jump-table label too, so aliasing them
    // blindly would silently retarget `beq .Lpool` at whatever code happens to follow the pool —
    // marker-free, plausible, wrong C where the frontend used to decline. Every agbcc pool is a
    // label on data, so that is the common case, not an exotic one. A data label therefore neither
    // aliases nor is aliased THROUGH: scanning past one for a later code block would silently jump
    // over the data.
    const isDataLabel = (l: string) => dataWords.has(l) || subwordData.has(l);
    const aliasOf = new Map<string, string>();
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].instrs.length > 0 || isDataLabel(blocks[i].label)) {
        continue;
      }
      let j = i + 1;
      while (j < blocks.length && blocks[j].instrs.length === 0 && !isDataLabel(blocks[j].label)) {
        j++;
      }
      const next = blocks[j];
      if (next && next.instrs.length > 0) {
        aliasOf.set(blocks[i].label, next.label);
      } // otherwise a trailing or data-fronted label: left dangling so a branch to it still declines
    }
    for (const b of aliasOf.size ? blocks : []) {
      for (const ins of b.instrs) {
        const k = ins.ops.length - 1;
        if ((ins.mnemonic === 'b' || COND_OPCODE[ins.mnemonic]) && k >= 0) {
          ins.ops[k] = aliasOf.get(ins.ops[k]) ?? ins.ops[k];
        }
      }
    }
    let live = blocks.filter((b) => b.instrs.length > 0);
    // Alignment-pad NOPs a splitter emits around returns and literal pools: `lsls r0, r0, #0`
    // is the 0x0000 halfword, `mov r8, r8` is 0x46C0, plus a literal `nop`. A block made ONLY
    // of these is pool/section padding when unreachable — pruned below. A REACHABLE pad block
    // is a real (degenerate) instruction and is kept.
    const isPadInstr = (i: Instr) =>
      i.mnemonic === 'nop' ||
      ((i.mnemonic === 'lsl' || i.mnemonic === 'lsls') &&
        i.ops[0] === 'r0' &&
        i.ops[1] === 'r0' &&
        /^#0x?0*$/.test(i.ops[2] ?? '')) ||
      ((i.mnemonic === 'mov' || i.mnemonic === 'movs') && i.ops[0] === 'r8' && i.ops[1] === 'r8');
    const padBlocks = new Set(live.filter((b) => b.instrs.every(isPadInstr)).map((b) => b.label));
    if (fallsIntoData.size > 0 || padBlocks.size > 0) {
      // Targeted reachability: a block that falls into data is either luvdis's unreachable
      // pool-alignment padding (pruned) or genuinely reachable (decline — its fall-through
      // successor would silently skip over the data bytes); an all-pad block after the final
      // return (before a labelled pool or EOF) is pruned when unreachable. Other unreachable
      // blocks are LEFT ALONE — this pass judges only those two sets, so genuine truncation
      // still declines "falls off the end".
      const idx = new Map(live.map((b, i) => [b.label, i] as const));
      const reach = new Set<number>([0]);
      const work = [0];
      while (work.length > 0) {
        const i = work.pop()!;
        const b = live[i];
        const last = b.instrs[b.instrs.length - 1];
        const kind = last ? classifyXfer(last) : null;
        const targets: string[] = [];
        if (kind === 'cond' || kind === 'uncond') {
          targets.push(last.ops[0]);
        }
        if (kind === null || kind === 'cond') {
          const fall = live[i + 1]?.label;
          if (fall !== undefined && !fallsIntoData.has(b.label)) {
            targets.push(fall);
          }
        }
        for (const t of targets) {
          const ti = idx.get(t);
          if (ti !== undefined && !reach.has(ti)) {
            reach.add(ti);
            work.push(ti);
          }
        }
      }
      for (const b of live) {
        if (fallsIntoData.has(b.label) && reach.has(idx.get(b.label)!)) {
          const last = b.instrs[b.instrs.length - 1];
          if (!last || classifyXfer(last) === null || classifyXfer(last) === 'cond') {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': reachable code in block '${b.label}' falls through into data bytes`,
            );
          }
        }
      }
      live = live.filter(
        (b) => (!fallsIntoData.has(b.label) && !padBlocks.has(b.label)) || reach.has(idx.get(b.label)!),
      );
    }
    // Fall-through into the NEXT function (shared tail): the slice's last block has no
    // terminator, and a further function region exists — retry with the slice extended.
    const lastLive = live[live.length - 1];
    const lastInstr = lastLive?.instrs[lastLive.instrs.length - 1];
    if (lastInstr && classifyXfer(lastInstr) === null && boundaryIdx + 1 < boundaries.length) {
      const nextLab = allFlat[boundaries[boundaryIdx]]?.label;
      if (nextLab !== undefined && armLabels.has(nextLab)) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': control falls through into the ARM-mode function '${nextLab}'`,
        );
      }
      boundaryIdx++;
      continue;
    }
    return { blocks: live, dataWords };
  }
}

// Resolve an agbcc/Thumb literal-pool reference (`ldr rD, .Lpool` / `.Lpool+byteOff`) to the NUMERIC
// 32-bit word it loads — the `ldr rD, =const` idiom. Returns null when the operand is NOT a numeric
// pool constant: a register/`[base]` memory operand, an unknown label, a misaligned offset, or a
// word that is a SYMBOL (an address / jump-table pointer — left for recoverJumpTable or the normal
// load path). The byte offset selects the word (index = off/4). This keeps a real literal constant
// (`.word 0x8408`) from being lifted as a phantom pointer parameter and dereferenced (`*a2`).
// The label-operand shape shared by BOTH pool paths: agbcc `.Lpool`, pret `_08012358`, with an
// optional `+N` byte offset. Kept in one place so the const and symbol resolvers cannot drift
// (they did — the drift fabricated phantom pointer params on symbol-pool loads).
const POOL_LABEL = /^([A-Za-z_.$][\w.$]*)(?:\s*\+\s*(0x[0-9a-fA-F]+|\d+))?$/;

type PoolRef =
  | { kind: 'const'; value: number }
  | { kind: 'gaddr'; sym: string; addend: number }
  | { kind: 'unmodelled'; why: string };

/** Classify a word-load operand `LABEL[+N]` against the captured literal pools. Returns null when
 *  the operand does NOT name a pool (a real register/memory base → the normal load path). When it
 *  DOES name a pool the outcome is const | gaddr | unmodelled — NEVER a fall-through to the load
 *  path, which would materialise the pool label as a phantom pointer parameter (a silent
 *  miscompile). `unmodelled` (a `sym+N` offset, a misaligned/out-of-range index, a `.L` code
 *  label) is the caller's cue to decline loud. */
function poolRef(operand: string, dataWords: Map<string, string[]>): PoolRef | null {
  const m = operand.match(POOL_LABEL);
  if (!m) {
    return null;
  }
  const words = dataWords.get(m[1]);
  if (!words) {
    return null; // not a pool — an ordinary register/memory operand
  }
  const byteOff = m[2] ? Number(m[2]) : 0;
  if (byteOff % 4 !== 0 || byteOff / 4 >= words.length) {
    return { kind: 'unmodelled', why: `offset ${byteOff} is not a whole word in pool '${m[1]}'` };
  }
  const w = words[byteOff / 4].trim();
  if (/^-?(0x[0-9a-fA-F]+|\d+)$/.test(w)) {
    const val = w.startsWith('-') ? -Number(w.slice(1)) : Number(w);
    return Number.isFinite(val) ? { kind: 'const', value: val } : { kind: 'unmodelled', why: `unparsable word '${w}'` };
  }
  // A C identifier that is NOT a `.L` code label → the address of a named global, optionally with
  // a byte ADDEND folded into the pool word (`gBgTilemapBufs+0x14a` — agbcc pre-computes a fixed
  // element's address into the pool rather than emitting an add). The addend stays in VALUE space:
  // the consumer emits `gaddr` then an explicit `add`, the exact spelling the register-materialised
  // `ldr rN,=gSym; add rN,#k` shape already lowers to — so it renders through the same audited
  // cast-based path (`((u8 *)&gSym) + k`), never through a typed-pointer scale that a
  // rendered-vs-value addend could silently multiply (the DEREF-TYPING class).
  const sm = w.match(/^([A-Za-z_]\w*)\s*(?:([+-])\s*(0x[0-9a-fA-F]+|\d+))?$/);
  if (sm && !sm[1].startsWith('.L')) {
    const mag = sm[3] ? Number(sm[3]) : 0;
    if (Number.isFinite(mag)) {
      return { kind: 'gaddr', sym: sm[1], addend: sm[2] === '-' ? -mag : mag };
    }
  }
  return { kind: 'unmodelled', why: `pool word '${w}' is not a symbol, symbol±offset, or number` };
}

/** Does this function's literal pool name at least one EXTERNAL symbol?
 *
 *  agbcc emits a pool word symbolically exactly when the source expression named a linker symbol,
 *  and numerically when it did not (`*(vu16 *)0x4000130`, an address-cast macro). So within one
 *  function, a numeric word sitting alongside a symbolic one is numeric *by the source's choice* —
 *  which is what lets {@link liftThumb} refuse to invent a name for it.
 *
 *  The witness is required because that inference only holds for asm that KEPT its symbols. A
 *  linked-ROM disassembly resolves every relocation to a number, and there "numeric" says nothing
 *  about the source; vetoing on it would disable the map's naming for the users who need it most.
 *  A function whose pool names nothing external is therefore left alone (both spellings still
 *  enumerate, and the differ referees) rather than being read as evidence of anything.
 *
 *  Labels DEFINED in this same asm — the jump-table pointer word, a pret-style `_08012358` pool
 *  label — are not external symbols and never witness: they survive disassembly whether or not
 *  relocations did. */
function poolNamesASymbol(dataWords: Map<string, string[]>, blockLabels: Set<string>): boolean {
  for (const [, words] of dataWords) {
    for (const raw of words) {
      const w = raw.trim();
      // `gSym+0x14a` names a symbol as surely as `gSym` does — the witness must count both, or an
      // asm whose pools carry only addend words would wrongly permit numeric promotion.
      const sym = w.match(/^([A-Za-z_]\w*)\s*(?:[+-]\s*(?:0x[0-9a-fA-F]+|\d+))?$/)?.[1];
      if (sym === undefined || sym.startsWith('.L')) {
        continue;
      }
      if (!dataWords.has(sym) && !blockLabels.has(sym)) {
        return true;
      }
    }
  }
  return false;
}

// Recover an agbcc Thumb jump-table dispatch. Given a dispatch block `disp` ending in `mov pc, rV`
// and its unique bounds predecessor `bounds` ending in `cmp rX,#(N-1); bhi DEF`, verify the exact
// idiom and read the inline table — else return null (→ the indirect-jump loud-fail fires). The
// recovered switch REPLACES both blocks: `bounds` emits a `switch_br` (scrutinee rX; successors =
// case blocks + DEF).
//
//   bounds:  cmp rX,#(N-1); bhi DEF          disp: lsl rY,rX,#2 ; ldr rP,=PTR ; add rA,rY,rP
//                                                  ; ldr rV,[rA] ; mov pc,rV
//   PTR: .word TABLE     TABLE: .word C0 … C_{N-1}
//
// Index IDENTITY-OR-DECLINE guard: the value feeding the table load must be EXACTLY the
// bounds-checked scrutinee scaled only by `<<2` — any other op (xor/neg/extra offset) → decline.
interface JumpTable {
  scrutReg: string;
  caseLabels: string[];
  defaultLabel: string;
}

// Accept a data-processing mnemonic in either the pre-UAL (`lsl`, `add`) or UAL (`lsls`, `adds`)
// spelling, WITHIN THE DISPATCH BLOCK ONLY.
//
// In Thumb-1 the trailing `s` is a DIALECT MARKER, not a modifier: `.syntax divided` spells the
// flag-setting data-processing instructions without it, `.syntax unified` with it. For a LOW-register
// destination each pair is one halfword — measured with this project's own assembler, one instruction
// per file, both dialects, encoding read back with objdump:
//
//     add/adds 1888   sub/subs 1a88   lsl/lsls 0088   lsr/lsrs 0888   asr/asrs 1088   neg/negs 4248
//
// This is the dominant dialect of the input format asmlift advertises: every pret-style split wraps
// its `INCLUDE_ASM` bodies in `.syntax unified`, where the non-suffixed spelling is a syntax ERROR,
// and the split `.s` files carry no `.syntax` directive of their own — so this frontend cannot tell
// from its input which dialect it is reading, and must accept both. Counted under
// `asm/nonmatchings` of the Klonoa: Empire of Dreams tree: `lsls` 5795 against `lsl` 0, and `adds`
// 8883 against `add` 600 — where **every one** of those 600 is an `sp`/high-register/pc form and not
// one is the three-operand low-register `add rD, rN, rM` this idiom uses. Comparing the text alone
// therefore declined every jump table in that corpus, on input that is not malformed in any way.
// (agbcc's own output is the other dialect — 2957 `lsl` in this project's `build-gdwarf/src/*.s` —
// which is why the benchmark, built from compiler `.s`, never exercised this.)
//
// Why LOCAL rather than an entry in LEGACY_MNEMONICS, which is where synonyms belong: normalising
// the suffix away is safe for every input an ASSEMBLER ACCEPTS — the operands that distinguish `add`
// from `adds` (the SP adjust `add sp, sp, #4` = b001, the high-register `add r8, r0` = 4480) have no
// S-form at all, so `adds sp` and `adds r8, r0` are rejected in both dialects and cannot appear in
// any assemblable file. But this frontend REFUSES those spellings loudly today, and a flat
// `adds: 'add'` entry silently turns `adds sp` into ordinary frame bookkeeping instead: the entry
// was written, and `decline-guards.test.ts` failed on exactly that case. So the reason to keep it
// local is input VALIDATION, not semantics — a name-keyed table cannot say "only when the
// destination is a low register", and giving up the refusal buys nothing, since no assembler emits
// what it refuses.
//
// Known false declines, all loud, none with a corpus instance: a parenthesised immediate (`#(2)`,
// which gas assembles), a two-operand `adds rA, rP` (the same add, but `addSrcs` has one source),
// and `movs pc, rV` (which IS `mov pc, rV` — 4687 — under divided syntax, and which `classifyXfer`
// accepts, so the frontend is internally inconsistent about it).
//
// Inside the dispatch block the distinction is additionally UNOBSERVABLE: the block computes
// `table_base + index*4`, loads the target and writes `pc`. Nothing between the `lsl` and the
// `mov pc` reads NZCV, no path leaves the block by falling through, and on a successful recovery the
// block is ELIDED from the CFG entirely — the bounds test that does feed a conditional branch lives
// in `bounds`, whose `cmp`/`bhi`/`bls` this function matches by exact name. Doubly moot in fact,
// since `lsl rD, rS, #imm` is low-register-only, so the add here is always the low-register form.
const isDataOp = (mn: string, base: 'lsl' | 'add'): boolean => mn === base || mn === `${base}s`;

function recoverJumpTable(
  bounds: AsmBlock,
  disp: AsmBlock,
  dataWords: Map<string, string[]>,
  blockLabels: Set<string>,
  longDefault?: string,
): JumpTable | null {
  // bounds: last two instrs are `cmp rX,#M` then the out-of-range guard, in one of two spellings.
  //
  //   direct    cmp rX,#M ; bhi DEF                 → fall through to the dispatch
  //   long jump cmp rX,#M ; bls DISP ; b DEF        → branch TO the dispatch, long-branch the default
  //
  // The second is what agbcc emits whenever the default is out of a conditional branch's reach —
  // Thumb-1 `B<cond>` carries a signed 8-bit HALFWORD offset, so ±256 BYTES, about 128
  // instructions — which on a real switch it usually is: five of the six benchmark
  // functions with a table use it, and only the sixth uses the direct form. `longDefault` is the
  // target of that trailing `b`, read by the caller from the block after `bounds`.
  const bi = bounds.instrs;
  const guard = bi[bi.length - 1],
    cmp = bi[bi.length - 2];
  if (!guard || !cmp || cmp.mnemonic !== 'cmp') {
    return null;
  }
  let defaultLabel: string;
  if (longDefault === undefined) {
    if (guard.mnemonic !== 'bhi') {
      return null;
    }
    defaultLabel = guard.ops[0];
  } else {
    // The `bls` must name THIS dispatch block, or the guard belongs to some other branch and the
    // `b` we picked up is not its default.
    if (guard.mnemonic !== 'bls' || guard.ops[0] !== disp.label) {
      return null;
    }
    defaultLabel = longDefault;
  }
  const scrutReg = cmp.ops[0];
  const m = cmp.ops[1];
  if (!m?.startsWith('#')) {
    return null;
  }
  const n = imm(m) + 1; // cases 0..M  → N = M+1
  if (n < 1) {
    return null; // a bound that admits no case at all is not a dispatch — fail closed
  }

  // disp: exactly the 5-op idiom, threading a single index register from `lsl rY,rX,#2`.
  const d = disp.instrs;
  if (d.length !== 5) {
    return null;
  }
  const [lsl, ldrP, add, ldrV, movpc] = d;
  if (!isDataOp(lsl.mnemonic, 'lsl') || lsl.ops[1] !== scrutReg || !immEq(lsl.ops[2], 2)) {
    return null;
  }
  const idxReg = lsl.ops[0]; // rY = rX << 2  (index*4, identity guard)
  if (ldrP.mnemonic !== 'ldr') {
    return null;
  }
  const ptrReg = ldrP.ops[0],
    ptrLabel = ldrP.ops[1]; // rP = *(PTR literal)
  if (!isDataOp(add.mnemonic, 'add') || add.ops[0] !== idxReg) {
    return null;
  }
  // add rY, rY, rP  (either operand order) — the address = table_base + index*4, nothing else.
  //
  // The two sources must be DISTINCT registers. Membership alone is satisfied by one register
  // listed twice, and that is not a hypothetical shape: if the pointer load targets the index
  // register (`lsl r0,r1,#2 ; ldr r0,=PTR ; add r0,r0,r0`) the index is overwritten before it is
  // ever added, `idxReg === ptrReg`, and both `includes` tests pass on `r0`. The address formed is
  // `2 * table_base` and the scrutinee is dead — yet the recogniser would emit `switch (a0)` and
  // dispatch on a value the hardware never uses. Wrong block, no marker. Found by an adversarial
  // probe; it predates the spelling fix this guard sits next to, and is fixed here because it is
  // the same identity-or-decline rule.
  const addSrcs = [add.ops[1], add.ops[2]];
  if (idxReg === ptrReg || !(addSrcs.includes(idxReg) && addSrcs.includes(ptrReg))) {
    return null;
  }
  if (ldrV.mnemonic !== 'ldr') {
    return null;
  }
  // rV = *(rY), and the address must be EXACTLY rY: no displacement, no register index.
  //
  // `parseAddr` surfaces `off` and `regOff` for precisely this reason — its own comment says
  // "surfaced to the caller so load/store DECLINE loud: silently reading `[rB]` dropped the index
  // — a silent miscompile" — and this caller used to destructure `base` alone and throw both away.
  // `ldr rV, [rA, #4]` loads table[i+1]: the recovered switch says `case 0` while the hardware
  // reaches case 1's block, and the last case reads a word past the table. `ldr rV, [rA, r2]` adds
  // an unrelated register. Both used to recover an ordinary-looking `switch` — a wrong BLOCK, with
  // no marker. The header of this function already claimed to refuse an "extra offset"; now it does.
  //
  // `#0` is the spelling the corpus actually uses (`ldr r0, [r0, #0x00]`), so the check is on the
  // VALUE, not on the operand's absence.
  const { base, off, regOff } = parseAddr(ldrV.ops[1]);
  if (base !== idxReg || off !== 0 || regOff !== undefined || ldrV.ops[0] !== movpc.ops[1]) {
    return null;
  }
  if (movpc.mnemonic !== 'mov' || movpc.ops[0] !== 'pc') {
    return null;
  }

  // Read the table: the ldr loads a POINTER word (PTR: .word TABLE); the table is TABLE: .word C0…
  // Note the case labels are matched against `blockLabels` as WRITTEN: the adjacent-label aliasing in
  // `decode` rewrites branch operands, not `.word` entries, so a table naming an aliased label would
  // decline here rather than dispatch anywhere. Loud, and no corpus instance — left as a known edge
  // rather than fixed speculatively.
  //
  // The pointer word is addressed the same way every other pool load in this frontend is —
  // `LABEL[+N]`, selecting word N/4 — because a literal pool is a POOL: agbcc packs the dispatch
  // pointer in beside whatever else the function needed, and which slot it lands in is an artifact
  // of emission order. Reading only a bare label whose pool held exactly ONE word declined six real
  // benchmark functions whose table pointer merely sat later in the pool. Same fix m2c made in
  // `a7c5c2d`, and the same shared POOL_LABEL grammar the const/gaddr resolvers use, so the three
  // cannot disagree about what `.L21+0x4` addresses.
  const pm = ptrLabel.match(POOL_LABEL);
  const ptrWords = pm ? dataWords.get(pm[1]) : undefined;
  if (!pm || !ptrWords) {
    return null;
  }
  const ptrOff = pm[2] ? Number(pm[2]) : 0;
  if (ptrOff % 4 !== 0 || ptrOff / 4 >= ptrWords.length) {
    return null; // misaligned or past the end of the pool — not a word this pool holds
  }
  const caseLabels = dataWords.get(ptrWords[ptrOff / 4].trim());
  if (!caseLabels || caseLabels.length !== n) {
    return null;
  } // table length must equal the bound
  // Every case target and the default must resolve to a real decoded block; a label that is an
  // expression (`.L4+4`) or points outside the function would otherwise crash later — decline cleanly.
  if (!blockLabels.has(defaultLabel) || caseLabels.some((l) => !blockLabels.has(l))) {
    return null;
  }
  return { scrutReg, caseLabels, defaultLabel };
}

/** Lift decoded asm → an L1 Fn with block-argument SSA. `prototypes` supplies each callee's
 *  declared parameter count (from the project's headers); it is authoritative for recovering
 *  how many argument registers a `bl` passes (falling back to a heuristic when absent). */
export function lift(
  name: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes = {},
  _asmData?: AsmData,
  symbols?: SymbolMap,
): Fn {
  assertInputFormat('thumb', 'gnu-as', asm);
  const { blocks: rawBlocks, dataWords } = decode(name, asm);

  // Regime B: recover agbcc jump tables. A dispatch block (`mov pc, rN`) plus its bounds
  // predecessor (`cmp; bhi DEF`) collapse into a `switch_br` emitted from the BOUNDS block; the
  // dispatch block is ELIDED from the CFG. A `mov pc` that is NOT a recognised table falls through
  // to the loud-fail below.
  const blockLabels = new Set(rawBlocks.map((b) => b.label));
  // Whether THIS asm preserves symbol names in its literal pools — the witness the numeric-pool
  // naming veto needs (see poolNamesASymbol).
  const poolNamesSymbols = poolNamesASymbol(dataWords, blockLabels);
  // Any label referenced as a branch target (so we can tell if an elided dispatch block has a SECOND
  // predecessor — a `b disp` from elsewhere — which would dangle after elision; decline if so).
  // How many branches name each label — not just whether any does, because the long-jump bounds
  // form legitimately branches to its own dispatch block exactly once.
  const branchRefs = new Map<string, number>();
  for (const b of rawBlocks) {
    for (const ins of b.instrs) {
      if ((ins.mnemonic === 'b' || COND_OPCODE[ins.mnemonic]) && ins.ops.length) {
        const t = ins.ops[ins.ops.length - 1];
        branchRefs.set(t, (branchRefs.get(t) ?? 0) + 1);
      }
    }
  }
  const tables = new Map<AsmBlock, JumpTable>(); // bounds block → recovered table
  const elided = new Set<AsmBlock>(); // dispatch (and long-jump default) blocks removed from the CFG
  rawBlocks.forEach((d, i) => {
    const last = d.instrs[d.instrs.length - 1];
    if (!last || last.mnemonic !== 'mov' || last.ops[0] !== 'pc' || last.ops[1] === 'lr') {
      return;
    }
    const refs = branchRefs.get(d.label) ?? 0;
    const prev = rawBlocks[i - 1];
    // Direct form: the dispatch is reached ONLY by falling through from its bounds predecessor. A
    // `b disp` from anywhere else would leave a dangling edge after elision, so decline (→ loud-fail).
    if (prev && refs === 0) {
      const jt = recoverJumpTable(prev, d, dataWords, blockLabels);
      if (jt) {
        tables.set(prev, jt);
        elided.add(d);
        return;
      }
    }
    // Long-jump form: `bounds` (cmp; bls DISP), then a lone `b DEF` block, then the dispatch. The
    // dispatch is entered by exactly that one `bls` and nothing else, and the `b DEF` block —
    // synthetically labelled, so unnameable and unreachable once the bounds block dispatches — is
    // elided WITH it. Leaving it would make it a parameterless predecessor of the default block,
    // and wiring a phi through it fabricates an entry parameter (the phantom-param miscompile).
    const boundsB = rawBlocks[i - 2];
    const prevNamed = prev ? (branchRefs.get(prev.label) ?? 0) > 0 : false;
    if (refs === 1 && prev && boundsB && !prevNamed && prev.instrs.length === 1 && prev.instrs[0].mnemonic === 'b') {
      const jt = recoverJumpTable(boundsB, d, dataWords, blockLabels, prev.instrs[0].ops[0]);
      if (jt) {
        tables.set(boundsB, jt);
        elided.add(d);
        elided.add(prev);
      }
    }
  });
  const asmBlocks = rawBlocks.filter((b) => !elided.has(b));

  // TRUSTWORTHINESS: loud-fail on a control transfer this frontend cannot model, rather than
  // silently dropping it. A computed/loaded PC write (`mov pc, rN`, `ldr pc, …`, `add/sub pc`,
  // `ldmia rN!,{…,pc}` with rN≠sp) is a jump table / computed goto / register tail call — decode
  // ends the block at it, but it has no static successor, so it must be a catchable "out of scope"
  // signal, not a vanished branch. Mirrors MIPS `jr`/PPC `bctr`. (A RECOGNISED jump table's
  // dispatch block is already elided above, so it is not scanned here.)
  for (const ab of asmBlocks) {
    for (const ins of ab.instrs) {
      if (classifyXfer(ins) === 'indirect') {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': indirect/computed jump '${ins.mnemonic} ${ins.ops.join(', ')}' ` +
            `— jump tables / computed gotos / register tail calls not supported`,
        );
      }
    }
  }

  // --- CFG (successors per block) as label lists; fallthrough + branch targets (via classifyXfer) ---
  const buildCfg = (blocks: AsmBlock[]) => {
    const labelIndex = new Map<string, number>();
    blocks.forEach((b, i) => labelIndex.set(b.label, i));
    const succLabels: string[][] = blocks.map((b, i) => {
      // A recovered jump-table BOUNDS block dispatches to its case blocks + default (the elided
      // dispatch block's targets); its `bhi`/fall-through successors are replaced entirely.
      const jt = tables.get(b);
      if (jt) {
        return [...jt.caseLabels, jt.defaultLabel];
      }
      const last = b.instrs[b.instrs.length - 1];
      const fall = i + 1 < blocks.length ? blocks[i + 1].label : null;
      const kind = last ? classifyXfer(last) : null;
      if (kind === 'return') {
        return [];
      } // bx lr / pop {…,pc} / mov pc,lr
      if (kind === 'uncond') {
        return [last!.ops[0]];
      } // unconditional
      if (kind === 'cond') {
        return [last!.ops[0], fall!];
      } // taken, fallthrough
      return fall ? [fall] : []; // fallthrough (or non-transfer last op / EMPTY synthetic block)
    });
    const preds: number[][] = blocks.map(() => []);
    // A branch to a label that is not a code block (a data label, or a target outside the sliced
    // function) cannot be modelled — fail loud, mirroring the MIPS/PPC non-block-boundary guards.
    succLabels.forEach((ss, i) =>
      ss.forEach((s) => {
        const ti = labelIndex.get(s);
        if (ti === undefined) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': branch target '${s}' is not a code block in this function (a data label, or outside the sliced function)`,
          );
        }
        preds[ti].push(i);
      }),
    );
    return { labelIndex, succLabels, preds };
  };

  // A function whose ENTRY block is itself a loop header (some block branches back to it — the tight
  // `strcpy`/`strlen`/`memset` shape where block 0 IS the loop) has no preheader to carry the
  // incoming argument registers into the header's phis. Braun SSA would then build each loop-carried
  // register's phi from the back-edge ALONE, dropping the entry value → a use-before-def on the
  // header's first op. Insert a synthetic EMPTY preheader that falls through to the old entry: it
  // becomes the true entry (its arg-register reads create the params), and the old header now has a
  // forward predecessor supplying the entry operand of each phi. Guarded on `preds[0]` so ordinary
  // functions (entry not a branch target) are untouched.
  let { labelIndex, preds } = buildCfg(asmBlocks);
  if (preds[0].length > 0) {
    let ph = '.Lasmlift_preheader';
    while (labelIndex.has(ph)) {
      ph += '_';
    }
    asmBlocks.unshift({ label: ph, instrs: [] });
    ({ labelIndex, preds } = buildCfg(asmBlocks));
  }

  // ENTRY-REACHABLE BLOCKS. Dead code is not evidence about anything: a reload in a block that
  // never executes is not a read of the slot, and an instruction there is not a fact about the
  // frame this function actually builds. Two analyses below rest on that, so it is computed once
  // rather than once each — the second one was written without it and a single unreachable
  // `mov r0, sp; bl use` appended to a five-argument forwarder was enough to turn a loud decline
  // into a call with every argument dropped.
  const entryReachable = ((): Set<number> => {
    const live = new Set<number>([0]);
    for (let changed = true; changed;) {
      changed = false;
      for (let b = 0; b < asmBlocks.length; b++) {
        if (!live.has(b) && preds[b].some((q) => live.has(q))) {
          live.add(b);
          changed = true;
        }
      }
    }
    return live;
  })();

  // --- ISA-neutral SSA construction (shared Braun builder) ---
  // THE LIVE-IN PARTITION (frontend/ssa.ts, LiveInModel). `[0, localArea)` is the whole of what this
  // function owns: an incoming stack argument is keyed `@sarg<k>` rather than `sp@<off>` precisely
  // because it sits at or above this frame, so `callerParams` is empty. `localArea` is 0 whenever
  // the prologue walk cannot measure the frame, and the empty range then refuses every slot —
  // `slotOff` applies the same bound when minting keys, so this is the independent check.
  //
  // The register half needs both of its facts, and they come from different places. The target says
  // which registers no caller can hand a value over in; `savedRegs` says which ones THIS function
  // saved, and so could have homed a local in. A register in only the first is one the ABI does not
  // describe — hand-written asm with a private convention, or a mid-function fragment — and it keeps
  // the treatment a target claiming no partition gets.
  const ssa = makeSsaBuilder(name, asmBlocks.length, preds, () => ({
    ownedLocals: { from: 0, to: localArea },
    ...(target.nonArgRegs
      ? { uninitRegs: target.nonArgRegs.filter((r) => savedRegs.has(r)), argRegs: target.argRegs }
      : {}),
  }));
  const { fn, irBlocks, readVar, writeVar, paramReg } = ssa;

  const constVal = (n: number, b: number): Value => {
    const v = mkValue(T.unk(32));
    irBlocks[b].ops.push(mkOp('const', { results: [v], attrs: { value: n } }));
    return v;
  };
  const reg = (s: string) => s.replace(/[[\]]/g, '');

  // THE one test for "is this token the stack pointer". Case-insensitive because GNU as accepts
  // uppercase register names, and a case-sensitive test here is a silent-wrong-answer hole rather
  // than a cosmetic one: `add r0, SP, #4` is `&local`, and missing it fabricates a phantom
  // parameter and emits confident arithmetic on it.
  const isSpReg = (s: string | undefined): boolean => {
    const r = reg(s ?? '').toLowerCase();
    return r === 'sp' || r === 'r13';
  };

  // Writing sp is transparent frame bookkeeping ONLY in the one shape that cannot change anything
  // observable: `sp = sp ± immediate`. Two producers feed this frontend and each emits exactly ONE
  // spelling, which is why both must work and why handling only one silently halved the input:
  //
  //     producer                                    `add sp, #N`   `add sp, sp, #N`
  //     agbcc's own .s (checkouts/*/build/src)            0                98
  //     disassembly (klonoa asm/ · sa3 asm/)           203 · 1250           0
  //
  // So this is not "one tool with two spellings" — it is the compiler's convention against the
  // disassembler's, and asmlift reads both kinds of file. (An earlier commit message on this branch
  // claimed agbcc emitted both; it does not, and the counts above are the check that settles it.)
  //
  // Everything else that writes sp is a
  // frame change this frontend cannot model: a register-sized adjustment (`add sp, r4`, agbcc's
  // way of spelling a frame too large for the 7-bit immediate), a computed stack pointer
  // (`add sp, r0, #4`), or `mov sp, rN`. Those must DECLINE, not vanish — dropping them deletes a
  // frame change with no diagnostic, which is the exact
  // loud-becomes-silent trade this frontend's guards exist to prevent.
  //
  // Flag-setting spellings (`adds`/`subs`) are excluded deliberately: ARMv4T's SP-adjust encoding
  // does not set flags, so a flag-setting one can only come from hand-written asm, where dropping
  // it would leave a stale compare for a following conditional branch to fold. There are 0 in the
  // benchmark corpus and 0 across the klonoa and sa3 checkouts, so excluding them costs nothing.
  // The decline names WHY the slot model is off when it is (slotsOffReason, assigned below —
  // referenced through the closure, so this reads the final value at throw time). The gap
  // histogram is the improvement loop's work-list, and "local stack frames not supported" was a
  // false attribution for a function whose frame IS modelled but whose blocker is, say, an
  // address-taken local or an outgoing stack argument — it sent the loop to build the wrong thing.
  const spAsDataError = () =>
    new FrontendUnsupportedError(
      `cannot lift '${name}': stack pointer used as data — ` +
        (slotsOffReason ?? 'not a modelled slot (address-taken local / frame arithmetic / above the local area)'),
    );

  const isFrameAdjust = (
    mnemonic: string,
    dest: string | undefined,
    base: string | undefined,
    off: string | undefined,
  ): boolean =>
    (mnemonic === 'add' || mnemonic === 'sub') &&
    isSpReg(dest) &&
    (base === undefined || isSpReg(base)) &&
    (off?.startsWith('#') ?? false);

  // Reading sp as a DATA operand means an address-taken local (`add rD, sp, #N` = `&local`),
  // an sp-relative spill slot (`ldr/str …, [sp, #N]`), or frame-pointer arithmetic — none
  // modellable without a stack abstraction. Without this guard Braun SSA would materialize sp as a
  // fabricated PHANTOM parameter that scrambles the signature. Fail LOUD instead, mirroring MIPS
  // (`isStackPtr`) and PPC (`r1`).
  //
  // sp is never WRITTEN either — but by `writeData` declining, NOT because sp-dest ops are inert.
  // That was this file's premise until the frame-adjust whitelist landed, and it was wrong: five
  // decode arms wrote sp and dropped it silently. The single transparent shape is `sp = sp ± imm`,
  // whitelisted in the add/sub arms. Read and write are now guarded symmetrically.
  const readData = (r: string, b: number): Value => {
    if (isSpReg(r)) {
      throw spAsDataError();
    }
    if (r === 'pc' || r === 'r15') {
      // A pc-relative literal load is rewritten to a pool label before reaching here (decode's
      // isPcRelLdr pass); a `pc`/`r15` base that survives to a data read is an unmodelled shape
      // (`ldr [pc]` with no `#imm`, computed-pc arithmetic) — decline, never fabricate a param.
      throw new FrontendUnsupportedError(`cannot lift '${name}': program counter used as a data base — not modelled`);
    }
    if (dataWords.has(r)) {
      // The operand is a literal-pool / data LABEL, not a register — reading it as dataflow would
      // fabricate a phantom parameter. Word-pool loads are resolved by poolRef upstream; anything
      // else reaching here (a sub-word load off a pool label, a label used in arithmetic) declines.
      throw new FrontendUnsupportedError(`cannot lift '${name}': data label '${r}' used as a register — not modelled`);
    }
    return readVar(r, b);
  };

  // A virtual register key per incoming stack argument. Reading it goes through the ordinary Braun
  // live-in path (frontend/ssa.ts), which turns a read with no reaching def into a function
  // parameter — so this needs NO new representation, opcode or pass. The `@` cannot appear in a
  // real register token, so the key cannot collide with one.
  const stackArgKey = (index: number) => `@sarg${index}`;
  // Defined beside its mint site on purpose: the format string and its parser drifted 650 lines
  // apart in the first version, with the convention explained only at one end.
  const stackArgIndex = (key: string): number | null => {
    const m = /^@sarg(\d+)$/.exec(key);
    return m ? +m[1] : null;
  };

  // INCOMING STACK ARGUMENTS (AAPCS). Args 1-4 arrive in r0-r3; args 5+ are pushed by the CALLER,
  // so the callee reads them at `[sp, #N]` where N is at or above its own frame. Those are
  // PARAMETERS, not locals — declining them as "sp used as data" refuses a calling convention.
  //
  // The frame depth is tracked by a linear walk of the ENTRY BLOCK only, which is
  // why the gate is what it is: within one straight-line block the depth at each instruction is
  // exact and needs no CFG reasoning. Every case that would need more declines.
  //
  // `push {a,b,c}` deepens by 4 per register; `sub sp, #N` and `add sp, sp, #-N` deepen by N.
  //
  // The walk, its two invariants and the predicate that reads them are ONE object on purpose. They
  // were three loose pieces — a delta function, a pair of `let`s updated in the instruction loop,
  // and a seven-parameter predicate taking the pair by value — and both bugs the second review pass
  // found lived in the seams: an invariant the predicate's proof needed but only the loop could
  // enforce, and a `0` returned for an unrecognised shape that only a guard in a third place made
  // safe. Anything that changes how sp moves now has one place to change, and the proof it has to
  // preserve is written next to the state it is about.
  const makeFrameWalk = () => {
    // Bytes the frame has grown since function entry, along this block's linear order only.
    let depth = 0;
    let depthKnown = true;

    // Returns null whenever the depth cannot be computed exactly — including for any write to sp
    // this does not model. The capability rests on the depth being EXACT, so an approximation is
    // never acceptable: understate the frame and a local sits above the computed top and gets
    // minted as a parameter reading uninitialised stack. A null poisons the depth for the rest of
    // the block, which disables argument recovery and leaves every `[sp,#N]` to decline as before.
    // Nothing here may return a NUMBER for a shape it merely failed to recognise.
    const delta = (ins: { mnemonic: string; ops: string[] }): number | null => {
      const m = ins.mnemonic;
      if (m === 'push' || m === 'pop') {
        // expandRegList, NOT a comma count: `push {r4-r7, lr}` is FIVE registers, and counting it as
        // two makes the frame 12 bytes too shallow — which turns a genuine LOCAL into a fabricated
        // parameter reading uninitialised stack. Caught by a probe, not by the corpus: agbcc emits no
        // range pushes and 0 of the 743 benchmark rows contain one, but GNU as accepts them and the
        // disassembly path can produce them.
        // Counting comma tokens instead would undercount `{r4-lr}` as two registers, and an
        // unexpandable range must poison the depth rather than be guessed at — definiteRegList owns
        // both rules, and owns them for the ldm/stm arm too.
        const list = definiteRegList(
          ins.ops
            .join(',')
            .replace(/[{}]/g, '')
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean),
        );
        if (list === null) {
          return null;
        }
        return (m === 'push' ? 1 : -1) * 4 * list.length;
      }
      if ((m === 'add' || m === 'sub') && isSpReg(ins.ops[0])) {
        const off = ins.ops[2] ?? ins.ops[1];
        if (off?.startsWith('#')) {
          const v = imm(off);
          return m === 'sub' ? v : -v;
        }
      }
      // Any OTHER write to sp poisons the depth. This used to fall through to 0 — "no change" — for
      // shapes it does not model (`add sp, r4`, `mov sp, rN`, `add sp, r0, #4`), which was safe only
      // because writeData declines every one of them elsewhere. That is the same
      // enumeration-of-arms mistake writeData itself exists to end, exported one function away: a
      // number meaning "no change" is the wrong answer to "I do not understand this". Now the walk is
      // self-sufficient — unknown ⇒ depth poisoned ⇒ decline — and writeData's refusal is an
      // independent second guarantee instead of a load-bearing one.
      if (isSpReg(ins.ops[0])) {
        return null;
      }
      return 0;
    };

    return {
      // Advance the walk over one instruction. Call for EVERY instruction, in order.
      step(ins: { mnemonic: string; ops: string[] }): void {
        const d = delta(ins);
        if (d === null) {
          depthKnown = false;
        } else {
          depth += d;
        }
        // sp ABOVE the incoming sp poisons the walk for the rest of the block, permanently — the
        // premise argIndex's proof rests on. See the proof there for what it costs to omit.
        if (depth < 0) {
          depthKnown = false;
        }
      },

      // Is `[sp, #off]` an incoming stack argument, and which one? `null` means NO — and every null is
      // a DECLINE, because the caller falls through to readData's sp guard.
      //
      // Why a slot at or above the frame top cannot have been written by this function, which is the
      // whole soundness argument: every sp-relative STORE declines (readData, via the str arm), and a
      // `push` only ever writes strictly BELOW the current top. An argument slot is at or above the
      // incoming sp, so no instruction here can have defined it — the value can only be the caller's.
      //
      // That second step needs sp to have stayed at or below where it came in — `depth >= 0` at every
      // point of the walk — or a `push` reaches back up over the argument area and the conclusion is
      // false:
      //
      //     add sp, sp, #8      ; sp = S+8
      //     push {r4, r5, r6}   ; sp = S-4, and this WROTE r5 to S+0
      //     ldr  r0, [sp, #4]   ; = S+0 — r5's slot, not the caller's argument
      //
      // The depth is back to a plausible +4 by the load, so nothing downstream can tell: it emitted
      // `s32 f(s32 a0, …, s32 a4) { return a4; }`, the function's own incoming r5 handed back as
      // argument 5. `pop {r4}; push {r4,r5}` gets there without an `add sp` at all, and a sliced
      // fragment whose prologue was cut off is exactly this shape — which is the corpus this frontend
      // reads. `step` enforces it, and never un-poisons: once sp has been above the line, a push during
      // the excursion may have written the later slots too. This is a PREMISE, not a detail — leaving
      // it unstated is what let the first version hand back a callee-saved register as an argument.
      argIndex(addr: { base: string; off: number; regOff?: string }, width: number, bi: number): number | null {
        const { base, off, regOff } = addr;
        if (!isSpReg(base) || regOff !== undefined) {
          return null; // not sp, or `[sp, rX]` — not a fixed argument slot
        }
        if (bi !== 0 || preds[0].length > 0) {
          return null; // depth is exact only along the ENTRY block's linear order, and only when its
          // params are parameters rather than phis
        }
        if (!depthKnown || depth <= 0) {
          return null; // an unmeasurable frame, or none established: a headerless FRAGMENT whose
          // prologue was sliced off looks identical to a frameless function, and there the slots are
          // locals — minting one would be the silent-wrong trade this frontend refuses
        }
        if (width !== 4 || off < depth || (off - depth) % 4 !== 0) {
          return null; // the argument area is word-granular; BELOW the top is a local, which is the
          // separate slot-promotion capability
        }
        const index = target.argRegs.length + (off - depth) / 4;
        return index < MAX_RECOVERED_ARITY ? index : null; // a wild offset must not mint a
        // 400-parameter signature
      },
    };
  };

  // LOCAL STACK SLOTS. A spill or a local that never has its address taken is transparent to
  // dataflow: `str rX,[sp,#k]` … `ldr rY,[sp,#k]` moves a value, it does not touch memory anyone
  // else can see. Modelling it as an SSA variable keyed by the offset (the same `sp@<off>` spelling
  // the MIPS frontend uses) makes it exactly that, and Braun's phi construction handles a slot that
  // is read-modify-written across a loop with no extra machinery.
  //
  // What Thumb does NOT inherit from MIPS: keying by the RAW sp offset is only sound while sp holds
  // the same value at every access, and MIPS gets that for free (IDO establishes sp with one
  // `addiu` and never moves it). Thumb's `push` moves sp, so constancy has to be PROVEN here.
  const slotKey = stackSlotKey; // shared spelling: frontend/ssa.ts
  // Deliberately OVER-inclusive: a `cmp sp, rN` only reads sp but counts here too. Every false
  // positive costs a decline, every false negative costs a wrong slot — so it errs loudly.
  const modifiesSp = (ins: Instr): boolean =>
    ins.mnemonic === 'push' || ins.mnemonic === 'pop' || isSpReg((ins.ops[0] ?? '').replace(/!$/, ''));
  // A `mov rD, sp` CAPTURES the frame address; the captured value means "the frame base" only if
  // sp still holds that base wherever the value is used — so a capture participates in the
  // constancy proof exactly like a literal [sp,#k] access, and ends the prologue for localArea.
  const capturesSp = (ins: Instr): boolean =>
    /^movs?$/.test(ins.mnemonic) && !isSpReg(ins.ops[0] ?? '') && isSpReg(ins.ops[1] ?? '');
  const touchesFrame = (ins: Instr): boolean => spMemAccess(ins) !== null || capturesSp(ins);
  const spMemAccess = (ins: Instr): { off: number; width: number; regOff: boolean } | null => {
    if (!/^(ldr|ldrb|ldrh|ldrsb|ldrsh|str|strb|strh)$/.test(ins.mnemonic)) {
      return null;
    }
    const mem = ins.ops[1];
    if (mem === undefined) {
      return null;
    }
    const { base, off, regOff } = parseAddr(mem);
    return isSpReg(base)
      ? { off, width: /b$/.test(ins.mnemonic) ? 1 : /h$/.test(ins.mnemonic) ? 2 : 4, regOff: regOff !== undefined }
      : null;
  };

  // THE FRAME BASE PASSED TO A CALLEE. What this computes is exactly what its name says and nothing
  // more: somewhere in entry-reachable code a bare `mov rD, sp` copies the frame base into a
  // register that is still an ARGUMENT register at a `bl`. It is a fact about a REGISTER, not about
  // the frame's layout — an earlier cut of this treated it as proof that "[sp,#0] is an addressable
  // local", and agbcc falsified that outright. The layout question is settled by the gate this
  // feeds (`capturedObjectIsTheWholeFrame`, below `localArea`), not here.
  //
  // ENTRY-REACHABLE, BLOCK-LOCAL AND KILL-ON-MENTION, because this feeds an ACCEPTANCE and so may
  // never over-approximate. Unreachable blocks are skipped for the same reason (a)'s reload scan
  // skips them — an instruction that never executes is not a fact about the frame, and one appended
  // `mov r0, sp; bl use` after the return was enough to license a whole function. A block is
  // straight-line, so a capture that is still held when the `bl` is decoded is held on every
  // execution that reaches it; and a register is dropped the moment ANY other instruction so much
  // as MENTIONS it, since a write cannot happen without the token appearing. That over-kills (a
  // `cmp` on the register between the capture and the call ends it) and over-killing only costs a
  // decline. ARGUMENT registers only: the frame base merely live across a call is not evidence that
  // it was passed to one, and for `blx rN` the TARGET register is not an argument either.
  const frameBasePassedToCallee = ((): boolean => {
    for (const b of entryReachable) {
      const ab = asmBlocks[b];
      const held = new Set<string>();
      for (const ins of ab.instrs) {
        if (ins.mnemonic === 'bl' || ins.mnemonic === 'blx') {
          // `blx rN` names its TARGET in the operand slot, so exclude it: `mov r3, sp; blx r3`
          // branches THROUGH the frame base, it does not pass it.
          const targetReg = ins.mnemonic === 'blx' ? reg(ins.ops[0] ?? '') : null;
          if ([...held].some((r) => target.argRegs.includes(r) && r !== targetReg)) {
            return true;
          }
          held.clear(); // the callee clobbers the argument registers
          continue;
        }
        // The two shapes that can carry the base forward: the capture itself, and a bare register
        // copy of a value already held. Everything else only kills.
        const carried = capturesSp(ins)
          ? reg(ins.ops[0] ?? '')
          : /^movs?$/.test(ins.mnemonic) && held.has(reg(ins.ops[1] ?? ''))
            ? reg(ins.ops[0] ?? '')
            : null;
        // The OPERAND TOKENS, not the mnemonic: `asWritten` carries only the normalised mnemonic,
        // so the operands are the only place a written register can appear — and they are
        // RANGE-EXPANDED first, because a range spells none of the registers it writes. `pop
        // {r0-r3}` writes r2 with the string `r2` nowhere in the instruction, so the bare `\bR\b`
        // test let a dead capture survive the `pop` that destroyed it, the acceptance fired on a
        // frame that really did stage an outgoing argument, and the lift dropped all five of that
        // call's arguments. Two spellings of one instruction must not give two verdicts, and CASE
        // is a third spelling of the same one — `expandRegList` is lowercase-only, so `{R0-R3}`
        // leaked through the expansion exactly as the range leaked through the regex.
        const mentions = expandRegList(
          ins.ops
            .join(' ')
            .toLowerCase()
            .replace(/[[\]{}!#]/g, ' ')
            .split(/[,\s]+/)
            .filter(Boolean),
        );
        for (const r of [...held]) {
          if (mentions.includes(r) || ins.ops.some((o) => new RegExp(`\\b${r}\\b`, 'i').test(o))) {
            held.delete(r);
          }
        }
        if (carried !== null) {
          held.add(carried);
        }
      }
    }
    return false;
  })();

  // Is the word-slot model safe for THIS function? Every disqualifier below leaves every `[sp,#k]`
  // access on the old path, which declines — so the answer to "not sure" is the loud one.
  // Returns null when the word-slot model is SAFE for this function, else the reason it is off —
  // which the sp declines append, so a refused function names the capability actually missing
  // instead of the generic "local stack frames". The gap histogram is the improvement loop's
  // work-list; a misattributed refusal sends that loop to build the wrong thing.
  const slotModelBlocker = (): string | null => {
    for (const ab of asmBlocks) {
      for (const ins of ab.instrs) {
        const acc = spMemAccess(ins);
        // A SUB-WORD access aliasing a word slot is the hazard MIPS paid for the hard way: routing
        // the word store to an SSA slot while the byte reload stays on the memory path drops the
        // store and reads uninitialised memory. One anywhere disables the model for the whole
        // function. A register offset can alias any slot, so it disqualifies the same way.
        if (acc && (acc.width !== 4 || acc.regOff)) {
          return acc.regOff
            ? 'a register-offset sp access can alias any slot'
            : 'a sub-word sp access aliases the word-slot model';
        }
        // sp escaping into a register: a computed form (`add rD, sp, #k`) is still a refusal, but a
        // plain COPY (`mov rD, sp`) is now the address-taken-local capability — the mov arm emits a
        // `laddr` for it and the post-lift frame-object audit proves every use, so the model's
        // remaining precondition is that the frame has a reserved local area for the object to
        // live in. A frameless function taking sp's address has nothing to model and refuses.
        if (ins.mnemonic === 'add' && !isSpReg(ins.ops[0] ?? '') && ins.ops.slice(1).some((o) => isSpReg(o))) {
          return `the address of a stack local is computed (\`${ins.mnemonic} ${ins.ops.join(', ')}\`) — only a plain \`mov rD, sp\` capture is modelled`;
        }
      }
    }
    // sp must be CONSTANT wherever a slot is keyed, because the key IS the raw offset. Two shapes
    // are legitimate and everything else refuses: a PROLOGUE (sp moves before the block touches the
    // frame) and an EPILOGUE (sp moves after it has finished touching it, and the block returns, so
    // nothing downstream can key a slot against the changed sp). A modification BETWEEN two
    // accesses moves the frame under a slot already keyed, and only the entry block may deepen —
    // elsewhere a pre-access modification would put the block at a different depth from the one the
    // prologue established.
    for (let bi = 0; bi < asmBlocks.length; bi++) {
      const ins = asmBlocks[bi].instrs;
      const mems = ins.map((x, i) => (touchesFrame(x) ? i : -1)).filter((i) => i >= 0);
      const mods = ins.map((x, i) => (modifiesSp(x) ? i : -1)).filter((i) => i >= 0);
      if (mods.length === 0) {
        continue;
      }
      const last = ins[ins.length - 1];
      const returns = last !== undefined && classifyXfer(last) === 'return';
      if (mems.length === 0) {
        // moves sp and never keys a slot itself: safe only if nothing downstream can key one
        if (!returns && bi !== 0) {
          return 'sp moves in a block that neither returns nor is the entry';
        }
        continue;
      }
      for (const m of mods) {
        if (m < mems[0]) {
          if (bi !== 0) {
            return 'a non-entry block establishes its own frame depth'; // not the prologue's
          }
        } else if (m > mems[mems.length - 1]) {
          if (!returns) {
            return 'sp unwinds mid-function and execution continues';
          }
        } else {
          return 'the frame moves between two accesses that keyed slots against it';
        }
      }
    }
    // OUTGOING ARGUMENTS. agbcc reserves the BOTTOM of the frame for arguments 5+ of the calls this
    // function makes: `add sp,sp,#-8` … `str r2,[sp]` / `str r3,[sp,#4]` … `bl callee`. Those
    // offsets are inside the frame and nothing this function does ever reloads them, so modelling
    // them as locals makes them dead defs and DCE deletes them — the arguments vanish from the call
    // with no diagnostic. Ground truth: sa3's CreateEntity_Platform_0_0 (platform.c:734) forwards
    // SIX arguments and came out as `CreateEntity_Platform(0, 0, a0, (u16)a1)`. "Inside my frame"
    // does not mean "private": the outgoing area belongs to the callee, which may even assign to a
    // stack parameter.
    //
    // How big is that area? A declared arity bounds it from BELOW — `4 * max(0, arity - 4)` — and
    // that is all the facts available here can support. It is used in exactly one direction: to
    // REFUSE. A callee declared with five parameters proves this frame has an outgoing area, and
    // consuming those stores as call operands is the dual capability, unbuilt, so the model
    // declines. A callee declared with four proves NOTHING, because a declaration is a lower bound
    // on the words a call actually pushes:
    //
    //   * a parameter may occupy more than one word (`double`, `long long`, a struct by value),
    //   * a variadic callee's list is a prefix — `sprintf` truthfully declares two and is handed six,
    //   * a large struct return adds a hidden pointer argument that appears in no parameter list.
    //
    // None of those is recorded by `FnProto` or `SymbolSignature`, so no arity here can license an
    // ACCEPTANCE. An earlier cut treated `arity <= 4` as proof of an empty area and had all three
    // holes: supplying a TRUE fact (`{ sprintf: { params: 2 } }`) turned a correct decline into
    // `return sprintf(a0, a1)` with both stack arguments deleted, where supplying nothing declined.
    // A fact must only ever move a function toward refusal — never toward an acceptance the facts
    // do not entail. Refusing on a lower bound is monotone in exactly that way: a true arity larger
    // than declared can only make the area bigger, and the answer is already "decline".
    //
    // Measured, this costs nothing it was buying: forcing the old acceptance path off changed 0
    // lift/decline verdicts across 2686 corpus functions (sa3's vendored map carries no signatures
    // at all), so the path that carried those holes was never load-bearing.
    for (const ab of asmBlocks) {
      for (const ins of ab.instrs) {
        if (ins.mnemonic !== 'bl' && ins.mnemonic !== 'blx') {
          continue;
        }
        const c = ins.ops[0] ?? '';
        const arity = protoArity(prototypes[c]) ?? protoArity(RUNTIME_HELPERS[c]);
        if (arity !== undefined && arity > target.argRegs.length) {
          return `callee \`${c}\` is declared with ${arity} arguments, so this frame has an outgoing stack-argument area — consuming stack call arguments is not implemented`;
        }
      }
    }
    // Nothing above could prove the area empty, so fall back to reading the CODE. Two conditions,
    // covering different escapes:
    //   (a) every slot store must be reloaded somewhere reachable. An outgoing argument is read by
    //       the CALLEE, never by the caller, so a store never read back is the signature of one.
    //   (b) no slot store may reach a `bl` unread ALONG A PATH.
    //
    // Neither is sound alone and the pair is not either, so keep two things straight. (a)'s real
    // theorem is not "the callee reads it, the caller does not" — it is that agbcc's
    // ACCUMULATE_OUTGOING_ARGS puts the outgoing area at the BOTTOM of localArea, disjoint from the
    // locals, so no local load can land on an argument offset. That disjointness is what a
    // tail-merged call site breaks, and agbcc DOES tail-merge: `Task_BonusFlower_Spawn` (sa3
    // bonus_game_enemies) stores argument 5 in both predecessors with the `bl` in the join.
    //
    // (b) is a forward may-analysis over the CFG, and it has been wrong twice in the other
    // direction. Scanning per block let a LABEL decide accept versus refuse; scanning the flat
    // listing let BLOCK ORDER decide, because a load in one arm of a branch cleared a store that
    // reaches the call through the other arm — swap the arms in the listing, same CFG and same
    // semantics, and the verdict flipped. Only the path-sensitive form is stable under layout.
    //
    // Only for a function that CALLS. With no call there is no outgoing area to mistake a local
    // for, and a never-reloaded store there is an ordinary dead local — which PR #30 modelled and
    // which must keep working.
    //
    // …and not when the WHOLE FRAME is an object whose address a callee holds
    // (`capturedObjectIsTheWholeFrame` — a one-word frame, passed by a bare `mov rD, sp`). Both
    // conditions hunt for an argument block; every argument block starts at [sp,#0] (that is what
    // `prefixStored` encodes); and a one-word frame that is entirely an addressable local has no
    // room for one. So there is no argument block to find and both conditions can only fire as
    // FALSE ALARMS — which is what they did: the three address-taken rows in the synthetic tier
    // declined at (a) on a store that is never reloaded for the ordinary reason, that the CALLEE
    // reads it through the pointer.
    //
    // This is the only acceptance in this function, so keep straight what licenses it. NOT arity: a
    // callee declared with four arguments proves nothing (see above), and the layout gate is
    // deliberately independent of the declarations. The arity refusal still runs FIRST and still
    // wins — in a one-word frame a declared fifth argument and an addressable local at offset 0 are
    // contradictory claims about the same word, so the honest answer there is the decline, not a
    // guess about which one to believe.
    if (
      !capturedObjectIsTheWholeFrame &&
      asmBlocks.some((ab) => ab.instrs.some((i) => i.mnemonic === 'bl' || i.mnemonic === 'blx'))
    ) {
      const slotAcc = (ins: Instr) => {
        const a = spMemAccess(ins);
        return a && !a.regOff && a.width === 4 && a.off % 4 === 0 && a.off >= 0 && a.off + 4 <= localArea
          ? a.off
          : null;
      };
      const isStore = (ins: Instr) => /^str/.test(ins.mnemonic);
      // Entry-REACHABLE blocks only: a reload in dead code is not evidence that live code reads the
      // slot back, and counting it lets an argument store satisfy (a) on the strength of an
      // instruction that never executes.
      const live = entryReachable;
      const reloaded = new Set<number>();
      for (const b of live) {
        for (const ins of asmBlocks[b].instrs) {
          const off = slotAcc(ins);
          if (off !== null && !isStore(ins)) {
            reloaded.add(off);
          }
        }
      }
      // CONTIGUITY. AAPCS lays the outgoing stack arguments at [sp,#0] upward, one word each, so an
      // argument block is CONTIGUOUS FROM ZERO: a store at [sp,#4] can be argument 6 of a call only
      // if argument 5 at [sp,#0] is also supplied on a path to that same call. A pending store
      // whose lower slots are nowhere supplied is therefore provably not an argument block, and
      // refusing it is a false alarm — the exact false alarm that blocked the commonest real shape,
      // a value spilled at [sp,#4] and kept live across calls (kleod's ProcessInputAndUpdateEntities
      // stores its `sp4` local and calls m4aSongNumStart 80 lines later, with offset 0 never stored
      // in the whole function).
      //
      // The calibration in this: a conforming caller stores EVERY argument slot of a call it makes,
      // so "slot 0 unsupplied" rules out "slot 4 is an argument". Hand-written asm could skip
      // storing an argument the callee never reads; agbcc cannot (no interprocedural dead-argument
      // elimination). That is the same producer assumption the reload conditions above already
      // make, stated once here.
      const prefixStored = (k: number, st: Set<number>): boolean => {
        for (let j = 0; j < k; j += 4) {
          if (!st.has(j)) {
            return false;
          }
        }
        return true;
      };
      // (a), contiguity-filtered: a store never reloaded ANYWHERE is an argument's signature only
      // if its lower slots are supplied somewhere too; otherwise it is an ordinary dead local.
      const storedAnywhere = new Set<number>();
      for (const b of live) {
        for (const ins of asmBlocks[b].instrs) {
          const off = slotAcc(ins);
          if (off !== null && isStore(ins)) {
            storedAnywhere.add(off);
          }
        }
      }
      for (const off of storedAnywhere) {
        if (!reloaded.has(off) && prefixStored(off, storedAnywhere)) {
          return `the store to [sp,#${off}] is never reloaded and its lower slots are supplied — it may be an outgoing stack argument of one of this function's calls`; // (a)
        }
      }
      // (b): `pendingOut[b]` = offsets stored and not yet reloaded on SOME path through b;
      // `storedOut[b]` = offsets stored on SOME path through b (a reload does not remove the value
      // from memory, so it does not remove the offset from this set — the callee would still read
      // what the store put there).
      const pendingOut: Array<Set<number>> = asmBlocks.map(() => new Set<number>());
      const storedOut: Array<Set<number>> = asmBlocks.map(() => new Set<number>());
      for (let changed = true; changed;) {
        changed = false;
        for (let b = 0; b < asmBlocks.length; b++) {
          if (!live.has(b)) {
            continue;
          }
          const pend = new Set<number>();
          const st = new Set<number>();
          for (const q of preds[b]) {
            for (const off of pendingOut[q]) {
              pend.add(off);
            }
            for (const off of storedOut[q]) {
              st.add(off);
            }
          }
          for (const ins of asmBlocks[b].instrs) {
            const off = slotAcc(ins);
            if (off !== null) {
              if (isStore(ins)) {
                pend.add(off);
                st.add(off);
              } else {
                pend.delete(off);
              }
            } else if (ins.mnemonic === 'bl' || ins.mnemonic === 'blx') {
              for (const k of pend) {
                if (prefixStored(k, st)) {
                  // (b) — a plausible argument block reaches this call unread
                  return `the store to [sp,#${k}] reaches \`bl ${ins.ops[0] ?? '?'}\` unread with its lower slots supplied — it may be that call's outgoing stack argument`;
                }
              }
            }
          }
          const grow = (out: Array<Set<number>>, cur: Set<number>): void => {
            if (cur.size !== out[b].size || [...cur].some((o) => !out[b].has(o))) {
              out[b] = cur;
              changed = true;
            }
          };
          grow(pendingOut, pend);
          grow(storedOut, st);
        }
      }
    }
    // A `pop`/`ldm` off sp READS frame memory, and push/pop are transparent to dataflow, so a pop
    // taken while the local area is still reserved reads a slot this model has retargeted into SSA
    // — the load simply disagrees with the store. A real epilogue releases the locals first
    // (`add sp,#N; pop {…}`), which is what this requires; `pop {r1}` mid-frame does not.
    for (const ab of asmBlocks) {
      let released = 0;
      for (const ins of ab.instrs) {
        if ((ins.mnemonic === 'pop' || ins.mnemonic === 'ldmia') && released < localArea) {
          const base = ins.mnemonic === 'pop' ? 'sp' : (ins.ops[0] ?? '').replace(/!$/, '');
          if (isSpReg(base)) {
            return 'a pop reads the frame while the local area is still reserved';
          }
        }
        if ((ins.mnemonic === 'add' || ins.mnemonic === 'sub') && isSpReg(ins.ops[0])) {
          const d = spAdjust(ins);
          if (d !== null && d > 0) {
            released += d;
          }
        }
      }
    }
    return null;
  };
  // The frame the body sees: the entry block's PROLOGUE, i.e. everything up to the first
  // instruction that touches the frame (or the whole block if it never does). A frame the walk
  // cannot measure yields 0, which disables every slot (`off + 4 <= localArea` is then false).
  //
  // NOT the same walk `argIndex` uses: `makeFrameWalk.delta` counts `push` at 4 bytes per register,
  // this one skips it, because the callee-saved block sits ABOVE the local area. The cost of that
  // difference is the push/pop arm below.
  // How much sp moves for `add/sub sp, #imm`, positive = sp RISES (frame shrinks). null if not that
  // shape. Only used to recognise a release; the authoritative depth arithmetic is makeFrameWalk's.
  const spAdjust = (ins: Instr): number | null => {
    if (!/^(add|sub)$/.test(ins.mnemonic) || !isSpReg(ins.ops[0])) {
      return null;
    }
    const o = ins.ops[2] ?? ins.ops[1];
    if (o === undefined || !o.startsWith('#')) {
      return null;
    }
    const v = imm(o);
    return ins.mnemonic === 'sub' ? -v : v;
  };
  // The EXPLICITLY reserved local area — the prologue's `add sp,sp,#-N`. A slot must live strictly
  // inside this, not merely inside the whole frame: the rest of the frame is the callee-saved block
  // the entry `push` wrote, which belongs to the epilogue's `pop`, so a `str` there is retargeted
  // away from the memory the pop will read.
  const localArea = ((): number => {
    // The PROLOGUE only — everything before the entry block first touches the frame. Summing the
    // whole block instead let a store made BEFORE the reservation fall inside the window, so
    // `str r0,[sp]; add sp,sp,#-4; …` claimed a write to the CALLER's frame as a private local and
    // deleted it.
    //
    // NET, not the sum of the negatives. Counting only reservations and discarding releases leaves
    // localArea larger than the region that is actually below the callee-saved block, and `off <
    // localArea` then claims the SAVED REGISTERS as private locals — which the epilogue's `pop`
    // reads back. `push {lr}; add sp,#-8; add sp,#8; str r0,[sp]; pop {r1}; bx r1` deleted the
    // store and rendered a computed `bx` as an ordinary return, and it fooled the pop gate too
    // (`released` is compared against this number). Not corpus-reachable — 0 of 2805 Thumb
    // functions adjust sp upward before their first frame access — which is exactly why only a
    // probe finds it.
    //
    // An sp write this cannot read poisons the whole thing to 0, disabling every slot, rather than
    // being skipped as if it were no movement: the same rule spDelta follows.
    const ins = asmBlocks[0].instrs;
    const firstMem = ins.findIndex((x) => touchesFrame(x));
    let reserved = 0;
    let reservedYet = false;
    for (const x of ins.slice(0, firstMem === -1 ? ins.length : firstMem)) {
      const d = spAdjust(x);
      if (d !== null) {
        reserved -= d; // d > 0 = sp rises = the frame shrinks
        reservedYet ||= reserved > 0;
      } else if (x.mnemonic === 'push' || x.mnemonic === 'pop') {
        // BEFORE any reservation this is the callee-saved block, measured from below — the
        // ordinary agbcc prologue, and why push/pop are skipped at all. AFTER one it slides sp
        // under the window just measured, so `[0, localArea)` stops naming the reserved area and
        // starts naming the pushed words. Those words ARE written, by an instruction that is
        // dataflow-transparent, so nothing downstream can tell:
        // `push {r4,lr}; add sp,#-8; push {r0}; … ldr r1,[sp]` reads back the pushed `r0` on every
        // path and the def-less shape renders it as an uninitialised local — 0 from the machine,
        // garbage from the C. Poisoned to 0 rather than corrected by subtracting the push bytes,
        // the same rule the sp-write arm follows. Not corpus-reachable — agbcc pushes before it
        // reserves in all 2343 Thumb functions — which is why only a probe finds it.
        if (reservedYet) {
          return 0;
        }
      } else if (isSpReg((x.ops[0] ?? '').replace(/!$/, ''))) {
        return 0; // an sp write of a shape this does not model
      }
    }
    return Math.max(0, reserved);
  })();

  // WHAT THE PROLOGUE SAVED — the second half of the register partition (frontend/ssa.ts,
  // LiveInModel.uninitRegs), in operand spellings. "The ABI does not pass arguments here" is a fact
  // about the CALLER and cannot on its own make a def-less read an uninitialised local; what does is
  // that the compiler homed a local in the register, which it may only do after saving it. Asm that
  // saves nothing follows no such convention, and some of it really is handed live values there:
  // the MP2K engine's hand-written `ChnVolSetAsm`, vendored in klonoa, sa3 and pokeemerald alike,
  // takes two pointers in r4/r5 and has no prologue at all — classified by the ABI alone it lost its
  // signature and stored through reads of registers nothing ever wrote.
  //
  // PER REGISTER, because saving r5 says nothing about r4 — a mid-function fragment reached by
  // agbcc's `bl`-as-a-long-branch saves what it uses and is handed the rest.
  //
  // The prologue is the LEADING run of saves and reservations, so a `push` in the body cannot join
  // the set. `HIGH_REGS` have no `push` encoding, so agbcc saves them as `mov rLow, rHi; push
  // {rLow}` and the source of such a `mov` joins the set when its low register is pushed — every
  // high-register inhabitant in the corpus goes through that idiom.
  const savedRegs = ((): ReadonlySet<string> => {
    const saved = new Set<string>();
    const carries = new Map<string, string>(); // low register ← the high one moved into it
    for (const x of asmBlocks[0].instrs) {
      if (x.mnemonic === 'push') {
        const list = definiteRegList(
          x.ops
            .join(',')
            .replace(/[{}]/g, '')
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean),
        );
        if (list === null) {
          break; // a list this cannot read is a save set this cannot vouch for
        }
        for (const r of list) {
          saved.add(r);
          const hi = carries.get(r);
          if (hi !== undefined) {
            saved.add(hi);
          }
        }
      } else if (/^movs?$/.test(x.mnemonic) && HIGH_REGS.has(x.ops[1] ?? '') && !HIGH_REGS.has(x.ops[0] ?? '')) {
        carries.set(x.ops[0], x.ops[1]);
      } else if (spAdjust(x) === null) {
        break;
      }
    }
    return saved;
  })();

  // …AND THE FRAME IS THAT OBJECT. `frameBasePassedToCallee` is a fact about a register; this is
  // the layout fact, and it is the one that licenses turning the outgoing-argument refusals off.
  //
  // The reason it is needed at all: a bare `mov rD, sp` names frame offset 0, but agbcc emits one
  // for TWO different things, and only one of them is an addressable local. The other is a
  // BLOCK-COPY BASE — the destination of a by-value struct argument (which IS the outgoing argument
  // area) and the hidden return pointer of a struct-returning call. Both compiled, agbcc
  // 2.9-arm-000512, `-O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix`:
  //
  //   by-value struct argument, `void f(struct S *p){ take(*p); }`, by stack words beyond r0-r3:
  //     1 word  → `ldr r0,[r3,#0x10]; str r0,[sp]`  — no capture at all, frame 4
  //     2 words → `mov r1, sp; ldmia r0!,{…}; stmia r1!,{…}` — frame 8
  //     13+     → `mov r0, sp; mov r2,#0x44; bl memcpy` — frame 0x44 and up
  //   struct return, `void f(int x){ struct R r = mk(x); use2(r.a[0]); }`:
  //     1 word, INTEGER-LIKE (`{int a;}`, `{int a[1];}`, `{float f;}`) → r0, no frame temp
  //     1 word, otherwise (`{char a,b,c,d;}`, `{short a,b;}`) → `mov r0, sp; bl mk` — frame 4
  //     2 words → `mov r0, sp; bl mk` — frame 8
  //
  // Left unguarded that cost an argument: `void g3(struct Huge *p, int x){ takesH(*p);
  // five(1,2,3,4,x); }` puts `str r5,[sp]` — argument 5 of `five` — in a frame whose offset 0 the
  // memcpy also names, and the lift emitted `five(1, 2, 3, 4)` with the fifth argument written into
  // a fabricated 4-byte local, in a frame declared 4 bytes where the machine reserves 0x90. Order
  // is not the discriminator either: with the five-argument call FIRST the same thing happens.
  //
  // So the gate is the MODEL'S OWN EXTENT. This frontend models the captured object as the single
  // word at [sp,#0] (`isFrameObjectAccess` below), and a one-word model is a description of the
  // frame only when the frame IS that word. `localArea === 4` says exactly that. It excludes every
  // block-copy base — each needs two frame words before agbcc names its base with a register at
  // all — and the two-word struct returns with them. Any larger frame has bytes this model does not
  // describe, and they are either the rest of a wider object the callee writes or another call's
  // argument slots; neither is provable here, so the answer stays the decline.
  //
  // What the frame size does NOT exclude is the one-word struct return in the table above, which is
  // instruction-for-instruction an out-parameter call. That one is settled after the lift, by the
  // premise re-check in the frame-object audit — which is also where the licence's other half is
  // re-proven.
  //
  // WHAT THIS GATE IS NOT. It switches the outgoing-argument refusals off, and nothing else. The
  // object model runs on ANY frame — the `laddrs` path in the audit below — so a `u8 buf[12]`
  // handed to a callee arrives there through a frame this conjunct never looks at, and what bounds
  // its extent is the audit's frame-accounting rule rather than anything here.
  //
  // WHY IT IS NOT WIDENED anyway, since a wider frame is the obvious next lever. Three shapes,
  // each compiled with agbcc 2.9-arm-000512, `-O2 -mthumb-interwork -Wimplicit -fhex-asm
  // -fprologue-bugfix`, and only the first is about extent at all:
  //
  // UNDECIDABLE — a slot THIS FUNCTION stores and reloads. Two sources that disagree about who
  // owns [sp,#4] compile to one instruction stream, byte for byte, with eight values live across
  // the calls so one of them spills:
  //
  //   s32 loc; s32 t0..t7;                   loc = x;  t0 = h(0); … g(&loc); k(loc + t0 + …);
  //   struct P { s32 a, b; } p; s32 t1..t7;  p.a = x;  p.b = h(0); … g(&p);   k(p.a + p.b + …);
  //
  // The first says a callee may not touch [sp,#4]; the second says it may, and the reload after the
  // call must read what it wrote. Nothing distinguishes them, so a licence over THAT slot would be
  // a guess — which is why the slot rule in the audit refuses the shape rather than deciding it.
  //
  // PINNED, and refused by the MODEL — sub-word members. Thumb has no sp-relative `strb`, so a
  // byte or halfword member is reached through a copy of sp, and the access at +4 witnesses that
  // the object reaches past its first word: `struct Q { u8 a; u8 pad[3]; u8 b; }` filled and then
  // handed over compiles to `mov r1, sp / strb r0, [r1] / strb r0, [r1, #0x4] / mov r0, sp / bl g`.
  // The escape is a use that is not an access, so the capture cannot be split per offset, and the
  // audit judges the [+4] access against the one object it does model — "only a scalar at the
  // captured address is modelled", and the SAME message when this conjunct is widened to
  // `localArea >= 4` (measured).
  //
  // PINNED, and ambiguous in its ROLE — a frame-covering block copy. `struct Big { s32 a[17]; };
  // b = gK; g(&b);` compiles to `add sp,#-0x44 / mov r0,sp / mov r2,#0x44 / bl memcpy`: the copy
  // bounds the object from below and the reservation from above, so the extent is exact. What is
  // NOT pinned is what the object IS — the producer table above records those same instructions
  // for a by-value struct ARGUMENT block and for a struct-return temp. Widening this conjunct
  // moves it exactly there: it then declines at "which is how a hidden struct-return pointer
  // looks" (measured), never at anything about extent.
  //
  // So a wider frame licence admits nothing this model can describe. `extent` is one scalar width
  // from one access, and the second access that would build a wider object is a `[+k]` the audit
  // refuses first: widened, the sub-word shape declines on the very same message and the
  // block-copy one moves onto the struct-return refusal (both measured).
  //
  // RESIDUE: the producer table is agbcc's, so hand-written asm that reserves one word, stages it
  // as a call's fifth argument and ALSO puts sp in an argument register defeats this — the same
  // producer assumption the contiguity filter below makes. The producer is named in the gate
  // rather than left to the prose: `armv4t` has one compiler entry today, and a second one free to
  // overlay a dead one-word local with a one-word outgoing area would inherit an acceptance whose
  // only evidence is an agbcc compile table.
  //
  // WHICH CONJUNCT REFUSES WHAT, for a reader arriving with a wide frame in hand. klonoa's
  // `LoadBGTilemapData` (a checkout function, not a benchmark row) reserves 0x3C and fails the
  // OTHER conjunct: its `mov r5, sp` is the DMA-fill PUBLISH (`strh r7, [r5]` / `mov r0, sp` /
  // `str r0, [r2]`, r2 = 0x040000D4), not a base live in an argument register at a `bl`.
  // Instrumented, it arrives with localArea=60 and frameBasePassedToCallee=false, lifts today with
  // the object modelled as `volatile u16 sp0`, and its lift is byte-identical with this conjunct
  // widened to `localArea >= 4` (measured). No answer to the frame size moves it.
  const capturedObjectIsTheWholeFrame = target.compiler === 'agbcc' && frameBasePassedToCallee && localArea === 4;

  const slotsOffReason = slotModelBlocker();
  const slotsOk = slotsOffReason === null;
  // Every offset the body actually keys as an SSA slot — the frame-object audit checks the
  // address-taken object cannot overlap one (two models for one byte is a silent disagreement).
  const usedSlotOffsets = new Set<number>();

  // …AND THE ONE OFFSET THAT MUST NOT BE A SLOT. When `capturedObjectIsTheWholeFrame` holds, the
  // frame is one word and a callee is being handed its address, so an `[sp,#0]` access is an access
  // to THAT OBJECT — provisionally, since the audit is what proves the object is a local at all. Keying it as an SSA slot instead moves the value into a
  // register and deletes the store from memory — and the callee reading it through the pointer is
  // invisible to every check the slot model makes, so the deletion would be silent.
  //
  // The frame-object audit does catch the collision today ("one byte, two models"), as a DECLINE.
  // Routing the access through an `laddr` here is what turns that decline into the lift, and it
  // hands the audit the same object it would have judged anyway — offset, width and escape all
  // come from the machine.
  //
  // Word accesses only, and only while the slot model is on: a sub-word or register-offset
  // `[sp,#k]` anywhere turns the whole model off (slotModelBlocker), and the `mov rD, sp` arm then
  // declines the capture rather than reaching this.
  const isFrameObjectAccess = (base: string, off: number, regOff: string | undefined, width: number): boolean =>
    slotsOk && capturedObjectIsTheWholeFrame && isSpReg(base) && regOff === undefined && off === 0 && width === 4;

  // The WRITE dual of readData, and the reason it exists is a lesson rather than a symmetry: the
  // first version of this guard checked sp in three decode arms (mov/add/sub) and its commit message
  // claimed "every write to sp declines". It did not — `lsl sp, r4, #2`, `neg sp, r4`, `mvn sp, r4`,
  // `ldr sp, [r0,#4]` and `ldmia r0!, {sp}` all still lifted, dropping the sp write silently, because
  // an enumeration of arms can only cover the arms someone thought of. Guarding the write ITSELF
  // cannot be incomplete.
  //
  // sp is writable in exactly one shape — the frame adjust the add/sub arms `break` on before
  // reaching here (see isFrameAdjust). Anything else that writes sp is a frame change this frontend
  // cannot model, and dropping it silently deletes that change while the function keeps compiling.
  //
  // Known residual, zero inhabitants: `pop {sp}` never reaches here (push/pop are skipSafe in the
  // opaque policy), so it stays silently transparent. ARMv4T Thumb cannot encode sp in a pop reglist.
  const writeData = (r: string, b: number, v: Value): void => {
    if (isSpReg(r)) {
      throw spAsDataError();
    }
    writeVar(r, b, v);
  };

  // Best-effort call arity via the shared helper (frontend/ssa.ts).
  const fallbackArgcHere = (b: number): number => fallbackArgc(ssa, target.argRegs, b);

  // --- fill each block in order, sealing blocks as their predecessors complete ---
  const fillBlock = (ab: AsmBlock, bi: number) => {
    const irb = irBlocks[bi];
    let pendingCmp: { lhs: Value; rhs: Value } | null = null;
    // Tracks the frame through this block's linear instruction order. Meaningful for the entry
    // block; elsewhere a `[sp,#N]` access declines.
    const frame = makeFrameWalk();

    // TRUSTWORTHINESS GUARD (mirrors the MIPS/PPC frontends): an unmodelled instruction must not
    // silently drop its destination register — emit an honest `opaque`, which fails LOUD at
    // assertResolved whether or not anything reads that register (see frontend/opaque.ts). Push/pop and sp
    // adjustments have no low-register data destination, so they fall through harmlessly;
    // terminators are handled in the terminator section below.
    const isThumbReg = (s: string | undefined): s is string => /^r\d+$/.test(s ?? '');
    const emitOpaqueDest = (ins: { mnemonic: string; ops: string[]; asWritten?: string }) => {
      // storeClass: unmodelled Thumb stores are str*/stm* — `stmia rN!, {…}`'s dest token `r0!`
      // fails isReg, so without this it would be skipped as "no reg dest", silently deleting the
      // memory writes AND the base writeback. push/pop stay transparent frame ops (they don't match).
      // skipSafe: push/pop stay transparent frame ops (the deliberate policy);
      // everything else with no register destination (swi, …) throws in opaqueDest.
      const od = opaqueDest(ins.mnemonic, ins.ops, {
        isReg: isThumbReg,
        normalize: reg,
        storeClass: /^(str|stm)/i,
        skipSafe: /^(push|pop|nop)$/i,
        context: name,
        display: ins.asWritten,
      });
      if (!od) {
        return;
      }
      const operands = od.srcRegs.map((r) => readVar(r, bi));
      const res = mkValue(T.unk(32));
      // carry the mnemonic so annotate mode can name the gap (`ASMLIFT_ERROR("unmodelled 'rsb'")`)
      irb.ops.push(mkOp('opaque', { operands, results: [res], attrs: { mnemonic: ins.asWritten ?? ins.mnemonic } }));
      writeData(od.dst, bi, res);
    };
    // 2-operand ALU form `op rD, op2` (rD = rD ⟨op⟩ op2). `op2` is an immediate (`#N`) or a
    // register. A destination that is NOT a low data register (`add sp, #8` / `sub sp, #N` frame
    // adjustments) is transparent to dataflow — the frame is push/pop-based — so it falls through
    // harmlessly, matching the documented sp handling. A malformed operand (missing / non-register
    // non-immediate) degrades to a loud opaque rather than a crash or a silent data-dest drop.
    const emit2op = (opc: Opcode, dReg: string, op2: string | undefined, bi: number) => {
      // The one sp guard writeData CANNOT supply: this path returns without ever producing a value
      // to write, so a bad sp destination would never reach the write. It is only reachable from the
      // add/sub arms, which have already let the whitelisted frame adjust `break` out — so an sp
      // destination here is by construction NOT that shape (`add sp, r4`: a register-sized frame
      // adjustment, how agbcc spells a frame too large for the 7-bit immediate).
      //
      // Honesty about what this is worth: the 4 real `add sp, rN` sites in the sa3 checkout all sit
      // in functions that ALSO do `mov rN, sp` 70+ times, so they declined before this guard and
      // decline after it. No wrong C was ever emitted by this shape. The guard is defence in depth
      // for the day a stack capability makes those functions liftable — not a miscompile fixed.
      //
      // This looked dead during review and is not: it becomes reachable the moment the arm-local
      // guards are removed, which is exactly what the test at 'add sp, r4' pins.
      if (isSpReg(dReg)) {
        throw spAsDataError();
      }
      if (!isThumbReg(reg(dReg))) {
        return;
      } // pc: claimed by classifyXfer first
      if (op2 === undefined) {
        emitOpaqueDest({ mnemonic: opc, ops: [dReg] });
        return;
      }
      const rhs = op2.startsWith('#') ? constVal(imm(op2), bi) : readData(reg(op2), bi);
      const res = mkValue(T.unk(32));
      irb.ops.push(mkOp(opc, { operands: [readData(reg(dReg), bi), rhs], results: [res] }));
      writeData(reg(dReg), bi, res);
    };

    for (const ins of ab.instrs) {
      // Control transfers (branches, returns) are emitted in the terminator section below — skip them
      // here so a return-form PC write (`mov pc, lr`, `pop {…,pc}`) is not decoded as a data write to a
      // phantom `pc` register (a silent drop of the return). `cmp` is not a transfer, so it still runs.
      if (classifyXfer(ins)) {
        continue;
      }
      // A Thumb-1 data-processing instruction on LOW registers writes the condition flags whether or
      // not the mnemonic carries the `s` (agbcc spells `adds r0,r0,r3` as `add r0,r0,r3`, and the
      // assembler picks the flag-setting encoding) — so an instruction between a `cmp` and its branch
      // REPLACES the flags the branch will test. Folding the earlier `cmp` in anyway would emit a
      // condition on the wrong operands: silently wrong C with no marker. Drop the pending compare
      // and let the terminator's existing "no reaching compare in its block" decline fire — the loud
      // answer, since modelling arithmetic flags is a capability asmlift does not have.
      //
      // The HIGH-register forms (`mov rD,rH`, `add rD,rH`) do NOT set flags and stay transparent,
      // which is what keeps agbcc's callee-saved shuffling from tripping this. Measured free: across
      // every agbcc row in the benchmark, no conditional-branch block has ANY instruction between its
      // compare and the branch — compilers keep the pair adjacent. The inhabitant this guards is
      // hand-written asm in the playground, where there is no oracle to catch a lie.
      if (FLAG_SETTING.has(ins.mnemonic) && /^r[0-7]$/.test(reg(ins.ops[0] ?? ''))) {
        pendingCmp = null;
      }
      frame.step(ins);
      const [a, b, c] = ins.ops;
      switch (ins.mnemonic) {
        case 'mov':
        case 'movs': {
          // `mov rD, sp` captures the address of the frame's local area — the DMA-fill idiom
          // (`DmaFill16` expands to `vu16 tmp; DmaSet(…, &tmp, …)`) and any `&local` argument.
          // Emitted as `laddr`, gaddr's local twin; every use is proven by the frame-object audit
          // after the blocks are filled, and any use it cannot vouch for declines the function
          // loudly there. Gated on the slot model (the frame must be private and immovable) and on
          // a reserved local area for the object to live in.
          if (!b?.startsWith('#') && isSpReg(b ?? '') && !isSpReg(a ?? '')) {
            if (slotsOk && localArea > 0) {
              const res = mkValue(T.unk(32));
              irb.ops.push(mkOp('laddr', { results: [res], attrs: { off: 0 } }));
              writeData(reg(a), bi, res);
              break;
            }
            throw spAsDataError();
          }
          const v = b?.startsWith('#') ? constVal(imm(b), bi) : readData(reg(b), bi);
          writeData(reg(a), bi, v);
          break;
        }
        case 'add':
        case 'adds': {
          // Frame bookkeeping first: it must outrank the `#0` copy idiom below, or `add sp, sp, #0`
          // takes the copy path and declines while `add sp, #0` is transparent — the same
          // two-spellings inconsistency one N lower down.
          if (isFrameAdjust(ins.mnemonic, a, c === undefined ? undefined : b, c ?? b)) {
            break;
          }
          // `add rD, rS, #0` is agbcc's low-register copy idiom (Thumb `mov rD, rS` between
          // low regs isn't always available). Model it as a pure copy — the SAME SSA VALUE — not
          // an `x + 0` add. Value identity is what it buys: the pattern engine matches on it
          // (`{same:'X'}`), and the structurer's pre-update loop test compares a back-edge argument
          // against an exit argument by identity, so an `x + 0` between them reads as a different
          // value and declines a loop that is perfectly ordinary.
          //
          // NOT call-argument liveness, which this comment claimed for several releases: both arms
          // end in `writeData(reg(a), …)`, and the arity machinery (`fallbackArgc`,
          // `trimClobberedCallArgs`) is keyed on the register, never on the value — measured, zero
          // arity changes across 3337 corpus functions even with this idiom ablated entirely.
          if (immEq(c, 0)) {
            writeData(reg(a), bi, readData(reg(b), bi));
            break;
          }
          // 2-operand form `add rD, op2` (rD = rD + op2): op2 in `b`, no third operand.
          // A malformed 1-operand `add` degrades to a loud opaque.
          if (c === undefined) {
            emit2op('add', a, b, bi);
            break;
          }

          const rhs = c?.startsWith('#') ? constVal(imm(c), bi) : readData(reg(c), bi);
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('add', { operands: [readData(reg(b), bi), rhs], results: [res] }));
          writeData(reg(a), bi, res);
          break;
        }
        case 'sub':
        case 'subs': {
          if (isFrameAdjust(ins.mnemonic, a, c === undefined ? undefined : b, c ?? b)) {
            break;
          }
          if (c === undefined) {
            emit2op('sub', a, b, bi);
            break;
          } // `sub rD, op2` → rD = rD - op2

          const rhs = c?.startsWith('#') ? constVal(imm(c), bi) : readData(reg(c), bi);
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('sub', { operands: [readData(reg(b), bi), rhs], results: [res] }));
          writeData(reg(a), bi, res);
          break;
        }
        case 'lsr':
        case 'lsl':
        case 'asr':
        case 'lsrs':
        case 'lsls':
        case 'asrs': {
          const shiftMn = ins.mnemonic.replace(/s$/, ''); // pret spells the flag-setting forms lsls/lsrs/asrs
          const opc = shiftMn === 'lsr' ? 'shr_u' : shiftMn === 'asr' ? 'shr_s' : 'shl';
          // A missing SECOND operand is malformed — degrade to a loud opaque like emit2op does.
          if (b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const res = mkValue(T.unk(32));
          if (c === undefined) {
            // 2-operand register form `lsl rD, rS` → rD = rD << rS
            irb.ops.push(mkOp(opc, { operands: [readData(reg(a), bi), readData(reg(b), bi)], results: [res] }));
          } else if (c.startsWith('#')) {
            // immediate form `lsl rD, rS, #n`
            irb.ops.push(mkOp(opc, { operands: [readData(reg(b), bi)], results: [res], attrs: { imm: imm(c) } }));
          } else {
            // register form `lsl rD, rS, rN` → rD = rS << rN
            irb.ops.push(mkOp(opc, { operands: [readData(reg(b), bi), readData(reg(c), bi)], results: [res] }));
          }
          writeData(reg(a), bi, res);
          break;
        }
        case 'neg':
        case 'negs': {
          // `neg rD, rS` (and `rsb rD, rS, #0`) = arithmetic negation → -x
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('neg', { operands: [readData(reg(b), bi)], results: [res] }));
          writeData(reg(a), bi, res);
          break;
        }
        case 'rsb':
        case 'rsbs': {
          // Reverse subtract. `rsb rD, rS, #0` is the negate idiom (0 - rS) → -x. Any other form
          // (`rsb rD, rS, #N`, N≠0 — not a Thumb-1 encoding, but be safe) is NOT modelled: degrade
          // to a loud `opaque` rather than silently leaving rD unwritten (a silent miscompile).
          if (immEq(c, 0)) {
            const res = mkValue(T.unk(32));
            irb.ops.push(mkOp('neg', { operands: [readData(reg(b), bi)], results: [res] }));
            writeData(reg(a), bi, res);
          } else {
            emitOpaqueDest(ins);
          }
          break;
        }
        case 'mvn':
        case 'mvns': {
          // `mvn rD, rS` = bitwise NOT → ~x
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('not', { operands: [readData(reg(b), bi)], results: [res] }));
          writeData(reg(a), bi, res);
          break;
        }
        case 'bic':
        case 'bics': {
          // `bic rD, rM` (2-op) / `bic rD, rD, rM` (agbcc's redundant 3-op spelling) = rD & ~rM —
          // emitted verbatim by agbcc for the C idiom `x & ~y` (kleod's ReadKeyInput
          // key-transition mask), so the not+and pair recompiles to bic.
          if (b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const [xr, mr] = c !== undefined ? [reg(b), reg(c)] : [reg(a), reg(b)];
          const inv = mkValue(T.unk(32));
          irb.ops.push(mkOp('not', { operands: [readData(mr, bi)], results: [inv] }));
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('and', { operands: [readData(xr, bi), inv], results: [res] }));
          writeData(reg(a), bi, res);
          break;
        }
        case 'ror':
        case 'rors': {
          // `ror rD, rS` (2-op) / `ror rD, rD, rS` (redundant 3-op) = rotate right → the rotr
          // op; the structurer spells the C rotate idiom, which agbcc compiles back to this ror.
          if (b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const [xr, nr] = c !== undefined ? [reg(b), reg(c)] : [reg(a), reg(b)];
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('rotr', { operands: [readData(xr, bi), readData(nr, bi)], results: [res] }));
          writeData(reg(a), bi, res);
          break;
        }
        case 'ldmia':
        case 'stmia': {
          // Load/store-multiple with writeback: `ldmia rN!, {rA, rB…}` = one word access per
          // listed register at ascending offsets, then rN += 4×count. splitOperands is
          // brace-depth-aware, so the register list arrives as ONE token ('{rA, rB}'); the
          // rejoin below also tolerates a split list defensively. Thumb-1 LDMIA skips the
          // writeback when rN is itself in the list (the loaded value wins) — modelled; any
          // malformed shape degrades to the loud opaque.
          // There is NO no-writeback form in Thumb-1, so the `!` is decoration and must not drive
          // the model. Four sources agree:
          //   * ARM DDI 0029G Table 1-7 gives the canonical syntax as `LDMIA Rb!, <reglist>` and
          //     `STMIA Rb!, <reglist>` — the `!` is part of the mnemonic, not an option, and
          //     Figure 1-6 Format 15 has no bit that could encode its absence;
          //   * GNU as assembles `ldm r1,{r0}` and `ldm r1!,{r0}` to the same halfword, 0xc901,
          //     and warns "this instruction will write back the base register";
          //   * gba-kit executes both with the base advanced by 4;
          //   * GBATEK, THUMB.15: "Both STM and LDM are incrementing the Base Register".
          // An earlier version of this comment called the `!`-less spelling "the valid
          // no-writeback form — same transfers, base unchanged", which is false, and the code
          // below acted on it. A missing register list is malformed → loud opaque.
          const baseTok = a;
          const writeback = !!baseTok?.endsWith('!');
          if (baseTok === undefined || b === undefined || !b.startsWith('{')) {
            emitOpaqueDest(ins);
            break;
          }
          const baseReg = reg(writeback ? baseTok.slice(0, -1) : baseTok);
          // Anything but a list of definite registers — an unexpandable range (alias endpoint,
          // e.g. `r4-lr`), a token naming no register, an empty list — leaves the transfer set
          // ambiguous, so degrade to the loud opaque rather than guess. Checking only for the
          // leftover `-` let `{foo}` through and fabricated a parameter out of it.
          const list = definiteRegList(
            ins.ops
              .slice(1)
              .join(',')
              .replace(/[{}]/g, '')
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean),
          );
          if (list === null) {
            emitOpaqueDest(ins);
            break;
          }
          // An STM whose base is in its own list, but is not the LOWEST entry, stores a value this
          // frontend must not guess — because the available references DISAGREE about what it is.
          //
          //   ARM:      UNPREDICTABLE, "the stored value cannot be relied upon".
          //   GNU as:   warns "value stored for rN is UNKNOWN".
          //   GBATEK:   version-specific — "Store OLD base if Rb is FIRST entry in Rlist,
          //             otherwise store NEW base (STM/ARMv4), always store OLD base (STM/ARMv5)".
          //   mGBA:     stores the OLD base unconditionally, on an ARMv4T core — its STM_LOOP
          //             reads gprs[i] during the loop and the writeback runs after it.
          //
          // So GBATEK's ARMv4 rule and the reference emulator's behaviour do not agree, and no
          // hardware test result was found either way. This frontend used to emit the old base,
          // i.e. it silently picked one side of that disagreement. Declining is the contract:
          // where the architecture declines to define a value, so do we.
          //
          // (One site in the Klonoa corpus, in unreachable code after a `pop`/`bx`, and it already
          // declines for an unrelated pc-relative-pool reason — so this costs nothing today.)
          if (ins.mnemonic === 'stmia' && list.some((r) => reg(r) === baseReg) && reg(list[0]) !== baseReg) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': stm with the base register in its own list, not as the lowest ` +
                `entry — the value stored for that register is UNPREDICTABLE and differs between ` +
                `ARMv4 (new base) and ARMv5 (old base)`,
            );
          }
          // SNAPSHOT the base ONCE: hardware performs every transfer from the ORIGINAL base, but
          // a base-in-list ldmia overwrites that register mid-list — re-reading it per iteration
          // loaded the siblings from the freshly-loaded value instead (silent wrong addresses,
          // adversarially reproduced). All accesses and the writeback read this snapshot.
          const base0 = readData(baseReg, bi);
          list.forEach((r, i) => {
            if (ins.mnemonic === 'ldmia') {
              const res = mkValue(T.unk(32));
              irb.ops.push(
                // `listOrder: true` — this load's stream position is the LIST position, not the
                // order the source evaluated it (structure.ts's def-order re-spelling must not
                // trust it; the aload rebuilds in raise/arrays.ts and raise/struct-arrays.ts
                // must carry it forward)
                mkOp('load', {
                  operands: [base0],
                  results: [res],
                  attrs: { off: 4 * i, signed: true, width: 4, listOrder: true },
                }),
              );
              writeData(reg(r), bi, res);
            } else {
              irb.ops.push(mkOp('store', { operands: [base0, readData(reg(r), bi)], attrs: { off: 4 * i, width: 4 } }));
            }
          });
          // Writeback advances the base by 4×count. It is suppressed ONLY for an ldmia whose base
          // is in its own list — the loaded value wins. GBATEK, THUMB.15: "no writeback
          // (LDM/ARMv4/ARMv5; at this point, THUMB opcodes work different than ARM opcodes)".
          // The `!` is NOT what decides it: see above, there is no encoding without writeback.
          const wroteBase = ins.mnemonic === 'ldmia' && list.some((r) => reg(r) === baseReg);
          if (!wroteBase) {
            const adv = mkValue(T.unk(32));
            irb.ops.push(mkOp('add', { operands: [base0, constVal(4 * list.length, bi)], results: [adv] }));
            writeData(baseReg, bi, adv);
          }
          break;
        }
        case 'mul':
        case 'muls':
        case 'and':
        case 'ands':
        case 'orr':
        case 'orrs':
        case 'eor':
        case 'eors': {
          const opc = (
            {
              mul: 'mul',
              muls: 'mul',
              and: 'and',
              ands: 'and',
              orr: 'or',
              orrs: 'or',
              eor: 'xor',
              eors: 'xor',
            } as Record<string, Opcode>
          )[ins.mnemonic]!;
          // 3-operand (rD, rS, rM) or 2-operand (rD, rM) flag-setting form. A 1-operand form is
          // malformed — loud opaque, not a crash.
          if (b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const [x, y] =
            c !== undefined
              ? [readData(reg(b), bi), readData(reg(c), bi)]
              : [readData(reg(a), bi), readData(reg(b), bi)];
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp(opc, { operands: [x, y], results: [res] }));
          writeData(reg(a), bi, res);
          break;
        }
        case 'cmp': {
          if (a === undefined || b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const rhs = b.startsWith('#') ? constVal(imm(b), bi) : readData(reg(b), bi);
          pendingCmp = { lhs: readData(reg(a), bi), rhs };
          break;
        }
        case 'ldr':
        case 'ldrb':
        case 'ldrh':
        case 'ldrsb':
        case 'ldrsh': {
          // A word load whose operand NAMES a literal pool is a pool reference, not a memory base:
          // a numeric word → `const`, a bare global → `gaddr` (structure.ts lowers a load/store
          // through it to `gSym`), anything else → loud decline. It must NEVER fall to the load
          // path below, which would materialise the pool label as a phantom pointer parameter.
          if (ins.mnemonic === 'ldr' && b !== undefined) {
            const pr = poolRef(b, dataWords);
            if (pr?.kind === 'const') {
              // Numeric-pool PROMOTION (symbols.ts): a pool-loaded word whose value the
              // project's symbol map knows becomes the NAMED global's address — the same
              // `gaddr` the symbol-pool path emits, so everything downstream is the existing
              // named-global machinery. Only pool-loaded words promote (an address built by
              // arithmetic never reaches here); a promoted `code` symbol carries `code: true`
              // so the structurer spells it `(u32)Name`, not `&Name`.
              //
              // VETOED when this asm's pool names other symbols (poolNamesASymbol): agbcc would
              // have emitted THIS word symbolically too had the source named it, so promoting it
              // spells a name the source did not use.
              //
              // …but the veto is really about RELOCATION, not about naming. An `extern` name makes
              // the compiler emit a relocated pool word, which contradicts the numeric word the
              // target shows. An address-cast MACRO expands to that same numeric literal, so it is
              // COMPATIBLE with the evidence by construction and is never vetoed — indeed it is
              // the spelling the numeric word is evidence FOR (klonoa's true source reaches these
              // cells through exactly such macros). Nothing is guessed in either case: a vetoed
              // word stays the raw constant the target says it is.
              const found = symbols ? lookupSymbol(symbols, pr.value) : null;
              const si = found && (!poolNamesSymbols || found.macroBody !== undefined) ? found : null;
              if (si) {
                const res = mkValue(T.unk(32));
                irb.ops.push(
                  mkOp('gaddr', {
                    results: [res],
                    attrs: { sym: si.name, ...(si.kind === 'code' ? { code: true } : {}) },
                  }),
                );
                writeData(reg(a), bi, res);
                break;
              }
              // INTERIOR attribution: a value strictly inside a sized data symbol becomes
              // `gaddr sym + offset` — the `&gSym + K` tree structure.ts already lowers (and,
              // with a struct layout, spells as the named field). Sized symbols only; an
              // unattributed address stays a raw const — nothing guesses.
              // Interior attribution is always an `&gSym + K` spelling — extern-shaped, hence
              // relocated — so the veto applies to it without the macro exemption above.
              const interior = symbols && !poolNamesSymbols ? lookupInterior(symbols, pr.value) : null;
              if (interior) {
                const g = mkValue(T.unk(32));
                const k = mkValue(T.unk(32));
                const res = mkValue(T.unk(32));
                irb.ops.push(mkOp('gaddr', { results: [g], attrs: { sym: interior.info.name } }));
                irb.ops.push(mkOp('const', { results: [k], attrs: { value: interior.offset } }));
                irb.ops.push(mkOp('add', { operands: [g, k], results: [res] }));
                writeData(reg(a), bi, res);
                break;
              }
              const res = mkValue(T.unk(32));
              irb.ops.push(mkOp('const', { results: [res], attrs: { value: pr.value } }));
              writeData(reg(a), bi, res);
              break;
            }
            if (pr?.kind === 'gaddr') {
              const res = mkValue(T.unk(32));
              irb.ops.push(mkOp('gaddr', { results: [res], attrs: { sym: pr.sym } }));
              if (pr.addend !== 0) {
                // `.word gSym+N` = the machine loads gSym's address plus N. Emitted as an explicit
                // add so the addend is a VALUE, not an attribute a renderer could re-scale.
                const k = mkValue(T.unk(32));
                irb.ops.push(mkOp('const', { results: [k], attrs: { value: pr.addend } }));
                const sum = mkValue(T.unk(32));
                irb.ops.push(mkOp('add', { operands: [res, k], results: [sum] }));
                writeData(reg(a), bi, sum);
                break;
              }
              writeData(reg(a), bi, res);
              break;
            }
            if (pr?.kind === 'unmodelled') {
              throw new FrontendUnsupportedError(
                `cannot lift '${name}': literal-pool load of ${pr.why} — not modelled`,
              );
            }
          }
          // rD, [base, #off] — a typed load. Width/signedness come from the mnemonic; the
          // base becomes a pointer to that element type during type recovery.
          if (a === undefined || b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const width = /b/.test(ins.mnemonic) ? 1 : /h/.test(ins.mnemonic) ? 2 : 4;
          const signed = ins.mnemonic === 'ldr' || /s/.test(ins.mnemonic.slice(3));
          const { base, off, regOff } = parseAddr(b);
          // `[rB, rX]` register-offset: lower EXACTLY as `rB + rX` then a load at offset 0 —
          // the same address arithmetic the encoding performs. (parseAddr used to silently
          // read `[rB]`, dropping the index — a silent miscompile; ldrsh exists ONLY in this
          // form in Thumb-1, so every ldrsh went through here.)
          // An incoming stack argument, read before its base becomes an sp decline. Every
          // condition below is a refusal that keeps a LOCAL from being mistaken for a parameter:
          //   • entry block only        — the depth is exact only along this block's linear order
          //   • entry has no preds      — otherwise its params are phis, not parameters
          //   • no register offset      — `[sp, rX]` is not a fixed argument slot
          //   • word width, word-aligned — the argument area is word-granular
          //   • off >= the frame depth — BELOW the frame top is a local/spill: still declines,
          //                               that is the separate slot-promotion capability
          //   • a sane arity bound      — a wild offset must not mint a 400-parameter signature
          {
            const index = frame.argIndex({ base, off, regOff }, width, bi);
            if (index !== null) {
              // Mint EVERY argument below this one — the register half included. Downstream naming
              // is POSITIONAL (structure.ts), so any hole binds every later parameter to the wrong
              // ABI slot, silently: `push {r4,r5,lr}; add r4,r3,#0; ldr r0,[sp,#0xc]` emitted a
              // 2-parameter signature where the ABI proves 5, with both of them bound wrong.
              //
              // Reading slot k proves the caller passed arguments 0..k: the register arguments are
              // filled before any stack argument exists, and the stack area is contiguous with slot
              // 4 at the lowest offset. So this is entailed by the calling convention, not guessed —
              // which is what separates it from inventing parameters a function might not have.
              // (It assumes one word per argument, which is what this frontend assumes everywhere —
              // it types every parameter s32. An 8-byte argument, which AAPCS may align into r1 or
              // straddle across r3 and the stack, would break the index↔slot correspondence; no
              // agbcc row in the corpus has one, and recovering them is its own capability.)
              //
              // ensureParam, NOT readVar: a register the entry block DEFINES before this point
              // (`bl g` then a read of the frame, the commonest shape there is) answers readVar with
              // that local definition and no parameter appears — reopening the very hole this loop
              // closes. It emitted `s32 f(s32 a0, s32 a1, s32 a2, s32 a3) { return g() + a3; }`:
              // arity 4 where the ABI proves 5, with the stack argument bound to r3's slot.
              for (let j = 0; j < index; j++) {
                ssa.ensureParam(j < target.argRegs.length ? target.argRegs[j] : stackArgKey(j), bi);
              }
              writeData(reg(a), bi, readVar(stackArgKey(index), bi));
              break;
            }
          }
          // The address-taken object at offset 0 comes FIRST: it is memory, not a slot, so it is
          // read with a real `load` through its `laddr` (see isFrameObjectAccess). No
          // reaching-def test — the callee holding the address is a writer this function cannot
          // see, so "never stored here" is not "holds nothing".
          if (isFrameObjectAccess(base, off, regOff, width)) {
            const addr = mkValue(T.unk(32));
            irb.ops.push(mkOp('laddr', { results: [addr], attrs: { off: 0 } }));
            const res = mkValue(T.unk(32));
            irb.ops.push(mkOp('load', { operands: [addr], results: [res], attrs: { off: 0, width, signed } }));
            writeData(reg(a), bi, res);
            break;
          }
          // A word reload from this function's own frame — the dual of the spill in the str arm.
          //
          // The reaching-def test is the whole soundness of it, and it mirrors the MIPS guard
          // exactly: a slot that was never STORED holds nothing this function put there, so
          // `readVar` would mint a phantom entry parameter for it and hand back a value the machine
          // never had. Above the frame that reading is right and is the incoming-argument path
          // above; INSIDE the frame it is an uninitialised local (or one whose address escaped
          // through a path the model missed), and the honest answer is the decline this falls
          // through to.
          if (
            slotsOk &&
            isSpReg(base) &&
            regOff === undefined &&
            width === 4 &&
            off % 4 === 0 &&
            off >= 0 &&
            off + 4 <= localArea &&
            ssa.hasReachingDef(slotKey(off), bi)
          ) {
            usedSlotOffsets.add(off);
            writeData(reg(a), bi, readVar(slotKey(off), bi));
            break;
          }
          let baseVal = readData(base, bi);
          if (regOff !== undefined) {
            const sum = mkValue(T.unk(32));
            irb.ops.push(mkOp('add', { operands: [baseVal, readData(regOff, bi)], results: [sum] }));
            baseVal = sum;
          }
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('load', { operands: [baseVal], results: [res], attrs: { off, width, signed } }));
          writeData(reg(a), bi, res);
          break;
        }
        case 'str':
        case 'strb':
        case 'strh': {
          // rS, [base, #off] — a typed store (a side-effecting statement, no result).
          if (a === undefined || b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const width = /b/.test(ins.mnemonic) ? 1 : /h/.test(ins.mnemonic) ? 2 : 4;
          const { base, off, regOff } = parseAddr(b);
          // A word spill into this function's own frame: record the slot's value in SSA rather than
          // emitting a store through sp. `slotsOk` has already proven the frame is private and does
          // not move; `off + 4 <= localArea` keeps this strictly inside the EXPLICITLY reserved local
          // area — not merely inside the frame, whose upper part is the callee-saved block the
          // epilogue pops — so it can never
          // collide with the incoming-argument area above it (which the load path recovers as
          // parameters, and where a STORE is still a decline — writing a caller's slot is a
          // different capability). A spill that is never reloaded becomes a dead def and drops.
          // …unless offset 0 is the address-taken object (see isFrameObjectAccess), where the
          // store is a real write to memory that the callee holding the address reads back.
          if (isFrameObjectAccess(base, off, regOff, width)) {
            const addr = mkValue(T.unk(32));
            irb.ops.push(mkOp('laddr', { results: [addr], attrs: { off: 0 } }));
            irb.ops.push(mkOp('store', { operands: [addr, readData(reg(a), bi)], attrs: { off: 0, width } }));
            break;
          }
          if (
            slotsOk &&
            isSpReg(base) &&
            regOff === undefined &&
            width === 4 &&
            off % 4 === 0 &&
            off >= 0 &&
            off + 4 <= localArea
          ) {
            usedSlotOffsets.add(off);
            writeVar(slotKey(off), bi, readData(reg(a), bi));
            break;
          }
          let storeBase = readData(base, bi);
          if (regOff !== undefined) {
            // register-offset store: same exact `rB + rX` lowering as the load path above
            const sum = mkValue(T.unk(32));
            irb.ops.push(mkOp('add', { operands: [storeBase, readData(regOff, bi)], results: [sum] }));
            storeBase = sum;
          }
          irb.ops.push(mkOp('store', { operands: [storeBase, readData(reg(a), bi)], attrs: { off, width } }));
          break;
        }
        case 'bl':
        case 'blx': {
          // A call: read the argument registers (r0..), produce the return value in r0. The
          // callee's caller-saved clobber (r1..r3, lr) needs no modelling — agbcc has already
          // moved anything live across the call into a callee-saved register (a copy we alias).
          const targetSym = a;
          // Caller-supplied prototype wins; otherwise a known runtime helper (`__divsi3` &c.)
          // supplies its arity so its arguments are recovered; only then fall back to guessing.
          const declared = protoArity(prototypes[targetSym]) ?? protoArity(RUNTIME_HELPERS[targetSym]);
          const argc = declared ?? fallbackArgcHere(bi);
          const args: Value[] = [];
          for (let k = 0; k < argc; k++) {
            args.push(readVar(`r${k}`, bi));
          }
          const res = mkValue(T.unk(32));
          const callOp = mkOp('call', { operands: args, results: [res], attrs: { target: targetSym } });
          irb.ops.push(callOp);
          // A GUESSED arity is revisited in `finish()`: only once the whole function is lifted is it
          // known whether every path to here passes through another call, which would have clobbered
          // the argument registers this guess just read.
          if (declared === undefined) {
            ssa.recordGuessedCall(callOp, bi, target);
          }
          writeData('r0', bi, res); // the callee defines r0 …
          ssa.noteCall(bi); // … and the clobber is recorded after it, so that def is the CALLEE's
          break;
        }
        default:
          // Control transfers are already skipped above; any other unmodelled op fails loud (opaque)
          // instead of silently dropping its destination.
          emitOpaqueDest(ins);
          break;
      }
    }

    // terminator (via classifyXfer — the single source of truth shared with decode/succLabels)
    const last = ab.instrs[ab.instrs.length - 1];
    const kind = last ? classifyXfer(last) : null;
    const succ = (label: string): Successor => ({ block: irBlocks[labelIndex.get(label)!], args: [] });
    const jt = tables.get(ab);
    if (jt) {
      // Regime B: the bounds block dispatches a `switch_br` over the scrutinee — N case blocks (values
      // 0..N-1, dense) followed by the default block (last successor). The `cmp`/`bhi` are subsumed.
      pushSwitchBr(irb.ops, readVar(reg(jt.scrutReg), bi), [...jt.caseLabels.map(succ), succ(jt.defaultLabel)]);
    } else if (!last) {
      // an EMPTY block is only ever the synthetic entry preheader (decoded blocks are non-empty):
      // fall through to the real entry, whose loop-header phis take their entry operand from here.
      irb.ops.push(mkOp('br', { successors: [succ(fallLabel(bi))] }));
    } else if (kind === 'return') {
      // bx lr / pop {…,pc} / mov pc,lr
      //
      // A `bx rN` BRANCHES THROUGH rN, so at that instruction rN holds the RETURN ADDRESS. When rN
      // is the return-VALUE register the two uses collide, and the address wins by definition —
      // whatever value was in r0 is gone, so the function cannot be returning one. agbcc spells an
      // interworking return that way (`push {lr}` … `pop {r0}; bx r0`), and reading r0 as a value
      // there invents a return the machine provably cannot make: a phantom `return`, a non-`void`
      // signature that would contradict the project's own prototype, and a live range that keeps
      // otherwise-dead computation alive.
      //
      // The other return forms are untouched, because none of them writes the return register:
      // `bx lr` and `bx r1`/`bx r2` branch through a different one, and `pop {…,pc}` / `mov pc,lr`
      // load PC directly. Only the register actually branched through is disqualified.
      const viaReturnReg = last.mnemonic === 'bx' && last.ops[0] === target.returnReg;
      irb.ops.push(mkOp('ret', { operands: viaReturnReg ? [] : [readVar(target.returnReg, bi)] }));
    } else if (kind === 'uncond') {
      irb.ops.push(mkOp('br', { successors: [succ(last.ops[0])] }));
    } else if (kind === 'cond') {
      // `pendingCmp` is block-local; a `cmp` split from its branch by a label means the flags
      // cross a block boundary — not modelled. Decline loud.
      if (!pendingCmp) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': conditional branch '${last.mnemonic}' has no reaching compare in its block`,
        );
      }
      const cond = mkValue(T.unk(32));
      irb.ops.push(mkOp(COND_OPCODE[last.mnemonic], { operands: [pendingCmp.lhs, pendingCmp.rhs], results: [cond] }));
      irb.ops.push(mkOp('cond_br', { operands: [cond], successors: [succ(last.ops[0]), succ(fallLabel(bi))] }));
    } else {
      // fallthrough (last instruction is a call / data op, no control transfer)
      irb.ops.push(mkOp('br', { successors: [succ(fallLabel(bi))] }));
    }
  };

  // The fall-through label after block `bi` — a LAST block needing one means control runs off
  // the end of the function (truncated/misparsed input): decline loud, never a TypeError.
  const fallLabel = (bi: number): string => {
    const nb = asmBlocks[bi + 1];
    if (!nb) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': control falls off the end (block '${asmBlocks[bi].label}' has no terminator and no successor)`,
      );
    }
    return nb.label;
  };
  asmBlocks.forEach((ab, bi) => {
    fillBlock(ab, bi);
    ssa.markFilled(bi);
  });

  ssa.finish();

  // FRAME-OBJECT AUDIT. Every `laddr` the frontend emitted is only a CLAIM that the address it
  // names is used as "the address of one scalar local"; this proves it, over the finished function,
  // the same boundary-total style as the slot-escape assert in finish(). The address may flow
  // anywhere as a VALUE — into an MMIO register (the DMA-fill idiom), a call, a phi — but every
  // MEMORY access through it must be at offset 0, with one agreed width and one agreed extension,
  // its bytes must belong to nothing else in the frame, and any use the audit cannot vouch for declines the whole function
  // loudly. Nothing here guesses: the object's declared type is exactly the access type the machine
  // used.
  {
    let laddrs: Op[] = [];
    for (const blk of irBlocks) {
      for (const op of blk.ops) {
        if (op.opcode === 'laddr') {
          laddrs.push(op);
        }
      }
    }
    // …and it runs for a licensed acceptance with no object at all, so the premise re-check below
    // is total rather than resting on "the capture always survives into the IR".
    if (laddrs.length > 0 || capturedObjectIsTheWholeFrame) {
      const readOnlySinks = new Set(target.capabilities.readOnlyAddressSinks ?? []);
      const defOf = new Map<Value, Op>();
      for (const blk of irBlocks) {
        for (const op of blk.ops) {
          for (const res of op.results) {
            defOf.set(res, op);
          }
        }
      }
      // A NAME IS NOT AN ADDRESS. The same symbol name can sit at two addresses — a symbol map is
      // free to carry one — and a `gaddr`'s `sym` can also come straight from the assembly text
      // (`.word REG_DMA3SAD`), where nothing looked it up at all. So names resolve to an address
      // here or they resolve to nothing: a name at more than one address vouches for neither.
      const addrOfName = new Map<string, number | null>();
      for (const [addr, infos] of symbols ?? []) {
        for (const si of infos) {
          addrOfName.set(si.name, addrOfName.has(si.name) ? null : addr);
        }
      }
      // The literal address a value denotes, or undefined when this cannot say. `const` is the
      // bare pool word, `gaddr` is the same word after the symbol map named it, and `add` is the
      // base+displacement form an interior attribution produces — three spellings of one address,
      // which is the point: the answer must not turn on which one the assembly happened to use.
      const literalAddrOf = (v: Value, depth = 0): number | undefined => {
        const d = defOf.get(v);
        if (d === undefined || depth > 2) {
          return undefined;
        }
        if (d.opcode === 'const') {
          return d.attrs.value as number;
        }
        if (d.opcode === 'gaddr') {
          return addrOfName.get(d.attrs.sym as string) ?? undefined;
        }
        if (d.opcode === 'add' && d.operands.length === 2) {
          const base = literalAddrOf(d.operands[0], depth + 1);
          const disp = defOf.get(d.operands[1]);
          if (base !== undefined && disp?.opcode === 'const') {
            return base + (disp.attrs.value as number);
          }
        }
        return undefined;
      };
      // Does this store hand the WHOLE address to something that only reads through it? Word stores
      // only: a `strh` to a source register hands over half an address, so the device's source is
      // not this object. A base this cannot resolve — computed, register-offset, merged by a phi —
      // is the conservative answer.
      const readsThrough = (op: Op): boolean => {
        if (readOnlySinks.size === 0 || (op.attrs.width as number) !== 4) {
          return false;
        }
        const base = literalAddrOf(op.operands[0]);
        return base !== undefined && readOnlySinks.has(base + (op.attrs.off as number));
      };
      const fail = (why: string): never => {
        throw new FrontendUnsupportedError(`cannot lift '${name}': address-taken stack local — ${why}`);
      };
      // A FRAME BASE ADDRESSED THROUGH IS NOT A CAPTURE. Thumb-1 gives `ldr`/`str` an `[sp,#imm]`
      // encoding and gives the sub-word forms none, so a byte or halfword spill can only be spelled
      // by copying sp into a register and addressing through the copy:
      //
      //     mov  r2, sp
      //     strh r3, [r2, #0x30]
      //
      // That is an ADDRESSING MODE. The copy never becomes a value, and the access is the
      // `[sp,#0x30]` the instruction set cannot spell — so what the machine named is one object at
      // frame offset 48, not a `[+48]` reach through the frame base.
      //
      // A captured address whose every use is a fixed-offset sub-word ACCESS is that shape, and
      // each of its accesses names its own object: re-root them onto a `laddr` at their own offset,
      // read at 0, and the rest of this audit judges the objects. A capture with ANY other use is a
      // real capture and keeps the frame base.
      //
      // What makes that judgement total is that the walk below enumerates every ROLE a value can
      // appear in — every operand of every op, and every edge argument — instead of asking what an
      // instruction looks like. One instruction can hold two roles: `str rD, [rD, #k]` stores the
      // frame address through itself, a base use AND an escape, and the escape is what stops the
      // split.
      // Why a capture was NOT split, when the reason is one no later message carries — the
      // `slotsOffReason` idiom: a refusal reported as the wrong capability sends the improvement
      // loop to build the wrong thing.
      let splitRefusal: string | null = null;
      {
        const uses = new Map<Value, { op: Op; idx: number; blk: Block }[]>();
        const record = (v: Value, op: Op, idx: number, blk: Block) =>
          (uses.get(v) ?? uses.set(v, []).get(v)!).push({ op, idx, blk });
        for (const blk of irBlocks) {
          for (const op of blk.ops) {
            op.operands.forEach((v, idx) => record(v, op, idx, blk));
            // An EDGE ARGUMENT is a use role too, and never an access: a capture that reaches a
            // block parameter is live past this block, so the taint closure below is what judges
            // it. Recorded at index -1 so it can never be counted as an access — a split there
            // would delete a capture the successor argument still names.
            for (const succ of op.successors ?? []) {
              for (const a of succ.args) {
                record(a, op, -1, blk);
              }
            }
          }
        }
        const minted: Op[] = [];
        const consumed = new Set<Op>();
        for (const capture of laddrs) {
          const at = uses.get(capture.results[0]) ?? [];
          const accesses = at.filter((u) => (u.op.opcode === 'load' || u.op.opcode === 'store') && u.idx === 0);
          // SUB-WORD ONLY, because that is the whole of what the encoding gap forces: `ldr`/`str` DO
          // have an `[sp,#imm]` form, so a WORD access through a copy is some other shape and must
          // not be read as this one. It is also what keeps the outgoing-argument area safe — that
          // guard reads `[sp,#k]` accesses (spMemAccess), which an access through a copy is not, and
          // agbcc stages arguments 5+ there with `str`.
          const subWord = accesses.every((u) => (u.op.attrs.width as number) < 4);
          // A use that is not an access leaves the capture naming the frame base, and the judgement
          // below reports that use itself — an escape, a phi, arithmetic — so it needs no reason
          // here. The WIDTH does: nothing downstream mentions it, so a refused word access would be
          // reported as "a store at [+4]" and the histogram would be asked for the wrong capability.
          if (at.length === 0 || accesses.length !== at.length) {
            continue;
          }
          if (!subWord) {
            splitRefusal ??= 'a WORD access through the copy, and `ldr`/`str` have an `[sp,#imm]` form';
            continue;
          }
          // Nothing to split when the capture already names ONE object: every access at offset 0 is
          // the frame base itself, which is what the DMA-fill idiom captures.
          if (accesses.every((u) => u.op.attrs.off === 0)) {
            continue;
          }
          for (const u of accesses) {
            const res = mkValue(T.unk(32));
            const object = mkOp('laddr', { results: [res], attrs: { off: u.op.attrs.off as number } });
            u.blk.ops.splice(u.blk.ops.indexOf(u.op), 0, object);
            minted.push(object);
            u.op.operands = [res, ...u.op.operands.slice(1)];
            u.op.attrs = { ...u.op.attrs, off: 0 };
          }
          consumed.add(capture);
        }
        if (consumed.size > 0) {
          for (const blk of irBlocks) {
            blk.ops = blk.ops.filter((op) => !consumed.has(op));
          }
          laddrs = [...laddrs.filter((op) => !consumed.has(op)), ...minted];
        }
      }
      // ONE OBJECT PER FRAME OFFSET. Two `laddr` at the same offset name the same storage; two at
      // different offsets are different objects, so width, signedness, escape and the overlap
      // window are decided per offset — one width shared by every capture in the function would
      // declare a halfword spill and a word spill as one object.
      const objects = new Map<number, Op[]>();
      for (const op of laddrs) {
        const off = op.attrs.off as number;
        (objects.get(off) ?? objects.set(off, []).get(off)!).push(op);
      }
      // Taint maps a value to the OBJECT whose address it may hold, closed over phis: a tainted
      // edge arg taints the receiving block param. A phi that merges two objects has no single
      // answer, and picking one would put an access on the wrong storage. Nothing builds one today,
      // and the reason is worth knowing before changing the split: an object at a nonzero offset
      // exists only where the split ran, the split refuses any capture with an edge-argument use,
      // and every frame-base object is the same object.
      const taint = new Map<Value, number>();
      for (const [off, ops] of objects) {
        for (const op of ops) {
          taint.set(op.results[0], off);
        }
      }
      for (let changed = true; changed;) {
        changed = false;
        for (const blk of irBlocks) {
          for (const op of blk.ops) {
            for (const s of op.successors ?? []) {
              s.args.forEach((arg, i) => {
                const from = taint.get(arg);
                const param = s.block.params[i];
                if (from === undefined || param === undefined) {
                  return;
                }
                const had = taint.get(param);
                if (had === from) {
                  return;
                }
                if (had !== undefined) {
                  fail(`a phi merges the frame objects at [sp,#${had}] and [sp,#${from}] — one value, two objects`);
                }
                taint.set(param, from);
                changed = true;
              });
            }
          }
        }
      }
      // Judge every use of a tainted value, against the object it names.
      const accesses = new Map<number, { width: number; signed: boolean; isLoad: boolean }[]>();
      const escaped = new Set<number>();
      // TWO QUESTIONS, not one. `escaped` asks whether the address LEFT the function, which is what
      // decides `volatile`. `mayWrite` asks whether it reached something that could write the frame
      // BACK, which is what every "a callee may write any frame offset" refusal below rests on. A
      // store into a device's SOURCE register answers yes to the first and no to the second: the
      // hardware reads the object, and the DMA-fill idiom this capability was built for
      // (`vu16 tmp; DmaSet(n, &tmp, …)`) is exactly that shape.
      const mayWrite = new Set<number>();
      // …and the two escapes SPLIT, because each decides something the other does not.
      // `passedToCallee` is the address handed to a callee as an argument — the one escape whose
      // writer this frontend can name, which is what the struct-return premise re-check below rests
      // on, and what tells a refusal message which escape it is talking about. `published` is the
      // address WRITTEN TO MEMORY, how the DMA idiom hands the object to hardware, and what
      // `volatile` at the stamp keys on. Reading either off `escaped` gets the other one wrong.
      const passedToCallee = new Set<number>();
      const published = new Set<number>();
      // …and WHICH ARGUMENT it was passed as, because argument 0 is the one position a hidden
      // struct-return pointer can occupy. A `call`'s operand index IS the argument index here (the
      // `bl` arm reads r0..r<argc-1> in order), so an address handed over at r1 or above is an
      // argument the source wrote.
      const passedAboveArg0 = new Set<number>();
      for (const off of objects.keys()) {
        accesses.set(off, []);
      }
      for (const blk of irBlocks) {
        for (const op of blk.ops) {
          op.operands.forEach((v, idx) => {
            const off = taint.get(v);
            if (off === undefined) {
              return;
            }
            const scalar = (kind: string) => {
              if ((op.attrs.off as number) !== 0) {
                fail(
                  `a ${kind} at [+${op.attrs.off}] through the captured address — ` +
                    (splitRefusal ?? 'only a scalar at the captured address is modelled'),
                );
              }
            };
            if (op.opcode === 'load' && idx === 0) {
              scalar('load');
              accesses.get(off)!.push({
                width: op.attrs.width as number,
                signed: (op.attrs.signed as boolean) ?? false,
                isLoad: true,
              });
              return;
            }
            if (op.opcode === 'store' && idx === 0) {
              scalar('store');
              accesses.get(off)!.push({ width: op.attrs.width as number, signed: false, isLoad: false });
              return;
            }
            if ((op.opcode === 'store' && idx === 1) || op.opcode === 'call') {
              escaped.add(off); // the address ESCAPES as a value — the point of the capability
              if (!(op.opcode === 'store' && readsThrough(op))) {
                mayWrite.add(off);
              }
              if (op.opcode === 'call') {
                passedToCallee.add(off);
                if (idx > 0) {
                  passedAboveArg0.add(off);
                }
              } else {
                published.add(off); // written to memory — the DMA idiom's `*dmaReg = &tmp`
              }
              return;
            }
            fail(`the captured address flows into \`${op.opcode}\` — not an access, an escape, or a phi`);
          });
        }
      }

      // THE ACCEPTANCE'S PREMISE, RE-ASKED OF THE IR. `capturedObjectIsTheWholeFrame` is a reading
      // of the TEXT and it is the one thing in this file that switches a refusal OFF, so the two
      // facts it claims are re-proven here, where they are exact, rather than left to the
      // approximation that licensed them. Neither is a second opinion on the same evidence: the
      // scan asks what a REGISTER holds at a `bl`; this asks what the finished function does with
      // the OBJECT.
      //
      // PASSED TO A CALLEE. The whole licence is "a callee is holding the address of this frame",
      // and the pre-lift scan can say that of a register whose value never reaches a call operand —
      // a declared arity trims it away, or the register is dead by the time the call is built. When
      // it does, [sp,#0] has been re-modelled as an addressable object on no evidence at all, and
      // the outgoing argument that really lived there is gone from the call.
      //
      // NOT A STRUCT-RETURN TEMP. A one-word frame rules out agbcc's block-copy bases (each needs
      // two words) but NOT the hidden return pointer of a <=4-byte non-integer-like struct, which is
      // exactly one word: `struct S4 { char a,b,c,d; }; struct S4 s = mk(x);` compiles to `add
      // sp,#-4 / mov r0,sp / bl mk / ldr r0,[sp]`, instruction for instruction an out-parameter
      // call. Left alone that lifted as `mk(&sp0, a0)` — a call the real prototype rejects.
      //
      // Two facts rule it out and either will do, because a return temp is storage the CALLEE owns
      // outright: it is written only by the callee, and its pointer is argument 0, always
      // (compiled — `struct S4 mk3(int,int,int)` puts sp in r0 and shifts all three real arguments
      // up). So a store of our own says the object is one this function fills, and an address
      // handed over at r1 or above says the same by position.
      //
      // The cost is stated rather than hidden: an OUTPUT-only parameter taken at argument 0 is
      // byte-for-byte a struct return and declines with it. Separating those needs the callee's
      // real signature, which is what the arity refusal above cannot get either.
      if (capturedObjectIsTheWholeFrame) {
        if (!passedToCallee.has(0)) {
          fail(
            'the one-word-frame proof licensed this lift on the frame base reaching a callee, and ' +
              'no call in the lifted function takes it — so nothing rules out an outgoing stack argument at [sp,#0]',
          );
        }
        if (!accesses.get(0)?.some((a) => !a.isLoad) && !passedAboveArg0.has(0)) {
          fail(
            'the one-word frame is handed to a callee as argument 0 and never written here, which ' +
              'is how a hidden struct-return pointer looks — the callee owning the storage is not provably an addressable local',
          );
        }
      }

      // The declared type of each object, and then that its bytes belong to nothing else.
      const extent = new Map<number, number>();
      for (const [off, acc] of accesses) {
        if (acc.length === 0) {
          // nothing in-function pins the object's type, and a guessed declaration is the
          // plausible-but-wrong class — decline until an inhabitant needs this
          fail('the captured address is never dereferenced in this function, so nothing pins the local object type');
        }
        const widths = new Set(acc.map((a) => a.width));
        if (widths.size > 1) {
          fail(`the accesses through the captured address disagree on width (${[...widths].join(' vs ')})`);
        }
        // …and on SIGNEDNESS, over the loads, for the same reason: one declared type extends one
        // way, so an object read by both `ldrsb` and `ldrb` has no faithful declaration —
        // `sp4 - sp4` would fold to 0 where the machine computes sext(b) - zext(b). Loads only: a
        // store extends nothing, and `strb` beside `ldrsb` is not a disagreement.
        const signs = new Set(acc.filter((a) => a.isLoad).map((a) => a.signed));
        if (signs.size > 1) {
          fail('the loads through the captured address disagree on signedness — one declared type extends one way');
        }
        extent.set(off, acc[0].width);
      }
      // TWO MODELS FOR ONE BYTE is a silent disagreement, so each object must own its bytes
      // outright: inside the reserved local area, clear of every SSA slot (which the slot model
      // keeps in registers, so a store through the object would not be seen there), and clear of
      // every other object.
      const overlaps = (a: number, aw: number, b: number, bw: number) => a < b + bw && b < a + aw;
      const objs = [...extent].sort((x, y) => x[0] - y[0]);
      for (const [off, width] of objs) {
        if (off < 0 || off + width > localArea) {
          fail(`the object at [sp,#${off}) of width ${width} lies outside the reserved local area`);
        }
        for (const slot of usedSlotOffsets) {
          if (overlaps(off, width, slot, 4)) {
            fail(`the object at [sp,#${off}) overlaps the SSA slot at [sp,#${slot}] — one byte, two models`);
          }
        }
      }
      for (let i = 1; i < objs.length; i++) {
        const [off, width] = objs[i];
        const [prev, prevWidth] = objs[i - 1];
        if (overlaps(prev, prevWidth, off, width)) {
          fail(`the objects at [sp,#${prev}) and [sp,#${off}) overlap — one byte, two models`);
        }
      }
      // WHAT AN ESCAPE COSTS. The audit bounds what WE access through an object, never what a callee
      // does with the address it was handed — and a callee may write any offset from it. So an
      // escape retracts two claims, both of them function-wide because one address reaches the
      // whole frame.
      //
      // The first is that the other ADDRESS-TAKEN objects are private, and it keys on ANY escape —
      // this is the rule `mayWrite` does NOT narrow. Its argument is about LAYOUT, and layout is
      // symmetric: two objects are two separate C locals with no guaranteed adjacency, so a device
      // that READS past the one it was given is as wrong as a callee that writes past it. `DmaCopy`
      // with a count of two halfwords off `&sp0` transfers `[sp,#2]` too, and the emitted source
      // transfers whatever the recompiler put after `sp0`, and the second object's own store is
      // whatever the recompiler made of it. Marking both volatile would not repair that: the locals
      // are still placed independently.
      //
      // ACCEPTED RESIDUE, so the rule is not read as wider than it is: it counts `laddr` objects,
      // so a neighbour that is merely SPILLED to an SSA slot is over-read just the same and nothing
      // refuses, and the audit never reads the transfer's control word, so an incrementing source
      // is vouched for exactly as a fixed one is. Both are reads, so the `undef` argument holds
      // either way, and both predate this rule.
      if (escaped.size > 0 && objects.size > 1) {
        fail(
          'the captured address escapes, so something outside this function reaches the whole ' +
            'frame — including another object',
        );
      }
      // The second is `undef`, which rests on this function's own stores being the ONLY writer of
      // its frame. A wider real object (`struct P p; g(&p);` where only `p.x` is read here) has its
      // later words written by `g` and read back at a slot no store of ours reaches — declaring
      // those uninitialised spells the callee's value as garbage. The extents here are inferred
      // from OUR accesses, which is the number that is too small in this shape.
      //
      // On an escape and not on "a laddr exists": an address dereferenced only in-function cannot
      // be written by anyone else, and the overlap checks above cover its aliasing.
      //
      // FRAME undefs only. A register-keyed one says a local lives in a register the ABI does not
      // pass arguments in, and no address reaches a register — the escape this retraction is about
      // cannot touch it, and counting it would refuse the whole function for an unrelated escape.
      const undefSlots = irBlocks.some((blk) =>
        blk.ops.some((op) => op.opcode === 'undef' && slotKeyOffset(op.attrs.key as string) !== null),
      );
      if (mayWrite.size > 0 && undefSlots) {
        fail(
          'the captured address escapes, so a callee may write any frame offset and an unstored slot is not provably uninitialised',
        );
      }

      // …and the SLOT MODEL is the third claim an escape retracts — the undef rule's argument
      // taken one step further. The extents above are inferred from OUR accesses, so an object
      // wider in the SOURCE than the bytes this function touches has its later words written by
      // the callee — and any of those modelled as an SSA slot is a value the slot model forwards
      // ACROSS the call that overwrote it.
      //
      // Not a hypothetical, and not new with the outgoing-argument gate above either: this shape
      // reached the old capture path and lifted wrongly. The object has to be reached ONLY through
      // the captured pointer (an `[sp,#0]` access of its own collides with the slot model and
      // declines at the overlap check), which is what four corpus functions do:
      //
      //     mov r2, sp / str r0, [r2]   @ the object, written through the captured address
      //     str r1, [sp, #0x4]          @ a word the slot model keys
      //     mov r0, r2 / bl g           @ the base escapes; `g` may write [sp,#4]
      //     ldr r0, [sp, #0x4]          @ …and the machine RELOADS it after the call
      //
      // and the lift emitted `use2(a1)` — the reload replaced by the value from BEFORE the call,
      // the callee's write dropped, no diagnostic. Exactly the silent-wrong-answer trade the sp
      // guards exist to prevent, so it refuses.
      //
      // WHAT IT COSTS, stated because the benchmark cannot see it: it refuses every word slot above
      // a `mayWrite` object, which is blunter than the hazard it names — four corpus functions
      // decline on it (sa3 `sub_809C274`, `UpdateAnimations`, `sub_801C4A0`, `sub_8062CFC`), none
      // of them a benchmark row. Narrowing it needs the object's real extent, and this model does
      // not carry one: `extent` is a single width from a single access. The asm sometimes cannot
      // supply it either — the compiled twin at `capturedObjectIsTheWholeFrame` is exactly this
      // rule's shape, a slot THIS FUNCTION stores and reloads, undecidable between a spill and a
      // member.
      //
      // ABOVE the object only: a C object extends upward from its base, so a slot BELOW it cannot
      // be part of it, and the overlap checks above already own the bytes it does cover.
      //
      // `mayWrite`, the same predicate the undef rule takes, because the two rules rest on one
      // argument and a callee is not the only writer. `struct M { u8 b; u8 pad[3]; s32 t; };
      // gp = &m; g2(); use2(m.t);` PUBLISHES the base to an ordinary global and the machine reloads
      // [sp,#4] after `bl g2` — `g2` writes through `gp`, which points here. Keyed on
      // `passedToCallee` that lifted as `use2(v0)`, the reload replaced by the value from before
      // the call, no diagnostic: the same silent wrong answer as the call shape, one escape over.
      //
      // Not `escaped`, which is the strictly wider set and the one that costs: the DMA-fill idiom
      // publishes to a device SOURCE register, which reads the object and never writes it, and
      // `readsThrough` is exactly the exemption that keeps `mayWrite` off those rows. What stays
      // residue is a base stored through a pointer this cannot resolve: unresolvable is the
      // conservative answer there, so such a store IS in `mayWrite` and such a frame declines.
      for (const off of mayWrite) {
        for (const slot of usedSlotOffsets) {
          if (slot > off) {
            const how = passedToCallee.has(off) ? 'is passed to a callee' : 'is stored to memory';
            fail(
              `the captured address at [sp,#${off}) ${how}, which may write the ` +
                `slot at [sp,#${slot}] — this function's own store there would be forwarded past the write`,
            );
          }
        }
      }
      // …and the FOURTH claim an escape retracts is the object's TOP, which the three rules above
      // leave to whatever this function happened to touch. `extent` is one width from one access,
      // so an object wider in the SOURCE than those bytes is declared too small — and a callee
      // holding its address writes frame bytes the emitted C never allocated. Compiled:
      //
      //     u8 buf[12]; buf[0] = x; garr(buf); use2(buf[0]);
      //       → add sp,sp,#-0xc / mov r1,sp / strb r0,[r1] / mov r0,sp / bl garr
      //
      // lifted as `u8 sp0; garr(&sp0); use2(sp0)` — a 12-byte object declared one byte, in a frame
      // the recompile makes 4 bytes wide, with `garr` writing the other 8 into the caller's. The
      // three rules above all pass it: one object, no `undef` op, no slot above it.
      //
      // What licenses an answer is the frame being ACCOUNTED FOR, word by word. Every word of the
      // reserved local area has to be an object this audit modelled or a slot the slot model keys;
      // a word that is neither is storage nothing here describes, so the emitted C reserves less
      // than the machine did and the writer reaches past what it allocated. Whole local area and
      // not only the words above the object: a word BELOW cannot be part of the object, but it is
      // still frame the declaration has to account for. Word granularity, not byte — the stack is
      // word-aligned, so a halfword object owns its word and the padding beside it is not a second
      // local.
      //
      // `mayWrite`, the predicate the two rules above take, and for the same reason: a device
      // SOURCE register reads through the address and cannot write the frame back.
      //
      // WHAT IT LEAVES, since this is the extent question the gate comment above is about: a
      // `mayWrite` escape is accepted only where the modelled objects and the keyed slots tile the
      // reserved area between them — a word above the object is a slot (refused above), a second
      // object (refused above), or unaccounted (refused here). That is not a wider extent model; it
      // is the same one-scalar `extent`, made to say when it does not fit. An object of two words
      // cannot be built here at all — the second access that would reach it is a `[+4]` the
      // `scalar()` guard refuses — so no widening of the frame licence admits a shape this rule
      // would then have to judge.
      if (mayWrite.size > 0) {
        const accountedWords = new Set<number>();
        for (const [off, width] of extent) {
          for (let w = off - (off % 4); w < off + width; w += 4) {
            accountedWords.add(w);
          }
        }
        for (const slot of usedSlotOffsets) {
          accountedWords.add(slot - (slot % 4));
        }
        for (let w = 0; w < localArea; w += 4) {
          if (!accountedWords.has(w)) {
            fail(
              `the word at [sp,#${w}] is neither an object this lift models nor a slot it keys, ` +
                `and the captured address reaches something that may write it — nothing accounts for the ` +
                `rest of the frame, so nothing bounds the captured object's extent`,
            );
          }
        }
      }
      // Proven. Stamp the MACHINE FACTS the audit established — width and signedness are what the
      // accesses used, so the declaration downstream is a fact, not a guess. The C-level NAME is
      // deliberately NOT chosen here: identifiers live in the structurer's namespace (params,
      // locals, globals, the symbol map), which the frontend cannot see — a frontend-chosen `sp0`
      // silently shadowed a project global of the same name.
      // `volatile` iff the address is PUBLISHED — written to memory, rather than handed to a
      // callee. That is the DMA idiom this rule was written for and it IS the source's own
      // spelling there: klonoa's `DMA_FILL` writes `vu##bit tmp` outright, sa3's does under
      // `PLATFORM_GBA`, pokeemerald's inside `DMA_FILL_UNCHECKED`, and the address goes to a device
      // register through a store. Reproducing that source means reproducing the qualifier.
      //
      // NOT on an ordinary `&local` ARGUMENT, where no source in the corpus writes one and the
      // qualifier is not free. `void f(u32 i){ s32 w; w = gEnts[i].h; use(&w); four(w,w,w,w); }`
      // compiles to one `ldr` reloaded into four registers by copies; the structurer emits one C
      // read per USE rather than per machine load, so `volatile` forbids the CSE and makes it four
      // `ldr`s — a byte-exact candidate turned into a four-instruction nonmatch (compiled, agbcc
      // 2.9-arm-000512, `-O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix`). It is free
      // only where the object is read at most once, which is all the rows that first shipped it
      // did. agbcc also warns `discards qualifiers` at every such call.
      //
      // NOT because gcc would otherwise delete the store. That claim was here for several releases
      // and does not reproduce: taking `&tmp` makes the local addressable, so gcc-2.9 keeps the
      // store with or without the qualifier, measured on store-then-escape, publish-then-fill, and
      // a loop that stores and escapes each iteration. What the qualifier does change is register
      // ALLOCATION — the same function compiled `vu16` and `u16` is 98 instructions either way and
      // differs in three register assignments — which is why it still has to be right. asmlift's
      // OWN dead-store pass used to key on it; it keys on address-taken now (l3/dce.ts), so
      // dropping the qualifier here cannot cost a store.
      //
      // An object whose address never leaves the function needs no volatile and must not pay it.
      for (const [off, ops] of objects) {
        const width = extent.get(off)!;
        const signed = accesses.get(off)!.some((a) => a.signed);
        for (const op of ops) {
          op.attrs = { ...op.attrs, width, signed, ...(published.has(off) ? { volatile: true } : {}) };
        }
      }
    }
  }

  // Order the entry block's parameters by ABI register (r0, r1, r2, …) so downstream
  // naming (`a0`, `a1`, …) matches the calling convention, not the read order. Safe only
  // for the true entry (no predecessors) — a loop header's params are phis whose position
  // is index-aligned with predecessor terminator args and must not be reordered.
  const entry = irBlocks[0];
  // non-ABI live-in ranks LAST (99) — deliberate Thumb tie-break; MIPS/PPC's is -1/first
  //
  // "Non-ABI" means NOT AN ARGUMENT REGISTER, and it has to be tested that way rather than by the
  // shape of the name. A `/^r(\d+)$/` test ranked `r8` at 8 and `r4` at 4 while sending only `sl`
  // and `sb` to 99 — harmless while nothing else occupied ranks >= 4, and a positional miscompile
  // the moment incoming stack arguments started ranking there. `sub_80B6B3C` in sa3's
  // `asm/code_x.s` — still undecompiled, so not a benchmark row — takes 10 arguments (its caller
  // stores six words at [sp,#0]..[sp,#0x14] plus r0-r3) and saves r8 in its prologue;
  // the `r8` live-in and `@sarg8` tied at 8, the sort is stable, the prologue reads r8 first — so
  // ABI argument 8 was emitted as `a9` and every parameter after it was off by one.
  //
  // The register partition (LiveInModel.uninitRegs) takes most of r4-sl before they reach here — one
  // the ABI does not pass arguments in and this function saved is an uninitialised local, not a
  // parameter. What still ranks 99 is `lr`/`pc`, which the partition does not list, and an r4-sl the
  // prologue did not save. Not an argument either way, and the honest place for one is after
  // everything the convention actually describes.
  abiSortEntryParams(entry, preds[0].length > 0, (v) => {
    const key = paramReg.get(v) ?? '';
    // an incoming STACK argument ranks by its ABI index, after every register argument
    const s = stackArgIndex(key);
    if (s !== null) {
      return s;
    }
    const i = target.argRegs.indexOf(key);
    return i >= 0 ? i : 99;
  });
  return fn;
}

/** The ARMv4T / Thumb (agbcc) frontend, registered for the `armv4t` target. */
export const thumbFrontend: Frontend = { id: 'thumb', inputFormat: 'gnu-as', lift };
