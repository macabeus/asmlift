// asmlift — the ELF32 facts a REL module's symbol map needs, read and rewritten in raw bytes.
//
// A GameCube REL module builds to a `<module>.plf`: a RELOCATABLE ELF whose allocated sections ALL
// start at address 0, because a module is placed by the game's loader, not by the linker. Every
// symbol value in one is therefore an offset into its OWN section, so a map keyed by address puts
// `.text`'s first function, `.data`'s first word and `.bss`'s first variable at 0x0 together. That
// is a silent wrong answer — the map still loads, and every lookup at a colliding address answers
// with whichever alias sorted first — so {@link assertPlaced} refuses such a file outright, and
// {@link placeModuleSections} is the one way to read it: give each section a base of its own, then
// let the ordinary reader run unchanged.
//
// This file works on bytes rather than through @gba-kit/debug-info because neither fact it needs is
// in that package's surface: a symbol's SECTION (which base its value belongs to) and its BINDING
// (which of a base ELF's symbols a module may be unioned with).
import { basename, dirname, extname, join } from 'node:path';

const ELF_MAGIC = 0x7f454c46;
const ELFCLASS32 = 1;
const ET_REL = 1;
const SHT_SYMTAB = 2;
const SHT_RELA = 4;
const SHT_REL = 9;
const SHF_ALLOC = 0x2;
const STB_GLOBAL = 1;
const STT_FUNC = 2;
const SHN_UNDEF = 0;
/** the first non-section `st_shndx` value (SHN_ABS, SHN_COMMON, …) — never a placeable section */
const SHN_LORESERVE = 0xff00;
const SYMENT = 16; // Elf32_Sym

/** Bases are handed out on this stride, so a placed address reads as section · offset. A section
 *  larger than the stride simply takes the next multiple — the invariant is that no two sections
 *  overlap, never that the stride divides the base.
 *
 *  Exported because it is the only thing that makes a PLACED address readable: every base is a
 *  multiple of it, so `placed % PLACEMENT_STRIDE` is the symbol's offset in its own section as long
 *  as no section is larger than the stride. The largest allocated section measured over both
 *  GameCube checkouts is Animal Crossing `foresta.plf`'s `.data` at 11,400,440 B — a margin of
 *  1.47×, not a comfortable one (Mario Party 4's largest, `m450Dll.plf`'s `.text` at 170,428 B, is
 *  the figure to quote only for Mario Party 4). A section that does outgrow the stride takes the
 *  next multiple, so the readback then answers a WRONG offset rather than a colliding address, and
 *  the benchmark's `addr` gate fails the row instead of admitting it. A reader that must relate a
 *  module map's keys back to a module location — that gate — needs this. */
export const PLACEMENT_STRIDE = 0x0100_0000;
/** Placement has to stay inside a 32-bit address; a module needing more sections than this has
 *  outgrown the scheme and gets an error rather than a wrapped address. */
const LIMIT = 0xff00_0000;

interface Section {
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  /** the section this one applies to — which section a relocation table relocates */
  info: number;
  /** byte offset of this section HEADER, so a field can be written back */
  at: number;
}

interface Elf32 {
  buf: Buffer;
  littleEndian: boolean;
  type: number;
  sections: Section[];
}

/** An ELF32 image's header and section table, or undefined for anything else — a non-ELF, an
 *  ELF64, a truncated file. Undefined rather than a throw because @gba-kit/debug-info parses the
 *  same bytes right after and already reports exactly what is wrong with them; two readers
 *  competing to name the same defect would just make the message depend on call order. */
function readElf32(bytes: Uint8Array): Elf32 | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 52 || buf.readUInt32BE(0) !== ELF_MAGIC || buf[4] !== ELFCLASS32) {
    return undefined;
  }
  const littleEndian = buf[5] === 1;
  const u16 = (o: number) => (littleEndian ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const shoff = u32(0x20);
  const shentsize = u16(0x2e);
  const shnum = u16(0x30);
  const shstrndx = u16(0x32);
  if (shoff === 0 || shentsize < 40 || shoff + shnum * shentsize > buf.length) {
    return undefined;
  }
  const header = (i: number) => {
    const at = shoff + i * shentsize;
    return { at, nameAt: u32(at), type: u32(at + 4), flags: u32(at + 8), addr: u32(at + 12) };
  };
  const strings = shstrndx < shnum ? u32(shoff + shstrndx * shentsize + 16) : 0;
  const cstr = (at: number): string => {
    const end = buf.indexOf(0, at);
    return at === 0 || at >= buf.length ? '' : buf.toString('latin1', at, end === -1 ? buf.length : end);
  };
  const sections: Section[] = [];
  for (let i = 0; i < shnum; i++) {
    const h = header(i);
    sections.push({
      name: cstr(strings + h.nameAt),
      type: h.type,
      flags: h.flags,
      addr: h.addr,
      offset: u32(h.at + 16),
      size: u32(h.at + 20),
      link: u32(h.at + 24),
      info: u32(h.at + 28),
      at: h.at,
    });
  }
  return { buf, littleEndian, type: u16(0x10), sections };
}

/** WHERE A MODULE'S ELF IS, given the base ELF beside it: dtk writes each module at
 *  `<directory of the base ELF>/<module>/<module>.plf`, and that layout is the whole location
 *  rule — a project's decomp.yaml says nothing about its modules.
 *
 *  Undefined when `module` names the BASE ELF itself. dtk gives the DOL's units a prefix too
 *  (`main/`, `static/`), and the base ELF is named after it, so that prefix is a module name a
 *  caller may hold; it selects the base ELF, which IS its own symbol source.
 *
 *  One rule, one home: the CLI's `--module` and the benchmark's REL rows resolve the same module
 *  through this, so a project laid out one way cannot answer them differently. */
export function moduleElfPath(baseElfPath: string, module: string): string | undefined {
  return module === basename(baseElfPath, extname(baseElfPath))
    ? undefined
    : join(dirname(baseElfPath), module, `${module}.plf`);
}

/** Allocated sections that hold something. An EMPTY allocated section also sits at 0 in a `.plf`,
 *  but it can hold no symbol, so it neither collides nor needs a base. */
const placeable = (elf: Elf32): Section[] => elf.sections.filter((s) => (s.flags & SHF_ALLOC) !== 0 && s.size > 0);

/** Refuse an UNPLACED relocatable ELF: one whose allocated sections share an address, so its symbol
 *  values are section-relative and a map keyed by address is a pile of collisions. This is what
 *  naming a `<module>.plf` as `tools.asmlift.elf` does — 99 of Mario Party 4's 99 modules, whose
 *  maps would carry 2,393 colliding addresses between them, with no warning to read.
 *
 *  A relocatable object with ONE allocated section is accepted: nothing can collide with it, and
 *  its values then read as ordinary addresses. */
export function assertPlaced(bytes: Uint8Array, elfPath: string): void {
  const elf = readElf32(bytes);
  if (!elf || elf.type !== ET_REL) {
    return;
  }
  const byAddress = new Map<number, string[]>();
  for (const s of placeable(elf)) {
    byAddress.set(s.addr, [...(byAddress.get(s.addr) ?? []), s.name]);
  }
  const collision = [...byAddress].find(([, names]) => names.length > 1);
  if (collision) {
    const [addr, names] = collision;
    throw new Error(
      `cannot build a symbol map from ${elfPath}: it is a RELOCATABLE ELF whose allocated sections ` +
        `${names.join('/')} all sit at 0x${addr.toString(16)}, so every symbol value is an offset into its own ` +
        `section and symbols of different sections collide at one address. A REL module's map is built from the ` +
        `module (pass --module <name>, which places its sections), not by naming its .plf as tools.asmlift.elf.`,
    );
  }
}

/** A copy of a module ELF with every allocated section given a base of its own, and every
 *  SECTION-RELATIVE coordinate rebased into it — symbol values and relocation offsets alike. The
 *  ordinary reader then sees an ordinary ELF: distinct addresses, one symbol per section offset, a
 *  function's relocations where the function is, and {@link assertPlaced} satisfied by construction.
 *
 *  The bases are synthetic — a REL module has no link-time address, and the game's loader picks a
 *  different one every run — so they are chosen only to be injective and readable, not to be where
 *  the module will live. */
export function placeModuleSections(bytes: Uint8Array, elfPath: string): Buffer {
  const elf = readElf32(bytes);
  if (!elf || elf.type !== ET_REL) {
    throw new Error(
      `cannot place ${elfPath}: a module ELF is a RELOCATABLE ELF32 (a dtk build writes one as <module>/<module>.plf)`,
    );
  }
  const out = Buffer.from(elf.buf); // never write through the caller's bytes
  const { littleEndian } = elf;
  const u32 = (o: number) => (littleEndian ? out.readUInt32LE(o) : out.readUInt32BE(o));
  const put32 = (o: number, v: number) =>
    littleEndian ? out.writeUInt32LE(v >>> 0, o) : out.writeUInt32BE(v >>> 0, o);
  const u16 = (o: number) => (littleEndian ? out.readUInt16LE(o) : out.readUInt16BE(o));

  const base = new Map<number, number>();
  let next = PLACEMENT_STRIDE;
  elf.sections.forEach((s, i) => {
    if ((s.flags & SHF_ALLOC) === 0 || s.size === 0) {
      return;
    }
    if (next >= LIMIT) {
      throw new Error(`cannot place ${elfPath}: its allocated sections do not fit in a 32-bit address space`);
    }
    base.set(i, next);
    put32(s.at + 12, next); // sh_addr
    next = Math.ceil((next + s.size) / PLACEMENT_STRIDE) * PLACEMENT_STRIDE;
  });

  for (const s of elf.sections) {
    if (s.type === SHT_SYMTAB) {
      for (let at = s.offset; at + SYMENT <= s.offset + s.size; at += SYMENT) {
        const shndx = u16(at + 14);
        const at32 = base.get(shndx);
        if (shndx !== SHN_UNDEF && shndx < SHN_LORESERVE && at32 !== undefined) {
          put32(at + 4, u32(at + 4) + at32); // st_value
        }
      }
      continue;
    }
    // A RELOCATION'S OFFSET IS WRITTEN IN THE SAME COORDINATES AS A SYMBOL'S VALUE — its section's, which
    // placement has just moved. Leave it and the file contradicts itself: a reader that finds a function at
    // its placed address finds no relocations over it, because they still sit at their section-relative
    // offsets. That is a silent answer of "this function relocates nothing", which is what a fully linked
    // image looks like, so a caller comparing what a function's relocations point at compares none of them.
    const at32 = base.get(s.info);
    if ((s.type !== SHT_REL && s.type !== SHT_RELA) || at32 === undefined) {
      continue;
    }
    const entsize = s.type === SHT_REL ? 8 : 12;
    for (let at = s.offset; at + entsize <= s.offset + s.size; at += entsize) {
      put32(at, u32(at) + at32); // r_offset
    }
  }
  return out;
}

/** Where a module ELF placed by {@link placeModuleSections} put the section `name`: the address a
 *  `<module>:<section>+0x<offset>` location reads as in that copy, less its offset. Throws for a
 *  section the module does not hold, or holds more than once — either way the location names no
 *  one place.
 *
 *  This is what lets a REL function be read like a linked one: placed, the module's own bytes sit
 *  at `base + offset` with its symbols beside them, exactly the shape a linked ELF has. */
export function placedSectionAddress(placed: Uint8Array, name: string): number {
  const elf = readElf32(placed);
  const found = elf === undefined ? [] : placeable(elf).filter((s) => s.name === name);
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? `the module ELF has no allocated section ${name}`
        : `the module ELF has ${found.length} allocated sections named ${name}`,
    );
  }
  return found[0].addr;
}

/** How a symbol is identified across the two readers here: the name it is known by and the address
 *  the map keys it at. FUNC values carry a Thumb low bit that @gba-kit/debug-info clears, and the
 *  map is keyed by what that reader produced, so the same normalization has to happen here. */
export const symbolKey = (name: string, address: number): string => `${(address >>> 0).toString(16)}\0${name}`;

/** Where a module ELF puts a FUNCTION: the section that holds it and its offset within that
 *  section — the two halves of a `<module>:<section>+0x<offset>` row identity that a symbol MAP
 *  cannot answer, because placement records a section INDEX and not a name.
 *
 *  Read straight off the UNPLACED `.plf`, where every allocated section sits at 0 and so every
 *  `st_value` already IS the section-relative offset. A name maps to a LIST: Animal Crossing's
 *  `foresta` holds 659 names at more than one `.text` offset (of 16,051), which is exactly why the
 *  offset is part of the identity and the name is not.
 *
 *  Empty for anything that is not a relocatable ELF32 — the caller names the file. */
export function moduleFunctionLocations(bytes: Uint8Array): Map<string, { section: string; offset: number }[]> {
  const out = new Map<string, { section: string; offset: number }[]>();
  const elf = readElf32(bytes);
  if (!elf || elf.type !== ET_REL) {
    return out;
  }
  const { buf, littleEndian } = elf;
  const u32 = (o: number) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u16 = (o: number) => (littleEndian ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  for (const s of elf.sections) {
    if (s.type !== SHT_SYMTAB) {
      continue;
    }
    const strings = elf.sections[s.link]?.offset ?? 0;
    for (let at = s.offset; at + SYMENT <= s.offset + s.size; at += SYMENT) {
      const info = buf[at + 12];
      if ((info & 0xf) !== STT_FUNC) {
        continue;
      }
      const shndx = u16(at + 14);
      const section = elf.sections[shndx];
      if (shndx === SHN_UNDEF || shndx >= SHN_LORESERVE || section === undefined) {
        continue;
      }
      if ((section.flags & SHF_ALLOC) === 0) {
        continue;
      }
      const nameAt = strings + u32(at);
      const end = buf.indexOf(0, nameAt);
      const name = buf.toString('latin1', nameAt, end === -1 ? buf.length : end);
      if (name === '') {
        continue;
      }
      out.set(name, [...(out.get(name) ?? []), { section: section.name, offset: u32(at + 4) }]);
    }
  }
  return out;
}

/** The {@link symbolKey}s of an ELF's GLOBAL-binding symbols: the ones another object may refer to,
 *  and so the only ones a module's map inherits from the base ELF it links against.
 *
 *  Per SYMBOL, never per name: a DOL carries names held by a global function and a file-static
 *  object at once (`seqSpeed` in Mario Party 4), and a name-keyed filter either keeps the static or
 *  drops the global. */
export function globalSymbolKeys(bytes: Uint8Array): Set<string> {
  const elf = readElf32(bytes);
  const keys = new Set<string>();
  if (!elf) {
    return keys;
  }
  const { buf, littleEndian } = elf;
  const u32 = (o: number) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  for (const s of elf.sections) {
    if (s.type !== SHT_SYMTAB) {
      continue;
    }
    const strings = elf.sections[s.link]?.offset ?? 0;
    for (let at = s.offset; at + SYMENT <= s.offset + s.size; at += SYMENT) {
      const info = buf[at + 12];
      if (info >> 4 !== STB_GLOBAL) {
        continue;
      }
      const value = u32(at + 4);
      const nameAt = strings + u32(at);
      const end = buf.indexOf(0, nameAt);
      const name = buf.toString('latin1', nameAt, end === -1 ? buf.length : end);
      if (name !== '') {
        keys.add(symbolKey(name, (info & 0xf) === STT_FUNC ? value & ~1 : value));
      }
    }
  }
  return keys;
}
