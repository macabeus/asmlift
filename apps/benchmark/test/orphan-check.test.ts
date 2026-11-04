// scripts/orphan-check.sh: the parallel run's pass check calls it to list processes that outlived
// whoever started them and still work in an asmlift tree. Incident: a `python3 -` left by a killed
// task spun one core for eight days under every bench, and nothing looked.
//
// What is pinned here: which processes it reports (age AND place, a removed lane's `(deleted)`
// cwd included), that it reports through its exit status, and that it never signals what it finds.
// The age bar is faked with --table (a prepared process table), so no test waits a day; the live
// cases use --hours 0 against a real child process.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'orphan-check.sh');
const DAY = 86400;
const scratch = mkdtempSync(join(tmpdir(), 'orphan-check-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(args: string[], cwd = scratch) {
  const r = spawnSync('sh', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

function table(
  name: string,
  rows: [pid: number, age: number, cwd: string, files: string[], cmd: string, tty?: string][],
) {
  const path = join(scratch, `${name}.tsv`);
  writeFileSync(
    path,
    rows.map(([p, a, c, f, cmd, tty]) => [p, a, c, f.join('|'), cmd, tty ?? '?'].join('\t') + '\n').join(''),
  );
  return path;
}

describe('orphan-check over a prepared process table', () => {
  const root = join(scratch, 'board');
  mkdirSync(root, { recursive: true });

  it('reports an old process working under a root, and only that one', () => {
    const t = table('basic', [
      [101, 8 * DAY, join(root, 'lane'), [], 'python3 -'],
      [102, 2 * 3600, join(root, 'lane'), [], 'young'],
      [103, 9 * DAY, '/somewhere/else', [], 'unrelated'],
      [104, 3 * DAY, `${root}x`, [], 'a sibling name, not under the root'],
    ]);
    const { status, out } = run(['--root', root, '--table', t]);
    expect(status).toBe(1);
    expect(out).toContain('ORPHAN pid=101 age=8d00h tty=none');
    expect(out).toContain('via=cwd cmd=python3 -');
    expect(out).not.toMatch(/pid=10[234]\b/);
    expect(out).toContain('1 process(es) older than 24h');
  });

  it('reports a process whose cwd is elsewhere but holds a file open under a root', () => {
    const t = table('file', [[201, 2 * DAY, '/', ['/dev/null', join(root, 'gates.log')], 'tee', 'pts/4']]);
    const { status, out } = run(['--root', root, '--table', t]);
    expect(status).toBe(1);
    expect(out).toContain(`pid=201 age=2d00h tty=pts/4 cwd=/ via=file ${join(root, 'gates.log')}`);
  });

  it('reads a removed directory as still under its root (Linux shows `<path> (deleted)`)', () => {
    const t = table('deleted', [[301, 5 * DAY, `${join(root, 'gone')} (deleted)`, [], 'node']]);
    expect(run(['--root', root, '--table', t]).out).toContain('pid=301');
  });

  it('honours --hours', () => {
    const t = table('hours', [[401, 3 * 3600, root, [], 'x']]);
    expect(run(['--root', root, '--table', t]).status).toBe(0);
    expect(run(['--root', root, '--hours', '2', '--table', t]).status).toBe(1);
  });

  it('says OK with exit 0 when nothing qualifies', () => {
    const t = table('none', [[501, 9 * DAY, '/elsewhere', [], 'x']]);
    const { status, out } = run(['--root', root, '--table', t]);
    expect(status).toBe(0);
    expect(out).toContain('orphan-check: OK');
  });

  it('derives the checkout, its worktrees, `<checkout>-*` siblings and the scratchpad as roots', () => {
    const main = join(scratch, 'asm');
    mkdirSync(main);
    expect(spawnSync('git', ['init', '-q', main]).status).toBe(0);
    const slug = main.replaceAll('/', '-');
    const t = table('roots', [
      [601, 2 * DAY, join(main, 'packages'), [], 'in the checkout'],
      [602, 2 * DAY, `${main}-wt-old (deleted)`, [], 'a removed lane'],
      [603, 2 * DAY, `${main}other`, [], 'not a lane: no dash'],
      [604, 2 * DAY, `/tmp/claude-${process.getuid?.() ?? 0}/${slug}/x/scratchpad`, [], 'scratchpad'],
    ]);
    const { status, out } = run(['--repo', main, '--table', t]);
    expect(status).toBe(1);
    expect(out).toMatch(/pid=601\b/);
    expect(out).toMatch(/pid=602\b/);
    expect(out).not.toMatch(/pid=603\b/);
    expect(out).toMatch(/pid=604\b/);
  });

  it('refuses bad arguments with exit 2', () => {
    expect(run(['--hours', 'x', '--root', root]).status).toBe(2);
    expect(run(['--bogus', '1']).status).toBe(2);
  });
});

describe.runIf(process.platform === 'linux')('orphan-check on this host', () => {
  it('finds a live child by its cwd, a removed cwd included, and leaves it running', async () => {
    const root = join(scratch, 'live');
    const lane = join(root, 'lane');
    mkdirSync(lane, { recursive: true });
    const child = spawn('sleep', ['60'], { cwd: lane, stdio: 'ignore' });
    try {
      await new Promise((r) => child.once('spawn', r));
      rmSync(lane, { recursive: true });
      const { status, out } = run(['--root', root, '--hours', '0']);
      expect(status).toBe(1);
      expect(out).toContain(`pid=${child.pid} `);
      expect(out).toContain(`cwd=${lane} (deleted)`);
      // never kills: the child is still there to be signalled by us
      expect(child.exitCode).toBeNull();
      expect(process.kill(child.pid!, 0)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('does not report its own caller chain', () => {
    // vitest's worker is an ancestor of the script's shell and works in the repo; at --hours 0
    // it would be reported if ancestors were not skipped.
    const repo = join(import.meta.dirname, '..', '..', '..');
    const { status, out } = run(['--root', process.cwd(), '--root', repo, '--hours', '0']);
    expect([0, 1]).toContain(status);
    expect(out).not.toContain(`pid=${process.pid} `);
  });
});
