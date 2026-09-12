// `pnpm bench sweep` — the CORPUS-WIDE, COMPILE-FREE differential re-lift: what does this tree
// decompile differently from another one, over every row, map-ful and map-less.
//
// WHY THIS IS A SUBCOMMAND. Twenty agents wrote this by hand across six rounds (census.ts,
// sweep.ts, fanhash.ts, det.mts, c3-census.mts, rowhash.mts, kcensus.mts…), 31 driver calls by 14
// agents, and a compile-free differential re-lift was reinvented in 37 rounds. Their scripts agree
// on the payload almost exactly — per row, the emitted C's hash, its diagnostic count, and
// optionally the enumerated fan's label/source hash — and disagree on everything that is not the
// payload: where the script lives, how it resolves `@asmlift/*`, which tree it points at, whether
// it shards, and which rows it skips. That remainder is what got rewritten, not the idea. The
// three failure modes it produced, all measured in this project's own transcripts:
//
//   - `ERR_MODULE_NOT_FOUND` on the hand-built rig in 41 of 51 rounds. The repo root does not
//     depend on `@asmlift/core`, a script outside the repo resolves neither `@asmlift/core/*` nor
//     `@asmlift/cli/*`, and a script inside `apps/benchmark/` resolves both — so every round
//     rediscovered where the file has to sit, and half of them settled on a relative import that
//     only works from one directory (`./packages/core/src/pipeline`).
//   - an untracked probe script is CODE to `provenance.ts`, so a rig left behind stamps the next
//     `bench run` dirty and `bench:merge` refuses the result — after ~2,000 s.
//   - the hand rigs hardcode the OTHER tree's absolute path (`/private/tmp/wt-c3-rev-breaker-2`),
//     so the next round's rig is a copy with the path edited, and a stale copy silently measures
//     the wrong tree.
//
// WHAT DECIDES WHETHER THIS GETS USED. `bench fan` shipped for a real pain and four of the six
// rounds after it still hand-built the same probe, because it is ROW-SCOPED by construction and
// the rigs are not: they iterate the whole corpus, AND they iterate raw `.s` files out of project
// checkouts, on functions that are not benchmark rows at all. So the unit of iteration here is
// deliberately wider than a row — `--asm-dir` sweeps a tree of `.s`/`.inc` files under the same
// record shape and the same diff.
//
// WHAT IT COSTS. `time`d on THIS COMMAND (not on a probe of its parts), on this machine
// 2026-09-12, alone, `ASMLIFT_CANDCACHE` default, over all 1,062 available rows:
//
//   | what                                                 | rows  | wall    |
//   |------------------------------------------------------|-------|---------|
//   | lift, 2 arms, warm target builds — ONE side          | 1,062 | 60.4 s  |
//   | lift, 2 arms, every target built (BENCH_CACHE=0)     | 1,062 | 176.9 s |
//   | `--repeat 2` (the determinism gate)                  | 1,062 | 123.7 s |
//   | `--fan`, 1 arm, the one over-limit row excluded      | 1,061 | 436.8 s |
//   | `--base <ref>`, BOTH sides — the flag this exists for | 1,062 | 232 s   |
//   | `--base-dir <tree> --tier real`, both sides          |   252 | 75.7 s  |
//
// An earlier table here priced the warm row at 28.8 s, which was a standalone probe's build+lift
// loop and NOT this command: `time pnpm bench sweep` is 59.0 / 61.8 / 62.8 s across three runs on
// two worktrees, and `docs/bench-cost.md` had it right. A header table is read as the command's
// price, so it states the command's price.
//
// AND THE PRICE OF THIS COMMAND IS THE `--base` ROW, not the first one: a sweep with no base
// compares nothing. Four whole-corpus measurements, 2026-09-12: `--base HEAD` against a base tree
// provisioned and swept hours earlier is 234.1 s (this tree 60.4 s, base tree 173.3 s), and
// `--base 5c440d38` — `git worktree add` + `pnpm install` + the sweep — is 231.7 s (this tree
// 59.9 s, base tree 169.0 s). So the base side is ~170 s EVERY time and does not amortize, which
// the earlier "its first target builds are cold" reading of the same number got wrong: that same
// base tree sweeping ITSELF, in its own process, is 58.3 s, and the real tier's base side is
// 40.0 s against a head side of 35.2 s with not one cache file written. The gap is in the corpus's
// other 810 rows and is NOT understood; it is quoted here as a measured wall clock and nothing
// more. Budget ~4 minutes for a whole-corpus `--base`, and prefer `--tier`/`--project` when the
// question is scoped — a real-tier A/B is 75.7 s.
//
// Both sides are also cold in a FRESH round worktree, where the head side pays its own ~170 s of
// target builds too: 337 s measured that way (wave-2 review, 2026-09-12).
//
// The split still matters more than the totals: of the cold run, ~116 s is BUILDING the scoring
// targets and ~2.3 s is the 1,346 lifts (probe `price2.mts`, 2026-09-12). Lifting the whole corpus
// is free; everything else is the harness getting the row's own configuration in front of it. That
// is why the default is lift-only and `--fan` is a flag: enumeration is ~120× the lift and is where
// a corpus sweep stops being cheap.
//
// WHAT IT DOES NOT DO. It never compiles a candidate and never scores one, so it cannot tell you
// whether a row MATCHES — that is `bench run`, at ~2,040 s. It tells you which rows your branch
// SPELLS differently, which is the question a round asks twenty times before it asks the other one
// once.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { REPO_ROOT, RESULTS_DIR } from '../config';
import { TOOLCHAINS } from '../toolchains';
import { ARMS, type SweepSelection, TREE_MODULES } from './sweep-driver';

/** One row, one arm, in one tree. Every field is a fact a hand rig recorded, and the set is
 *  closed on purpose: a sweep whose payload each round extends is a rig with a stable filename,
 *  and the diff below has to know every field to compare it. */
export interface SweepRecord {
  /** `project:sym:toolchain` for a row, or `asm:<path relative to --asm-dir>` for a file */
  id: string;
  /** `harness` = the row's own configuration (`rankOptionsFor`); `nomap` = the same minus the
   *  symbol map. Both, because a symbol-fed row and the same row without one take different paths
   *  through naming and global recovery, and a change that moves only one of them is exactly the
   *  change a one-arm rig reports as inert. */
  arm: string;
  /** sha1/12 of the scrubbed asm this record was lifted FROM, and of the option object it was
   *  lifted WITH (`rankOptionsFor`'s result — prototypes, `asmData`, the symbol map). The INPUT,
   *  recorded because each side of a comparison loads its own tree's dataset and harness: without
   *  these two fields a dataset edit under a stable row id moves `src` and reads as a decompiler
   *  change. See `optsDigest` in sweep-driver.ts for the measurement. */
  asm?: string;
  opts?: string;
  /** sha1/12 of the emitted C. THE field: everything else is context for reading a move in it. */
  src?: string;
  /** the emitted C's length, so a hash move can be read as "one token" or "half the function" */
  len?: number;
  /** `decompile`'s diagnostics, at `onGap: 'annotate'` — the count that makes a row `declined` */
  diag?: number;
  /** `ASMLIFT_ERROR` markers in the emitted C (annotate mode's loud-fail, see annotate-mode) */
  marks?: number;
  /** the first line of what the lift threw, when it did */
  threw?: string;
  /** `--fan` only: how many spellings enumeration produced (`enumerateRanked`) */
  fan?: number;
  /** `--fan` only: sha1/12 over `label\0source` pairs IN ENUMERATION ORDER. Ordered and not
   *  sorted: the order is what the ranker consumes, so a reorder with the same set is a real
   *  change to what gets scored first, and `--repeat` exists to tell a reorder from a flake. */
  fanHash?: string;
  /** `--fan` only: the first line of what enumeration threw. Not an error — `enumerateRanked` has
   *  no annotate mode, so every row that publishes `declined` throws here (234 of 1,060 at
   *  bd7ad596), and the census must count them rather than stop at the first one. */
  fanThrew?: string;
  /** why this row produced nothing: `toolchain` (unavailable), `build` (target build failed),
   *  `fan-limit` (bigger than `SWEEP_FAN_LIMIT`, see below) */
  skipped?: string;
}

/** The fields the diff compares, in the order it prints them. The INPUT fields come first, because
 *  a line that opens `asm … -> …` is a different finding from one that opens `src … -> …`. */
const FIELDS = [
  'asm',
  'opts',
  'src',
  'len',
  'diag',
  'marks',
  'threw',
  'fan',
  'fanHash',
  'fanThrew',
  'skipped',
] as const;

/** A record for which NOTHING was lifted: the row's toolchain is unavailable here, or its target
 *  would not build. `fan-limit` is deliberately not one of these — that row WAS lifted, the guard
 *  announced itself by name before paying, and only its enumeration is missing. */
export const unmeasured = (r: SweepRecord): boolean => r.skipped === 'toolchain' || r.skipped === 'build';

/** How many records in a sweep measured nothing, by cause. */
export function unmeasuredCounts(records: readonly SweepRecord[]): { total: number; toolchain: number; build: number } {
  const toolchain = records.filter((r) => r.skipped === 'toolchain').length;
  const build = records.filter((r) => r.skipped === 'build').length;
  return { total: toolchain + build, toolchain, build };
}

export interface RecordMove {
  id: string;
  arm: string;
  fields: { field: string; from: unknown; to: unknown }[];
}

export interface SweepDiff {
  moved: RecordMove[];
  baseOnly: string[];
  headOnly: string[];
  same: number;
  /** records that agree because NEITHER side lifted them. Counted apart from `same` because
   *  "identical" is a claim about two decompilers and this is the absence of one: with
   *  `ASMLIFT_AGBCC` unset — trap #6 of the round protocol, a login shell away — 618 of 1,620
   *  synthetic records were never lifted on either side and the summary called them identical. */
  notMeasured: number;
}

const key = (r: SweepRecord): string => `${r.id} ${r.arm}`;

/** BASE against HEAD, per row and per arm. Both sides are produced by the SAME driver code (this
 *  tree's), differing only in which tree's decompiler it points at — the property every hand rig
 *  had by accident (one script, two invocations) and the one thing a base/head comparison cannot
 *  be correct without. */
export function compareSweeps(base: SweepRecord[], head: SweepRecord[]): SweepDiff {
  const b = new Map(base.map((r) => [key(r), r]));
  const h = new Map(head.map((r) => [key(r), r]));
  const moved: RecordMove[] = [];
  let same = 0;
  let notMeasured = 0;
  for (const [k, hr] of h) {
    const br = b.get(k);
    if (br === undefined) {
      continue;
    }
    const fields = FIELDS.filter((f) => br[f] !== hr[f]).map((f) => ({ field: f, from: br[f], to: hr[f] }));
    if (fields.length > 0) {
      moved.push({ id: hr.id, arm: hr.arm, fields });
    } else if (unmeasured(hr)) {
      notMeasured++;
    } else {
      same++;
    }
  }
  return {
    moved,
    baseOnly: [...b.keys()].filter((k) => !h.has(k)),
    headOnly: [...h.keys()].filter((k) => !b.has(k)),
    same,
    notMeasured,
  };
}

const show = (v: unknown): string => (v === undefined ? '-' : typeof v === 'string' ? v : String(v));

/** The lines a reader acts on. One per moved record, naming every field that moved — never a bare
 *  count, because "7 rows moved" is the input to the next twenty minutes of work and the row ids
 *  are the work. */
export function renderDiff(d: SweepDiff): string[] {
  const lines = d.moved.map(
    (m) =>
      `asmlift: [moved] ${m.id} ${m.arm} — ${m.fields.map((f) => `${f.field} ${show(f.from)} -> ${show(f.to)}`).join(', ')}`,
  );
  for (const k of d.baseOnly) {
    lines.push(`asmlift: [base-only] ${k} — the base tree produced this record and this tree did not`);
  }
  for (const k of d.headOnly) {
    lines.push(`asmlift: [head-only] ${k} — this tree produced this record and the base tree did not`);
  }
  return lines;
}

/** Rows whose recorded fan is larger than this are SKIPPED by `--fan` and named, unless `--force`.
 *
 *  Not a wall-clock guard, because a wall-clock guard cannot pre-empt: enumerating one row is a
 *  single call that returns when it returns. So the guard reads the committed artifact's own
 *  `candidateCount` for the row and refuses BEFORE paying, the way `bench fan`'s `FAN_SCORE_LIMIT`
 *  refuses before compiling.
 *
 *  WHAT IT EXCLUDES, off the committed artifact at bd7ad596 — checked, not assumed, because every
 *  hand rig hardcoded `LoadBGTilemapData|ProcessInputAndUpdateEntities` and only one of those two
 *  is a benchmark row at all (`LoadBGTilemapData` is a klonoa function this project prices in
 *  docs/ranked-repro.md at 225,792 spellings and over five hours; the dataset does not carry it,
 *  so a SKIP regex naming it protects the corpus sweep from nothing):
 *
 *    kleod:ProcessInputAndUpdateEntities:agbcc   77,760   EXCLUDED
 *    kleod:UpdateCameraScroll:agbcc              13,728   admitted, measured 25.1 s
 *    kleod:CountCollectedGems:agbcc               9,192   admitted, measured 83.0 s — the slowest
 *
 *  20,000 sits between the one giant and the largest row a round actually enumerates. Lower would
 *  exclude `CountCollectedGems`, which is this project's most-enumerated row and therefore the
 *  sweep's best customer; higher admits a row whose price nobody has measured.
 *
 *  A row the artifact does not carry has no recorded count and IS enumerated: the guard protects
 *  against the known giants and says so, rather than pretending to bound an unmeasured row. */
export const SWEEP_FAN_LIMIT = 20000;

/** sym → the fan the committed artifact recorded, for the `--fan` guard. Read off the COMMITTED
 *  `results.json` in this worktree rather than through `git show`: the guard's job is to keep a
 *  diagnostic from becoming an overnight job, and a ref that will not resolve must not be able to
 *  turn the guard off. A row the artifact does not carry (a new dataset row) has no recorded
 *  count and is enumerated — the guard protects against the known giants, and says so. */
export function recordedFans(): { fans: Map<string, number>; unreadable?: string; path?: string; rows?: number } {
  const path = join(RESULTS_DIR, 'results.json');
  // NO ARTIFACT AT ALL is the documented pre-guard behavior: a checkout that has never published
  // one prices no row, every row enumerates, and the header says so. AN ARTIFACT THAT WILL NOT
  // PARSE is a different thing and must not read as the same one — a truncated file mid-`bench
  // merge`, or a shape change, used to empty the map inside a bare `catch {}` and turn the guard
  // off with NO OUTPUT AT ALL. Reproduced by deleting the top-level `results` key: `--fan --only
  // ProcessInputAndUpdateEntities` printed nothing and was still enumerating 77,760 spellings at
  // 120 s, against 0.3 s to refuse with the artifact intact. A guard that disappears without a word
  // is worse than no guard, so the caller refuses instead.
  if (!existsSync(path)) {
    return { fans: new Map() };
  }
  const out = new Map<string, number>();
  try {
    const { results } = JSON.parse(readFileSync(path, 'utf8')) as {
      results: { id: string; asmlift: { candidateCount?: number } }[];
    };
    if (!Array.isArray(results)) {
      return { fans: out, path, unreadable: `${path} has no top-level \`results\` array` };
    }
    for (const r of results) {
      if (typeof r.asmlift?.candidateCount === 'number') {
        out.set(r.id, r.asmlift.candidateCount);
      }
    }
    return { fans: out, path, rows: results.length };
  } catch (e) {
    return { fans: out, path, unreadable: `${path}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
}

/** Does this selection name that row? The same three filters `collect` applies, over a row ID
 *  instead of a `Case` — `synthetic:<sym>:<toolchain>` or `<project>:<sym>:<toolchain>`, where
 *  `--only` is a substring of the SYM (`syntheticCases`/`realCases` both filter `x.sym`, not the
 *  id) and the synthetic tier is the rows whose project is `synthetic`.
 *
 *  Exported because it is what lets the `--fan` guard say how much of its own selection the
 *  artifact could price, which is the difference between "no giants here" and "I cannot see". */
export function selectsRow(o: Pick<SweepOptions, 'tiers' | 'only' | 'project'>, id: string): boolean {
  const parts = id.split(':');
  if (parts.length < 3) {
    return false;
  }
  const project = parts[0];
  const sym = parts.slice(1, -1).join(':');
  if (!o.tiers.includes(project === 'synthetic' ? 'synthetic' : 'real')) {
    return false;
  }
  if (o.project !== undefined && project !== o.project) {
    return false;
  }
  return o.only === undefined || sym.includes(o.only);
}

export interface SweepOptions extends SweepSelection {
  /** write the records to this file instead of (well, as well as) printing a summary */
  json?: string;
  /** compare two record files written by earlier runs, running nothing */
  compare?: readonly string[];
  /** a git ref: provision a worktree at it under `.local/` and sweep it as the base */
  base?: string;
  /** a worktree that already exists: sweep it as the base, provisioning nothing */
  baseDir?: string;
  /** run the selection this many times in ONE process (alternating direction) and report any
   *  record that disagreed with itself */
  repeat?: number;
  /** report rows whose toolchain is unavailable (or whose target will not build) and carry on,
   *  instead of exiting 2. For a machine that genuinely lacks a toolchain — mwcc needs Docker. */
  allowUnmeasured?: boolean;
}

function note(s: string): void {
  console.error(s);
}

/** Where `--base <ref>` puts the tree it provisions, named by the base's sha so a second sweep
 *  against the same revision reuses it.
 *
 *  `.local/` is the repo's sanctioned name for per-worktree local state and is gitignored, so a
 *  provisioned base can neither make this tree dirty nor reach `bench run`'s preflight — which
 *  matters, because an untracked file anywhere else under the repo is CODE to `provenance.ts` and
 *  voids the next full run after ~2,000 s. That was one of the three standing hazards of the hand
 *  rigs this replaces.
 *
 *  IT IS STILL A GIT WORKTREE, registered in the shared `.git`. Provisioning one is the same act a
 *  round's own setup performs, and it is cleaned up the same way: `git worktree remove <path>`, or
 *  `git worktree prune` once the directory is gone with the round's worktree. Nothing here removes
 *  it automatically — a base tree costs a `pnpm install` to rebuild and is reused by every later
 *  sweep against that revision, so deleting it after one comparison would be the expensive
 *  choice. */
export const BASE_TREES_DIR = join(REPO_ROOT, '.local', 'sweep-base');

function git(args: string[], cwd = REPO_ROOT): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Materialize (or reuse) a worktree at `ref` and make it runnable.
 *
 *  WHAT A BASE TREE NEEDS, and it is less than the round protocol asks for: `node_modules`, and
 *  nothing else. `cases/real.ts` reads VENDORED preprocessed TUs rather than project checkouts, so
 *  the `checkouts/` and `toolchains/` symlinks a round's worktree needs for `pnpm test:matching`
 *  are not needed here — verified by sweeping all 252 real rows in a tree that had neither.
 *
 *  Returns the path, or an error STRING naming the step that failed. Never a throw: every refusal
 *  in this command prints a sentence and exits 2. */
function provisionBase(ref: string): { dir: string } | { error: string } {
  const sha = git(['rev-parse', `${ref}^{commit}`]);
  if (!sha.ok) {
    return {
      error: `--base ${JSON.stringify(ref)}: git cannot resolve that ref here. ${
        ref.startsWith('origin/') ? 'Run `git fetch origin` first.' : 'Name a branch, tag or sha this checkout has.'
      }`,
    };
  }
  const dir = join(BASE_TREES_DIR, sha.out.trim().slice(0, 12));
  if (!existsSync(dir)) {
    mkdirSync(BASE_TREES_DIR, { recursive: true });
    const add = git(['worktree', 'add', '--detach', dir, sha.out.trim()]);
    if (!add.ok) {
      return { error: `--base ${ref}: git worktree add failed:\n${add.out}` };
    }
    note(`asmlift: [sweep] provisioned base worktree ${dir} at ${sha.out.trim().slice(0, 12)} (${ref})`);
  }
  // THE FLOOR IS CHECKED BEFORE THE INSTALL, because it reads files out of the checkout and needs
  // no `node_modules`: a ref below the floor used to pay a `pnpm install` and only then be told it
  // could never have been swept. Same rule as the base-ref resolution below — take the refusal
  // before anything is paid for.
  const old = moduleFloorRefusal(dir);
  if (old !== undefined) {
    return { error: old };
  }
  if (!existsSync(join(dir, 'node_modules'))) {
    note(`asmlift: [sweep] pnpm install in the base tree (once per base revision, ~2 s)`);
    const r = spawnSync('pnpm', ['install', '--silent'], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) {
      return { error: `--base ${ref}: pnpm install failed in ${dir}:\n${(r.stderr ?? '').slice(0, 2000)}` };
    }
  }
  return { dir };
}

/** Sweep a tree that is not this one, through THIS tree's driver. The driver is spawned rather
 *  than imported so that the base tree's modules never share a process with this tree's — see
 *  sweep-driver.ts's header for why the dynamic-import-by-root shape is safe and what it assumes. */
/** Is this tree one THIS driver can sweep — and if not, which part of it is missing?
 *
 *  HOW FAR BACK `--base` REACHES, as a sentence instead of a raw `ERR_MODULE_NOT_FOUND` stack out
 *  of `tsx`'s resolver, and BEFORE the head sweep is paid for (the same rule the base-ref
 *  resolution above restored). The driver loads NINE modules from the tree under test and they are
 *  the harness's internals, which move: the newest by creation date is
 *  `apps/benchmark/src/asm-scrub.ts` (85f81116, 2026-09-09), so that commit is the floor —
 *  `packages/core/src/symbols.ts` (ed33699c, 2026-08-02) is the next one down. Against `2bb1cde6`
 *  (2026-08-22) the failure arrived as an unhandled stack and the word `ERR_MODULE_NOT_FOUND`,
 *  which is failure mode #1 of the hand rigs this command replaces.
 *
 *  WHAT IT CANNOT CATCH, said out loud: a module that still EXISTS with a CHANGED SIGNATURE.
 *  `rankOptionsFor`'s parameter list moved at 85f81116 and again at 3b82f953, and a base on the
 *  other side of such a change lifts with DIFFERENT OPTIONS rather than with none — which is what
 *  each record's `opts` digest makes visible instead of silent.
 *
 *  AND THAT COMPENSATING CONTROL IS ONLY AS GOOD AS THE DIGEST. It was claimed here while
 *  `optsDigest` still rendered every `Map` as `{}`, so the one signature change it was offered
 *  against — a `rankOptionsFor` that builds a DIFFERENT symbol map rather than dropping the key —
 *  was invisible to this check AND to `opts`. See `canon` in sweep-driver.ts: the sentence above
 *  became true when that was fixed, and stops being true again for any option shape `canon` cannot
 *  render. */
function moduleFloorRefusal(dir: string): string | undefined {
  const missing = TREE_MODULES.filter((p) => !existsSync(join(dir, p)));
  if (missing.length > 0) {
    return `base tree ${dir} is older than this command's floor: it has no ${missing.join(', ')}. \`--base\` reaches back to 85f81116 (2026-09-09) for a whole-corpus sweep; compare against a newer revision, or use \`bench diff\` against the published artifact.`;
  }
  return undefined;
}

function baseTreeRefusal(dir: string): string | undefined {
  if (!existsSync(join(dir, 'node_modules'))) {
    return `base tree ${dir} has no node_modules — run \`pnpm install\` there, or use --base <ref>`;
  }
  return moduleFloorRefusal(dir);
}

function collectBase(dir: string, sel: SweepSelection): { records: SweepRecord[] } | { error: string } {
  const out = join(tmpdir(), `asmlift-sweep-base-${process.pid}.json`);
  const driver = join(import.meta.dirname, 'sweep-driver.ts');
  const tsx = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  const r = spawnSync(tsx, [driver, dir, out, JSON.stringify(sel)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) {
    rmSync(out, { force: true });
    return { error: `the base sweep exited ${r.status ?? 'on a signal'} — nothing was compared` };
  }
  try {
    return { records: JSON.parse(readFileSync(out, 'utf8')) as SweepRecord[] };
  } catch (e) {
    return { error: `the base sweep wrote no readable records: ${e instanceof Error ? e.message : e}` };
  } finally {
    // The handoff file is the transport, not an artifact — a leaked `$TMPDIR/asmlift-sweep-base-
    // <pid>.json` per run is how a scratch directory becomes unreadable.
    rmSync(out, { force: true });
  }
}

/** Every way this command refuses to run, in one place and before anything is paid for. */
export function sweepRefusal(o: SweepOptions): string | undefined {
  if (o.compare !== undefined && (o.base !== undefined || o.baseDir !== undefined)) {
    return '--compare reads two files that already exist; --base/--base-dir produce them. Pick one.';
  }
  if (o.compare !== undefined && o.json !== undefined) {
    return '--compare reads two record files and runs nothing, so there is nothing for --json to write. Drop one.';
  }
  if (o.compare !== undefined && o.compare.length !== 2) {
    // `--compare a.json b.json` reads as one flag and one POSITIONAL, so `cli.ts` pairs
    // `--compare` with `positionals[1]` and hands both here. The count can still be wrong — a
    // missing second file — and then it has to be refused rather than compared against
    // `undefined`, which is how a rig reports "0 moved" over an empty side.
    return `--compare needs two record files: \`bench sweep --compare <base.json> <head.json>\` — got ${o.compare.length}`;
  }
  if (o.base !== undefined && o.baseDir !== undefined) {
    return '--base names a git ref to provision, --base-dir a tree that already exists. Pick one.';
  }
  if (o.repeat !== undefined && (!Number.isInteger(o.repeat) || o.repeat < 2)) {
    return `--repeat runs the selection N times and compares them, so N must be an integer ≥ 2 — got ${o.repeat}`;
  }
  if (o.repeat !== undefined && (o.base !== undefined || o.baseDir !== undefined)) {
    return '--repeat asks whether THIS tree agrees with itself; --base asks whether it agrees with another. Run them separately, so a disagreement has one cause.';
  }
  if (o.asmDir !== undefined && o.toolchain === undefined) {
    return '--asm-dir needs --toolchain: a .s file does not say which target lifted it.';
  }
  if (o.toolchain !== undefined && o.asmDir === undefined) {
    return '--toolchain belongs to --asm-dir alone — a dataset row names its toolchain in its own id, and --only selects it.';
  }
  if (o.asmProject !== undefined && o.asmDir === undefined) {
    return '--asm-project belongs to --asm-dir alone (a dataset row carries its own symbol map).';
  }
  if (o.asmDir !== undefined && o.toolchain !== undefined && !(o.toolchain in TOOLCHAINS)) {
    // Refused HERE rather than thrown from inside the driver: an unknown toolchain used to arrive
    // as a raw node stack on exit 1, which is this command's "rows moved" code.
    return `unknown --toolchain ${JSON.stringify(o.toolchain)} — have: ${Object.keys(TOOLCHAINS).join(', ')}`;
  }
  if (o.asmDir !== undefined && !existsSync(o.asmDir)) {
    return `--asm-dir ${o.asmDir} does not exist`;
  }
  if (o.asmDir !== undefined && o.fan === true && o.force !== true) {
    // THE GUARD CANNOT REACH THIS POPULATION. `SWEEP_FAN_LIMIT` is read off the committed
    // artifact's `candidateCount`, which exists for dataset rows only, so `--asm-dir --fan`
    // enumerates every file unbounded — and the tree this flag exists to sweep,
    // `checkouts/<project>/asm/nonmatchings`, is where the five-hour functions live. Measured on
    // this branch: one 1.6 KB klonoa `.s` in a directory of its own had not finished enumerating
    // at 120 s, while the only line printed named a dataset row the invocation never iterated.
    return '--fan over --asm-dir has no size guard: the limit is read off the committed artifact, which prices dataset rows only, and this population includes functions priced at over five hours. Sweep a directory you have measured and pass --force.';
  }
  const bad = o.arms.filter((a) => !(ARMS as readonly string[]).includes(a));
  if (bad.length > 0) {
    return `unknown --arms ${bad.join(', ')} — the arms are 'harness' (the row's own configuration) and 'nomap' (that, minus the symbol map)`;
  }
  if (o.arms.length === 0) {
    return '--arms selected nothing';
  }
  if (new Set(o.arms).size !== o.arms.length) {
    // The duplicate collapses in `compareSweeps`' Map, so `--arms harness,harness` lifted twice and
    // reported one record — accepted-then-ignored, the class every other pair here is refused for.
    return `--arms names ${o.arms.join(',')} — each arm at most once`;
  }
  return undefined;
}

/** Is this parsed file a side of a comparison — and if not, which part of it is not?
 *
 *  EXIT 1 IS THIS COMMAND'S "ROWS MOVED" CODE, so a crash landing there is a wrong ANSWER and not
 *  merely an ugly one: `bench sweep --compare a b; [ $? -eq 1 ] && report` reads it as a finding.
 *  The `try/catch` above wraps `JSON.parse` alone, so a file that PARSES and is not an array of
 *  records reached `compareSweeps` and died on `base.map is not a function` as a raw node stack —
 *  and the realistic input is a reader pointing `--compare` at `apps/benchmark/results/results.json`,
 *  which is a JSON OBJECT and belongs to `bench diff`.
 *
 *  An EMPTY side is refused for the reason an empty selection is (`head.length === 0` below): it
 *  compares clean against anything, and `bench sweep --compare … && echo clean` is the gate this
 *  command is for. Reproduced: two `[]` files printed `0 record(s) moved … 0 identical` at exit 0. */
export function recordFileRefusal(file: string, parsed: unknown): string | undefined {
  if (!Array.isArray(parsed)) {
    return `${file} is not a sweep record file: it parses to ${parsed === null ? 'null' : typeof parsed}, and \`--json\` writes a JSON ARRAY of records. (\`results.json\` is \`bench run\`'s artifact — \`bench diff\` reads that one.)`;
  }
  if (parsed.length === 0) {
    return `${file} holds no records, so it compares clean against anything — the run that wrote it swept nothing, or was interrupted mid-write`;
  }
  const bad = (parsed as unknown[]).findIndex(
    (r) =>
      r === null ||
      typeof r !== 'object' ||
      typeof (r as SweepRecord).id !== 'string' ||
      typeof (r as SweepRecord).arm !== 'string',
  );
  if (bad >= 0) {
    return `${file} is not a sweep record file: entry ${bad} has no \`id\`/\`arm\` pair, which is what a comparison keys on`;
  }
  return undefined;
}

const selectionOf = (o: SweepOptions): SweepSelection => ({
  tiers: o.tiers,
  ...(o.only !== undefined ? { only: o.only } : {}),
  ...(o.project !== undefined ? { project: o.project } : {}),
  arms: o.arms,
  ...(o.fan !== undefined ? { fan: o.fan } : {}),
  ...(o.force !== undefined ? { force: o.force } : {}),
  ...(o.overLimit !== undefined ? { overLimit: o.overLimit } : {}),
  ...(o.asmDir !== undefined ? { asmDir: o.asmDir } : {}),
  ...(o.toolchain !== undefined ? { toolchain: o.toolchain } : {}),
  ...(o.asmProject !== undefined ? { asmProject: o.asmProject } : {}),
});

/** The rows `--fan` will skip, and why the caller has to compute them: the limit is read off THIS
 *  tree's committed artifact and handed to BOTH sides, so a base whose artifact prices a row
 *  differently still skips the same rows — otherwise the giant appears as a `head-only` record and
 *  the comparison has silently paid five hours to produce one. */
function overLimitRows(o: SweepOptions): { over: Record<string, number>; unreadable?: string } {
  // `--asm-dir` is excluded rather than merely empty: the guard keys on a DATASET row id, a raw
  // `.s` has no recorded count, and printing "`--fan` skips kleod:ProcessInputAndUpdateEntities"
  // over a selection that never iterates a dataset row told a reader a guard had fired when none
  // could. `sweepRefusal` refuses that combination; this keeps the note off the other paths too.
  if (o.fan !== true || o.force === true || o.asmDir !== undefined) {
    return { over: {} };
  }
  return fanGuard(o, recordedFans());
}

/** The guard itself, over an artifact that has ALREADY been read — the pure half, because the CI
 *  mirror runs where the committed artifact is the repo's own and a test cannot perturb it. */
export function fanGuard(
  o: Pick<SweepOptions, 'tiers' | 'only' | 'project'>,
  artifact: ReturnType<typeof recordedFans>,
): { over: Record<string, number>; unreadable?: string } {
  const { fans, unreadable, path, rows } = artifact;
  if (unreadable !== undefined) {
    return { over: {}, unreadable };
  }
  const over: Record<string, number> = {};
  let priced = 0;
  for (const [id, n] of fans) {
    if (!selectsRow(o, id)) {
      continue;
    }
    priced++;
    if (n > SWEEP_FAN_LIMIT) {
      over[id] = n;
    }
  }
  // AN ARTIFACT THAT PRICES NONE OF THE SELECTION IS UNREADABLE, not "no giants here". This is
  // where the first version of the guard still failed OPEN and SILENTLY one level below the JSON
  // error it had learned to catch: with `results: []` — a shard that wrote no rows, or a checkout
  // mid-`bench merge` — the loop added nothing, nothing was over the limit, and `--fan --only
  // ProcessInputAndUpdateEntities` printed NOTHING and was still enumerating 77,760 spellings when
  // it was killed at 25 s, against 0.9 s to refuse with the artifact intact. Renaming the
  // `asmlift` key on all 1,062 results — the schema move this guard's own comment names as its
  // trigger — did the same at 30 s. The count is SELECTION-SCOPED and not corpus-wide, because a
  // whole-corpus artifact that prices no `kleod` row bounds a `--project kleod --fan` run exactly
  // as little as an empty one does.
  //
  // THE PRICE, said out loud: a selection of rows the artifact does not carry — a dataset row this
  // branch ADDS — now refuses where it used to enumerate. That is the right default for a flag
  // whose population contains five-hour functions, and `--force` is one word.
  if (path !== undefined && priced === 0) {
    return {
      over: {},
      unreadable:
        fans.size === 0
          ? `${path} prices no row at all — 0 of its ${rows ?? 0} result(s) carry an \`asmlift.candidateCount\`, which is what a schema move under that key, or an artifact from a shard that wrote no rows, looks like`
          : `${path} prices ${fans.size} row(s) and not one of the rows this selection names, so it bounds nothing here`,
    };
  }
  return { over };
}

export async function sweep(o: SweepOptions): Promise<number> {
  const refusal = sweepRefusal(o);
  if (refusal !== undefined) {
    note(`asmlift: [sweep] ${refusal}`);
    return 2;
  }

  if (o.compare !== undefined) {
    const sides: SweepRecord[][] = [];
    for (const f of o.compare) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(f, 'utf8'));
      } catch (e) {
        note(`asmlift: [sweep] cannot read ${f}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
        return 2;
      }
      const bad = recordFileRefusal(f, parsed);
      if (bad !== undefined) {
        note(`asmlift: [sweep] ${bad}`);
        return 2;
      }
      sides.push(parsed as SweepRecord[]);
    }
    // NEITHER SIDE'S RECORDS ARE THIS PROCESS'S. `--json`/`--compare` exist to split a comparison
    // across two machines, so both files were written by a run this one did not watch. A pair with
    // no key in common was not swept over the same selection — a truncated write, two different
    // `--only`s, one side's `--arms` — and comparing them reports every record as base-only or
    // head-only, which is arithmetic, not an answer.
    const shared = new Set(sides[0].map((r) => `${r.id} ${r.arm}`));
    const overlap = sides[1].filter((r) => shared.has(`${r.id} ${r.arm}`)).length;
    if (overlap === 0) {
      note(
        `asmlift: [sweep] ${o.compare[0]} and ${o.compare[1]} share no record: ${sides[0].length} and ${sides[1].length} record(s) and not one id+arm in common, so nothing was compared. Sweep both sides over the same --tier/--only/--project/--arms.`,
      );
      return 2;
    }
    return reportDiff(compareSweeps(sides[0], sides[1]), `${o.compare[0]} -> ${o.compare[1]}`, o);
  }

  const { over, unreadable } = overLimitRows(o);
  if (unreadable !== undefined) {
    note(
      `asmlift: [sweep] --fan needs the committed artifact to size what it is about to enumerate, and it does not: ${unreadable}`,
    );
    note(
      `asmlift: [sweep] --force enumerates every row anyway (kleod:ProcessInputAndUpdateEntities is 77,760 spellings).`,
    );
    return 2;
  }
  const sel = selectionOf({ ...o, overLimit: over });
  if (o.asmDir !== undefined && o.asmProject === undefined && o.arms.includes('harness')) {
    // ACCEPTED, and said out loud: with no project there is no symbol map, so the `harness` arm is
    // the `nomap` arm under another name. The record is still emitted under both (a rectangular
    // record set is what makes the row-set arithmetic readable), but a reader must not read two
    // identical arms as evidence that the map changed nothing.
    note(
      `asmlift: [sweep] --asm-dir without --asm-project: there is no symbol map, so the 'harness' arm IS the 'nomap' arm here.`,
    );
  }
  for (const [id, n] of Object.entries(over)) {
    note(
      `asmlift: [sweep] --fan skips ${id}: ${n} recorded spellings, over SWEEP_FAN_LIMIT ${SWEEP_FAN_LIMIT} (--force to enumerate it anyway)`,
    );
  }

  // THE BASE TREE IS RESOLVED BEFORE THE HEAD SWEEP IS PAID FOR. Measured on the way in: with the
  // resolution left where it reads naturally — after the head side, just before it is needed —
  // `bench sweep --base no/such/ref` printed `1062 row(s) ... 59.6 s` and THEN "git cannot resolve
  // that ref". A refusal a minute after the mistake is a refusal the reader has already stopped
  // watching for, and `run/fan.ts` states the same rule about its own `optionRefusal`: take the
  // refusal before anything is paid for.
  let baseTree: string | undefined;
  if (o.baseDir !== undefined) {
    // RESOLVED, because the driver is loaded as `import(`${root}/apps/...`)` and a bare relative
    // root is not a module specifier: `--base-dir .local/sweep-base/<sha>` passed `existsSync`,
    // reached the base subprocess and died there on `ERR_INVALID_MODULE_SPECIFIER`. Relative is
    // what a reader types.
    const dir = resolve(o.baseDir);
    if (!existsSync(dir)) {
      note(`asmlift: [sweep] --base-dir ${o.baseDir} does not exist`);
      return 2;
    }
    baseTree = dir;
  } else if (o.base !== undefined) {
    const p = provisionBase(o.base);
    if ('error' in p) {
      note(`asmlift: [sweep] ${p.error}`);
      return 2;
    }
    baseTree = p.dir;
  }
  if (baseTree !== undefined) {
    const bad = baseTreeRefusal(baseTree);
    if (bad !== undefined) {
      note(`asmlift: [sweep] ${bad}`);
      return 2;
    }
  }

  const { collect } = await import('./sweep-driver');
  const t0 = Date.now();
  const head = await collect(REPO_ROOT, sel);
  const secs = (t: number): string => ((Date.now() - t) / 1000).toFixed(1);
  const un = unmeasuredCounts(head);
  note(
    `asmlift: [sweep] this tree: ${head.length} record(s) over ${new Set(head.map((r) => r.id)).size} row(s), ${o.arms.join('+')}${o.fan ? ', +fan' : ''} — ${secs(t0)} s${
      un.total > 0 ? `; ${un.total} NOT MEASURED (toolchain ${un.toolchain}, build ${un.build})` : ''
    }`,
  );
  // AN EMPTY SELECTION IS NOT A CLEAN BILL OF HEALTH. `bench sweep --base main && echo clean` is
  // the gate this command is for, and a typo'd `--only`/`--project`/`--asm-dir` passed it: 0
  // record(s), 0 moved, exit 0. `run/gate-census.ts` refuses the same condition at exit 2.
  if (head.length === 0) {
    note(`asmlift: [sweep] no rows selected — nothing was swept, so nothing was compared`);
    return 2;
  }
  if (o.json !== undefined) {
    writeFileSync(o.json, JSON.stringify(head));
    note(`asmlift: [sweep] wrote ${o.json}`);
  }

  if (o.repeat !== undefined) {
    // DETERMINISM. Five breakers rebuilt this check by hand in six rounds and every one of them
    // reported 0 disagreements — which is the result worth having cheaply rather than the result
    // worth skipping. Alternating direction is the point: a pass that carries state between rows
    // (a module-level cache, a counter) disagrees under REORDERING and not under repetition, and
    // a repeat-only check is blind to exactly that.
    let disagreed = 0;
    for (let i = 1; i < o.repeat; i++) {
      const again = await collect(REPO_ROOT, { ...sel, reverse: i % 2 === 1 } as SweepSelection);
      const d = compareSweeps(head, again);
      for (const m of d.moved) {
        disagreed++;
        note(`asmlift: [nondet] run ${i + 1} ${m.id} ${m.arm} — ${m.fields.map((f) => f.field).join(', ')}`);
      }
      for (const k of [...d.baseOnly, ...d.headOnly]) {
        disagreed++;
        note(`asmlift: [nondet] run ${i + 1} ${k} — present in one run and not the other`);
      }
    }
    console.log(
      `asmlift: [sweep] determinism: ${head.length} record(s) × ${o.repeat} run(s) (alternating direction), ${disagreed} disagreement(s)`,
    );
    return unmeasuredRefusal(un.total, o) ?? (disagreed === 0 ? 0 : 1);
  }

  if (baseTree === undefined) {
    console.log(`asmlift: [sweep] ${head.length} record(s); no base given, so nothing was compared`);
    return unmeasuredRefusal(un.total, o) ?? 0;
  }

  const dir = baseTree;
  const t1 = Date.now();
  const base = collectBase(dir, sel);
  if ('error' in base) {
    note(`asmlift: [sweep] ${base.error}`);
    return 2;
  }
  note(`asmlift: [sweep] base tree: ${base.records.length} record(s) — ${secs(t1)} s`);
  return reportDiff(compareSweeps(base.records, head), `${dir} -> this tree`, o);
}

/** A sweep that could not lift part of its own selection did not answer the question, and exits 2
 *  saying which part — the code `bench gates` uses for the same condition.
 *
 *  WHY IT IS A REFUSAL AND NOT A WARNING. The gate a round writes is `bench sweep --base main &&
 *  echo clean`, and the environment this project loses most often is a toolchain: trap #6 of the
 *  round protocol is a LOGIN shell shadowing the `cpp` shim, which turned 44 matches into
 *  `noncompile` while the run reported ✓. With `ASMLIFT_AGBCC` unset, this command reported 618 of
 *  1,620 synthetic records as "identical" and exited 0. Measured on a correctly wired machine, the
 *  whole corpus sweeps with 0 of 2,124 records unmeasured, so this refusal costs a correct setup
 *  nothing; `--allow-unmeasured` is for the setup that genuinely lacks a toolchain (mwcc needs
 *  Docker) and wants the rest of the answer. */
function unmeasuredRefusal(total: number, o: SweepOptions, moved = 0): number | undefined {
  if (total === 0 || o.allowUnmeasured === true) {
    return undefined;
  }
  // THE ENVIRONMENT CODE MASKS THE ANSWER CODE, and only one number fits in an exit status. 2 wins
  // because a sweep that could not lift part of its selection did not answer the question — but a
  // sweep with REAL moves must not read as "environment broken" and nothing else, so the count is
  // in the line. The `[moved]` lines are printed above this one either way.
  note(
    `asmlift: [sweep] ${total} record(s) were NOT MEASURED — their toolchain is unavailable here or their target would not build, so this sweep did not answer the question for them${
      moved > 0
        ? ` (and ${moved} record(s) DID move — those lines are above, and --allow-unmeasured exits 1 on them)`
        : ''
    }. Check \`which cpp\` and the ASMLIFT_* env (round protocol trap #6), or pass --allow-unmeasured.`,
  );
  return 2;
}

/** Print the comparison. Exit 1 when anything moved, matching `bench diff`'s contract: a
 *  comparison gate that exits 0 whatever it found is a gate nobody can put in a script. */
function reportDiff(d: SweepDiff, what: string, o: SweepOptions): number {
  for (const line of renderDiff(d)) {
    console.log(line);
  }
  const moved = d.moved.length + d.baseOnly.length + d.headOnly.length;
  console.log(
    `asmlift: [sweep] ${what}: ${d.moved.length} record(s) moved, ${d.baseOnly.length} base-only, ${d.headOnly.length} head-only, ${d.same} identical${
      d.notMeasured > 0 ? `, ${d.notMeasured} NOT MEASURED on either side` : ''
    }`,
  );
  return unmeasuredRefusal(d.notMeasured, o, moved) ?? (moved === 0 ? 0 : 1);
}
