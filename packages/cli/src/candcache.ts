// asmlift — the CROSS-RUN candidate-object cache.
//
// A candidate compile is a pure function of (translation-unit bytes, symbol) GIVEN a fixed
// toolchain — so the same TU compiled by a later run of the same toolchain can be served from
// disk instead of re-run. Within ONE run there is nothing to reuse (`rank.ts` dedups candidate
// sources by value before any compile); the reuse is ACROSS runs, because admitting an axis
// preserves the flag-off branch verbatim.
//
// Everything hard about this module is the word "GIVEN". A stored object served after the
// toolchain moved is a claim about a compiler that no longer produced it: it compiles, it
// scores, and it is silently wrong. Two devices keep that from happening, and neither is a
// version constant:
//
//   1. The NAMESPACE, supplied by the caller as a `stamp()` thunk — a MEASUREMENT of the whole
//      compile pipeline (binary bytes, flags, every file the command names, the harness code
//      that shapes the compiler's input, and the object bytes the pipeline produces for one
//      fixed probe TU). Anything the stamp does not see is a hole; `stamp()` may answer
//      NOT_CACHEABLE and this module then refuses, loudly, for the whole process.
//   2. `verify` mode — compile anyway, compare stored bytes against fresh, count and report.
//      It is the byte gate at full scale for the price of one uncached run.
//
// OFF unless ASMLIFT_CANDCACHE is set. `ASMLIFT_CANDCACHE=1|on` serves; `=verify` compiles and
// compares; unset / `0` / `off` bypasses the module entirely.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A `stamp()` that returns this is saying: the object this pipeline produces is NOT a pure
 *  function of its input bytes, so NOTHING may be cached for it. `ido7.1` bakes the absolute
 *  path of its input `.c` into the object; the probe measures that rather than listing it. */
export const NOT_CACHEABLE = ' NOT_CACHEABLE ';

export type CandCacheMode = 'off' | 'on' | 'verify';

const RAW = process.env.ASMLIFT_CANDCACHE ?? '';
const MODE: CandCacheMode = RAW === 'verify' ? 'verify' : RAW === '' || RAW === '0' || RAW === 'off' ? 'off' : 'on';

/** The mode this process is running in — `off` unless ASMLIFT_CANDCACHE says otherwise. */
export const cacheMode = (): CandCacheMode => MODE;

const STATS: Record<string, number> = Object.create(null) as Record<string, number>;
const bump = (k: string, n = 1): void => {
  STATS[k] = (STATS[k] ?? 0) + n;
};
/** Counters for the run's `[candcache]` line: hit / failHit / miss / stored / failStored /
 *  verified / mismatch / refused / pruned*. Empty object when nothing happened. */
export const cacheStats = (): Record<string, number> => ({ ...STATS });

const ROOT = process.env.ASMLIFT_CANDCACHE_DIR ?? join(tmpdir(), 'asmlift-candcache');
const OBJECTS = join(ROOT, 'objects');
/** Distinct-byte cap for the whole store. 65,280 LBG candidate objects are 144.9 MB logical but
 *  only 14,484 distinct = 32.1 MB, so the cap is counted over `objects/` (the distinct bytes) —
 *  the hardlinks in `ns/` cost an inode each, not a copy. */
const CAP_BYTES = Number(process.env.ASMLIFT_CANDCACHE_MAX_MB ?? 4096) * 1024 * 1024;

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const say = (msg: string): void => {
  process.stderr.write(`[candcache] ${msg}\n`);
};

// The store:
//
//   objects/<ab>/<sha256 of the object bytes>   content-addressed, immutable, deduped
//   ns/<ns16>/<ab>/<key>.o                      a HARDLINK to the object above
//   ns/<ns16>/<ab>/<key>.fail                   a negative entry (the diagnostic text)
//
// Two levels because the redundancy is 4.51x on LBG and 2.53x on the bench: the same object is
// reached by many keys. Hardlinks make the second level free, and let a prune that deletes one
// key's link leave every other key's answer intact.

function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Put the bytes into `objects/` (deduping) and hardlink them at `dest`. Falls back to a copy
 *  when the link cannot be made (EXDEV / EMLINK) — correctness never depends on the link. */
function linkInto(objBytes: Buffer, dest: string): void {
  const h = sha(objBytes);
  const objDir = join(OBJECTS, h.slice(0, 2));
  const objPath = join(objDir, h);
  mkdirSync(objDir, { recursive: true });
  if (!existsSync(objPath)) {
    writeAtomic(objPath, objBytes);
  }
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  try {
    linkSync(objPath, dest);
  } catch {
    copyFileSync(objPath, dest);
  }
}

/** Delete every `objects/` entry no key links to any more, and return the surviving byte total.
 *  Hardlinks mean deleting an `ns/` link alone frees nothing: `nlink === 1` is the test. */
function reapUnlinked(): number {
  let total = 0;
  for (const ab of readdirSync(OBJECTS, { withFileTypes: true })) {
    if (!ab.isDirectory()) {
      continue;
    }
    for (const f of readdirSync(join(OBJECTS, ab.name))) {
      const p = join(OBJECTS, ab.name, f);
      const st = statSync(p);
      if (st.nlink === 1) {
        rmSync(p, { force: true });
        bump('prunedObjects');
      } else {
        total += st.size;
      }
    }
  }
  return total;
}

// Run ONCE per process, at the first namespace resolution, and NEVER while candidates are in
// flight: a served object is handed out BY PATH and read later by the scorer, so a concurrent
// prune would delete a file out from under a live reader. The unit is a NAMESPACE — one
// namespace is exactly one toolchain configuration, and a namespace nobody touched is dead
// weight in full.
let pruned = false;
function pruneOnce(keepNs: string): void {
  if (pruned) {
    return;
  }
  pruned = true;
  try {
    let distinct = 0;
    for (const ab of readdirSync(OBJECTS, { withFileTypes: true })) {
      if (!ab.isDirectory()) {
        continue;
      }
      for (const f of readdirSync(join(OBJECTS, ab.name))) {
        distinct += statSync(join(OBJECTS, ab.name, f)).size;
      }
    }
    if (distinct <= CAP_BYTES) {
      return;
    }
    const nsRoot = join(ROOT, 'ns');
    const namespaces = readdirSync(nsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== keepNs)
      .map((d) => ({ name: d.name, at: statSync(join(nsRoot, d.name)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const ns of namespaces) {
      if (distinct <= CAP_BYTES * 0.8) {
        break;
      }
      rmSync(join(nsRoot, ns.name), { recursive: true, force: true });
      bump('prunedNamespaces');
      distinct = reapUnlinked();
    }
    if (distinct > CAP_BYTES) {
      say(
        `store holds ${(distinct / 1048576).toFixed(0)} MB of distinct bytes over a ${CAP_BYTES / 1048576} MB cap in the namespace now in use — not pruning it`,
      );
    }
  } catch {
    /* an unreadable store is a cold store, never an error */
  }
}

export interface CandCache {
  /** `off` once this cache has REFUSED — every call site tests it before doing anything. */
  readonly mode: CandCacheMode;
  /** Resolve the namespace NOW. Call it before the first candidate compiles: the stamp probe
   *  runs the real compile pipeline, and resolving it lazily (from inside `verify`, say) makes
   *  it run AFTER a candidate, which with a shared scratch slot overwrites that candidate's
   *  object. That exact ordering poisoned 8 keys and flipped 2 benchmark rows once already. */
  warm(): void;
  /** The stored answer: an object PATH, an Error (a stored deterministic rejection), or
   *  undefined for a miss. */
  get(key: string, symbol: string): string | Error | undefined;
  /** Store `objPath`'s bytes and return the path to serve — the STORE's path, so a warm run and
   *  a cold run hand the caller the same kind of stable read-only path. */
  put(key: string, symbol: string, objPath: string): string;
  /** Store a DETERMINISTIC rejection (the compiler ran and said no). Never a spawn failure or a
   *  timeout: a transient stored as a rejection would drop that candidate on every future run. */
  putFail(key: string, symbol: string, message: string): void;
  /** verify mode only: compare the stored bytes for this key against the freshly compiled ones
   *  and count. A mismatch is reported loudly and the fresh bytes win. */
  verify(key: string, symbol: string, objPath: string): void;
}

const OFF: CandCache = {
  mode: 'off',
  warm() {},
  get: () => undefined,
  put: (_k, _s, o) => o,
  putFail() {},
  verify() {},
};

/**
 * One cache instance for one compile pipeline.
 *
 * `label` names the pipeline in the counters and in a refusal. `stamp` is called AT MOST ONCE
 * and must return a hex digest over every input the object depends on — or NOT_CACHEABLE.
 */
export function candCache(label: string, stamp: () => string): CandCache {
  if (MODE === 'off') {
    return OFF;
  }
  let ns: string | undefined;
  let refused = false;

  const namespace = (): string | undefined => {
    if (ns !== undefined || refused) {
      return ns;
    }
    let s: string;
    try {
      s = stamp();
    } catch (e) {
      refused = true;
      bump('refused');
      say(`REFUSED label=${label} reason=stamp-threw: ${(e as Error).message}`);
      return undefined;
    }
    if (s === NOT_CACHEABLE || !/^[0-9a-f]{16,}$/.test(s)) {
      refused = true;
      bump('refused');
      say(
        s === NOT_CACHEABLE
          ? `REFUSED label=${label} reason=object-is-not-a-pure-function-of-its-input (the stamp probe compiled to different bytes in two directories)`
          : `REFUSED label=${label} reason=stamp-is-not-a-digest: ${JSON.stringify(s).slice(0, 80)}`,
      );
      return undefined;
    }
    ns = s.slice(0, 16);
    mkdirSync(join(ROOT, 'ns', ns), { recursive: true });
    mkdirSync(OBJECTS, { recursive: true });
    utimesSync(join(ROOT, 'ns', ns), new Date(), new Date());
    pruneOnce(ns);
    return ns;
  };

  // The key is over the namespace TOO, so a stored answer can never be read under a different
  // toolchain even if the directory layout were tampered with.
  const pathFor = (n: string, key: string, symbol: string, ext: 'o' | 'fail'): string => {
    const k = sha(`${label} ${n} ${symbol} ${key}`);
    return join(ROOT, 'ns', n, k.slice(0, 2), `${k}.${ext}`);
  };

  return {
    get mode(): CandCacheMode {
      return refused ? 'off' : MODE;
    },
    warm(): void {
      namespace();
    },
    get(key, symbol) {
      const n = namespace();
      if (n === undefined) {
        return undefined;
      }
      const o = pathFor(n, key, symbol, 'o');
      if (existsSync(o) && statSync(o).size > 0) {
        bump('hit');
        return o;
      }
      const f = pathFor(n, key, symbol, 'fail');
      if (existsSync(f)) {
        bump('failHit');
        return new Error(readFileSync(f, 'utf8'));
      }
      bump('miss');
      return undefined;
    },
    put(key, symbol, objPath) {
      const n = namespace();
      if (n === undefined) {
        return objPath;
      }
      const bytes = readFileSync(objPath);
      if (bytes.length === 0) {
        return objPath; // an empty object is not an answer; the caller's own guards speak
      }
      const dest = pathFor(n, key, symbol, 'o');
      linkInto(bytes, dest);
      bump('stored');
      return dest;
    },
    putFail(key, symbol, message) {
      const n = namespace();
      if (n === undefined) {
        return;
      }
      const dest = pathFor(n, key, symbol, 'fail');
      mkdirSync(dirname(dest), { recursive: true });
      writeAtomic(dest, message);
      bump('failStored');
    },
    verify(key, symbol, objPath) {
      if (MODE !== 'verify') {
        return;
      }
      const n = namespace();
      if (n === undefined) {
        return;
      }
      const stored = pathFor(n, key, symbol, 'o');
      if (!existsSync(stored)) {
        return;
      }
      bump('verified');
      const a = readFileSync(stored);
      const b = readFileSync(objPath);
      if (!a.equals(b)) {
        bump('mismatch');
        say(
          `BYTE MISMATCH label=${label} ns=${n} symbol=${symbol} stored=${sha(a).slice(0, 16)}:${a.length} fresh=${sha(b).slice(0, 16)}:${b.length}`,
        );
        linkInto(b, stored); // the fresh bytes are the truth
      }
    },
  };
}
