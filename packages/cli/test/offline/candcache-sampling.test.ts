// SAMPLED VERIFICATION in serving mode — the audit that licenses serving at all.
//
// `bench regression` and `bench diff` are the two gates this project trusts most, and both compare
// OUTCOMES. A stale cached object is served identically on the base and on the head, so both go
// green on a cache defect: neither is capable of catching one. Compiling anyway and comparing is
// the only mechanism that can, and `on` mode does it for a sampled fraction of the keys it serves.
//
// THE HAZARD THAT MAKES A NAIVE VERSION WORSE THAN NOTHING, and the first test below: making
// `get()` return undefined for a sampled key makes the caller compile — and then its `put()`
// OVERWRITES the stored bytes, so the mismatch is never reported and the store silently HEALS.
// The audit would then report clean on exactly the defect it exists to find. A sampled key's
// `put`/`putFail` must route into the same comparison `verify` mode uses, never into a plain
// store.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// A BLOCKING-spawnSync suite in a pool whose config says there are none — the same hazard the rest
// of the candcache family carries the same guard for: the end-to-end cases below drive real `sh`
// compiles through `compileFromCommand`, and this file's neighbours in `test:offline` run in
// parallel worker forks. MEASURED here: under a 120 ms timeout two cases fail with `Test timed out`
// and nothing else, which reads like a soundness failure and is not — this file went red exactly
// once on a loaded box before the guard was added.
vi.setConfig({ testTimeout: 120_000 });

type CandCacheModule = typeof import('../../src/candcache');

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
  vi.resetModules();
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'candcache-sample-'));
  roots.push(d);
  return d;
};

/** candcache.ts reads its env once, at module load, so every state needs its own module registry. */
async function load<T>(env: Record<string, string | undefined>, fn: (m: CandCacheModule) => T): Promise<T> {
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
    return fn(await import('../../src/candcache'));
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

async function capture<T>(
  env: Record<string, string | undefined>,
  fn: (m: CandCacheModule) => T,
): Promise<{ said: string; stats: Record<string, number>; value: T }> {
  let said = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    said += typeof c === 'string' ? c : Buffer.from(c).toString();
    return true;
  });
  try {
    return await load(env, (m) => {
      const value = fn(m);
      return { said, stats: m.cacheStats(), value };
    });
  } finally {
    spy.mockRestore();
  }
}

const NS_A = 'a'.repeat(64);
const object = (bytes: string): string => {
  const p = join(scratch(), 'cand.o');
  writeFileSync(p, bytes);
  return p;
};
/** Serve-every-key, so a case does not depend on which side of the threshold one key lands. */
const ALL = { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '100' };
/** Seeding a store must not itself sample. */
const seedEnv = (root: string): Record<string, string> => ({
  ASMLIFT_CANDCACHE: '1',
  ASMLIFT_CANDCACHE_SAMPLE: '0',
  ASMLIFT_CANDCACHE_DIR: root,
});

/** What a call site does with one candidate, exactly as `compile-command.ts` and
 *  `apps/benchmark/src/compile/agbcc.ts` both spell it: `get` under `on`, then a real compile,
 *  then `verify` (a no-op outside verify mode) and `put`. Neither call site changes for sampling —
 *  the whole mechanism is inside the module, which is what keeps the ORDER a property of the
 *  module rather than of two callers that could drift. */
const compileAndStore = (c: ReturnType<CandCacheModule['candCache']>, key: string, fresh: string): unknown => {
  const hit = c.get(key, 'f');
  if (typeof hit === 'string' || hit instanceof Error) {
    return hit;
  }
  const o = object(fresh);
  c.verify(key, 'f', o);
  return c.put(key, 'f', o);
};
const compileAndFail = (c: ReturnType<CandCacheModule['candCache']>, key: string, message: string): unknown => {
  const hit = c.get(key, 'f');
  if (typeof hit === 'string' || hit instanceof Error) {
    return hit;
  }
  c.verifyFail(key, 'f', message);
  c.putFail(key, 'f', message);
  return undefined;
};

describe('a sampled key is AUDITED, not silently re-stored', () => {
  test('WRONG stored bytes are REPORTED, not healed — the hazard that makes a naive version worse than nothing', async () => {
    // The store holds bytes this toolchain does not produce. `bench regression` and `bench diff`
    // cannot see that: they compare outcomes, and the same wrong object is served on both sides.
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('WRONG-BYTES')));

    const { said, stats, value } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) =>
      compileAndStore(
        m.candCache('t', () => NS_A),
        'k',
        'THE-TRUTH',
      ),
    );

    expect(stats.sampled, 'the stored answer must be WITHHELD so the caller compiles it').toBe(1);
    expect(stats.mismatch, 'the disagreement must be REPORTED — a plain put here heals it silently').toBe(1);
    expect(said).toContain('BYTE MISMATCH');
    // and the caller is still served a path holding the truth, exactly as an unsampled key is
    expect(readFileSync(value as string, 'utf8')).toBe('THE-TRUTH');
  });

  test('a mismatch found by SAMPLING reaches MISMATCHES.log, where a gate in another process reads it', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('WRONG-BYTES')));
    await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) =>
      compileAndStore(
        m.candCache('t', () => NS_A),
        'k',
        'THE-TRUTH',
      ),
    );
    expect(readFileSync(join(root, 'MISMATCHES.log'), 'utf8')).toContain('BYTE MISMATCH');
  });

  test('OUTCOME direction: a stored REJECTION whose TU now compiles — the one that drops a spelling', async () => {
    // Most of a warm store's served answers are rejections. Under `on` a stale one throws for a
    // candidate that compiles, and the spelling leaves the row's fan with nothing said.
    const root = scratch();
    await load(seedEnv(root), (m) =>
      m.candCache('t', () => NS_A).putFail('k', 'f', 'agbcc failed: c.c:3: syntax error'),
    );
    const { said, stats } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) =>
      compileAndStore(
        m.candCache('t', () => NS_A),
        'k',
        'THE-TRUTH',
      ),
    );
    expect(stats.sampled).toBe(1);
    expect(stats.mismatch).toBe(1);
    expect(said).toContain('OUTCOME MISMATCH');
    expect(said).toContain('stored=rejection');
    // repaired: the next serve must not throw the stale rejection again
    const served = await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).get('k', 'f'));
    expect(readFileSync(served as string, 'utf8')).toBe('THE-TRUTH');
  });

  test('OUTCOME direction: a stored OBJECT whose TU no longer compiles', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('STALE')));
    const { said, stats } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) =>
      compileAndFail(
        m.candCache('t', () => NS_A),
        'k',
        'agbcc failed: c.c:3: syntax error',
      ),
    );
    expect(stats.sampled).toBe(1);
    expect(stats.mismatch).toBe(1);
    expect(said).toContain('OUTCOME MISMATCH');
    expect(said).toContain('stored=object');
    const served = await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).get('k', 'f'));
    expect(served).toBeInstanceOf(Error);
  });

  test('an AGREEING sample is counted and says nothing — both halves of the store', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => {
      const c = m.candCache('t', () => NS_A);
      c.put('obj', 'f', object('SAME'));
      c.putFail('rej', 'f', 'agbcc failed: c.c:3: syntax error');
    });
    const { said, stats } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      compileAndStore(c, 'obj', 'SAME');
      // the diagnostic TEXT differs and the OUTCOME does not — that is what the store serves
      compileAndFail(c, 'rej', 'agbcc failed: c.c:3: syntax error before ")"');
    });
    expect(stats).toMatchObject({ sampled: 2, verified: 1, verifiedFail: 1 });
    expect(stats.mismatch).toBeUndefined();
    expect(said).not.toContain('MISMATCH');
  });

  test('a key already audited in this run is SERVED on the next lookup, not compiled again', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('SAME')));
    const { stats, value } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      compileAndStore(c, 'k', 'SAME');
      return c.get('k', 'f');
    });
    expect(stats.sampled, 'one extra compile per distinct key per run, not one per lookup').toBe(1);
    expect(stats.hit).toBe(1);
    expect(readFileSync(value as string, 'utf8')).toBe('SAME');
  });
});

describe('the whole mechanism is inside the module — neither call site changes', () => {
  // `compile-command.ts` and `apps/benchmark/src/compile/agbcc.ts` both already spell it
  // `get` → compile → `verify` → `put` (and `verifyFail` → `putFail`), which is exactly the order
  // sampling needs. This drives the REAL ranked-path seam end to end, with a poisoned store, and
  // nothing in it knows sampling exists.
  // No side effect in `cwd`: the neighbouring suites' template appends to a `runs` file so a hit
  // is observable as an execution that did not happen, and that file is a TOKEN of the template.
  // It does not exist when the first run stamps the namespace and does exist when the second one
  // does, so the namespace MOVES between them and the second run is cold — a rig artifact that
  // reads exactly like "sampling found nothing".
  const TEMPLATE = 'cat "{{inputPath}}" > "{{outputPath}}"';
  const CAND = 's32 f(s32 a0) { return a0 + 1; }\n';

  async function withCompile<T>(
    env: Record<string, string | undefined>,
    fn: (m: typeof import('../../src/compile-command')) => Promise<T> | T,
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

  /** Every stored `.o` under the store — the answers a serve would hand back. */
  const storedObjects = (store: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.live') {
          continue;
        }
        const p = join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (e.name.endsWith('.o')) {
          out.push(p);
        }
      }
    };
    walk(join(store, 'ns'));
    return out;
  };

  test('a poisoned store is caught on the RANKED path, through compileFromCommand', async () => {
    const cwd = scratch();
    const store = scratch();
    // 1. a cold run stores this template's answer for one candidate
    await withCompile(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0', ASMLIFT_CANDCACHE_DIR: store },
      ({ compileFromCommand }) => compileFromCommand(TEMPLATE, { cwd })(CAND, 'f', 'c'),
    );
    const objs = storedObjects(store);
    expect(objs.length).toBe(1);

    // 2. the store goes stale in the way no OUTCOME gate can see: the bytes change, the key does
    //    not, and `bench regression` / `bench diff` serve the same wrong object on both sides.
    //    (A write THROUGH the hardlink, which is one of the ways an entry really goes wrong.)
    writeFileSync(objs[0], 'NOT-WHAT-THIS-TOOLCHAIN-PRODUCES\n');

    // 3. a serving run with that key sampled compiles it anyway and compares
    let said = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      said += typeof c === 'string' ? c : Buffer.from(c).toString();
      return true;
    });
    let mismatches = 0;
    let served = '';
    try {
      await withCompile(
        { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '100', ASMLIFT_CANDCACHE_DIR: store },
        async ({ compileFromCommand }) => {
          served = compileFromCommand(TEMPLATE, { cwd })(CAND, 'f', 'c');
          mismatches = (await import('../../src/candcache')).cacheMismatches();
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(said).toContain('BYTE MISMATCH');
    // TWO disagreements over one physical corruption, and both are true: the poison was written
    // THROUGH the hardlink, so the key's answer is wrong (`BYTE MISMATCH`, from the audit) and the
    // content-addressed entry every other key dedups onto is wrong too (`OBJECT STORE CORRUPT`,
    // found by the repair's own store write). The second names a different set of victims, so it
    // is reported rather than swallowed as "already known".
    expect(said).toContain('OBJECT STORE CORRUPT');
    expect(mismatches, 'nonzero is what makes the run exit CACHE_MISMATCH_EXIT in main.ts and cli.ts').toBe(2);
    // and the candidate the row is scored on is the TRUTH, not the poison
    expect(readFileSync(served, 'utf8')).toContain('a0 + 1');
  });

  test('…and with sampling off, that same poisoned store is served silently', async () => {
    // The control. Without the audit the defect is invisible: the run is clean, fast, and wrong,
    // and no outcome-comparing gate anywhere can tell.
    const cwd = scratch();
    const store = scratch();
    await withCompile(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0', ASMLIFT_CANDCACHE_DIR: store },
      ({ compileFromCommand }) => compileFromCommand(TEMPLATE, { cwd })(CAND, 'f', 'c'),
    );
    writeFileSync(storedObjects(store)[0], 'NOT-WHAT-THIS-TOOLCHAIN-PRODUCES\n');
    const { served, mismatches } = await withCompile(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0', ASMLIFT_CANDCACHE_DIR: store },
      async ({ compileFromCommand }) => ({
        served: compileFromCommand(TEMPLATE, { cwd })(CAND, 'f', 'c'),
        mismatches: (await import('../../src/candcache')).cacheMismatches(),
      }),
    );
    expect(mismatches).toBe(0);
    expect(readFileSync(served, 'utf8')).toBe('NOT-WHAT-THIS-TOOLCHAIN-PRODUCES\n');
  });
});

describe('sampling is deterministic within a run and rotates across runs', () => {
  const KEYS = Array.from({ length: 400 }, (_, i) => `k${i}`);
  const withdrawn = async (root: string, seed: string): Promise<string[]> =>
    load(
      {
        ASMLIFT_CANDCACHE: '1',
        ASMLIFT_CANDCACHE_SAMPLE: '10',
        ASMLIFT_CANDCACHE_SAMPLE_SEED: seed,
        ASMLIFT_CANDCACHE_DIR: root,
      },
      (m) => {
        const c = m.candCache('t', () => NS_A);
        return KEYS.filter((k) => c.get(k, 'f') === undefined);
      },
    );

  test('the same seed selects the same keys; a different seed selects different ones', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => {
      const c = m.candCache('t', () => NS_A);
      for (const k of KEYS) {
        c.put(k, 'f', object('SAME'));
      }
    });
    const a1 = await withdrawn(root, 'seed-a');
    const a2 = await withdrawn(root, 'seed-a');
    const b = await withdrawn(root, 'seed-b');
    expect(a1.length, 'a 10% rate over 400 keys must select roughly 40, never 0 or all').toBeGreaterThan(15);
    expect(a1.length).toBeLessThan(90);
    expect(a2, 'ASMLIFT_CANDCACHE_SAMPLE_SEED replays a run exactly').toEqual(a1);
    // The reason the seed exists: hashing the key alone is reproducible AND audits the same keys
    // forever, so the rest of the store is never looked at however many runs go by.
    expect(b, 'a new run must audit different keys').not.toEqual(a1);
  });

  test('a SET-AND-EMPTY seed is refused out loud — it would pin the audit to one subset forever', async () => {
    // `??` catches only `undefined`, and '' is a perfectly usable seed: `isSampled` degenerates
    // into a pure function of the key, so the same fixed slice of every store is audited in
    // perpetuity and the rest is never compared — the exact failure the seed exists to
    // prevent, on every machine, with a trailing `seed=` on the line as the only tell. Its two
    // siblings (ASMLIFT_CANDCACHE_MAX_MB, ASMLIFT_CANDCACHE_SAMPLE) both guard it; this one did
    // not.
    const root = scratch();
    const seen: string[] = [];
    let said = '';
    for (let i = 0; i < 2; i++) {
      const r = await capture(
        {
          ASMLIFT_CANDCACHE: '1',
          ASMLIFT_CANDCACHE_SAMPLE: '1',
          ASMLIFT_CANDCACHE_SAMPLE_SEED: '',
          ASMLIFT_CANDCACHE_DIR: root,
        },
        (m) => m.cacheSampleNote(),
      );
      seen.push(r.value as string);
      said = r.said;
    }
    expect(said).toContain('ASMLIFT_CANDCACHE_SAMPLE_SEED is SET AND EMPTY');
    expect(seen[0]).not.toBe(seen[1]);
    for (const note of seen) {
      expect(note, 'a fresh random seed, printed like any other').toMatch(/ sample=1%\/seed=[0-9a-f]{16}$/);
    }
  });

  test('a NON-empty seed is still honoured verbatim, and says nothing', async () => {
    const root = scratch();
    const { said, value } = await capture(
      {
        ASMLIFT_CANDCACHE: '1',
        ASMLIFT_CANDCACHE_SAMPLE: '1',
        ASMLIFT_CANDCACHE_SAMPLE_SEED: 'replay-me',
        ASMLIFT_CANDCACHE_DIR: root,
      },
      (m) => m.cacheSampleNote(),
    );
    expect(value).toBe(' sample=1%/seed=replay-me');
    expect(said).toBe('');
  });
});

describe('the rate and the seed are on the [candcache] line, and the rate is a knob with guards', () => {
  test('an audited run is distinguishable from an unaudited one', async () => {
    const note = await load(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '5', ASMLIFT_CANDCACHE_SAMPLE_SEED: 'deadbeef' },
      (m) => m.cacheSampleNote(),
    );
    expect(note).toBe(' sample=5%/seed=deadbeef');
  });

  test('sampling turned OFF says so — silence would read as an audited run', async () => {
    expect(await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0' }, (m) => m.cacheSampleNote())).toBe(
      ' sample=off',
    );
  });

  test('the note is empty where sampling is not the mechanism: verify audits every key, off serves none', async () => {
    expect(
      await load({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_SAMPLE: '100' }, (m) => m.cacheSampleNote()),
    ).toBe('');
    expect(await load({ ASMLIFT_CANDCACHE: '0', ASMLIFT_CANDCACHE_SAMPLE: '100' }, (m) => m.cacheSampleNote())).toBe(
      '',
    );
  });

  test('rate 0 serves every key and audits none', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('SAME')));
    const stats = await load(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0', ASMLIFT_CANDCACHE_DIR: root },
      (m) => {
        expect(typeof m.candCache('t', () => NS_A).get('k', 'f')).toBe('string');
        return m.cacheStats();
      },
    );
    expect(stats.hit).toBe(1);
    expect(stats.sampled).toBeUndefined();
  });

  test('with nothing set, the audit runs at the rate a measurement picked', async () => {
    // The default is the whole point of the flip: a serving cache nobody switched on is a serving
    // cache nothing audits. 2% is the largest rate whose wall landed inside the audit-off arms'
    // own spread on the LoadBGTilemapData fan (167.4 / 173.1 / 176.2 / 192.7 s against 186.2 s;
    // 5% was 222.6 s, 30 s above the slowest arm it could have hidden behind).
    const { value } = await capture({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: undefined }, (m) =>
      m.cacheSampleNote(),
    );
    expect(value).toMatch(/ sample=2%\/seed=[0-9a-f]{16}$/);
  });

  test('a malformed rate is rejected OUT LOUD and the default stands', async () => {
    // Number('abc') is NaN, and a NaN threshold compares false against everything: the audit would
    // be disabled with no output at all, which is the silent half of a loud-failure rule.
    for (const bad of ['abc', '-1', '101']) {
      const { said, value } = await capture({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: bad }, (m) =>
        m.cacheSampleNote(),
      );
      expect(said).toContain('ignoring ASMLIFT_CANDCACHE_SAMPLE');
      expect(value).toContain('sample=2%');
    }
  });

  test('verify mode is unchanged by sampling — it already audits every key', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('STALE')));
    const { stats, value } = await capture(
      { ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_SAMPLE: '100', ASMLIFT_CANDCACHE_DIR: root },
      (m) => {
        const c = m.candCache('t', () => NS_A);
        // verify mode never serves, so its call sites never call `get` at all
        c.verify('k', 'f', object('FRESH'));
        return m.cacheStats();
      },
    );
    expect((value as Record<string, number>).mismatch).toBe(1);
    expect(stats.sampled, 'no key is WITHHELD in verify mode: nothing was going to be served').toBeUndefined();
  });

  test('a sampled key that vanishes from the store between the get and the put is stored, not lost', async () => {
    // A store rewritten under us (a prune in a sibling shard) leaves nothing to audit. The fresh
    // compile is still the answer, and it must land in the store like any other miss.
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('SAME')));
    const { stats, value } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      expect(c.get('k', 'f')).toBeUndefined();
      rmSync(join(root, 'ns'), { recursive: true, force: true });
      return c.put('k', 'f', object('FRESH'));
    });
    expect(stats.mismatch).toBeUndefined();
    expect(stats.stored).toBe(1);
    // …and the withholding is ACCOUNTED FOR rather than vanishing out of `sampled`.
    expect(stats).toMatchObject({ sampled: 1, sampledStale: 1 });
    expect(stats.sampledPending).toBeUndefined();
    expect(existsSync(value as string)).toBe(true);
    expect(readFileSync(value as string, 'utf8')).toBe('FRESH');
  });
});

describe('a withholding ACCOUNTS FOR ITSELF: `sampled` is not a count of audits', () => {
  // `sampled` counts keys `get` WITHHELD. An audit only happens if the caller comes back with a
  // fresh answer, and for a transient — a spawn failure, the 120 s timeout, a `sh`-laundered
  // SIGKILL — it never does: both call sites deliberately store nothing, because a transient
  // stored as a rejection would drop that candidate on every future run. So a run could print
  // `{"sampled":700,"verified":400}` with nothing at all saying that 300 audits did not happen,
  // and the doc's survival arithmetic reads the first number.
  //
  // Two harms, both fixed here. The accounting one is above; the OTHER one is worse and runs the
  // other way — those keys had a stored answer a serving run would have used, and withholding
  // them exposed them to a transient the cache had been absorbing entirely.
  test('a transient after a withholding takes the WITHHELD answer back, and says so', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('STORED-TRUTH')));
    const { stats, value } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      expect(c.get('k', 'f'), 'withheld, so the caller compiles').toBeUndefined();
      // …and the compile dies transiently: neither put nor putFail is called.
      return c.abandonAudit('k', 'f');
    });
    expect(typeof value, 'the stored answer comes back rather than the candidate being lost').toBe('string');
    expect(readFileSync(value as string, 'utf8')).toBe('STORED-TRUTH');
    expect(stats).toMatchObject({ sampled: 1, sampledAbandoned: 1, hit: 1 });
    expect(stats.sampledPending, 'nothing is left outstanding').toBeUndefined();
  });

  test('a stored REJECTION comes back the same way', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).putFail('k', 'f', 'agbcc failed (exit 1)'));
    const { stats, value } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      expect(c.get('k', 'f')).toBeUndefined();
      return c.abandonAudit('k', 'f');
    });
    expect(value).toBeInstanceOf(Error);
    expect((value as Error).message).toContain('agbcc failed');
    expect(stats).toMatchObject({ sampled: 1, sampledAbandoned: 1, failHit: 1 });
  });

  test('abandoning a key that was never withheld gives back nothing and counts nothing', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('STORED')));
    const { stats, value } = await capture(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0', ASMLIFT_CANDCACHE_DIR: root },
      (m) => m.candCache('t', () => NS_A).abandonAudit('k', 'f'),
    );
    expect(value).toBeUndefined();
    expect(stats.sampledAbandoned).toBeUndefined();
  });

  test('a withholding the caller NEVER answers is reported as still outstanding', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('STORED')));
    const { stats } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).get('k', 'f');
    });
    expect(stats, 'silence here is what let `sampled` overstate the audit').toMatchObject({
      sampled: 1,
      sampledPending: 1,
    });
  });

  test('the identity holds over a mixed run: every withholding lands in exactly one bucket', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => {
      const c = m.candCache('t', () => NS_A);
      c.put('agree', 'f', object('SAME'));
      c.put('differ', 'f', object('STALE'));
      c.putFail('failagree', 'f', 'agbcc failed (exit 1)');
      c.put('abandoned', 'f', object('STORED'));
      c.put('pending', 'f', object('STORED'));
      c.put('vanishes', 'f', object('STORED'));
    });
    const { stats } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      for (const k of ['agree', 'differ', 'failagree', 'abandoned', 'pending', 'vanishes']) {
        expect(c.get(k, 'f'), `${k} must be withheld at SAMPLE=100`).toBeUndefined();
      }
      c.put('agree', 'f', object('SAME')); // verified
      c.put('differ', 'f', object('FRESH')); // mismatch
      c.putFail('failagree', 'f', 'agbcc failed (exit 1)'); // verifiedFail
      c.abandonAudit('abandoned', 'f'); // sampledAbandoned
      return undefined; // 'pending' and 'vanishes' are never answered at all
    });
    const audited =
      (stats.verified ?? 0) +
      (stats.verifiedFail ?? 0) +
      (stats.mismatch ?? 0) +
      (stats.sampledStale ?? 0) +
      (stats.sampledAbandoned ?? 0) +
      (stats.sampledPending ?? 0);
    expect(stats.sampled, 'sampled = verified + verifiedFail + mismatch + stale + abandoned + pending').toBe(audited);
    expect(stats).toMatchObject({ sampled: 6, verified: 1, verifiedFail: 1, mismatch: 1, sampledAbandoned: 1 });
    expect(stats.sampledPending, 'two keys were withheld and never answered').toBe(2);
    expect(stats.sampledStale, 'nothing vanished from the store in this run').toBeUndefined();
  });

  test('a key withheld once and never audited is SERVED on the next lookup, not withheld again', async () => {
    // `auditing` is only emptied by an audit, so re-asserting the withholding on every lookup
    // turned one transient into a permanent miss for the rest of the process — strictly worse
    // than the uncached run the doc compares against.
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('STORED')));
    const { stats, value } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      expect(c.get('k', 'f')).toBeUndefined();
      return c.get('k', 'f');
    });
    expect(typeof value).toBe('string');
    expect(readFileSync(value as string, 'utf8')).toBe('STORED');
    expect(stats, 'one withholding, not one per lookup').toMatchObject({ sampled: 1, hit: 1 });
  });
});

describe('an audit whose REPAIR did not land must not be served — sampling may never be worse than not sampling', () => {
  // The audit compares, reports, and repairs; the repair is best-effort BY DESIGN, because a store
  // gone unwritable must not turn a disagreement into a throw that both call sites read as "this
  // spelling does not compile". What must not follow is handing the caller the store's path anyway:
  // on the mismatch branch that path still holds the bytes the audit has just PROVED wrong, while
  // the fresh, correct object is in the caller's own hand. An unsampled `put` whose store write
  // fails returns that fresh object; a sampled one has to do at least as well.
  /** Every `.o` under `ns/`, and the directories they live in. */
  const keyFiles = (store: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.live') {
          continue;
        }
        const p = join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (e.name.endsWith('.o')) {
          out.push(p);
        }
      }
    };
    walk(join(store, 'ns'));
    return out;
  };
  /** Make the store's write paths refuse, run, and put them back whatever happens. */
  const withUnwritable = (dirs: string[], fn: () => void): void => {
    for (const d of dirs) {
      chmodSync(d, 0o555);
    }
    try {
      fn();
    } finally {
      for (const d of dirs) {
        chmodSync(d, 0o755);
      }
    }
  };

  test('the caller is handed its own FRESH object, never the entry the audit just disproved', async () => {
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('STALE-FROM-AN-OLD-TOOLCHAIN')));
    const stale = keyFiles(root)[0];
    const keyDir = stale.slice(0, stale.lastIndexOf('/'));

    const { said, value, stats } = await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      expect(c.get('k', 'f'), 'sampled: the store is withheld so the caller compiles').toBeUndefined();
      const fresh = object('FRESH-BYTES-THIS-TOOLCHAIN-MADE');
      // objects/ refuses the rewrite, and the key's own directory refuses the drop that would
      // otherwise clean up after it — so the wrong answer is still sitting there when `put`
      // decides what to hand back.
      let served = '';
      withUnwritable([join(root, 'objects'), keyDir], () => {
        served = c.put('k', 'f', fresh);
      });
      return served;
    });

    expect(stats.mismatch, 'the disagreement is reported whatever the repair did').toBe(1);
    expect(said).toContain('BYTE MISMATCH');
    expect(said).toContain('could not repair a mismatched entry');
    expect(readFileSync(value, 'utf8'), 'the scored candidate must be the fresh compile').toBe(
      'FRESH-BYTES-THIS-TOOLCHAIN-MADE',
    );
    expect(readFileSync(stale, 'utf8'), 'and the store really did keep the wrong bytes').toBe(
      'STALE-FROM-AN-OLD-TOOLCHAIN',
    );
  });

  test('an entry proved wrong and not repaired is DROPPED, so the next run misses instead of serving it', async () => {
    // The repair fails where `objects/` cannot be written; `ns/` is a different directory and is
    // usually still writable. A miss recompiles, which is always correct — leaving the entry means
    // the next run serves the disproved answer and only another sampling draw would look at it again.
    const root = scratch();
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('STALE-FROM-AN-OLD-TOOLCHAIN')));
    const stale = keyFiles(root)[0];

    await capture({ ...ALL, ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.get('k', 'f');
      withUnwritable([join(root, 'objects')], () => c.put('k', 'f', object('FRESH-BYTES-THIS-TOOLCHAIN-MADE')));
    });
    expect(existsSync(stale), 'the disproved entry must not survive the run that disproved it').toBe(false);

    const next = await load(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0', ASMLIFT_CANDCACHE_DIR: root },
      (m) => m.candCache('t', () => NS_A).get('k', 'f'),
    );
    expect(next, 'a miss recompiles, which is always correct').toBeUndefined();
  });
});

describe('a reported mismatch reaches the EXIT STATUS, which is the only thing a wrapper reads', () => {
  // `[candcache]` lines and MISMATCHES.log are for whoever is watching. A published reproduction
  // script, an orchestration loop and `bench fidelity` read the status, and `match && mismatches
  // === 0 ? 0 : 1` carried no signal for the case this repo publishes: LoadBGTilemapData has been
  // a nonmatch at 386 for twenty rounds, so a clean run and a poisoned run of it both exit 1.
  const poison = async (root: string): Promise<void> => {
    await load(seedEnv(root), (m) => m.candCache('t', () => NS_A).put('k', 'f', object('WRONG-BYTES')));
  };

  test('BOTH ranked returns carry it: a match, and the decline a total cache defect produces', async () => {
    const root = scratch();
    await poison(root);
    const saved = { ...process.env };
    Object.assign(process.env, {
      ASMLIFT_CANDCACHE: '1',
      ASMLIFT_CANDCACHE_SAMPLE: '100',
      ASMLIFT_CANDCACHE_DIR: root,
    });
    vi.resetModules();
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const m = await import('../../src/candcache');
      compileAndStore(
        m.candCache('t', () => NS_A),
        'k',
        'THE-TRUTH',
      );
      expect(m.cacheMismatches()).toBeGreaterThan(0);
      const { rankedExitCode } = await import('../../src/main');
      expect(rankedExitCode(false), 'the failure return — serving stale objects is WHY nothing scored').toBe(
        m.CACHE_MISMATCH_EXIT,
      );
      expect(rankedExitCode(true), 'and a MATCH published off a store that lied is not a 0').toBe(
        m.CACHE_MISMATCH_EXIT,
      );
    } finally {
      spy.mockRestore();
      for (const k of ['ASMLIFT_CANDCACHE', 'ASMLIFT_CANDCACHE_SAMPLE', 'ASMLIFT_CANDCACHE_DIR']) {
        if (saved[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[k];
        }
      }
    }
  });

  test('END TO END through runCli: the same score, the same stdout, a DIFFERENT status', async () => {
    // The whole discrimination, on one store. A poisoned run and a clean one produce byte-identical
    // `[ranked]` lines — that is what makes `bench regression` and `bench diff` blind — so the exit
    // status is the only place the difference can land, and 1 was already taken by "no match".
    const fixture = (f: string): string => join(import.meta.dirname, 'fixtures', 'objdiff', f);
    const root = scratch();
    const store = scratch();
    const asm = join(root, 'add_one.s');
    writeFileSync(asm, '\t.text\n\t.code\t16\n\t.globl\tadd_one\n\t.thumb_func\nadd_one:\n\tadd\tr0, #1\n\tbx\tlr\n');
    // A "compiler" that is a pure function of its input, which is all the namespace asks of it.
    const template = `cat {{inputPath}} > /dev/null && cp ${fixture('candidate-diff.o')} {{outputPath}}`;
    writeFileSync(
      join(root, 'decomp.yaml'),
      `platform: gba\ntools:\n  asmlift:\n    compiler: ${JSON.stringify(template)}\n`,
    );
    const args = [
      asm,
      '--name',
      'add_one',
      '--score-against',
      fixture('target.o'),
      '--config',
      join(root, 'decomp.yaml'),
    ];

    const run = async (sample: string): Promise<{ code: number; stdout: string; stderr: string }> => {
      const saved = { ...process.env };
      Object.assign(process.env, {
        ASMLIFT_CANDCACHE: '1',
        ASMLIFT_CANDCACHE_SAMPLE: sample,
        ASMLIFT_CANDCACHE_DIR: store,
      });
      vi.resetModules();
      try {
        return await (await import('../../src/main')).runCli(args);
      } finally {
        for (const k of ['ASMLIFT_CANDCACHE', 'ASMLIFT_CANDCACHE_SAMPLE', 'ASMLIFT_CANDCACHE_DIR']) {
          if (saved[k] === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = saved[k];
          }
        }
      }
    };
    /** Replace every stored object with the TARGET's own bytes — a store that answers, wrongly,
     *  and whose wrong answer is a byte-exact MATCH. */
    const poisonStore = (): number => {
      const objs: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.name === '.live') {
            continue;
          }
          const p = join(d, e.name);
          if (e.isDirectory()) {
            walk(p);
          } else if (e.name.endsWith('.o')) {
            objs.push(p);
          }
        }
      };
      walk(join(store, 'ns'));
      for (const o of objs) {
        writeFileSync(o, readFileSync(fixture('target.o')));
      }
      return objs.length;
    };

    const cold = await run('0');
    expect(cold.code, 'a nonmatching ranked run: the status this project publishes').toBe(1);
    expect(poisonStore()).toBeGreaterThan(0);

    const audited = await run('100');
    expect(audited.stderr).toContain('STORED ANSWER(S) DISAGREED WITH A FRESH COMPILE');
    expect(audited.code, 'a mismatch outranks "no match", or the status says nothing').toBe(3);
    expect(audited.stdout, 'the audit repaired the entry, so the published source is unchanged').toBe(cold.stdout);

    // THE CONTROL, and it is the whole argument: the same poisoned store with the audit off
    // publishes the target's own bytes as this candidate's, scores them byte-exact, and exits 0.
    // A silent wrong answer, from a run `bench regression` and `bench diff` both pass.
    poisonStore();
    const silent = await run('0');
    expect(silent.stderr).not.toContain('DISAGREED');
    expect(silent.stderr).toContain('(match)');
    expect(silent.code, 'a MATCH published off a store nobody audited').toBe(0);
  });

  test('and a clean run still says match-or-not, which is what every other reader depends on', async () => {
    vi.resetModules();
    const m = await import('../../src/candcache');
    expect(m.cacheMismatches()).toBe(0);
    const { rankedExitCode } = await import('../../src/main');
    expect(rankedExitCode(true)).toBe(0);
    expect(rankedExitCode(false)).toBe(1);
  });
});
