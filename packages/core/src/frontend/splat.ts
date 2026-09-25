// asmlift — the Splat-dialect MIPS reader. Splat (the N64 disassembler that pmret/decomp.me-style
// projects run) emits a GNU-as flavour that neither `objdump -d` nor a compiler produce, so the
// shared objdump scaffolding (frontend/disasm.ts) reads nothing from it. This module normalises
// that dialect into the SAME `DisasmInstr[]` the objdump parser yields, so the whole MIPS frontend
// (delay slots, blocks, SSA, recovery) runs downstream unchanged — mirroring how the Thumb frontend
// grew a second dialect for pret/luvdis splits.
//
// What the dialect adds over objdump:
//   • `glabel NAME` / `endlabel NAME` function markers (objdump uses `ADDR <sym>:` headers);
//   • a `/* ROM VRAM BYTES */` comment prefix on every instruction (the addr lives INSIDE it, so
//     disasm.ts's `ADDR:` line anchor never matches) — the VRAM word is the instruction address;
//   • `$`-prefixed registers (`$v0`, `$sp`) — stripped to the bare names the frontend's guards expect;
//   • `.L<vram>_<rom>` local labels as branch/jump TARGETS (objdump prints a resolved address) —
//     resolved here to the target instruction's address;
//   • constant immediate EXPRESSIONS (`(0x660104 >> 16)`, `(x & 0xFFFF)`) — the assembler's hi/lo
//     split of a 32-bit literal, evaluated here to the plain number the decode switch parses.
//
// `%hi`/`%lo` operands (a global's address) are turned into exactly what a relocatable object
// carries — an `R_MIPS_HI16`/`R_MIPS_LO16` record on the instruction, plus the immediate the
// instruction really encodes — so both MIPS dialects reach ONE fold (frontend/mips.ts,
// frontend/high-half.ts) and neither gets a pairing rule of its own. The encoding is the
// assembler's: `%hi(x)` is `((x + 0x8000) >> 16) & 0xffff`, ADJUSTED so the sign-extended low half
// cancels the carry, and `%lo(x)` is the sign-extended low 16 bits — which is what lets the fold
// recover `x` as `(hi << 16) + (s16)lo` for a positive or a negative offset alike.
// The other GOT/PIC relocations (`%gp_rel`, `%got`, …) are declined LOUD — small-data /
// position-independent access is not modelled.
import type { DisasmInstr, DisasmReloc } from './disasm';
import { FrontendUnsupportedError } from './errors';

// One instruction line: `/* ROM VRAM BYTES */  MNEMONIC  OPS`. Group 1 is the VRAM address word.
const INSN_LINE = /^\/\*\s*[0-9A-Fa-f]+\s+([0-9A-Fa-f]+)\s+[0-9A-Fa-f]+\s*\*\/\s*(\S+)\s*(.*)$/;
// A Splat instruction-comment prefix anywhere in the text — the load-bearing format signal.
const INSN_SIGNAL = /\/\*\s*[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s*\*\//;
// A local-label DEFINITION on its own line (`.L800011C0_1DC0:`); the colon is required.
const LABEL_DEF = /^(\.[\w.$]+):$/;
// A GOT/PIC relocation operand this reader does not support (small-data / position-independent
// access) — declined loud. `%hi`/`%lo` are NOT here: they name a global's address and become
// relocation records for the MIPS frontend to fold (see normalizeOperand / frontend/mips.ts).
const RELOC_OP = /%(gp_rel|gprel|got|call16|call_hi|call_lo|higher|highest|neg|tprel|dtprel)\b/i;
// Any `%hi`/`%lo` spelling at all, so a half `normalizeOperand`'s pattern cannot resolve is caught
// rather than falling through to the paths that read an operand as arithmetic.
const HILO_OP = /%(hi|lo)\s*\(/i;
// Data directives whose bytes could encode an effect: skipping one inside a function slice would
// silently delete it, so they decline (mirrors the Thumb frontend's in-code-data guard).
const DATA_DIRECTIVE =
  /^\.(byte|half|hword|short|2byte|word|4byte|long|dword|8byte|quad|float|double|ascii|asciz|string|incbin|space|skip|fill|zero)\b/i;

/** Does this text look like Splat-dialect MIPS? Both signals (`glabel` markers and the
 *  three-word instruction-comment prefix) are unique to Splat — objdump and compiler `.s` carry
 *  neither — so a positive match is unambiguous. */
export function isSplatMips(asm: string): boolean {
  return /^\s*glabel\s+\S+/m.test(asm) || INSN_SIGNAL.test(asm);
}

/** Parse Splat-dialect text into one function's `DisasmInstr[]`. When `glabel` markers are present
 *  the text is sliced to exactly `name` (an absent symbol declines LOUD — emitting some other
 *  function's body under the requested name is the silent miscompile the cardinal rule forbids);
 *  a marker-less fragment is parsed whole. Branch targets are resolved against the local-label
 *  map, so an unresolved `.L` target declines here rather than crashing deep in the frontend. */
export function parseSplatMips(asm: string, name: string): DisasmInstr[] {
  const lines = asm.split('\n');

  // Slice to the requested function: `glabel NAME` … its `endlabel`/the next `glabel`/EOF.
  const glabels: { line: number; sym: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*glabel\s+(\S+)/);
    if (m) {
      glabels.push({ line: i, sym: m[1] });
    }
  }
  let slice = lines;
  if (glabels.length > 0) {
    const at = glabels.findIndex((g) => g.sym === name);
    if (at === -1) {
      throw new FrontendUnsupportedError(
        `symbol '${name}' not found in the Splat disassembly (functions present: ${glabels.map((g) => g.sym).join(', ')})`,
      );
    }
    let end = lines.length;
    for (let i = glabels[at].line + 1; i < lines.length; i++) {
      if (/^\s*(endlabel|glabel)\b/.test(lines[i])) {
        end = i;
        break;
      }
    }
    slice = lines.slice(glabels[at].line, end);
  }

  // Flatten to instructions, assigning any pending label(s) to the NEXT instruction's address.
  const instrs: DisasmInstr[] = [];
  const labelAddr = new Map<string, number>();
  let pending: string[] = [];
  for (const raw of slice) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (/^(glabel|endlabel|dlabel|jlabel)\b/.test(line) || /^nonmatching\b/.test(line)) {
      continue; // function/data markers and the objdiff scratch header
    }
    const labelDef = line.match(LABEL_DEF);
    if (labelDef) {
      pending.push(labelDef[1]);
      continue;
    }
    if (line.startsWith('.')) {
      // A data directive in the code stream could hide an instruction/effect — decline; other
      // bookkeeping directives (`.set`, `.align`, `.section`…) are transparent and skipped.
      if (DATA_DIRECTIVE.test(line)) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': data directive '${line}' in the code stream — skipping it would silently delete its effect`,
        );
      }
      continue;
    }
    const m = line.match(INSN_LINE);
    if (!m) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': unrecognised line in the Splat disassembly: '${line}'`,
      );
    }
    const addr = parseInt(m[1], 16);
    const mnemonic = m[2];
    // A data directive carrying an instruction-comment prefix (`/* … */ .word …`) would otherwise
    // be decoded as a mnemonic and silently become an opaque — decline it like the bare form.
    if (DATA_DIRECTIVE.test(mnemonic)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': data directive '${mnemonic}' in the code stream — skipping it would silently delete its effect`,
      );
    }
    const normalized = m[3].trim() ? splitOperands(m[3].trim()).map((o) => normalizeOperand(name, o)) : [];
    const ops = normalized.map((n) => n.op);
    // At most one relocation per instruction — the same invariant disasm.ts enforces on objdump
    // output, and for the same reason: two would leave one symbol standing for the other's operand.
    const relocs = normalized.map((n) => n.reloc).filter((r): r is DisasmReloc => r !== undefined);
    if (relocs.length > 1) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': two relocation operands on one instruction ('${mnemonic}' at ` +
          `0x${addr.toString(16)}): '${relocs[0].sym}' and '${relocs[1].sym}'`,
      );
    }
    // addi/addiu SIGN-EXTEND their 16-bit immediate; Splat may spell the low half of a materialised
    // constant as an unsigned mask (`(0x8000ABCD & 0xFFFF)` = 0xABCD), so re-sign it here to match
    // the hardware — and the objdump path, which prints the already-signed value. Zero-extending ops
    // (ori/andi/xori) and lui keep the unsigned value, so they are deliberately excluded.
    if ((mnemonic === 'addiu' || mnemonic === 'addi') && ops.length === 3 && /^-?(0x[0-9a-fA-F]+|\d+)$/.test(ops[2])) {
      ops[2] = String(signExtend16(ops[2]));
    }
    for (const l of pending) {
      labelAddr.set(l, addr);
    }
    pending = [];
    instrs.push({ addr, mnemonic, ops, reloc: relocs[0] });
  }

  // Resolve every branch/jump's target label to an address. A target that is not a local label of
  // this function — an unresolvable `.L`, or a bare symbol (`j func` tail call) — declines LOUD
  // rather than leaving `target` undefined for the frontend to crash on (`succ(undefined)`).
  for (const ins of instrs) {
    if (!isBranchMnemonic(ins.mnemonic)) {
      continue;
    }
    const label = ins.ops[ins.ops.length - 1];
    const t = label !== undefined ? labelAddr.get(label) : undefined;
    if (t === undefined) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': branch/jump target '${label ?? ''}' is not a local label in this function ` +
          `(tail call / cross-function branch not modelled)`,
      );
    }
    ins.target = t;
  }
  return instrs;
}

// A control transfer whose last operand is a code-label target: `b`, `j`, and the conditional
// branches (`beq`/`bnez`/`bc1f`…). NOT `jal`/`jalr` (calls) or `jr` (register) — the MIPS frontend
// owns those declines; `break` is a trap, not a branch.
const isBranchMnemonic = (mn: string): boolean => mn === 'j' || (mn[0] === 'b' && mn !== 'break');

// Re-sign a raw 16-bit immediate: a value with bit 15 set becomes negative (two's complement),
// matching how addi/addiu sign-extend the field. A value already ≤ 0x7FFF is unchanged.
function signExtend16(s: string): number {
  const v = parseInt(s, /^-?0x/i.test(s) ? 16 : 10) & 0xffff;
  return v & 0x8000 ? v - 0x10000 : v;
}

// Split an operand list on top-level commas (commas inside `(...)` — a memory operand or a
// constant expression — do not separate operands).
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
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

/** A COPROCESSOR-1 REGISTER, in every spelling either MIPS dialect writes. THE ONE COPY: this
 *  reader decides which tokens keep the `$` sigil and `frontend/mips.ts` passes the same object as
 *  `OpaquePolicy.fpReg`, so the two questions — "does this survive normalisation with its sigil?"
 *  and "is this the FPU's file?" — are answered by one predicate. Two copies are sequenced rather
 *  than merely duplicated: widening the frontend's alone changes nothing, because this one has
 *  already stripped the token, and widening this one alone hands the frontend a sigil its own
 *  predicate rejects. Each half is silent on its own and the result is an opaque on a register in
 *  a file nothing models.
 *
 *  Why the sigil: objdump writes a GPR bare (`v0`) and an FPU register with the sigil (`$f12`), so
 *  an FPU register is the one operand shape this reader must NOT strip, or the two dialects hand
 *  the frontend two different spellings of the same register. It is REQUIRED rather than optional
 *  because the bare form is indistinguishable from an objdump branch target, which is also bare
 *  lower-case hex (`f4`, `fa0`).
 *
 *  The spellings, and all three are live in the trees: objdump's numbers (`$f12`), this dialect's
 *  o32 ABI names (`$ft2`, `$fv0`, `$fa0`, `$fs0`), and the trailing `f` those names take for the
 *  ODD HALF of a double-precision pair (`$ft0f`, `$fa1f`). `$fp` is the frame pointer and is
 *  stripped like any GPR: the digit is what decides, and it is what excludes it.
 *
 *  Across every `$`-token in the three MIPS `asm/` trees this matches 52 tokens and every one is an
 *  FPU register:
 *  `grep -rhoE '\$[A-Za-z0-9_]+' apps/benchmark/checkouts/{af,marioparty3,snowboardkids2-decomp}/asm
 *   | sort -u | grep -icE '^\$f[vats]?[0-9]+f?$'` */
export const MIPS_FP_REG = /^\$f[vats]?\d+f?$/i;

/** The o32 ABI names of the EVEN FPU registers, by register number — the only ones a
 *  single-precision arithmetic instruction names under the FR=0 register model these compilers
 *  target. Read off the instruction words, not a manual: over 9,981 `add.s`/`sub.s`/`mul.s`/`div.s`
 *  lines in the `af` and `marioparty3` trees, decoding each word's `fd`/`fs`/`ft` fields gives every
 *  name one number and no name two. */
const O32_FP_NAMES: ReadonlyMap<string, number> = new Map([
  ['fv0', 0],
  ['fv1', 2],
  ['ft0', 4],
  ['ft1', 6],
  ['ft2', 8],
  ['ft3', 10],
  ['fa0', 12],
  ['fa1', 14],
  ['ft4', 16],
  ['ft5', 18],
  ['fs0', 20],
  ['fs1', 22],
  ['fs2', 24],
  ['fs3', 26],
  ['fs4', 28],
  ['fs5', 30],
]);

/** An FPU register token, in either dialect's spelling, as the ONE key both dialects share — the
 *  objdump number (`$fa0` and `$f12` are both `$f12`) — or null for anything this does not name: a
 *  GPR, or an ODD half (`$f13`, `$fa0f`), which only a double-precision value or a word move uses.
 *  A key is what the SSA builder names a register by, so two spellings of one register that did
 *  not meet here would be two variables. */
export function mipsEvenFpKey(tok: string): string | null {
  if (!MIPS_FP_REG.test(tok)) {
    return null;
  }
  const bare = tok.slice(1).toLowerCase();
  const num = /^f\d+$/.test(bare) ? Number(bare.slice(1)) : O32_FP_NAMES.get(bare);
  return num !== undefined && num < 32 && num % 2 === 0 ? `$f${num}` : null;
}

// Rewrite one Splat operand into the canonical objdump spelling the frontend consumes: strip the
// `$` register sigil (except on an FPU register, where objdump keeps it), fold a memory operand's
// displacement expression, evaluate a bare constant expression, split a `%hi`/`%lo` reference into
// an immediate plus its record, decline a PIC one.
function normalizeOperand(name: string, op: string): { op: string; reloc?: DisasmReloc } {
  // `%hi(SYM)` / `%lo(SYM + N)` / `%lo(SYM)(base)` — a global's address. Becomes the relocation
  // record an object file would carry plus the immediate the instruction really encodes, so the
  // frontend folds this dialect through the same path as objdump; NOT declined like the PIC relocs.
  // The addend is a constant expression like any other here, so its RADIX is {@link evalConst}'s
  // question rather than this pattern's — {@link refuseOctal} says why the placement is the rule.
  const hilo = op.match(
    /^%(hi|lo)\(\s*([A-Za-z_.$][\w.$]*)\s*(?:([+-])\s*(0x[0-9a-fA-F]+|\d+))?\s*\)(?:\((\$?[A-Za-z]\w*)\))?$/,
  );
  if (hilo) {
    const addend = hilo[4] ? evalConst(name, hilo[4]) * (hilo[3] === '-' ? -1 : 1) : 0;
    const imm = hilo[1] === 'hi' ? ((addend + 0x8000) >> 16) & 0xffff : (addend << 16) >> 16;
    const reloc: DisasmReloc = { type: hilo[1] === 'hi' ? 'R_MIPS_HI16' : 'R_MIPS_LO16', sym: hilo[2], addend: 0 };
    return { op: hilo[5] ? `${imm}(${hilo[5].replace(/^\$/, '')})` : String(imm), reloc };
  }
  // A `%hi`/`%lo` the pattern above did NOT convert is still a relocation operand, and the paths
  // below it read an operand as arithmetic: `%lo(0x800A1234)($v0)` matches the memory-operand shape
  // and `evalConst` drops the tokens it does not know, so the displacement becomes the bare number
  // and the access lifts as an index into the base register. A bare `%hi(…)` falls through to
  // `plain` and the frontend refuses it one level down as a non-numeric immediate; refusing here
  // says instead that what it saw was a relocation.
  if (HILO_OP.test(op)) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': relocation operand '${op}' — this reader resolves a '%hi'/'%lo' half ` +
        `only against a symbol ('SYM' or 'SYM ± <integer>'), and will not treat one it cannot ` +
        `resolve as arithmetic`,
    );
  }
  if (RELOC_OP.test(op)) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': relocation operand '${op}' (small-data / PIC data access) — not modelled`,
    );
  }
  const plain = (v: string) => ({ op: v });
  // Memory operand `DISP(base)` — base is a register (letter-first), DISP a constant/expression.
  const mem = op.match(/^(.*)\((\$?[A-Za-z]\w*)\)$/);
  if (mem) {
    const disp = mem[1].trim();
    const off = disp === '' ? '0' : String(evalConst(name, disp));
    return plain(`${off}(${mem[2].replace(/^\$/, '')})`);
  }
  // A bare constant expression (`(0x660104 >> 16)`) — the assembler's hi/lo literal split.
  if (op.startsWith('(')) {
    return plain(String(evalConst(name, op)));
  }
  // The one path that hands an operand on UNREAD, to a reader somewhere else: `addiu`/`addi`'s
  // re-sign above is one, the MIPS frontend's `parseImm` another, and neither is told the radix, so
  // a leading-zero immediate stops here — `addiu $v0, $a0, 020` lifted as `a0 + 20` against the
  // assembler's 16.
  if (OCTAL_MAGNITUDE.test(op)) {
    refuseOctal(name, op, op);
  }
  return plain(MIPS_FP_REG.test(op) ? op : op.replace(/^\$/, ''));
}

/** A magnitude with a LEADING ZERO is octal to the assembler and decimal to every `parseInt(…, 10)`
 *  in this file. Both readings are measured rather than assumed: under `mips-linux-gnu-as` 2.45,
 *  `.word 020` assembles to 0x10 and `.word 010` to 8 read back out of `.data`, and
 *  `lw $v0, 020($a0)` encodes the displacement 16 — against the 20 and the 10 a decimal reader
 *  answers. The difference reached the emitted C as a different ELEMENT: `%lo(gTab + 020)` lifted
 *  as `((s32 *)&gTab)[5]` where the assembler's addend gives `[4]`, and `%lo(gTab + 010)` as the
 *  fractional index `2.5`. A wrong address compiles and scores, so this is not something to guess.
 *
 *  This reader models hex and decimal, so the third radix REFUSES rather than being resolved:
 *  nothing produces the shape — 0 operand occurrences carrying a leading-zero integer over the
 *  4,200,524 operands of the 20,260 `.s` files that carry a `glabel` or a `.set noreorder` in the
 *  nine benchmark checkouts (counted with python; a recursive `grep` here skips `build/`) — so a
 *  reading for it would be a capability nothing could referee.
 *
 *  THE PLACEMENT IS THE POINT. The rule belongs to the readers that turn a digit string into a
 *  value, not to the patterns that feed them: a guard on one caller's regex leaves the next caller
 *  reading base 10, and the three readers that do — `evalConst`'s literal, {@link signExtend16} and
 *  the shared `parseImm` — are not all in this file. */
const OCTAL_MAGNITUDE = /^[-+]?0\d/;
const refuseOctal = (name: string, tok: string, operand: string): never => {
  throw new FrontendUnsupportedError(
    `cannot lift '${name}': operand '${operand}' has a leading-zero magnitude ('${tok}'), which is ` +
      `octal to the assembler and a radix this reader does not model`,
  );
};

// Evaluate a constant integer expression (the assembler's hi/lo split: hex/dec literals with
// `+ - * << >> & | ^ ~` and parentheses). Precedence-climbing; C-like precedence. A shift `>>` is
// LOGICAL — Splat's operands are unsigned 32-bit constants. Anything unparsable declines LOUD
// rather than silently yielding NaN.
function evalConst(name: string, expr: string): number {
  const toks = expr.match(/0x[0-9a-fA-F]+|\d+|<<|>>|[-+*&|^()~]/g);
  if (!toks) {
    throw new FrontendUnsupportedError(`cannot lift '${name}': unparsable constant expression '${expr}'`);
  }
  const prec: Record<string, number> = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6 };
  let p = 0;
  const fail = () => {
    throw new FrontendUnsupportedError(`cannot lift '${name}': unparsable constant expression '${expr}'`);
  };
  const primary = (): number => {
    const t = toks[p++];
    if (t === undefined) {
      return fail();
    }
    if (t === '(') {
      const v = expr2(0);
      if (toks[p++] !== ')') {
        return fail();
      }
      return v;
    }
    if (t === '-') {
      return -unary();
    }
    if (t === '~') {
      return ~unary();
    }
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) {
      if (OCTAL_MAGNITUDE.test(t)) {
        refuseOctal(name, t, expr);
      }
      return t.toLowerCase().startsWith('0x') ? parseInt(t, 16) : parseInt(t, 10);
    }
    return fail();
  };
  const unary = (): number => primary();
  const expr2 = (minPrec: number): number => {
    let left = unary();
    for (;;) {
      const op = toks[p];
      if (op === undefined || prec[op] === undefined || prec[op] < minPrec) {
        break;
      }
      p++;
      const right = expr2(prec[op] + 1);
      switch (op) {
        case '+':
          left = (left + right) | 0;
          break;
        case '-':
          left = (left - right) | 0;
          break;
        case '*':
          left = Math.imul(left, right);
          break;
        case '<<':
          left = (left << right) >>> 0;
          break;
        case '>>':
          left = left >>> right;
          break;
        case '&':
          left = left & right;
          break;
        case '|':
          left = left | right;
          break;
        case '^':
          left = left ^ right;
          break;
      }
    }
    return left;
  };
  const v = expr2(0);
  if (p !== toks.length) {
    return fail();
  }
  return v;
}
