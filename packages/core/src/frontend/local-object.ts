// asmlift — a function-scope static's DEFINITION, read out of the target.
//
// A relocation (PPC) or a literal-pool word (Thumb) names a function-scope static by the linker's
// name, `sprHideTbl$797` or `tide.3`, and the counter in it is the compiler's
// (frontend/reloc-symbol.ts). No declaration elsewhere in the project describes the object: the
// source DEFINED it inside the function. So a lift that names it must also define it, and
// everything a definition needs is in the target: the section says the qualifier and whether it
// has an initializer, the size says how big it is, and the bytes are the initializer.
//
// This module reads that, and what an assembler listing shows beyond it — the directives the
// compiler wrote the initializer with and the alignment it placed the object at, which are facts
// about the source's type. Which C type the definition gets is decided where the accesses are
// spelled (structure/local-statics.ts).
//
// It REFUSES rather than guesses — with the tail of a sentence the caller opens by naming the
// static — when:
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
import type { LocalObject, LocalObjects } from '../ir/core';
import type { AsmData } from './asmdata';
import { localStaticName } from './reloc-symbol';

/** A definition, or why there is none: the tail of a refusal sentence the caller opens with
 *  "names a function-scope static ('<symbol>')", so every refusal of the kind reads the same. */
export type LocalObjectRead = LocalObject | { refused: string };

const refused = (why: string): { refused: string } => ({ refused: why });

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

const GAS_SECTIONS: Readonly<Record<string, LocalObject['section']>> = {
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

/** What one data directive writes: its bytes, the width of each value it writes (null for
 *  padding, which writes none), and whether one of those values is negative. */
interface DirectiveData {
  bytes: number[];
  width: number | null;
  negative: boolean;
}

/** One data directive's data; `{ address }` when an operand is not a number (a symbol — the word is
 *  relocated), null when the directive is not a data directive this reader parses. */
function dataBytes(directive: string, operands: string): DirectiveData | { address: string } | null {
  const width = /^(byte)$/.test(directive)
    ? 1
    : /^(short|hword|2byte)$/.test(directive)
      ? 2
      : /^(word|long|int|4byte)$/.test(directive)
        ? 4
        : 0;
  if (width > 0) {
    const out: number[] = [];
    let negative = false;
    for (const op of operands.split(',')) {
      const v = gasInteger(op);
      if (v === null) {
        return { address: op.trim() };
      }
      negative ||= v < 0;
      out.push(...le(v, width));
    }
    return { bytes: out, width, negative };
  }
  if (/^(space|skip|zero)$/.test(directive)) {
    const [n, fill, ...rest] = operands.split(',').map((s) => gasInteger(s));
    return n === null || n < 0 || rest.length > 0 || fill === null
      ? null
      : { bytes: new Array<number>(n).fill((fill ?? 0) & 0xff), width: null, negative: false };
  }
  if (/^(ascii|asciz|string)$/.test(directive)) {
    const m = operands.trim().match(/^"((?:[^"\\]|\\.)*)"$/);
    const s = m ? gasString(m[1]) : null;
    return s === null ? null : { bytes: directive === 'ascii' ? s : [...s, 0], width: 1, negative: false };
  }
  return null;
}

/** The alignment written ahead of the label on line `at`, in bytes. agbcc writes `.align N` there
 *  exactly when the object's alignment exceeds a byte — after the section switch, before `.type`,
 *  `.size` and the label (varasm.c:1327-1329 `assemble_variable`) — so none means 1. Null for an
 *  alignment directive this reader does not read. */
function alignAhead(lines: readonly string[], at: number): number | null {
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === '' || /^\.(type|size|globl)\b/.test(line)) {
      continue;
    }
    const a = line.match(/^\.align\s+(\d+)\s*(?:,.*)?$/);
    if (a) {
      return 2 ** Number(a[1]);
    }
    return /^\.(balign|p2align)\b/.test(line) ? null : 1;
  }
  return 1;
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
  const parts = localStaticName(symbol);
  if (parts === null) {
    return refused('whose name has no source spelling this reader knows');
  }
  const { name, counter: order } = parts;
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
        return refused(`whose '.lcomm' size '${lcomm[2]}' is not a positive number`);
      }
      return { name, symbol, order, section: 'bss', size, bigEndian: false };
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
        return refused('whose label is defined twice in this asm');
      }
      at = i;
      labelSection = section;
    }
  }
  if (at === -1) {
    return refused('whose definition this asm does not carry');
  }
  const kind = labelSection === null ? undefined : GAS_SECTIONS[labelSection];
  if (kind === undefined) {
    return refused(`defined in section '${labelSection ?? '(none)'}', which is not data this reader defines`);
  }
  const bytes: number[] = [];
  const widths = new Set<number>();
  let negative = false;
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
        return refused(`whose data starts with '.${d[1]}', a directive this reader does not read as bytes`);
      }
      break; // `.align` and the like: the run ended
    }
    if ('address' in b) {
      return refused(`whose initializer holds the address '${b.address}' — a relocation inside the object`);
    }
    bytes.push(...b.bytes);
    if (b.width !== null) {
      widths.add(b.width);
      negative ||= b.negative && b.width < 4;
    }
  }
  if (bytes.length === 0) {
    return refused('whose label heads no data');
  }
  if (declaredSize !== null && declaredSize !== bytes.length) {
    return refused(`whose '.size' (${declaredSize}) disagrees with the ${bytes.length} bytes under its label`);
  }
  if (kind === 'bss') {
    return bytes.every((b) => b === 0)
      ? { name, symbol, order, section: 'bss', size: bytes.length, bigEndian: false }
      : refused('defined in bss with non-zero bytes');
  }
  const align = alignAhead(lines, at);
  if (align === null) {
    return refused('whose alignment directive this reader does not read');
  }
  // A word's negative value says nothing: agbcc's constants are 32-bit host integers (machmode.h:30),
  // so an unsigned word past 0x7fffffff prints negative too, while a narrower constant keeps its
  // type's extension (varasm.c:1706-1710 `immed_double_const`) — `.short 0xffff` is a u16,
  // `.short -0x1` an s16.
  const unit = widths.size === 1 ? [...widths][0] : undefined;
  return {
    name,
    symbol,
    order,
    section: kind,
    size: bytes.length,
    bytes: Uint8Array.from(bytes),
    bigEndian: false,
    directives: { align, ...(unit !== undefined && bytes.length % unit === 0 ? { unit } : {}), negative },
  };
}

/** The functions whose literal pools name `symbol` in GNU as text, by the function each pool
 *  follows: a pool word belongs to the most recent function start (`.thumb_func` then a label, or
 *  a pret `thumb_func_start NAME`).
 *
 *  Only words in code count. A word in a data section is another object's initializer, and one
 *  naming a function-scope static belongs to a static of the same function, the only scope that
 *  can spell that name — so it is no second referrer, and it sits wherever the compiler emitted
 *  that object, which is ahead of the function's own code. */
export function gasPoolReferrers(asm: string, symbol: string): Set<string> {
  const out = new Set<string>();
  let fn: string | null = null;
  let pendingFn = false;
  let inCode = true;
  for (const raw of asm.split('\n')) {
    const line = code(raw);
    const sw = sectionSwitch(line);
    if (sw !== null) {
      inCode = sw === '.text' || sw.startsWith('.text.');
      continue;
    }
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
    if (
      inCode &&
      w &&
      fn !== null &&
      w[1].split(',').some((op) => op.trim().match(/^[A-Za-z_.$][\w.$]*/)?.[0] === symbol)
    ) {
      out.add(fn);
    }
  }
  return out;
}

// ── An object file's side table (mwcc) ───────────────────────────────────────────────────────────

const OBJECT_SECTIONS: Readonly<Record<string, LocalObject['section']>> = {
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
  const parts = localStaticName(symbol);
  if (parts === null) {
    return refused('whose name has no source spelling this reader knows');
  }
  const { name, counter: order } = parts;
  const sym = ad.symbols.get(symbol);
  if (sym === undefined) {
    return refused("whose definition the object's symbol table does not carry");
  }
  const kind = OBJECT_SECTIONS[sym.section];
  if (kind === undefined) {
    return refused(`defined in section '${sym.section}', which is not data this reader defines`);
  }
  if (sym.size <= 0) {
    return refused('whose symbol-table size is 0, so its extent is unknown');
  }
  const self = ad.symbols.get(fn);
  for (const r of ad.relocs) {
    if (r.section === sym.section && r.offset >= sym.value && r.offset < sym.value + sym.size) {
      return refused(`whose initializer holds the address '${r.sym}' — a relocation inside the object`);
    }
    if (r.sym !== symbol || isDebugSection(r.section)) {
      continue;
    }
    const inSelf =
      self !== undefined && r.section === self.section && r.offset >= self.value && r.offset < self.value + self.size;
    if (!inSelf) {
      return refused(`that ${r.section} also names at 0x${r.offset.toString(16)} — it is not this function's alone`);
    }
  }
  if (kind === 'bss') {
    return { name, symbol, order, section: 'bss', size: sym.size, bigEndian: ad.bigEndian };
  }
  const contents = ad.sections.get(sym.section);
  if (contents === undefined || sym.value + sym.size > contents.length) {
    return refused(`whose bytes the side table's '${sym.section}' contents do not hold`);
  }
  return {
    name,
    symbol,
    order,
    section: kind,
    size: sym.size,
    bytes: contents.slice(sym.value, sym.value + sym.size),
    bigEndian: ad.bigEndian,
  };
}

/** The statics one lift names, gathered as the frontend meets them. */
export interface LocalStatics {
  /** Record a static this function names, and answer the name its source wrote. */
  define(obj: LocalObject): string;
  /** Record a global this function names that is not one of its statics. */
  plain(sym: string): void;
  /** Every static, once every name is in, or undefined for none. */
  finish(): LocalObjects | undefined;
}

/** The registry a frontend collects its statics in. It refuses, through `fail` (the static's linker
 *  name and the sentence's tail), the two ways a block-scope definition would misname an object:
 *  two statics sharing a source name (inlined scopes each declaring an `n`), and a static sharing
 *  its name with a global the same function names, which the static would hide. */
export function makeLocalStatics(fail: (symbol: string, why: string) => never): LocalStatics {
  const byName = new Map<string, LocalObject>();
  const plain = new Set<string>();
  return {
    define(obj) {
      const seen = byName.get(obj.name);
      if (seen !== undefined && seen.symbol !== obj.symbol) {
        fail(
          obj.symbol,
          `whose source name '${obj.name}' another static here ('${seen.symbol}') also has — one block ` +
            `cannot declare both`,
        );
      }
      byName.set(obj.name, obj);
      return obj.name;
    },
    plain(sym) {
      plain.add(sym);
    },
    finish() {
      for (const obj of byName.values()) {
        if (plain.has(obj.name)) {
          fail(
            obj.symbol,
            `whose source name '${obj.name}' is also a global this function names — the static would hide it`,
          );
        }
      }
      return byName.size > 0 ? byName : undefined;
    },
  };
}
