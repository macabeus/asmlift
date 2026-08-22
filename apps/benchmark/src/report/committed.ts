// Reading the COMMITTED results.json, for the three gates that compare a fresh run against it
// (stale-check, regression, diff). One place, because the ref they read is part of the answer:
// on a branch that has already committed its own artifact, `HEAD` compares the branch against
// ITSELF and every gate passes vacuously — which is why the real check is against the branch
// POINT (`origin/main`), and why every gate here takes a `--base`.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from '../config';

export const RESULTS_PATH = 'apps/benchmark/results/results.json';

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

/** Every row keyed by id — the shape all three gates walk. */
export const byId = (o: BenchOutput): Map<string, FunctionResult> => new Map(o.results.map((r) => [r.id, r]));
