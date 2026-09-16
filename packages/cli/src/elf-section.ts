// asmlift — reading ONE function out of an object that holds several code sections.
//
// CodeWarrior splits a translation unit across sections ALL NAMED `.text`, each starting at address
// 0 (197 of Animal Crossing's 4,103 target objects do). A whole-object `objdump -d` prints one block
// per section with colliding addresses, and labels an address with whatever symbol it finds at that
// value — so in `m_choice.o` 22 of 94 functions are first labelled inside a section that does not
// define them, and 4 are never labelled at all. Anything that keys on the NAME in that text reads
// another function's bytes, silently.
//
// The remedy is to disassemble a copy of the object holding only the code section the symbol's
// `st_shndx` names, with only that section's relocations. objdump cannot express that selection
// itself: `-j` filters by section NAME and the names are equal, `--start-address` by VMA and the
// VMAs are all 0.
//
// ELF32 only, either byte order — every object the CLI and the harness disassemble is ELF32. An
// object this reader cannot parse is reported as having nothing to disambiguate, so it reaches
// objdump exactly as it does today and objdump reports on it.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_RELA = 4;
const SHT_NOBITS = 8;
const SHT_REL = 9;
const SHT_DYNSYM = 11;
const SHF_EXECINSTR = 0x4;
const SHN_UNDEF = 0;
const SHN_LORESERVE = 0xff00;
const SYM_ENTSIZE = 16;
const SH_ENTSIZE = 40;
const EH_SIZE = 52;

interface SectionHeader {
  name: number;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  align: number;
  entsize: number;
}

interface Elf32 {
  bytes: Buffer;
  littleEndian: boolean;
  shstrndx: number;
  sections: SectionHeader[];
}

function readElf32(bytes: Uint8Array): Elf32 | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < EH_SIZE || buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 1) {
    return undefined;
  }
  const littleEndian = buf[5] === 1;
  const u16 = (o: number) => (littleEndian ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const shoff = u32(0x20);
  const shentsize = u16(0x2e);
  const shnum = u16(0x30);
  if (shentsize < SH_ENTSIZE || shoff + shnum * shentsize > buf.length) {
    return undefined;
  }
  const sections: SectionHeader[] = [];
  for (let i = 0; i < shnum; i++) {
    const sh = shoff + i * shentsize;
    sections.push({
      name: u32(sh),
      type: u32(sh + 4),
      flags: u32(sh + 8),
      addr: u32(sh + 12),
      offset: u32(sh + 16),
      size: u32(sh + 20),
      link: u32(sh + 24),
      info: u32(sh + 28),
      align: u32(sh + 32),
      entsize: u32(sh + 36),
    });
  }
  return { bytes: buf, littleEndian, shstrndx: u16(0x32), sections };
}

/** A section objdump disassembles: one carrying instruction bytes of its own. */
const isCode = (s: SectionHeader): boolean => s.type === SHT_PROGBITS && (s.flags & SHF_EXECINSTR) !== 0 && s.size > 0;

/** Whether a name-keyed read of this object's whole-object disassembly is ambiguous — i.e. whether it
 *  holds more than one code section. */
export function severalCodeSections(bytes: Uint8Array): boolean {
  const elf = readElf32(bytes);
  return elf !== undefined && elf.sections.filter(isCode).length > 1;
}

/** The index of the code section defining `sym`, or undefined when no code section does. */
function definingSection(elf: Elf32, sym: string): number | undefined {
  const want = Buffer.from(`${sym}\0`, 'latin1');
  const u16 = (o: number) => (elf.littleEndian ? elf.bytes.readUInt16LE(o) : elf.bytes.readUInt16BE(o));
  const u32 = (o: number) => (elf.littleEndian ? elf.bytes.readUInt32LE(o) : elf.bytes.readUInt32BE(o));
  for (const tab of elf.sections.filter((s) => s.type === SHT_SYMTAB)) {
    const strings = elf.sections[tab.link].offset;
    for (let at = tab.offset; at + SYM_ENTSIZE <= tab.offset + tab.size; at += SYM_ENTSIZE) {
      const shndx = u16(at + 14);
      if (shndx === SHN_UNDEF || shndx >= SHN_LORESERVE || !isCode(elf.sections[shndx])) {
        continue;
      }
      const nameAt = strings + u32(at);
      if (elf.bytes.subarray(nameAt, nameAt + want.length).equals(want)) {
        return shndx;
      }
    }
  }
  return undefined;
}

/** The object with every code section OTHER than the one defining `sym` removed, along with those
 *  sections' relocations. Symbols they defined survive as undefined ones, so a relocation reaching
 *  into them still disassembles under its own name; data sections are untouched, which is what the
 *  jump-table side-table reads.
 *
 *  `undefined` when there is nothing to disambiguate — at most one code section, or bytes this
 *  reader cannot parse. Returning the object unchanged there is what keeps every single-`.text`
 *  disassembly byte-identical to the one this seam produced before it existed.
 *
 *  Throws when several code sections are present and none defines `sym`: the caller asked for a
 *  function this object does not hold, and any answer would be another section's bytes. */
export function sectionScopedObject(bytes: Uint8Array, sym: string): Uint8Array | undefined {
  const elf = readElf32(bytes);
  if (elf === undefined) {
    return undefined;
  }
  const code = elf.sections.filter(isCode).length;
  if (code <= 1) {
    return undefined;
  }
  const keepCode = definingSection(elf, sym);
  if (keepCode === undefined) {
    throw new Error(
      `the object holds ${code} code sections and none of them defines '${sym}' — ` +
        "a whole-object disassembly would label another section's bytes with that name",
    );
  }
  const isDropped = (i: number): boolean => isCode(elf.sections[i]) && i !== keepCode;
  const dropped = new Set(elf.sections.map((_, i) => i).filter(isDropped));
  const relocatesDropped = (s: SectionHeader): boolean =>
    (s.type === SHT_REL || s.type === SHT_RELA) && dropped.has(s.info);
  const keep = elf.sections.map((_, i) => i).filter((i) => !dropped.has(i) && !relocatesDropped(elf.sections[i]));
  const remap = new Map<number, number>(keep.map((old, at) => [old, at]));
  return writeElf32(elf, keep, (old) => remap.get(old) ?? SHN_UNDEF, dropped);
}

/** Re-emit `elf` holding only `keep` (in their original order), with every section index rewritten
 *  through `index` — in the file header, in each section's link/info, and in each symbol's
 *  `st_shndx`. */
function writeElf32(
  elf: Elf32,
  keep: readonly number[],
  index: (old: number) => number,
  dropped: ReadonlySet<number>,
): Uint8Array {
  const le = elf.littleEndian;
  const bodies: Buffer[] = [];
  const offsets: number[] = [];
  let at = EH_SIZE;
  for (const old of keep) {
    const s = elf.sections[old];
    if (s.type === SHT_NOBITS) {
      // occupies no file bytes; its offset is where it would have started
      offsets.push(at);
      bodies.push(Buffer.alloc(0));
      continue;
    }
    const align = Math.max(1, s.align);
    at += (align - (at % align)) % align;
    const body = Buffer.from(elf.bytes.subarray(s.offset, s.offset + s.size));
    if (s.type === SHT_SYMTAB || s.type === SHT_DYNSYM) {
      rewriteSymbols(body, le, index, dropped);
    }
    bodies.push(body);
    offsets.push(at);
    at += body.length;
  }
  at += (4 - (at % 4)) % 4;
  const shoff = at;

  const out = Buffer.alloc(shoff + keep.length * SH_ENTSIZE);
  elf.bytes.copy(out, 0, 0, EH_SIZE);
  const w16 = (v: number, o: number) => (le ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o));
  const w32 = (v: number, o: number) => (le ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o));
  w32(shoff, 0x20);
  w16(SH_ENTSIZE, 0x2e);
  w16(keep.length, 0x30);
  w16(index(elf.shstrndx), 0x32);
  keep.forEach((old, i) => {
    const s = elf.sections[old];
    const sh = shoff + i * SH_ENTSIZE;
    bodies[i].copy(out, offsets[i]);
    const linksASection = s.type === SHT_SYMTAB || s.type === SHT_DYNSYM || s.type === SHT_REL || s.type === SHT_RELA;
    const relocates = s.type === SHT_REL || s.type === SHT_RELA;
    w32(s.name, sh);
    w32(s.type, sh + 4);
    w32(s.flags, sh + 8);
    w32(s.addr, sh + 12);
    w32(offsets[i], sh + 16);
    w32(s.size, sh + 20);
    w32(linksASection ? index(s.link) : s.link, sh + 24);
    w32(relocates ? index(s.info) : s.info, sh + 28);
    w32(s.align, sh + 32);
    w32(s.entsize, sh + 36);
  });
  return out;
}

/** Point every symbol at its section's new index. One defined in a dropped section becomes
 *  undefined, and loses the value and size that described bytes this object no longer holds. */
function rewriteSymbols(symtab: Buffer, le: boolean, index: (old: number) => number, dropped: ReadonlySet<number>) {
  const r16 = (o: number) => (le ? symtab.readUInt16LE(o) : symtab.readUInt16BE(o));
  const w16 = (v: number, o: number) => (le ? symtab.writeUInt16LE(v, o) : symtab.writeUInt16BE(v, o));
  const w32 = (v: number, o: number) => (le ? symtab.writeUInt32LE(v, o) : symtab.writeUInt32BE(v, o));
  for (let at = 0; at + SYM_ENTSIZE <= symtab.length; at += SYM_ENTSIZE) {
    const shndx = r16(at + 14);
    if (shndx === SHN_UNDEF || shndx >= SHN_LORESERVE) {
      continue;
    }
    if (dropped.has(shndx)) {
      w32(0, at + 4); // st_value
      w32(0, at + 8); // st_size
    }
    w16(index(shndx), at + 14);
  }
}

/** The object to disassemble when reading `sym`: `objPath` itself when it holds at most one code
 *  section, otherwise a section-scoped copy written into `destDir`. The caller owns `destDir` — the
 *  CLI a scratch directory it removes, the harness the object's own (already container-visible)
 *  directory.
 *
 *  An object that cannot even be read passes through: this seam decides which SECTION to
 *  disassemble, and a missing or unreadable object is the disassembler's to report. */
export function scopedObjectPath(objPath: string, sym: string, destDir: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(objPath);
  } catch {
    return objPath;
  }
  const scoped = sectionScopedObject(bytes, sym);
  if (scoped === undefined) {
    return objPath;
  }
  const path = join(destDir, `${basename(objPath).replace(/\.o$/, '')}.${sym.replace(/[^\w.-]/g, '_')}.o`);
  writeFileSync(path, scoped);
  return path;
}
