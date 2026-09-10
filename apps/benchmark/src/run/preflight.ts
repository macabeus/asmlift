// What a `bench run` is checked for BEFORE it spends half an hour, as opposed to what it is
// checked for after.
//
// `provenance.ts` samples the tree DURING the run and `report/merge.ts` refuses to merge a tier
// whose sample came back dirty. That pair is correct and stays as it is — a mutation that lands
// mid-run is invisible to anything sampled at the start. But it makes the loss maximal for the one
// case that is already decidable at second 0: a dirty tree at the start is almost always a dirty
// tree at the end, and twice it was a single UNTRACKED ENV FILE sitting in a worktree, costing a
// ~2,350 s run each time. `merge` said so, correctly, 39 minutes late.
//
// So this is the same rule asked at the start. It refuses strictly LESS than `merge` does: every
// tree it rejects would have had its run stamp come back dirty and be rejected there anyway. And
// it refuses only runs that REWRITE A TIER WHOLE — the scoped dev loop is the shape you run on a
// dirty tree on purpose, and a check that stopped it would be traded away inside one round.
//
// "WHOLE" is the exact word, because a scoped run does NOT leave its tier file alone: `cli.ts`
// writes `results/<tier>.json` — the canonical file `merge` publishes — holding only the selected
// rows (measured: `--tier synthetic --only add --toolchain agbcc --serial` wrote an 11-row
// `synthetic.json`; see `runner.ts`'s `writeEmpty` for the `results: []` case). What makes the
// scoped loop safe to run dirty is that `bench:merge` still refuses the tier at the end, not that
// nothing was written — and the reader of this refusal is deciding whether to commit or to route
// around it.
//
// THREE LAWS, THREE PREDICATES. `runTakesTheBenchLock` asks "is this a run at all, rather than one
// of its own shard children" — the only invocations that carry a record in `run/lock.ts`'s
// register, and so the only ones its concurrent-run refusal is about. `runIsWholeTier` asks "does
// this invocation rewrite a tier file whole": the git question, and also what makes a second run
// beside a neighbour's a breach of the house rule rather than a dev loop. The `cpp` question is a
// different one — "will this invocation preprocess anything with the host `cpp`" — and the tier
// alone decides it: every `CPP` call site in `compile/{ido,kmc,gcc272}.ts` sits inside the `*Real`
// export, `compile/real.ts` is their only consumer, and no synthetic row preprocesses. Scoping
// cannot narrow it (`--toolchain` does not filter the real tier at all — `cases/real.ts` takes
// only `project`/`only`), and it must not: the scoped `--tier real --only <sym>` loop that both
// briefs prescribe is exactly where TRAP 6 bites, so it is the last place the probe may be silent.
//
// The `cpp` probe rides along for free and is NOT priced as a saving: its prose version ("spend
// one second on `which cpp` before spending 30 minutes") has been written down repeatedly and has
// stopped nothing. Its incident is a login shell resolving `cpp` to Apple clang, which ignores
// `-o`, writes the preprocessed text to stdout and exits 1 — 44 rows failed and the run reported
// itself successful, `✓` on both tiers and exit 0. The probe is the failure itself, run on one
// line of C: it does not care which `cpp` is on PATH, only whether that one honours `-o`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CPP_PREPROCESS_FLAGS } from '../compile/util';
import { CPP, REPO_ROOT } from '../config';
import { codeDirtyPaths } from '../provenance';
import { type ToolchainId, availableToolchains } from '../toolchains';
import { type BenchLockState, concurrentRunRefusal, readBenchLock } from './lock';
import { type Tier, tierIsFiltered } from './orchestrate';

/** The gitignored name a local env file is expected to take, quoted in the refusal. One sanctioned
 *  name beats an escape hatch: without it every round that trips this refusal invents its own way
 *  past it, and lands back on the 39-minute loss at `bench:merge`. */
export const LOCAL_ENV_FILE = '.envrc.local';

/** ...and the gitignored directory for everything else local. Named here rather than
 *  `$(git rev-parse --git-path info/exclude)` because that path, from ANY worktree, resolves to
 *  the MAIN checkout's file: it outlives the worktree that appended to it, every other worktree
 *  reads it, and nothing prunes it. A gitignored directory is scoped and disposable. */
export const LOCAL_SCRATCH_DIR = '.local/';

/** How many dirty paths the refusal lists before it summarises the rest. */
const PATHS_SHOWN = 20;

/** The toolchains whose REAL-TIER candidate compiles preprocess with the host `cpp`
 *  (`compile/{ido,kmc,gcc272}.ts`, all three inside their `*Real` export). agbcc uses
 *  `arm-none-eabi-cpp` and mwcc/ppc preprocess inside docker, so a broken `cpp` costs them
 *  nothing. Hand-maintained, so `preflight.test.ts` derives the same set by scanning `compile/`
 *  and `REAL_COMPILERS`, and fails if a rung added later diverges from it. */
export const CPP_TOOLCHAINS: readonly ToolchainId[] = ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'];

export interface PreflightOptions {
  tiers: Tier[];
  only?: string;
  project?: string;
  toolchain?: string;
  shard?: string;
  serial?: boolean;
}

/** A shard CHILD, exempt from EVERY verdict in this file and from taking a lock record: the parent
 *  that spawned it has already answered them once, and every child re-answering would print the
 *  same refusal N times — or, for the record, would say eight runs are in flight. `--shard` alone
 *  is NOT that child — `cli.ts`'s fan-out branch ignores the shard and runs the tier whole — so
 *  the test is `--shard` AND `--serial`, exactly how `orchestrate.ts` spawns one
 *  (`run --serial --tier X --shard i/N`). `cli.ts` rejects the other combination outright.
 *
 *  Private: the three predicates below are the exported surface, so that every exemption is
 *  spelled in the file that owns the sentence above rather than re-derived by a caller. */
function isShardChild(opts: PreflightOptions): boolean {
  return opts.shard !== undefined && opts.serial === true;
}

/** Does this invocation write a record into `run/lock.ts`'s register, so the phases that edit the
 *  tree can see it? Every run but a shard child. Exported for `cli.ts`, which takes the record
 *  after this file's verdicts pass — taking one is not a refusal, so it does not belong in
 *  `preflightRefusals`, but WHICH invocations are exempt does belong here with the other two. */
export function runTakesTheBenchLock(opts: PreflightOptions): boolean {
  return !isShardChild(opts);
}

/** Will this invocation rewrite at least one tier file WHOLE? That — not "is it slow" — is the
 *  question, because a tier file written whole is what `merge` publishes and what the provenance
 *  refusal is about. */
export function runIsWholeTier(opts: PreflightOptions): boolean {
  return !isShardChild(opts) && opts.tiers.some((tier) => !tierIsFiltered(tier, opts));
}

/** Will this invocation compile anything through the host `cpp`? The REAL tier does, on the three
 *  rungs in `CPP_TOOLCHAINS`; the synthetic tier never does. Scoping does not change the answer —
 *  `--only`/`--project` still compile real rows, and `--toolchain` does not filter the real tier at
 *  all — so a one-row `--only` run is checked exactly like a whole one, and a synthetic-only run
 *  pays neither the probe nor, on a broken `cpp`, the toolchain scan. */
export function runUsesHostCpp(opts: PreflightOptions): boolean {
  return !isShardChild(opts) && opts.tiers.includes('real');
}

/** The refusal text for a dirty tree, or undefined when there is nothing to refuse. Pure, so the
 *  message is testable without a checkout to dirty. */
export function dirtyTreeRefusal(paths: readonly string[]): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  // Capped: a tree after a rebase or a `pnpm format` sweep has hundreds of paths, and printing
  // them all scrolls the actionable sentences below off the reader's screen.
  const shown = paths.slice(0, PATHS_SHOWN);
  return [
    `bench run REFUSED: the working tree's code differs from HEAD, in ${paths.length} path${paths.length === 1 ? '' : 's'}:`,
    ...shown.map((p) => `  ${p}`),
    ...(paths.length > shown.length ? [`  …and ${paths.length - shown.length} more`] : []),
    '',
    'A full run against this tree produces numbers no commit holds, and `bench merge` refuses to',
    'publish them — 39 minutes from now. Commit the change, or, if it is local scratch, move it:',
    `env exports go in \`${LOCAL_ENV_FILE}\`, anything else under \`${LOCAL_SCRATCH_DIR}\` — both gitignored.`,
    'A scoped run is not refused — it is the dev loop, and it is meant to run dirty. It still',
    'REWRITES `results/<tier>.json` with only the rows it selected, so run whole before',
    '`bench:merge`. And note `--only` scopes both tiers, while `--project` scopes real and',
    '`--toolchain` scopes synthetic: pair those two with `--tier real` / `--tier synthetic`, or the',
    'other tier is still rewritten whole and this refusal still fires.',
  ].join('\n');
}

/** The refusal text for a `cpp` that does not honour `-o`. */
export function cppRefusal(probe: { ok: boolean; how: string }): string | undefined {
  if (probe.ok) {
    return undefined;
  }
  return [
    `bench run REFUSED: \`${CPP}\` does not preprocess to \`-o\` (${probe.how}).`,
    '',
    'Usually that is Apple clang answering to `cpp`: a login shell puts /usr/bin ahead of the shim.',
    'Every REAL-tier ido, kmc and gcc272 row would come back `noncompile` and the run would still',
    'report `✓` and exit 0 — one row or 300 of them. Put the GNU shim first on PATH, or set',
    'ASMLIFT_CPP, then re-run:',
    '  export PATH="$HOME/.local/bin:$PATH"',
  ].join('\n');
}

/** Ask the configured `cpp` to do the one thing the harness needs of it. */
export function probeCpp(cpp: string = CPP): { ok: boolean; how: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-cpp-'));
  try {
    const cPath = join(dir, 'probe.c');
    const iPath = join(dir, 'probe.i');
    writeFileSync(cPath, 'int probe;\n');
    const r = spawnSync(cpp, [...CPP_PREPROCESS_FLAGS, cPath, '-o', iPath], { encoding: 'utf8' });
    if (r.error) {
      return { ok: false, how: `cannot be run: ${r.error.message}` };
    }
    if (r.status !== 0) {
      return { ok: false, how: `exit ${r.status}: ${(r.stderr ?? '').trim().split('\n')[0]}` };
    }
    return existsSync(iPath) ? { ok: true, how: 'ok' } : { ok: false, how: 'exit 0 but wrote no output file' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `preflightRefusals` reads from the world, injectable so every branch of it is testable
 *  against a throwaway checkout and a stub `cpp` instead of the machine it happens to run on. */
export interface PreflightDeps {
  repoRoot?: string;
  probe?: () => { ok: boolean; how: string };
  cppUsingToolchains?: () => ToolchainId[];
  lockState?: () => BenchLockState;
  /** `--no-lock`: the sanctioned way past the concurrent-run verdict, and the reason the verdict
   *  can afford to be strict. See `concurrentRunRefusal`. */
  ignoreLock?: boolean;
}

/** Which of the cpp-preprocessing toolchains are actually installed here. */
export function cppUsingToolchains(): ToolchainId[] {
  return availableToolchains()
    .map((t) => t.id)
    .filter((id) => CPP_TOOLCHAINS.includes(id));
}

/** Every start-time verdict. Returned rather than exited on, so the caller owns the exit code and
 *  the test owns neither. Each verdict is gated on ITS OWN predicate — see the header:
 *  `runTakesTheBenchLock` for the concurrent-run register, `runIsWholeTier` for git,
 *  `runUsesHostCpp` for the probe — so a scoped real run is checked for `cpp` and not for dirt,
 *  and a whole synthetic run the other way round.
 *
 *  The concurrent-run verdict lives HERE and not in `cli.ts` because it is the same shape as the
 *  other two — a start-time refusal, gated on a predicate over the same options — and this file's
 *  first sentence is its charter. `cli.ts` keeps only the WRITE (`acquireBenchLock`), which is not
 *  a verdict.
 *
 *  A WARNING and not a refusal when `cpp` is broken but no toolchain that uses it is installed:
 *  this harness's standing policy is that a missing tool SKIPS its rows (`toolchains.ts` →
 *  `runner.ts`: `SKIP <id>: toolchain unavailable`), so refusing a whole agbcc run on a GBA-only
 *  macOS checkout — where the default `cpp` IS Apple clang and every ido/kmc/gcc272 row would have
 *  skipped — would be this check inventing a policy stricter than the run it guards. Availability
 *  is consulted ONLY on the failing path: `availableToolchains()` probes docker and costs several
 *  times what `probeCpp` does, and a `cpp` that works never pays it. */
export function preflightRefusals(
  opts: PreflightOptions,
  deps: PreflightDeps = {},
): { refusals: string[]; warnings: string[] } {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  // First, because it costs a readdir where the next verdict costs a `git status` and the one
  // after it a compile — and because it is the verdict whose answer changes while you read it.
  if (runTakesTheBenchLock(opts) && deps.ignoreLock !== true) {
    const concurrent = concurrentRunRefusal((deps.lockState ?? readBenchLock)(), {
      tiers: opts.tiers,
      whole: runIsWholeTier(opts),
      root: repoRoot,
    });
    if (concurrent !== undefined) {
      refusals.push(concurrent);
    }
  }
  if (runIsWholeTier(opts)) {
    const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' });
    // git being unreadable is not a dirty tree, and the run-time stamp already reports that case as
    // dirty on its own. Refusing here on it would block a bench run in a tarball checkout.
    const dirty = status.status === 0 ? dirtyTreeRefusal(codeDirtyPaths(status.stdout)) : undefined;
    if (dirty !== undefined) {
      refusals.push(dirty);
    }
  }
  if (!runUsesHostCpp(opts)) {
    return { refusals, warnings };
  }
  const cpp = (deps.probe ?? probeCpp)();
  const cppMsg = cppRefusal(cpp);
  if (cppMsg !== undefined) {
    const users = (deps.cppUsingToolchains ?? cppUsingToolchains)();
    if (users.length > 0) {
      refusals.push(cppMsg);
    } else {
      warnings.push(
        [
          `bench run WARNING: \`${CPP}\` does not preprocess to \`-o\` (${cpp.how}). Not refused —`,
          `none of ${CPP_TOOLCHAINS.join(' / ')} is installed here, so every row that would have used`,
          'it is going to SKIP anyway. Install one of them and this becomes a refusal.',
        ].join('\n'),
      );
    }
  }
  return { refusals, warnings };
}
