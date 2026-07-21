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
// `%hi`/`%lo` operands (a global's address) are preserved verbatim so the MIPS frontend can fold
// them into a `gaddr` (frontend/mips.ts). The other GOT/PIC relocations (`%gp_rel`, `%got`, …) are
// declined LOUD — small-data / position-independent access is not modelled. Preserving rather than
// blindly evaluating is what keeps `parseImm('%hi(SYM)')` from silently becoming a NaN immediate.
import type { DisasmInstr } from './disasm';
import { FrontendUnsupportedError } from './errors';

// One instruction line: `/* ROM VRAM BYTES */  MNEMONIC  OPS`. Group 1 is the VRAM address word.
const INSN_LINE = /^\/\*\s*[0-9A-Fa-f]+\s+([0-9A-Fa-f]+)\s+[0-9A-Fa-f]+\s*\*\/\s*(\S+)\s*(.*)$/;
// A Splat instruction-comment prefix anywhere in the text — the load-bearing format signal.
const INSN_SIGNAL = /\/\*\s*[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s*\*\//;
// A local-label DEFINITION on its own line (`.L800011C0_1DC0:`); the colon is required.
const LABEL_DEF = /^(\.[\w.$]+):$/;
// A GOT/PIC relocation operand this reader does not support (small-data / position-independent
// access) — declined loud. `%hi`/`%lo` are NOT here: they name a global's address and are preserved
// verbatim for the MIPS frontend to fold into a `gaddr` (see normalizeOperand / frontend/mips.ts).
const RELOC_OP = /%(gp_rel|gprel|got|call16|call_hi|call_lo|higher|highest|neg|tprel|dtprel)\b/i;
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
    const ops = m[3].trim() ? splitOperands(m[3].trim()).map((o) => normalizeOperand(name, o)) : [];
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
    instrs.push({ addr, mnemonic, ops });
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

// Rewrite one Splat operand into the canonical objdump spelling the frontend consumes: strip the
// `$` register sigil, fold a memory operand's displacement expression, evaluate a bare constant
// expression, preserve a `%hi`/`%lo` global reference, and decline an unsupported PIC relocation.
function normalizeOperand(name: string, op: string): string {
  // `%hi(SYM)` / `%lo(SYM + N)` / `%lo(SYM)(base)` — a global's address. Preserved verbatim (with a
  // de-sigiled base) for the MIPS frontend to fold into a `gaddr`; NOT declined like the PIC relocs.
  const hilo = op.match(/^(%(?:hi|lo)\([^)]*\))(?:\((\$?[A-Za-z]\w*)\))?$/);
  if (hilo) {
    return hilo[2] ? `${hilo[1]}(${hilo[2].replace(/^\$/, '')})` : hilo[1];
  }
  if (RELOC_OP.test(op)) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': relocation operand '${op}' (small-data / PIC data access) — not modelled`,
    );
  }
  // Memory operand `DISP(base)` — base is a register (letter-first), DISP a constant/expression.
  const mem = op.match(/^(.*)\((\$?[A-Za-z]\w*)\)$/);
  if (mem) {
    const disp = mem[1].trim();
    const off = disp === '' ? '0' : String(evalConst(name, disp));
    return `${off}(${mem[2].replace(/^\$/, '')})`;
  }
  // A bare constant expression (`(0x660104 >> 16)`) — the assembler's hi/lo literal split.
  if (op.startsWith('(')) {
    return String(evalConst(name, op));
  }
  return op.replace(/^\$/, '');
}

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
