// `bench repro` is the vehicle both function briefs now send a round to, and what is pinned here
// is every way it can be WRONG WITHOUT ERRORING — because the block it replaces failed exactly
// that way. A `node -e … > repro.sh` with one character wrong in the row id left a 0-byte script
// that `bash` then ran to exit 0 with empty output, three lines after the page taught the reader
// that an empty `grep '^WARN'` means the setup is right.
//
// So: no row and an ambiguous needle must both be a message and a nonzero code; the script must
// carry the row's own inputs with this machine's paths substituted; and the out dir must be one
// `bench run`'s dirty-tree preflight tolerates — the previous recipe's `--out "$PWD"` in the repo
// root left seven untracked files that the preflight refuses whole rounds for.
import type { BenchOutput } from '@asmlift/bench-schema';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../src/config';
import { repro, reproDirFor } from '../src/report/repro';
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

  test('carries the row s own input asm and the built-bin invocation, with no placeholder left', async () => {
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

  test('the default out dir is one a bench run will not refuse the round for', () => {
    // `--out "$PWD"` at the repo root was the old recipe, and it leaves out.c/decomp.yaml/
    // proto.json untracked there — which `run/preflight.ts` then refuses a whole TIER over,
    // 39 minutes into the gate agent's run, naming files the page told the round to make.
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
