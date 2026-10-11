// The candidate store for the three toolchains that compile in a linux/386 container, or natively
// on a host that runs i386 ELFs (native.ts): KMC GCC, GCC 2.7.2 and CodeWarrior. The same store
// agbcc.ts uses (`candCache`), with its namespace measured over everything such a compile reads:
//
//   - where it runs: natively, or in a container whose image is named by its CONTENT ID. A tag is
//     whatever was last built under it, and the pool container keeps running the image it started
//     from after the tag moves, so the namespace takes the tag's ID and refuses when the pool runs
//     another one. A compile after which this process confirmed or started that pool reads the ID
//     again, and one that moved ends the use of every store on that pool for the process. A
//     one-shot `docker run` reads the tag afresh each time, so a compile that took one is never
//     stored, and a namespace whose probe took one is refused;
//   - the compiler directory mounted into the container (or run from on the host), by content;
//   - every word of the command, the text written ahead of every TU, the compile environment (none
//     at all is cached while it moves where a GCC driver finds its programs or specs), and
//     every host command the pipeline runs (the preprocessor, a native runner) followed to the
//     files that actually run;
//   - the harness files whose code shapes the TU, the command or a stored rejection's message;
//   - the pipeline's own object for a fixed probe, compiled twice.
// And per key, what the TU reads besides its own bytes (@asmlift/cli/candcache-reads): what its text
// decides before the store is asked, and what the compile's preprocessor reports once it has run.
import {
  COMPILE_ENV,
  type CandCache,
  NOT_CACHEABLE,
  STAMP_PROBE,
  candCache,
  isChainMeasurement,
  noteKeyRefused,
  refuseDriverSearchEnv,
  toolchainFileChain,
} from '@asmlift/cli/candcache';
import { type PreprocessorReport, candidateCacheRefusal, candidateReadsRefusal } from '@asmlift/cli/candcache-reads';
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { oneShots, poolStarts } from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIAGNOSTIC_SOURCES, READS_SOURCE } from './util';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLCHAINS_SRC = join(HERE, '../../../../packages/toolchains/src');
/** The harness files every containerized candidate compile runs through: this one, the spawn and
 *  diagnostic helpers, the module that decides which answers are kept, and @asmlift/toolchains'
 *  compile, native-or-container decision and toolchain table. */
export const DOCKER_COMPILE_SOURCES = [
  join(HERE, 'docker-cache.ts'),
  ...DIAGNOSTIC_SOURCES,
  READS_SOURCE,
  join(TOOLCHAINS_SRC, 'compile.ts'),
  join(TOOLCHAINS_SRC, 'native.ts'),
  join(TOOLCHAINS_SRC, 'toolchain.ts'),
];

export interface DockerCacheSpec {
  /** the store's label: one per pipeline, since two pipelines compile one TU differently */
  label: string;
  /** whether this process runs the compiler on the host (native.ts) rather than in the container */
  native: () => boolean;
  docker: string;
  image: string;
  /** the pooled container a containerized compile runs in */
  pool: string;
  /** host directories the compile reads: mounted into the container, or run from natively */
  dirs: readonly string[];
  /** every word of the compile besides its scratch file names: harness words, flags, dialect */
  words: readonly string[];
  /** the text the pipeline writes ahead of every candidate TU */
  prelude: string;
  /** host commands the pipeline runs, by name or path: the preprocessor, a native runner */
  hostCommands: readonly string[];
  /** the harness files whose code shapes the TU or the command */
  sources: readonly string[];
  /** whether a throw is the compiler refusing the text, and so may be stored */
  refused: (e: unknown) => e is CompilerRejection;
  /** whether the compiler hands inline asm to a GNU assembler */
  gnuAs: boolean;
}

/** A compile behind the store: the object's path, after recording in `seen` what its preprocessor
 *  reported, if it runs one on the host and it ran to the end. */
export type RawCompile = (tu: string, sym: string, seen: { report?: PreprocessorReport }) => string;

/** A docker command's answer: stdout when it succeeded, else what it said on stderr (Docker 29 prints
 *  a bare newline on stdout for a container that is not there, and the error on stderr). */
const inspect = (docker: string, args: readonly string[]): { ok: boolean; out: string } => {
  const r = spawnSync(docker, [...args], { encoding: 'utf8', timeout: 60_000 });
  const ok = r.status === 0;
  return { ok, out: ((ok ? r.stdout : r.stderr) || String(r.error ?? '')).trim() };
};

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The content ID of the image a containerized compile runs: the tag's, which a pool container
 *  already running must also be running. Throws (the store refuses) when the tag cannot be read or
 *  the pool runs another image. */
function containerImageId(docker: string, image: string, pool: string): string {
  const tagged = inspect(docker, ['image', 'inspect', '--format', '{{.Id}}', image]);
  if (!tagged.ok || !IMAGE_ID.test(tagged.out)) {
    throw new Error(`docker image inspect ${image}: ${tagged.out}`);
  }
  const running = inspect(docker, ['container', 'inspect', '--format', '{{.Image}}', pool]);
  if (!running.ok && !/No such (?:container|object)/i.test(running.out)) {
    throw new Error(`docker container inspect ${pool}: ${running.out}`);
  }
  if (running.ok && running.out !== tagged.out) {
    throw new Error(
      `the pool container ${pool} runs ${running.out.slice(0, 19)}, but ${image} now names ` +
        `${tagged.out.slice(0, 19)}: its compiles are not the tag's. Remove it (docker rm -f ${pool}) to restart it`,
    );
  }
  return tagged.out;
}

const treeDigests = new Map<string, string>();
/** Every file under `dir`, by path relative to it and by content, links followed. */
function treeDigest(dir: string): string {
  const root = realpathSync(dir);
  const known = treeDigests.get(root);
  if (known !== undefined) {
    return known;
  }
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) {
        walk(p);
      } else if (s.isFile()) {
        h.update(`file:${relative(root, p)}:`);
        h.update(createHash('sha256').update(readFileSync(p)).digest('hex'));
      }
    }
  };
  walk(root);
  const digest = h.digest('hex');
  treeDigests.set(root, digest);
  return digest;
}

/** What the pipeline's compiles run on now: the host, or the content ID of a container image. */
export const runsOn = (spec: DockerCacheSpec): string =>
  spec.native() ? 'native' : `container:${containerImageId(spec.docker, spec.image, spec.pool)}`;

/** The namespace's static half: everything but the probe's own object. Throws where an input
 *  cannot be read, which `candCache` turns into a refusal. */
export function dockerStaticStamp(spec: DockerCacheSpec, runs = runsOn(spec)): string {
  const h = createHash('sha256');
  h.update(`${spec.label}/v1`);
  h.update(`runs:${runs}`);
  for (const d of spec.dirs) {
    h.update(`dir:${treeDigest(d)}`);
  }
  h.update(`words:${JSON.stringify(spec.words)}`);
  h.update(`prelude:${JSON.stringify(spec.prelude)}`);
  for (const v of COMPILE_ENV) {
    h.update(`env:${v}=${process.env[v] ?? ''}`);
  }
  // Files by BASENAME and content, as agbcc.ts's namespace hashes them, so two worktrees holding the
  // same bytes share a store.
  for (const p of [...spec.hostCommands.flatMap((c) => toolchainFileChain(c)), ...spec.sources]) {
    if (isChainMeasurement(p)) {
      h.update(`measured:${p}`);
      continue;
    }
    h.update(`file:${basename(p)}`);
    h.update(createHash('sha256').update(readFileSync(p)).digest('hex'));
  }
  return h.digest('hex');
}

/** `bytes` with the random suffix of the scratch directory `dir`, wherever they spell it, rewritten
 *  to a fixed one of the same length; undefined when they do not spell it. KMC GCC and GCC 2.7.2
 *  write the source's absolute path into the object, and that directory is a fresh `mkdtemp` per
 *  compile, so those bytes are arbitrary already and no score reads them. */
function scrubbed(bytes: Buffer, dir: string): Buffer | undefined {
  const suffix = /-([^-]+)$/.exec(dir);
  const from = Buffer.from(dir);
  let at = suffix === null ? -1 : bytes.indexOf(from);
  if (suffix === null || at < 0) {
    return undefined;
  }
  const out = Buffer.from(bytes);
  const to = Buffer.from(dir.slice(0, dir.length - suffix[1].length) + 'X'.repeat(suffix[1].length));
  while (at >= 0) {
    to.copy(out, at);
    at = out.indexOf(from, at + to.length);
  }
  return out;
}

/** The object's bytes as the store keeps them (see `scrubbed`). */
export function scrubScratchDir(objPath: string): Buffer {
  const bytes = readFileSync(objPath);
  return scrubbed(bytes, basename(dirname(objPath))) ?? bytes;
}

/** A file holding `scrubScratchDir(objPath)`: the object itself, or a copy beside it. The compiler's
 *  file is only read, since a container running as root leaves it root-owned. */
function scrubbedFile(objPath: string): string {
  const bytes = scrubbed(readFileSync(objPath), basename(dirname(objPath)));
  if (bytes === undefined) {
    return objPath;
  }
  const copy = join(dirname(objPath), `scrubbed-${basename(objPath)}`);
  writeFileSync(copy, bytes);
  return copy;
}

/** Per pool container, what this process saw it run: the image its first namespace was measured
 *  on, the pool starts read since, and whether it has run another image since. Shared by every
 *  store whose compiles run in that pool. */
const pools = new Map<string, { runs: string; starts: number; moved: boolean }>();

/** Whether the pool `spec` compiles in has run another image than the one this process first
 *  measured it on, reading it again after any pool start since the last read. */
function poolMoved(spec: DockerCacheSpec): boolean {
  const p = pools.get(spec.pool);
  if (p === undefined || p.moved) {
    return p?.moved ?? false;
  }
  const starts = poolStarts(spec.pool);
  if (starts !== p.starts) {
    p.starts = starts;
    try {
      p.moved = runsOn(spec) !== p.runs;
    } catch {
      // an image that cannot be read now is not the one the namespace read
      p.moved = true;
    }
  }
  return p.moved;
}

/** `raw` behind the store: the same objects (scratch suffix aside, see `scrubScratchDir`) and the
 *  same rejections, compiled once. agbcc.ts `compileCandidate`'s steps, and a compile stored only
 *  when it ran in the pool or natively, on what the namespace was measured on, and read nothing
 *  its key does not hold. */
export function dockerCached(spec: DockerCacheSpec, raw: RawCompile): (tu: string, sym: string) => string {
  let cache: CandCache | undefined;
  const cacheNow = (): CandCache =>
    (cache ??= candCache(spec.label, () => {
      refuseDriverSearchEnv();
      // The probe first: a pool container it starts is then there for `containerImageId` to read.
      const before = oneShots();
      const probe = (): string | null => {
        try {
          return createHash('sha256')
            .update(scrubScratchDir(raw(STAMP_PROBE, 'asmlift_candcache_stamp', {})))
            .digest('hex');
        } catch {
          return null;
        }
      };
      const a = probe();
      const b = probe();
      if (a === null || b === null || a !== b) {
        return NOT_CACHEABLE;
      }
      if (oneShots() !== before) {
        throw new Error(`${spec.label}: the probe compiled in a one-shot docker run, which reads the image tag afresh`);
      }
      const runs = runsOn(spec);
      const p = pools.get(spec.pool);
      if (p === undefined) {
        pools.set(spec.pool, { runs, starts: poolStarts(spec.pool), moved: false });
      } else if (poolMoved(spec) || p.runs !== runs) {
        p.moved = true;
        throw new Error(`${spec.label}: ${MOVED}`);
      }
      return createHash('sha256').update(dockerStaticStamp(spec, runs)).update(a).digest('hex');
    }));
  /** The reason the compile that ran since `oneShotsBefore` may not be stored, or undefined. */
  const unstorable = (tu: string, seen: { report?: PreprocessorReport }, oneShotsBefore: number) =>
    poolMoved(spec)
      ? MOVED
      : oneShots() !== oneShotsBefore
        ? ONE_SHOT
        : candidateReadsRefusal(tu, { report: seen.report, gnuAs: spec.gnuAs, command: spec.words.join(' ') });
  return (tu, sym) => {
    const c = cacheNow();
    const refusal = candidateCacheRefusal(tu) ?? (poolMoved(spec) ? MOVED : undefined);
    if (refusal !== undefined || c.mode === 'off') {
      if (refusal !== undefined && c.mode !== 'off') {
        noteKeyRefused(spec.label, refusal);
      }
      return raw(tu, sym, {});
    }
    if (c.mode === 'on') {
      const hit = c.get(tu, sym);
      if (typeof hit === 'string') {
        return hit;
      }
      if (hit instanceof Error) {
        throw hit;
      }
    }
    c.warm();
    const before = oneShots();
    const seen: { report?: PreprocessorReport } = {};
    try {
      const o = raw(tu, sym, seen);
      const off = unstorable(tu, seen, before);
      if (off !== undefined) {
        noteKeyRefused(spec.label, off);
        c.abandonAudit(tu, sym);
        return o;
      }
      const kept = scrubbedFile(o);
      c.verify(tu, sym, kept);
      return c.put(tu, sym, kept);
    } catch (e) {
      if (spec.refused(e)) {
        const off = unstorable(tu, seen, before);
        if (off === undefined) {
          c.verifyFail(tu, sym, e);
          c.putFail(tu, sym, e);
          throw e;
        }
        noteKeyRefused(spec.label, off);
      }
      // Not the compiler's located verdict on this key where the namespace was measured: never
      // stored, and a key the sampled audit withheld gets its stored answer back, as an unaudited
      // run would have been served.
      const held = c.abandonAudit(tu, sym);
      if (typeof held === 'string') {
        return held;
      }
      if (held instanceof Error) {
        throw held;
      }
      throw e;
    }
  };
}

const MOVED = 'the-image-moved-under-this-process';
const ONE_SHOT = 'compiled-in-a-one-shot-docker-run';

/** One `dockerCached` per namespace key, made on first use. */
export function dockerCachedBy<K extends readonly unknown[]>(
  specFor: (...key: K) => DockerCacheSpec,
  rawFor: (...key: K) => RawCompile,
): (...key: K) => (tu: string, sym: string) => string {
  const made = new Map<string, (tu: string, sym: string) => string>();
  return (...key) => {
    const k = JSON.stringify(key);
    let f = made.get(k);
    if (f === undefined) {
      f = dockerCached(specFor(...key), rawFor(...key));
      made.set(k, f);
    }
    return f;
  };
}

/** What, besides a located error, says the compiler itself did not finish: a killed or crashed
 *  `cc1`, or one out of memory. Its verdict on the text is unknown, so it is never stored. */
const GCC_DID_NOT_FINISH = /fatal signal|Internal compiler error|virtual memory exhausted|out of memory/i;

/** A gcc rejection the store may keep: the compiler located an ERROR in the candidate's `.i`/`.c`
 *  (old gcc writes an error with no `error:` word, a warning with `warning:`), and nothing says it
 *  was cut short. A located warning beside a failure elsewhere (the assembler unable to write the
 *  object) is not a verdict on the candidate. */
export const gccRefused = (e: unknown): e is CompilerRejection =>
  e instanceof CompilerRejection &&
  /(?:^|[\s/])(?:c\.i|cand\.c):\d+: (?!warning: )/m.test(e.diagnostic) &&
  !GCC_DID_NOT_FINISH.test(e.diagnostic);

/** The one line mwcceppc writes outside its `#` reports when it stops on an error. */
const MWCC_ABORTED = 'Errors caused tool to abort.';

/** A CodeWarrior rejection the store may keep: the output is the compiler's reports and nothing else
 *  (a line of anyone else's, a crashed emulator's say, means it did not finish), every report is the
 *  compiler's own (`### mwcceppc.exe Compiler:`, never its driver's or its usage errors, which are
 *  about files and the command line), the reports name the candidate's source, and every one that
 *  is an error points at a source line. */
export function mwccRefused(e: unknown): e is CompilerRejection {
  if (!(e instanceof CompilerRejection)) {
    return false;
  }
  const text = e.diagnostic.replaceAll('\r', '');
  const reports = text.split(/^(?=### )/m).filter((r) => r.startsWith('### '));
  const errors = reports.filter((r) => /^#\s*Error:/m.test(r));
  return (
    errors.length > 0 &&
    text.split('\n').every((l) => l.trim() === '' || l.startsWith('#') || l.trim() === MWCC_ABORTED) &&
    reports.every((r) => r.startsWith('### mwcceppc.exe Compiler:\n')) &&
    /^#\s+(?:File|From): .*[\\/](?:c|cand)\.(?:c|cp)$/m.test(text) &&
    errors.every((r) => /^#\s+\d+: /m.test(r))
  );
}
