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

/** The gitignored name a local env/scratch file is expected to take, quoted in the refusal. One
 *  sanctioned name beats an escape hatch: without it every round that trips this refusal invents
 *  its own way past it, and lands back on the 39-minute loss at `bench:merge`. */
export const LOCAL_ENV_FILE = '.envrc.local';

/** How many dirty paths the refusal lists before it summarises the rest. */
const PATHS_SHOWN = 20;

/** The toolchains whose CANDIDATE compiles preprocess with the host `cpp` (`compile/{ido,kmc,
 *  gcc272}.ts`). agbcc uses `arm-none-eabi-cpp` and mwcc/ppc preprocess inside docker, so a broken
 *  `cpp` costs them nothing. */
const CPP_TOOLCHAINS: readonly ToolchainId[] = ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'];

export interface PreflightOptions {
  tiers: Tier[];
  only?: string;
  project?: string;
  toolchain?: string;
  shard?: string;
}

/** Will this invocation rewrite at least one tier file WHOLE? That — not "is it slow" — is the
 *  question, because a tier file written whole is what `merge` publishes and what the provenance
 *  refusal is about. A shard CHILD is exempt: the parent that spawned it has already run this,
 *  and eight children re-answering it would print the same refusal eight times. */
export function runIsWholeTier(opts: PreflightOptions): boolean {
  return opts.shard === undefined && opts.tiers.some((tier) => !tierIsFiltered(tier, opts));
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
    'publish them — 39 minutes from now. Commit the change, or, if this is a local env/scratch',
    `file, name it \`${LOCAL_ENV_FILE}\` (gitignored) or add it to \`$(git rev-parse --git-path info/exclude)\`.`,
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
    'The ido, kmc and gcc272 rows would all fail to compile and the run would still report `✓` on',
    'both tiers and exit 0. Put the GNU shim first on PATH, or set ASMLIFT_CPP, then re-run:',
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
 *  the exit code and the test owns neither.
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
  if (!runIsWholeTier(opts)) {
    return { refusals: [], warnings: [] };
  }
  const status = spawnSync('git', ['-C', deps.repoRoot ?? REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  // git being unreadable is not a dirty tree, and the run-time stamp already reports that case as
  // dirty on its own. Refusing here on it would block a bench run in a tarball checkout.
  const dirty = status.status === 0 ? dirtyTreeRefusal(codeDirtyPaths(status.stdout)) : undefined;
  const cpp = (deps.probe ?? probeCpp)();
  const cppMsg = cppRefusal(cpp);
  const refusals = dirty === undefined ? [] : [dirty];
  const warnings: string[] = [];
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
