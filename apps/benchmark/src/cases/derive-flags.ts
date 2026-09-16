// A real unit's compiler flags, copied from its project's own build by a tool and never typed: a Makefile
// project's recipe for the unit's object, as `gmake -n` prints it, or a dtk project's `objdiff.json` unit,
// cross-checked with the `build.ninja` edge that compiles it. Both are stored in core's normal form.
//
// A Makefile is read in a clone of the checkout at the vendored commit, never in the checkout itself: pret
// Makefiles build their tools and scan dependencies while they are parsed, and `-n` does not stop that.
import { readObjdiffUnits } from '@asmlift/cli/dtk-unit';
import { commandFlags } from '@asmlift/cli/flags';
import { storedFlags, tokenizeFlags } from '@asmlift/core/codegen-flags';
import { TOOLCHAIN_TARGETS, type ToolchainId, isToolchainId } from '@asmlift/core/target';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CACHE_DIR } from '../config';
import { git } from './checkout';
import type { BuildUnit, RealFunction } from './manifests';
import { gnuMake } from './project-elf';
import { PROJECT_RECIPES } from './project-setup';

/** The file a row's permalink cites: the source file its `funcC` was copied from. */
export function citedFile(fn: Pick<RealFunction, 'sym' | 'sourceUrl'>): string {
  const path = /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[0-9a-f]+\/([^#]+)/.exec(fn.sourceUrl ?? '')?.[1];
  if (path === undefined) {
    throw new Error(`${fn.sym}: its sourceUrl names no unit`);
  }
  return path;
}

/** `ninja -t deps` output as the files each output's compile read, relative to `root` (the checkout the
 *  build ran in, as its real path) where they lie inside it. */
export function parseNinjaDeps(text: string, root: string): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  let read: string[] | undefined;
  for (const line of text.split('\n')) {
    const output = /^(\S.*): #deps \d+/.exec(line)?.[1];
    if (output !== undefined) {
      read = [];
      deps.set(output, read);
    } else if (read !== undefined && /^\s+\S/.test(line)) {
      const path = line.trim();
      read.push(path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
    }
  }
  return deps;
}

/** The dtk unit `cited` is compiled in: the unit `objdiff.json` builds from it, or, for a file no unit is
 *  built from, the one unit whose compile READ it — a body a unit `#include`s (Animal Crossing's 550
 *  `.c_inc` files) is compiled only inside that unit, and only at its flags. `deps` are what the project's
 *  build recorded each object's compile reading (`parseNinjaDeps`), keyed by `base_path`. */
export function dtkUnitOf(
  units: readonly ObjdiffSourceUnit[],
  cited: string,
  deps: () => ReadonlyMap<string, readonly string[]>,
): string {
  if (units.some((u) => u.metadata?.source_path === cited)) {
    return cited;
  }
  const including = units.filter((u) => deps().get(String(u.base_path))?.includes(cited));
  if (including.length !== 1) {
    throw new Error(
      including.length === 0
        ? `no objdiff.json unit is built from ${cited}, and the build records no unit reading it — build the project first`
        : `${cited} is read by ${including.length} units: ${including.map((u) => String(u.metadata?.source_path)).join(', ')}`,
    );
  }
  return String(including[0].metadata?.source_path);
}

export type BuildSystem = 'makefile' | 'dtk';

/** A dtk project has the `objdiff.json` and `build.ninja` its configure step writes; any other has a Makefile. */
export function buildSystemOf(root: string): BuildSystem {
  if (existsSync(join(root, 'objdiff.json')) && existsSync(join(root, 'build.ninja'))) {
    return 'dtk';
  }
  if (existsSync(join(root, 'Makefile'))) {
    return 'makefile';
  }
  throw new Error(`${root} has neither a Makefile nor dtk's objdiff.json and build.ninja`);
}

const fileSha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A clone of `checkout` at `commit`, reset on every call, with the project's baseroms linked in: a
 *  Makefile may refuse to parse without its baserom. */
export function flagsClone(
  project: string,
  checkout: string,
  commit: string,
  clonesDir = join(CACHE_DIR, 'flags-clones'),
): string {
  const dir = join(clonesDir, project);
  if (existsSync(join(dir, '.git'))) {
    git(dir, ['fetch', '--quiet', 'origin', 'HEAD']);
  } else {
    mkdirSync(clonesDir, { recursive: true });
    git(clonesDir, ['clone', '--quiet', '--no-checkout', checkout, project]);
  }
  git(dir, ['checkout', '--quiet', '--force', '--detach', commit]);
  git(dir, ['clean', '--quiet', '-fdx']);
  for (const baserom of PROJECT_RECIPES[project]?.baseroms ?? []) {
    if (existsSync(join(checkout, baserom)) && !existsSync(join(dir, baserom))) {
      mkdirSync(dirname(join(dir, baserom)), { recursive: true });
      symlinkSync(join(checkout, baserom), join(dir, baserom));
    }
  }
  return dir;
}

/** Every object file a built checkout holds, relative to it, outside hidden directories. */
export function objectFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.o')) {
        found.push(path);
      }
    }
  };
  walk('');
  return found;
}

/** The object the project's build wrote for `unit`: the one whose path ends in the unit's path, with its
 *  extension replaced (`src/math.o`) or kept (`src/sprman.c.o`). */
export function unitObject(unit: string, objects: readonly string[]): string {
  const stem = unit.replace(/\.[^./]+$/, '');
  const found = objects.filter((o) => `/${o}`.endsWith(`/${stem}.o`) || `/${o}`.endsWith(`/${unit}.o`));
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? `no object file for ${unit} in the checkout: build the project first`
        : `${unit} has several object files: ${found.join(', ')}`,
    );
  }
  return found[0];
}

/** A Makefile unit's flags: the words its recipe gives the toolchain's compiler, read off
 *  `gmake -n -W <unit> <object>` run in `clone`. Only recipe lines naming the unit or its object are read,
 *  so a tool the recipe also builds is never taken for the compile. Throws `UnreadableLevelError` on a level
 *  word the compiler family cannot read. */
export function deriveMakefileFlags(opts: {
  clone: string;
  commit: string;
  unit: string;
  object: string;
  toolchain: ToolchainId;
}): BuildUnit {
  const { clone, commit, unit, object, toolchain } = opts;
  const family = TOOLCHAIN_TARGETS[toolchain].family;
  // NODEP and SETUP_PREREQS are pret's switches for the dependency scan and the tool builds a parse
  // runs; other Makefiles ignore them
  const args = ['-n', 'NODEP=1', 'SETUP_PREREQS=0', '-W', unit, object];
  const make = spawnSync(gnuMake(), args, { cwd: clone, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (make.status !== 0) {
    throw new Error(
      `${gnuMake()} ${args.join(' ')} failed at ${commit.slice(0, 8)}: ${make.stderr.trim().slice(-500)}`,
    );
  }
  const stem = object.replace(/(\.[^./]+)?\.o$/, '');
  for (const line of make.stdout.replace(/\\\n/g, ' ').split('\n')) {
    if (!line.includes(unit) && !line.includes(stem)) {
      continue;
    }
    const cflags = commandFlags(line, family);
    if (cflags !== undefined) {
      return {
        toolchain,
        cflags,
        flagsFrom: {
          from: 'makefile',
          commit,
          file: 'Makefile',
          sha256: fileSha256(join(clone, 'Makefile')),
          command: line.trim(),
        },
      };
    }
  }
  throw new Error(`no recipe line for ${object} runs ${toolchain}'s compiler`);
}

/** The `cflags` of the build.ninja edge that builds `output`, continuations joined and escapes undone. */
export function ninjaCflags(ninja: string, output: string): string | undefined {
  const lines = ninja.replace(/\$\r?\n[ \t]*/g, '').split('\n');
  const edge = lines.findIndex((l) => l.startsWith(`build ${output}:`));
  if (edge === -1) {
    return undefined;
  }
  for (let i = edge + 1; i < lines.length && /^[ \t]/.test(lines[i]); i++) {
    const value = /^[ \t]+cflags = (.*)$/.exec(lines[i])?.[1];
    if (value !== undefined) {
      return value.replace(/\$([$ :])/g, '$1');
    }
  }
  return undefined;
}

interface ObjdiffSourceUnit {
  name?: unknown;
  base_path?: unknown;
  scratch?: { compiler?: unknown; c_flags?: unknown };
  metadata?: { source_path?: unknown };
}

/** A dtk unit's flags: the `scratch.c_flags` of the one `objdiff.json` unit compiled from `unit`, which must
 *  agree in normal form with the `cflags` of the build.ninja edge building its object, and its toolchain is
 *  `scratch.compiler`. Throws `UnreadableLevelError` on a level word the compiler family cannot read. */
export function deriveDtkFlags(root: string, commit: string, unit: string): BuildUnit {
  const objdiff = readObjdiffUnits(root);
  if (objdiff === undefined) {
    throw new Error(`${root} has no objdiff.json`);
  }
  const units = (objdiff.units as readonly ObjdiffSourceUnit[]).filter(
    (u) => u.metadata?.source_path === unit && typeof u.scratch?.c_flags === 'string',
  );
  if (units.length !== 1) {
    throw new Error(
      units.length === 0
        ? `objdiff.json has no unit compiled from ${unit}`
        : `${unit} is compiled in ${units.length} objdiff.json units: ${units.map((u) => String(u.name)).join(', ')}`,
    );
  }
  const [u] = units;
  const name = String(u.name);
  const compiler = String(u.scratch?.compiler);
  if (!isToolchainId(compiler)) {
    throw new Error(`${name} is compiled by ${compiler}, which is not an asmlift toolchain`);
  }
  const family = TOOLCHAIN_TARGETS[compiler].family;
  const cflags = storedFlags(family, tokenizeFlags(String(u.scratch?.c_flags)));
  const edgeFlags = ninjaCflags(readFileSync(join(root, 'build.ninja'), 'utf8'), String(u.base_path));
  if (edgeFlags === undefined) {
    throw new Error(`build.ninja has no edge building ${String(u.base_path)} with cflags`);
  }
  const fromNinja = storedFlags(family, tokenizeFlags(edgeFlags));
  if (fromNinja.join('\0') !== cflags.join('\0')) {
    throw new Error(
      `${name}: objdiff.json's flags (${cflags.join(' ')}) are not build.ninja's (${fromNinja.join(' ')})`,
    );
  }
  return {
    toolchain: compiler,
    cflags,
    flagsFrom: {
      from: 'objdiff',
      commit,
      file: 'objdiff.json',
      sha256: fileSha256(join(root, 'objdiff.json')),
      unit: name,
    },
  };
}

/** Every unit of one project, derived at its checkout's HEAD: the build system is read once, and a Makefile
 *  project is read in one clone, with one walk over the objects its build wrote. A Makefile names no
 *  compiler asmlift can tell apart (`gcc` is two toolchains), so its unit takes `toolchain`; a dtk unit
 *  names its own. `unitOf` is the unit a row's function is compiled in: a Makefile project's is the file
 *  the row cites, and a dtk project's the unit that file is built in or read by (`dtkUnitOf`). */
export function unitDeriver(
  project: string,
  root: string,
): {
  build: BuildSystem;
  commit: string;
  unitOf: (fn: Pick<RealFunction, 'sym' | 'sourceUrl'>) => string;
  derive: (unit: string, toolchain: ToolchainId | undefined) => BuildUnit;
} {
  const build = buildSystemOf(root);
  const commit = git(root, ['rev-parse', 'HEAD']);
  if (build === 'dtk') {
    const units = (readObjdiffUnits(root)?.units ?? []) as readonly ObjdiffSourceUnit[];
    let deps: Map<string, string[]> | undefined;
    const recorded = () => {
      deps ??= ninjaDeps(root);
      return deps;
    };
    return {
      build,
      commit,
      unitOf: (fn) => dtkUnitOf(units, citedFile(fn), recorded),
      derive: (unit) => deriveDtkFlags(root, commit, unit),
    };
  }
  const clone = flagsClone(project, root, commit);
  const objects = objectFiles(root);
  return {
    build,
    commit,
    unitOf: citedFile,
    derive: (unit, toolchain) => {
      if (toolchain === undefined) {
        throw new Error(`no unit of ${project} names its toolchain yet: pass --toolchain`);
      }
      return deriveMakefileFlags({ clone, commit, unit, object: unitObject(unit, objects), toolchain });
    },
  };
}

/** What the project's ninja build recorded each compile reading. */
function ninjaDeps(root: string): Map<string, string[]> {
  const r = spawnSync('ninja', ['-t', 'deps'], { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error(`ninja -t deps failed in ${root}: ${r.error?.message ?? r.stderr}`);
  }
  return parseNinjaDeps(r.stdout, realpathSync(root));
}

export type FlagsStatus = { kind: 'ok' } | { kind: 'DRIFT'; changes: string[] } | { kind: 'MISSING' };

/** How a unit as the manifest stores it stands against the unit derived from its build: every difference,
 *  in the words `bench flags` prints. */
export function flagsStatus(stored: BuildUnit | undefined, derived: BuildUnit): FlagsStatus {
  if (stored === undefined) {
    return { kind: 'MISSING' };
  }
  const changes: string[] = [];
  const moved = (what: string, from: string, to: string) => {
    if (from !== to) {
      changes.push(`${what}${from} → ${to}`);
    }
  };
  moved('', stored.toolchain, derived.toolchain);
  moved('', stored.cflags.join(' '), derived.cflags.join(' '));
  const [a, b] = [stored.flagsFrom, derived.flagsFrom];
  moved('from ', a.from, b.from);
  moved('commit ', a.commit.slice(0, 8), b.commit.slice(0, 8));
  moved(`${b.file} sha256 `, a.sha256.slice(0, 12), b.sha256.slice(0, 12));
  moved('', a.file, b.file);
  if (a.from === 'makefile' && b.from === 'makefile' && a.command !== b.command) {
    changes.push('recipe line changed');
  }
  if (a.from === 'objdiff' && b.from === 'objdiff') {
    moved('objdiff unit ', a.unit, b.unit);
  }
  return changes.length === 0 ? { kind: 'ok' } : { kind: 'DRIFT', changes };
}
