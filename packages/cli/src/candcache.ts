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
// scores, and it is silently wrong. Three devices keep that from happening, and none of them is
// a version constant:
//
//   1. The NAMESPACE, supplied by the caller as a `stamp()` thunk — a MEASUREMENT of the whole
//      compile pipeline (binary bytes AND WHAT THOSE BINARIES DELEGATE TO, flags, every file the
//      command names, the harness code that shapes the compiler's input, and the object bytes the
//      pipeline produces for one fixed probe TU). Anything the stamp does not see is a hole;
//      `stamp()` may answer NOT_CACHEABLE and this module then refuses, loudly, for the process.
//   2. A per-KEY refusal for a TU whose object is not a function of its own bytes —
//      `candidateCacheRefusal` below: a TU that reads a file, or that bakes its own path or the
//      wall clock into the object.
//   3. `verify` mode — compile anyway, compare stored against fresh IN BOTH DIRECTIONS (a stored
//      object against a fresh rejection is as wrong as differing bytes, and it is the direction
//      that silently drops a candidate), count and report. `on` mode runs that same comparison on
//      a SAMPLED fraction of the keys it serves, every run, because the two gates this project
//      trusts most compare OUTCOMES and a stale object is served identically on the base and on
//      the head: `bench regression` and `bench diff` both go green on a cache defect, so a serving
//      mode that never compiles anything is a mode nothing can audit.
//
// ON BY DEFAULT: unset means `on`. `ASMLIFT_CANDCACHE=1|on|true|yes` serves too; `=verify`
// compiles and compares; `0` / `off` / `false` / `no` — and a SET-BUT-EMPTY value — bypass the
// module entirely; and ANYTHING ELSE is refused out loud rather than quietly treated as "on".
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** A `stamp()` that returns this is saying: the object this pipeline produces is NOT a pure
 *  function of its input bytes, so NOTHING may be cached for it. `ido7.1` bakes the absolute
 *  path of its input `.c` into the object; the probe measures that rather than listing it. */
export const NOT_CACHEABLE = ' NOT_CACHEABLE ';

export type CandCacheMode = 'off' | 'on' | 'verify';

const say = (msg: string): void => {
  process.stderr.write(`[candcache] ${msg}\n`);
};

// ---------------------------------------------------------------------------------------------
// MODE. The parse is deliberately closed: an unrecognised value is OFF and LOUD, never "on".
// The two ways an open parse goes wrong are both silent: `VERIFY` falling through to SERVE loses
// the audit mode to a capitalisation and reports `{"hit":…}` looking clean, and `false`/`no` — the
// two spellings a person reaches for to disable it — enabling it.
const OFF_WORDS = new Set(['', '0', 'off', 'false', 'no', 'n', 'disable', 'disabled']);
const ON_WORDS = new Set(['1', 'on', 'true', 'yes', 'y', 'enable', 'enabled']);
// UNSET and SET-BUT-EMPTY are two different states and mean two different things now.
//
//   UNSET is ON. That is this module's default, and the reason is that the variable was set in no
//   shell profile, no `.envrc` and no CI job on any machine this repo is developed on — so the
//   cache shipped inert for everyone. A default nobody turns on is a default of `off` written the
//   long way.
//
//   SET-BUT-EMPTY is OFF, and it SAYS SO once. `ASMLIFT_CANDCACHE=` arises two ways that point in
//   opposite directions — a deliberate one-shot bypass, and an unexpanded `$SOMETHING` — so either
//   reading is a guess. `off` is the guess whose cost is a cold start rather than a served object,
//   it is what this spelling meant before the flip, and the stderr line makes the surprise loud
//   instead of leaving a reader to infer it from a missing `[candcache]` line.
const RAW_ENV = process.env.ASMLIFT_CANDCACHE;
const UNSET = RAW_ENV === undefined;
const RAW = (RAW_ENV ?? '').trim();
const LOWER = RAW.toLowerCase();
// `ASMLIFT_BENCH_CACHE=0` is documented (apps/benchmark/src/cache.ts) as "bypass the benchmark's
// caches". It has to mean this one too, or a developer bisecting a suspect row bypasses half the
// caching in the harness and still gets candidate objects off disk.
const BENCH_CACHE_OFF = process.env.ASMLIFT_BENCH_CACHE === '0';
const MODE: CandCacheMode = ((): CandCacheMode => {
  if (UNSET) {
    return BENCH_CACHE_OFF ? 'off' : 'on';
  }
  if (LOWER === 'verify') {
    return BENCH_CACHE_OFF ? 'off' : 'verify';
  }
  if (OFF_WORDS.has(LOWER)) {
    return 'off';
  }
  if (ON_WORDS.has(LOWER)) {
    return BENCH_CACHE_OFF ? 'off' : 'on';
  }
  say(
    `REFUSED reason=unrecognised-mode ASMLIFT_CANDCACHE=${JSON.stringify(RAW)} — the cache is OFF. ` +
      `Say 0/off to disable, 1/on to serve, verify to audit.`,
  );
  return 'off';
})();
if (!UNSET && LOWER === '') {
  say(
    `ASMLIFT_CANDCACHE is SET AND EMPTY — the cache is OFF. Unset now means ON, so "set to nothing" ` +
      `is no longer the same state as "not set"; say 1/on to serve, verify to audit.`,
  );
}
// The bypass is only worth a line where it CHANGED the answer. Before the flip that was "the
// variable asks for the cache"; now it is also the silent case — an unset variable that would have
// served, turned off by the other one, with nothing on stderr to say which.
if (BENCH_CACHE_OFF && (UNSET || (LOWER !== '' && !OFF_WORDS.has(LOWER)))) {
  say(
    `OFF because ASMLIFT_BENCH_CACHE=0 bypasses every cache in the harness, ` +
      `ASMLIFT_CANDCACHE=${UNSET ? '<unset, which means on>' : RAW} included`,
  );
}

/** The mode this process is running in — `on` unless ASMLIFT_CANDCACHE (or ASMLIFT_BENCH_CACHE=0)
 *  says otherwise. */
export const cacheMode = (): CandCacheMode => MODE;

const STATS: Record<string, number> = Object.create(null) as Record<string, number>;
const bump = (k: string, n = 1): void => {
  STATS[k] = (STATS[k] ?? 0) + n;
};
/** Keys `get` withheld for an audit that has not come back yet, one set per live instance. Read
 *  at report time as `sampledPending`, which is what makes `sampled` RECONCILE — see below. */
const pendingAudits = new Set<Set<string>>();

/** Counters for the run's `[candcache]` line: hit / failHit / miss / stored / failStored /
 *  sampled / verified / verifiedFail / mismatch / refused / refusedKeys / pruned*. `verified` and
 *  `verifiedFail` count audits that AGREED (a stored object, a stored rejection); a disagreement
 *  in either direction is `mismatch` and nothing else, so the three never have to be read against
 *  each other to learn whether the store was right. Empty object when nothing happened.
 *
 *  `sampled` COUNTS WITHHOLDINGS, NOT AUDITS, and the difference is not cosmetic: a withheld key
 *  whose fresh compile never arrives (a spawn failure, the 120 s timeout, a signal — the caller
 *  then stores nothing, because a transient stored as a rejection would drop that candidate on
 *  every future run) is a sample that was paid for and never compared. Read alone, `sampled: 700`
 *  claims 700 audits that did not happen, and the doc's survival arithmetic rests on that number.
 *  So the withholdings ACCOUNT FOR THEMSELVES, exactly:
 *
 *      sampled = verified + verifiedFail + mismatch + sampledStale + sampledAbandoned + sampledPending
 *
 *  `sampledStale` — the audit ran and the store had nothing left to compare (a sibling shard's
 *  prune); `sampledAbandoned` — the caller came back empty and took the withheld answer instead;
 *  `sampledPending` — still outstanding at the moment this is read. A gap between the two sides is
 *  a bug in this module, and a test asserts the identity rather than trusting it. */
export const cacheStats = (): Record<string, number> => {
  let pending = 0;
  for (const set of pendingAudits) {
    pending += set.size;
  }
  return pending === 0 ? { ...STATS } : { ...STATS, sampledPending: pending };
};
/** How many stored answers a fresh compile disagreed with, in either direction. A run that ends
 *  with this nonzero has served (or would have served) bytes the toolchain no longer produces:
 *  the gate that reads it must FAIL, not print. */
export const cacheMismatches = (): number => STATS.mismatch ?? 0;

// WHERE THE STORE LIVES. `??` catches only `undefined`, and an empty string is a PATH — a relative
// one, meaning the CURRENT DIRECTORY. `ASMLIFT_CANDCACHE_DIR=` therefore used to put `ns/`,
// `objects/` and `MISMATCHES.log` wherever the process happened to be standing, which
// `docs/ranked-repro.md` tells the reader is their decomp checkout; the pruner then walks and
// DELETES from a two-level `objects/<dir>/<file>` layout that is a very ordinary build-output
// shape (measured: a planted 200 KB build artifact removed by one `prunedObjects`). This is the
// same unexpanded-`$SOMETHING` shape `ASMLIFT_CANDCACHE=` is guarded against nine lines above, and
// the flip is what armed it — with the old default an empty DIR was inert because the mode was
// off. A non-empty value is resolved ONCE, here, so a relative store cannot mean two directories
// in one process.
const DEFAULT_ROOT = join(tmpdir(), 'asmlift-candcache');
const RAW_ROOT = process.env.ASMLIFT_CANDCACHE_DIR;
const ROOT = ((): string => {
  if (RAW_ROOT === undefined) {
    return DEFAULT_ROOT;
  }
  if (RAW_ROOT.trim() === '') {
    say(
      `ASMLIFT_CANDCACHE_DIR is SET AND EMPTY — an empty path is the CURRENT DIRECTORY, which is ` +
        `never what that means. Using the default store ${DEFAULT_ROOT}; say a path to move it.`,
    );
    return DEFAULT_ROOT;
  }
  return resolve(RAW_ROOT);
})();
const OBJECTS = join(ROOT, 'objects');
/** Where `verify` mode records a stored-vs-fresh disagreement, so a GATE IN ANOTHER PROCESS can
 *  read it. The stderr line is for a human watching a run; this file is what
 *  `pnpm test:matching`'s teardown fails on, and the counters live only in the process that
 *  compiled (vitest runs its tests in a forked worker, its globalSetup in the parent). */
export const mismatchLogFor = (root: string): string => join(root, 'MISMATCHES.log');
export const MISMATCH_LOG = mismatchLogFor(ROOT);

/** A stored answer disagreed with the truth, in any direction. The loudest thing this module can
 *  say, and the only record that reaches a GATE IN ANOTHER PROCESS: it bumps `mismatch` (the CLI
 *  and every bench shard turn a nonzero one into a failing run), writes the stderr line for
 *  whoever is watching, and appends to `MISMATCH_LOG` for `pnpm test:matching`'s teardown.
 *
 *  Module-level rather than per-instance because `linkInto` is the other caller: a
 *  content-addressed entry whose bytes are not the ones it is named after is exactly this fact,
 *  found on the store's hot path rather than inside an audit. */
function report(line: string): void {
  bump('mismatch');
  say(line);
  try {
    mkdirSync(ROOT, { recursive: true });
    appendFileSync(MISMATCH_LOG, `${line}\n`);
  } catch {
    /* the stderr line is the primary record; an unwritable store must not mask it */
  }
}

// ---------------------------------------------------------------------------------------------
// The CAP. It bounds what the store COSTS, which is not what `objects/` weighs: 77% of a warm
// store's entries are cached REJECTIONS, written straight into `ns/`, and on APFS a 200-byte
// `.fail` costs a whole allocation block. Measured on one full-bench store: `objects/` 7.57 MB
// against `du -sm` 156 MB — a cap counting only the first sees 4.9% of the cost and fires after
// roughly 540 bench runs. So the cost is the distinct object bytes PLUS one block per `ns/` entry.
const BLOCK_BYTES = 4096;
const RAW_CAP = process.env.ASMLIFT_CANDCACHE_MAX_MB;
const CAP_MB = ((): number => {
  if (RAW_CAP === undefined || RAW_CAP.trim() === '') {
    return 4096;
  }
  const n = Number(RAW_CAP);
  if (!Number.isFinite(n) || n < 0) {
    // NaN silently disabled BOTH the prune and its own over-cap warning: the store then grew
    // without bound with no output at all.
    say(`ignoring ASMLIFT_CANDCACHE_MAX_MB=${JSON.stringify(RAW_CAP)} — want a non-negative number of MB; using 4096`);
    return 4096;
  }
  return n;
})();
const CAP_BYTES = CAP_MB * 1024 * 1024;

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------
// SAMPLED VERIFICATION — what licenses serving at all.
//
// `bench regression` and `bench diff` are the two gates this project trusts most, and both compare
// OUTCOMES: a stale object is served identically on the base and on the head, so BOTH GO GREEN on
// a cache defect. Nothing that measures an outcome can catch one. Only compiling anyway and
// comparing can, and that is `verify` mode — which costs the entire speedup.
//
// So `on` mode does it for a FRACTION of the keys it serves, every run, forever. That does not
// eliminate the residual `docs/ranked-repro.md` publishes (a computed path, a `cd` into a computed
// directory, a wrapper that OPENS a config directory, a candidate's assembler `.include`, an
// opaque runtime); it bounds how long one survives. A staleness that touches every key is caught
// in the FIRST run that serves more than a handful; a staleness that touches exactly one key
// survives on average 1/rate runs.
const DEFAULT_SAMPLE_PCT = 1;
const RAW_SAMPLE = process.env.ASMLIFT_CANDCACHE_SAMPLE;
const SAMPLE_PCT = ((): number => {
  if (RAW_SAMPLE === undefined || RAW_SAMPLE.trim() === '') {
    return DEFAULT_SAMPLE_PCT;
  }
  const n = Number(RAW_SAMPLE);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    // Same shape as the cap's malformed-value guard, and for the same reason: a NaN threshold
    // compares false against everything, which would disable the audit with no output at all.
    say(
      `ignoring ASMLIFT_CANDCACHE_SAMPLE=${JSON.stringify(RAW_SAMPLE)} — want a percentage in [0,100]; ` +
        `using ${DEFAULT_SAMPLE_PCT}`,
    );
    return DEFAULT_SAMPLE_PCT;
  }
  return n;
})();
/** A per-RUN seed, and it has to be one. Random per-CALL sampling makes a run unreproducible;
 *  hashing the key alone is reproducible but audits the SAME keys forever, so the rest of the
 *  store is never looked at however many runs go by. The seed is PRINTED on the `[candcache]`
 *  line and `ASMLIFT_CANDCACHE_SAMPLE_SEED` replays a run's exact selection. */
//  SET AND EMPTY is the failure this guard exists for, and `??` does not catch it: an empty seed
//  is a perfectly usable string, so `isSampled` degenerates into a pure function of the key and
//  the SAME fixed 1% of every store is audited in perpetuity — the exact "audits the same keys
//  forever" design the paragraph above rejects, on every machine, with a trailing `seed=` on the
//  line as the only tell. Its two siblings (the cap, the rate) both guard it; this one did not.
const RAW_SEED = process.env.ASMLIFT_CANDCACHE_SAMPLE_SEED;
const SEED_IS_EMPTY = RAW_SEED !== undefined && RAW_SEED.trim() === '';
const SAMPLE_SEED = RAW_SEED === undefined || SEED_IS_EMPTY ? randomBytes(8).toString('hex') : RAW_SEED;
const SAMPLE_THRESHOLD = Math.round((SAMPLE_PCT / 100) * 2 ** 32);
// Only where it CHANGED the answer: with the audit off there is no selection for a seed to pin.
if (SEED_IS_EMPTY && MODE === 'on' && SAMPLE_THRESHOLD > 0) {
  say(
    `ASMLIFT_CANDCACHE_SAMPLE_SEED is SET AND EMPTY — an empty seed pins the audit to one fixed ` +
      `subset of every store forever. Using a fresh random seed ${SAMPLE_SEED}.`,
  );
}
const isSampled = (id: string): boolean =>
  SAMPLE_THRESHOLD > 0 && parseInt(sha(`${SAMPLE_SEED} ${id}`).slice(0, 8), 16) < SAMPLE_THRESHOLD;

/** What the `[candcache]` line says about the audit, so an AUDITED run is distinguishable from an
 *  unaudited one at a glance — including the run that deliberately turned the audit off. Empty
 *  outside `on` mode: `verify` audits every key and `off` serves nothing. */
export const cacheSampleNote = (): string =>
  MODE !== 'on' ? '' : SAMPLE_THRESHOLD > 0 ? ` sample=${SAMPLE_PCT}%/seed=${SAMPLE_SEED}` : ' sample=off';

// ---------------------------------------------------------------------------------------------
// WHAT A KEY MAY NOT COVER — the per-candidate refusal.
//
// The namespace measures the pipeline. It cannot measure an input the CANDIDATE names: a header
// the TU includes, or the TU's own path baked in by `__FILE__`. Those are refused per key, so the
// cache stays on for every other candidate.
//
// The `#include` test runs on RAW TU text, and the preprocessor gets there first: translation
// phase 2 splices backslash-newlines and phase 3 replaces comments, so `#in\<newline>clude`,
// `#/*c*/include`, a form feed before the `#`, and `#import` are all real includes that a
// `/^[ \t]*#[ \t]*include/m` never sees. Six such spellings were demonstrated. Normalise the way
// the preprocessor does, then look.
//
// A comment becomes ONE SPACE, NEWLINES INCLUDED — phase 3's actual rule, and it decides the
// multi-line case in both directions. `#/*<newline>*/include "k.h"` is a REAL include: the comment
// joins the two physical lines into one directive, and `arm-none-eabi-cpp` resolves the header and
// substitutes its macros (`int f(int x){return x*3;}`). A `#include` written inside a comment that
// spans lines is not, and disappears with it. Replacing a comment with blanks-and-newlines instead
// gets the first case backwards, and it is the one a `/^#include/` cannot see either.
const PATH_OR_CLOCK_MACRO = /\b(__FILE__|__BASE_FILE__|__DATE__|__TIME__|__TIMESTAMP__|__INCLUDE_LEVEL__)\b/;

/** The reason this TU may not be cached under a pipeline namespace, or undefined. */
export function candidateCacheRefusal(tu: string): string | undefined {
  // phase 1: the trigraph for `#` (only under -trigraphs, but refuse rather than reason about flags)
  let t = tu.replaceAll('??=', '#');
  // phase 2: splice line continuations
  t = t.replace(/\\[ \t]*\r?\n/g, '');
  // phase 3: each comment becomes one space, so a comment spanning a newline joins the lines
  t = t.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/(^|[\r\n])[ \t\f\v]*#[ \t\f\v]*(include|include_next|import)\b/.test(t)) {
    return 'the-TU-reads-a-file';
  }
  // A TU using __FILE__/__DATE__ is not a pure function of its own bytes: the object carries the
  // scratch path or the wall clock. MEASURED: three uncached compiles of one such TU produced
  // three different 836-byte objects through the very namespace the bench uses, and the stamp
  // probe — one fixed TU that uses neither — certified the pipeline pure.
  if (PATH_OR_CLOCK_MACRO.test(t)) {
    return 'the-TU-bakes-its-path-or-the-clock-into-the-object';
  }
  return undefined;
}

const saidKeyRefusals = new Set<string>();
/** Say a per-key refusal ONCE per reason and COUNT every one. The reason is a fact about the
 *  emitter, not about this candidate, so 65,280 lines would say nothing the first says; but a
 *  refusal nobody counts is Hole 2's whole protection reporting nothing — a run where an emitter
 *  change arms `#include` prints one line in one shard's log and no number anywhere. */
export function noteKeyRefused(label: string, reason: string): void {
  bump('refusedKeys');
  const seen = `${label} ${reason}`;
  if (saidKeyRefusals.has(seen)) {
    return;
  }
  saidKeyRefusals.add(seen);
  say(`REFUSED-KEY label=${label} reason=${reason}`);
}

/** The compile ENVIRONMENT gcc/cpp read whether or not a command line names it. `CPATH` and
 *  `C_INCLUDE_PATH` are honoured even under `-nostdinc` (MEASURED: `CPATH=inc arm-none-eabi-cpp
 *  -nostdinc` resolves `#include "g0.h"` and its value reaches the object), so every one of these
 *  is an input to every candidate compile. ONE list: both pipelines compile with the same
 *  compilers, and two copies of the answer is how the tenth variable gets added to one of them. */
export const COMPILE_ENV = [
  'CPATH',
  'C_INCLUDE_PATH',
  'CPLUS_INCLUDE_PATH',
  'GCC_EXEC_PREFIX',
  'COMPILER_PATH',
  'LIBRARY_PATH',
  'SOURCE_DATE_EPOCH',
  'DEPENDENCIES_OUTPUT',
  'SUNPRO_DEPENDENCIES',
];

/** The fixed TU every pipeline's stamp probe compiles — twice, in two different directories, so
 *  the compiler itself answers whether its object is a pure function of its input. */
export const STAMP_PROBE = 'int asmlift_candcache_stamp(int x) { return x * 3 + 1; }\n';

// ---------------------------------------------------------------------------------------------
// WHAT A NAMESPACE MUST FOLLOW — the delegate chain.
//
// Hashing "the file a command name resolves to" stops one level short. On the machine this was
// found on, `cpp` resolves to a 208-byte `#!/bin/sh` shim that `exec`s Homebrew's `cpp-14`; the
// namespace hashed the shim, and repointing the Cellar symlink served a stale object while the
// shim stayed byte-identical. `arm-none-eabi-cpp` is the same shape one level down: a driver
// binary that execs `libexec/gcc/arm-none-eabi/14.2.1/cc1`.
//
// So an executable is expanded into the CHAIN of files that actually run, and where the chain
// cannot be followed the cache REFUSES rather than hashing a stand-in:
//   • a script is hashed AND followed — its interpreter, and every token naming a file or
//     resolving on $PATH;
//   • a script that names its delegate through a VARIABLE (`exec "$MYCPP" "$@"` — the ccache /
//     distcc / toolchain-wrapper shape, and the commonest one there is) has that variable's VALUE
//     measured into the chain and followed if it names a file. A syntax list would have to call
//     `"$MYCPP"` un-followable while calling `$(cat x)` un-followable for the same reason; the
//     value is the answer to the actual question, and it is one holding two different compilers
//     apart under a byte-identical wrapper;
//   • a script that COMPUTES its delegate (`$(...)`, backticks, `eval`) is a refusal — there is no
//     value to read without running it;
//   • a gcc-style driver is asked where its sub-program is (`-print-prog-name=cc1`);
//   • too deep, or too wide, is a refusal.
const SCRIPT_COMPUTES_ITS_DELEGATE = /\$\(|`|(^|[\s;&|])eval[\s]/;
/** `$NAME` / `${NAME}`. Positional and special parameters (`$@`, `$1`, `$?`) do not match: they
 *  carry the caller's arguments, never the program's identity. */
const SHELL_VAR = /\$\{?([A-Za-z_]\w*)\}?/g;
/** An entry of a chain that is a MEASUREMENT rather than a file to read: `UNRESOLVED:<cmd>` (the
 *  command is on no `$PATH` here) and `ENV:<name>=<value>` (a script chooses its delegate through
 *  that variable). Callers hash the string itself. */
export const isChainMeasurement = (entry: string): boolean =>
  entry.startsWith('UNRESOLVED:') || entry.startsWith('ENV:');
const GCC_DRIVER = /(^|[-/])(cpp|gcc|cc|g\+\+)(-[\d.]+)?$/;
const CHAIN_MAX_DEPTH = 8;
const CHAIN_MAX_FILES = 64;

const looksBinary = (p: string): boolean => {
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
};

const resolveOnPath = (cmd: string): string | undefined => {
  const r = spawnSync('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], { encoding: 'utf8' });
  const p = (r.stdout ?? '').trim();
  return p !== '' && isAbsolute(p) && existsSync(p) ? p : undefined;
};

/**
 * Ask a gcc-style driver where its COMPILER PROPER lives. `arm-none-eabi-cpp` is a driver binary
 * that execs `libexec/gcc/arm-none-eabi/14.2.1/cc1`; hashing the driver alone stops one level
 * short of the program that reads the TU.
 *
 * `cc1` and only `cc1`, deliberately. A driver also knows an `as` and an `ld`, but it execs them
 * only in modes this seam's templates do not use — both agbcc templates preprocess with the driver
 * and name their assembler themselves — and asking for them OVER-reaches into programs that never
 * run: on this machine `cpp-14 -print-prog-name=as` answers Apple's `/Library/Developer/…/as`, a
 * zsh script that computes its delegate through `$(realpath)`, which would refuse a whole
 * namespace over an assembler no candidate compile invokes. THE RESIDUAL, said out loud: a
 * template that assembles THROUGH the driver (`gcc -c x.c -o x.o`) reaches an assembler this
 * chain does not name — unless a `-B` operand names a DIRECTORY, which the compile template's
 * token scan then hashes by content. `-B /opt/tc/arm-` used as a filename PREFIX names nothing
 * that exists, so it contributes nothing and the residual stands; that is the same sentence
 * `docs/ranked-repro.md` publishes, and the two must not drift apart.
 *
 * Only absolute, existing answers count; only names that look like a driver are asked at all
 * (agbcc IS a cc1 and takes no such flag), stdin is closed and the probe is bounded.
 */
const driverSubprograms = (p: string): string[] => {
  if (!GCC_DRIVER.test(basename(p))) {
    return [];
  }
  const r = spawnSync(p, ['-print-prog-name=cc1'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 20_000,
  });
  const ans = (r.stdout ?? '').trim();
  return isAbsolute(ans) && existsSync(ans) ? [ans] : [];
};

function expandExecutable(p: string, out: Set<string>, depth: number): void {
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    throw new Error(`namespace input cannot be resolved: ${p}`);
  }
  if (out.has(real)) {
    return;
  }
  if (depth > CHAIN_MAX_DEPTH) {
    throw new Error(`namespace delegate chain deeper than ${CHAIN_MAX_DEPTH} at ${real}`);
  }
  out.add(real);
  if (out.size > CHAIN_MAX_FILES) {
    throw new Error(`namespace delegate chain wider than ${CHAIN_MAX_FILES} files at ${real}`);
  }
  if (looksBinary(real)) {
    for (const sub of driverSubprograms(real)) {
      expandExecutable(sub, out, depth + 1);
    }
    return;
  }
  // A text executable is a script: what it EXECS is the compiler, and the script's own bytes are
  // not that compiler.
  const text = readFileSync(real, 'utf8');
  if (SCRIPT_COMPUTES_ITS_DELEGATE.test(text)) {
    throw new Error(
      `${real} computes the program it runs (a command substitution or eval), so its delegate ` +
        `cannot be hashed — the cache refuses rather than hash a stand-in`,
    );
  }
  // A variable the script does not itself assign is an EXTERNAL input choosing what runs. Its
  // value joins the chain as a measurement, and if it names a file that file is followed —
  // `exec "$MYCPP" "$@"` under a byte-constant wrapper otherwise reads as one namespace for two
  // different compilers.
  const assigned = new Set<string>();
  for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=/gm)) {
    assigned.add(m[1]);
  }
  for (const m of text.matchAll(SHELL_VAR)) {
    const name = m[1];
    if (assigned.has(name)) {
      continue;
    }
    const val = process.env[name] ?? '';
    out.add(`ENV:${name}=${val}`);
    if (out.size > CHAIN_MAX_FILES) {
      throw new Error(`namespace delegate chain wider than ${CHAIN_MAX_FILES} entries at ${real}`);
    }
    if (val && isAbsolute(val) && existsSync(val) && statSync(val).isFile()) {
      expandExecutable(val, out, depth + 1);
    }
  }
  const first = text.split('\n', 1)[0] ?? '';
  const tokens = text.split(/[\s"'<>|;&()=]+/);
  if (first.startsWith('#!')) {
    tokens.unshift(first.slice(2).trim().split(/\s+/)[0] ?? '');
  }
  for (const tok of tokens) {
    if (!tok || tok.length > 300) {
      continue;
    }
    if (isAbsolute(tok)) {
      if (existsSync(tok) && statSync(tok).isFile()) {
        expandExecutable(tok, out, depth + 1);
      }
      continue;
    }
    if (/^[A-Za-z][\w.+-]*$/.test(tok)) {
      const r = resolveOnPath(tok);
      if (r) {
        expandExecutable(r, out, depth + 1);
      }
    }
  }
}

/**
 * Every FILE that actually runs when `cmd` is invoked — the resolved program, whatever it
 * delegates to, and so on. `cmd` may be a path or a bare name resolved on `$PATH`.
 *
 * Entries satisfying `isChainMeasurement` are not paths: `UNRESOLVED:<cmd>` when the command is on
 * no `$PATH` here, `ENV:<name>=<value>` for a variable a script in the chain reads. Both ARE the
 * measurement, and a caller hashes the string. THROWS when the chain cannot be followed — a throw
 * reaches `candCache` as a loud refusal, which is the only sound answer: a namespace that guesses
 * at a delegate it cannot read is a namespace that serves stale objects.
 */
export function toolchainFileChain(cmd: string): string[] {
  const out = new Set<string>();
  let start: string | undefined;
  if (cmd.includes('/')) {
    // A PATH the caller named explicitly and that is not there is a broken configuration, not a
    // measurement: refuse loudly rather than hash a marker for the compiler nobody can read.
    if (!existsSync(cmd)) {
      throw new Error(`namespace input does not exist: ${cmd}`);
    }
    start = resolve(cmd);
  } else {
    // A bare NAME that resolves nowhere on this $PATH IS the measurement: the command is absent,
    // and it will be absent identically for every candidate this namespace serves.
    start = resolveOnPath(cmd);
    if (start === undefined) {
      return [`UNRESOLVED:${cmd}`];
    }
  }
  expandExecutable(start, out, 0);
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// The store:
//
//   objects/<ab>/<sha256 of the object bytes>   content-addressed, immutable, deduped
//   ns/<ns16>/<ab>/<key>.o                      a HARDLINK to the object above
//   ns/<ns16>/<ab>/<key>.fail                   a negative entry (the diagnostic text)
//   ns/<ns16>/.live/<pid>-<rand>                a LEASE: this namespace has a live reader
//
// Two levels because the redundancy is 4.51x on LBG and 2.53x on the bench: the same object is
// reached by many keys. Hardlinks make the second level free, and let a prune that deletes one
// key's link leave every other key's answer intact.

function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.tmp${process.pid}.${(seq += 1)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
let seq = 0;

/** Put the bytes into `objects/` (deduping) and hardlink them at `dest`. Falls back to a copy
 *  when the link cannot be made (EXDEV / EMLINK) — correctness never depends on the link. Note
 *  that `objects/` and `ns/` are both under ROOT, so EXDEV is unreachable and the copy path is
 *  near-dead code; on a filesystem with no hardlinks at all correctness survives (the `ns/` copy
 *  serves) but `reapUnlinked`'s `nlink === 1` test then deletes every `objects/` entry at the next
 *  prune, so dedup silently vanishes and the cap under-counts. Nothing on this machine is such a
 *  filesystem; if that changes, the cap is what to re-measure first.
 *
 *  The replacement is ATOMIC — link to a temp name, rename over `dest`. The obvious spelling
 *  (`rmSync(dest)` then `linkSync`) DELETES THE ANSWER before replacing it, and a sibling process
 *  reading that path in the window gets ENOENT on a key that is permanently in the store: 13
 *  throws and 34 failed reads in 15,000 concurrent lookups, measured.
 *
 *  EXISTENCE IS NOT CONTENT, and treating it as content was a silent wrong answer with no audit
 *  over it at all. `objects/<sha>` can hold bytes that are not the ones it is named after — a disk
 *  error, an external edit, a write THROUGH one of its hardlinks, or a store living in a directory
 *  the project's own build writes to — and then EVERY key that dedups onto it serves those bytes.
 *  The sampled audit cannot see that: sampling is reached from `get`, so it only ever looks at a
 *  key the store can already answer, and a `put` is a MISS by construction. MEASURED end to end: a
 *  run in which every key missed, every candidate compiled freshly and correctly, and the audit was
 *  at 100% published a NONMATCH as a byte-exact MATCH with exit 0 and wrote no `MISMATCHES.log`.
 *
 *  So a `put` compares. It costs one read of a file the dedup path was about to hardlink anyway,
 *  and only on a key that is being STORED — a key served off the store never reaches here at all.
 *  MEASURED at the cold LBG fan's own shape (53,228 dedup-hit puts against 15,124 distinct
 *  objects): stat 267 ms, read-and-compare 1,729 ms, so +1.5 s on a 683-905 s run. A disagreement
 *  is a `mismatch` like any other: the truth is in hand, so the entry is repaired with it and the
 *  run FAILS rather than publishing off a store that lied once.
 *
 *  `distrustExisting` skips the comparison and rewrites outright: `verify`'s repair has already
 *  reported its own disagreement and does not need this one to report it again. */
function linkInto(objBytes: Buffer, dest: string, distrustExisting = false): void {
  const h = sha(objBytes);
  const objDir = join(OBJECTS, h.slice(0, 2));
  const objPath = join(objDir, h);
  mkdirSync(objDir, { recursive: true });
  if (distrustExisting) {
    writeAtomic(objPath, objBytes);
  } else {
    let held: Buffer | undefined;
    try {
      held = readFileSync(objPath);
    } catch {
      held = undefined; // absent, or reaped between here and now — either way, write it
    }
    if (held === undefined) {
      writeAtomic(objPath, objBytes);
    } else if (!held.equals(objBytes)) {
      report(
        `OBJECT STORE CORRUPT object=${h.slice(0, 16)} held=${sha(held).slice(0, 16)}:${held.length} ` +
          `truth=${h.slice(0, 16)}:${objBytes.length} — an entry is not the bytes it is named after, ` +
          `so every key that dedups onto it has been served those bytes`,
      );
      writeAtomic(objPath, objBytes);
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.link${process.pid}.${(seq += 1)}`;
  try {
    try {
      linkSync(objPath, tmp);
    } catch {
      copyFileSync(objPath, tmp);
    }
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// LIVENESS. A prune runs in ONE process and deletes files EVERY process can be reading: `put`
// hands the caller a path in `ns/` that the scorer opens later, and `pnpm bench run` forks 8–16
// shards over one store (the default ROOT is one directory shared by every asmlift process on the
// box). A wall-clock grace window alone is not liveness — a run longer than the window, and the
// `/match-function` ladder is hours, is unprotected. So a process CLAIMS the namespace it is
// about to use with a lease file, and a pruner treats a namespace with a live lease as untouchable.
const LEASE = `${process.pid}-${randomBytes(4).toString('hex')}`;
const PRUNE_GRACE_MS = 60 * 60 * 1000;
/** How long an `objects/` entry is presumed to be mid-`put` in another process. `linkInto` writes
 *  the content-addressed file and links it a moment later, and in that window the object has
 *  `nlink === 1` and looks like garbage to a reaper in a sibling shard. Microseconds of exposure,
 *  five minutes of margin — short enough that a store filled and evicted in the same round still
 *  reclaims its bytes, which an hour-long window would not. */
const REAP_GRACE_MS = 5 * 60 * 1000;
const leases: string[] = [];

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Claim this namespace for the life of the process, and sweep the leases of processes that are
 *  gone. There is deliberately NO exit handler: a lease outliving its process is not a leak, it is
 *  a file whose pid no longer answers, and `namespaceIsLive` reads it that way — which is the same
 *  test that has to work after a `kill -9`, when no handler would have run anyway. */
function claimNamespace(nsDir: string): void {
  const live = join(nsDir, '.live');
  mkdirSync(live, { recursive: true });
  namespaceIsLive(nsDir); // sweeps dead leases; the answer is not the point here
  const p = join(live, LEASE);
  writeFileSync(p, `${process.pid}\n`);
  leases.push(p);
}

const heldByUs = (name: string): boolean => leases.some((l) => basename(l) === name);

/** Is any process still holding this namespace? A lease whose pid is gone is swept — and so is a
 *  lease carrying OUR OWN pid that this module is not actually holding, which is either a recycled
 *  pid or a previous module registry in the same process (what `vi.resetModules()` produces). Our
 *  own live leases cover every `candCache` instance in this process, because the module is a
 *  singleton and they share the list. */
function namespaceIsLive(nsDir: string, ignoreOwn = false): boolean {
  const live = join(nsDir, '.live');
  let names: string[];
  try {
    names = readdirSync(live);
  } catch {
    return false;
  }
  let anyLive = false;
  for (const n of names) {
    const mine = heldByUs(n);
    if (mine) {
      if (!ignoreOwn) {
        anyLive = true;
      }
      continue;
    }
    if (Number(n.split('-')[0]) !== process.pid && pidAlive(Number(n.split('-')[0]))) {
      anyLive = true;
      continue;
    }
    try {
      rmSync(join(live, n), { force: true });
    } catch {
      /* someone else swept it first */
    }
  }
  return anyLive;
}

/** Delete every `objects/` entry no key links to any more, and return the surviving byte total.
 *  Hardlinks mean deleting an `ns/` link alone frees nothing: `nlink === 1` is the test — but a
 *  `put` in ANOTHER process writes `objects/<sha>` and links it a moment later, so an object
 *  younger than the grace window is left alone rather than reaped out of that window. */
function reapUnlinked(): number {
  const cutoff = Date.now() - REAP_GRACE_MS;
  let total = 0;
  for (const ab of readdirSync(OBJECTS, { withFileTypes: true })) {
    if (!ab.isDirectory()) {
      continue;
    }
    for (const f of readdirSync(join(OBJECTS, ab.name))) {
      const p = join(OBJECTS, ab.name, f);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st === undefined) {
        continue;
      }
      if (st.nlink === 1 && st.mtimeMs < cutoff) {
        rmSync(p, { force: true });
        bump('prunedObjects');
      } else {
        total += st.size;
      }
    }
  }
  return total;
}

/** What the store costs on disk: the distinct object bytes plus one allocation block per `ns/`
 *  entry. The `.fail` half is 77% of all entries and weighs nothing logically — it is inodes and
 *  blocks, and that is what runs a disk out. */
function storeCost(): { bytes: number; entries: number } {
  let bytes = 0;
  let entries = 0;
  try {
    for (const ab of readdirSync(OBJECTS, { withFileTypes: true })) {
      if (!ab.isDirectory()) {
        continue;
      }
      for (const f of readdirSync(join(OBJECTS, ab.name))) {
        bytes += statSync(join(OBJECTS, ab.name, f), { throwIfNoEntry: false })?.size ?? 0;
      }
    }
  } catch {
    /* no objects yet */
  }
  try {
    for (const ns of readdirSync(join(ROOT, 'ns'), { withFileTypes: true })) {
      if (!ns.isDirectory()) {
        continue;
      }
      for (const ab of readdirSync(join(ROOT, 'ns', ns.name), { withFileTypes: true })) {
        if (!ab.isDirectory() || ab.name.startsWith('.')) {
          continue;
        }
        entries += readdirSync(join(ROOT, 'ns', ns.name, ab.name)).length;
      }
    }
  } catch {
    /* no namespaces yet */
  }
  return { bytes: bytes + entries * BLOCK_BYTES, entries };
}

/** Every key file in a namespace, oldest first. */
function keysOf(nsDir: string): { path: string; at: number }[] {
  const out: { path: string; at: number }[] = [];
  for (const ab of readdirSync(nsDir, { withFileTypes: true })) {
    if (!ab.isDirectory() || ab.name.startsWith('.')) {
      continue;
    }
    for (const f of readdirSync(join(nsDir, ab.name))) {
      const p = join(nsDir, ab.name, f);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st) {
        out.push({ path: p, at: st.mtimeMs });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Run ONCE per process, at the first namespace resolution and BEFORE this process claims its
// lease, and NEVER while candidates are in flight. The unit is a NAMESPACE — one namespace is
// exactly one toolchain configuration, and a namespace nobody holds is dead weight in full. When
// the only namespace left is the one this process is about to use, the cap falls back to evicting
// that namespace's OLDEST-WRITTEN KEYS, which is the only way it can ever fire on a
// single-toolchain machine: the steady state of this repo is ONE agbcc namespace used by every
// run, growing by ~640 keys a run forever.
//
// LEASES are the liveness test there, and the ONLY one. A wall-clock "the namespace has not been
// resolved for an hour" test cannot work on the namespace this process is about to use, because
// resolving it is what just touched it — asked that way the branch is dead by construction (it
// evicted 0 of 300 keys against a 0.5 MB cap while printing that everything left was younger than
// the window), and a cap that provably cannot fire is the silent half of a loud-failure rule. What
// makes eviction safe is not age: it is that no OTHER process holds this namespace, that `get` is
// miss-on-race, and that `reapUnlinked` leaves objects younger than its own grace window alone.
let pruned = false;
function pruneOnce(keepNs: string): void {
  if (pruned) {
    return;
  }
  pruned = true;
  try {
    let cost = storeCost().bytes;
    if (cost <= CAP_BYTES) {
      return;
    }
    const nsRoot = join(ROOT, 'ns');
    const cutoff = Date.now() - PRUNE_GRACE_MS;
    let heldBack = 0;
    let tooYoung = 0;
    const namespaces = readdirSync(nsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== keepNs)
      .map((d) => ({ name: d.name, at: statSync(join(nsRoot, d.name)).mtimeMs }))
      .filter((d) => {
        // A namespace resolved within the window may belong to a shard that has not claimed its
        // lease yet — the only gap the lease cannot cover.
        if (d.at >= cutoff) {
          tooYoung += 1;
          return false;
        }
        if (namespaceIsLive(join(nsRoot, d.name))) {
          heldBack += 1;
          return false;
        }
        return true;
      })
      .sort((a, b) => a.at - b.at);
    for (const ns of namespaces) {
      if (cost <= CAP_BYTES * 0.8) {
        break;
      }
      // Re-asked immediately before the delete, not only in the filter above: the filter runs over
      // every namespace at once and each delete below re-walks the whole store, so a namespace
      // claimed in between would otherwise be removed under a live reader.
      if (namespaceIsLive(join(nsRoot, ns.name))) {
        heldBack += 1;
        continue;
      }
      rmSync(join(nsRoot, ns.name), { recursive: true, force: true });
      bump('prunedNamespaces');
      cost = reapUnlinked() + storeCost().entries * BLOCK_BYTES;
    }
    const keepDir = join(nsRoot, keepNs);
    let keepHeld = false;
    if (cost > CAP_BYTES * 0.8 && existsSync(keepDir)) {
      if (namespaceIsLive(keepDir, true)) {
        keepHeld = true;
      } else {
        const keys = keysOf(keepDir);
        let i = 0;
        while (cost > CAP_BYTES * 0.8 && i < keys.length) {
          rmSync(keys[i].path, { force: true });
          bump('prunedKeys');
          i += 1;
          if (i % 512 === 0) {
            cost = reapUnlinked() + storeCost().entries * BLOCK_BYTES;
          }
        }
        cost = reapUnlinked() + storeCost().entries * BLOCK_BYTES;
      }
    }
    if (cost > CAP_BYTES) {
      // Say which reason actually applied. A message that asserts a reason it did not measure is
      // a report nobody can act on.
      const why = [
        keepHeld ? 'another process holds the namespace this run is using' : '',
        heldBack > 0 ? `${heldBack} other namespace(s) held by a live process` : '',
        tooYoung > 0
          ? `${tooYoung} other namespace(s) resolved within the ${PRUNE_GRACE_MS / 60000}-minute grace window`
          : '',
      ].filter(Boolean);
      say(
        `store costs ${(cost / 1048576).toFixed(0)} MB over a ${CAP_MB} MB cap and it could not be pruned below it` +
          `${why.length > 0 ? ' — ' + why.join(', ') : ''}. Drop it by hand with: rm -rf ${ROOT}`,
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
   *  undefined for a miss. A store racing with another process is a MISS, never a throw. */
  get(key: string, symbol: string): string | Error | undefined;
  /** Store `objPath`'s bytes and return the path to serve — the STORE's path, so a warm run and
   *  a cold run hand the caller the same kind of stable read-only path. */
  put(key: string, symbol: string, objPath: string): string;
  /** Store a DETERMINISTIC rejection (the compiler ran and said no). Never a spawn failure, a
   *  timeout or a signal: a transient stored as a rejection drops that candidate on every future
   *  run. */
  putFail(key: string, symbol: string, message: string): void;
  /** The caller got NEITHER an object nor a storable rejection for this key — a spawn failure, a
   *  timeout, a signal — so there is no fresh answer to audit against. Give back whatever was
   *  WITHHELD for the audit (an object path, a stored rejection, or undefined for a key that was
   *  never withheld), and count the abandonment.
   *
   *  This exists because sampling must never be worse than not sampling. A warm run had ZERO
   *  exposure to a transient compile failure — it never compiled — and withholding 1% of keys
   *  hands that 1% straight back to the hazard, deleting a spelling from the fan under a RANDOM
   *  per-run seed. Falling back to the stored answer is exactly what an unaudited run would have
   *  been served, and it is counted so the audit's own shortfall is visible. */
  abandonAudit(key: string, symbol: string): string | Error | undefined;
  /** verify mode only, fresh compile SUCCEEDED: compare the stored answer against it. Differing
   *  bytes are a mismatch; so is a stored REJECTION, which would have dropped this candidate. */
  verify(key: string, symbol: string, objPath: string): void;
  /** verify mode only, fresh compile was a DETERMINISTIC REJECTION: a stored OBJECT for this key
   *  is a mismatch — it would have been scored as a candidate that no longer compiles. This is
   *  the half of the store that is 77% of what a warm run is served. */
  verifyFail(key: string, symbol: string, message: string): void;
}

/** The inert cache: every call site tests `mode` first, so this is what a REFUSAL and an opt-out
 *  both collapse to. Exported because a second hand-written copy of it is a second place for the
 *  interface to drift. */
export const OFF: CandCache = {
  mode: 'off',
  warm() {},
  get: () => undefined,
  put: (_k, _s, o) => o,
  putFail() {},
  abandonAudit: () => undefined,
  verify() {},
  verifyFail() {},
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
          ? `REFUSED label=${label} reason=object-is-not-a-pure-function-of-its-input (the stamp probe failed, or compiled to different bytes in two directories)`
          : `REFUSED label=${label} reason=stamp-is-not-a-digest: ${JSON.stringify(s).slice(0, 80)}`,
      );
      return undefined;
    }
    const resolved = s.slice(0, 16);
    if (process.env.ASMLIFT_CANDCACHE_TRACE) {
      say(`ns label=${label} ns=${resolved}`);
    }
    // A STORE THIS PROCESS CANNOT PREPARE IS A COLD STORE, never a compile failure. `putFail` and
    // `pruneOnce` both already say that in so many words; this function did not, and the throw
    // escaped `get`/`put`/`warm` into the candidate compile, where `compile-command.ts` and
    // `compile/agbcc.ts` read any exception as "this spelling does not compile" and DELETE IT FROM
    // THE FAN. MEASURED on a read-only store: `1 dropped` and the published winner moved from
    // `unsigned` to `signed`, on the one line `docs/ranked-repro.md` tells readers to quote, while
    // the `[candcache]` line still read a clean `{"hit":1}`. The flip is what makes it reachable
    // for everyone: unset now means the default ROOT under `$TMPDIR`, which on a shared `/tmp` or
    // a CI runner belongs to whoever ran first — and ENOSPC, a read-only mount and a store copied
    // with `cp -a` all land here.
    try {
      const nsDir = join(ROOT, 'ns', resolved);
      mkdirSync(nsDir, { recursive: true });
      mkdirSync(OBJECTS, { recursive: true });
      utimesSync(nsDir, new Date(), new Date());
      pruneOnce(resolved);
      claimNamespace(nsDir);
    } catch (e) {
      refused = true;
      bump('refused');
      say(`REFUSED label=${label} reason=store-unusable: ${(e as Error).message}`);
      return undefined;
    }
    ns = resolved;
    return ns;
  };

  // The key is over the namespace TOO, so a stored answer can never be read under a different
  // toolchain even if the directory layout were tampered with.
  const keyId = (n: string, key: string, symbol: string): string => sha(`${label} ${n} ${symbol} ${key}`);
  const pathFor = (n: string, key: string, symbol: string, ext: 'o' | 'fail'): string => {
    const k = keyId(n, key, symbol);
    return join(ROOT, 'ns', n, k.slice(0, 2), `${k}.${ext}`);
  };

  /** Keys this instance WITHHELD from a serve so the caller would compile them (`auditing`), and
   *  keys whose audit is FINISHED — done, abandoned or stale (`audited`, so a later lookup of the
   *  same key is served normally rather than withheld again). Both hold only sampled keys, so both
   *  stay small. `auditing` is registered module-wide so `cacheStats()` can report what is still
   *  outstanding; without that, an abandoned withholding is invisible on the `[candcache]` line. */
  const auditing = new Set<string>();
  const audited = new Set<string>();
  pendingAudits.add(auditing);

  /** What the store would SERVE for this key: an object first — and only a non-empty regular file
   *  counts — a stored rejection second, otherwise nothing. `get` and both halves of `verify` ask
   *  through this one reader, so verify mode audits the answer a serve would actually get rather
   *  than the store's raw contents; asked separately, the precedence between an `.o` and a `.fail`
   *  for one key is outside the audit's reach by construction. */
  const lookup = (n: string, key: string, symbol: string): { obj: string } | { fail: string } | undefined => {
    try {
      const o = pathFor(n, key, symbol, 'o');
      const st = statSync(o, { throwIfNoEntry: false });
      if (st !== undefined && st.isFile() && st.size > 0) {
        return { obj: o };
      }
    } catch {
      /* a store being rewritten under us is a MISS: recompiling is always correct */
    }
    try {
      return { fail: readFileSync(pathFor(n, key, symbol, 'fail'), 'utf8') };
    } catch {
      /* no negative entry, or it vanished — either way, a miss */
    }
    return undefined;
  };

  /** An audit's REPAIR is best-effort; its REPORT is not, and the two must not share a fate. A
   *  store that has gone unwritable or is being pruned under us would otherwise turn a
   *  disagreement into a thrown exception, and BOTH call sites read an exception out of a
   *  candidate compile as "this spelling does not compile" and delete it from the fan — the same
   *  loud-failure-traded-for-a-silent-wrong-answer shape `namespace()` was fixed for. The
   *  `mismatch` counter and `MISMATCHES.log` have already been written by the time this runs. */
  const repair = (what: () => void): void => {
    try {
      what();
    } catch (e) {
      say(`could not repair a mismatched entry (the mismatch is still reported): ${(e as Error).message}`);
    }
  };

  /** The stored-vs-fresh comparison for a SUCCESSFUL compile, without the mode test — `verify`
   *  mode runs it for every key, `on` mode runs it from `put` for a sampled one. ONE comparison,
   *  not two: a second copy is a second place for the two directions to drift, and the outcome
   *  direction below is the one nothing was checking until #132.
   *
   *  Returns whether there was a stored answer to audit at all. There is not when the store was
   *  rewritten under us between the lookup and this call, and the caller then stores normally —
   *  a fresh compile is always the right answer, whatever the store did or did not hold. */
  const auditObject = (n: string, key: string, symbol: string, objPath: string): boolean => {
    let fresh: Buffer;
    try {
      fresh = readFileSync(objPath);
    } catch {
      return false;
    }
    const found = lookup(n, key, symbol);
    if (found === undefined) {
      return false;
    }
    const stored = pathFor(n, key, symbol, 'o');
    if ('fail' in found) {
      // The direction nothing was auditing: the store says this candidate does not compile and
      // it does. Served under `on`, that spelling is silently dropped from the row's fan.
      report(
        `OUTCOME MISMATCH label=${label} ns=${n} symbol=${symbol} stored=rejection fresh=object:${sha(fresh).slice(0, 16)}:${fresh.length}`,
      );
      repair(() => {
        rmSync(pathFor(n, key, symbol, 'fail'), { force: true });
        linkInto(fresh, stored, true);
      });
      return true;
    }
    let a: Buffer;
    try {
      a = readFileSync(found.obj);
    } catch {
      return false; // the entry vanished between the lookup and the read: a fresh compile is the answer
    }
    if (!a.equals(fresh)) {
      report(
        `BYTE MISMATCH label=${label} ns=${n} symbol=${symbol} stored=${sha(a).slice(0, 16)}:${a.length} fresh=${sha(fresh).slice(0, 16)}:${fresh.length}`,
      );
      repair(() => linkInto(fresh, stored, true)); // the fresh bytes are the truth, whatever the store holds
      return true;
    }
    bump('verified');
    return true;
  };

  /** The same for a fresh DETERMINISTIC REJECTION. This half is 77% of what a warm store serves. */
  const auditRejection = (n: string, key: string, symbol: string, message: string): boolean => {
    const found = lookup(n, key, symbol);
    if (found === undefined) {
      return false;
    }
    if ('obj' in found) {
      // The store holds an OBJECT for a TU that no longer compiles: served under `on` it would
      // be scored as a candidate the toolchain now rejects.
      report(
        `OUTCOME MISMATCH label=${label} ns=${n} symbol=${symbol} stored=object fresh=rejection: ${message.split('\n')[0].slice(0, 120)}`,
      );
      repair(() => {
        rmSync(found.obj, { force: true });
        writeAtomic(pathFor(n, key, symbol, 'fail'), message);
      });
      return true;
    }
    // The OUTCOME is what is compared, not the diagnostic text: a compiler's message can carry
    // a scratch path or a line the harness reformats, and neither is the answer the cache
    // serves. Agreement here is what makes the negative half of the store audited at all.
    bump('verifiedFail');
    return true;
  };

  /** Is this key one `get` withheld for an audit? Claims it, so the audit runs exactly once and a
   *  later lookup in the same run is served. `Set.prototype.delete` returns a boolean (unlike
   *  `add`, which returns the Set), and this is the only place that distinction may be relied on. */
  const claimAudit = (id: string): boolean => {
    if (!auditing.delete(id)) {
      return false;
    }
    audited.add(id);
    return true;
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
      const found = lookup(n, key, symbol);
      if (found === undefined) {
        bump('miss');
        return undefined;
      }
      // Only a key the store CAN answer is sampled: a miss is already going to be compiled, and
      // there would be nothing to compare the result against.
      const id = keyId(n, key, symbol);
      // WITHHELD AT MOST ONCE, and this is the fix for a key whose audit never comes back: the
      // withholding used to be re-asserted on every later lookup (`auditing` is only ever emptied
      // by `claimAudit`), so one transient compile failure turned a key the store could answer
      // into a permanent miss for the rest of the process — strictly worse than the uncached run
      // the doc compares against, which at least has no correct answer sitting on disk.
      // `Set.prototype.add` returns the Set, not a boolean, so the `has` must be its own test.
      if (MODE === 'on' && !audited.has(id) && !auditing.has(id) && isSampled(id)) {
        auditing.add(id);
        bump('sampled');
        return undefined;
      }
      if ('obj' in found) {
        bump('hit');
        return found.obj;
      }
      bump('failHit');
      return new Error(found.fail);
    },
    put(key, symbol, objPath) {
      const n = namespace();
      if (n === undefined) {
        return objPath;
      }
      // A SAMPLED key's fresh object goes to the COMPARISON, never to a plain store. Storing it
      // first is the hazard that makes sampling worse than nothing: it overwrites the very bytes
      // the sample was withheld to compare against, the mismatch is never reported, and the store
      // heals itself into a clean-looking audit of the defect it exists to find.
      if (claimAudit(keyId(n, key, symbol))) {
        if (auditObject(n, key, symbol, objPath)) {
          // Serve the STORE's path, exactly as an unsampled put does — `auditObject` has already
          // repaired it with the fresh bytes wherever the two disagreed, so a sampled key is
          // indistinguishable downstream from a served one.
          const dest = pathFor(n, key, symbol, 'o');
          return existsSync(dest) ? dest : objPath;
        }
        // The audit was claimed and there was nothing left to compare it against — a sibling
        // shard pruned the entry between the get and the put. Counted so `sampled` reconciles;
        // the fresh object still stores normally below.
        bump('sampledStale');
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(objPath);
      } catch {
        return objPath; // the caller's own object is the answer; storing it is best-effort
      }
      if (bytes.length === 0) {
        return objPath; // an empty object is not an answer; the caller's own guards speak
      }
      const dest = pathFor(n, key, symbol, 'o');
      try {
        linkInto(bytes, dest);
      } catch {
        return objPath;
      }
      bump('stored');
      return dest;
    },
    putFail(key, symbol, message) {
      const n = namespace();
      if (n === undefined) {
        return;
      }
      if (claimAudit(keyId(n, key, symbol))) {
        if (auditRejection(n, key, symbol, message)) {
          return;
        }
        bump('sampledStale');
      }
      const dest = pathFor(n, key, symbol, 'fail');
      try {
        mkdirSync(dirname(dest), { recursive: true });
        writeAtomic(dest, message);
        bump('failStored');
      } catch {
        /* a store that cannot be written is a cold store */
      }
    },
    abandonAudit(key, symbol) {
      const n = namespace();
      if (n === undefined) {
        return undefined;
      }
      const id = keyId(n, key, symbol);
      if (!auditing.delete(id)) {
        return undefined; // this key was never withheld; the caller's failure is its own
      }
      audited.add(id);
      bump('sampledAbandoned');
      const found = lookup(n, key, symbol);
      if (found === undefined) {
        return undefined;
      }
      if ('obj' in found) {
        bump('hit');
        return found.obj;
      }
      bump('failHit');
      return new Error(found.fail);
    },
    verify(key, symbol, objPath) {
      if (MODE !== 'verify') {
        return;
      }
      const n = namespace();
      if (n !== undefined) {
        auditObject(n, key, symbol, objPath);
      }
    },
    verifyFail(key, symbol, message) {
      if (MODE !== 'verify') {
        return;
      }
      const n = namespace();
      if (n !== undefined) {
        auditRejection(n, key, symbol, message);
      }
    },
  };
}
