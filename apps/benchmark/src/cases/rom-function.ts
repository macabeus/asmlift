// Is a compiled function the function the game contains? The ROM gate reads the function's bytes out of
// a relocatable object and out of the project's linked ELF, and compares them with every relocated field
// masked: a relocation's value is only known once the object is linked, and the linked ELF holds it
// resolved. The rest of the function, instructions and literal pools included, must be byte-equal.
//
// ELF32 only, ARM and MIPS: the machines the real tier builds for.

const SHT_RELA = 4;
const SHT_REL = 9;
const SHT_PROGBITS = 1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHN_LORESERVE = 0xff00;
const STT_NOTYPE = 0;
const STT_FUNC = 2;
const EM_MIPS = 8;
const EM_ARM = 40;

interface Section {
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
  const sections: Section[] = [];
  for (let i = 0, n = u16(0x30); i < n; i++) {
    const sh = shoff + i * shentsize;
    sections.push({
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

/** Per byte of `[start, start + length)` of section `shndx`: which bits the relocations leave compared. */
function relocationMask(elf: Elf32, shndx: number, start: number, length: number): number[] {
  const mask = new Array<number>(length).fill(0xff);
  const u32 = (o: number) => (elf.littleEndian ? elf.bytes.readUInt32LE(o) : elf.bytes.readUInt32BE(o));
  const clear = (at: number, fieldBytes: number, keep: number) => {
    for (let k = 0; k < fieldBytes; k++) {
      const byteOfField = elf.littleEndian ? k : fieldBytes - 1 - k;
      const idx = at + k;
      if (idx >= 0 && idx < length) {
        mask[idx] &= (keep >>> (8 * byteOfField)) & 0xff;
      }
    }
  };
  for (const rel of elf.sections.filter((s) => (s.type === SHT_REL || s.type === SHT_RELA) && s.info === shndx)) {
    const entsize = rel.type === SHT_REL ? 8 : 12;
    for (let at = rel.offset; at + entsize <= rel.offset + rel.size; at += entsize) {
      const offset = u32(at) - start;
      const type = u32(at + 4) & 0xff;
      if (elf.machine === EM_ARM) {
        // R_ARM_THM_JUMP11 and R_ARM_THM_JUMP8 patch one 16-bit instruction, every other type 4 bytes
        clear(offset, type === 102 || type === 103 ? 2 : 4, 0);
      } else if (elf.machine === EM_MIPS) {
        // R_MIPS_26 fills the jump target and keeps the opcode; HI16, LO16 and GPREL16 fill the immediate
        clear(offset, 4, type === 4 ? 0xfc000000 : type === 5 || type === 6 || type === 7 ? 0xffff0000 : 0);
      } else {
        throw new Error(`no relocation mask for ELF machine ${elf.machine}`);
      }
    }
  }
  return mask;
}

export type RomComparison = { equal: true; length: number } | { equal: false; detail: string };

/** Compare function `sym` of a relocatable object with the function at `addr` in the linked ELF. A tail
 *  of up to 3 zero bytes on either side is alignment padding. */
export function compareWithRom(object: Buffer, sym: string, linked: Buffer, addr: number): RomComparison {
  const obj = readElf32(object, 'the object');
  const rom = readElf32(linked, 'the linked ELF');
  const defined = obj.symbols.find((s) => s.name === sym && isCodeLabel(s));
  if (defined === undefined) {
    return { equal: false, detail: `the object defines no ${sym}` };
  }
  const section = obj.sections[defined.shndx];
  const start = codeAddress(obj, defined.value);
  const end = defined.size > 0 ? start + defined.size : (nextLabel(obj, start, defined.shndx) ?? section.size);
  const objBytes = obj.bytes.subarray(section.offset + start, section.offset + end);

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
  const romBytes = rom.bytes.subarray(
    romSection.offset + addr - romSection.addr,
    romSection.offset + romEnd - romSection.addr,
  );

  const n = Math.min(objBytes.length, romBytes.length);
  const mask = relocationMask(obj, defined.shndx, start, n);
  for (let i = 0; i < n; i++) {
    if ((objBytes[i] & mask[i]) !== (romBytes[i] & mask[i])) {
      return {
        equal: false,
        detail: `object ${objBytes.length} B, ROM ${romBytes.length} B, first difference at +0x${i.toString(16)}`,
      };
    }
  }
  const tail = objBytes.length > n ? objBytes.subarray(n) : romBytes.subarray(n);
  if (tail.length === 0 || (tail.length < 4 && tail.every((b) => b === 0))) {
    return { equal: true, length: n };
  }
  return { equal: false, detail: `object ${objBytes.length} B, ROM ${romBytes.length} B, equal over the shorter` };
}
