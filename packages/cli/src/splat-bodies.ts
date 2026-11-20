// asmlift — the body of a guessed Thumb callee, read off the project's own assembly where asmlift
// itself shows that text is the code the link kept.
//
// A callee the input does not hold is bounded by its body (core frontend/callee-body.ts), and
// elf-bodies.ts reads that body off the linked ELF. The MIPS and PowerPC frontends read objdump text,
// so the ELF's disassembly is a body in their own input format and bounds the argument registers. The
// agbcc frontend reads GNU as text, so a Thumb range is handed in as halfwords, and those size only
// the incoming stack words its entry loads (frontend/thumb-entry.ts): such a callee gets no register
// bound at all. A decomp project holds that text already. Its build includes one `.s` per function
// that it has not decompiled (`INCLUDE_ASM("asm/nonmatchings/<module>", <name>)`, the Splat and
// romlift convention), and the file is in the frontend's own input format.
//
// THE FILE IS A BODY ONLY WHERE ITS TEXT, AS ASMLIFT READS IT, IS THE LINKED CODE. The text may be
// stale or hand-edited, and a bound read off text that is not the linked bytes is a bound on another
// function. Nor may the proof run the project's build: its header, include chain and compile command
// are C and shell, and each can hand gas a macro under an instruction's name (`.macro movs rd, imm` /
// `adds \rd, \imm`) that the core never sees, so the build's bytes would agree with the ELF while
// the text the core reads says something else (review probes: `#import`, string concatenation, a hex
// escape, `-include`, `$X`, `"-"include`, a `cd` line, `-{{flags}}`, a `..` through a symlink). So
// asmlift ASSEMBLES THE FILE ITSELF, in an environment only asmlift defines ({@link controlledSources}):
// a fresh directory holding one source, which is asmlift's own definitions of the marker macros the
// Thumb frontend reads ({@link MARKER_PRELUDE}) followed by the file's text, assembled by GNU as
// ({@link assembleWith}) with no `-I`. Whatever the project's build does, the comparison is then
// between the text the core reads and the bytes that were linked. It requires all of the following:
//   - exactly one source file of the project includes `<dir>/<name>.s` by that macro, and exactly
//     one header defines the macro. The site is read off the units, not off decomp.yaml's
//     `paths.asm`/`paths.nonmatchings`: a file under those paths that no unit includes is no code the
//     build links. A name two sites include (a second unit, or a commented-out line) gives no body;
//   - the file defines the label once, marks it `.weak` nowhere, and holds no `.include` (an
//     included file is the project's environment, which this proof does not read);
//   - the controlled assembly succeeds: any macro but the markers, a missing file, an unknown
//     symbol in an immediate makes gas fail, and that gives no body;
//   - its object defines `<name>` as one non-weak Thumb FUNC, as long as its ELF range (elf-bodies.ts
//     `functionRange` on both);
//   - every byte of the object's range equals the ELF's, except a word a relocation of the object
//     fills, and that one is the word the link wrote: an `R_ARM_ABS32` word whose ELF value is its
//     symbol's linked address plus the addend in place (a jump table's word against the function's
//     own section included, placed where the link put that section), or an `R_ARM_THM_CALL` `bl`
//     pair whose ELF target is the one FUNC the relocation's own symbol names.
// Any other relocation in the range, and any miss above, gives no body. The callee then keeps what
// elf-bodies.ts gave it, byte for byte. So does a host with no assembler.
//
// NOT FOR MIPS OR POWERPC: there the ELF's own disassembly already bounds the registers (elf-bodies.ts,
// #378), so a second reading of the same bytes adds nothing.
import type { CalleeBody } from '@asmlift/core/frontend/callee-body';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { type ElfImage, type FunctionRange, calleeAt, functionRange, readElfImage } from './elf-bodies';

const SHT_SYMTAB = 2;
const SHT_RELA = 4;
const SHT_REL = 9;
const STT_FUNC = 2;
const STT_SECTION = 3;
const R_ARM_ABS32 = 2;
const R_ARM_THM_CALL = 10;
/** Source files past this size are no translation unit a decomp project writes by hand. */
const MAX_SOURCE_BYTES = 4 << 20;
/** Directories a project's sources are never in. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'tools', 'expected', '.local']);

/** Where a project includes each function's assembly: name → every `{ unit, asm }` that names it. */
export type IncludeAsmSites = ReadonlyMap<string, readonly IncludeAsmSite[]>;

/** One `INCLUDE_ASM("<dir>", <name>)`: the unit it is in, its `dir` as written, and the file it names. */
export interface IncludeAsmSite {
  unit: string;
  dir: string;
  asm: string;
}

/** The project's `INCLUDE_ASM` macro and its sites (see the header). */
export interface ProjectAsm {
  /** the one header under the root defining the macro, or undefined */
  header: string | undefined;
  sites: IncludeAsmSites;
}

/** Every `INCLUDE_ASM("<dir>", <name>)` in the `.c` files under `root`, and the `.h` defining it. */
export function projectAsm(root: string): ProjectAsm {
  const out = new Map<string, IncludeAsmSite[]>();
  const headers: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n)) {
          walk(p);
        }
      } else if (n.endsWith('.h') && st.size <= MAX_SOURCE_BYTES) {
        if (/^\s*#\s*define\s+INCLUDE_ASM\b/m.test(readFileSync(p, 'latin1'))) {
          headers.push(p);
        }
      } else if (n.endsWith('.c') && st.size <= MAX_SOURCE_BYTES) {
        const text = readFileSync(p, 'latin1');
        for (const m of text.matchAll(/\bINCLUDE_ASM\s*\(\s*"([^"\\\n]+)"\s*,\s*([A-Za-z_]\w*)\s*\)/g)) {
          const sites = out.get(m[2]) ?? [];
          sites.push({ unit: p, dir: m[1], asm: resolve(root, m[1], `${m[2]}.s`) });
          out.set(m[2], sites);
        }
      }
    }
  };
  walk(root);
  return { header: headers.length === 1 && !/["\\\n]/.test(headers[0]) ? headers[0] : undefined, sites: out };
}

/** The `{ unit, asm }` that includes `name`'s assembly, where exactly one does. */
export function includingUnit(sites: IncludeAsmSites, name: string): IncludeAsmSite | undefined {
  const found = sites.get(name) ?? [];
  return found.length === 1 ? found[0] : undefined;
}

/** Whether `text` defines label `name` exactly once and marks it `.weak` nowhere. */
export function definesOnce(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labels = text.match(new RegExp(`^\\s*${esc}\\s*:`, 'gm')) ?? [];
  const weak = [...text.matchAll(/^\s*\.weak\s+([^\n@;]*)/gm)].some((m) =>
    m[1]
      .split(',')
      .map((s) => s.trim())
      .includes(name),
  );
  return labels.length === 1 && !weak;
}

interface Relocation {
  offset: number;
  type: number;
  /** the relocation's symbol in the object: its name, type, value and section */
  sym: { name: string; type: number; value: number; shndx: number };
}

/** The relocations of an object's section `shndx`; undefined where any is RELA (ARM objects carry REL). */
function relocationsOf(image: ElfImage, shndx: number): Relocation[] | undefined {
  const { elf } = image;
  const { bytes, littleEndian } = elf;
  const u32 = (o: number) => (littleEndian ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
  const out: Relocation[] = [];
  for (const s of elf.sections) {
    if ((s.type !== SHT_REL && s.type !== SHT_RELA) || s.info !== shndx) {
      continue;
    }
    if (s.type === SHT_RELA) {
      return undefined;
    }
    const symtab = elf.sections[s.link];
    const strings = symtab?.type === SHT_SYMTAB ? elf.sections[symtab.link] : undefined;
    if (strings === undefined) {
      return undefined;
    }
    for (let at = s.offset; at + 8 <= s.offset + s.size; at += 8) {
      const info = u32(at + 4);
      const ent = symtab.offset + 16 * (info >>> 8);
      const nameAt = strings.offset + u32(ent);
      const nameEnd = bytes.indexOf(0, nameAt);
      out.push({
        offset: u32(at),
        type: info & 0xff,
        sym: {
          name: bytes.toString('latin1', nameAt, nameEnd < 0 ? nameAt : nameEnd),
          type: bytes[ent + 12] & 0xf,
          value: u32(ent + 4),
          shndx: littleEndian ? bytes.readUInt16LE(ent + 14) : bytes.readUInt16BE(ent + 14),
        },
      });
    }
  }
  return out;
}

/** The file offset of `range`'s first byte in its image. */
const fileOffset = (image: ElfImage, range: FunctionRange): number => {
  const s = image.elf.sections[range.shndx];
  return s.offset + (range.start - s.addr);
};

/** Where the Thumb `bl` pair at `at` (file offset) of address `pc` branches. */
function blTarget(image: ElfImage, at: number, pc: number): number | undefined {
  const { bytes, littleEndian } = image.elf;
  const u16 = (o: number) => (littleEndian ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
  const [hi, lo] = [u16(at), u16(at + 2)];
  if ((hi & 0xf800) !== 0xf000 || (lo & 0xf800) !== 0xf800) {
    return undefined;
  }
  const off = ((((hi & 0x7ff) << 12) | ((lo & 0x7ff) << 1)) << 9) >> 9; // sign-extend 23 bits
  return (pc + 4 + off) >>> 0;
}

/** Whether the `R_ARM_ABS32` word `at` bytes into `ours` (the object's range of the function) is
 *  the word the link wrote `at` bytes into `range`: `(S + A) | T`, the addend `A` read in place (ARM
 *  objects carry REL). A word against a symbol of the function's own section (a jump table's
 *  `.4byte .Lcase`, which gas relocates against the section) places `S` by where the link put that
 *  section, which the function's own range says; one against a named symbol elsewhere takes `S` off
 *  the linked image's one definition of that name. Any other word (a section symbol of another
 *  section, a name defined twice or nowhere) is no word this check can place, and gives no body: a
 *  file whose table names another case assembles to the same instructions. */
function abs32Agrees(
  linked: ElfImage,
  range: FunctionRange,
  obj: ElfImage,
  ours: FunctionRange,
  at: number,
  sym: Relocation['sym'],
): boolean {
  const word = (image: ElfImage, r: FunctionRange): number => {
    const { bytes, littleEndian } = image.elf;
    const o = fileOffset(image, r) + at;
    return littleEndian ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o);
  };
  const addend = word(obj, ours);
  let s: number;
  let thumb: number;
  if (sym.shndx === ours.shndx) {
    thumb = sym.type === STT_FUNC ? sym.value & 1 : 0;
    s = range.start + ((sym.value & ~thumb) - ours.start);
  } else if (sym.type === STT_SECTION) {
    return false;
  } else {
    const defs = linked.symbols.filter((d) => d.name === sym.name && d.shndx !== 0);
    if (defs.length !== 1) {
      return false;
    }
    thumb = linked.arm && defs[0].type === STT_FUNC ? defs[0].value & 1 : 0;
    s = defs[0].value & ~thumb;
  }
  return ((s + addend) | thumb) >>> 0 === word(linked, range);
}

/** Whether `object`'s `name` is the code `linked`'s `name` is, relocated words aside (see the
 *  header). */
export function assemblesToLinked(linked: ElfImage, object: Uint8Array, name: string): boolean {
  const range = functionRange(linked, name);
  const obj = readElfImage(object);
  const ours = obj === undefined ? undefined : functionRange(obj, name);
  if (range === undefined || !range.thumb || obj === undefined || ours === undefined || !ours.thumb) {
    return false;
  }
  const length = range.end - range.start;
  if (ours.end - ours.start !== length) {
    return false;
  }
  const relocs = relocationsOf(obj, ours.shndx);
  if (relocs === undefined) {
    return false;
  }
  const masked = new Set<number>();
  for (const r of relocs) {
    const at = r.offset - (ours.start - obj.elf.sections[ours.shndx].addr);
    if (at + 4 <= 0 || at >= length) {
      continue;
    }
    if (at < 0 || at + 4 > length || (r.type !== R_ARM_ABS32 && r.type !== R_ARM_THM_CALL)) {
      return false;
    }
    if (r.type === R_ARM_THM_CALL) {
      const target = blTarget(linked, fileOffset(linked, range) + at, range.start + at);
      if (
        r.sym.type === STT_SECTION ||
        target === undefined ||
        calleeAt(linked, range, target, { thumb: true }) !== r.sym.name
      ) {
        return false;
      }
    } else if (!abs32Agrees(linked, range, obj, ours, at, r.sym)) {
      return false;
    }
    for (let k = 0; k < 4; k++) {
      masked.add(at + k);
    }
  }
  const [a, b] = [fileOffset(linked, range), fileOffset(obj, ours)];
  for (let k = 0; k < length; k++) {
    if (!masked.has(k) && linked.elf.bytes[a + k] !== obj.elf.bytes[b + k]) {
      return false;
    }
  }
  return true;
}

// THE MARKER MACROS, as asmlift defines them for its own assembly of a project file. The Thumb
// frontend (core thumb.ts) reads `thumb_func_start NAME` and `non_word_aligned_thumb_func_start NAME`
// as "a Thumb function NAME starts at the next label", `arm_func_start NAME` as an ARM-mode function
// it refuses, and `thumb_func_end`/`arm_func_end` as nothing. These definitions are pret's and
// kl2dct's include/macros.inc, which mean exactly that: zero bytes inside the function, the label a
// global function of that instruction set (`.thumb_func` marks the Thumb bit), the `.size` closing
// it. No other macro is defined, so a file calling any other (a `_local` marker the frontend does
// not read included) fails to assemble and gives no body.
export const MARKER_PRELUDE = [
  '.macro thumb_func_start name',
  '.align 2, 0',
  '.global \\name',
  '.thumb',
  '.thumb_func',
  '.type \\name, %function',
  '.endm',
  '.macro non_word_aligned_thumb_func_start name',
  '.global \\name',
  '.thumb',
  '.thumb_func',
  '.type \\name, %function',
  '.endm',
  '.macro arm_func_start name',
  '.align 2, 0',
  '.global \\name',
  '.arm',
  '.type \\name, %function',
  '.endm',
  '.macro thumb_func_end name',
  '.size \\name, .-\\name',
  '.endm',
  '.macro arm_func_end name',
  '.size \\name, .-\\name',
  '.endm',
].join('\n');

/** The sources asmlift assembles for a project file's `text`, one per dialect; undefined where the
 *  text `.include`s anything (see the header). The Thumb frontend reads both `.syntax divided` and
 *  `.syntax unified` (thumb.ts `isDataOp`: a project's split files carry no `.syntax` of their own,
 *  and its INCLUDE_ASM may wrap them in either), and the register reads it takes from a line are the
 *  same in both, so the file is a body where either dialect assembles it to the linked bytes. gas's
 *  default, divided, is tried first. */
export function controlledSources(text: string): string[] | undefined {
  if (/(?<![\w.$])\.include(?![\w.$])/i.test(text)) {
    return undefined;
  }
  return ['divided', 'unified'].map((d) => `${MARKER_PRELUDE}\n.syntax ${d}\n${text}\n`);
}

/** Assembles one {@link controlledSources} source for `callee` to an object's bytes; undefined where it
 *  does not assemble. The seam the offline tests fake. */
export type BodyAssemble = (source: string, callee: string) => Promise<Uint8Array | undefined>;

/** The flags of asmlift's assembly: the GBA's CPU, as the Thumb frontend and the pinned toolchain
 *  (@asmlift/toolchains `TOOLCHAIN.asFlags`) assume. Interworking marks the object, not the code. */
const AS_FLAGS = ['-mcpu=arm7tdmi', '-mthumb-interwork'];

/** {@link BodyAssemble} with GNU as for ARM: `ASMLIFT_ARM_AS`, else `arm-none-eabi-as` on PATH (the
 *  binary the pinned toolchain names), run in a fresh directory holding only the source. */
export function assembleWith(as: string = process.env.ASMLIFT_ARM_AS ?? 'arm-none-eabi-as'): BodyAssemble {
  return (source) =>
    new Promise((done) => {
      let dir: string | undefined;
      try {
        dir = mkdtempSync(join(tmpdir(), 'asmlift-body-'));
        writeFileSync(join(dir, 'body.s'), source);
      } catch {
        if (dir !== undefined) {
          rmSync(dir, { recursive: true, force: true });
        }
        done(undefined);
        return;
      }
      const at = dir;
      execFile(as, [...AS_FLAGS, '-o', 'body.o', 'body.s'], { cwd: at, timeout: 60_000 }, (error) => {
        let object: Uint8Array | undefined;
        try {
          object = error === null ? new Uint8Array(readFileSync(join(at, 'body.o'))) : undefined;
        } catch {
          object = undefined;
        }
        rmSync(at, { recursive: true, force: true });
        done(object);
      });
    });
}

/** The callees of `callees` whose project file {@link calleeBodiesFromProjectAsm} assembles: one
 *  site includes it under the root, its linked range is Thumb, and the file defines it once (see the
 *  header). Each with the file's text. What the assembly then proves of each is its own; this is
 *  every body that pass may read, which is what a reader holding the
 *  CLI's bodies frozen (the bench's vendoring) must refuse to read less than. */
export function projectAsmCandidates(
  root: string,
  linked: ElfImage,
  callees: readonly string[],
  { header, sites }: ProjectAsm = projectAsm(root),
): Array<{ callee: string; header: string; site: IncludeAsmSite; text: string }> {
  const out: Array<{ callee: string; header: string; site: IncludeAsmSite; text: string }> = [];
  for (const callee of callees) {
    const site = header === undefined ? undefined : includingUnit(sites, callee);
    if (
      header === undefined ||
      site === undefined ||
      relative(root, site.asm).startsWith('..') ||
      functionRange(linked, callee)?.thumb !== true
    ) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(site.asm, 'latin1');
    } catch {
      continue;
    }
    if (definesOnce(text, callee)) {
      out.push({ callee, header, site, text });
    }
  }
  return out;
}

/** The body each callee in `callees` has in the project's assembly, where asmlift's own assembly of
 *  it proves it (see the header): a listing, which the core lifts as it would the same text in the
 *  input; and the file each was read from, relative to `root`, which the `[proto]` note names
 *  (callees.ts `guessedArityNote`) where it would otherwise name the ELF. */
export async function calleeBodiesFromProjectAsm(
  root: string,
  linked: ElfImage,
  callees: readonly string[],
  assemble: BodyAssemble,
  asm: ProjectAsm = projectAsm(root),
): Promise<{ bodies: Record<string, CalleeBody>; files: Record<string, string> }> {
  const bodies: Record<string, CalleeBody> = {};
  const files: Record<string, string> = {};
  for (const { callee, site, text } of projectAsmCandidates(root, linked, callees, asm)) {
    for (const source of controlledSources(text) ?? []) {
      const object = await assemble(source, callee);
      if (object !== undefined && assemblesToLinked(linked, object, callee)) {
        bodies[callee] = { kind: 'listing', text };
        files[callee] = relative(root, site.asm);
        break;
      }
    }
  }
  return { bodies, files };
}
