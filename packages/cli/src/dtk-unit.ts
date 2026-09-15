// asmlift — the dtk unit a function belongs to, read from the project's `objdiff.json`.
//
// dtk-template writes `objdiff.json` beside the project's build: one unit per translation unit,
// each naming the object split from the original binary (`target_path`) and the flags and compiler
// its source builds with (`scratch.c_flags`, `scratch.compiler`). A function's unit is the one whose
// target object defines it, so no path convention is assumed. REL code repeats names across modules
// (every Mario Party 4 minigame has a `REL/executor`), which `--module` narrows.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The nearest `objdiff.json` in `startDir` or a directory above it. */
export function objdiffAbove(startDir: string): string | undefined {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    const path = join(dir, 'objdiff.json');
    if (existsSync(path)) {
      return path;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

/** One unit with flags: a translation unit compiled from source. */
export interface DtkUnit {
  /** `<module>/<path>`, as objdiff names it */
  name: string;
  /** decomp.me's name for the compiler (`mwcc_242_81`) */
  compiler: string;
  /** the flags, as the build spells them */
  cflags: string;
}

export type DtkLookup =
  | { kind: 'found'; unit: DtkUnit }
  | { kind: 'ambiguous'; units: readonly DtkUnit[] }
  | {
      kind: 'none';
      /** how many units had no target object to read */
      unbuilt: number;
    };

interface ObjdiffUnit {
  name?: unknown;
  target_path?: unknown;
  scratch?: { compiler?: unknown; c_flags?: unknown };
}

/** The `objdiff.json` beside a `decomp.yaml`, or undefined when there is none. Throws on a file that is
 *  not an objdiff project. */
export function readObjdiffUnits(configDir: string): { path: string; units: readonly ObjdiffUnit[] } | undefined {
  const path = join(configDir, 'objdiff.json');
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const units = (parsed as { units?: unknown } | null)?.units;
  if (!Array.isArray(units)) {
    throw new Error(`${path} has no units list`);
  }
  return { path, units };
}

/** The unit whose target object defines `symbol`, among the units of `module` when one is named. Only
 *  units compiled from source (with `scratch.c_flags`) are candidates. */
export function unitDefining(
  projectDir: string,
  units: readonly ObjdiffUnit[],
  symbol: string,
  module: string | undefined,
): DtkLookup {
  const defining: DtkUnit[] = [];
  let unbuilt = 0;
  for (const u of units) {
    const { name, target_path: targetPath, scratch } = u;
    if (
      typeof name !== 'string' ||
      typeof targetPath !== 'string' ||
      typeof scratch?.c_flags !== 'string' ||
      typeof scratch.compiler !== 'string' ||
      (module !== undefined && !name.startsWith(`${module}/`))
    ) {
      continue;
    }
    const object = join(projectDir, targetPath);
    if (!existsSync(object)) {
      unbuilt++;
      continue;
    }
    if (elfDefines(readFileSync(object), symbol)) {
      defining.push({ name, compiler: scratch.compiler, cflags: scratch.c_flags });
    }
  }
  if (defining.length === 1) {
    return { kind: 'found', unit: defining[0] };
  }
  return defining.length === 0 ? { kind: 'none', unbuilt } : { kind: 'ambiguous', units: defining };
}

/** Whether `module` names any unit. */
export const moduleHasUnits = (units: readonly ObjdiffUnit[], module: string): boolean =>
  units.some((u) => typeof u.name === 'string' && u.name.startsWith(`${module}/`));

const SHT_SYMTAB = 2;
const SHN_UNDEF = 0;

/** Whether an ELF object's symbol table defines `symbol`: a symbol of that name in any section,
 *  local or global. 32- and 64-bit, either byte order. */
export function elfDefines(bytes: Uint8Array, symbol: string): boolean {
  const name = new TextEncoder().encode(`${symbol}\0`);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 52 || buf.readUInt32BE(0) !== 0x7f454c46 || buf.indexOf(name) === -1) {
    return false;
  }
  const is64 = buf[4] === 2;
  const le = buf[5] === 1;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const word = (o: number) => (is64 ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o)) : u32(o));
  const shoff = word(is64 ? 0x28 : 0x20);
  const shentsize = u16(is64 ? 0x3a : 0x2e);
  const shnum = u16(is64 ? 0x3c : 0x30);
  const sectionOffset = (sh: number) => word(sh + (is64 ? 0x18 : 0x10));
  for (let i = 0; i < shnum; i++) {
    const sh = shoff + i * shentsize;
    if (u32(sh + 4) !== SHT_SYMTAB) {
      continue;
    }
    const start = sectionOffset(sh);
    const end = start + word(sh + (is64 ? 0x20 : 0x14));
    const entsize = word(sh + (is64 ? 0x38 : 0x24));
    const strings = sectionOffset(shoff + u32(sh + (is64 ? 0x28 : 0x18)) * shentsize);
    for (let s = start; entsize > 0 && s + entsize <= end; s += entsize) {
      const at = strings + u32(s);
      if (u16(s + (is64 ? 6 : 14)) !== SHN_UNDEF && buf.subarray(at, at + name.length).equals(name)) {
        return true;
      }
    }
  }
  return false;
}
