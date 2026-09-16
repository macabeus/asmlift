// Building a dtk project (`python3 configure.py && ninja`) from the harness.
//
// Everything a Makefile project gets for free has to be spelled out here:
//
//   - THE VERSION. A dtk checkout configures several disc versions and builds `configure.py`'s
//     default one. The rows are keyed to ONE of them, so the recipe names it and this module
//     refuses a checkout whose default has moved — an upstream pin bump would otherwise build a
//     different ROM under the same row addresses.
//   - THE DISC. dtk cuts the target objects out of the original disc, which is never committed:
//     the image (or the tree dtk extracted from it on an earlier build) lives in `orig/<version>/`.
//     Every file `config.yml` names there is sha1-checked against the hash beside it BEFORE the
//     build, so a wrong or swapped image fails in a second rather than after an hour.
//   - WINE. The compilers are Windows binaries run under wine, which on macOS fails to launch a
//     tool from time to time, and can leave a compile frozen at 0% CPU or hold ninja's pipe open
//     after its own child is gone. All three recover by re-running ninja, and none of them changes
//     a byte of the output — dtk's own sha1 check is the arbiter. So ninja runs supervised: its
//     output goes to a LOG FILE, never a pipe a grandchild can hold open; an attempt whose log
//     stops growing is stalled and is stopped; and a stopped or failed attempt is resumed.
import { readObjdiffUnits } from '@asmlift/cli/dtk-unit';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import YAML from 'yaml';

import { CACHE_DIR } from '../config';

/** The versions `configure.py` offers and the one it builds without `--version`. */
export function configuredVersions(root: string): { versions: string[]; fallback: string } {
  const source = readFileSync(join(root, 'configure.py'), 'utf8');
  const index = /^DEFAULT_VERSION\s*=\s*(\d+)\s*$/m.exec(source)?.[1];
  const list = /^VERSIONS\s*=\s*\[([\s\S]*?)^\]/m.exec(source)?.[1];
  if (index === undefined || list === undefined) {
    throw new Error(`${root}/configure.py declares no DEFAULT_VERSION and VERSIONS`);
  }
  // one entry per line, and only the string that OPENS the line: Pikmin comments several of its
  // versions with the disc path they came from, in quotes
  const versions = [...list.matchAll(/^\s*"([^"]+)"\s*,/gm)].map((m) => m[1]);
  const fallback = versions[Number(index)];
  if (fallback === undefined) {
    throw new Error(`${root}/configure.py: DEFAULT_VERSION ${index} names none of its ${versions.length} VERSIONS`);
  }
  return { versions, fallback };
}

/** Refuse a checkout that would build a version other than the one the rows are keyed to. */
export function requireVersion(root: string, version: string): void {
  const { fallback } = configuredVersions(root);
  if (fallback !== version) {
    throw new Error(`${root}/configure.py builds ${fallback} by default, not ${version}`);
  }
}

/** A file dtk reads out of the disc, and the sha1 `config.yml` says it has. */
export interface DiscInput {
  /** relative to `objectBase` (`sys/main.dol`, `files/dll/bootDll.rel`) */
  object: string;
  sha1: string;
}

interface DtkConfigYml {
  object_base?: unknown;
  object?: unknown;
  hash?: unknown;
  modules?: readonly { object?: unknown; hash?: unknown }[];
}

/** The DOL and every module `config/<version>/config.yml` names, with the directory they live in. */
export function discInputs(root: string, version: string): { objectBase: string; inputs: DiscInput[] } {
  const path = join(root, 'config', version, 'config.yml');
  const config = YAML.parse(readFileSync(path, 'utf8')) as DtkConfigYml;
  const objectBase = config.object_base;
  if (typeof objectBase !== 'string') {
    throw new Error(`${path} declares no object_base`);
  }
  const inputs: DiscInput[] = [];
  for (const entry of [config, ...(config.modules ?? [])]) {
    if (typeof entry.object === 'string' && typeof entry.hash === 'string') {
      inputs.push({ object: entry.object, sha1: entry.hash.toLowerCase() });
    }
  }
  if (inputs.length === 0) {
    throw new Error(`${path} names no object with a hash`);
  }
  return { objectBase, inputs };
}

/** No disc image of any container dtk reads is smaller than this; the smallest here is a 19 MB
 *  rvz. A `.gitkeep`, a Finder `.DS_Store`, an AppleDouble or a stray README is kilobytes — and
 *  each of those passing as "the image is there" would cost an hour of building to find out. */
const SMALLEST_DISC_IMAGE = 1_000_000;

/** Whatever sits in `orig/<version>/` that dtk did not extract there and is big enough to be a
 *  disc image. Size rather than a list of extensions: the containers are dtk's to support. */
function discImages(dir: string, inputs: readonly DiscInput[]): string[] {
  const extracted = new Set(inputs.map((i) => i.object.split('/')[0]));
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !extracted.has(e.name))
        .map((e) => e.name)
        .filter((name) => statSync(join(dir, name)).size >= SMALLEST_DISC_IMAGE)
    : [];
}

const sha1 = (path: string): string => createHash('sha1').update(readFileSync(path)).digest('hex');

/** Prove the checkout can build the ROM the rows were cut from: every file dtk has already
 *  extracted from the disc hashes to what `config.yml` says, and where it has extracted nothing
 *  yet there is an image to extract from. Returns how many objects were hashed. */
export function requireDisc(root: string, version: string): number {
  const { objectBase, inputs } = discInputs(root, version);
  const dir = join(root, objectBase);
  let checked = 0;
  for (const input of inputs) {
    const path = join(dir, input.object);
    if (!existsSync(path)) {
      continue;
    }
    const found = sha1(path);
    if (found !== input.sha1) {
      throw new Error(`${join(objectBase, input.object)} is sha1 ${found}, and config.yml wants ${input.sha1}`);
    }
    checked++;
  }
  if (checked < inputs.length && discImages(dir, inputs).length === 0) {
    throw new Error(
      `${objectBase} holds ${checked} of the ${inputs.length} objects config.yml names, and no disc image to cut ` +
        `the rest from: put the ${version} disc image in ${dir} (it is never committed)`,
    );
  }
  return checked;
}

/** One supervised `ninja`. `stopped` says why it was not left to finish. */
export interface NinjaAttempt {
  status: number | null;
  signal: NodeJS.Signals | null;
  stopped?: 'stalled' | 'timeout';
  seconds: number;
}

export interface NinjaOptions {
  dir: string;
  /** the build's whole output, appended to across attempts — never a pipe (see the file header) */
  log: string;
  exe?: string;
  args?: readonly string[];
  /** how many times a stopped or failed ninja is resumed */
  attempts?: number;
  /** an attempt is abandoned at this age */
  timeoutMs?: number;
  /** an attempt whose log has not grown for this long is stalled */
  stallMs?: number;
  pollMs?: number;
  /** grace between SIGTERM, which makes ninja take its own children down, and SIGKILL */
  graceMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Write what the log gained since `from` to our own stdout, and return the new offset. */
function echo(log: string, from: number): number {
  const size = existsSync(log) ? statSync(log).size : 0;
  if (size <= from) {
    return from;
  }
  const fd = openSync(log, 'r');
  try {
    const chunk = Buffer.alloc(size - from);
    const read = readSync(fd, chunk, 0, chunk.length, from);
    process.stdout.write(chunk.subarray(0, read));
    return from + read;
  } finally {
    closeSync(fd);
  }
}

async function stop(child: ChildProcess, exited: () => boolean, graceMs: number, pollMs: number): Promise<void> {
  child.kill('SIGTERM'); // ninja puts every edge in its own process group and takes them down with it
  for (let waited = 0; waited < graceMs && !exited(); waited += pollMs) {
    await sleep(pollMs);
  }
  if (!exited()) {
    child.kill('SIGKILL');
  }
}

const describeAttempt = (run: NinjaAttempt): string =>
  `${run.stopped ?? `exit ${run.status ?? run.signal}`} after ${run.seconds.toFixed(1)}s`;

/** Run ninja until it succeeds, resuming a stopped or failed attempt. Throws when the attempts run
 *  out, naming the log. A resume is cheap: ninja rebuilds only what is not up to date. */
export async function runNinja(opts: NinjaOptions): Promise<NinjaAttempt[]> {
  const { dir, log, exe = 'ninja', args = [] } = opts;
  const { attempts = 3, timeoutMs = 3_600_000, stallMs = 300_000, pollMs = 1_000, graceMs = 10_000 } = opts;
  mkdirSync(dirname(log), { recursive: true });
  const runs: NinjaAttempt[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    let shown = existsSync(log) ? statSync(log).size : 0;
    const fd = openSync(log, 'a');
    // stdin is /dev/null: a wine tool that reads it would otherwise wait for a terminal forever
    const child = spawn(exe, args, { cwd: dir, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    let exit: { status: number | null; signal: NodeJS.Signals | null } | undefined;
    // `exit`, never `close`: a wine prefix service that outlives the build can hold the log open,
    // and `close` would then never arrive
    child.on('exit', (status, signal) => {
      exit = { status, signal };
    });
    child.on('error', (e) => {
      process.stdout.write(`${exe}: ${e.message}\n`);
      exit ??= { status: null, signal: null };
    });
    let grew = Date.now();
    let stopped: NinjaAttempt['stopped'];
    while (exit === undefined) {
      await sleep(pollMs);
      const before = shown;
      shown = echo(log, shown);
      if (shown > before) {
        grew = Date.now();
      }
      if (exit !== undefined) {
        break;
      }
      if (Date.now() - started > timeoutMs) {
        stopped = 'timeout';
      } else if (Date.now() - grew > stallMs) {
        stopped = 'stalled';
      }
      if (stopped !== undefined) {
        await stop(child, () => exit !== undefined, graceMs, pollMs);
      }
    }
    echo(log, shown);
    const run: NinjaAttempt = { ...exit, stopped, seconds: (Date.now() - started) / 1000 };
    runs.push(run);
    if (stopped === undefined && run.status === 0) {
      return runs;
    }
    console.log(`  ninja attempt ${attempt}/${attempts}: ${describeAttempt(run)}`);
  }
  throw new Error(`${exe} did not finish in ${attempts} attempts (${runs.map(describeAttempt).join('; ')}) — ${log}`);
}

/** Every unit's TARGET object — what dtk cut from the disc, which a candidate is scored against —
 *  read from the `objdiff.json` the configure step writes, keyed by unit name. Throws when the
 *  split has not run, or has left a unit's object behind. */
export function dtkTargetObjects(root: string): Map<string, string> {
  const objdiff = readObjdiffUnits(root);
  if (objdiff === undefined) {
    throw new Error(`${root} has no objdiff.json: it is written by \`configure.py\` after the disc split`);
  }
  const targets = new Map<string, string>();
  const missing: string[] = [];
  for (const unit of objdiff.units as readonly { name?: unknown; target_path?: unknown }[]) {
    if (typeof unit.name !== 'string' || typeof unit.target_path !== 'string') {
      continue;
    }
    const path = join(root, unit.target_path);
    if (existsSync(path)) {
      targets.set(unit.name, path);
    } else {
      missing.push(unit.target_path);
    }
  }
  if (missing.length > 0) {
    throw new Error(`${objdiff.path}: ${missing.length} unit(s) have no target object, e.g. ${missing[0]}`);
  }
  return targets;
}

export interface DtkOptions {
  /** the disc version the rows are keyed to; `configure.py` must still build it by default */
  version: string;
  python?: string;
  ninja?: string;
  ninjaArgs?: readonly string[];
  /** where ninja's output is appended (default: the harness's own cache, never the checkout) */
  log?: string;
  attempts?: number;
  timeoutMs?: number;
  stallMs?: number;
  pollMs?: number;
  graceMs?: number;
}

const ninjaLog = (root: string, opts: DtkOptions): string =>
  opts.log ?? join(CACHE_DIR, 'dtk', `${basename(root)}.ninja.log`);

/** Write the build graph, having refused now what would otherwise fail an hour in: a checkout that
 *  builds another version, a missing disc, a wrong one. `configure.py` rewrites `build.ninja` from
 *  scratch, so running it again costs nothing. */
export function dtkPrepare(root: string, opts: DtkOptions): void {
  requireVersion(root, opts.version);
  const checked = requireDisc(root, opts.version);
  const python = opts.python ?? 'python3';
  console.log(`  ${opts.version}: ${checked} disc object(s) match config.yml`);
  console.log(`  $ ${python} configure.py`);
  const run = spawnSync(python, ['configure.py'], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) {
    throw new Error(`${python} configure.py failed in ${root} (${run.error?.message ?? `exit ${run.status}`})`);
  }
}

/** The full build, ending in dtk's own byte-compare gate: `CHECK config/<version>/build.sha1`
 *  writes `build/<version>/ok` only when every linked output has the disc's sha1. */
export async function dtkBuild(root: string, opts: DtkOptions): Promise<void> {
  requireDisc(root, opts.version);
  const log = ninjaLog(root, opts);
  console.log(`  $ ${opts.ninja ?? 'ninja'} ${(opts.ninjaArgs ?? []).join(' ')}  (log: ${log})`);
  await runNinja({ ...opts, dir: root, log, exe: opts.ninja, args: opts.ninjaArgs });
  const ok = join(root, 'build', opts.version, 'ok');
  if (!existsSync(ok)) {
    throw new Error(`ninja finished without dtk's byte-compare gate: ${ok} is missing`);
  }
  console.log(`  ${opts.version}: ${dtkTargetObjects(root).size} target objects from objdiff.json`);
}
