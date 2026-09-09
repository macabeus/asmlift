// The marker that says a run is in flight, and the two refusals read off it.
//
// Every assertion here runs against a THROWAWAY root. Deliberately: the real repo root's marker
// belongs to whatever bench is running in this worktree, and a test that wrote one — or removed
// one — would be the mid-run tree mutation this file exists to prevent, from inside the suite the
// briefs tell you to run beside a bench.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../src/config';
import {
  BENCH_LOCK_FILE,
  acquireBenchLock,
  benchInFlightRefusal,
  benchLockPath,
  benchLockStatus,
  concurrentRunRefusal,
  readBenchLock,
  releaseBenchLock,
} from '../src/run/lock';

function throwawayRoot(): string {
  return mkdtempSync(join(tmpdir(), 'asmlift-lock-'));
}

/** A pid that certainly names no process: one we watched exit. Better than a magic number, which
 *  a busy machine can hand to something real. */
function deadPid(): number {
  const r = spawnSync('sh', ['-c', 'echo $$']);
  return Number(r.stdout.toString().trim());
}

function writeMarker(root: string, record: unknown): void {
  writeFileSync(benchLockPath(root), typeof record === 'string' ? record : JSON.stringify(record));
}

describe('reading the marker', () => {
  test('no marker is a free worktree', () => {
    expect(readBenchLock(throwawayRoot()).state).toBe('free');
  });

  test('a marker naming a LIVE process is held', () => {
    const root = throwawayRoot();
    writeMarker(root, { pid: process.pid, startedAt: new Date().toISOString(), command: 'bench run' });
    const state = readBenchLock(root);
    expect(state.state).toBe('held');
    expect(state.state === 'held' && state.record.pid).toBe(process.pid);
  });

  test('a marker naming a DEAD process is stale — a SIGKILLed run must not block the next round', () => {
    const root = throwawayRoot();
    const pid = deadPid();
    writeMarker(root, { pid, startedAt: new Date().toISOString(), command: 'bench run' });
    const state = readBenchLock(root);
    expect(state.state).toBe('stale');
    expect(state.state === 'stale' && state.why).toContain(`pid ${pid}`);
  });

  test('a marker that names no pid at all is stale — nobody could ever clear it by waiting', () => {
    const root = throwawayRoot();
    writeMarker(root, '{ half-writ');
    expect(readBenchLock(root).state).toBe('stale');
    writeMarker(root, { startedAt: 'now' });
    expect(readBenchLock(root).state).toBe('stale');
  });
});

describe('taking and releasing it', () => {
  test('acquire records this pid, the time and the argv; release removes it', () => {
    const root = throwawayRoot();
    const path = acquireBenchLock('bench run --tier real', root);
    const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; startedAt: string; command: string };
    expect(record.pid).toBe(process.pid);
    expect(record.command).toBe('bench run --tier real');
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
    expect(readBenchLock(root).state).toBe('held');
    releaseBenchLock(root);
    expect(existsSync(path)).toBe(false);
  });

  test('release leaves SOMEONE ELSE’s marker alone — clearing a live run would be the whole bug', () => {
    const root = throwawayRoot();
    writeMarker(root, { pid: process.pid + 1, startedAt: new Date().toISOString(), command: 'bench run' });
    releaseBenchLock(root);
    expect(existsSync(benchLockPath(root))).toBe(true);
  });

  test('releasing when there is no marker is not an error', () => {
    expect(() => releaseBenchLock(throwawayRoot())).not.toThrow();
  });
});

describe('what a tree-editing phase is told', () => {
  test('a held worktree refuses, naming the marker, the pid and the sticky sampler', () => {
    const root = throwawayRoot();
    writeMarker(root, { pid: process.pid, startedAt: new Date().toISOString(), command: 'bench run' });
    const msg = benchInFlightRefusal(readBenchLock(root));
    expect(msg).toBeDefined();
    expect(msg).toContain(BENCH_LOCK_FILE);
    expect(msg).toContain(`pid ${process.pid}`);
    expect(msg).toMatch(/STICKY/);
  });

  test('a free or stale worktree does not — the phase proceeds', () => {
    const free = throwawayRoot();
    expect(benchInFlightRefusal(readBenchLock(free))).toBeUndefined();
    const stale = throwawayRoot();
    writeMarker(stale, { pid: deadPid(), startedAt: new Date().toISOString(), command: 'bench run' });
    expect(benchInFlightRefusal(readBenchLock(stale))).toBeUndefined();
  });

  test('`bench lock` exits 1 while a run is in flight and 0 otherwise', () => {
    const held = throwawayRoot();
    writeMarker(held, { pid: process.pid, startedAt: new Date().toISOString(), command: 'bench run' });
    expect(benchLockStatus(held)).toBe(1);
    expect(benchLockStatus(throwawayRoot())).toBe(0);
    const stale = throwawayRoot();
    writeMarker(stale, { pid: deadPid(), startedAt: new Date().toISOString(), command: 'bench run' });
    expect(benchLockStatus(stale)).toBe(0);
  });
});

describe('what a SECOND bench run is told', () => {
  test('it refuses, and says what two runs do to one tier file', () => {
    const root = throwawayRoot();
    writeMarker(root, { pid: process.pid, startedAt: new Date().toISOString(), command: 'bench run' });
    const msg = concurrentRunRefusal(readBenchLock(root));
    expect(msg).toContain('bench run REFUSED');
    expect(msg).toContain('results/<tier>.json');
    expect(concurrentRunRefusal(readBenchLock(throwawayRoot()))).toBeUndefined();
  });

  test('a STALE marker does not refuse it — the next run overwrites what a SIGKILL left', () => {
    const root = throwawayRoot();
    writeMarker(root, { pid: deadPid(), startedAt: new Date().toISOString(), command: 'bench run' });
    expect(concurrentRunRefusal(readBenchLock(root))).toBeUndefined();
    acquireBenchLock('bench run', root);
    const state = readBenchLock(root);
    expect(state.state === 'held' && state.record.pid).toBe(process.pid);
    releaseBenchLock(root);
  });
});

describe('the marker is invisible to git', () => {
  // Load-bearing rather than tidy: an untracked file at the repo root is what `preflight.ts`
  // refuses to start on and what `provenance.ts` stamps a run dirty for, so a marker git can see
  // causes the loss it exists to prevent.
  const ignored = (path: string) =>
    spawnSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', path], { encoding: 'utf8' }).status === 0;

  test('the repo-root marker is gitignored', () => {
    expect(ignored(BENCH_LOCK_FILE)).toBe(true);
  });

  test('and the pattern is ANCHORED — it hides nothing of that name deeper in the tree', () => {
    expect(ignored(join('apps', 'benchmark', BENCH_LOCK_FILE))).toBe(false);
  });
});

describe('the CLI is wired to it', () => {
  // The dispatch lines themselves: `benchLockStatus`/`acquireBenchLock` are tested above against a
  // throwaway root, but nothing else notices if `cli.ts` stops calling them.
  const cli = readFileSync(join(REPO_ROOT, 'apps', 'benchmark', 'src', 'cli.ts'), 'utf8');

  test('`bench run` takes the marker, and refuses when another run holds it', () => {
    const runCase = cli.slice(cli.indexOf("case 'run': {"), cli.indexOf("case 'lock': {"));
    expect(runCase).toContain('acquireBenchLock(');
    expect(runCase).toContain('concurrentRunRefusal(');
    // A shard CHILD must take nothing: eight of them clear the parent's marker on first exit.
    expect(runCase).toContain('isShardChild(');
  });

  test('`bench lock` is a subcommand and is listed in the usage line', () => {
    expect(cli).toContain("case 'lock': {");
    expect(cli).toMatch(/usage: bench <run\|lock\|/);
  });
});
