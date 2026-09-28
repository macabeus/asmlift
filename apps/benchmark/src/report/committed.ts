// Reading the COMMITTED results.json, for the three gates that compare a fresh run against it
// (stale-check, regression, diff). One place, because the ref they read is part of the answer:
// on a branch that has already committed its own artifact, `HEAD` compares the branch against
// ITSELF and every gate passes vacuously — which is why the real check is against the branch
// POINT (`origin/main`), and why every gate here takes a `--base`.
import { type BenchOutput, type FunctionResult, type Identifiable, joinArtifacts } from '@asmlift/bench-schema';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, RESULTS_DIR } from '../config';

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

/** The commit HEAD and `ref` forked from, abbreviated; `undefined` when git cannot say. */
export const mergeBaseSha = (ref: string): string | undefined => {
  const full = git('merge-base', 'HEAD', `${ref}^{commit}`);
  return full === undefined ? undefined : shortSha(full);
};

/** What a comparison gate compared against, for the line it prints before its verdict. `origin/main`
 *  is a different commit on every machine and after every fetch, so the base is named by sha. When
 *  HEAD does not contain the base, the warning says where the branch forked: every row the base's
 *  newer commits moved then reads as this branch's change. A notice, not a refusal — the reader
 *  decides whether to rebase first. Pure over the git facts, which `gitFacts` supplies. */
export function baseNotice(a: {
  base: string;
  generatedAt: string;
  sha?: string;
  contains?: boolean;
  mergeBase?: string;
}): { named: string; warning?: string } {
  const named = `base ${a.base}${a.sha ? ` = ${a.sha}` : ''} (artifact generated ${a.generatedAt})`;
  if (a.base === 'HEAD' || a.contains !== false) {
    return { named };
  }
  return {
    named,
    warning:
      `WARNING: HEAD does not contain ${a.base} (the branch forked at ${a.mergeBase ?? 'an unknown commit'}) — ` +
      `everything ${a.base} gained since reads below as a change this branch made, or is hidden by one. ` +
      `Rebase, re-run, then compare again.`,
  };
}

/** The git facts `baseNotice` reads, for `ref` in this checkout. */
export const gitFacts = (ref: string): { sha?: string; contains?: boolean; mergeBase?: string } => ({
  sha: shortSha(ref),
  contains: headContains(ref),
  mergeBase: mergeBaseSha(ref),
});

/** The artifact as of `ref` (a commit, tag or branch — `HEAD` by default).
 *
 *  AN EMPTY REF IS NOT A MISSING ONE, and git will not say so: `git show :<path>` with an empty
 *  left-hand side reads the staging INDEX, so an unguarded `--base=` compares against whatever is
 *  STAGED and prints a confident line about it — `bench fan --base=` answers `the artifact at
 *  records no candidate count … the series starts here` off the index. Every caller passes a ref
 *  straight from a `--base` flag, so the guard belongs at the read. */
export function readCommitted(ref = 'HEAD'): BenchOutput {
  if (ref.trim() === '') {
    throw new Error(`empty --base ref: git reads the staging INDEX for it, which is not a base — name a commit`);
  }
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
 *  ONE PREDICATE, TWO CALLERS, deliberately. `diff.ts` asks it of the BASE side (`notRegenerated`,
 *  and its comment is the argument for why: the cheapest way to produce a green neutrality line
 *  must not be the one that compares a file with itself). The
 *  added-row sections of `diff` and `regression` need the same question asked of the SELF side —
 *  a branch that has already committed its artifact reads it straight back out of `HEAD` — and
 *  the way two copies of a predicate like this go wrong is that one of them stops being asked. */
export const sameRun = (a: BenchOutput, b: BenchOutput): boolean => a.meta.generatedAt === b.meta.generatedAt;

/** Every row keyed by id — the shape all three gates walk. */
export const byId = (o: BenchOutput): Map<string, FunctionResult> => new Map(o.results.map((r) => [r.id, r]));

/** This worktree's own `results.json`, read off disk rather than through git: the readers are the
 *  guards and price estimates a command prints before it spends anything, and a ref that will not
 *  resolve must not switch them off. `results` absent and `unreadable` absent means there is no
 *  artifact at all; `unreadable` means there is one that will not parse, which a caller must say
 *  out loud rather than read as "no artifact". */
export function readWorktreeArtifact(dir = RESULTS_DIR): {
  path: string;
  results?: FunctionResult[];
  unreadable?: string;
} {
  const path = join(dir, 'results.json');
  if (!existsSync(path)) {
    return { path };
  }
  try {
    const { results } = JSON.parse(readFileSync(path, 'utf8')) as BenchOutput;
    return Array.isArray(results)
      ? { path, results }
      : { path, unreadable: `${path} has no top-level \`results\` array` };
  } catch (e) {
    return { path, unreadable: `${path}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
}

/** Recorded rows keyed by the CURRENT dataset's row ids — joined by row identity (bench-schema
 *  `joinArtifacts`), never by the id the artifact happened to publish. A renamed row keeps its
 *  record, a row of another decompilation at the same address has none, and a real row the dataset
 *  no longer carries is dropped. Synthetic rows are keyed by id on both sides. */
export function rekeyToCurrent<R extends Identifiable>(
  recorded: readonly R[],
  current: readonly Identifiable[],
): Map<string, R> {
  const join = joinArtifacts(recorded, current);
  const currentId = new Map(current.map((r) => [join.headKey(r), r.id]));
  const out = new Map<string, R>();
  for (const r of recorded) {
    const id = r.tier === 'real' ? currentId.get(join.baseKey(r)) : r.id;
    if (id !== undefined) {
      out.set(id, r);
    }
  }
  return out;
}
