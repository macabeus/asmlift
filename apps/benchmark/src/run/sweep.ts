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
// WHAT IT COSTS, measured on this machine 2026-09-12 at bd7ad596, alone, `ASMLIFT_CANDCACHE`
// default, over all 1,062 available rows:
//
//   | what                              | rows  | wall    |
//   |-----------------------------------|-------|---------|
//   | lift, 2 arms, warm target builds  | 1,062 | 28.8 s  |
//   | lift, 2 arms, COLD target builds  | 1,062 | 136.9 s |
//   | `--fan`, 1 arm, giants excluded   |   827 | 277.4 s |
//
// The split matters more than the totals: of the 136.9 s cold, 116.1 s is BUILDING the scoring
// targets and 2.3 s is the 1,346 lifts. Lifting the whole corpus is free; everything else is the
// harness getting the row's own configuration in front of it. That is why the default is
// lift-only and `--fan` is a flag: enumeration is 120× the lift and is where a corpus sweep stops
// being cheap.
//
// WHAT IT DOES NOT DO. It never compiles a candidate and never scores one, so it cannot tell you
// whether a row MATCHES — that is `bench run`, at ~2,040 s. It tells you which rows your branch
// SPELLS differently, which is the question a round asks twenty times before it asks the other one
// once.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT, RESULTS_DIR } from '../config';
import type { SweepSelection } from './sweep-driver';

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

/** The fields the diff compares, in the order it prints them. */
const FIELDS = ['src', 'len', 'diag', 'marks', 'threw', 'fan', 'fanHash', 'fanThrew', 'skipped'] as const;

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
  for (const [k, hr] of h) {
    const br = b.get(k);
    if (br === undefined) {
      continue;
    }
    const fields = FIELDS.filter((f) => br[f] !== hr[f]).map((f) => ({ field: f, from: br[f], to: hr[f] }));
    if (fields.length === 0) {
      same++;
    } else {
      moved.push({ id: hr.id, arm: hr.arm, fields });
    }
  }
  return {
    moved,
    baseOnly: [...b.keys()].filter((k) => !h.has(k)),
    headOnly: [...h.keys()].filter((k) => !b.has(k)),
    same,
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
export function recordedFans(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const { results } = JSON.parse(readFileSync(join(RESULTS_DIR, 'results.json'), 'utf8')) as {
      results: { id: string; asmlift: { candidateCount?: number } }[];
    };
    for (const r of results) {
      if (typeof r.asmlift.candidateCount === 'number') {
        out.set(r.id, r.asmlift.candidateCount);
      }
    }
  } catch {
    // no artifact in this checkout — every row enumerates, which is the pre-guard behavior
  }
  return out;
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
}

function note(s: string): void {
  console.error(s);
}

/** Where `--base <ref>` puts the tree it provisions. `.local/` is the repo's sanctioned name for
 *  per-worktree local state and is gitignored, so a provisioned base cannot make this tree dirty
 *  and cannot reach `bench run`'s preflight. */
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
function collectBase(dir: string, sel: SweepSelection): { records: SweepRecord[] } | { error: string } {
  if (!existsSync(join(dir, 'node_modules'))) {
    return { error: `base tree ${dir} has no node_modules — run \`pnpm install\` there, or use --base <ref>` };
  }
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
    return { error: `the base sweep exited ${r.status ?? 'on a signal'} — nothing was compared` };
  }
  try {
    return { records: JSON.parse(readFileSync(out, 'utf8')) as SweepRecord[] };
  } catch (e) {
    return { error: `the base sweep wrote no readable records: ${e instanceof Error ? e.message : e}` };
  }
}

/** Every way this command refuses to run, in one place and before anything is paid for. */
export function sweepRefusal(o: SweepOptions): string | undefined {
  if (o.compare !== undefined && (o.base !== undefined || o.baseDir !== undefined)) {
    return '--compare reads two files that already exist; --base/--base-dir produce them. Pick one.';
  }
  if (o.compare !== undefined && o.compare.length !== 2) {
    return `--compare takes exactly two record files, got ${o.compare.length}`;
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
  const bad = o.arms.filter((a) => a !== 'harness' && a !== 'nomap');
  if (bad.length > 0) {
    return `unknown --arms ${bad.join(', ')} — the arms are 'harness' (the row's own configuration) and 'nomap' (that, minus the symbol map)`;
  }
  if (o.arms.length === 0) {
    return '--arms selected nothing';
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
function overLimitRows(o: SweepOptions): Record<string, number> {
  if (o.fan !== true || o.force === true) {
    return {};
  }
  const over: Record<string, number> = {};
  for (const [id, n] of recordedFans()) {
    if (n > SWEEP_FAN_LIMIT) {
      over[id] = n;
    }
  }
  return over;
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
      try {
        sides.push(JSON.parse(readFileSync(f, 'utf8')) as SweepRecord[]);
      } catch (e) {
        note(`asmlift: [sweep] cannot read ${f}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
        return 2;
      }
    }
    return reportDiff(compareSweeps(sides[0], sides[1]), `${o.compare[0]} -> ${o.compare[1]}`);
  }

  const over = overLimitRows(o);
  const sel = selectionOf({ ...o, overLimit: over });
  for (const [id, n] of Object.entries(over)) {
    note(
      `asmlift: [sweep] --fan skips ${id}: ${n} recorded spellings, over SWEEP_FAN_LIMIT ${SWEEP_FAN_LIMIT} (--force to enumerate it anyway)`,
    );
  }

  const { collect } = await import('./sweep-driver');
  const t0 = Date.now();
  const head = await collect(REPO_ROOT, sel);
  const secs = (t: number): string => ((Date.now() - t) / 1000).toFixed(1);
  note(
    `asmlift: [sweep] this tree: ${head.length} record(s) over ${new Set(head.map((r) => r.id)).size} row(s), ${o.arms.join('+')}${o.fan ? ', +fan' : ''} — ${secs(t0)} s`,
  );
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
    return disagreed === 0 ? 0 : 1;
  }

  if (o.base === undefined && o.baseDir === undefined) {
    console.log(`asmlift: [sweep] ${head.length} record(s); no base given, so nothing was compared`);
    return 0;
  }

  let dir: string;
  if (o.baseDir !== undefined) {
    if (!existsSync(o.baseDir)) {
      note(`asmlift: [sweep] --base-dir ${o.baseDir} does not exist`);
      return 2;
    }
    dir = o.baseDir;
  } else {
    const p = provisionBase(o.base!);
    if ('error' in p) {
      note(`asmlift: [sweep] ${p.error}`);
      return 2;
    }
    dir = p.dir;
  }
  const t1 = Date.now();
  const base = collectBase(dir, sel);
  if ('error' in base) {
    note(`asmlift: [sweep] ${base.error}`);
    return 2;
  }
  note(`asmlift: [sweep] base tree: ${base.records.length} record(s) — ${secs(t1)} s`);
  return reportDiff(compareSweeps(base.records, head), `${dir} -> this tree`);
}

/** Print the comparison. Exit 1 when anything moved, matching `bench diff`'s contract: a
 *  comparison gate that exits 0 whatever it found is a gate nobody can put in a script. */
function reportDiff(d: SweepDiff, what: string): number {
  for (const line of renderDiff(d)) {
    console.log(line);
  }
  const moved = d.moved.length + d.baseOnly.length + d.headOnly.length;
  console.log(
    `asmlift: [sweep] ${what}: ${d.moved.length} record(s) moved, ${d.baseOnly.length} base-only, ${d.headOnly.length} head-only, ${d.same} identical`,
  );
  return moved === 0 ? 0 : 1;
}
