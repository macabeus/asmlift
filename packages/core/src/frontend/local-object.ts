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
//   • a relocation falls inside its bytes that is no pointer-width absolute address of an ordinary
//     global: one narrower or wider than a pointer, or off the object's words, or of another type,
//     or naming what no declaration outside the function can (a section, the compiler's anonymous
//     constant, another function-scope static — reloc-symbol.ts's kinds). Such an address is
//     RECORDED (`LocalObject.relocs`) and left to the reader of the object to spell or refuse
//     (structure/local-statics.ts);
//   • its extent cannot be read: a directive inside its data run this reader does not parse, a
//     size that disagrees with the bytes under the label, or an empty object;
//   • its alignment cannot be read: an `.align` form this reader does not parse, or an object file
//     whose `.comment` section does not record it;
//   • another function names it too. A static of an inlined same-unit function is named by every
//     function the compiler inlined it into — agbcc 2.9 puts `static inline counter`'s `n.3`
//     ahead of its first caller, and mwcc -inline auto has `A` and `B` both address `n$4` — so
//     re-declaring it inside one of them would split one object in two. Only the functions this
//     input shows can be checked, which is the limit of this refusal: a single-function input
//     cannot show a second referrer, and one that ends at this function cannot show a later one.
import type { LocalObject, LocalObjectReloc, LocalObjects } from '../ir/core';
import type { AsmData } from './asmdata';
import { classifyRelocSymbol, localStaticName, unspellableReason } from './reloc-symbol';

/** A definition, or why there is none: the tail of a refusal sentence the caller opens with
 *  "names a function-scope static ('<symbol>')", so every refusal of the kind reads the same. */
export type LocalObjectRead = LocalObject | { refused: string };

const refused = (why: string): { refused: string } => ({ refused: why });

/** The bytes of a pointer on every target whose initializers these readers relocate — the width of
 *  the only relocations they record (agbcc's `.word sym`, mwcc's `R_PPC_ADDR32`). */
const POINTER_BYTES = 4;

/** Why an initializer's address of `symbol` cannot be recorded, as the tail of the refusal
 *  sentence — or null for an ordinary global's, which a declaration outside the function names.
 *  Every other kind is the naming policy's own (reloc-symbol.ts), with its own sentence. */
function addressRefusal(symbol: string): string | null {
  const why = unspellableReason(symbol);
  return why === null ? null : `whose initializer holds an address that ${why}`;
}

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

/** The named escapes agbcc's ASM_OUTPUT_ASCII writes (agbcc/gcc/thumb.h:195-260); every other
 *  unprintable byte it writes as `\ooo` octal. */
const GAS_ESCAPES: Readonly<Record<string, number>> = { n: 10, t: 9, r: 13, f: 12, b: 8, '\\': 92, '"': 34 };

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
    } else if (n in GAS_ESCAPES) {
      out.push(GAS_ESCAPES[n]);
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
 *  padding, which writes none), whether one of those values is negative, whether it writes a
 *  string, and the addresses among its values, at their byte offsets in the directive. */
interface DirectiveData {
  bytes: number[];
  width: number | null;
  negative: boolean;
  string: boolean;
  relocs: LocalObjectReloc[];
}

/** `sym`, `sym+K` or `sym-K` — the operand GNU as relocates to a symbol's address plus a constant. */
const GAS_ADDRESS = /^([A-Za-z_.$][\w.$]*)\s*(?:([+-])\s*(\S+))?$/;

/** One data directive's data; `{ refused }` for an operand that is no number and no address this
 *  reader records, null when the directive is not a data directive this reader parses. */
function dataBytes(directive: string, operands: string): DirectiveData | { refused: string } | null {
  const width = /^(byte)$/.test(directive)
    ? 1
    : /^(short|hword|2byte)$/.test(directive)
      ? 2
      : /^(word|long|int|4byte)$/.test(directive)
        ? 4
        : 0;
  if (width > 0) {
    const out: number[] = [];
    const relocs: LocalObjectReloc[] = [];
    let negative = false;
    for (const op of operands.split(',')) {
      const v = gasInteger(op);
      if (v !== null) {
        negative ||= v < 0;
        out.push(...le(v, width));
        continue;
      }
      // Not a number, so the assembler relocates the value: an address, which the bytes do not hold.
      const a = op.trim().match(GAS_ADDRESS);
      // agbcc writes a negative addend `garr+-0x4` (compiled: `&garr[-1]`), so the constant keeps a sign
      const k = a === null ? null : a[3] === undefined ? 0 : gasInteger(a[3]);
      if (a === null || k === null) {
        return refused(`whose initializer holds '${op.trim()}', an expression this reader does not read as an address`);
      }
      if (width !== POINTER_BYTES) {
        return refused(
          `whose initializer holds the address '${op.trim()}' in a ${width}-byte value — not a pointer's ${POINTER_BYTES}`,
        );
      }
      const why = addressRefusal(a[1]);
      if (why !== null) {
        return refused(why);
      }
      relocs.push({ offset: out.length, symbol: a[1], addend: a[2] === '-' ? -k : k });
      out.push(...le(0, width));
    }
    return { bytes: out, width, negative, string: false, relocs };
  }
  if (/^(space|skip|zero)$/.test(directive)) {
    const [n, fill, ...rest] = operands.split(',').map((s) => gasInteger(s));
    return n === null || n < 0 || rest.length > 0 || fill === null
      ? null
      : {
          bytes: new Array<number>(n).fill((fill ?? 0) & 0xff),
          width: null,
          negative: false,
          string: false,
          relocs: [],
        };
  }
  if (/^(ascii|asciz|string)$/.test(directive)) {
    const m = operands.trim().match(/^"((?:[^"\\]|\\.)*)"$/);
    const s = m ? gasString(m[1]) : null;
    return s === null
      ? null
      : { bytes: directive === 'ascii' ? s : [...s, 0], width: 1, negative: false, string: true, relocs: [] };
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

/** The directives that end an object's data run without being part of it: the next object's
 *  alignment or bss allocation, and what ends a file or opens code. Any other directive inside the
 *  run is one this reader cannot size, so it refuses there rather than end the object short — an
 *  unsized object has no `.size` to catch the truncation (telf.h:297-316 prints one only when the
 *  declaration knows the size). */
const RUN_ENDS: ReadonlySet<string> = new Set([
  'align',
  'balign',
  'p2align',
  'lcomm',
  'comm',
  'ident',
  'end',
  'code',
  'thumb',
  'thumb_func',
  'arm',
]);

/** Read a function-scope static's definition out of GNU as text (agbcc's `.s`).
 *
 *  Two shapes, both agbcc 2.9's (varasm.c `assemble_variable`): an object with NO initializer is
 *  `.lcomm name.N,size` — bss, with the exact size; an initialized one is a label under
 *  `.section .rodata` or `.data`, followed by its data directives. `.size name.N,K` is emitted for
 *  a sized declarator and NOT for an unsized one (`static const u8 tide[] = {…}` has none), so the
 *  extent is the data run under the label, which ends at the next label, section switch,
 *  instruction or one of {@link RUN_ENDS}, and `.size` where present must agree with it. */
export function readGasLocalObject(asm: string, symbol: string): LocalObjectRead {
  const parts = localStaticName(symbol);
  if (parts === null) {
    return refused('whose name has no source spelling this reader knows');
  }
  const { name, counter: order } = parts;
  const read = readGasDefinition(asm, symbol);
  return 'refused' in read ? read : { name, symbol, order, ...read };
}

/** Read an ANONYMOUS constant out of GNU as text: the data run under a compiler-generated `.L`
 *  label (agbcc's `.LC0`), which is how agbcc 2.9 places the image a local aggregate's constant
 *  initializer is copied from (`u8 a[16] = {…}` is `ldr r1,=.LC0; mov r0,sp; mov r2,#16; bl memcpy`,
 *  varasm.c `output_constant_def`). Nothing in the source names it, so no declaration can spell it:
 *  the object is carried {@link LocalObject.anonymous} and spelled only as the initializer of the
 *  local it is copied into (l3/constinit.ts), or refused there.
 *
 *  Read-only data only, with the same refusals as a static's definition: a `.L` label anywhere else
 *  is code, or data this reader has no reason to believe is a constant image. That gate is agbcc's
 *  placement, not every compiler's: IDO 7.1 places the same image in `.data` (compiled). Which
 *  names are anonymous is reloc-symbol.ts's decision (`anon-pool`). */
export function readGasAnonymousObject(asm: string, label: string): LocalObjectRead {
  if (classifyRelocSymbol(label) !== 'anon-pool') {
    return refused('whose label is not a compiler-generated `.L` label');
  }
  const read = readGasDefinition(asm, label);
  if ('refused' in read) {
    return read;
  }
  if (read.section !== 'rodata') {
    return refused(`defined in ${read.section}, which is not the read-only data a constant image sits in`);
  }
  return { name: label, symbol: label, order: -1, anonymous: true, ...read };
}

/** A definition's section, size, bytes and directives, read from the label down. */
function readGasDefinition(
  asm: string,
  symbol: string,
): Omit<LocalObject, 'name' | 'symbol' | 'order'> | { refused: string } {
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
      return { section: 'bss', size, bigEndian: false };
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
  const strings = new Set<boolean>();
  const gaps: [number, number][] = [];
  const relocs: LocalObjectReloc[] = [];
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
    if (!d || RUN_ENDS.has(d[1])) {
      break; // an instruction, or what comes after an object
    }
    if (d[1] === 'type' || d[1] === 'size' || d[1] === 'globl') {
      continue;
    }
    const b = dataBytes(d[1], d[2]);
    if (b === null) {
      return refused(`whose data run holds '.${d[1]}', a directive this reader does not read as bytes`);
    }
    if ('refused' in b) {
      return b;
    }
    // A word lands wherever the run has reached: agbcc aligns an object's words, never one word
    // inside it, so one off a pointer boundary is no pointer of the object's.
    if (b.relocs.length > 0 && bytes.length % POINTER_BYTES !== 0) {
      return refused(`whose initializer holds the address '${b.relocs[0].symbol}' off its ${POINTER_BYTES}-byte words`);
    }
    relocs.push(...b.relocs.map((r) => ({ ...r, offset: r.offset + bytes.length })));
    if (b.width === null && b.bytes.length > 0 && b.bytes.every((x) => x === 0)) {
      const last = gaps[gaps.length - 1];
      if (last !== undefined && last[0] + last[1] === bytes.length) {
        last[1] += b.bytes.length;
      } else {
        gaps.push([bytes.length, b.bytes.length]);
      }
    }
    bytes.push(...b.bytes);
    if (b.width !== null) {
      widths.add(b.width);
      negative ||= b.negative && b.width < 4;
      strings.add(b.string);
    }
  }
  if (bytes.length === 0) {
    return refused('whose label heads no data');
  }
  if (declaredSize !== null && declaredSize !== bytes.length) {
    return refused(`whose '.size' (${declaredSize}) disagrees with the ${bytes.length} bytes under its label`);
  }
  if (kind === 'bss') {
    return bytes.every((b) => b === 0) && relocs.length === 0
      ? { section: 'bss', size: bytes.length, bigEndian: false }
      : refused('defined in bss with non-zero bytes');
  }
  const align = alignAhead(lines, at);
  if (align === null) {
    return refused('whose alignment directive this reader does not read');
  }
  // A word's negative value says nothing: agbcc's constants are 32-bit host integers (machmode.h:30),
  // so an unsigned word past 0x7fffffff prints negative too, while a narrower constant keeps its
  // type's extension (varasm.c:1706-1710 `immed_double_const`) — `.short 0xffff` is a u16,
  // `.short -0x1` an s16. And it says so only of the ELEMENT when every value is one width: in a
  // struct's mixed directives a negative belongs to one field, which says nothing of another.
  const unit = widths.size === 1 && bytes.length % [...widths][0] === 0 ? [...widths][0] : undefined;
  return {
    section: kind,
    size: bytes.length,
    bytes: Uint8Array.from(bytes),
    bigEndian: false,
    directives: {
      align,
      ...(unit !== undefined ? { unit } : {}),
      negative: unit !== undefined && negative,
      string: strings.size === 1 && strings.has(true),
      ...(widths.size > 0 && gaps.length > 0 ? { gaps } : {}),
    },
    ...(relocs.length > 0 ? { relocs } : {}),
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

/** The relocations that fill a pointer-width word with a symbol's absolute address — the only kind
 *  an initializer's address constant is. Each is listed where a frontend reads its objects through
 *  this reader: mwcc's (frontend/ppc.ts); MIPS addresses a function-scope static section-relative
 *  and does not reach it. */
const ABSOLUTE_WORD: ReadonlySet<string> = new Set(['R_PPC_ADDR32']);

/** Sections whose relocations describe the program for a debugger, not for the machine. */
const isDebugSection = (s: string): boolean => /^\.(debug|line)/.test(s);

/** mwcc's `.comment` section: `CodeWarrior\n`, a header to 0x2c, then one 8-byte record per
 *  symbol-table entry, the null one first, whose first word is the alignment mwcc gave that symbol
 *  (compiled: `s64` records 8 and lands at 8 after an `s32`, `aligned(32)` records 32, a scalar
 *  `u8` 1). No section header or symbol value says the same: a section's alignment is its widest
 *  object's, and an object at offset 0 of one is aligned to anything. */
const MW_COMMENT_MAGIC = 'CodeWarrior\n';
const MW_COMMENT_RECORDS = 0x2c;

/** The alignment mwcc's `.comment` records for the symbol at `index`, or null when the section is
 *  absent, is not mwcc's, or holds another number of records than the listing has symbols — the
 *  index would then name another symbol's. */
function recordedAlign(ad: AsmData, index: number): number | null {
  const c = ad.sections.get('.comment');
  if (
    c === undefined ||
    String.fromCharCode(...c.subarray(0, MW_COMMENT_MAGIC.length)) !== MW_COMMENT_MAGIC ||
    c.length !== MW_COMMENT_RECORDS + 8 * (ad.symbolCount + 1)
  ) {
    return null;
  }
  const at = MW_COMMENT_RECORDS + 8 * index;
  const align = ((c[at] << 24) | (c[at + 1] << 16) | (c[at + 2] << 8) | c[at + 3]) >>> 0;
  return align > 0 && (align & (align - 1)) === 0 ? align : null;
}

/** Read a function-scope static's definition out of an object's `objdump -s -r -t` side table:
 *  the symbol table gives its section, offset and size, the section contents its bytes, and mwcc's
 *  `.comment` its alignment. `fn` is the function reading it — a relocation naming the static from
 *  any other code, or from data, is another referrer. */
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
  const inside: typeof ad.relocs = [];
  for (const r of ad.relocs) {
    if (r.section === sym.section && r.offset >= sym.value && r.offset < sym.value + sym.size) {
      inside.push(r);
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
  const align = recordedAlign(ad, sym.index);
  if (align === null) {
    return refused("whose alignment the object's `.comment` section does not record");
  }
  const placement = { align, section: sym.section, offset: sym.value };
  if (kind === 'bss') {
    return inside.length === 0
      ? { name, symbol, order, section: 'bss', size: sym.size, bigEndian: ad.bigEndian, placement }
      : refused('defined in bss with a relocation inside it');
  }
  const contents = ad.sections.get(sym.section);
  if (contents === undefined || sym.value + sym.size > contents.length) {
    return refused(`whose bytes the side table's '${sym.section}' contents do not hold`);
  }
  const relocs: LocalObjectReloc[] = [];
  for (const r of inside.sort((a, b) => a.offset - b.offset)) {
    const at = r.offset - sym.value;
    if (!ABSOLUTE_WORD.has(r.type)) {
      return refused(
        `whose initializer holds the address '${r.sym}' by a ${r.type} relocation — no pointer's absolute address`,
      );
    }
    if (at % POINTER_BYTES !== 0 || at + POINTER_BYTES > sym.size) {
      return refused(`whose initializer holds the address '${r.sym}' off its ${POINTER_BYTES}-byte words`);
    }
    const why = addressRefusal(r.sym);
    if (why !== null) {
      return refused(why);
    }
    // The word's own bytes add to the relocation's addend: they are zero under a RELA relocation and
    // ARE the addend under a REL one (asmdata.ts reads a jump table's entries the same way).
    const w = contents.subarray(r.offset, r.offset + POINTER_BYTES);
    const inline = ad.bigEndian
      ? (w[0] << 24) | (w[1] << 16) | (w[2] << 8) | w[3]
      : (w[3] << 24) | (w[2] << 16) | (w[1] << 8) | w[0];
    relocs.push({ offset: at, symbol: r.sym, addend: (r.addend + inline) | 0 });
  }
  return {
    name,
    symbol,
    order,
    section: kind,
    size: sym.size,
    bytes: contents.slice(sym.value, sym.value + sym.size),
    bigEndian: ad.bigEndian,
    placement,
    ...(relocs.length > 0 ? { relocs } : {}),
  };
}

/** The statics one lift names, gathered as the frontend meets them. */
export interface LocalStatics {
  /** Record a static this function names, and answer the name the IR calls it by: its linker name,
   *  which no C identifier and no declared symbol can equal. */
  define(obj: LocalObject): string;
  /** Every static, or undefined for none. */
  finish(): LocalObjects | undefined;
}

export function makeLocalStatics(): LocalStatics {
  const bySymbol = new Map<string, LocalObject>();
  return {
    define(obj) {
      bySymbol.set(obj.symbol, obj);
      return obj.symbol;
    },
    finish: () => (bySymbol.size > 0 ? bySymbol : undefined),
  };
}
