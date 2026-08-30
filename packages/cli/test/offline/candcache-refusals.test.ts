// What the candidate-object cache REFUSES, and what it audits — the two devices that stand between
// a stored answer and a silently wrong one, driven directly (src/candcache.ts).
//
// Every case below is a shape an audit reproduced on the shipped code, each of which served a
// stale or wrong answer with no perturbation of anything the design considered an input.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
});

describe('the mode parse is closed: an unrecognised value is OFF and LOUD, never "on"', () => {
  // `ASMLIFT_CANDCACHE=VERIFY` used to mean SERVE. A Gate-E run typed that way was a serve run
  // that printed `{"hit":…}` instead of `{"verified":…}` and reported clean.
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
