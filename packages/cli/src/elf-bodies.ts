// asmlift — the bodies of guessed callees that the input does not hold, read off the project's
// linked ELF (`tools.asmlift.elf`).
//
// A callee nobody declared is called at a guessed arity, and where its body is in the input the
// body bounds what it can read (core frontend/callee-body.ts). A unit's assembly holds only its own
// functions, though, and the linked ELF holds every one: this reads a guessed callee's range there
// and hands the core what it reads as that callee's body.
//
// A RANGE IS A DEFINITION THE LINK KEPT, OR NOTHING. A callee is read only where exactly one
// symbol of its name is defined in a code section, and that symbol is a non-weak FUNC: a weak one
// is the definition a link MAY keep, and the binding is exactly what an objdump listing does not
// show (callee-body.ts KNOWN GAP). Its range is `[value, value + size)`; a FUNC of size 0 (hand
// written assembly declares no `.size`: 77 of kleod's 562 FUNCs) runs to the next symbol of any
// kind in its section, mapping symbols included, and with nothing after it in its section there is
// no range and no body.
//
// What the range is read as is the target's: on MIPS and PowerPC it is disassembled with the
// target's own objdump, the text the frontend reads (objfile.ts `disasmRange`). The agbcc frontend
// reads no objdump text, so a Thumb range is read for one shape alone: an interworking veneer, a
// word-aligned Thumb entry of `bx pc; nop` whose ARM word after it is an unconditional `b` (core
// frontend/arm-body.ts `thumbToArmVeneerTarget`). The ARM words the `b` reaches are handed in as
// the body, and the core scans them; any other Thumb range gives no body.
//
// KNOWN GAP: a function in a REL module (`--module`) is read from no ELF: the module's own ELF is
// relocatable, its sections all placed at 0, so its symbol values are no addresses to disassemble.
import { thumbToArmVeneerTarget } from '@asmlift/core/frontend/arm-body';
import type { CalleeBodies, CalleeBody } from '@asmlift/core/frontend/callee-body';
import type { TargetDescription } from '@asmlift/core/target';

import { type Elf32, isCode, readElf32 } from './elf-section';

const SHT_SYMTAB = 2;
const SHN_UNDEF = 0;
const SHN_LORESERVE = 0xff00;
const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STT_FUNC = 2;
const SYM_ENTSIZE = 16;
/** The longest range read: a body past it is no callee whose arguments a lift should be asked. */
const MAX_RANGE = 0x10000;
/** The most ARM words handed in behind a veneer: the scan answers nothing for a body that has not
 *  returned by then. */
const MAX_ARM_WORDS = 256;

interface ElfSymbol {
  name: string;
  value: number;
  size: number;
  bind: number;
  type: number;
  shndx: number;
}

/** Every symbol of every symbol table, in the file's order. */
function elfSymbols(elf: Elf32): ElfSymbol[] {
  const { bytes, littleEndian } = elf;
  const u16 = (o: number) => (littleEndian ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
  const u32 = (o: number) => (littleEndian ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
  const out: ElfSymbol[] = [];
  for (const tab of elf.sections.filter((s) => s.type === SHT_SYMTAB)) {
    const strings = elf.sections[tab.link];
    if (strings === undefined) {
      continue;
    }
    for (let at = tab.offset + SYM_ENTSIZE; at + SYM_ENTSIZE <= tab.offset + tab.size; at += SYM_ENTSIZE) {
      const nameAt = strings.offset + u32(at);
      const nameEnd = bytes.indexOf(0, nameAt);
      out.push({
        name: bytes.toString('latin1', nameAt, nameEnd < 0 ? nameAt : nameEnd),
        value: u32(at + 4),
        size: u32(at + 8),
        bind: bytes[at + 12] >> 4,
        type: bytes[at + 12] & 0xf,
        shndx: u16(at + 14),
      });
    }
  }
  return out;
}

/** A function's bytes in the linked image: `[start, end)` in section `shndx`, and whether its
 *  symbol marks it Thumb code (an ARM FUNC's value has bit 0 set for a Thumb entry). */
export interface FunctionRange {
  start: number;
  end: number;
  shndx: number;
  thumb: boolean;
}

/** The parsed ELF and its symbols, read once for every callee asked. */
export interface ElfImage {
  elf: Elf32;
  symbols: ElfSymbol[];
  /** whether symbol values carry the Thumb bit (EM_ARM) */
  arm: boolean;
}

const EM_ARM = 40;

/** The image, or undefined for bytes this reader cannot parse. */
export function readElfImage(bytes: Uint8Array): ElfImage | undefined {
  const elf = readElf32(bytes);
  if (elf === undefined) {
    return undefined;
  }
  const machine = elf.littleEndian ? elf.bytes.readUInt16LE(0x12) : elf.bytes.readUInt16BE(0x12);
  return { elf, symbols: elfSymbols(elf), arm: machine === EM_ARM };
}

const definedInSection = (s: ElfSymbol): boolean => s.shndx !== SHN_UNDEF && s.shndx < SHN_LORESERVE;

/** The range of the one non-weak FUNC named `name`, or undefined (see the header). */
export function functionRange(image: ElfImage, name: string): FunctionRange | undefined {
  const defs = image.symbols.filter((s) => s.name === name && definedInSection(s));
  if (defs.length !== 1) {
    return undefined;
  }
  const [f] = defs;
  const section = image.elf.sections[f.shndx];
  if (
    f.type !== STT_FUNC ||
    (f.bind !== STB_GLOBAL && f.bind !== STB_LOCAL) ||
    section === undefined ||
    !isCode(section)
  ) {
    return undefined;
  }
  const at = (s: ElfSymbol): number => (image.arm && s.type === STT_FUNC ? s.value & ~1 : s.value);
  const start = at(f);
  let end: number | undefined = f.size > 0 ? start + f.size : undefined;
  if (end === undefined) {
    for (const s of image.symbols) {
      const a = at(s);
      if (s.shndx === f.shndx && a > start && (end === undefined || a < end)) {
        end = a;
      }
    }
  }
  if (end === undefined || start < section.addr || end > section.addr + section.size || end - start > MAX_RANGE) {
    return undefined;
  }
  return { start, end, shndx: f.shndx, thumb: image.arm && (f.value & 1) === 1 };
}

/** Disassembles `[start, stop)` of the ELF at a path with the target's objdump, as the frontend
 *  reads it (objfile.ts `disasmRange`): the seam the offline tests fake. */
export type RangeDisasm = (elfPath: string, target: TargetDescription, start: number, stop: number) => string;

/** What reading the ELF found: the bodies, and one line per callee whose range could not be read. */
export interface ElfBodies {
  bodies: CalleeBodies;
  warnings: string[];
}

/** The body of each callee in `callees` that the ELF defines (see the header). */
export function calleeBodiesFromElf(
  elfPath: string,
  bytes: Uint8Array,
  callees: readonly string[],
  target: TargetDescription,
  disasm: RangeDisasm,
): ElfBodies {
  const image = readElfImage(bytes);
  const bodies: Record<string, CalleeBody> = {};
  const warnings: string[] = [];
  if (image === undefined) {
    return { bodies, warnings };
  }
  for (const callee of callees) {
    const range = functionRange(image, callee);
    if (range === undefined) {
      continue;
    }
    if (target.id === 'armv4t') {
      const words = range.thumb ? veneeredArmWords(image, range) : undefined;
      if (words !== undefined) {
        bodies[callee] = { kind: 'arm', words };
      }
      continue;
    }
    try {
      bodies[callee] = { kind: 'listing', text: disasm(elfPath, target, range.start, range.end) };
    } catch (e) {
      warnings.push(
        `asmlift: warning: cannot disassemble ${callee} out of tools.asmlift.elf (${e instanceof Error ? e.message : e}) — its arity stays guessed\n`,
      );
    }
  }
  return { bodies, warnings };
}

/** The code section holding `addr`, and the file offset of that address in it. */
function codeAt(image: ElfImage, addr: number, bytes: number): number | undefined {
  const s = image.elf.sections.find((x) => isCode(x) && x.addr <= addr && addr + bytes <= x.addr + x.size);
  return s === undefined ? undefined : s.offset + (addr - s.addr);
}

/** The ARM words a Thumb veneer at `range` enters, up to the first `bx lr` or `MAX_ARM_WORDS`; undefined
 *  where the range is no veneer. */
function veneeredArmWords(image: ElfImage, range: FunctionRange): number[] | undefined {
  const { bytes, littleEndian } = image.elf;
  const u16 = (o: number) => (littleEndian ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
  const u32 = (o: number) => (littleEndian ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
  const at = range.end - range.start >= 4 ? codeAt(image, range.start, 8) : undefined;
  if (at === undefined) {
    return undefined;
  }
  const entry = thumbToArmVeneerTarget(range.start, u16(at), u16(at + 2), u32(at + 4));
  if (entry === undefined) {
    return undefined;
  }
  const words: number[] = [];
  for (let k = 0; k < MAX_ARM_WORDS; k++) {
    const o = codeAt(image, entry + 4 * k, 4);
    if (o === undefined) {
      break;
    }
    words.push(u32(o));
    if (words[k] === 0xe12fff1e) {
      break;
    }
  }
  return words;
}
