// Is a compiled function the function the game contains? The ROM gate reads the function's bytes out of
// a relocatable object and out of the ELF holding the game's function — the project's linked ELF, or a REL
// module's own ELF, placed — and compares them with every relocated field masked: a relocation's value is
// only known once the object is linked (the linked ELF holds it resolved) or loaded (a module ELF leaves it
// to the loader). The rest of the function, instructions and literal pools included, must be byte-equal.
//
// The masked comparison SKIPS every relocated field, so what those fields will hold is compared as the
// symbol each relocation names — name, addend, and the datum's bytes where the file carries them
// (`comparePointedAt`). On PowerPC that is the whole of a function's constant data.
//
// A target proved equal is recorded by its digest (a row's `romDigest`): the function's bytes with the
// relocated bits cleared, and the relocations themselves. A target built later, with no ELF at hand, holds
// the function the ROM holds exactly when it has that digest (`targetDigest`).
//
// ELF32 only, ARM, MIPS and PowerPC: the machines the real tier builds for.
import { moduleLocation } from '@asmlift/bench-schema';
import { placedSectionAddress } from '@asmlift/cli/module-elf';
import { createHash } from 'node:crypto';

const SHT_RELA = 4;
const SHT_REL = 9;
const SHT_PROGBITS = 1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHN_LORESERVE = 0xff00;
const STB_LOCAL = 0;
const STT_NOTYPE = 0;
const STT_SECTION = 3;
const STT_FUNC = 2;
const EM_MIPS = 8;
const EM_PPC = 20;
const EM_ARM = 40;

interface Section {
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  info: number;
}

interface ElfSymbol {
  name: string;
  value: number;
  size: number;
  type: number;
  bind: number;
  shndx: number;
}

interface Elf32 {
  bytes: Buffer;
  littleEndian: boolean;
  machine: number;
  sections: Section[];
  symbols: ElfSymbol[];
}

function readElf32(bytes: Buffer, what: string): Elf32 {
  if (bytes.length < 52 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 1) {
    throw new Error(`${what} is not a 32-bit ELF file`);
  }
  const littleEndian = bytes[5] === 1;
  const u16 = (o: number) => (littleEndian ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
  const u32 = (o: number) => (littleEndian ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
  const shoff = u32(0x20);
  const shentsize = u16(0x2e);
  const shnum = u16(0x30);
  const shstrndx = u16(0x32);
  const names = shstrndx > 0 && shstrndx < shnum ? u32(shoff + shstrndx * shentsize + 16) : undefined;
  const sections: Section[] = [];
  for (let i = 0; i < shnum; i++) {
    const sh = shoff + i * shentsize;
    const nameAt = names === undefined ? undefined : names + u32(sh);
    sections.push({
      name: nameAt === undefined ? '' : bytes.toString('latin1', nameAt, bytes.indexOf(0, nameAt)),
      type: u32(sh + 4),
      flags: u32(sh + 8),
      addr: u32(sh + 12),
      offset: u32(sh + 16),
      size: u32(sh + 20),
      link: u32(sh + 24),
      info: u32(sh + 28),
    });
  }
  const symbols: ElfSymbol[] = [];
  for (const s of sections.filter((x) => x.type === 2)) {
    const strings = sections[s.link];
    for (let at = s.offset; at + 16 <= s.offset + s.size; at += 16) {
      const nameAt = strings.offset + u32(at);
      symbols.push({
        name: bytes.toString('latin1', nameAt, bytes.indexOf(0, nameAt)),
        value: u32(at + 4),
        size: u32(at + 8),
        type: bytes[at + 12] & 0xf,
        bind: bytes[at + 12] >> 4,
        shndx: u16(at + 14),
      });
    }
  }
  return { bytes, littleEndian, machine: u16(0x12), sections, symbols };
}

/** An address as code refers to it: ARM symbols carry the Thumb bit. */
const codeAddress = (elf: Elf32, value: number): number => (elf.machine === EM_ARM ? value & ~1 : value);

/** A symbol that can start a function's bytes: named, not an ARM mapping symbol (`$t`, `$d`), defined. */
const isCodeLabel = (s: ElfSymbol): boolean =>
  s.name !== '' &&
  !s.name.startsWith('$') &&
  (s.type === STT_NOTYPE || s.type === STT_FUNC) &&
  s.shndx > 0 &&
  s.shndx < SHN_LORESERVE;

/** Where a function without a size ends: the next code label after it, or its section's end. */
function nextLabel(elf: Elf32, start: number, shndx: number | undefined): number | undefined {
  const later = elf.symbols
    .filter((s) => isCodeLabel(s) && (shndx === undefined || s.shndx === shndx))
    .map((s) => codeAddress(elf, s.value))
    .filter((v) => v > start);
  return later.length > 0 ? Math.min(...later) : undefined;
}

/** Which bits each PowerPC relocation LEAVES for comparison — the bits the linker does not write —
 *  and how wide its field is. Big-endian, bit 0 the most significant.
 *
 *  These six are every type that appears in a code section of the three GameCube projects' objects
 *  (`ADDR32`/`UADDR32` appear only in data sections, which this mask never covers): Animal Crossing
 *  8,206 objects, Mario Party 4 1,161, Pikmin 1,166 — 4, 5, 6, 10, 11 and 109 in all three and
 *  nothing else.
 *
 *  A 2-BYTE FIELD STARTS AT `r_offset`; A 4-BYTE ONE AT THE WORD AROUND IT. The ABI puts an
 *  `ADDR16_*` relocation on the half-word it rewrites, two bytes into the instruction, and a
 *  branch relocation on the instruction — measured over those 3,000-odd objects, 4/5/6 are at an
 *  offset ≡ 2 (mod 4) every time and 10/11 at ≡ 0 every time. `EMB_SDA21` is written BOTH WAYS by
 *  CodeWarrior (66,828 at ≡ 0, 34,669 at ≡ 2, both spellings inside one project's own compiled
 *  objects) while rewriting the whole instruction either way — it replaces the BASE REGISTER field
 *  as well as the displacement — so its field is the word the offset falls in. */
const PPC_FIELD: Readonly<Record<number, { bytes: 2 | 4; keep: number }>> = {
  1: { bytes: 4, keep: 0 }, // R_PPC_ADDR32 — a whole address, the only way a DATUM points at something
  4: { bytes: 2, keep: 0 }, // R_PPC_ADDR16_LO — the low half of an address
  5: { bytes: 2, keep: 0 }, // R_PPC_ADDR16_HI — the high half
  6: { bytes: 2, keep: 0 }, // R_PPC_ADDR16_HA — the high half, adjusted for a signed low half
  10: { bytes: 4, keep: 0xfc000003 }, // R_PPC_REL24 — a `bl`: the opcode and the AA/LK bits survive
  11: { bytes: 4, keep: 0xffff0003 }, // R_PPC_REL14 — a conditional branch, with AA/LK
  109: { bytes: 4, keep: 0xffe00000 }, // R_PPC_EMB_SDA21 — base register AND displacement
};

/** One relocation over a function: where in it, of what type, and which symbol (+ addend) it names. */
interface RelocationEntry {
  offset: number;
  type: number;
  symIndex: number;
  addend: number;
}

/** The relocations over `[start, start + length)` of section `shndx` — or undefined when the FILE KEEPS
 *  NONE for that section, which is what a fully linked image looks like: its linker resolved every field
 *  and dropped the table. */
function relocationsOf(elf: Elf32, shndx: number, start: number, length: number): RelocationEntry[] | undefined {
  const tables = elf.sections.filter((s) => (s.type === SHT_REL || s.type === SHT_RELA) && s.info === shndx);
  if (tables.length === 0) {
    return undefined;
  }
  const u32 = (o: number) => (elf.littleEndian ? elf.bytes.readUInt32LE(o) : elf.bytes.readUInt32BE(o));
  const i32 = (o: number) => (elf.littleEndian ? elf.bytes.readInt32LE(o) : elf.bytes.readInt32BE(o));
  const entries: RelocationEntry[] = [];
  for (const rel of tables) {
    const entsize = rel.type === SHT_REL ? 8 : 12;
    for (let at = rel.offset; at + entsize <= rel.offset + rel.size; at += entsize) {
      const offset = u32(at) - start;
      if (offset < 0 || offset >= length) {
        continue;
      }
      // A REL entry's addend lives in the field itself, which is exactly the bits the mask leaves out —
      // so it is not a fact about the referent on either side, and is read as 0 on both.
      entries.push({
        offset,
        type: u32(at + 4) & 0xff,
        symIndex: u32(at + 4) >>> 8,
        addend: rel.type === SHT_RELA ? i32(at + 8) : 0,
      });
    }
  }
  return entries.sort((a, b) => a.offset - b.offset || a.type - b.type);
}

/** Per byte of `[start, start + length)` of section `shndx`: which bits the relocations leave compared. */
function relocationMask(elf: Elf32, entries: readonly RelocationEntry[], length: number): number[] {
  const mask = new Array<number>(length).fill(0xff);
  const clear = (at: number, fieldBytes: number, keep: number) => {
    for (let k = 0; k < fieldBytes; k++) {
      const byteOfField = elf.littleEndian ? k : fieldBytes - 1 - k;
      const idx = at + k;
      if (idx >= 0 && idx < length) {
        mask[idx] &= (keep >>> (8 * byteOfField)) & 0xff;
      }
    }
  };
  for (const { offset, type } of entries) {
    if (elf.machine === EM_ARM) {
      // R_ARM_THM_JUMP11 and R_ARM_THM_JUMP8 patch one 16-bit instruction, every other type 4 bytes
      clear(offset, type === 102 || type === 103 ? 2 : 4, 0);
    } else if (elf.machine === EM_MIPS) {
      // R_MIPS_26 fills the jump target and keeps the opcode; HI16, LO16 and GPREL16 fill the immediate
      clear(offset, 4, type === 4 ? 0xfc000000 : type === 5 || type === 6 || type === 7 ? 0xffff0000 : 0);
    } else if (elf.machine === EM_PPC) {
      const field = PPC_FIELD[type];
      if (field === undefined) {
        // LOUD, where MIPS falls back to clearing the whole word. A type this table does not
        // know is one nothing has measured, and guessing its field WIDENS what the comparison
        // ignores — the direction that lets a target that is not the game's function pass.
        throw new Error(`no PowerPC relocation mask for type ${type}`);
      }
      clear(field.bytes === 2 ? offset : offset & ~3, field.bytes, field.keep);
    } else {
      throw new Error(`no relocation mask for ELF machine ${elf.machine}`);
    }
  }
  return mask;
}

/** WHAT A RELOCATION POINTS AT — the half of a function the masked byte comparison cannot see.
 *
 *  A relocated field's bits are left out of that comparison on purpose: only the linker (or the module
 *  loader) knows them. What the field will hold is decided by the SYMBOL the relocation names, so the
 *  symbol is compared instead — its name, its addend, and, when it is a datum this file carries, the
 *  datum's bytes. On PowerPC that is the whole of a function's constant data: every float literal, string
 *  and table lives outside the function, reached through an `ADDR16_HA`/`LO` pair or an `EMB_SDA21`, and a
 *  target whose `-450.0f` reads `-451.0f` has byte-identical CODE.
 *
 *  `data` is the referent's bytes, and is absent where there are none to compare: an undefined symbol (the
 *  extern is a name here and nothing else), a NOBITS section (`.bss`, `.sbss`), and code — an earlier
 *  function's bytes carry their own relocated fields, which have no value to compare either.
 *
 *  A name is compared unless the COMPILER wrote it. CodeWarrior numbers two kinds of file-local name per
 *  translation unit — a literal pool is `@1135` and a function static `sprHideTbl$797` — so an object
 *  built from a unit PREFIX spells the same two data `@9` and `sprHideTbl$11`, and neither number is a
 *  fact about the game. Every other name a file defines, file-locally or not, is the one the source
 *  wrote: two `static` globals of the same size in `.bss` hold nothing to compare, and their names are
 *  the only thing that tells them apart. A symbol one side leaves UNDEFINED is compared by name too,
 *  which is how the linker would resolve it: a unit's own prefix leaves the statics defined below it
 *  undefined. */
interface Referent {
  name: string;
  /** a definition with file-local linkage — the case whose name is not comparable */
  local: boolean;
  /** the referent is a SECTION, not a datum in it — the case nothing about is comparable */
  sectionSymbol?: true;
  addend: number;
  section?: string;
  size?: number;
  data?: Buffer;
  /** per byte of `data`, which bits the FILE's own relocations over the datum leave compared */
  dataMask?: number[];
}

/** One relocation of a function, as the comparison reads it. */
interface Relocation {
  offset: number;
  type: number;
  referent: Referent;
}

/** How far a symbol's datum reaches: its size, or — a CodeWarrior section label carries none — up to the
 *  next symbol defined after it in the same section, or that section's end. In the section's OWN
 *  coordinates, which is what `sym.value` is written in: a linked image's addresses, a relocatable
 *  object's and a REL module's offsets. */
function extentOf(elf: Elf32, sym: ElfSymbol): number {
  if (sym.size > 0) {
    return sym.size;
  }
  const section = elf.sections[sym.shndx];
  const later = elf.symbols
    .filter((s) => s.shndx === sym.shndx && s.name !== '' && s.value > sym.value)
    .map((s) => s.value);
  return (later.length > 0 ? Math.min(...later) : section.addr + section.size) - sym.value;
}

function referentOf(elf: Elf32, entry: RelocationEntry): Referent {
  const sym = elf.symbols[entry.symIndex];
  const section = sym.shndx > 0 && sym.shndx < SHN_LORESERVE ? elf.sections[sym.shndx] : undefined;
  if (section === undefined) {
    return { name: sym.name, local: false, addend: entry.addend };
  }
  if (sym.type === STT_SECTION) {
    // A RELOCATION AGAINST A SECTION SYMBOL NAMES NO DATUM. Which section a datum ends up in is the
    // linker's choice — Animal Forest's object relocates against its own `.rodata` and the linked
    // image against the `.ovl_play` that absorbed it — and WHERE in the section is the addend, which
    // a REL table (the MIPS and ARM projects') keeps in the very field this comparison masks. Offset
    // and type are all such a relocation states on either side. IDO writes them for every reference
    // to a file-local datum; CodeWarrior writes none.
    return { name: section.name, local: true, sectionSymbol: true, addend: entry.addend };
  }
  const referent: Referent = {
    name: sym.name,
    local: sym.bind === STB_LOCAL,
    addend: entry.addend,
    section: section.name,
    size: sym.size,
  };
  if (section.type !== SHT_PROGBITS || (section.flags & SHF_EXECINSTR) !== 0) {
    return referent;
  }
  // `- section.addr` is what turns the section's own coordinates into a file offset, exactly as
  // `heldFunction` does for the code: a relocatable object and a REL module put their sections at 0
  // and a linked image at the address the game loads them to, so without it a linked image's datum is
  // read MEGABYTES past the end of the file — an empty buffer, which compares equal to everything.
  const at = sym.value + entry.addend;
  const end = sym.value + extentOf(elf, sym);
  if (end <= at || at < section.addr || end > section.addr + section.size) {
    return referent;
  }
  return {
    ...referent,
    data: elf.bytes.subarray(section.offset + at - section.addr, section.offset + end - section.addr),
    // A datum can be relocated too — a `bctr` jump table is nothing BUT relocations, all zeroes in the
    // object and resolved addresses in the game's file — and those fields have no comparable value, for
    // the same reason the instruction stream's have none. What is left of the datum is still compared.
    dataMask: relocationMask(elf, relocationsOf(elf, sym.shndx, at, end - at) ?? [], end - at),
  };
}

const relocationsFor = (elf: Elf32, shndx: number, start: number, length: number): Relocation[] | undefined =>
  relocationsOf(elf, shndx, start, length)?.map((e) => ({
    offset: e.offset,
    type: e.type,
    referent: referentOf(elf, e),
  }));

/** A function's bytes, per byte the bits its relocations leave compared, and what those relocations point
 *  at. `relocations` is undefined for a file that keeps none (a fully linked image). */
interface FunctionBytes {
  bytes: Buffer;
  mask: number[];
  relocations: Relocation[] | undefined;
}

/** The function `sym` defines in a relocatable object. */
function objectFunction(object: Buffer, sym: string): FunctionBytes | undefined {
  const obj = readElf32(object, 'the object');
  const defined = obj.symbols.find((s) => s.name === sym && isCodeLabel(s));
  if (defined === undefined) {
    return undefined;
  }
  const section = obj.sections[defined.shndx];
  const start = codeAddress(obj, defined.value);
  const end = defined.size > 0 ? start + defined.size : (nextLabel(obj, start, defined.shndx) ?? section.size);
  const entries = relocationsOf(obj, defined.shndx, start, end - start) ?? [];
  return {
    bytes: obj.bytes.subarray(section.offset + start, section.offset + end),
    mask: relocationMask(obj, entries, end - start),
    relocations: entries.map((e) => ({ offset: e.offset, type: e.type, referent: referentOf(obj, e) })),
  };
}

/** The function the game holds in `section` of its own file, at `start` in that section's own coordinates
 *  (a linked image's addresses, a module's offsets — which is what its relocations are written in too). */
function heldFunction(elf: Elf32, shndx: number, start: number, length: number): FunctionBytes {
  const section = elf.sections[shndx];
  const at = section.offset + start - section.addr;
  return {
    bytes: elf.bytes.subarray(at, at + length),
    mask: [],
    relocations: relocationsFor(elf, shndx, start, length),
  };
}

/** The digest of an object's function: its mask, then its bytes under that mask.
 *
 *  It covers the CODE alone — not what the relocations point at — so it answers "the target built here is
 *  the one proved against the game" for everything the linker does not write, and the proof itself
 *  (`compareWithRom`) is what covers the referents. */
function digestOf(fn: FunctionBytes): string {
  return createHash('sha256')
    .update(Buffer.from(fn.mask))
    .update(Buffer.from(fn.bytes.map((b, i) => b & fn.mask[i])))
    .digest('hex');
}

export type RomComparison = { equal: true; digest: string } | { equal: false; detail: string };

/** Compare function `sym` of a relocatable object with the function at `addr` in the linked ELF. A tail of up
 *  to 3 zero bytes on either side is alignment padding. When they are equal, `digest` is the object's
 *  `targetDigest`. */
export function compareWithRom(object: Buffer, sym: string, linked: Buffer, addr: number): RomComparison {
  const fn = objectFunction(object, sym);
  if (fn === undefined) {
    return { equal: false, detail: `the object defines no ${sym}` };
  }
  const rom = readElf32(linked, 'the linked ELF');
  const atAddr = rom.symbols.filter((s) => s.type === STT_FUNC && codeAddress(rom, s.value) === addr);
  const named = atAddr.filter((s) => s.name === sym);
  const candidates = named.length > 0 ? named : atAddr;
  const size = Math.max(0, ...candidates.map((s) => s.size));
  const romEnd = size > 0 ? addr + size : nextLabel(rom, addr, undefined);
  if (romEnd === undefined) {
    return { equal: false, detail: `the linked ELF has no function at 0x${addr.toString(16)}` };
  }
  const holder = candidates.length > 0 ? rom.sections[candidates[0].shndx] : undefined;
  const inSection = (s: Section) => s.addr <= addr && romEnd <= s.addr + s.size && (s.flags & SHF_ALLOC) !== 0;
  const romSection =
    holder !== undefined && inSection(holder)
      ? holder
      : rom.sections.find((s) => s.type === SHT_PROGBITS && (s.flags & SHF_EXECINSTR) !== 0 && inSection(s));
  if (romSection === undefined) {
    return { equal: false, detail: `the linked ELF holds no bytes at 0x${addr.toString(16)}` };
  }
  return compareMasked(fn, heldFunction(rom, rom.sections.indexOf(romSection), addr, romEnd - addr));
}

/** An object's function against the function the game holds: its bytes with every relocated bit left out,
 *  and then what those relocations point at. A tail of up to 3 zero bytes on either side is alignment
 *  padding. */
function compareMasked(fn: FunctionBytes, held: FunctionBytes): RomComparison {
  const objBytes = fn.bytes;
  const n = Math.min(objBytes.length, held.bytes.length);
  for (let i = 0; i < n; i++) {
    if ((objBytes[i] & fn.mask[i]) !== (held.bytes[i] & fn.mask[i])) {
      return {
        equal: false,
        detail: `object ${objBytes.length} B, ROM ${held.bytes.length} B, first difference at +0x${i.toString(16)}`,
      };
    }
  }
  const tail = objBytes.length > n ? objBytes.subarray(n) : held.bytes.subarray(n);
  if (tail.length > 0 && !(tail.length < 4 && tail.every((b) => b === 0))) {
    return {
      equal: false,
      detail: `object ${objBytes.length} B, ROM ${held.bytes.length} B, equal over the shorter`,
    };
  }
  const points = comparePointedAt(fn.relocations ?? [], held.relocations);
  return points === null ? { equal: true, digest: digestOf(fn) } : { equal: false, detail: points };
}

/** The two functions' relocations, one for one: same field, same symbol, same data behind it. The reason
 *  it runs at all is that the byte comparison above SKIPS every relocated field, so this is the only place
 *  a target that names another global, or points at another literal, is caught.
 *
 *  Returns the difference, or null when there is none — and null, too, when the game's file keeps no
 *  relocations over the function: every dtk project's partially linked ELF and every REL module carries
 *  its own, a fully linked image (the ARM and MIPS projects here) resolved and dropped them, and for those
 *  the proof stays what it was, the code alone. */
function comparePointedAt(object: readonly Relocation[], held: readonly Relocation[] | undefined): string | null {
  if (held === undefined) {
    return null;
  }
  if (object.length !== held.length) {
    return `object relocates ${object.length} field(s), ROM ${held.length}`;
  }
  const label = (r: Relocation) => `type ${r.type} at +0x${r.offset.toString(16)}`;
  const names = (r: Referent) => `${r.name}${r.addend === 0 ? '' : `+0x${r.addend.toString(16)}`}`;
  const shape = (r: Referent) => `a local ${r.section ?? 'undefined'} datum of ${r.size ?? 0} B`;
  for (const [i, a] of object.entries()) {
    const b = held[i];
    if (a.offset !== b.offset || a.type !== b.type) {
      return `object relocates ${label(a)}, ROM ${label(b)}`;
    }
    const [x, y] = [a.referent, b.referent];
    if (x.sectionSymbol || y.sectionSymbol) {
      continue;
    }
    const [nx, ny] = [comparableName(x), comparableName(y)];
    const anonymous = nx === undefined && ny === undefined;
    if (x.addend !== y.addend || (!anonymous && nx !== ny)) {
      return `${label(a)} names ${names(x)}, ROM ${names(y)}`;
    }
    if (x.data !== undefined && y.data !== undefined) {
      // Over the SHORTER of the two: a symbol whose file gives it no size is measured up to the next
      // symbol, and the two files hold different amounts of the unit. Under BOTH masks: a field either
      // side relocates is one only a linker knows, so neither file states its value.
      const at = firstDifference(x.data, y.data, Math.min(x.data.length, y.data.length), x.dataMask, y.dataMask);
      if (at >= 0) {
        return `${label(a)} points at ${anonymous ? shape(x) : names(x)}, whose data differs from ROM's at +0x${at.toString(16)}`;
      }
    } else if (anonymous && (x.section !== y.section || x.size !== y.size)) {
      return `${label(a)} points at ${shape(x)}, ROM ${shape(y)}`;
    }
  }
  return null;
}

/** The part of a referent's name that is a fact about the game, or undefined where none of it is: the
 *  number CodeWarrior gave a file-local literal pool (`@1135`) or function static (`sprHideTbl$797`)
 *  belongs to the translation unit, not to the datum. `@` and `$` cannot appear in a C identifier, so
 *  no name the source wrote is mistaken for one of those. */
const comparableName = (r: Referent): string | undefined => {
  if (!r.local) {
    return r.name;
  }
  if (/^@\d+$/.test(r.name)) {
    return undefined;
  }
  const numbered = /^(.+)\$\d+$/.exec(r.name);
  return numbered === null ? r.name : numbered[1];
};

/** Where two buffers first differ over their first `n` bytes, or -1 — comparing only the bits both
 *  masks leave, where masks are given. */
const firstDifference = (x: Buffer, y: Buffer, n: number, mx?: number[], my?: number[]): number => {
  for (let i = 0; i < n; i++) {
    const keep = (mx?.[i] ?? 0xff) & (my?.[i] ?? 0xff);
    if ((x[i] & keep) !== (y[i] & keep)) {
      return i;
    }
  }
  return -1;
};

/** Where the ROM gate reads a row's function: the ELF holding the game's bytes for it, and the
 *  address they sit at in that ELF.
 *
 *  A row with a linked address is read out of the project's linked ELF at that address. A row keyed
 *  by a REL MODULE LOCATION is read out of its MODULE's ELF — the `.plf` the project's build links
 *  the module from and turns into the disc's `.rel`, which is to a module what the linked ELF is to
 *  the DOL — PLACED (cli/module-elf `placeModuleSections`), so that its section sits at an address
 *  of its own and the function at that address plus its offset. The module's bytes are unrelocated
 *  there, which is no obstacle: so are the object's, and every relocated field is masked on both
 *  sides by the object's own relocations.
 *
 *  `placedModule` hands back a module's placed ELF; a caller reading many rows of one module
 *  places it once. */
export function romLocation(
  addr: string,
  linked: Buffer,
  placedModule: (module: string) => Buffer,
): { elf: Buffer; at: number } {
  const loc = moduleLocation(addr);
  if (loc === undefined) {
    return { elf: linked, at: Number.parseInt(addr, 16) };
  }
  const elf = placedModule(loc.module);
  return { elf, at: placedSectionAddress(elf, loc.section) + loc.offset };
}

/** The digest of function `sym` in a relocatable object, the value `compareWithRom` records for a target it
 *  proves. Throws when the object does not define `sym`. */
export function targetDigest(object: Buffer, sym: string): string {
  const fn = objectFunction(object, sym);
  if (fn === undefined) {
    throw new Error(`the object defines no ${sym}`);
  }
  return digestOf(fn);
}
