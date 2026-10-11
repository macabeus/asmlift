// The candidate store for the containerized toolchains (compile/docker-cache.ts): what it keys a
// namespace on, what it may treat as one object, and which refusals it may keep.
//
// Every compile here is a real one, through the pipeline the benchmark runs: GCC 2.7.2 in its pooled
// linux/386 container, CodeWarrior through wibo in its image. The transient failures are real too:
// the compiler is pointed at an object path it cannot write, which is the shape a lost scratch
// directory or a full disk gives.
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import {
  GCC272_TOOLCHAIN,
  MWCC_PPC_TOOLCHAIN,
  gcc272Available,
  gcc272Compile,
  gcc272Native,
  ppcCompile,
  ppcDockerAvailable,
} from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  type DockerCacheSpec,
  dockerStaticStamp,
  gccRefused,
  mwccRefused,
  scrubScratchDir,
} from '../src/compile/docker-cache';
import { canonicalCodegen } from '../src/toolchains';

/** A compile in the container costs seconds, and several of them on a loaded machine. */
const CONTAINER_BUDGET = 240_000;

const GCC272_FLAGS = canonicalCodegen('gcc2.7.2').cflags;
const MWCC_FLAGS = canonicalCodegen('mwcc_242_81').cflags;
const HAVE_GCC272 = gcc272Available() && !gcc272Native();
const HAVE_MWCC = ppcDockerAvailable('mwcc_242_81');

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});
const scratch = (prefix: string, under = tmpdir()): string => {
  const d = mkdtempSync(join(under, prefix));
  roots.push(d);
  return d;
};

type Stats = Record<string, number>;

/** candcache.ts reads its environment once, at module load: each call is a fresh process's worth of
 *  modules over `store`, with the audit off unless `sample` says otherwise. */
async function asRun<T>(
  store: string,
  env: Record<string, string>,
  fn: (m: {
    gcc272: typeof import('../src/compile/gcc272');
    mwcc: typeof import('../src/compile/mwcc');
    cache: typeof import('../src/compile/docker-cache');
    toolchains: typeof import('@asmlift/toolchains');
  }) => T,
): Promise<{ value: T; stats: Stats }> {
  const all = { ASMLIFT_CANDCACHE: 'on', ASMLIFT_CANDCACHE_DIR: store, ASMLIFT_CANDCACHE_SAMPLE: '0', ...env };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  Object.assign(process.env, all);
  vi.resetModules();
  try {
    const value = fn({
      gcc272: await import('../src/compile/gcc272'),
      mwcc: await import('../src/compile/mwcc'),
      cache: await import('../src/compile/docker-cache'),
      toolchains: await import('@asmlift/toolchains'),
    });
    return { value, stats: (await import('@asmlift/cli/candcache')).cacheStats() };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    vi.resetModules();
  }
}

/** The thrown error of `f`, which must throw. */
const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
};

const docker = (args: string[]): string => {
  const r = spawnSync(MWCC_PPC_TOOLCHAIN.docker, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`docker ${args.join(' ')}: ${r.stderr}`);
  }
  return r.stdout.trim();
};

const OK_TU = 'int f(int a) { return a * 3 + 1; }\n';
const REFUSED_TU = 'int f(void) { return undeclared_x; }\n';
/** Compiles with a located WARNING under GCC 2.7.2 (there is no `-w` in its harness words). */
const WARNING_TU = 'int f(int *p) { int a = p; return a; }\n';

/** GCC 2.7.2 on `tu` in a fresh /tmp scratch directory, writing the object to `out`. `compile` is
 *  the one a run's own module registry holds where its rejection must be that registry's class. */
function gcc272In(tu: string, out = 'c.o', compile = gcc272Compile): string {
  const dir = mkdtempSync(join('/tmp', 'bench-cand-'));
  roots.push(dir);
  writeFileSync(join(dir, 'c.i'), tu);
  compile(dir, 'c.i', out, GCC272_FLAGS);
  return join(dir, out);
}

/** CodeWarrior 2.4.2b81 on `tu` the same way, with every warning on. */
function mwccIn(tu: string, out = 'c.o'): string {
  const dir = mkdtempSync(join('/tmp', 'bench-ppc-cand-'));
  roots.push(dir);
  writeFileSync(join(dir, 'c.c'), tu);
  ppcCompile('mwcc_242_81', dir, 'c.c', out, [...MWCC_FLAGS, '-w', 'all'], false);
  return join(dir, out);
}

describe('the namespace takes the compiler directory by content', () => {
  // `native` is true so nothing here asks Docker for an image; the directory half is what is read.
  const spec = (dir: string): DockerCacheSpec => ({
    label: 'test-dirs',
    native: () => true,
    docker: 'docker',
    image: 'unused',
    pool: 'unused',
    dirs: [dir],
    words: ['-O1'],
    hostCommands: [],
    sources: [],
    refused: gccRefused,
  });

  test('two copies of one directory are one namespace, and an edit inside it is another', () => {
    const a = scratch('dockercache-dir-');
    mkdirSync(join(a, 'lib'));
    writeFileSync(join(a, 'gcc'), 'driver v1');
    writeFileSync(join(a, 'lib', 'cc1'), 'cc1 v1');
    const b = scratch('dockercache-dir-');
    cpSync(a, b, { recursive: true });
    expect(dockerStaticStamp(spec(a))).toBe(dockerStaticStamp(spec(b)));

    // A fresh process: the digest of a directory is computed once per process.
    const c = scratch('dockercache-dir-');
    cpSync(a, c, { recursive: true });
    writeFileSync(join(c, 'lib', 'cc1'), 'cc1 v2');
    expect(dockerStaticStamp(spec(c))).not.toBe(dockerStaticStamp(spec(a)));
  });

  test('every word of the command is in it', () => {
    const a = scratch('dockercache-dir-');
    writeFileSync(join(a, 'gcc'), 'driver');
    expect(dockerStaticStamp({ ...spec(a), words: ['-O2'] })).not.toBe(dockerStaticStamp(spec(a)));
  });
});

describe.runIf(HAVE_GCC272)('GCC 2.7.2 in its container', () => {
  test(
    'two compiles of one TU differ only in the scratch directory, and the rewrite makes them equal',
    () => {
      const a = gcc272In(OK_TU);
      const b = gcc272In(OK_TU);
      expect(readFileSync(a).equals(readFileSync(b)), 'the object names its random directory').toBe(false);
      expect(readFileSync(a).includes(basename(dirname(a)))).toBe(true);
      const scrubbed = scrubScratchDir(a);
      expect(scrubbed.equals(scrubScratchDir(b))).toBe(true);
      expect(scrubbed.includes('bench-cand-XXXXXX')).toBe(true);
      expect(readFileSync(a).equals(scrubbed), 'the object on disk is the rewritten one').toBe(true);
    },
    CONTAINER_BUDGET,
  );

  test(
    'keeps an error the compiler located in the candidate',
    () => {
      const e = thrown(() => gcc272In(REFUSED_TU));
      expect(e).toBeInstanceOf(CompilerRejection);
      expect(gccRefused(e)).toBe(true);
    },
    CONTAINER_BUDGET,
  );

  test(
    'does not keep a located warning beside an object it could not write',
    () => {
      const e = thrown(() => gcc272In(WARNING_TU, 'missing/c.o'));
      expect(e).toBeInstanceOf(CompilerRejection);
      const diagnostic = (e as CompilerRejection).diagnostic;
      expect(diagnostic).toMatch(/c\.i:1: warning: /);
      expect(diagnostic).not.toMatch(/c\.i:\d+: (?!warning: )/);
      expect(gccRefused(e)).toBe(false);
    },
    CONTAINER_BUDGET,
  );

  test(
    'does not keep what the daemon says about a container that is not there',
    () => {
      const r = spawnSync(GCC272_TOOLCHAIN.docker, ['exec', 'asmlift-test-no-such-container', '/gcc272/gcc'], {
        encoding: 'utf8',
      });
      expect(r.status).not.toBe(0);
      expect(gccRefused(new CompilerRejection(`gcc 2.7.2 (docker) failed: ${r.stderr}`, r.stderr))).toBe(false);
    },
    CONTAINER_BUDGET,
  );

  test(
    'serves warm what it compiled cold, and its sampled audit agrees with a fresh compile',
    async () => {
      const store = scratch('dockercache-store-');
      const compileBoth = ({ gcc272 }: { gcc272: typeof import('../src/compile/gcc272') }) => {
        const obj = readFileSync(gcc272.gcc272Real.compileCandidate(OK_TU, 'f', GCC272_FLAGS, 'c'));
        const refusal = thrown(() => gcc272.gcc272Real.compileCandidate(REFUSED_TU, 'f', GCC272_FLAGS, 'c'));
        // this run's own module registry: its CompilerRejection is not the one imported above
        return { obj, message: (refusal as Error).message, thrownAs: (refusal as Error).constructor.name };
      };
      const cold = await asRun(store, {}, compileBoth);
      expect(cold.stats).toMatchObject({ stored: 1, failStored: 1 });
      expect(cold.value.thrownAs).toBe('CompilerRejection');

      const warm = await asRun(store, {}, compileBoth);
      expect(warm.stats).toMatchObject({ hit: 1, failHit: 1 });
      expect(warm.stats.miss).toBeUndefined();
      expect(warm.value.obj.equals(cold.value.obj)).toBe(true);
      expect(warm.value).toMatchObject({ message: cold.value.message, thrownAs: 'CompilerRejection' });

      // Every key withheld and compiled afresh: the stored object agrees with a new compile in a
      // new scratch directory, so the audit can look at this store at all.
      const audited = await asRun(store, { ASMLIFT_CANDCACHE_SAMPLE: '100' }, compileBoth);
      expect(audited.stats).toMatchObject({ sampled: 2, verified: 1, verifiedFail: 1 });
      expect(audited.stats.mismatch).toBeUndefined();
      expect(audited.value.obj.equals(cold.value.obj)).toBe(true);
    },
    CONTAINER_BUDGET,
  );

  test(
    'never stores a failure that is not a located refusal, and compiles that key again',
    async () => {
      const store = scratch('dockercache-store-');
      let compiles = 0;
      const run = ({
        cache,
        toolchains,
      }: {
        cache: typeof import('../src/compile/docker-cache');
        toolchains: typeof import('@asmlift/toolchains');
      }) => {
        const compile = cache.dockerCached(
          {
            label: 'test-unwritable',
            native: toolchains.gcc272Native,
            docker: toolchains.GCC272_TOOLCHAIN.docker,
            image: toolchains.GCC272_TOOLCHAIN.image,
            pool: toolchains.gcc272PoolCfg().name,
            dirs: [toolchains.GCC272_TOOLCHAIN.dir],
            words: [...toolchains.GCC272_TOOLCHAIN.harnessFlags, ...GCC272_FLAGS],
            hostCommands: [],
            sources: [],
            refused: cache.gccRefused,
          },
          // The candidate's object path cannot be written; the probe's can.
          (tu) => {
            compiles += tu === WARNING_TU ? 1 : 0;
            return gcc272In(tu, tu === WARNING_TU ? 'missing/c.o' : 'c.o', toolchains.gcc272Compile);
          },
        );
        return thrown(() => compile(WARNING_TU, 'f'));
      };
      const first = await asRun(store, {}, run);
      expect((first.value as Error).constructor.name).toBe('CompilerRejection');
      expect(first.stats.failStored).toBeUndefined();
      const second = await asRun(store, {}, run);
      expect((second.value as Error).constructor.name).toBe('CompilerRejection');
      expect(second.stats.failHit).toBeUndefined();
      expect(compiles, 'the second run compiled the candidate itself').toBe(2);
    },
    CONTAINER_BUDGET,
  );

  test(
    'a retagged image misses the store: the namespace is the image content, not its tag',
    async () => {
      const suffix = `${process.pid}-${Date.now()}`;
      const tag = `asmlift-test-retag:${suffix}`;
      const other = `asmlift-test-retag-other:${suffix}`;
      const base = GCC272_TOOLCHAIN.image;
      let pool: string | undefined;
      const store = scratch('dockercache-store-');
      const run = ({
        gcc272,
        toolchains,
      }: {
        gcc272: typeof import('../src/compile/gcc272');
        toolchains: typeof import('@asmlift/toolchains');
      }) => {
        pool = toolchains.gcc272PoolCfg().name;
        return gcc272.gcc272Real.compileCandidate(OK_TU, 'f', GCC272_FLAGS, 'c');
      };
      const onTag = { ASMLIFT_GCC272_IMAGE: tag };
      try {
        // Another image whose compiles are byte-identical: only its content ID tells the two apart.
        const created = docker(['create', '--platform', 'linux/386', base, 'true']);
        docker(['commit', '-c', `LABEL asmlift.test=${suffix}`, created, other]);
        docker(['rm', created]);
        docker(['tag', base, tag]);

        expect((await asRun(store, onTag, run)).stats).toMatchObject({ stored: 1 });
        expect((await asRun(store, onTag, run)).stats).toMatchObject({ hit: 1 });

        docker(['tag', other, tag]);
        // The pool container still runs the image the tag named when it started: refused, not served.
        const stale = await asRun(store, onTag, run);
        expect(stale.stats).toMatchObject({ refused: 1 });
        expect(stale.stats.hit).toBeUndefined();

        docker(['rm', '-f', pool!]);
        const moved = await asRun(store, onTag, run);
        expect(moved.stats).toMatchObject({ miss: 1, stored: 1 });
        expect(moved.stats.hit).toBeUndefined();
        expect(readdirSync(join(store, 'ns')), 'one namespace per image').toHaveLength(2);
      } finally {
        if (pool !== undefined) {
          spawnSync(GCC272_TOOLCHAIN.docker, ['rm', '-f', pool]);
        }
        spawnSync(GCC272_TOOLCHAIN.docker, ['rmi', tag, other]);
      }
    },
    CONTAINER_BUDGET,
  );
});

describe.runIf(HAVE_MWCC)('CodeWarrior in its container', () => {
  test(
    "keeps mwcceppc's own located error",
    () => {
      const e = thrown(() => mwccIn(REFUSED_TU));
      expect(e).toBeInstanceOf(CompilerRejection);
      expect((e as CompilerRejection).diagnostic).toMatch(/^### mwcceppc\.exe Compiler:/m);
      expect(mwccRefused(e)).toBe(true);
    },
    CONTAINER_BUDGET,
  );

  test(
    'does not keep located warnings beside an object it could not write',
    () => {
      const e = thrown(() => mwccIn('int g(int a) { int b; return a; }\n', 'missing/c.o'));
      expect(e).toBeInstanceOf(CompilerRejection);
      const diagnostic = (e as CompilerRejection).diagnostic;
      expect(diagnostic).toMatch(/^### mwcceppc\.exe Compiler:/m);
      expect(diagnostic).toMatch(/^# Warning:/m);
      expect(diagnostic).toMatch(/^### mwcceppc\.exe Driver Error:/m);
      expect(mwccRefused(e)).toBe(false);
    },
    CONTAINER_BUDGET,
  );

  test(
    'does not keep a usage error about a source that is not there',
    () => {
      const dir = scratch('bench-ppc-cand-', '/tmp');
      const e = thrown(() => ppcCompile('mwcc_242_81', dir, 'c.c', 'c.o', MWCC_FLAGS, false));
      expect((e as CompilerRejection).diagnostic).toMatch(/^### mwcceppc\.exe Usage Error:/m);
      expect(mwccRefused(e)).toBe(false);
    },
    CONTAINER_BUDGET,
  );

  test(
    'serves a stored refusal of the real tier warm, with the message a fresh compile gave',
    async () => {
      const store = scratch('dockercache-store-');
      const refuse = ({ mwcc }: { mwcc: typeof import('../src/compile/mwcc') }) =>
        (thrown(() => mwcc.mwccReal('mwcc_242_81').compileCandidate(REFUSED_TU, 'f', MWCC_FLAGS, 'c')) as Error)
          .message;
      const cold = await asRun(store, {}, refuse);
      expect(cold.stats).toMatchObject({ failStored: 1 });
      const warm = await asRun(store, {}, refuse);
      expect(warm.stats).toMatchObject({ failHit: 1 });
      expect(warm.value).toBe(cold.value);
    },
    CONTAINER_BUDGET,
  );
});
