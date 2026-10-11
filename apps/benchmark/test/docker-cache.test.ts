// The candidate store for the containerized toolchains (compile/docker-cache.ts): what it keys a
// namespace on, what it may treat as one object, and which refusals it may keep.
//
// Every compile here is a real one, through the pipeline the benchmark runs: GCC 2.7.2 in its pooled
// linux/386 container, CodeWarrior through wibo in its image. The transient failures are real too:
// the compiler is pointed at an object path it cannot write, which is the shape a lost scratch
// directory or a full disk gives.
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { C_TYPEDEFS } from '@asmlift/core/target';
import {
  GCC272_TOOLCHAIN,
  MWCC_PPC_TOOLCHAIN,
  gcc272Available,
  gcc272Compile,
  gcc272Native,
  gcc272PoolCfg,
  ppcCompile,
  ppcDockerAvailable,
} from '@asmlift/toolchains';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  type DockerCacheSpec,
  dockerStaticStamp,
  gccRefused,
  mwccRefused,
  runsOn,
  scrubScratchDir,
} from '../src/compile/docker-cache';
import { gcc272CacheSpec } from '../src/compile/gcc272';
import { kmcCacheSpec } from '../src/compile/kmc';
import { mwccCacheSpec } from '../src/compile/mwcc';
import { pooledKmcSpec, pooledMwccSpec } from '../src/decomp-config';
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

type RunModules = {
  cache: typeof import('../src/compile/docker-cache');
  toolchains: typeof import('@asmlift/toolchains');
};

/** GCC 2.7.2's container compile at its canonical flags, keyed as the real tier keys it, under `label`. */
const gcc272TestSpec = ({ cache, toolchains }: RunModules, label: string): DockerCacheSpec => ({
  label,
  native: toolchains.gcc272Native,
  docker: toolchains.GCC272_TOOLCHAIN.docker,
  image: toolchains.GCC272_TOOLCHAIN.image,
  pool: toolchains.gcc272PoolCfg().name,
  dirs: [toolchains.GCC272_TOOLCHAIN.dir],
  words: [...toolchains.GCC272_TOOLCHAIN.harnessFlags, ...GCC272_FLAGS],
  prelude: '',
  hostCommands: [],
  sources: [],
  refused: cache.gccRefused,
  gnuAs: true,
});

/** A private tag on GCC 2.7.2's image, and a second image whose compiles are byte-identical to it,
 *  so that only their content IDs tell the two apart; both, and the tag's pool, removed afterwards. */
async function withPrivateImage(
  fn: (t: {
    tag: string;
    other: string;
    onTag: Record<string, string>;
    poolOf: (m: RunModules) => string;
  }) => Promise<void>,
): Promise<void> {
  const suffix = `${process.pid}-${Date.now()}`;
  const tag = `asmlift-test-retag:${suffix}`;
  const other = `asmlift-test-retag-other:${suffix}`;
  const pools = new Set<string>();
  const created = docker(['create', '--platform', 'linux/386', GCC272_TOOLCHAIN.image, 'true']);
  docker(['commit', '-c', `LABEL asmlift.test=${suffix}`, created, other]);
  docker(['rm', created]);
  docker(['tag', GCC272_TOOLCHAIN.image, tag]);
  try {
    await fn({
      tag,
      other,
      onTag: { ASMLIFT_GCC272_IMAGE: tag },
      poolOf: (m) => {
        const pool = m.toolchains.gcc272PoolCfg().name;
        pools.add(pool);
        return pool;
      },
    });
  } finally {
    for (const pool of pools) {
      spawnSync(GCC272_TOOLCHAIN.docker, ['rm', '-f', pool]);
    }
    spawnSync(GCC272_TOOLCHAIN.docker, ['rmi', tag, other]);
  }
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
    prelude: '',
    hostCommands: [],
    sources: [],
    refused: gccRefused,
    gnuAs: true,
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

  test('the text written ahead of every TU is in it', () => {
    const a = scratch('dockercache-dir-');
    writeFileSync(join(a, 'gcc'), 'driver');
    expect(dockerStaticStamp({ ...spec(a), prelude: 'typedef int s32;\n' })).not.toBe(dockerStaticStamp(spec(a)));
  });

  test('the compile environment is in it', () => {
    const a = scratch('dockercache-dir-');
    writeFileSync(join(a, 'gcc'), 'driver');
    const unset = dockerStaticStamp(spec(a));
    const saved = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = '1';
    try {
      expect(dockerStaticStamp(spec(a))).not.toBe(unset);
    } finally {
      if (saved === undefined) {
        delete process.env.SOURCE_DATE_EPOCH;
      } else {
        process.env.SOURCE_DATE_EPOCH = saved;
      }
    }
  });
});

describe("each pipeline's key", () => {
  const CORE_DIAGNOSTICS = 'compiler-diagnostics.ts';
  // Read here without a compiler or a container: the compiler directories and host commands are
  // left out, everything else the spec names is hashed.
  const stamp = (spec: DockerCacheSpec): string => dockerStaticStamp({ ...spec, dirs: [], hostCommands: [] }, 'native');
  const pipelines: [string, (flags: readonly string[]) => DockerCacheSpec, string[], string, typeof gccRefused][] = [
    ['real-tier KMC GCC', kmcCacheSpec, ['kmc.ts', 'agbcc.ts', 'util.ts'], '', gccRefused],
    ['real-tier GCC 2.7.2', gcc272CacheSpec, ['gcc272.ts', 'agbcc.ts', 'util.ts'], '', gccRefused],
    ['real-tier CodeWarrior', (f) => mwccCacheSpec('mwcc_233_163n', f, 'c'), ['mwcc.ts', 'util.ts'], '', mwccRefused],
    ['pooled KMC GCC', pooledKmcSpec, ['compile.ts'], C_TYPEDEFS, gccRefused],
    ['pooled CodeWarrior', pooledMwccSpec, ['compile.ts'], C_TYPEDEFS, mwccRefused],
  ];

  test.each(pipelines)('%s: moves with the flags', (_name, specFor) => {
    expect(stamp(specFor(['-O1']))).not.toBe(stamp(specFor(['-O2'])));
  });

  test.each(pipelines)(
    "%s: hashes the harness files its TU and its stored messages pass through, core's diagnostics, and what decides which answers are kept",
    (_name, specFor, files) => {
      const sources = specFor([]).sources;
      for (const f of [...files, 'docker-cache.ts', CORE_DIAGNOSTICS, 'candcache-reads.ts']) {
        const hit = sources.find((p) => basename(p) === f);
        expect(hit, `${f} must be a namespace input`).toBeDefined();
        expect(existsSync(hit!)).toBe(true);
      }
    },
  );

  test.each(pipelines)('%s: keys the text it writes ahead of every candidate', (_name, specFor, _files, prelude) => {
    expect(specFor([]).prelude).toBe(prelude);
  });

  test.each(pipelines)("%s: stores only its compiler's located refusals", (_name, specFor, _f, _p, refused) => {
    expect(specFor([]).refused).toBe(refused);
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
      const onDisk = readFileSync(a);
      const scrubbed = scrubScratchDir(a);
      expect(scrubbed.equals(scrubScratchDir(b))).toBe(true);
      expect(scrubbed.includes('bench-cand-XXXXXX')).toBe(true);
      expect(readFileSync(a).equals(onDisk), "the compiler's file is only read").toBe(true);
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
      const run = (m: RunModules) => {
        const compile = m.cache.dockerCached(
          gcc272TestSpec(m, 'test-unwritable'),
          // The candidate's object path cannot be written; the probe's can.
          (tu) => {
            compiles += tu === WARNING_TU ? 1 : 0;
            return gcc272In(tu, tu === WARNING_TU ? 'missing/c.o' : 'c.o', m.toolchains.gcc272Compile);
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
    'stores an object it may only read, and leaves that file as the compiler wrote it',
    async () => {
      // A container running as root on a Linux host leaves the object root-owned: readable, not
      // writable. A read-only file is that here.
      const store = scratch('dockercache-store-');
      const run = (m: RunModules) => {
        const written: Buffer[] = [];
        const compile = m.cache.dockerCached(gcc272TestSpec(m, 'test-readonly'), (tu) => {
          const o = gcc272In(tu, 'c.o', m.toolchains.gcc272Compile);
          chmodSync(o, 0o444);
          written.push(readFileSync(o));
          return o;
        });
        const served = readFileSync(compile(OK_TU, 'f'));
        return { served, written };
      };
      const cold = await asRun(store, {}, run);
      expect(cold.stats).toMatchObject({ miss: 1, stored: 1 });
      expect(cold.stats.refused).toBeUndefined();
      const warm = await asRun(store, {}, run);
      expect(warm.stats).toMatchObject({ hit: 1 });
      expect(warm.value.served.equals(cold.value.served)).toBe(true);
    },
    CONTAINER_BUDGET,
  );

  test(
    'gives a key the audit withheld its stored answer back when the fresh compile fails',
    async () => {
      const store = scratch('dockercache-store-');
      let unwritable = false;
      const run = (m: RunModules) => {
        const compile = m.cache.dockerCached(gcc272TestSpec(m, 'test-abandon'), (tu) =>
          gcc272In(tu, unwritable && tu === OK_TU ? 'missing/c.o' : 'c.o', m.toolchains.gcc272Compile),
        );
        return readFileSync(compile(OK_TU, 'f'));
      };
      const cold = await asRun(store, {}, run);
      expect(cold.stats).toMatchObject({ stored: 1 });
      unwritable = true;
      const audited = await asRun(store, { ASMLIFT_CANDCACHE_SAMPLE: '100' }, run);
      expect(audited.stats).toMatchObject({ sampled: 1, sampledAbandoned: 1 });
      expect(audited.value.equals(cold.value)).toBe(true);
    },
    CONTAINER_BUDGET,
  );

  test.skipIf(process.env.ASMLIFT_DOCKER_POOL === '0')(
    'does not store a compile that took another route than its probe',
    async () => {
      const store = scratch('dockercache-store-');
      const run = (m: RunModules) => {
        const compile = m.cache.dockerCached(gcc272TestSpec(m, 'test-route'), (tu) => {
          if (tu !== OK_TU) {
            return gcc272In(tu, 'c.o', m.toolchains.gcc272Compile);
          }
          // The one-shot `docker run` a compile falls back to when its pool cannot be had.
          process.env.ASMLIFT_DOCKER_POOL = '0';
          try {
            return gcc272In(tu, 'c.o', m.toolchains.gcc272Compile);
          } finally {
            delete process.env.ASMLIFT_DOCKER_POOL;
          }
        });
        return readFileSync(compile(OK_TU, 'f'));
      };
      const first = await asRun(store, {}, run);
      expect(first.value.includes('/work/c.i'), 'the one-shot object names its mount').toBe(true);
      expect(first.stats).toMatchObject({ miss: 1, refusedKeys: 1 });
      expect(first.stats.stored).toBeUndefined();
      const second = await asRun(store, {}, run);
      expect(second.stats.hit).toBeUndefined();
    },
    CONTAINER_BUDGET,
  );

  test(
    'does not keep a located error from a compiler that was killed before it finished',
    () => {
      gcc272In(OK_TU); // the pool is up
      const pool = gcc272PoolCfg().name;
      const dir = scratch('bench-cand-', '/tmp');
      const input = `/host-tmp/${basename(dir)}/c.i`;
      // cc1 reads its TU from a FIFO whose writer sends a line with an error and then holds it open:
      // cc1 locates the error, waits for the rest, and is killed while it waits.
      docker(['exec', pool, 'mkfifo', input]);
      const writer = spawn(GCC272_TOOLCHAIN.docker, [
        'exec',
        pool,
        'sh',
        '-c',
        `{ printf 'int f(void) { return undeclared_x; }\\nint g(void) {\\n'; sleep 60; } > ${input}`,
      ]);
      const killer = spawn('sh', [
        '-c',
        `sleep 10; until ${GCC272_TOOLCHAIN.docker} exec ${pool} pkill -9 -f '/gcc272/cc1 .*${input}'; do sleep 1; done`,
      ]);
      try {
        const e = thrown(() => gcc272Compile(dir, 'c.i', 'c.o', GCC272_FLAGS));
        expect(e).toBeInstanceOf(CompilerRejection);
        const diagnostic = (e as CompilerRejection).diagnostic;
        expect(diagnostic).toMatch(/c\.i:1: `undeclared_x' undeclared/);
        expect(diagnostic).toMatch(/cc1 got fatal signal 9/);
        expect(gccRefused(e)).toBe(false);
      } finally {
        killer.kill();
        writer.kill();
        spawnSync(GCC272_TOOLCHAIN.docker, ['exec', pool, 'pkill', '-f', input]);
      }
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

        // The tag moves back and the pool restarts in the middle of one process: the compile that
        // ran in the restarted pool is not stored, and the store is not used again by that process.
        const midRun = await asRun(store, onTag, ({ gcc272 }: { gcc272: typeof import('../src/compile/gcc272') }) => {
          gcc272.gcc272Real.compileCandidate('int f(int a) { return a + 11; }\n', 'f', GCC272_FLAGS, 'c');
          docker(['tag', base, tag]);
          docker(['rm', '-f', pool!]);
          gcc272.gcc272Real.compileCandidate('int f(int a) { return a + 12; }\n', 'f', GCC272_FLAGS, 'c');
          gcc272.gcc272Real.compileCandidate('int f(int a) { return a + 13; }\n', 'f', GCC272_FLAGS, 'c');
        });
        expect(midRun.stats).toMatchObject({ miss: 2, stored: 1, refusedKeys: 2 });
      } finally {
        if (pool !== undefined) {
          spawnSync(GCC272_TOOLCHAIN.docker, ['rm', '-f', pool]);
        }
        spawnSync(GCC272_TOOLCHAIN.docker, ['rmi', tag, other]);
      }
    },
    CONTAINER_BUDGET,
  );

  test(
    'ends the store on a pool that changed image for every flag set, and keeps no rejection compiled there',
    async () => {
      await withPrivateImage(async ({ tag, other, onTag, poolOf }) => {
        const store = scratch('dockercache-store-');
        const F2 = [...GCC272_FLAGS, '-fno-common'];
        type Gcc272 = typeof import('../src/compile/gcc272');
        const compile = (gcc272: Gcc272, tu: string, flags: readonly string[]) =>
          readFileSync(gcc272.gcc272Real.compileCandidate(tu, 'f', flags, 'c'));
        const cold = await asRun(store, onTag, ({ gcc272 }) => {
          compile(gcc272, OK_TU, GCC272_FLAGS);
          compile(gcc272, OK_TU, F2);
        });
        expect(cold.stats).toMatchObject({ stored: 2 });

        const warm = await asRun(store, onTag, (m) => {
          compile(m.gcc272, OK_TU, GCC272_FLAGS);
          compile(m.gcc272, OK_TU, F2);
          docker(['tag', other, tag]);
          docker(['rm', '-f', poolOf(m)]);
          // The rejection that restarts the pool on the other image, under the second flag set…
          const refusal = thrown(() => m.gcc272.gcc272Real.compileCandidate(REFUSED_TU, 'f', F2, 'c'));
          // …and the first flag set's stored object, on the same pool.
          compile(m.gcc272, OK_TU, GCC272_FLAGS);
          return (refusal as Error).constructor.name;
        });
        expect(warm.value).toBe('CompilerRejection');
        expect(warm.stats).toMatchObject({ hit: 2, miss: 1, refusedKeys: 2 });
        expect(warm.stats.failStored).toBeUndefined();
        expect(warm.stats.stored).toBeUndefined();
      });
    },
    CONTAINER_BUDGET,
  );

  test(
    'notices a pool that another process started on a moved image while this one compiled',
    async () => {
      await withPrivateImage(async ({ tag, other, onTag, poolOf }) => {
        const store = scratch('dockercache-store-');
        // The other process is played by a docker front: the moment this process removes the pool
        // (after `docker exec` finds it gone), it starts the pool again from the tag, so this
        // process finds a running pool and confirms it instead of starting one.
        const front = scratch('docker-front-');
        const armed = join(front, 'armed');
        const mounts = gcc272PoolCfg()
          .mounts.map((m) => `'${m}'`)
          .join(' ');
        writeFileSync(
          join(front, 'docker'),
          [
            '#!/bin/sh',
            `${MWCC_PPC_TOOLCHAIN.docker} "$@"`,
            'rc=$?',
            `if [ "$1" = rm ] && [ -e '${armed}' ]; then`,
            `  rm -f '${armed}'`,
            `  ${MWCC_PPC_TOOLCHAIN.docker} run -d --name "$3" --platform linux/386 ${mounts} '${tag}' sleep 86400 >/dev/null`,
            'fi',
            'exit $rc',
            '',
          ].join('\n'),
        );
        chmodSync(join(front, 'docker'), 0o755);
        const run = await asRun(store, { ...onTag, ASMLIFT_DOCKER: join(front, 'docker') }, (m) => {
          m.gcc272.gcc272Real.compileCandidate(OK_TU, 'f', GCC272_FLAGS, 'c');
          docker(['tag', other, tag]);
          writeFileSync(armed, '');
          docker(['rm', '-f', poolOf(m)]);
          m.gcc272.gcc272Real.compileCandidate('int f(int a) { return a + 12; }\n', 'f', GCC272_FLAGS, 'c');
          return existsSync(armed);
        });
        expect(run.value, 'the front started the pool again').toBe(false);
        expect(run.stats).toMatchObject({ miss: 2, stored: 1, refusedKeys: 1 });
      });
    },
    CONTAINER_BUDGET,
  );

  test(
    'keeps nothing a one-shot docker run compiled: the tag it reads can move between two of them',
    async () => {
      await withPrivateImage(async ({ tag, other, onTag, poolOf }) => {
        // A pool left running on the tag's image, as an earlier process leaves one.
        await asRun(scratch('dockercache-store-'), onTag, (m) => {
          poolOf(m);
          m.gcc272.gcc272Real.compileCandidate(OK_TU, 'f', GCC272_FLAGS, 'c');
        });
        const store = scratch('dockercache-store-');
        const poolless = await asRun(store, { ...onTag, ASMLIFT_DOCKER_POOL: '0' }, ({ gcc272 }) => {
          gcc272.gcc272Real.compileCandidate('int f(int a) { return a + 11; }\n', 'f', GCC272_FLAGS, 'c');
          docker(['tag', other, tag]);
          gcc272.gcc272Real.compileCandidate('int f(int a) { return a + 12; }\n', 'f', GCC272_FLAGS, 'c');
        });
        expect(poolless.stats).toMatchObject({ refused: 1 });
        expect(poolless.stats.stored).toBeUndefined();
      });
    },
    CONTAINER_BUDGET,
  );

  test(
    'reads the image of a compile with no pool container off the tag alone',
    () => {
      const spec = { ...gcc272CacheSpec(GCC272_FLAGS), native: () => false, pool: 'asmlift-test-no-such-pool' };
      const id = docker(['image', 'inspect', '--format', '{{.Id}}', GCC272_TOOLCHAIN.image]);
      expect(runsOn(spec)).toBe(`container:${id}`);
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
    'does not keep an error located in a file that is not the candidate',
    () => {
      const dir = scratch('bench-ppc-cand-', '/tmp');
      writeFileSync(join(dir, 'other.c'), REFUSED_TU);
      const e = thrown(() => ppcCompile('mwcc_242_81', dir, 'other.c', 'c.o', MWCC_FLAGS, false));
      expect(e).toBeInstanceOf(CompilerRejection);
      expect((e as CompilerRejection).diagnostic).toMatch(/^#\s+File: .*other\.c\r?$/m);
      expect(mwccRefused(e)).toBe(false);
    },
    CONTAINER_BUDGET,
  );

  test(
    'does not keep its reports beside a line it did not write, or an error without its line',
    () => {
      const e = thrown(() => mwccIn(REFUSED_TU)) as CompilerRejection;
      expect(mwccRefused(e)).toBe(true);
      const crashed = 'qemu: uncaught target signal 11 (Segmentation fault) - core dumped\n';
      expect(mwccRefused(new CompilerRejection(e.message, e.diagnostic + crashed))).toBe(false);
      expect(mwccRefused(new CompilerRejection(e.message, crashed + e.diagnostic))).toBe(false);
      // the same reports without the source lines they point at
      const unlocated = e.diagnostic.replace(/^#\s+\d+: .*\r?\n/gm, '');
      expect(unlocated).not.toBe(e.diagnostic);
      expect(mwccRefused(new CompilerRejection(e.message, unlocated))).toBe(false);
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
