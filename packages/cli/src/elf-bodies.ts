// asmlift — the bodies of guessed callees that the input does not hold, read off the project's
// linked ELF (`tools.asmlift.elf`).
//
// A callee nobody declared is called at a guessed arity, and where its body is in the input the
// body bounds what it can read (core frontend/callee-body.ts). A unit's assembly holds only its own
// functions, though, and the linked ELF holds every one: this reads a guessed callee's range there
// and hands the core what it reads as that callee's body.
//
// A RANGE IS A DEFINITION THE LINK KEPT, OR NOTHING. A callee is read only where exactly one
// symbol of its name is defined, in a code section, and that symbol is a non-weak FUNC: a weak one
// is the definition a link MAY keep, and the binding is exactly what an objdump listing does not
// show (callee-body.ts KNOWN GAP). Its range is `[value, value + size)`; a FUNC of size 0 (hand
// written assembly declares no `.size`: 77 of kleod's 562 FUNCs) runs to the next symbol of any
// kind in its section, mapping symbols included, and with nothing after it in its section there is
// no range and no body.
//
// What the range is read as is the target's: where the frontend reads objdump text (MIPS and
// PowerPC, objfile.ts `readsObjdumpText`) it is disassembled with the target's own objdump, in the
// section the symbol names (objfile.ts `disasmRange`: overlays put several sections at one address).
// The agbcc frontend reads no objdump text, so a Thumb range of an ARM image is read for one shape
// alone: an interworking veneer, a word-aligned Thumb entry of `bx pc; nop` whose ARM word after it
// is an unconditional `b` (core frontend/arm-body.ts `thumbToArmVeneerTarget`). The ARM words the `b` reaches are handed in as
// the body, and the core scans them; any other Thumb range gives no body.
//
// A RANGE IS ONE BODY, WHATEVER SYMBOLS SIT INSIDE IT. objdump starts a `<name>:` header at every
// symbol in a range (mp3's `*_VRAM_END` inside func_8010EC38_25B288_rockin_raceway, af's `.L800F29C8`,
// the SDK's `__RAS_OSDisableInterrupts_end`), and the frontend slices a listing at its next header,
// which would cut the callee's body there. Every header but the callee's own is dropped: branch
// targets are read by address, never by a header's name.
//
// A RANGE'S CALLS ARE NAMED BY THE IMAGE'S OWN SYMBOLS. The MIPS and PowerPC frontends name a callee
// only by its relocation, and a linked image carries none, so a listing body making any call would
// not lift. Each direct call in the range (objfile.ts `callRelocationOf`: MIPS `jal`, PowerPC `bl`)
// whose target is the value of exactly one FUNC symbol, in the callee's own section where that
// holds the address and in the one code section that does otherwise (overlays put several at one
// address), and whose name no other symbol defines, gets the relocation an object would carry for
// it: as a relocation line under it where the frontend reads them in the listing (PowerPC), and in
// the body's side table otherwise (MIPS, `CalleeBody.relocs`, against `.text`: the one code section
// a frontend reads an object's relocations for, and the listing is one). A name is never guessed: a
// wrong one would lay the call out by another function's declaration, so a target with no such
// symbol is left unnamed, and the body does not lift. Naming a call only lets the body lift: the
// core takes every call in it that nothing declares at every argument register (callee-body.ts).
// A jump is never named (a `j`/`b` to the callee's own entry is a loop's back edge), so a body that
// tail-calls still proves nothing. An image linked keeping its relocations already prints them
// (marioparty4's and pikmin's main.elf: every `bl` carries its `R_PPC_REL24`), and is read as it is.
//
// KNOWN GAP: a function in a REL module (`--module`) is read from no ELF: the module's own ELF is
// relocatable, its sections all placed at 0, so its symbol values are no addresses to disassemble.
import { thumbToArmVeneerTarget } from '@asmlift/core/frontend/arm-body';
import type { Reloc } from '@asmlift/core/frontend/asmdata';
import { type CalleeBodies, type CalleeBody, definesLabel } from '@asmlift/core/frontend/callee-body';
import type { Prototypes } from '@asmlift/core/proto';
import type { SymbolMap } from '@asmlift/core/symbols';
import type { TargetDescription } from '@asmlift/core/target';

import { calleeNames, guessedArityCallees } from './callees';
import { type Elf32, isCode, readElf32 } from './elf-section';
import { type CallRelocation, callRelocationOf, readsObjdumpText } from './objfile';

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

/** THE CALLEES WHOSE BODIES A LIFT OF `self` IS HANDED OUT OF THE LINKED ELF: those whose arity it
 *  guesses (`guessedArityCallees`, read at the prototypes and the map the lift reads) that the input
 *  does not define (`definesLabel`: a body in the input answers for itself), and none at all for a
 *  function in a REL module (`module`, the header's KNOWN GAP).
 *
 *  ONE RULE, TWO READERS: the CLI reads these bodies off `tools.asmlift.elf` (main.ts), and the
 *  benchmark harness hands the same subset of the bodies `bench vendor` froze (apps/benchmark
 *  cases/callee-bodies.ts `selectCalleeBodies`). Spelled twice, a change to the guess would move what
 *  `bench repro` prints and leave the published row where it was. */
export function elfBodyCallees(
  asm: string,
  self: string,
  target: TargetDescription,
  prototypes: Prototypes | undefined,
  symbols: SymbolMap | undefined,
  relocs: readonly Reloc[] | undefined,
  module: string | undefined,
): string[] {
  if (module !== undefined) {
    return [];
  }
  return guessedArityCallees(asm, self, target, prototypes, symbols, relocs).filter((c) => !definesLabel(asm, c));
}

/** Every direct callee of `self` the input does not define: the callees {@link elfBodyCallees} can
 *  ever select, whatever the prototypes and the map say. What a reader that freezes the ELF's bodies
 *  ahead of the lift reads (apps/benchmark `bench vendor`), so the frozen set does not depend on
 *  which callees today's declarations leave guessed. */
export function elfBodyCandidates(asm: string, self: string, relocs: readonly Reloc[] | undefined): string[] {
  return calleeNames(asm, self, relocs).filter((c) => !definesLabel(asm, c));
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
  /** that section's name, which a disassembly of the range is scoped to */
  section: string;
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
  return {
    start,
    end,
    shndx: f.shndx,
    section: sectionName(image.elf, f.shndx),
    thumb: image.arm && (f.value & 1) === 1,
  };
}

/** Section `index`'s name, out of the section-name string table. */
function sectionName(elf: Elf32, index: number): string {
  const names = elf.sections[elf.shstrndx];
  const at = names === undefined ? -1 : names.offset + elf.sections[index].name;
  const end = at < 0 ? -1 : elf.bytes.indexOf(0, at);
  return at < 0 || end < 0 ? '' : elf.bytes.toString('latin1', at, end);
}

/** Disassembles `[start, stop)` of section `section` of the ELF at a path with the target's
 *  objdump, as the frontend reads it (objfile.ts `disasmRange`): the seam the offline tests fake. */
export type RangeDisasm = (
  elfPath: string,
  target: TargetDescription,
  section: string,
  start: number,
  stop: number,
) => string;

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
    if (!readsObjdumpText(target)) {
      const words = range.thumb ? veneeredArmWords(image, range) : undefined;
      if (words !== undefined) {
        bodies[callee] = { kind: 'arm', words };
      }
      continue;
    }
    if (range.section === '') {
      continue;
    }
    try {
      const listing = withOnlyHeaderOf(disasm(elfPath, target, range.section, range.start, range.end), callee);
      const call = callRelocationOf(target);
      bodies[callee] =
        call === undefined ? { kind: 'listing', text: listing } : withNamedCalls(listing, image, range, call);
    } catch (e) {
      warnings.push(
        `asmlift: warning: cannot disassemble ${callee} out of tools.asmlift.elf (${e instanceof Error ? e.message : e}) — its arity stays guessed\n`,
      );
    }
  }
  return { bodies, warnings };
}

/** `listing` with every objdump `<name>:` header line but `callee`'s own dropped (see the header). */
export function withOnlyHeaderOf(listing: string, callee: string): string {
  return listing
    .split('\n')
    .filter((l) => {
      const m = /^[0-9a-fA-F]+\s+<(.+)>:\s*$/.exec(l);
      return m === null || m[1] === callee;
    })
    .join('\n');
}

/** `listing` as a body whose calls are named (see the header): each `call.mnemonic` to an address
 *  `calleeAt` names gets its relocation. A listing that already prints relocations (an image linked
 *  with `--emit-relocs`) is handed in as it is. */
export function withNamedCalls(
  listing: string,
  image: ElfImage,
  range: FunctionRange,
  call: CallRelocation,
): CalleeBody {
  if (/^\s+[0-9a-fA-F]+:\s+R_\w+/m.test(listing)) {
    return { kind: 'listing', text: listing };
  }
  const site = new RegExp(`^\\s*([0-9a-fA-F]+):\\s+${call.mnemonic}\\s+([0-9a-fA-F]+)\\b`);
  const lines: string[] = [];
  const relocs: Reloc[] = [];
  for (const line of listing.split('\n')) {
    lines.push(line);
    const m = site.exec(line);
    const name = m === null ? undefined : calleeAt(image, range, parseInt(m[2], 16));
    if (m === null || name === undefined) {
      continue;
    }
    if (call.inListing) {
      lines.push(`\t\t\t${m[1]}: ${call.type}\t${name}`);
    } else {
      relocs.push({ section: '.text', offset: parseInt(m[1], 16), type: call.type, sym: name, addend: 0 });
    }
  }
  const text = lines.join('\n');
  return relocs.length === 0 ? { kind: 'listing', text } : { kind: 'listing', text, relocs };
}

/** The one name a call from `range` to `addr` enters (see the header), or undefined. */
export function calleeAt(image: ElfImage, range: FunctionRange, addr: number): string | undefined {
  const holding = image.elf.sections.flatMap((s, i) =>
    isCode(s) && s.addr <= addr && addr < s.addr + s.size ? [i] : [],
  );
  const shndx = holding.includes(range.shndx) ? range.shndx : holding.length === 1 ? holding[0] : undefined;
  const names = new Set(
    image.symbols.filter((s) => s.shndx === shndx && s.type === STT_FUNC && s.value === addr).map((s) => s.name),
  );
  if (shndx === undefined || names.size !== 1) {
    return undefined;
  }
  const [name] = names;
  const defined = image.symbols.filter((s) => s.name === name && definedInSection(s));
  return /^[^\s+.-][^\s+-]*$/.test(name) && defined.length === 1 ? name : undefined;
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
