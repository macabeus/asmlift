// What the candidate-object cache REFUSES, and what it audits — the two devices that stand between
// a stored answer and a silently wrong one, driven directly (src/candcache.ts).
//
// Every case below is a shape an audit reproduced on the shipped code, each of which served a
// stale or wrong answer with no perturbation of anything the design considered an input.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// A BLOCKING-spawnSync suite in a pool whose config says there are none: every case here drives
// several `spawnSync` compiles, and the file's neighbours in `test:offline` run in parallel worker
// forks. Under the 5000 ms default the whole candcache family goes red on load alone — measured on
// one machine at one commit, loadavg ~65: 30 of these tests failed with `Test timed out in 5000ms`
// and two more cascaded into CONTENT assertions, which reads like a soundness failure and is not.
// `test:offline` is a CI gate on a shared runner, so the timeout is the honest knob.
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
  const d = mkdtempSync(join(tmpdir(), 'candcache-refuse-'));
  roots.push(d);
  return d;
};

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

const NS_A = 'a'.repeat(64);
const object = (bytes: string): string => {
  const p = join(scratch(), 'cand.o');
  writeFileSync(p, bytes);
  return p;
};

describe('a TU whose object is not a function of its own bytes is refused PER KEY', () => {
  // The regex this replaces ran on RAW text, and the preprocessor gets there first: phase 2
  // splices backslash-newlines, phase 3 replaces comments. Six spellings were demonstrated as
  // real includes that the guard passed — each one a header the namespace cannot see.
  test.each([
    ['plain', '#include "k.h"\nint f(void);\n'],
    ['backslash-newline inside the word', '#in\\\nclude "k.h"\nint f(void);\n'],
    ['backslash-newline after the #', '#\\\ninclude "k.h"\nint f(void);\n'],
    ['form feed before the #', '\f#include "k.h"\nint f(void);\n'],
    ['vertical tab before the #', '\v#include "k.h"\nint f(void);\n'],
    ['#import', '#import "k.h"\nint f(void);\n'],
    ['a comment between the # and the directive', '#/*c*/include "k.h"\nint f(void);\n'],
    ['#include_next', '#include_next "k.h"\nint f(void);\n'],
    ['the trigraph for #', '??=include "k.h"\nint f(void);\n'],
    // A comment is replaced by ONE SPACE, newlines and all — so this comment JOINS the two
    // physical lines into a single directive. Measured against the preprocessor that will read it:
    // `arm-none-eabi-cpp -nostdinc -I.` on this TU resolves `k.h` and substitutes its macro
    // (`int f(int x){return x*3;}`). A phase-3 normalisation that keeps the newlines "so line
    // starts survive" answers `undefined` here, which is the one spelling a raw `/^#include/`
    // cannot see either.
    ['a comment spanning the newline', '#/*\n*/include "k.h"\nint f(void);\n'],
    ['a comment spanning several newlines', '#/*\n\n*/include "k.h"\nint f(void);\n'],
  ])('a TU that reads a file is refused: %s', async (_name, tu) => {
    const r = await load({}, (m) => m.candidateCacheRefusal(tu));
    expect(r, 'the preprocessor resolves this include; the guard must see it too').toBe('the-TU-reads-a-file');
  });

  test.each([['__FILE__'], ['__DATE__'], ['__TIME__'], ['__TIMESTAMP__'], ['__BASE_FILE__']])(
    'a TU that bakes its path or the clock in is refused: %s',
    async (macro) => {
      // MEASURED before this existed: three uncached compiles of a `__FILE__` TU produced three
      // different 836-byte objects through the production namespace, and the stamp probe — one
      // fixed TU that uses neither macro — certified the pipeline pure and froze the first.
      const r = await load({}, (m) => m.candidateCacheRefusal(`const char *s = ${macro};\n`));
      expect(r).toBe('the-TU-bakes-its-path-or-the-clock-into-the-object');
    },
  );

  test('an ordinary candidate is NOT refused — the refusal is per key, not a switch', async () => {
    const tu = 's32 f(s32 a0) { /* not an #include, just prose */ return a0 + 1; }\n';
    expect(await load({}, (m) => m.candidateCacheRefusal(tu))).toBeUndefined();
  });

  test('a #include written INSIDE a multi-line comment is not one — the comment takes it with it', async () => {
    // The other direction of the same rule, and the one that keeps collapsing comments from
    // refusing every candidate whose prose mentions a header. Measured: this TU preprocesses to
    // `int f(int x){return x*2;}`, no include resolved.
    const tu = '/* a comment mentioning\n#include "k.h"\nspanning lines */\nint f(int x){return x*2;}\n';
    expect(await load({}, (m) => m.candidateCacheRefusal(tu))).toBeUndefined();
  });

  test('the per-key refusal is COUNTED, not only said — once per reason, every time', async () => {
    // Hole 2's entire protection reported nothing: `noteKeyRefused` said one line per reason and
    // bumped no counter, so a 16-shard run where an emitter change armed `#include` printed one
    // line in one shard's log and no number anywhere.
    const stats = await load({ ASMLIFT_CANDCACHE: '1' }, (m) => {
      m.noteKeyRefused('bench-agbcc', 'the-TU-reads-a-file');
      m.noteKeyRefused('bench-agbcc', 'the-TU-reads-a-file');
      m.noteKeyRefused('command', 'the-TU-reads-a-file');
      return m.cacheStats();
    });
    expect(stats.refusedKeys).toBe(3);
  });

  test('a stamp that is not a digest is refused, not truncated into a namespace', async () => {
    const said = await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: scratch() }, (m) => {
      let out = '';
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
        out += typeof c === 'string' ? c : Buffer.from(c).toString();
        return true;
      });
      try {
        const c = m.candCache('t', () => 'not-a-digest');
        c.warm();
        expect(c.mode).toBe('off');
        expect(c.get('k', 'f')).toBeUndefined();
        return out;
      } finally {
        spy.mockRestore();
      }
    });
    expect(said).toContain('reason=stamp-is-not-a-digest');
  });
});

describe('the mode parse is closed: an unrecognised value is OFF and LOUD, never "on"', () => {
  // `ASMLIFT_CANDCACHE=VERIFY` used to mean SERVE. A Gate-E run typed that way was a serve run
  // that printed `{"hit":…}` instead of `{"verified":…}` and reported clean.
  //
  // The parse got MORE load-bearing when the default flipped to `on`: every branch below that
  // lands on `off` is now a branch that has to say no against a default that says yes.
  test.each([
    ['verify', 'verify'],
    ['Verify', 'verify'],
    ['VERIFY', 'verify'],
    ['1', 'on'],
    ['on', 'on'],
    ['ON ', 'on'],
    ['true', 'on'],
    ['yes', 'on'],
    ['', 'off'],
    ['0', 'off'],
    ['off', 'off'],
    ['off ', 'off'],
    ['false', 'off'],
    ['no', 'off'],
    ['maybe', 'off'],
    ['2', 'off'],
  ])('ASMLIFT_CANDCACHE=%j → %s', async (raw, want) => {
    expect(await load({ ASMLIFT_CANDCACHE: raw }, (m) => m.cacheMode())).toBe(want);
  });

  test('an unrecognised value SAYS SO — silence is how the audit mode is lost to a typo', async () => {
    let said = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      said += typeof c === 'string' ? c : Buffer.from(c).toString();
      return true;
    });
    try {
      await load({ ASMLIFT_CANDCACHE: 'verfiy' }, (m) => m.cacheMode());
    } finally {
      spy.mockRestore();
    }
    expect(said).toContain('REFUSED reason=unrecognised-mode');
    expect(said).toContain('verfiy');
  });

  test('ASMLIFT_BENCH_CACHE=0 bypasses this cache too — it is documented as "the benchmark\'s caches"', async () => {
    expect(await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_BENCH_CACHE: '0' }, (m) => m.cacheMode())).toBe('off');
    expect(await load({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_BENCH_CACHE: '0' }, (m) => m.cacheMode())).toBe('off');
    expect(await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_BENCH_CACHE: undefined }, (m) => m.cacheMode())).toBe('on');
    // The case the flip CREATED: with unset meaning on, this is the only thing standing between a
    // developer bisecting a suspect row and a candidate object off disk.
    expect(
      await load({ ASMLIFT_CANDCACHE: undefined, ASMLIFT_BENCH_CACHE: '0' }, (m) => m.cacheMode()),
      'ASMLIFT_BENCH_CACHE=0 must beat the new default, not just an explicit request',
    ).toBe('off');
  });

  test('UNSET is ON — the default the flip installed, and the reason the cache was inert before', async () => {
    expect(await load({ ASMLIFT_CANDCACHE: undefined, ASMLIFT_BENCH_CACHE: undefined }, (m) => m.cacheMode())).toBe(
      'on',
    );
  });

  test('SET AND EMPTY is OFF, and it SAYS SO — unset and empty are no longer one state', async () => {
    // Before the flip both were `''` and both meant off, so nothing had to distinguish them.
    // `ASMLIFT_CANDCACHE=` now differs from no variable at all, and a reader who cannot see that
    // from the output would infer it from a missing `[candcache]` line, which is not evidence.
    let said = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      said += typeof c === 'string' ? c : Buffer.from(c).toString();
      return true;
    });
    let mode: string;
    try {
      mode = await load({ ASMLIFT_CANDCACHE: '', ASMLIFT_BENCH_CACHE: undefined }, (m) => m.cacheMode());
    } finally {
      spy.mockRestore();
    }
    expect(mode).toBe('off');
    expect(said).toContain('SET AND EMPTY');
  });

  test('an unrecognised value does NOT inherit the new default — it is refused onto off', async () => {
    // The silent failure the closed parse exists to prevent, restated for a world where falling
    // through means SERVING rather than doing nothing.
    for (const raw of ['maybe', '2', 'ONN', 'verifyy']) {
      expect(await load({ ASMLIFT_CANDCACHE: raw, ASMLIFT_BENCH_CACHE: undefined }, (m) => m.cacheMode())).toBe('off');
    }
  });
});

describe('a malformed cap does not silently disable the prune AND its own warning', () => {
  test('MAX_MB=abc is rejected out loud and the default stands', async () => {
    let said = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      said += typeof c === 'string' ? c : Buffer.from(c).toString();
      return true;
    });
    try {
      // Number('abc') is NaN, and BOTH `distinct <= CAP` and the over-cap warning are false for
      // NaN: the store grew without bound with no output at all.
      await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_MAX_MB: 'abc' }, (m) => m.cacheMode());
    } finally {
      spy.mockRestore();
    }
    expect(said).toContain('ignoring ASMLIFT_CANDCACHE_MAX_MB');
  });
});

describe('verify mode audits BOTH directions — the outcome, not only the bytes', () => {
  const capture = async (
    env: Record<string, string | undefined>,
    fn: (m: CandCacheModule) => void,
  ): Promise<{ said: string; stats: Record<string, number> }> => {
    let said = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      said += typeof c === 'string' ? c : Buffer.from(c).toString();
      return true;
    });
    try {
      return await load(env, (m) => {
        fn(m);
        return { said, stats: m.cacheStats() };
      });
    } finally {
      spy.mockRestore();
    }
  };

  test('a stored REJECTION against a fresh OBJECT is a mismatch — the direction that drops a spelling', async () => {
    // Served under `on`, a stale rejection throws for a candidate that compiles: the spelling
    // leaves the row's fan silently, and it might have been the match. 77% of a warm store's
    // served answers are rejections, and verify mode used to look at none of them.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).putFail('k', 'f', 'agbcc failed: c.c:3: syntax error');
    });
    const { said, stats } = await capture({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).verify('k', 'f', object('THE-TRUTH'));
    });
    expect(stats).toMatchObject({ mismatch: 1 });
    expect(said).toContain('OUTCOME MISMATCH');
    expect(said).toContain('stored=rejection');
    // and the store is REPAIRED: the next `on` run must not throw the stale rejection again.
    const served = await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) =>
      m.candCache('t', () => NS_A).get('k', 'f'),
    );
    expect(typeof served).toBe('string');
    expect(readFileSync(served as string, 'utf8')).toBe('THE-TRUTH');
  });

  test('a stored OBJECT against a fresh REJECTION is a mismatch — a candidate scored on dead bytes', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).put('k', 'f', object('STALE'));
    });
    const { said, stats } = await capture({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).verifyFail('k', 'f', 'agbcc failed: c.c:3: syntax error');
    });
    expect(stats).toMatchObject({ mismatch: 1 });
    expect(said).toContain('OUTCOME MISMATCH');
    expect(said).toContain('stored=object');
    const served = await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) =>
      m.candCache('t', () => NS_A).get('k', 'f'),
    );
    expect(served).toBeInstanceOf(Error);
  });

  test('an agreeing REJECTION is COUNTED — an audit that skips 77% of the store is not an audit', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).putFail('k', 'f', 'agbcc failed: c.c:3: syntax error');
    });
    const { said, stats } = await capture({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      // The OUTCOME is compared, not the diagnostic text: a message can carry a scratch path or a
      // line the harness reformats, and neither is the answer the cache serves.
      m.candCache('t', () => NS_A).verifyFail('k', 'f', 'agbcc failed: c.c:3: syntax error before ")"');
    });
    expect(stats).toMatchObject({ verifiedFail: 1 });
    expect(stats.mismatch).toBeUndefined();
    expect(said).not.toContain('MISMATCH');
  });

  test('a mismatch is written to MISMATCH_LOG, where a gate in ANOTHER process reads it', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).put('k', 'f', object('STALE'));
    });
    await capture({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).verify('k', 'f', object('FRESH'));
    });
    expect(readFileSync(join(root, 'MISMATCHES.log'), 'utf8')).toContain('BYTE MISMATCH');
  });
});

describe('the store survives another process rewriting it under us', () => {
  test('a key whose object vanishes between the check and the read is a MISS, never a throw', async () => {
    // `existsSync(o) && statSync(o).size > 0` is a TOCTOU, and the throw escaped the module: at
    // the call site an ENOENT stack reads as a failed candidate compile — a valid spelling
    // silently dropped. Measured under one concurrent writer: 13 throws in 15,000 lookups.
    const root = scratch();
    const stat = await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.put('k', 'f', object('SOMETHING'));
      // stand in for the pruner: delete every key link the way a concurrent process would
      const nsDir = join(root, 'ns', NS_A.slice(0, 16));
      for (const ab of readdirSync(nsDir, { withFileTypes: true })) {
        if (ab.isDirectory() && !ab.name.startsWith('.')) {
          rmSync(join(nsDir, ab.name), { recursive: true, force: true });
        }
      }
      expect(() => c.get('k', 'f')).not.toThrow();
      expect(c.get('k', 'f')).toBeUndefined();
      return m.cacheStats();
    });
    expect(stat.miss).toBeGreaterThan(0);
  });

  test('a key whose entry is not the FILE the check assumed is a miss, not a throw', async () => {
    // The TOCTOU in its deterministic form. `existsSync(o) && statSync(o).size > 0` then
    // `readFileSync(f)` are two calls about a store another process is rewriting; between them the
    // answer can be anything. A directory standing where a `.o` or a `.fail` should be reproduces
    // both halves without a race: the old code returned the directory AS A HIT (a size > 0 that is
    // not an object) and threw EISDIR out of the negative branch, and the throw reached the call
    // site as a failed candidate compile — a valid spelling silently dropped.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.put('k', 'f', object('SOMETHING'));
      const nsDir = join(root, 'ns', NS_A.slice(0, 16));
      const shard = readdirSync(nsDir, { withFileTypes: true }).find((e) => e.isDirectory() && !e.name.startsWith('.'));
      const file = readdirSync(join(nsDir, shard!.name))[0];
      const key = join(nsDir, shard!.name, file);
      rmSync(key, { force: true });
      mkdirSync(key); // the `.o` path is now a directory with a nonzero stat size
      expect(() => c.get('k', 'f')).not.toThrow();
      expect(c.get('k', 'f'), 'a directory is not an object').toBeUndefined();
      rmSync(key, { recursive: true, force: true });
      mkdirSync(key.replace(/\.o$/, '.fail')); // …and now the negative branch's path is one
      expect(() => c.get('k', 'f')).not.toThrow();
      expect(c.get('k', 'f')).toBeUndefined();
    });
  });

  test('a replacement that FAILS does not destroy the answer already there', async () => {
    // `rmSync(dest); linkSync(objPath, dest)` deletes the answer BEFORE it has one to put back —
    // a sibling process reading that path in the window gets ENOENT on a key that is permanently
    // in the store (13 throws and 34 failed reads in 15,000 concurrent lookups, measured). The
    // fix is link-to-temp-then-rename, and the observable consequence, without a race: when the
    // link cannot be made at all, the previous answer is still there afterwards.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      const dest = c.put('k', 'f', object('ONE'));
      expect(readFileSync(dest, 'utf8')).toBe('ONE');
      // Make the content-addressed entry for the NEW bytes a directory: linkSync and copyFileSync
      // both fail on it, which is the "replacement could not be completed" case.
      const h = createHash('sha256').update('TWO').digest('hex');
      mkdirSync(join(root, 'objects', h.slice(0, 2), h), { recursive: true });
      c.put('k', 'f', object('TWO'));
      expect(existsSync(dest), 'the old answer must survive a replacement that could not finish').toBe(true);
      expect(readFileSync(dest, 'utf8')).toBe('ONE');
      expect(c.get('k', 'f')).toBe(dest);
    });
  });

  test('replacing a key never leaves the served path missing — link-to-temp, then rename', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      const first = c.put('k', 'f', object('ONE'));
      expect(existsSync(first)).toBe(true);
      const second = c.put('k', 'f', object('TWO'));
      expect(second).toBe(first);
      expect(readFileSync(second, 'utf8')).toBe('TWO');
      // no temp litter left behind next to it
      const dir = join(root, 'ns', NS_A.slice(0, 16));
      const litter: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) {
            walk(join(d, e.name));
          } else if (e.name.includes('.link') || e.name.includes('.tmp')) {
            litter.push(e.name);
          }
        }
      };
      walk(dir);
      expect(litter).toEqual([]);
    });
  });
});

describe('a store this process cannot prepare is a COLD store, never a dropped candidate', () => {
  // `putFail` and `pruneOnce` both already said it in so many words ("a store that cannot be
  // written is a cold store", "an unreadable store is a cache miss, never an error"). `namespace()`
  // did not: `mkdirSync` / `utimesSync` / `claimNamespace` sat outside the try that guards
  // `stamp()`, so the throw escaped `get`/`put`/`warm` into the candidate compile — where
  // compile-command.ts and compile/agbcc.ts read ANY exception as "this spelling does not compile"
  // and delete it from the fan. MEASURED end to end against a read-only store: `1 dropped`, the
  // published winner moved `unsigned` -> `signed` on the one line docs/ranked-repro.md tells
  // readers to quote, and the `[candcache]` line still read a clean `{"hit":1}`.
  const captureAll = async (
    env: Record<string, string | undefined>,
    fn: (m: CandCacheModule) => void,
  ): Promise<{ said: string; stats: Record<string, number> }> => {
    let said = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      said += typeof c === 'string' ? c : Buffer.from(c).toString();
      return true;
    });
    try {
      return await load(env, (m) => {
        fn(m);
        return { said, stats: m.cacheStats() };
      });
    } finally {
      spy.mockRestore();
    }
  };

  /** A ROOT whose parent is a FILE: `mkdir` answers ENOTDIR on every platform, and unlike `chmod`
   *  it does not depend on whether the test runs as root (hosted CI containers often do). */
  const unusableRoot = (): string => {
    const f = join(scratch(), 'not-a-directory');
    writeFileSync(f, 'x');
    return join(f, 'store');
  };

  test('every entry point answers like a miss and NOTHING throws', async () => {
    const root = unusableRoot();
    const { said, stats } = await captureAll({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      const scratchObj = object('FRESHLY-COMPILED');
      expect(() => c.warm()).not.toThrow();
      expect(c.get('k', 'f')).toBeUndefined();
      // put hands back the CALLER'S OWN path, which is the answer it just compiled.
      expect(c.put('k', 'f', scratchObj)).toBe(scratchObj);
      expect(() => c.putFail('k2', 'f', 'agbcc failed (exit 1)')).not.toThrow();
      expect(c.mode, 'and the instance is off for the rest of the process').toBe('off');
    });
    expect(said).toContain('REFUSED label=t reason=store-unusable');
    expect(stats).toMatchObject({ refused: 1 });
  });

  test('the refusal is said ONCE, not once per candidate', async () => {
    const root = unusableRoot();
    const { said, stats } = await captureAll({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      for (let i = 0; i < 20; i++) {
        c.get(`k${i}`, 'f');
      }
    });
    expect(said.split('store-unusable').length - 1).toBe(1);
    expect(stats.refused).toBe(1);
  });
});

describe('the matching gate upgrades to verify off ONE list of off-words, never a copy of it', () => {
  // `pnpm test:matching` is the only thing in this repo that audits the store a developer's real
  // runs have filled, so its globalSetup forces `verify`. It decided that with
  // `asked !== '0' && asked !== 'off'` — a two-element copy of a list candcache.ts already owns —
  // and therefore forced `verify` for `false`, `no`, `disable` and the SET-AND-EMPTY state, every
  // one of which the module calls OFF and docs/ranked-repro.md describes as "touches no disk".
  // Under a forced `verify` such a run stores every key and appends to the SHARED
  // `MISMATCHES.log`, which a neighbour worktree's lines can then fail the teardown on.
  //
  // UNSET is the case the obvious fix breaks: `process.env.X ?? ''` puts unset INTO the off-words
  // (`''` is one), and unset means the module's default, which is `on` — this suite must upgrade
  // it. The two states have to stay apart here exactly as they do in the module.
  const modeAfterSetup = async (raw: string | undefined): Promise<string | undefined> => {
    const saved = process.env.ASMLIFT_CANDCACHE;
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      if (raw === undefined) {
        delete process.env.ASMLIFT_CANDCACHE;
      } else {
        process.env.ASMLIFT_CANDCACHE = raw;
      }
      vi.resetModules();
      (await import('../matching/candcache-gate')).default();
      return process.env.ASMLIFT_CANDCACHE;
    } finally {
      spy.mockRestore();
      if (saved === undefined) {
        delete process.env.ASMLIFT_CANDCACHE;
      } else {
        process.env.ASMLIFT_CANDCACHE = saved;
      }
    }
  };

  test.each([['0'], ['off'], ['false'], ['no'], ['n'], ['disable'], ['disabled'], [''], ['OFF'], [' off ']])(
    'ASMLIFT_CANDCACHE=%j is left OFF — a no-disk spelling must not be upgraded to a storing mode',
    async (raw) => {
      expect(await modeAfterSetup(raw)).toBe(raw);
    },
  );

  test.each([[undefined], ['1'], ['on'], ['true'], ['yes'], ['verify'], ['nonsense']])(
    'ASMLIFT_CANDCACHE=%j becomes verify — the gate may not be SERVED, and unset means on',
    async (raw) => {
      expect(await modeAfterSetup(raw)).toBe('verify');
    },
  );
});
