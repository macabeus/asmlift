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
// run that passes today still passes. It only refuses runs that REWRITE A TIER WHOLE — the
// `--only`/`--project`/`--toolchain` dev loop is the shape you run on a dirty tree on purpose, and
// its tier files are left unchanged (see `tierIsFiltered`).
//
// The `cpp` probe rides along for free and is NOT priced as a saving: its prose version ("spend one
// second on `which cpp` before spending 30 minutes") has been written down for four ship rounds and
// has not stopped anything. Its incident is a login shell resolving `cpp` to Apple clang, which
// ignores `-o`, writes the preprocessed text to stdout and exits 1 — 44 rows failed and the run
// reported itself successful with a `✓` on both tiers and exit 0. The probe is the failure itself,
// run on one line of C: it does not care which `cpp` is on PATH, only whether that one honours
// `-o`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CPP, REPO_ROOT } from '../config';
import { codeDirtyPaths } from '../provenance';
import { type Tier, tierIsFiltered } from './orchestrate';

/** The gitignored name a local env/scratch file is expected to take, quoted in the refusal. One
 *  sanctioned name beats an escape hatch: without it every round that trips this refusal invents
 *  its own way past it, and lands back on the 39-minute loss at `bench:merge`. */
export const LOCAL_ENV_FILE = '.envrc.local';

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
  return [
    `bench run REFUSED: the working tree's code differs from HEAD, in ${paths.length} path${paths.length === 1 ? '' : 's'}:`,
    ...paths.map((p) => `  ${p}`),
    '',
    'A full run against this tree produces numbers no commit holds, and `bench merge` refuses to',
    'publish them — 39 minutes from now. Commit the change, or, if this is a local env/scratch',
    `file, name it \`${LOCAL_ENV_FILE}\` (gitignored) or add it to \`$(git rev-parse --git-path info/exclude)\`.`,
    'A scoped run (--only/--project/--toolchain) is not refused: it leaves the tier files alone.',
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
export function probeCpp(): { ok: boolean; how: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-cpp-'));
  const cPath = join(dir, 'probe.c');
  const iPath = join(dir, 'probe.i');
  writeFileSync(cPath, 'int probe;\n');
  const r = spawnSync(CPP, ['-P', '-nostdinc', cPath, '-o', iPath], { encoding: 'utf8' });
  if (r.error) {
    return { ok: false, how: `cannot be run: ${r.error.message}` };
  }
  if (r.status !== 0) {
    return { ok: false, how: `exit ${r.status}: ${(r.stderr ?? '').trim().split('\n')[0]}` };
  }
  return existsSync(iPath) ? { ok: true, how: 'ok' } : { ok: false, how: 'exit 0 but wrote no output file' };
}

/** Every start-time refusal, in the order they cost: the git one first, because it is the one with
 *  4,688 s of measured incidents behind it. Returns the refusals rather than exiting, so the
 *  caller owns the exit code and the test owns neither. */
export function preflightRefusals(opts: PreflightOptions): string[] {
  if (!runIsWholeTier(opts)) {
    return [];
  }
  const status = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  // git being unreadable is not a dirty tree, and the run-time stamp already reports that case as
  // dirty on its own. Refusing here on it would block a bench run in a tarball checkout.
  const dirty = status.status === 0 ? dirtyTreeRefusal(codeDirtyPaths(status.stdout)) : undefined;
  return [dirty, cppRefusal(probeCpp())].filter((r) => r !== undefined);
}
