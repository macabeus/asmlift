// Reading the COMMITTED results.json, for the three gates that compare a fresh run against it
// (stale-check, regression, diff). One place, because the ref they read is part of the answer:
// on a branch that has already committed its own artifact, `HEAD` compares the branch against
// ITSELF and every gate passes vacuously — which is why the real check is against the branch
// POINT (`origin/main`), and why every gate here takes a `--base`.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from '../config';

export const RESULTS_PATH = 'apps/benchmark/results/results.json';

/** `git …` in the repo, or `undefined` when git declines to answer. Used only for the provenance
 *  LINE a gate prints about itself, so a question git cannot answer must degrade to "not shown",
 *  never to a thrown gate. */
function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** The sha `ref` names in THIS checkout, abbreviated. A gate that reports its base by NAME has
 *  reported nothing checkable: `origin/main` is a different commit on every machine and after
 *  every fetch. */
export const shortSha = (ref: string): string | undefined => git('rev-parse', '--short', `${ref}^{commit}`);

/** Does HEAD contain `ref`? `undefined` when git cannot say. A branch compared against a base it
 *  has not merged in is credited with everything the base gained meanwhile. */
export function headContains(ref: string): boolean | undefined {
  if (git('rev-parse', '--verify', `${ref}^{commit}`) === undefined) {
    return undefined;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The artifact as of `ref` (a commit, tag or branch — `HEAD` by default). */
export function readCommitted(ref = 'HEAD'): BenchOutput {
  let raw: string;
  try {
    // execFile, not a shell string: `ref` comes straight from `--base`, and a shell would have to
    // be trusted with whatever it contains — a ref with a space, a `$` or a `;` in it would
    // otherwise be re-split, expanded or run rather than read.
    raw = execFileSync('git', ['show', `${ref}:${RESULTS_PATH}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256e6,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(
      `cannot read ${RESULTS_PATH} at '${ref}' — fetch the ref first (git fetch origin) or pass a --base that exists: ${
        e instanceof Error ? e.message.split('\n')[0] : e
      }`,
    );
  }
  return JSON.parse(raw) as BenchOutput;
}

/** Scratch-dir names and machine temp paths are run-local noise, not measurement: a cold run
 *  re-mints them inside embedded asm comments, so comparing them raw reports a change that no
 *  reader could act on. */
export const scrub = (s: string): string =>
  s
    .replace(/(?:asmlift|bench)-[A-Za-z0-9-]+-[A-Za-z0-9]{6}/g, '<scratch>')
    .replace(/\/host-tmp\S*|\/var\/folders\S*|\/tmp\/\S*/g, '<tmp>');

/** Do two artifacts come out of the SAME merge? `bench merge` re-mints `meta.generatedAt` from
 *  `new Date()` on every run (`run/runner.ts` benchMeta), so equal stamps mean no merge has run
 *  between them — they are the same bytes, and any comparison of the two measures nothing.
 *
 *  ONE PREDICATE, TWO CALLERS, deliberately. `diff.ts` has asked this of the BASE side since the
 *  gate existed (`notRegenerated`, and its comment is the argument for why: the cheapest way to
 *  produce a green neutrality line must not be the one that compares a file with itself). The
 *  added-row sections of `diff` and `regression` need the same question asked of the SELF side —
 *  a branch that has already committed its artifact reads it straight back out of `HEAD` — and
 *  the way two copies of a predicate like this go wrong is that one of them stops being asked. */
export const sameRun = (a: BenchOutput, b: BenchOutput): boolean => a.meta.generatedAt === b.meta.generatedAt;

/** Every row keyed by id — the shape all three gates walk. */
export const byId = (o: BenchOutput): Map<string, FunctionResult> => new Map(o.results.map((r) => [r.id, r]));
