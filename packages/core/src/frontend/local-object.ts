// asmlift — a function-scope static's DEFINITION, read out of the target.
//
// A relocation (PPC) or a literal-pool word (Thumb) names a function-scope static by the linker's
// name, `sprHideTbl$797` or `tide.3`, and the counter in it is the compiler's
// (frontend/reloc-symbol.ts). No declaration elsewhere in the project describes the object: the
// source DEFINED it inside the function. So a lift that names it must also define it, and
// everything a definition needs is in the target: the section says the qualifier and whether it
// has an initializer, the size says how big it is, and the bytes are the initializer.
//
// This module reads that and nothing else. Which C type the bytes are is a question about the
// function's accesses, answered where those are spelled.
//
// It REFUSES rather than guesses, each in a sentence naming the static, when:
//   • the target does not carry the definition (the symbol is absent, or its label heads no data);
//   • the object sits in a section that is not read-only data, initialized data or bss;
//   • a relocation falls inside its bytes — the initializer holds an address, which is a
//     declaration of another object this reader does not make;
//   • its extent cannot be read: a data directive this reader does not parse, a size that
//     disagrees with the bytes under the label, or an empty object;
//   • another function names it too. A static of an inlined same-unit function is named by every
//     function the compiler inlined it into — agbcc 2.9 puts `static inline counter`'s `n.3`
//     ahead of its first caller, and mwcc -inline auto has `A` and `B` both address `n$4` — so
//     re-declaring it inside one of them would split one object in two. Only the functions this
//     input shows can be checked, which is the limit of this refusal: a single-function input
//     cannot show a second referrer.
import type { AsmData } from './asmdata';
import { localStaticSourceName } from './reloc-symbol';

/** Where a static lives, which decides how its definition is spelled: `rodata` is `const` with an
 *  initializer, `data` has an initializer, `bss` has none. */
export type LocalObjectSection = 'rodata' | 'data' | 'bss';

/** One function-scope static, as the target defines it. */
export interface LocalObject {
  /** the name the source wrote — the linker name without the compiler's counter */
  name: string;
  /** the linker name the target carries (`tide.3`, `sprHideTbl$797`) */
  symbol: string;
  section: LocalObjectSection;
  /** bytes */
  size: number;
  /** the initial contents in target byte order; absent exactly for a `bss` object */
  bytes?: Uint8Array;
  bigEndian: boolean;
}

/** A function's statics, keyed by {@link LocalObject.name}. */
export type LocalObjects = ReadonlyMap<string, LocalObject>;

/** A definition, or the reason there is none as the tail of a refusal sentence. */
export type LocalObjectRead = LocalObject | { refused: string };

const refused = (symbol: string, why: string): { refused: string } => ({
  refused: `names a function-scope static ('${symbol}') ${why}`,
});

// ── GNU as text (agbcc) ──────────────────────────────────────────────────────────────────────────

/** A line without its `@` comment, where the `@` is not inside a string literal. */
function code(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && quoted) {
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === '@' && !quoted) {
      return line.slice(0, i).trim();
    }
  }
  return line.trim();
}

/** The section a GNU as section directive switches to, or null for a line that is not one. */
function sectionSwitch(line: string): string | null {
  const m = line.match(/^\.(?:section\s+([^\s,]+)|(text|data|bss)\b)/);
  return m ? (m[1] ?? `.${m[2]}`) : null;
}

const GAS_SECTIONS: Readonly<Record<string, LocalObjectSection>> = {
  '.rodata': 'rodata',
  '.data': 'data',
  '.bss': 'bss',
};

/** A GNU as integer literal: decimal, `0x` hex or `0` octal, optionally negated. */
function gasInteger(s: string): number | null {
  const m = s.trim().match(/^(-?)(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i);
  if (!m) {
    return null;
  }
  const radix = /^0x/i.test(m[2]) ? 16 : /^0\d/.test(m[2]) ? 8 : 10;
  const mag = parseInt(radix === 16 ? m[2].slice(2) : m[2], radix);
  return m[1] ? -mag : mag;
}

/** The bytes of a GNU as string literal body (between its quotes), or null for an escape this
 *  reader does not decode. */
function gasString(body: string): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out.push(c.charCodeAt(0) & 0xff);
      continue;
    }
    const n = body[++i];
    const oct = body.slice(i).match(/^[0-7]{1,3}/);
    if (oct) {
      out.push(parseInt(oct[0], 8) & 0xff);
      i += oct[0].length - 1;
    } else if (n === 'n' || n === 't' || n === 'r' || n === '\\' || n === '"') {
      out.push({ n: 10, t: 9, r: 13, '\\': 92, '"': 34 }[n]);
    } else {
      return null;
    }
  }
  return out;
}

/** Little-endian bytes of `value` at `width` bytes — the only byte order agbcc's target has. */
const le = (value: number, width: number): number[] =>
  Array.from({ length: width }, (_, i) => (value >>> (8 * i)) & 0xff);

/** One data directive's bytes; `{ address }` when an operand is not a number (a symbol — the
 *  word is relocated), null when the directive is not a data directive this reader parses. */
function dataBytes(directive: string, operands: string): number[] | { address: string } | null {
  const width = /^(byte)$/.test(directive)
    ? 1
    : /^(short|hword|2byte)$/.test(directive)
      ? 2
      : /^(word|long|int|4byte)$/.test(directive)
        ? 4
        : 0;
  if (width > 0) {
    const out: number[] = [];
    for (const op of operands.split(',')) {
      const v = gasInteger(op);
      if (v === null) {
        return { address: op.trim() };
      }
      out.push(...le(v, width));
    }
    return out;
  }
  if (/^(space|skip|zero)$/.test(directive)) {
    const [n, fill, ...rest] = operands.split(',').map((s) => gasInteger(s));
    return n === null || n < 0 || rest.length > 0 || fill === null
      ? null
      : new Array<number>(n).fill((fill ?? 0) & 0xff);
  }
  if (/^(ascii|asciz|string)$/.test(directive)) {
    const m = operands.trim().match(/^"((?:[^"\\]|\\.)*)"$/);
    const s = m ? gasString(m[1]) : null;
    return s === null ? null : directive === 'ascii' ? s : [...s, 0];
  }
  return null;
}

/** Read a function-scope static's definition out of GNU as text (agbcc's `.s`).
 *
 *  Two shapes, both agbcc 2.9's (varasm.c `assemble_variable`): an object with NO initializer is
 *  `.lcomm name.N,size` — bss, with the exact size; an initialized one is a label under
 *  `.section .rodata` or `.data`, followed by its data directives. `.size name.N,K` is emitted for
 *  a sized declarator and NOT for an unsized one (`static const u8 tide[] = {…}` has none), so the
 *  extent is the data run under the label, which ends at the next label, section switch or any
 *  other directive, and `.size` where present must agree with it. */
export function readGasLocalObject(asm: string, symbol: string): LocalObjectRead {
  const name = localStaticSourceName(symbol);
  if (name === null) {
    return refused(symbol, 'whose name has no source spelling this reader knows');
  }
  const lines = asm.split('\n').map(code);
  let declaredSize: number | null = null;
  let section: string | null = null;
  let at = -1;
  let labelSection: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lcomm = line.match(/^\.lcomm\s+([^\s,]+)\s*,\s*(\S+?)(?:\s*,.*)?$/);
    if (lcomm && lcomm[1] === symbol) {
      const size = gasInteger(lcomm[2]);
      if (size === null || size <= 0) {
        return refused(symbol, `whose '.lcomm' size '${lcomm[2]}' is not a positive number`);
      }
      return { name, symbol, section: 'bss', size, bigEndian: false };
    }
    const sz = line.match(/^\.size\s+([^\s,]+)\s*,\s*(\S+)$/);
    if (sz && sz[1] === symbol) {
      declaredSize = gasInteger(sz[2]);
    }
    const sw = sectionSwitch(line);
    if (sw !== null) {
      section = sw;
    }
    const lab = line.match(/^([A-Za-z_.$][\w.$]*):/);
    if (lab && lab[1] === symbol) {
      if (at !== -1) {
        return refused(symbol, 'whose label is defined twice in this asm');
      }
      at = i;
      labelSection = section;
    }
  }
  if (at === -1) {
    return refused(symbol, 'whose definition this asm does not carry');
  }
  const kind = labelSection === null ? undefined : GAS_SECTIONS[labelSection];
  if (kind === undefined) {
    return refused(symbol, `defined in section '${labelSection ?? '(none)'}', which is not data this reader defines`);
  }
  const bytes: number[] = [];
  const first = lines[at].replace(/^[A-Za-z_.$][\w.$]*:\s*/, '');
  for (let i = at; i < lines.length; i++) {
    const line = i === at ? first : lines[i];
    if (line === '') {
      continue;
    }
    if (/^[A-Za-z_.$][\w.$]*:/.test(line) || sectionSwitch(line) !== null) {
      break;
    }
    const d = line.match(/^\.(\w+)\s*(.*)$/);
    if (!d) {
      break; // an instruction
    }
    if (d[1] === 'type' || d[1] === 'size' || d[1] === 'globl') {
      continue;
    }
    const b = dataBytes(d[1], d[2]);
    if (b === null) {
      if (bytes.length === 0) {
        return refused(symbol, `whose data starts with '.${d[1]}', a directive this reader does not read as bytes`);
      }
      break; // `.align` and the like: the run ended
    }
    if (!Array.isArray(b)) {
      return refused(symbol, `whose initializer holds the address '${b.address}' — a relocation inside the object`);
    }
    bytes.push(...b);
  }
  if (bytes.length === 0) {
    return refused(symbol, 'whose label heads no data');
  }
  if (declaredSize !== null && declaredSize !== bytes.length) {
    return refused(symbol, `whose '.size' (${declaredSize}) disagrees with the ${bytes.length} bytes under its label`);
  }
  if (kind === 'bss') {
    return bytes.every((b) => b === 0)
      ? { name, symbol, section: 'bss', size: bytes.length, bigEndian: false }
      : refused(symbol, 'defined in bss with non-zero bytes');
  }
  return { name, symbol, section: kind, size: bytes.length, bytes: Uint8Array.from(bytes), bigEndian: false };
}

/** The functions whose literal pools name `symbol` in GNU as text, by the function each pool
 *  follows: a pool word belongs to the most recent function start (`.thumb_func` then a label, or
 *  a pret `thumb_func_start NAME`). */
export function gasPoolReferrers(asm: string, symbol: string): Set<string> {
  const out = new Set<string>();
  let fn: string | null = null;
  let pendingFn = false;
  for (const raw of asm.split('\n')) {
    const line = code(raw);
    const start = line.match(/^(?:non_word_aligned_)?thumb_func_start\s+(\S+)$/);
    if (start) {
      fn = start[1];
      continue;
    }
    if (line === '.thumb_func') {
      pendingFn = true;
      continue;
    }
    const lab = line.match(/^([A-Za-z_.$][\w.$]*):\s*(.*)$/);
    if (lab && pendingFn) {
      fn = lab[1];
      pendingFn = false;
    }
    const rest = lab ? lab[2] : line;
    const w = rest.match(/^\.(?:word|4byte|long)\s+(.+)$/);
    if (w && fn !== null && w[1].split(',').some((op) => op.trim().match(/^[A-Za-z_.$][\w.$]*/)?.[0] === symbol)) {
      out.add(fn);
    }
  }
  return out;
}

// ── An object file's side table (mwcc) ───────────────────────────────────────────────────────────

const OBJECT_SECTIONS: Readonly<Record<string, LocalObjectSection>> = {
  '.rodata': 'rodata',
  '.sdata2': 'rodata',
  '.data': 'data',
  '.sdata': 'data',
  '.bss': 'bss',
  '.sbss': 'bss',
};

/** Sections whose relocations describe the program for a debugger, not for the machine. */
const isDebugSection = (s: string): boolean => /^\.(debug|line)/.test(s);

/** Read a function-scope static's definition out of an object's `objdump -s -r -t` side table:
 *  the symbol table gives its section, offset and size, the section contents its bytes.
 *  `fn` is the function reading it — a relocation naming the static from any other code, or from
 *  data, is another referrer. */
export function readObjectLocalObject(ad: AsmData, symbol: string, fn: string): LocalObjectRead {
  const name = localStaticSourceName(symbol);
  if (name === null) {
    return refused(symbol, 'whose name has no source spelling this reader knows');
  }
  const sym = ad.symbols.get(symbol);
  if (sym === undefined) {
    return refused(symbol, "whose definition the object's symbol table does not carry");
  }
  const kind = OBJECT_SECTIONS[sym.section];
  if (kind === undefined) {
    return refused(symbol, `defined in section '${sym.section}', which is not data this reader defines`);
  }
  if (sym.size <= 0) {
    return refused(symbol, 'whose symbol-table size is 0, so its extent is unknown');
  }
  const self = ad.symbols.get(fn);
  for (const r of ad.relocs) {
    if (r.section === sym.section && r.offset >= sym.value && r.offset < sym.value + sym.size) {
      return refused(symbol, `whose initializer holds the address '${r.sym}' — a relocation inside the object`);
    }
    if (r.sym !== symbol || isDebugSection(r.section)) {
      continue;
    }
    const inSelf =
      self !== undefined && r.section === self.section && r.offset >= self.value && r.offset < self.value + self.size;
    if (!inSelf) {
      return refused(
        symbol,
        `that ${r.section} also names at 0x${r.offset.toString(16)} — it is not this function's alone`,
      );
    }
  }
  if (kind === 'bss') {
    return { name, symbol, section: 'bss', size: sym.size, bigEndian: ad.bigEndian };
  }
  const contents = ad.sections.get(sym.section);
  if (contents === undefined || sym.value + sym.size > contents.length) {
    return refused(symbol, `whose bytes the side table's '${sym.section}' contents do not hold`);
  }
  return {
    name,
    symbol,
    section: kind,
    size: sym.size,
    bytes: contents.slice(sym.value, sym.value + sym.size),
    bigEndian: ad.bigEndian,
  };
}
