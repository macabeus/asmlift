// What a full `bench run` is checked for BEFORE it spends half an hour, as opposed to what it is
// checked for after.
//
// `provenance.ts` samples the tree DURING the run and `report/merge.ts` refuses to merge a tier
// whose sample came back dirty. That pair is correct and stays exactly as it is — a mutation that
// lands mid-run is invisible to anything sampled at the start, and a tree dirtied at second 400 is
// a real incident this repo has had. But it makes the loss maximal for the one case that was
// already decidable at second 0: four full runs were discarded across recent rounds, and two of
// them (2,329.8 s and 2,358.5 s) were a single UNTRACKED ENV FILE — `.envrc.probe`, `envrc.sh` —
// sitting in a worktree the whole time. `merge` said so, correctly, 39 minutes late.
//
// So this is the same rule asked at the start. It refuses strictly LESS than `merge` does: every
// tree it rejects is one whose run stamp would come back dirty and be rejected there anyway, so a
// run that passes today still passes. It only refuses runs that REWRITE A TIER WHOLE — the scoped
// dev loop is the shape you run on a dirty tree on purpose, and refusing it would get this whole
// check traded away inside one round.
//
// "WHOLE" is the exact word. A scoped run does NOT leave its tier file alone: `cli.ts` writes
// `results/<tier>.json` — the canonical file `merge` publishes — holding only the selected rows
// (measured: `--tier synthetic --only add --toolchain agbcc --serial` wrote an 11-row
// `synthetic.json`), and `runner.ts:75-81` records the incident where that file came back with
// `results: []`. What makes the scoped loop safe to run dirty is that `bench:merge` still refuses
// the tier at the end, not that nothing was written. Say the true thing here: the reader of this
// refusal is deciding whether to commit or to route around it.
//
// TWO LAWS, TWO PREDICATES. `runIsWholeTier` asks "does this invocation rewrite a tier file
// whole", which is the git question and only the git question. The `cpp` question is a different
// one — "will this invocation preprocess anything with the host `cpp`" — and keying it off
// whole-tier-ness got it wrong in BOTH directions (measured, both on this branch before the fix):
// a whole `--tier synthetic` run was REFUSED under a broken `cpp` that six synthetic ido rows then
// compiled and scored under, and `--tier real --only <sym>` — the shape Phase 3 of
// `match-function.md` and Phase 6 of `attribute-function.md` both prescribe — got no verdict at
// all while turning a `diff:27/32` row into `noncompile(1)` at exit 0. The scoped loop is where
// TRAP 6 actually lives, so it is the last place the probe may be silent. `runUsesHostCpp` is the
// right axis: every `CPP` call site in `compile/{ido,kmc,gcc272}.ts` sits inside the `*Real`
// export, and `compile/real.ts` is their only consumer, so the tier alone decides it. Note
// `--toolchain` does NOT scope the real tier (`cases/real.ts` takes only `project`/`only`), so it
// cannot narrow this question either.
//
// The `cpp` probe rides along for free and is NOT priced as a saving: its prose version ("spend one
// second on `which cpp` before spending 30 minutes") has been written down for four ship rounds and
// has not stopped anything. Its incident is a login shell resolving `cpp` to Apple clang, which
// ignores `-o`, writes the preprocessed text to stdout and exits 1 — 44 rows failed and the run
// reported itself successful with a `✓` on both tiers and exit 0. The probe is the failure itself,
// run on one line of C: it does not care which `cpp` is on PATH, only whether that one honours
// `-o`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CPP_PREPROCESS_FLAGS } from '../compile/util';
import { CPP, REPO_ROOT } from '../config';
import { codeDirtyPaths } from '../provenance';
import { type ToolchainId, availableToolchains } from '../toolchains';
import { type Tier, tierIsFiltered } from './orchestrate';

/** The gitignored name a local env file is expected to take, quoted in the refusal. One sanctioned
 *  name beats an escape hatch: without it every round that trips this refusal invents its own way
 *  past it, and lands back on the 39-minute loss at `bench:merge`. */
export const LOCAL_ENV_FILE = '.envrc.local';

/** ...and the gitignored directory for everything else local. Named here rather than
 *  `$(git rev-parse --git-path info/exclude)` because that path, from any worktree, is the MAIN
 *  checkout's file — it outlives the worktree that appended to it and nothing prunes it (measured:
 *  113 lines, 24 unique patterns, 40 copies of one). A directory is scoped and disposable. */
export const LOCAL_SCRATCH_DIR = '.local/';

/** How many dirty paths the refusal lists before it summarises the rest. */
const PATHS_SHOWN = 20;

/** The toolchains whose REAL-TIER candidate compiles preprocess with the host `cpp`
 *  (`compile/{ido,kmc,gcc272}.ts`, all three inside their `*Real` export). agbcc uses
 *  `arm-none-eabi-cpp` and mwcc/ppc preprocess inside docker, so a broken `cpp` costs them
 *  nothing — and NO synthetic row preprocesses at all, which is the tier qualifier this comment
 *  and the rule below were both missing. Hand-maintained, so `preflight.test.ts` derives the same set
 *  by scanning `compile/` and `REAL_COMPILERS`, and fails if a rung added later diverges from it. */
export const CPP_TOOLCHAINS: readonly ToolchainId[] = ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'];

export interface PreflightOptions {
  tiers: Tier[];
  only?: string;
  project?: string;
  toolchain?: string;
  shard?: string;
  serial?: boolean;
}

/** A shard CHILD, exempt from BOTH verdicts: the parent that spawned it has already answered them
 *  once, and eight children re-answering would print the same refusal eight times. `--shard` alone
 *  is NOT that child — `cli.ts`'s fan-out branch ignores it and runs the tier whole — so the test
 *  is `--shard` AND `--serial`, which is exactly how `orchestrate.ts` spawns one
 *  (`run --serial --tier X --shard i/N`). `cli.ts` rejects the other combination outright. */
function isShardChild(opts: PreflightOptions): boolean {
  return opts.shard !== undefined && opts.serial === true;
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
 *  all — so a one-row `--only` run is checked exactly like a whole one. It is cheaper than
 *  whole-tier-ness too: a synthetic-only run now pays neither the 42 ms probe nor, on a broken
 *  `cpp`, the 274 ms toolchain scan. */
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
  // them all scrolls the three actionable sentences off the reader's screen — which is where the
  // reader decides whether to commit or to invent a way around this.
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
    'That is Apple clang answering to `cpp` — a login shell puts /usr/bin ahead of ~/.local/bin.',
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
}

/** Which of the cpp-preprocessing toolchains are actually installed here. */
export function cppUsingToolchains(): ToolchainId[] {
  return availableToolchains()
    .map((t) => t.id)
    .filter((id) => CPP_TOOLCHAINS.includes(id));
}

/** Every start-time verdict, in the order they cost: the git one first, because it is the one with
 *  4,688 s of measured incidents behind it. Returns them rather than exiting, so the caller owns
 *  the exit code and the test owns neither. Each verdict is gated on ITS OWN predicate — see the
 *  header: `runIsWholeTier` for git, `runUsesHostCpp` for the probe — so a scoped real run is
 *  checked for `cpp` and not for dirt, and a whole synthetic run the other way round.
 *
 *  A WARNING and not a refusal when `cpp` is broken but no toolchain that uses it is installed:
 *  this harness's standing policy is that a missing tool SKIPS its rows (`toolchains.ts` →
 *  `runner.ts`: `SKIP <id>: toolchain unavailable`), so refusing a whole agbcc run on a GBA-only
 *  macOS checkout — where the default `cpp` IS Apple clang and every ido/kmc/gcc272 row would have
 *  skipped — would be this check inventing a policy stricter than the run it guards. Availability
 *  is consulted ONLY on the failing path: `availableToolchains()` costs 274 ms here (it probes
 *  docker) against `probeCpp`'s 42 ms, and a `cpp` that works never pays it. */
export function preflightRefusals(
  opts: PreflightOptions,
  deps: PreflightDeps = {},
): { refusals: string[]; warnings: string[] } {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (runIsWholeTier(opts)) {
    const status = spawnSync('git', ['-C', deps.repoRoot ?? REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
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
