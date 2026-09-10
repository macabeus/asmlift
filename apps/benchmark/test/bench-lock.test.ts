// The marker that says a run is in flight, and the two refusals read off it.
//
// Every assertion here runs against a THROWAWAY root. Deliberately: the real repo root's marker
// belongs to whatever bench is running in this worktree, and a test that wrote one — or removed
// one — would be the mid-run tree mutation this file exists to prevent, from inside the suite the
// briefs tell you to run beside a bench.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../src/config';
import {
  BENCH_LOCK_FILE,
  type BenchLockRecord,
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

/** A pid that certainly names no process: one we watched exit, CONFIRMED gone before we hand it to
 *  a test. A busy machine recycles pids, and an unconfirmed one flips the assertion to `held`. */
function deadPid(): number {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pid = Number(spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim());
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
        return pid;
      }
    }
  }
  throw new Error('could not obtain a pid that is certainly dead');
}

function writeRecord(root: string, pid: number, record?: unknown): void {
  const dir = benchLockPath(root);
  spawnSync('mkdir', ['-p', dir]);
  const body = record ?? { pid, startedAt: new Date().toISOString(), command: 'bench run', tiers: ['synthetic'] };
  writeFileSync(join(dir, `${pid}.json`), typeof body === 'string' ? body : JSON.stringify(body));
}

const SYNTH = ['synthetic'];

/** Another process that is certainly ALIVE. `process.pid + 1` is not: whether it names anything is
 *  a lottery the sweep then wins, and this suite is run beside a bench. */
const LIVE_OTHER = process.ppid;

describe('reading the marker', () => {
  test('no marker is a free worktree', () => {
    expect(readBenchLock(throwawayRoot()).state).toBe('free');
  });

  test('a record naming a LIVE process is held', () => {
    const root = throwawayRoot();
    writeRecord(root, process.pid);
    const state = readBenchLock(root);
    expect(state.state).toBe('held');
    expect(state.state === 'held' && state.records[0].pid).toBe(process.pid);
  });

  test('a record naming a DEAD process is stale — a SIGKILLed run must not block the next round', () => {
    const root = throwawayRoot();
    writeRecord(root, deadPid());
    expect(readBenchLock(root).state).toBe('stale');
  });

  test('a record that names no pid at all is stale — nobody could ever clear it by waiting', () => {
    const root = throwawayRoot();
    writeRecord(root, 1234, '{ half-writ');
    expect(readBenchLock(root).state).toBe('stale');
    writeRecord(root, 1234, { startedAt: 'now' });
    expect(readBenchLock(root).state).toBe('stale');
  });

  test('a live record among dead ones still holds the worktree', () => {
    const root = throwawayRoot();
    writeRecord(root, deadPid());
    writeRecord(root, deadPid());
    writeRecord(root, process.pid);
    const state = readBenchLock(root);
    expect(state.state).toBe('held');
    expect(state.state === 'held' && state.records.map((r) => r.pid)).toEqual([process.pid]);
  });

  test('a plain FILE where the directory belongs names no live run, so it is stale not held', () => {
    const root = throwawayRoot();
    writeFileSync(benchLockPath(root), JSON.stringify({ pid: process.pid, command: 'bench run' }));
    expect(readBenchLock(root).state).toBe('stale');
  });
});

describe('taking and releasing it', () => {
  test('acquire records this pid, the time, the argv and the tiers; release removes it', () => {
    const root = throwawayRoot();
    const path = acquireBenchLock('bench run --tier real', ['real'], root);
    const record = JSON.parse(readFileSync(path, 'utf8')) as BenchLockRecord;
    expect(record.pid).toBe(process.pid);
    expect(record.command).toBe('bench run --tier real');
    expect(record.tiers).toEqual(['real']);
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
    expect(readBenchLock(root).state).toBe('held');
    releaseBenchLock(root);
    expect(existsSync(path)).toBe(false);
    // And the directory goes with the last record, so `free` is the resting state a reader sees.
    expect(existsSync(benchLockPath(root))).toBe(false);
  });

  test('release leaves SOMEONE ELSE’s record alone — clearing a live run would be the whole bug', () => {
    const root = throwawayRoot();
    writeRecord(root, LIVE_OTHER);
    releaseBenchLock(root);
    expect(existsSync(join(benchLockPath(root), `${LIVE_OTHER}.json`))).toBe(true);
  });

  test('acquire cannot EVICT a live run — one slot would make the guard lie when the second run ends', () => {
    // The failure this shape exists to prevent: a second run takes the marker, finishes, removes
    // it, and `bench lock` then clears an audit to edit the tree under a run still in flight.
    const root = throwawayRoot();
    const other = LIVE_OTHER;
    writeRecord(root, other);
    acquireBenchLock('bench run --tier synthetic', SYNTH, root);
    expect(readdirSync(benchLockPath(root)).sort()).toEqual([`${other}.json`, `${process.pid}.json`].sort());
    releaseBenchLock(root);
    expect(existsSync(join(benchLockPath(root), `${other}.json`))).toBe(true);
    expect(readBenchLock(root).state).toBe('held');
  });

  test('acquire SWEEPS the records of dead runs', () => {
    const root = throwawayRoot();
    const gone = deadPid();
    writeRecord(root, gone);
    acquireBenchLock('bench run', SYNTH, root);
    expect(existsSync(join(benchLockPath(root), `${gone}.json`))).toBe(false);
    releaseBenchLock(root);
  });

  test('releasing when there is no marker is not an error', () => {
    expect(() => releaseBenchLock(throwawayRoot())).not.toThrow();
  });
});

describe('what a tree-editing phase is told', () => {
  test('a held worktree refuses, naming the record, the pid and the sticky sampler', () => {
    const root = throwawayRoot();
    writeRecord(root, process.pid);
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
    writeRecord(stale, deadPid());
    expect(benchInFlightRefusal(readBenchLock(stale))).toBeUndefined();
  });

  test('the tree-edit refusal is NOT tier-gated — any live run makes an edit cost the run', () => {
    const root = throwawayRoot();
    writeRecord(root, process.pid, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: 'bench run --tier real',
      tiers: ['real'],
    });
    expect(benchInFlightRefusal(readBenchLock(root))).toBeDefined();
  });

  test('`bench lock` exits 1 while a run is in flight and 0 otherwise', () => {
    const held = throwawayRoot();
    writeRecord(held, process.pid);
    expect(benchLockStatus(held)).toBe(1);
    expect(benchLockStatus(throwawayRoot())).toBe(0);
    const stale = throwawayRoot();
    writeRecord(stale, deadPid());
    expect(benchLockStatus(stale)).toBe(0);
  });
});

describe('what a SECOND bench run is told', () => {
  const held = (tiers: string[]): ReturnType<typeof readBenchLock> => {
    const root = throwawayRoot();
    writeRecord(root, process.pid, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: `bench run --tier ${tiers.join('+')}`,
      tiers,
    });
    return readBenchLock(root);
  };

  test('a run writing the SAME tier file is refused, and told what two runs do to it', () => {
    const msg = concurrentRunRefusal(held(SYNTH), SYNTH);
    expect(msg).toContain('bench run REFUSED');
    expect(msg).toContain('apps/benchmark/results/synthetic.json');
    expect(concurrentRunRefusal(readBenchLock(throwawayRoot()), SYNTH)).toBeUndefined();
  });

  test('a scoped run on a tier the live run is NOT writing is allowed through', () => {
    // The dev loop HARD RULE 2 and both briefs prescribe. Refusing it would send the round looking
    // for a way past the guard, and the only way past is the `rm` that unprotects the live run.
    expect(concurrentRunRefusal(held(['real']), SYNTH)).toBeUndefined();
    expect(concurrentRunRefusal(held(SYNTH), ['real'])).toBeUndefined();
    expect(concurrentRunRefusal(held(['synthetic', 'real']), SYNTH)).toBeDefined();
  });

  test('a record carrying NO tiers is assumed to collide — an unknown is not a clearance', () => {
    const root = throwawayRoot();
    writeRecord(root, process.pid, { pid: process.pid, startedAt: new Date().toISOString(), command: 'bench run' });
    expect(concurrentRunRefusal(readBenchLock(root), ['real'])).toBeDefined();
  });

  test('a STALE record does not refuse it — the next run sweeps what a SIGKILL left', () => {
    const root = throwawayRoot();
    writeRecord(root, deadPid());
    expect(concurrentRunRefusal(readBenchLock(root), SYNTH)).toBeUndefined();
    acquireBenchLock('bench run', SYNTH, root);
    const state = readBenchLock(root);
    expect(state.state === 'held' && state.records[0].pid).toBe(process.pid);
    releaseBenchLock(root);
  });
});

describe('the marker survives the ways a run actually ends', () => {
  // The item's second design point, and the one nothing in-process can check: these spawn a real
  // child, so `process.on('exit')` and the ABSENCE of signal handlers are what is under test.
  const child = (root: string, body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-lock-child-'));
    const script = join(dir, 'child.mjs');
    const lock = join(REPO_ROOT, 'apps', 'benchmark', 'src', 'run', 'lock.ts');
    writeFileSync(
      script,
      `import { acquireBenchLock } from ${JSON.stringify(lock)};\n` +
        `acquireBenchLock('bench run --tier synthetic', ['synthetic'], ${JSON.stringify(root)});\n` +
        `console.log('ACQUIRED');\n${body}\n`,
    );
    return script;
  };

  test('a normal exit removes the record', () => {
    const root = throwawayRoot();
    const r = spawnSync('npx', ['tsx', child(root, 'process.exit(0);')], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(r.stdout).toContain('ACQUIRED');
    expect(readBenchLock(root).state).toBe('free');
  }, 60_000);

  test('an uncaught throw removes it too — `cli.ts` leaves through a dozen exits', () => {
    const root = throwawayRoot();
    spawnSync('npx', ['tsx', child(root, 'throw new Error("boom");')], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(readBenchLock(root).state).toBe('free');
  }, 60_000);

  test('acquiring installs NO signal handler, so SIGTERM still kills at once — and what it leaves reads stale', async () => {
    // The rule, not the tidiness. A JS SIGTERM listener cannot run while `spawnSync` holds the
    // loop, which is every case of a run: measured in isolation, a listener made a blocked process
    // survive the full 10 s and exit 0 with the listener never running. So `acquireBenchLock`
    // registers none, and this child — which imports lock.ts and nothing else — must die on the
    // default action while blocked in `spawnSync`, leaving a record that reads stale.
    //
    // It does NOT follow that `bench run` is killable: importing `run/orchestrate.ts` makes tsx
    // bind a hidden handler of its own, and a real run sent SIGTERM finishes every remaining case
    // and rewrites `results/<tier>.json` first. That is true on `origin/main` too. `kill -9`.
    const root = throwawayRoot();
    const script = child(root, 'import { spawnSync as s } from "node:child_process"; s("sleep", ["30"]);');
    const { spawn } = await import('node:child_process');
    const proc = spawn('npx', ['tsx', script], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      let out = '';
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('ACQUIRED')) {
          resolve();
        }
      });
      proc.on('exit', () => reject(new Error(`child exited before acquiring: ${out}`)));
      setTimeout(() => reject(new Error('child never acquired')), 45_000);
    });
    const marked = readBenchLock(root);
    expect(marked.state).toBe('held');
    const t0 = Date.now();
    // The pid the marker names is the one an operator kills, and it is blocked in `spawnSync`.
    process.kill(marked.state === 'held' ? marked.records[0].pid : 0, 'SIGTERM');
    const code = await new Promise<number | null>((resolve) =>
      proc.on('exit', (c, sig) => resolve(c ?? (sig ? -1 : 0))),
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(code).not.toBe(0);
    // Left behind on purpose, and harmless: it names a pid that is gone.
    expect(readBenchLock(root).state).toBe('stale');
    expect(benchLockStatus(root)).toBe(0);
  }, 60_000);
});

describe('the marker is invisible to git', () => {
  // Load-bearing rather than tidy: an untracked path at the repo root is what `preflight.ts`
  // refuses to start on and what `provenance.ts` stamps a run dirty for, so a marker git can see
  // causes the loss it exists to prevent.
  const ignored = (path: string) =>
    spawnSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', path], { encoding: 'utf8' }).status === 0;

  test('the repo-root marker is gitignored, records and all', () => {
    expect(ignored(BENCH_LOCK_FILE)).toBe(true);
    expect(ignored(join(BENCH_LOCK_FILE, '12345.json'))).toBe(true);
  });

  test('and the pattern is ANCHORED — it hides nothing of that name deeper in the tree', () => {
    expect(ignored(join('apps', 'benchmark', BENCH_LOCK_FILE))).toBe(false);
  });
});

describe('the CLI is wired to it', () => {
  // The dispatch lines themselves: `benchLockStatus`/`acquireBenchLock` are tested above against a
  // throwaway root, but nothing else notices if `cli.ts` stops calling them.
  const cli = readFileSync(join(REPO_ROOT, 'apps', 'benchmark', 'src', 'cli.ts'), 'utf8');

  /** Slice one `switch` case out of `cli.ts`, LOUDLY. A bare `indexOf`/`indexOf` pair returns ''
   *  when the cases are reordered and the rest of the file when one is renamed — failing, or
   *  passing, for a reason no reader would guess. */
  function switchCase(name: string): string {
    const from = cli.indexOf(`case '${name}': {`);
    expect(from, `cli.ts has no \`case '${name}'\``).toBeGreaterThan(-1);
    const to = cli.indexOf("\n  case '", from + 1);
    expect(to, `\`case '${name}'\` is the last case in cli.ts`).toBeGreaterThan(from);
    return cli.slice(from, to);
  }

  test('`bench run` records the run, and refuses one that writes the same tier file', () => {
    const runCase = switchCase('run');
    expect(runCase).toContain('acquireBenchLock(');
    // Tier-gated: a refusal that ignored the tiers would refuse the scoped dev loop.
    expect(runCase).toMatch(/concurrentRunRefusal\(readBenchLock\(\), tiers\)/);
    // A shard CHILD records nothing: eight of them would say eight runs are in flight.
    expect(runCase).toContain('isShardChild(');
  });

  test('`bench lock` is a subcommand and is listed in the usage line', () => {
    expect(switchCase('lock')).toContain('benchLockStatus(');
    expect(cli).toMatch(/usage: bench <run\|lock\|/);
  });
});
