// The candidate-object STORE itself (src/candcache.ts): what is on disk, how it dedups, what it
// evicts, and what it refuses. The two consumer seams are tested next door (candcache.test.ts);
// this file drives the module directly, with a stamp the test supplies.
//
// The store is two levels because the redundancy is real: 65,280 LBG candidate objects are
// 144.9 MB logical and only 14,484 distinct = 32.1 MB. Content-addressed bytes under `objects/`,
// hardlinked per key under `ns/<namespace>/` — so a key costs an inode, not a copy, and evicting
// one namespace leaves every other namespace's answers intact.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  const d = mkdtempSync(join(tmpdir(), 'candcache-store-'));
  roots.push(d);
  return d;
};

/** candcache.ts reads its environment ONCE, at module load, so every case gets its own registry. */
async function load<T>(
  env: Record<string, string | undefined>,
  fn: (m: CandCacheModule) => Promise<T> | T,
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
    return await fn(await import('../../src/candcache'));
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
const NS_B = 'b'.repeat(64);
/** An "object" the caller just compiled, at a scratch path. */
const object = (bytes: string): string => {
  const p = join(scratch(), 'cand.o');
  writeFileSync(p, bytes);
  return p;
};
/** Backdate a namespace past the prune grace window, standing in for "a previous day's run".
 *  Inside the window a namespace is treated as possibly live in a sibling PROCESS — `pnpm bench
 *  run` forks 8-16 shards over one store — and is never evicted. */
const age = (root: string, ns: string): void => {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(join(root, 'ns', ns.slice(0, 16)), old, old);
};

const objectsIn = (root: string): string[] => {
  const dir = join(root, 'objects');
  return readdirSync(dir, { withFileTypes: true }).flatMap((ab) =>
    ab.isDirectory() ? readdirSync(join(dir, ab.name)).map((f) => join(dir, ab.name, f)) : [],
  );
};

describe('the store is content-addressed and hardlinked', () => {
  test('four keys whose objects agree cost ONE copy of the bytes and four inodes', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      for (const key of ['k1', 'k2', 'k3', 'k4']) {
        c.put(key, 'f', object('IDENTICAL-OBJECT-BYTES'));
      }
      const objs = objectsIn(root);
      expect(objs.length, 'four candidates, one distinct object').toBe(1);
      // 4 key links + the objects/ entry itself.
      expect(statSync(objs[0]).nlink).toBe(5);
      expect(m.cacheStats()).toMatchObject({ stored: 4 });
    });
  });

  test('put returns the STORE path, so a cold run and a warm run hand back the same kind of path', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      const served = c.put('k', 'f', object('OBJ'));
      expect(served.startsWith(join(root, 'ns'))).toBe(true);
      expect(c.get('k', 'f')).toBe(served);
      expect(readFileSync(served, 'utf8')).toBe('OBJ');
    });
  });

  test('the SYMBOL and the NAMESPACE are both inside the key', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).put('k', 'f', object('FOR-F'));
      expect(m.candCache('t', () => NS_A).get('k', 'other')).toBeUndefined();
      expect(m.candCache('t', () => NS_B).get('k', 'f')).toBeUndefined();
      expect(m.candCache('other-label', () => NS_A).get('k', 'f')).toBeUndefined();
    });
  });

  test('an EMPTY object is never stored — it is not an answer, and the caller`s guards speak', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      const scratchPath = object('');
      expect(c.put('k', 'f', scratchPath), 'the scratch path comes straight back').toBe(scratchPath);
      expect(c.get('k', 'f')).toBeUndefined();
      expect(objectsIn(root)).toEqual([]);
    });
  });

  test('a stored deterministic REJECTION reads back as an Error carrying its diagnostic', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).putFail('k', 'f', "agbcc failed: c.c:2: conflicting types for `f'");
      const hit = m.candCache('t', () => NS_A).get('k', 'f');
      expect(hit).toBeInstanceOf(Error);
      expect((hit as Error).message).toContain('conflicting types');
      expect(m.cacheStats()).toMatchObject({ failHit: 1 });
    });
  });
});

describe('the LRU cap evicts whole namespaces, oldest first, and never the one in use', () => {
  test('over the cap: the cold namespace goes, its objects are reaped, the live one stays', async () => {
    const root = scratch();
    // Run one: fill namespace A with a generous cap so nothing prunes.
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.put('k1', 'f', object('A-ONE'));
      c.put('k2', 'f', object('A-TWO'));
    });
    expect(objectsIn(root).length).toBe(2);
    age(root, NS_A);

    // Run two: a new namespace, and a cap of zero. A is cold, B is in use.
    const err = await load(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '0' },
      (m) => {
        let out = '';
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
          out += typeof c === 'string' ? c : Buffer.from(c).toString();
          return true;
        });
        try {
          const c = m.candCache('t', () => NS_B);
          c.warm();
          c.put('k3', 'f', object('B-ONE'));
          expect(m.cacheStats()).toMatchObject({ prunedNamespaces: 1, prunedObjects: 2 });
        } finally {
          spy.mockRestore();
        }
        return out;
      },
    );

    expect(readdirSync(join(root, 'ns')), 'the namespace in use survives its own cap').toEqual([NS_B.slice(0, 16)]);
    // A's two objects are gone; B's one, written after the prune, is not.
    expect(objectsIn(root).length).toBe(1);
    expect(readFileSync(objectsIn(root)[0], 'utf8')).toBe('B-ONE');
    expect(err).not.toContain('BYTE MISMATCH');
  });

  test('the namespace IN USE is never evicted, even when the store stays over the cap', async () => {
    const root = scratch();
    // A warm store, then a run that re-uses namespace A while B sits cold and the cap is zero.
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_A).put('k1', 'f', object('A-ONE'));
    });
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_B).put('k2', 'f', object('B-ONE'));
    });

    age(root, NS_B);
    const said = await load(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '0' },
      (m) => {
        let out = '';
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
          out += typeof c === 'string' ? c : Buffer.from(c).toString();
          return true;
        });
        try {
          const c = m.candCache('t', () => NS_A);
          c.warm();
          // The whole point: A's own answers are still there afterwards. Evicting the namespace
          // a run is USING would delete a file the scorer is about to read by path.
          expect(readFileSync(c.get('k1', 'f') as string, 'utf8')).toBe('A-ONE');
          expect(m.cacheStats()).toMatchObject({ prunedNamespaces: 1, hit: 1 });
          return out;
        } finally {
          spy.mockRestore();
        }
      },
    );
    expect(said).toContain('not pruning it');
    expect(readdirSync(join(root, 'ns'))).toEqual([NS_A.slice(0, 16)]);
  });

  test('a namespace touched RECENTLY is spared even over the cap — a sibling shard may hold it', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_A).put('k1', 'f', object('A-ONE'));
    });
    // NOT aged: `pnpm bench run` forks 8-16 shards over one store, and a shard compiling for one
    // toolchain must not delete the namespace a sibling is reading objects out of BY PATH.
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '0' }, (m) => {
      m.candCache('t', () => NS_B).warm();
      expect(m.cacheStats().prunedNamespaces).toBeUndefined();
    });
    expect(readdirSync(join(root, 'ns')).sort()).toEqual([NS_A.slice(0, 16), NS_B.slice(0, 16)].sort());
  });

  test('under the cap: nothing is pruned at all', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_A).put('k1', 'f', object('A-ONE'));
    });
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_B).warm();
      expect(m.cacheStats().prunedNamespaces).toBeUndefined();
    });
    expect(readdirSync(join(root, 'ns')).sort()).toEqual([NS_A.slice(0, 16), NS_B.slice(0, 16)].sort());
  });
});

describe('every refusal says WHY on stderr, and turns the instance off for the process', () => {
  const refusal = async (stamp: () => string): Promise<{ said: string; mode: string; wroteAnything: boolean }> => {
    const root = scratch();
    return load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      let said = '';
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
        said += typeof c === 'string' ? c : Buffer.from(c).toString();
        return true;
      });
      try {
        const c = m.candCache('t', stamp);
        c.warm();
        const scratchPath = object('OBJ');
        expect(c.get('k', 'f'), 'a refused cache is a permanent miss').toBeUndefined();
        expect(c.put('k', 'f', scratchPath), 'and it hands the scratch path straight back').toBe(scratchPath);
        return { said, mode: c.mode, wroteAnything: readdirSync(root).length > 0 };
      } finally {
        spy.mockRestore();
      }
    });
  };

  test('NOT_CACHEABLE — the object is not a pure function of its input', async () => {
    const r = await refusal(() => ' NOT_CACHEABLE ');
    expect(r.said).toContain('REFUSED label=t reason=object-is-not-a-pure-function-of-its-input');
    expect(r.mode).toBe('off');
    expect(r.wroteAnything).toBe(false);
  });

  test('a stamp that THROWS — an input it could not read is a refusal, never a guess', async () => {
    const r = await refusal(() => {
      throw new Error('ENOENT: no such file or directory, open ...agbcc.ts');
    });
    expect(r.said).toContain('REFUSED label=t reason=stamp-threw:');
    expect(r.said).toContain('agbcc.ts');
    expect(r.mode).toBe('off');
  });

  test('a stamp that is not a digest — a version constant would be exactly this mistake', async () => {
    const r = await refusal(() => 'v3');
    expect(r.said).toContain('REFUSED label=t reason=stamp-is-not-a-digest');
    expect(r.mode).toBe('off');
  });

  test('the stamp is called AT MOST ONCE, however many times the cache is asked', async () => {
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: scratch() }, (m) => {
      let calls = 0;
      const c = m.candCache('t', () => {
        calls++;
        return NS_A;
      });
      c.warm();
      c.warm();
      c.get('k', 'f');
      c.put('k', 'f', object('OBJ'));
      expect(calls, 'the stamp runs a real compile; running it twice is a cost and a hazard').toBe(1);
    });
  });
});

describe('verify mode compiles anyway, compares, and lets the FRESH bytes win', () => {
  test('a corrupted entry is reported byte for byte and repaired', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).put('k', 'f', object('THE-TRUTH'));
    });
    expect(objectsIn(root).length).toBe(1);

    const said = await load({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      let out = '';
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
        out += typeof c === 'string' ? c : Buffer.from(c).toString();
        return true;
      });
      try {
        const c = m.candCache('t', () => NS_A);
        expect(m.cacheMode()).toBe('verify');
        // The caller compiled fresh and got DIFFERENT bytes: that is the whole point of the mode.
        c.verify('k', 'f', object('NOT-THE-TRUTH'));
        expect(m.cacheStats()).toMatchObject({ verified: 1, mismatch: 1 });
        return out;
      } finally {
        spy.mockRestore();
      }
    });
    expect(said).toContain('BYTE MISMATCH label=t');
    expect(said).toContain('symbol=f');

    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const hit = m.candCache('t', () => NS_A).get('k', 'f');
      expect(readFileSync(hit as string, 'utf8'), 'the fresh bytes replaced the stored ones').toBe('NOT-THE-TRUTH');
    });
  });

  test('matching bytes are counted and nothing is said', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).put('k', 'f', object('AGREED'));
    });
    await load({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      m.candCache('t', () => NS_A).verify('k', 'f', object('AGREED'));
      expect(m.cacheStats()).toMatchObject({ verified: 1 });
      expect(m.cacheStats().mismatch).toBeUndefined();
    });
  });
});
