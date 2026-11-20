// asmlift — the body of a guessed Thumb callee, read off the project's own assembly where the
// project's own build proves it is the code the link kept.
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
// THE FILE IS A BODY ONLY WHERE THE PROJECT'S OWN BUILD SHOWS IT IS THE LINKED CODE. The text may be
// stale or hand-edited, and a bound read off text that does not assemble to the linked bytes is a
// bound on another function. So the CLI compiles, with the project's own compiler command
// (`tools.asmlift.compiler`, and so whatever assembler that command invokes), a unit holding the
// project's own `INCLUDE_ASM` header and that one `INCLUDE_ASM` line. That is the include the
// project's unit makes, without the rest of the unit, whose headers a candidate compile command
// need not reach (kl2dct's omits the `-I` its Makefile passes for `<string.h>`). It then requires
// all of the following:
//   - exactly one source file of the project includes `<dir>/<name>.s` by that macro, and exactly
//     one header defines the macro;
//   - the file defines the label once and marks it `.weak` nowhere;
//   - the unit's object defines `<name>` as one non-weak Thumb FUNC, as long as its ELF range
//     (elf-bodies.ts `functionRange` on both);
//   - every byte of the object's range equals the ELF's, except a word a relocation of the object
//     fills: an `R_ARM_ABS32` pool word, or an `R_ARM_THM_CALL` `bl` pair whose ELF target is the one
//     FUNC the relocation's own symbol names.
// Any other relocation in the range, and any miss above, gives no body. The callee then keeps what
// elf-bodies.ts gave it, byte for byte. So does a unit that does not compile, an assembler the command
// cannot find included.
//
// NOT FOR MIPS OR POWERPC: there the ELF's own disassembly already bounds the registers (elf-bodies.ts,
// #378), so a second reading of the same bytes adds nothing.
import type { CalleeBody } from '@asmlift/core/frontend/callee-body';
import { createRunner } from '@match-kit/compiler';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { renderCc } from './compile-command';
import { type ElfImage, type FunctionRange, functionRange, readElfImage } from './elf-bodies';

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
  sym: { name: string; type: number };
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
        sym: { name: bytes.toString('latin1', nameAt, nameEnd < 0 ? nameAt : nameEnd), type: bytes[ent + 12] & 0xf },
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

/** The one FUNC whose Thumb entry is `addr` in the linked image: its name, where no other symbol
 *  defines that name. */
function thumbFuncAt(image: ElfImage, addr: number): string | undefined {
  const names = new Set(
    image.symbols
      .filter((s) => s.type === STT_FUNC && (s.value & ~1) === addr && (s.value & 1) === 1)
      .map((s) => s.name),
  );
  if (names.size !== 1) {
    return undefined;
  }
  const [name] = names;
  return image.symbols.filter((s) => s.name === name && s.shndx !== 0 && s.shndx < 0xff00).length === 1
    ? name
    : undefined;
}

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
      if (r.sym.type === STT_SECTION || target === undefined || thumbFuncAt(linked, target) !== r.sym.name) {
        return false;
      }
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

/** Compiles a C source with the project's own compiler command, to an object's bytes; undefined
 *  where it does not compile. The seam the offline tests fake. */
export type UnitCompile = (source: string) => Promise<Uint8Array | undefined>;

/** {@link UnitCompile} with the project's `compiler` command template, run where the decomp.yaml is,
 *  with the flags and compiler name the run resolved (flags.ts), as a candidate compile runs. */
export function unitCompileFromCommand(
  command: string,
  cwd: string,
  flags: readonly string[] | undefined,
  cc: string | undefined,
): UnitCompile {
  return async (source) => {
    try {
      const runner = createRunner(renderCc(command, cc), { cwd, flags });
      try {
        const outcome = await runner.compile(source, { ext: 'c' });
        try {
          return outcome.kind === 'ok' ? new Uint8Array(readFileSync(outcome.object)) : undefined;
        } finally {
          outcome[Symbol.dispose]();
        }
      } finally {
        await runner.dispose();
      }
    } catch {
      return undefined;
    }
  };
}

/** The body each callee in `callees` has in the project's assembly, where the build proves it (see
 *  the header): a listing, which the core lifts as it would the same text in the input. */
export async function calleeBodiesFromProjectAsm(
  root: string,
  linked: ElfImage,
  callees: readonly string[],
  compile: UnitCompile,
  { header, sites }: ProjectAsm = projectAsm(root),
): Promise<Record<string, CalleeBody>> {
  const bodies: Record<string, CalleeBody> = {};
  for (const callee of callees) {
    const site = header === undefined ? undefined : includingUnit(sites, callee);
    if (
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
    if (!definesOnce(text, callee)) {
      continue;
    }
    const object = await compile(`#include "${header}"\nINCLUDE_ASM("${site.dir}", ${callee});\n`);
    if (object !== undefined && assemblesToLinked(linked, object, callee)) {
      bodies[callee] = { kind: 'listing', text };
    }
  }
  return bodies;
}
