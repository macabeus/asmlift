// The candidate store for the three toolchains that compile in a linux/386 container, or natively
// on a host that runs i386 ELFs (native.ts): KMC GCC, GCC 2.7.2 and CodeWarrior. The same store
// agbcc.ts uses (`candCache`), with its namespace measured over everything such a compile reads:
//
//   - where it runs: natively, or in a container whose image is named by its CONTENT ID. A tag is
//     whatever was last built under it, and the pool container keeps running the image it started
//     from after the tag moves, so the namespace takes the tag's ID and refuses when the pool runs
//     another one;
//   - the compiler directory mounted into the container (or run from on the host), by content;
//   - every word of the command, the compile environment, and every host command the pipeline
//     runs (the preprocessor, a native runner) followed to the files that actually run;
//   - the harness files whose code shapes the TU or the command;
//   - the pipeline's own object for a fixed probe, compiled twice.
import {
  COMPILE_ENV,
  type CandCache,
  NOT_CACHEABLE,
  STAMP_PROBE,
  candCache,
  candidateCacheRefusal,
  isChainMeasurement,
  noteKeyRefused,
  toolchainFileChain,
} from '@asmlift/cli/candcache';
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLCHAINS_SRC = join(HERE, '../../../../packages/toolchains/src');
/** The harness files every containerized candidate compile runs through: this one, the spawn
 *  helpers, and @asmlift/toolchains' compile, native-or-container decision and toolchain table. */
export const DOCKER_COMPILE_SOURCES = [
  join(HERE, 'docker-cache.ts'),
  join(HERE, 'util.ts'),
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
  /** host commands the pipeline runs, by name or path: the preprocessor, a native runner */
  hostCommands: readonly string[];
  /** the harness files whose code shapes the TU or the command */
  sources: readonly string[];
  /** whether a throw is the compiler refusing the text, and so may be stored */
  refused: (e: unknown) => e is CompilerRejection;
}

const inspect = (docker: string, args: readonly string[]): { ok: boolean; out: string } => {
  const r = spawnSync(docker, [...args], { encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout || r.stderr || String(r.error ?? '')).trim() };
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

/** The namespace's static half: everything but the probe's own object. Throws where an input
 *  cannot be read, which `candCache` turns into a refusal. */
export function dockerStaticStamp(spec: DockerCacheSpec): string {
  const h = createHash('sha256');
  h.update(`${spec.label}/v1`);
  h.update(spec.native() ? 'runs:native' : `runs:container:${containerImageId(spec.docker, spec.image, spec.pool)}`);
  for (const d of spec.dirs) {
    h.update(`dir:${treeDigest(d)}`);
  }
  h.update(`words:${JSON.stringify(spec.words)}`);
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

/** Rewrite the random suffix of the object's scratch directory, wherever the object spells it, to a
 *  fixed one of the same length, in place. KMC GCC and GCC 2.7.2 write the source's absolute path
 *  into the object, and that directory is a fresh `mkdtemp` per compile, so those bytes are
 *  arbitrary already and no score reads them. */
export function scrubScratchDir(objPath: string): Buffer {
  const dir = basename(dirname(objPath));
  const bytes = readFileSync(objPath);
  const suffix = /-([^-]+)$/.exec(dir);
  if (suffix === null) {
    return bytes;
  }
  const from = Buffer.from(dir);
  const to = Buffer.from(dir.slice(0, dir.length - suffix[1].length) + 'X'.repeat(suffix[1].length));
  let at = bytes.indexOf(from);
  if (at < 0) {
    return bytes;
  }
  while (at >= 0) {
    to.copy(bytes, at);
    at = bytes.indexOf(from, at + to.length);
  }
  writeFileSync(objPath, bytes);
  return bytes;
}

/** `raw` behind the store: the same objects (scratch suffix aside, see `scrubScratchDir`) and the
 *  same rejections, compiled once. Follows agbcc.ts `compileCandidate` step for step. */
export function dockerCached(
  spec: DockerCacheSpec,
  raw: (tu: string, sym: string) => string,
): (tu: string, sym: string) => string {
  let cache: CandCache | undefined;
  const cacheNow = (): CandCache =>
    (cache ??= candCache(spec.label, () => {
      // The probe first: a pool container it starts is then there for `containerImageId` to read.
      const probe = (): string | null => {
        try {
          return createHash('sha256')
            .update(scrubScratchDir(raw(STAMP_PROBE, 'asmlift_candcache_stamp')))
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
      return createHash('sha256').update(dockerStaticStamp(spec)).update(a).digest('hex');
    }));
  return (tu, sym) => {
    const c = cacheNow();
    const refusal = candidateCacheRefusal(tu);
    if (refusal !== undefined || c.mode === 'off') {
      if (refusal !== undefined && c.mode !== 'off') {
        noteKeyRefused(spec.label, refusal);
      }
      return raw(tu, sym);
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
    try {
      const o = raw(tu, sym);
      scrubScratchDir(o);
      c.verify(tu, sym, o);
      return c.put(tu, sym, o);
    } catch (e) {
      if (spec.refused(e)) {
        c.verifyFail(tu, sym, e);
        c.putFail(tu, sym, e);
        throw e;
      }
      // Not the compiler's located verdict: never stored, and a key the sampled audit withheld gets
      // its stored answer back, as an unaudited run would have been served.
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

/** One `dockerCached` per namespace key, made on first use. */
export function dockerCachedBy<K extends readonly unknown[]>(
  specFor: (...key: K) => DockerCacheSpec,
  rawFor: (...key: K) => (tu: string, sym: string) => string,
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

/** A CodeWarrior rejection the store may keep: every report is the compiler's own (`### mwcceppc.exe
 *  Compiler:`, never its driver's or its usage errors, which are about files and the command line),
 *  the reports name the candidate's source, and every one that is an error points at a source line. */
export function mwccRefused(e: unknown): e is CompilerRejection {
  if (!(e instanceof CompilerRejection)) {
    return false;
  }
  const reports = e.diagnostic
    .replaceAll('\r', '')
    .split(/^(?=### )/m)
    .filter((r) => r.startsWith('### '));
  const errors = reports.filter((r) => /^#\s*Error:/m.test(r));
  return (
    errors.length > 0 &&
    reports.every((r) => r.startsWith('### mwcceppc.exe Compiler:\n')) &&
    /^#\s+(?:File|From): .*[\\/](?:c|cand)\.(?:c|cp)$/m.test(e.diagnostic.replaceAll('\r', '')) &&
    errors.every((r) => /^#\s+\d+: /m.test(r))
  );
}
