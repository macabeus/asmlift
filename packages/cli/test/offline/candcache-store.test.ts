// The candidate-object STORE itself (src/candcache.ts): what is on disk, how it dedups, what it
// evicts, and what it refuses. The two consumer seams are tested next door (candcache.test.ts);
// this file drives the module directly, with a stamp the test supplies.
//
// The store is two levels because the redundancy is real: 65,280 LBG candidate objects are
// 144.9 MB logical and only 14,484 distinct = 32.1 MB. Content-addressed bytes under `objects/`,
// hardlinked per key under `ns/<namespace>/` — so a key costs an inode, not a copy, and evicting
// one namespace leaves every other namespace's answers intact.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
const objectsIn = (root: string): string[] => {
  const dir = join(root, 'objects');
  return readdirSync(dir, { withFileTypes: true }).flatMap((ab) =>
    ab.isDirectory() ? readdirSync(join(dir, ab.name)).map((f) => join(dir, ab.name, f)) : [],
  );
};

/** Backdate a namespace AND the objects it wrote past the two grace windows, standing in for "a
 *  previous day's run". Inside the namespace window a namespace is treated as possibly live in a
 *  sibling PROCESS — `pnpm bench run` forks 8-16 shards over one store — and is never evicted;
 *  inside the shorter object window an unlinked `objects/` entry is presumed to be mid-`put` in
 *  another process (written, not yet hardlinked) and is not reaped. A previous day's run is past
 *  both, which is what this stands in for. */
const age = (root: string, ns: string): void => {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(join(root, 'ns', ns.slice(0, 16)), old, old);
  for (const o of objectsIn(root)) {
    utimesSync(o, old, old);
  }
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

  test('the namespace IN USE keeps its DIRECTORY and loses its oldest keys — the cap fires on one toolchain', async () => {
    // The steady state of this repo is ONE agbcc namespace that every run resolves, growing by
    // ~640 keys a run forever: 46,197 keys / 155.3 MB after one full bench run. If the only
    // evictable unit were a whole OTHER namespace, the cap could never fire there at all — which
    // is what a wall-clock "not resolved for an hour" test on the namespace this run just
    // resolved amounts to. Its directory and its lease survive; its oldest-written keys do not.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_A).put('k1', 'f', object('A-ONE'));
    });
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_B).put('k2', 'f', object('B-ONE'));
    });

    age(root, NS_B);
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '0' }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.warm();
      expect(m.cacheStats()).toMatchObject({ prunedNamespaces: 1, prunedKeys: 1 });
      expect(c.get('k1', 'f'), 'the evicted key is a MISS, which is always a correct answer').toBeUndefined();
    });
    expect(readdirSync(join(root, 'ns')), 'the directory the run is using is never removed').toEqual([
      NS_A.slice(0, 16),
    ]);
    expect(objectsIn(root).length, 'and the bytes nothing links to any more are reclaimed').toBe(0);
  });

  test('…but not while ANOTHER process holds it: a key eviction would delete a path it is about to read', async () => {
    // `put` hands the caller a path INSIDE the namespace and the scorer opens it later, so key
    // eviction is safe only because it runs once, before this process compiles anything, and only
    // when no other process has claimed the namespace. A sibling shard's lease outranks the cap.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_A).put('k1', 'f', object('A-ONE'));
    });
    // pid 1 is launchd/init: certainly alive, certainly not us.
    mkdirSync(join(root, 'ns', NS_A.slice(0, 16), '.live'), { recursive: true });
    writeFileSync(join(root, 'ns', NS_A.slice(0, 16), '.live', '1-sibling'), '1\n');

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
          expect(m.cacheStats().prunedKeys).toBeUndefined();
          expect(readFileSync(c.get('k1', 'f') as string, 'utf8')).toBe('A-ONE');
          return out;
        } finally {
          spy.mockRestore();
        }
      },
    );
    expect(said).toContain('another process holds the namespace this run is using');
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

  test('an object written MOMENTS ago is not reaped — another process may be mid-put', async () => {
    // `linkInto` writes `objects/<sha>` and hardlinks it a moment later. In that window the object
    // has nlink === 1 and looks like garbage to a reaper in a sibling shard, which would delete the
    // answer that process is about to serve BY PATH. Same setup as the eviction test above, minus
    // the backdating of the objects.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.put('k1', 'f', object('A-ONE'));
      c.put('k2', 'f', object('A-TWO'));
    });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(join(root, 'ns', NS_A.slice(0, 16)), old, old); // the NAMESPACE is cold…
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '0' }, (m) => {
      const c = m.candCache('t', () => NS_B);
      c.warm();
      expect(m.cacheStats()).toMatchObject({ prunedNamespaces: 1 });
      expect(m.cacheStats().prunedObjects, '…but its objects are too young to reap').toBeUndefined();
    });
    expect(objectsIn(root).length, 'the bytes survive the window and are reclaimed by a later prune').toBe(2);
  });

  test('a namespace a LIVE process holds is never evicted, however cold its mtime is', async () => {
    // `keepNs` protects only the pruner's OWN namespace. The store is shared: `pnpm bench run`
    // forks 8-16 shards over one directory, and `bench fidelity` re-executes 1234 scripts for far
    // longer than any wall-clock grace window. A shard that resolved hours ago and is still
    // serving objects BY PATH out of its namespace was protected by nothing. So a process CLAIMS
    // its namespace with a lease file, and a pruner reads the lease's pid.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      m.candCache('t', () => NS_A).put('k1', 'f', object('A-ONE'));
    });
    age(root, NS_A);
    // pid 1 is launchd/init: a process that is certainly alive and is certainly not us.
    mkdirSync(join(root, 'ns', NS_A.slice(0, 16), '.live'), { recursive: true });
    writeFileSync(join(root, 'ns', NS_A.slice(0, 16), '.live', '1-sibling'), '1\n');

    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '0' }, (m) => {
      m.candCache('t', () => NS_B).warm();
      expect(m.cacheStats().prunedNamespaces, 'a live holder outranks the cap').toBeUndefined();
    });
    expect(readdirSync(join(root, 'ns')).sort()).toEqual([NS_A.slice(0, 16), NS_B.slice(0, 16)].sort());

    // …and once the lease's pid is gone, the same namespace IS reclaimable.
    rmSync(join(root, 'ns', NS_A.slice(0, 16), '.live', '1-sibling'), { force: true });
    writeFileSync(join(root, 'ns', NS_A.slice(0, 16), '.live', '2147483000-dead'), '2147483000\n');
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '0' }, (m) => {
      m.candCache('t', () => NS_B).warm();
      expect(m.cacheStats()).toMatchObject({ prunedNamespaces: 1 });
    });
  });

  test('the cap counts the NEGATIVE entries too — they are most of the store and weighed zero', async () => {
    // MEASURED on one full-bench store: `objects/` 7.57 MB against `du -sm` 156 MB, because
    // `putFail` writes straight into `ns/` and a 200-byte `.fail` costs a whole allocation block.
    // A cap counting only `objects/` saw 4.9% of the cost and would fire after ~540 bench runs.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '4096' }, (m) => {
      const c = m.candCache('t', () => NS_A);
      for (let i = 0; i < 300; i++) {
        c.putFail(`k${i}`, 'f', "agbcc failed: c.c:2: conflicting types for `f'");
      }
    });
    expect(objectsIn(root).length, 'not one byte of this store is in objects/').toBe(0);
    age(root, NS_A);
    // 300 entries x one 4096-byte block = ~1.2 MB of real cost against a 0.5 MB cap; the same
    // store weighs 0 MB by the old accounting, so nothing would prune.
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root, ASMLIFT_CANDCACHE_MAX_MB: '0.5' }, (m) => {
      m.candCache('t', () => NS_B).warm();
      expect(m.cacheStats()).toMatchObject({ prunedNamespaces: 1 });
    });
    expect(readdirSync(join(root, 'ns'))).toEqual([NS_B.slice(0, 16)]);
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
  test('the audit reads the store through the SERVE path — an object outranks a rejection', async () => {
    // `verify` used to ask the store its own way (a `.fail` first, then an `.o`), which is the
    // opposite of what `get` does. So the precedence between the two entries for one key — which
    // is what a warm run actually serves — was outside the audit's reach by construction, and a
    // key holding both reported an OUTCOME MISMATCH about an answer nobody would ever be served.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.put('k', 'f', object('TRUTH'));
      c.putFail('k', 'f', 'agbcc failed: stale');
      expect(readFileSync(c.get('k', 'f') as string, 'utf8'), 'this is what a warm run is served').toBe('TRUTH');
    });
    await load({ ASMLIFT_CANDCACHE: 'verify', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.verify('k', 'f', object('TRUTH'));
      expect(m.cacheStats()).toMatchObject({ verified: 1 });
      expect(m.cacheMismatches(), 'the served answer agreed; there is nothing to report').toBe(0);
    });
  });

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
        // `verified` counts audits that AGREED. A disagreement is `mismatch` and nothing else, so
        // the two never have to be read against each other to learn whether the store was right.
        expect(m.cacheStats()).toMatchObject({ mismatch: 1 });
        expect(m.cacheStats().verified).toBeUndefined();
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

describe('EXISTENCE IS NOT CONTENT: a corrupt objects/<sha> entry is caught where the truth is in hand', () => {
  // The threat `linkInto` names in its own docstring — "an entry can be wrong: a disk error, an
  // external edit, or a write THROUGH one of its hardlinks" — reached the caller through the ONE
  // path no audit covers. Sampling is reached from `get`, so it can only ever look at a key the
  // store already answers; `put` is a MISS by construction. So a run where every key missed, every
  // candidate was freshly and correctly compiled, and the audit was at 100% still handed the
  // scorer bytes that were not the object it had just compiled — measured end to end as a NONMATCH
  // published as a byte-exact MATCH with exit 0.
  //
  // A `put` holds the truth in memory and has already hashed it, so the comparison costs one read
  // of a file the dedup path was about to link anyway.
  test('a put whose bytes dedup onto a CORRUPTED object reports a mismatch and repairs it', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      c.put('k1', 'f', object('TRUTH-BYTES'));
      const [obj] = objectsIn(root);
      // The filename still says sha(TRUTH-BYTES); the contents no longer hash to it.
      writeFileSync(obj, 'CORRUPT-BYTES-OF-A-DIFFERENT-LENGTH');

      const served = c.put('k2', 'f', object('TRUTH-BYTES'));
      expect(readFileSync(served, 'utf8'), 'the caller is served what it compiled, never the store`s claim').toBe(
        'TRUTH-BYTES',
      );
      expect(readFileSync(obj, 'utf8'), 'and the content-addressed entry is repaired').toBe('TRUTH-BYTES');
      expect(m.cacheMismatches(), 'a store that disagreed with the compiler must FAIL the run').toBe(1);
      expect(readFileSync(m.mismatchLogFor(root), 'utf8')).toContain('OBJECT STORE CORRUPT');
      // Counted APART from an audit mismatch: it is not an audit of a withheld key, and folding
      // it in would break the identity `sampled` is read against.
      expect(m.cacheStats()).toMatchObject({ objectCorrupt: 1 });
      expect(m.cacheStats().mismatch).toBeUndefined();
    });
  });

  test('every key ALREADY linked to the corrupt object is repaired too — the repair goes through the inode', async () => {
    // The reason the repair is a plain in-place write and not `writeAtomic`. Renaming a new inode
    // over `objects/<sha>` repairs the NAME: every `ns/` key that deduped onto the old inode keeps
    // serving the corrupt bytes this very call reported, and a warm run is all hits and never
    // reaches the comparison again — so the loud line would name a corruption it had left in place
    // for every key but the one being stored.
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      const first = c.put('k1', 'f', object('TRUTH-BYTES'));
      const second = c.put('k2', 'f', object('TRUTH-BYTES'));
      writeFileSync(objectsIn(root)[0], 'CORRUPT');
      expect(readFileSync(first, 'utf8'), 'the hardlink shows the corruption').toBe('CORRUPT');

      c.put('k3', 'f', object('TRUTH-BYTES'));
      expect(m.cacheStats()).toMatchObject({ objectCorrupt: 1 });
      for (const [name, p] of [
        ['k1', first],
        ['k2', second],
      ] as const) {
        expect(readFileSync(p, 'utf8'), `${name} deduped onto that inode and must be repaired with it`).toBe(
          'TRUTH-BYTES',
        );
      }
    });
  });

  test('an honest store says nothing and stores nothing twice', async () => {
    const root = scratch();
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: root }, (m) => {
      const c = m.candCache('t', () => NS_A);
      for (const k of ['k1', 'k2', 'k3']) {
        expect(readFileSync(c.put(k, 'f', object('SAME')), 'utf8')).toBe('SAME');
      }
      expect(objectsIn(root).length).toBe(1);
      expect(m.cacheMismatches()).toBe(0);
      expect(m.cacheStats().mismatch).toBeUndefined();
    });
  });
});

describe('ASMLIFT_CANDCACHE_DIR: set-and-empty is a PATH, and the path it is is the current directory', () => {
  // `??` catches only `undefined`. `ASMLIFT_CANDCACHE_DIR=` — an unexpanded `$SOMETHING`, or a
  // half-typed one-shot override — therefore put `ns/`, `objects/` and `MISMATCHES.log` wherever
  // the process was standing, which docs/ranked-repro.md tells the reader is their decomp
  // checkout. MEASURED: with the store in a CWD holding `objects/aa/build-artifact.o`, one
  // over-cap prune reported `{"prunedObjects":1}` and the file was gone. This is the same
  // unexpanded-variable shape `ASMLIFT_CANDCACHE=` is guarded against, and the flip is what armed
  // it: before it, an empty DIR was inert because the mode was off.
  const captureLoad = async (
    env: Record<string, string | undefined>,
    fn: (m: CandCacheModule) => void,
  ): Promise<string> => {
    let said = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      said += typeof c === 'string' ? c : Buffer.from(c).toString();
      return true;
    });
    try {
      await load(env, (m) => fn(m));
      return said;
    } finally {
      spy.mockRestore();
    }
  };

  test('an empty DIR falls back to the default store and SAYS so — it never writes to the CWD', async () => {
    const cwd = scratch();
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      const said = await captureLoad({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: '' }, (m) => {
        expect(m.MISMATCH_LOG, 'the loud line must name a path a reader can find').toBe(
          join(tmpdir(), 'asmlift-candcache', 'MISMATCHES.log'),
        );
      });
      expect(said).toContain('ASMLIFT_CANDCACHE_DIR is SET AND EMPTY');
      expect(readdirSync(cwd), 'nothing lands in the current directory').toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a RELATIVE DIR is resolved once, so one process cannot mean two stores', async () => {
    const base = scratch();
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(base);
    try {
      await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: 'rel-store' }, (m) => {
        expect(m.MISMATCH_LOG).toBe(join(base, 'rel-store', 'MISMATCHES.log'));
        m.candCache('t', () => NS_A).put('k', 'f', object('OBJ'));
      });
      expect(readdirSync(join(base, 'rel-store')).sort()).toEqual(['ns', 'objects']);
    } finally {
      spy.mockRestore();
    }
  });

  test('an UNSET DIR is still the shared default, unchanged by the guard', async () => {
    await load({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: undefined }, (m) => {
      expect(m.MISMATCH_LOG).toBe(join(tmpdir(), 'asmlift-candcache', 'MISMATCHES.log'));
    });
  });
});
