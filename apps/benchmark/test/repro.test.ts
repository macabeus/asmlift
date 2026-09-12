// `bench repro` is the vehicle both function briefs send a round to, and what is pinned here is
// every way it can be WRONG WITHOUT ERRORING — the failure mode a hand-run recipe has: a row id
// with one character wrong leaves a 0-byte script that `bash` runs to exit 0 with empty output,
// which reads as "no warnings, so the setup is right".
//
// So: no row and an ambiguous needle must both be a message and a nonzero code; the script must
// carry the row's own inputs with this machine's paths substituted; and the out dir must be one
// `bench run`'s dirty-tree preflight tolerates.
import type { BenchOutput } from '@asmlift/bench-schema';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../src/config';
import { repro, reproDirFor, setupRefusal } from '../src/report/repro';
import { LOCAL_SCRATCH_DIR } from '../src/run/preflight';

const results = (JSON.parse(readFileSync(join(import.meta.dirname, '../results/results.json'), 'utf8')) as BenchOutput)
  .results;

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bench-repro-test-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Capture, so an assertion can be about what the reader is TOLD, not only the exit code. */
function run(needle: string, opts: Parameters<typeof repro>[1] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return repro(
    needle,
    opts,
    (s) => out.push(s),
    (s) => err.push(s),
  ).then((code) => ({
    code,
    out: out.join('\n'),
    err: err.join('\n'),
  }));
}

describe('bench repro — the ways it can find no row', () => {
  test('a mistyped id exits 1 and names BOTH causes, rather than printing nothing', async () => {
    const r = await run('kleod:StrCpyy:agbcc', { out: scratch() });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no row for');
    // both causes: a typo, and a target that has no row because it is measured outside the harness
    expect(r.err).toMatch(/mistyped/);
    expect(r.err).toMatch(/outside the harness/);
    expect(r.out).toBe('');
  });

  test('a needle that selects many rows exits 1 listing them, rather than reproducing one at random', async () => {
    const r = await run('add', { out: scratch() });
    expect(r.code).toBe(1);
    expect(r.err).toContain('selects');
    expect(r.err).toContain('synthetic:add:agbcc');
  });

  test('an unknown --tool exits 2 rather than silently writing the asmlift script', async () => {
    const r = await run('kleod:StrCpy:agbcc', { out: scratch(), tool: 'asmlfit' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown --tool');
  });
});

describe('bench repro — the script it hands over', () => {
  const id = 'kleod:StrCpy:agbcc';
  const fn = results.find((r) => r.id === id)!;

  test("carries the row's own input asm and the built-bin invocation, with no placeholder left", async () => {
    const dir = scratch();
    const r = await run(id, { out: dir });
    expect(r.code).toBe(0);
    const script = readFileSync(join(dir, 'repro-asmlift.sh'), 'utf8');
    expect(script).toContain(fn.targetAsm.trimEnd());
    expect(script).toContain('bench target kleod:StrCpy:agbcc');
    expect(script).toContain('--score-against target.o');
    // materialize() filled the placeholders — an unfilled one is a script that cd's to /path/to
    expect(script).not.toContain("ASMLIFT_PATH='/path/to/asmlift'");
    expect(script).toContain(`ASMLIFT_PATH='${REPO_ROOT}'`);
    // and it says which row and what that row's published number is, so a reader who reproduces
    // a different one notices before quoting it
    expect(r.out).toContain(id);
    expect(r.out).toContain(`${fn.asmlift.score}/${fn.asmlift.maxScore}`);
  });

  test('--tool m2c writes the OTHER script, not the same one under a different name', async () => {
    const dir = scratch();
    expect(await run(id, { out: dir, tool: 'm2c' })).toMatchObject({ code: 0 });
    const script = readFileSync(join(dir, 'repro-m2c.sh'), 'utf8');
    expect(script).toContain('m2c.py');
    expect(script).not.toContain('--score-against');
    expect(existsSync(join(dir, 'repro-asmlift.sh'))).toBe(false);
  });

  test("--tool m2c states M2C's published figure, not asmlift's", async () => {
    // These differ on this row — asmlift 5/8, m2c 6/7 — so printing the asmlift one beside the
    // m2c script hands the reader the wrong thing to compare out.c against.
    const r = await run(id, { out: scratch(), tool: 'm2c' });
    expect(fn.m2c.score).not.toBe(fn.asmlift.score);
    expect(r.out).toContain(`m2c ${fn.m2c.outcome} ${fn.m2c.score}/${fn.m2c.maxScore} as published`);
    expect(r.out).not.toContain(`${fn.asmlift.score}/${fn.asmlift.maxScore}`);
    // and no symbol-map line: the map is asmlift's input, m2c's channel is the --context header
    expect(r.out).not.toContain('symbol map from');
  });

  test('the default out dir is one a bench run will not refuse the round for', () => {
    // The script's step 1 is `bench target … --out "$PWD"`, so run at the repo root it leaves
    // decomp.yaml/ctx.i/in.asm/proto.json untracked there — which `run/preflight.ts` refuses a
    // whole TIER over, ~39 minutes into a full run.
    // Asked of git, not of a regex over .gitignore: `codeDirtyPaths` cannot answer it, because
    // `git status --porcelain` never lists an ignored path in the first place — which is exactly
    // why the fix is an ignored directory and not a smarter predicate.
    const rel = relative(REPO_ROOT, reproDirFor('kleod:StrCpy:agbcc'));
    expect(rel.startsWith(LOCAL_SCRATCH_DIR)).toBe(true);
    const check = spawnSync('git', ['check-ignore', '-q', join(rel, 'out.c')], { cwd: REPO_ROOT });
    expect(check.status, `git check-ignore ${join(rel, 'out.c')}`).toBe(0);
  });

  test('the row id becomes ONE directory name — a `:` is not a path separator to fall through', () => {
    expect(reproDirFor('kleod:StrCpy:agbcc').endsWith(join('.local', 'repro', 'kleod_StrCpy_agbcc'))).toBe(true);
    // an id is harness-generated, but this composes a filesystem path out of one, so a separator
    // or a traversal in it must land in the name and not in the path
    expect(relative(join(REPO_ROOT, '.local', 'repro'), reproDirFor('a/../b:c:d'))).toBe('a_.._b_c_d');
  });
});

describe('bench repro — a broken MACHINE is not a non-matching row', () => {
  // The one fragile part of the diagnosis is a regex over a shell error string, and it was pinned
  // by nothing: the round that added it wrote 139 test lines about the command FILES and none about
  // this. Its comment also called the bin link "the one cause that is not the row", and the second
  // cause was the first thing a reviewer hit in a fresh worktree wired the documented way.
  test('names the missing CLI bin, whichever way the shell spells it', () => {
    for (const line of [
      'bash: /wt/node_modules/.bin/asmlift: No such file or directory',
      'bash: /wt/node_modules/.bin/asmlift: command not found',
      '/wt/repro.sh: line 40: /wt/node_modules/.bin/asmlift: cannot execute: required file not found',
    ]) {
      expect(setupRefusal(line), line).toMatch(/asmlift bin is missing/);
    }
  });

  test('names an uninstalled pinned toolchain, and names WHICH', () => {
    const msg = setupRefusal(
      "Error: cannot run '/private/tmp/transmuter/compilers/agbcc/agbcc' (ENOENT) — not installed, or its pinned-toolchain path is wrong",
    );
    expect(msg).toMatch(/not installed on this machine, not the row/);
    expect(msg).toContain('/private/tmp/transmuter/compilers/agbcc/agbcc');
  });

  test('says nothing about a run that merely did not match', () => {
    expect(setupRefusal('')).toBeUndefined();
    expect(setupRefusal('[ranked] 1 candidate(s) scored, 0 dropped, best unsigned: 5/8')).toBeUndefined();
    // the words are there but the shape is not: a comment quoting the recovery is not the failure
    expect(
      setupRefusal('# run `pnpm --filter @asmlift/cli build` if node_modules/.bin/asmlift is absent'),
    ).toBeUndefined();
  });
});
