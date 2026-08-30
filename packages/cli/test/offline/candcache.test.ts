// The cross-run candidate-object cache on the RANKED path — the seam every published score comes
// from (src/compile-command.ts + src/candcache.ts). Offline: the "compilers" here are plain sh
// commands, exactly as in compile-command.test.ts.
//
// A stale cached object is this repo's banned failure mode in its purest form: it compiles, it
// scores, and it is a claim about a toolchain that no longer produced it. Two holes were
// reproduced on this seam before the code below existed, and both served one:
//
//   HOLE 2 — an input reached through a DIRECTORY. The namespace scans the template's TOKENS
//     (files it names, commands on $PATH, variables it reads) plus one probe object. `-I ./inc`
//     names a directory, the candidate's `#include "k.h"` names a file inside it, and neither is
//     in any token set nor visible to the probe TU. Editing `k.h` between two cache-on runs
//     served the old object. Closed by REFUSING rather than widening: the cache does not start at
//     all until the project DECLARES its compile inputs, and a declared directory is hashed by
//     its whole contents.
//   HOLE 3 — the purity premise is FALSE for some toolchains. "A candidate object is a pure
//     function of (TU bytes, symbol)" holds for agbcc and fails for `ido7.1`, which writes the
//     absolute path of its input `.c` into the object. Closed by a MEASUREMENT, not a list: the
//     stamp probe compiles in two different directories and the compiler answers.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

type CompileCommandModule = typeof import('../../src/compile-command');

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
  vi.resetModules();
});

/** A throwaway project: `inc/k.h` (the input reached through a directory), a template that is a
 *  pure function of (candidate bytes, k.h bytes), and a counter file the template appends to on
 *  every execution — so a cache HIT is observable as an execution that did not happen. */
function project(k = 3): { cwd: string; store: string; setK: (v: number) => void; runs: () => number } {
  const cwd = mkdtempSync(join(tmpdir(), 'candcache-proj-'));
  const store = mkdtempSync(join(tmpdir(), 'candcache-store-'));
  roots.push(cwd, store);
  mkdirSync(join(cwd, 'inc'));
  const setK = (v: number): void => writeFileSync(join(cwd, 'inc/k.h'), `#define K ${v}\n`);
  setK(k);
  return {
    cwd,
    store,
    setK,
    runs: () => (existsSync(join(cwd, 'runs')) ? readFileSync(join(cwd, 'runs'), 'utf8').trim().split('\n').length : 0),
  };
}
// The faithful shape of `-I ./inc` plus a candidate's `#include "k.h"`, in one sh line. Two
// properties make it the real hole rather than an easy one:
//   • the header is reached through a GLOB, so `inc/k.h` is not a token the namespace's token
//     scan can find — only the DECLARATION can name it;
//   • it is pulled in only for a candidate that ASKS for it, so the fixed stamp probe TU (which
//     does not) compiles to bytes that are independent of `k.h`. That is precisely why the probe
//     backstop cannot see this input, and why hole 2 needed a fix of its own.
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

/** A candidate whose object does NOT depend on the declared directory. */
const CAND = 's32 f(s32 a0) { return a0 + 1; }\n';
/** A candidate whose object DOES — the template pulls the header in for it, and for nothing the
 *  namespace's probe compiles. Its `#include` is spelled the way a preprocessor would reach the
 *  file; `USES_K` is this rig's stand-in for what `-I ./inc` resolves. */
const CAND_K = '/* USES_K */\ns32 f(s32 a0) { return a0 + K; }\n';
const CAND_INCLUDE = '#include "k.h" /* USES_K */\ns32 f(s32 a0) { return a0 + K; }\n';

describe('hole 2 — an input reached through a DIRECTORY', () => {
  test('UNDECLARED: no tools.asmlift.cacheInputs, no cache — the store is never even created', async () => {
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
      const compile = compileFromCommand(TEMPLATE, { cwd: p.cwd });
      expect(readFileSync(compile(CAND_K, 'f', 'c'), 'utf8')).toContain('#define K 3');
      p.setK(999);
      // THE HOLE: with the cache running and no declaration, this is where the stale object was
      // served — and the probe object cannot save it, because the probe TU never asks for `k.h`.
      expect(readFileSync(compile(CAND_K, 'f', 'c'), 'utf8')).toContain('#define K 999');
    });
    expect(storedKeys(p.store), 'an undeclared project must not have a single key stored').toEqual([]);
  });

  test('DECLARED: the cache runs, and a hit is an execution that did not happen', async () => {
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
      const compile = compileFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] });
      expect(readFileSync(compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
      const afterFirst = p.runs();
      expect(readFileSync(compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
      expect(p.runs(), 'the same TU a second time must be served, not compiled').toBe(afterFirst);
    });
    expect(storedKeys(p.store).length).toBeGreaterThan(0);
  });

  test('DECLARED: editing a file inside the declared DIRECTORY re-namespaces — no stale object', async () => {
    const p = project();
    const seen = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const first = readFileSync(
          compileFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] })(CAND_K, 'f', 'c'),
          'utf8',
        );
        p.setK(999);
        // A NEW compiler instance, as a second run of asmlift would build: same store, same key,
        // and only the declared directory's contents have moved.
        const second = readFileSync(
          compileFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] })(CAND_K, 'f', 'c'),
          'utf8',
        );
        return { first, second };
      },
    );
    expect(seen.first).toContain('#define K 3');
    expect(seen.second, 'the declared directory moved; the stored object is not the answer').toContain('#define K 999');
    // Two namespaces, one per state of `inc/` — the mechanism, not just the outcome.
    expect(readdirSync(join(p.store, 'ns')).length).toBe(2);
  });

  test('a candidate carrying #include is REFUSED per key: it reads a file the namespace cannot name', async () => {
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
      const compile = compileFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] });
      compile(CAND, 'f', 'c'); // a plain candidate: cached
      const keysAfterPlain = storedKeys(p.store).length;
      expect(keysAfterPlain).toBeGreaterThan(0);

      compile(CAND_INCLUDE, 'f', 'c');
      const afterFirstInclude = p.runs();
      compile(CAND_INCLUDE, 'f', 'c');
      expect(p.runs(), 'an #include-carrying TU must be recompiled every time').toBeGreaterThan(afterFirstInclude);
      expect(storedKeys(p.store).length, 'and it must never be stored').toBe(keysAfterPlain);
    });
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

  test('a template that bakes its input PATH into the object is NOT_CACHEABLE, said out loud', async () => {
    const p = project();
    // The `ido7.1` shape, in one line: the object carries the scratch path it was compiled at,
    // so two directories give two objects for one input.
    const baked = 'cat "{{inputPath}}" > "{{outputPath}}"; echo "{{inputPath}}" >> "{{outputPath}}"';
    const err = await stderrOf(async () => {
      await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
        const compile = compileFromCommand(baked, { cwd: p.cwd, cacheInputs: ['inc'] });
        // A refusal is not a failure: the compile still happens and still answers.
        expect(readFileSync(compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
        compile(CAND, 'f', 'c');
      });
    });
    expect(err).toContain('[candcache] REFUSED label=command');
    expect(err).toContain('reason=object-is-not-a-pure-function-of-its-input');
    expect(storedKeys(p.store), 'a refused pipeline stores nothing at all').toEqual([]);
  });

  test('a probe that will not COMPILE refuses too — the conservative direction', async () => {
    const p = project();
    // A template that rejects the stamp probe specifically. A pipeline that cannot compile the
    // simplest possible TU is not one whose answers may be stored.
    const hostile = `echo x >> runs; ! grep -q asmlift_candcache_stamp "{{inputPath}}" && cat "{{inputPath}}" > "{{outputPath}}"`;
    const err = await stderrOf(async () => {
      await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
        const compile = compileFromCommand(hostile, { cwd: p.cwd, cacheInputs: ['inc'] });
        expect(readFileSync(compile(CAND, 'f', 'c'), 'utf8')).toContain('a0 + 1');
      });
    });
    expect(err).toContain('reason=object-is-not-a-pure-function-of-its-input');
    expect(storedKeys(p.store)).toEqual([]);
  });

  test('a path-independent template PASSES the same measurement — the probe is not a blanket no', async () => {
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
      compileFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] })(CAND, 'f', 'c');
    });
    expect(storedKeys(p.store).length).toBeGreaterThan(0);
  });
});

describe('a miss is indistinguishable from no cache, and OFF is the default', () => {
  test('ASMLIFT_CANDCACHE unset: nothing is stored even with inputs declared', async () => {
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: undefined, ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
      const compile = compileFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] });
      compile(CAND, 'f', 'c');
      compile(CAND, 'f', 'c');
    });
    expect(existsSync(join(p.store, 'ns'))).toBe(false);
  });

  test('ASMLIFT_CANDCACHE=0 is the documented bypass, and it touches no disk', async () => {
    const p = project();
    const mode = await withCache(
      { ASMLIFT_CANDCACHE: '0', ASMLIFT_CANDCACHE_DIR: p.store },
      async ({ compileFromCommand }) => {
        compileFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] })(CAND, 'f', 'c');
        return (await import('../../src/candcache')).cacheMode();
      },
    );
    expect(mode).toBe('off');
    expect(existsSync(join(p.store, 'ns'))).toBe(false);
  });

  test('cold and warm produce the same bytes, and the async worker path shares the store', async () => {
    const p = project();
    const [cold, warm] = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      async ({ compilersFromCommand }) => {
        const a = await compilersFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] }).worker()(CAND, 'f', 'c');
        const b = await compilersFromCommand(TEMPLATE, { cwd: p.cwd, cacheInputs: ['inc'] }).worker()(CAND, 'f', 'c');
        return [readFileSync(a, 'utf8'), readFileSync(b, 'utf8')];
      },
    );
    expect(warm).toBe(cold);
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
  // Both templates below reject (or die) only for a candidate that ASKS for it. A template that
  // fails unconditionally fails the stamp probe too, which is NOT_CACHEABLE — the cache then
  // refuses for the process and every assertion about what the store did is vacuously true.
  const REJECTS =
    'echo x >> runs; if grep -q REJECTME "{{inputPath}}"; then echo "no." >&2; exit 1; fi; ' +
    'cat "{{inputPath}}" > "{{outputPath}}"';
  const CAND_REJECT = 's32 f(s32 a0) { REJECTME }\n';
  /** Every negative entry on disk: what `putFail` actually wrote, as opposed to what a message says. */
  const failEntries = (store: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          walk(join(d, e.name));
        } else if (e.name.endsWith('.fail')) {
          out.push(join(d, e.name));
        }
      }
    };
    if (existsSync(join(store, 'ns'))) {
      walk(join(store, 'ns'));
    }
    return out;
  };

  test('the message carries no scratch path, cached or not', async () => {
    const p = project();
    const errors = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const compile = compileFromCommand(REJECTS, { cwd: p.cwd, cacheInputs: [] });
        const out: string[] = [];
        for (let i = 0; i < 2; i++) {
          try {
            compile(CAND_REJECT, 'f', 'c');
          } catch (e) {
            out.push((e as Error).message);
          }
        }
        return out;
      },
    );
    expect(errors.length).toBe(2);
    expect(failEntries(p.store).length, 'the rejection really is in the store').toBe(1);
    const [cold, warm] = errors;
    expect(warm, 'the second run was served from the store').toBe(cold);
    expect(cold).toContain('<scratch>');
    expect(cold, 'no mkdtemp directory reaches a published error').not.toMatch(/asmlift-usercc-/);
    expect(cold).not.toMatch(/\/var\/folders|\/private\/tmp|\/tmp\//);
  });

  // A compiler this machine KILLED never gave a verdict, and `sh` is what hides that on this
  // path: the template always runs through `sh -ec`, and a shell reports a killed child as exit
  // 128+signal. A SIGKILLed compiler arrives as an ordinary `exit 137`, which the message-shape
  // guard matched and stored FOREVER — the candidate then silently missing from every future
  // run's fan under that namespace. Reach: candidate compiles have no timeout, an OOM-killed
  // `docker run` exits 137, and a bench run forks 8-16 shards.
  const KILLED =
    'if grep -q KILLME "{{inputPath}}"; then sh -c \'kill -9 $$\'; fi; cat "{{inputPath}}" > "{{outputPath}}"';
  const CAND_KILL = 's32 f(s32 a0) { KILLME }\n';

  test('a KILLED compile is never stored as a rejection, however ordinary its exit code looks', async () => {
    const p = project();
    const message = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const compile = compileFromCommand(KILLED, { cwd: p.cwd, cacheInputs: [] });
        try {
          compile(CAND_KILL, 'f', 'c');
        } catch (e) {
          return (e as Error).message;
        }
        return 'IT DID NOT FAIL';
      },
    );
    expect(message).toContain('did not run to completion');
    expect(message).toContain('killed by signal 9');
    expect(failEntries(p.store), 'a transient stored as a rejection drops the candidate forever').toEqual([]);
  });

  test('…while a compiler that RAN and said no is stored — the guard is not "never store"', async () => {
    const p = project();
    await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
      const compile = compileFromCommand(REJECTS, { cwd: p.cwd, cacheInputs: [] });
      try {
        compile(CAND_REJECT, 'f', 'c');
      } catch {
        /* expected */
      }
    });
    expect(failEntries(p.store).length).toBe(1);
  });

  test('and the uncached spelling is the SAME string — a miss is indistinguishable in RESULT', async () => {
    const p = project();
    const uncached = await withCache(
      { ASMLIFT_CANDCACHE: '0', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const compile = compileFromCommand(REJECTS, { cwd: p.cwd, cacheInputs: [] });
        const out: string[] = [];
        for (let i = 0; i < 2; i++) {
          try {
            compile(CAND_REJECT, 'f', 'c');
          } catch (e) {
            out.push((e as Error).message);
          }
        }
        return out;
      },
    );
    expect(uncached[0], 'two uncached runs of the identical failure used to differ').toBe(uncached[1]);
  });
});
