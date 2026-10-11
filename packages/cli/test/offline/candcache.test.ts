// The cross-run candidate-object cache on the RANKED path — the seam every published score comes
// from (src/compile-command.ts + src/candcache.ts). The store keys only the benchmark's own
// commands (src/candcache-bench.ts), so every store case here compiles through the benchmark's agbcc
// command with a test double in its compiler slots (bench-command-double.ts).
//
// A stale cached object is this repo's banned failure mode in its purest form: it compiles, it
// scores, and it is a claim about a toolchain that no longer produced it. Two holes were
// reproduced on this seam before the code below existed, and both served one:
//
//   HOLE 2 — an input reached through a DIRECTORY or a file the candidate names. A TU that reads a
//     file is refused per key, and a project's command, which can reach a directory through a
//     path it computes, is not keyed at all.
//   HOLE 3 — the purity premise is FALSE for some toolchains. "A candidate object is a pure
//     function of (TU bytes, symbol)" holds for agbcc and fails for `ido7.1`, which writes the
//     absolute path of its input `.c` into the object. Closed by a MEASUREMENT, not a list: the
//     stamp probe compiles in two different directories and the compiler answers.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { benchAgbcc } from './bench-command-double';

// A BLOCKING-spawnSync suite in a pool whose config says there are none: every case here drives
// several `spawnSync` compiles, and the file's neighbours in `test:offline` run in parallel worker
// forks. Under the 5000 ms default the whole candcache family goes red on load alone — measured on
// one machine at one commit, loadavg ~65: 30 of these tests failed with `Test timed out in 5000ms`
// and two more cascaded into CONTENT assertions, which reads like a soundness failure and is not.
// `test:offline` is a CI gate on a shared runner, so the timeout is the honest knob.
vi.setConfig({ testTimeout: 120_000 });

type CompileCommandModule = typeof import('../../src/compile-command');

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
  vi.resetModules();
});

/** A throwaway project: `inc/k.h`, a private store, and a tally file the double appends to on every
 *  execution — so a cache HIT is observable as an execution that did not happen. */
function project(k = 3): {
  cwd: string;
  store: string;
  tallyFile: string;
  setK: (v: number) => void;
  runs: () => number;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'candcache-proj-'));
  const store = mkdtempSync(join(tmpdir(), 'candcache-store-'));
  roots.push(cwd, store);
  mkdirSync(join(cwd, 'inc'));
  const setK = (v: number): void => writeFileSync(join(cwd, 'inc/k.h'), `#define K ${v}\n`);
  setK(k);
  const tallyFile = join(cwd, 'runs');
  return {
    cwd,
    store,
    tallyFile,
    setK,
    runs: () => (existsSync(tallyFile) ? readFileSync(tallyFile, 'utf8').trim().split('\n').length : 0),
  };
}

const BENCH = benchAgbcc();
const FLAGS = ['-O2'];
/** The benchmark's command, as the benchmark hands it to the store. */
const benchCompile = (m: CompileCommandModule, cwd: string, cflags: readonly string[] = FLAGS) =>
  m.compileFromCommand(BENCH.command, { cwd, cflags, bench: BENCH.bench });

/** A project's own command: it reads `inc/*.h`, which no word of it names, for a candidate that asks. */
const TEMPLATE =
  'echo x >> runs; cat "{{inputPath}}" > "{{outputPath}}"; ' +
  'if grep -q USES_K "{{inputPath}}"; then cat inc/*.h >> "{{outputPath}}"; fi';

/** Import compile-command with the cache env set — candcache.ts reads ASMLIFT_CANDCACHE and
 *  ASMLIFT_CANDCACHE_DIR once, at module load, so every case needs its own module registry. */
async function withCache<T>(
  env: Record<string, string | undefined>,
  fn: (mod: CompileCommandModule) => Promise<T> | T,
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  vi.resetModules();
  try {
    return await fn(await import('../../src/compile-command'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

/** Every stored key link under the store, `.o` and `.fail` alike. */
function storedKeys(store: string): string[] {
  const ns = join(store, 'ns');
  if (!existsSync(ns)) {
    return [];
  }
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.name === '.live') {
        continue; // liveness leases, not answers
      }
      if (e.isDirectory()) {
        walk(p);
      } else {
        out.push(p);
      }
    }
  };
  walk(ns);
  return out;
}

const CAND = 's32 f(s32 a0) { return a0 + 1; }\n';
const CAND_K = '/* USES_K */\ns32 f(s32 a0) { return a0 + K; }\n';

describe('the flags a command renders', () => {
  test('one command at two flag sets never serves one set the other’s object', async () => {
    const p = project();
    const seen = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store, BENCH_DOUBLE_TALLY: p.tallyFile },
      async (m) => {
        const at = async (cflags: string[]) =>
          readFileSync(await benchCompile(m, p.cwd, cflags)(CAND, 'f', 'c'), 'utf8');
        const o2 = await at(['-O2']);
        const afterO2 = p.runs();
        const o1 = await at(['-O1']);
        return { o2, o1, compiledAgain: p.runs() > afterO2, o2Again: await at(['-O2']) };
      },
    );
    expect(seen.o2).toContain(' -O2\n');
    expect(seen.o1, 'the -O1 compile must not be served the -O2 object').toContain(' -O1\n');
    expect(seen.compiledAgain).toBe(true);
    expect(seen.o2Again).toBe(seen.o2);
    expect(storedKeys(p.store).length, 'one key per flag set').toBe(2);
  });
});

describe('hole 2 — an input the namespace cannot see', () => {
  test('the cache runs, and a hit is an execution that did not happen', async () => {
    const p = project();
    await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store, BENCH_DOUBLE_TALLY: p.tallyFile },
      async (m) => {
        const compile = benchCompile(m, p.cwd);
        expect(readFileSync(await compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
        const afterFirst = p.runs();
        expect(readFileSync(await compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
        expect(p.runs(), 'the same TU a second time must be served, not compiled').toBe(afterFirst);
      },
    );
    expect(storedKeys(p.store).length).toBeGreaterThan(0);
  });

  test('a project command that reads a directory it never names is not keyed, so an edit there reaches the compile', async () => {
    const p = project();
    const seen = await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, async (m) => {
      const first = readFileSync(await m.compileFromCommand(TEMPLATE, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
      p.setK(999);
      // A NEW compiler instance, as a second run of asmlift would build: same store, same key.
      const second = readFileSync(await m.compileFromCommand(TEMPLATE, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
      return { first, second, stats: (await import('../../src/candcache')).cacheStats() };
    });
    expect(seen.first).toContain('#define K 3');
    expect(seen.second, 'the directory moved; no stored object may answer').toContain('#define K 999');
    expect(seen.stats).toMatchObject({ refusedKeys: 2 });
    expect(existsSync(join(p.store, 'ns')), 'a command the store does not key is never stamped').toBe(false);
  });

  test('a candidate carrying #include is REFUSED per key: it reads a file the namespace cannot name', async () => {
    const p = project();
    const candInclude = `#include "${join(p.cwd, 'inc/k.h')}"\ns32 f(s32 a0) { return a0 + K; }\n`;
    await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store, BENCH_DOUBLE_TALLY: p.tallyFile },
      async (m) => {
        const compile = benchCompile(m, p.cwd);
        await compile(CAND, 'f', 'c'); // a plain candidate: cached
        const keysAfterPlain = storedKeys(p.store).length;
        expect(keysAfterPlain).toBeGreaterThan(0);

        expect(readFileSync(await compile(candInclude, 'f', 'c'), 'utf8')).toContain('a0 + 3');
        const afterFirstInclude = p.runs();
        p.setK(999);
        expect(readFileSync(await compile(candInclude, 'f', 'c'), 'utf8')).toContain('a0 + 999');
        expect(p.runs(), 'an #include-carrying TU must be recompiled every time').toBeGreaterThan(afterFirstInclude);
        expect(storedKeys(p.store).length, 'and it must never be stored').toBe(keysAfterPlain);
      },
    );
  });
});

describe('hole 3 — the object must be a PURE FUNCTION of its input, and that is measured', () => {
  const stderrOf = async (fn: () => Promise<void> | void): Promise<string> => {
    let out = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return out;
  };

  test('a compiler that bakes its input PATH into the object is NOT_CACHEABLE, said out loud', async () => {
    const p = project();
    // The `ido7.1` shape: the object carries the scratch path it was compiled at, so two
    // directories give two objects for one input.
    const err = await stderrOf(async () => {
      await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store, BENCH_DOUBLE: 'bake' }, async (m) => {
        const compile = benchCompile(m, p.cwd);
        // A refusal is not a failure: the compile still happens and still answers.
        expect(readFileSync(await compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
        await compile(CAND, 'f', 'c');
      });
    });
    expect(err).toContain('[candcache] REFUSED label=command');
    expect(err).toContain('reason=object-is-not-a-pure-function-of-its-input');
    expect(storedKeys(p.store), 'a refused pipeline stores nothing at all').toEqual([]);
  });

  test('a probe that will not COMPILE refuses too — the conservative direction', async () => {
    const p = project();
    // A compiler that rejects the stamp probe specifically. A pipeline that cannot compile the
    // simplest possible TU is not one whose answers may be stored.
    const err = await stderrOf(async () => {
      await withCache(
        { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store, BENCH_DOUBLE: 'reject-probe' },
        async (m) => {
          expect(readFileSync(await benchCompile(m, p.cwd)(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
        },
      );
    });
    expect(err).toContain('reason=object-is-not-a-pure-function-of-its-input');
    expect(storedKeys(p.store)).toEqual([]);
  });

  test('a path-independent compiler PASSES the same measurement — the probe is not a blanket no', async () => {
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, async (m) => {
      await benchCompile(m, p.cwd)(CAND, 'f', 'c');
    });
    expect(storedKeys(p.store).length).toBeGreaterThan(0);
  });
});

describe('a miss is indistinguishable from no cache, and ON is the default', () => {
  test("ASMLIFT_CANDCACHE UNSET: the cache runs on the benchmark's command, with nothing declared", async () => {
    // `undefined` here DELETES the variable — `vitest.config.ts` pins it to `0` for every other
    // suite, and this case is one of the few that must see the real default.
    const p = project();
    await withCache(
      { ASMLIFT_CANDCACHE: undefined, ASMLIFT_CANDCACHE_DIR: p.store, BENCH_DOUBLE_TALLY: p.tallyFile },
      async (m) => {
        const compile = benchCompile(m, p.cwd);
        expect(readFileSync(await compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
        const afterFirst = p.runs();
        expect(readFileSync(await compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
        expect(p.runs(), 'unset means ON, so the second compile is served rather than executed').toBe(afterFirst);
      },
    );
    expect(storedKeys(p.store).length).toBeGreaterThan(0);
  });

  test('ASMLIFT_CANDCACHE set and EMPTY is OFF, and it is not the same state as unset', async () => {
    // The one state the flip splits in two. `ASMLIFT_CANDCACHE=` is both a deliberate one-shot
    // bypass and an unexpanded `$SOMETHING`, so it lands on the side whose cost is a cold start.
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: '', ASMLIFT_CANDCACHE_DIR: p.store }, async (m) => {
      const compile = benchCompile(m, p.cwd);
      await compile(CAND, 'f', 'c');
      await compile(CAND, 'f', 'c');
    });
    expect(existsSync(join(p.store, 'ns'))).toBe(false);
  });

  test('ASMLIFT_BENCH_CACHE=0 turns the DEFAULT off, not just an explicit request', async () => {
    // With unset meaning `on`, this is the difference between "bypass the benchmark's caches" and
    // a developer bisecting a suspect row while candidate objects still come off disk.
    const p = project();
    await withCache(
      { ASMLIFT_CANDCACHE: undefined, ASMLIFT_BENCH_CACHE: '0', ASMLIFT_CANDCACHE_DIR: p.store },
      async (m) => {
        await benchCompile(m, p.cwd)(CAND, 'f', 'c');
      },
    );
    expect(existsSync(join(p.store, 'ns'))).toBe(false);
  });

  test('ASMLIFT_CANDCACHE=0 is the documented bypass, and it touches no disk', async () => {
    const p = project();
    const mode = await withCache({ ASMLIFT_CANDCACHE: '0', ASMLIFT_CANDCACHE_DIR: p.store }, async (m) => {
      await benchCompile(m, p.cwd)(CAND, 'f', 'c');
      return (await import('../../src/candcache')).cacheMode();
    });
    expect(mode).toBe('off');
    expect(existsSync(join(p.store, 'ns'))).toBe(false);
  });

  test('cold and warm produce the same bytes, and the async worker path shares the store', async () => {
    const p = project();
    const seen = await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, async (m) => {
      const opts = { cwd: p.cwd, cflags: FLAGS, bench: BENCH.bench };
      const a = await m.compilersFromCommand(BENCH.command, opts).worker()(CAND, 'f', 'c');
      const b = await m.compilersFromCommand(BENCH.command, opts).worker()(CAND, 'f', 'c');
      return {
        cold: readFileSync(a, 'utf8'),
        warm: readFileSync(b, 'utf8'),
        stats: (await import('../../src/candcache')).cacheStats(),
      };
    });
    expect(seen.stats, 'the second worker was served what the first stored').toMatchObject({
      miss: 1,
      stored: 1,
      hit: 1,
    });
    expect(seen.warm).toBe(seen.cold);
  });
});

describe('a cached REJECTION is equal in RESULT to an uncached one', () => {
  // `dropped[].error` is published: rank.ts puts the first line of a failed compile there,
  // main.ts prints it as `[dropped]` and the benchmark publishes it as `droppedCandidates`. That
  // first line is `compile command failed (exit N): <the whole command>`, and the command holds
  // the mkdtemp scratch path — so a stored rejection replayed a directory that no longer exists,
  // and two runs of the identical failure printed different text. The scratch dir is scrubbed at
  // the point the message is built, which makes cached and uncached identical AND takes a machine
  // path out of published output.
  //
  // The double rejects only a candidate that ASKS for it. A compiler that fails unconditionally
  // fails the stamp probe too, which is NOT_CACHEABLE — the cache then refuses for the process and
  // every assertion about what the store did is vacuously true.
  const CAND_REJECT = 's32 f(s32 a0) { REJECTME }\n';
  /** Every negative entry on disk: what `putFail` actually wrote, as opposed to what a message says. */
  const failEntries = (store: string): string[] => storedKeys(store).filter((k) => k.endsWith('.fail'));

  test('the message carries no scratch path, cached or not', async () => {
    const p = project();
    const errors = await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, async (m) => {
      const compile = benchCompile(m, p.cwd);
      const out: string[] = [];
      for (let i = 0; i < 2; i++) {
        try {
          await compile(CAND_REJECT, 'f', 'c');
        } catch (e) {
          out.push((e as Error).message);
        }
      }
      return out;
    });
    expect(errors.length).toBe(2);
    expect(failEntries(p.store).length, 'the rejection really is in the store').toBe(1);
    const [cold, warm] = errors;
    expect(warm, 'the second run was served from the store').toBe(cold);
    expect(cold).toContain('<compile-dir>');
    expect(cold, 'no mkdtemp directory reaches a published error').not.toMatch(/match-kit-compile-/);
    // The double itself lives in a temporary directory, as a compiler's own path is in its command.
    const doubleDir = dirname(BENCH.bench.placeholders.ASMLIFT_AGBCC);
    expect(cold.replaceAll(doubleDir, '<double>')).not.toMatch(/\/var\/folders|\/private\/tmp|\/tmp\//);
  });

  // A compiler this machine KILLED never gave a verdict, and `sh` is what hides that on this
  // path: the template always runs through `sh -ec`, and a shell reports a killed child as exit
  // 128+signal, so a SIGKILLed compiler arrives as an ordinary `exit 137`. Stored as a rejection,
  // the candidate would be missing from every future run's fan under that namespace. Reach:
  // candidate compiles have no timeout, an OOM-killed `docker run` exits 137, and a bench run
  // forks 8-16 shards.
  const CAND_KILL = 's32 f(s32 a0) { return a0 - 1; }\n';

  test('a KILLED compile is never stored as a rejection, however ordinary its exit code looks', async () => {
    const p = project();
    const message = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store, BENCH_DOUBLE: undefined },
      async (m) => {
        const compile = benchCompile(m, p.cwd);
        await compile(CAND, 'f', 'c'); // measures the namespace
        process.env.BENCH_DOUBLE = 'kill';
        try {
          await compile(CAND_KILL, 'f', 'c');
        } catch (e) {
          return (e as Error).message;
        }
        return 'IT DID NOT FAIL';
      },
    );
    expect(message).toContain('did not run to completion');
    expect(message).toContain('killed by SIGKILL');
    expect(failEntries(p.store), 'a transient stored as a rejection drops the candidate forever').toEqual([]);
  });

  test('…while a compiler that RAN and said no is stored — the guard is not "never store"', async () => {
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, async (m) => {
      try {
        await benchCompile(m, p.cwd)(CAND_REJECT, 'f', 'c');
      } catch {
        /* expected */
      }
    });
    expect(failEntries(p.store).length).toBe(1);
  });

  test('and the uncached spelling is the SAME string — a miss is indistinguishable in RESULT', async () => {
    const p = project();
    const uncached = await withCache({ ASMLIFT_CANDCACHE: '0', ASMLIFT_CANDCACHE_DIR: p.store }, async (m) => {
      const compile = benchCompile(m, p.cwd);
      const out: string[] = [];
      for (let i = 0; i < 2; i++) {
        try {
          await compile(CAND_REJECT, 'f', 'c');
        } catch (e) {
          out.push((e as Error).message);
        }
      }
      return out;
    });
    expect(uncached[0], 'two uncached runs of the identical failure used to differ').toBe(uncached[1]);
  });
});

describe('the sampled audit must never cost a candidate the store could have answered', () => {
  // A WARM run has zero exposure to a transient compile failure: it never compiles. Withholding
  // a fraction of keys hands exactly that fraction back to the hazard — `util.ts run()`'s 120 s timeout, an
  // OOM-killed `docker run`, a `sh`-laundered SIGKILL — and both call sites deliberately store
  // NOTHING for a transient, so the withheld key was simply lost from the fan, under a RANDOM
  // per-run seed. That is a nondeterministic fan sitting underneath a byte-identical `[score]`
  // table, and it is strictly worse than the uncached run the doc compares against: an uncached
  // run at least has no correct answer sitting on disk.
  //
  // ONE module load, and the compiler is made flaky mid-load: `namespace()` memoizes, and so does
  // the command's refusal, so a mutation AFTER the first compile leaves both exactly where they
  // were, and the double reads `BENCH_DOUBLE` afresh on every run.
  test('a transient on a WITHHELD key takes the withheld answer back instead of dropping it', async () => {
    const p = project();
    const { first, second, stats } = await withCache(
      {
        ASMLIFT_CANDCACHE: '1',
        ASMLIFT_CANDCACHE_SAMPLE: '100',
        ASMLIFT_CANDCACHE_DIR: p.store,
        BENCH_DOUBLE: undefined,
      },
      async (m) => {
        const compile = benchCompile(m, p.cwd);
        const first = await compile(CAND, 'f', 'c'); // a MISS: compiled for real, and stored
        process.env.BENCH_DOUBLE = 'kill'; // …and now every compile of it dies without a verdict
        const second = await compile(CAND, 'f', 'c'); // withheld at 100%, killed, abandoned
        return { first, second, stats: (await import('../../src/candcache')).cacheStats() };
      },
    );
    expect(readFileSync(first, 'utf8')).toContain('a0 + 1');
    expect(readFileSync(second, 'utf8'), 'the stored answer, not a lost candidate').toContain('a0 + 1');
    expect(stats).toMatchObject({ miss: 1, stored: 1, sampled: 1, sampledAbandoned: 1, hit: 1 });
    expect(stats.sampledPending, 'and nothing is left outstanding').toBeUndefined();
  });

  test('the control: with the audit OFF the same flaky compiler is never even asked', async () => {
    const p = project();
    const stats = await withCache(
      {
        ASMLIFT_CANDCACHE: '1',
        ASMLIFT_CANDCACHE_SAMPLE: '0',
        ASMLIFT_CANDCACHE_DIR: p.store,
        BENCH_DOUBLE: undefined,
      },
      async (m) => {
        const compile = benchCompile(m, p.cwd);
        await compile(CAND, 'f', 'c');
        process.env.BENCH_DOUBLE = 'kill';
        expect(readFileSync(await compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
        return (await import('../../src/candcache')).cacheStats();
      },
    );
    expect(stats, 'a served key is a compile that did not happen').toMatchObject({ hit: 1 });
    expect(stats.sampled).toBeUndefined();
  });

  test('a DETERMINISTIC rejection on a withheld key is still AUDITED, not abandoned', async () => {
    // The abandonment must not swallow the case it is not for: a compiler that RAN and said no is
    // a fresh answer, and it goes to the comparison exactly as before — here the outcome
    // direction, a stored OBJECT for a TU that no longer compiles.
    const p = project();
    const stats = await withCache(
      {
        ASMLIFT_CANDCACHE: '1',
        ASMLIFT_CANDCACHE_SAMPLE: '100',
        ASMLIFT_CANDCACHE_DIR: p.store,
        BENCH_DOUBLE: undefined,
      },
      async (m) => {
        const compile = benchCompile(m, p.cwd);
        await compile(CAND, 'f', 'c');
        process.env.BENCH_DOUBLE = 'reject';
        await expect(compile(CAND, 'f', 'c')).rejects.toThrow(/error: rejected/);
        return (await import('../../src/candcache')).cacheStats();
      },
    );
    expect(stats).toMatchObject({ sampled: 1, mismatch: 1 });
    expect(stats.sampledAbandoned, 'a verdict is not an abandonment').toBeUndefined();
  });
});
