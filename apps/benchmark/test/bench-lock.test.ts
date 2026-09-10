// The register that says which runs are in flight, and the refusals read off it.
//
// Every assertion here runs against a THROWAWAY register directory, never `BENCH_LOCK_DIR`.
// Deliberately: the real register belongs to whatever benches are running on this machine, and a
// test that wrote a record into it — or swept one — would be the failure this file exists to
// prevent, from inside the suite the briefs tell you to run beside a bench.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../src/config';
import {
  BENCH_LOCK_DIR,
  type BenchLockRecord,
  acquireBenchLock,
  benchInFlightRefusal,
  benchLockStatus,
  concurrentRunRefusal,
  readBenchLock,
  releaseBenchLock,
} from '../src/run/lock';

/** A throwaway REGISTER directory. Named `reg` and not `root` throughout, because the two are now
 *  different things: the register is machine-wide and each record names the worktree it measures. */
function throwawayReg(): string {
  return join(mkdtempSync(join(tmpdir(), 'asmlift-lock-')), 'reg');
}

/** The worktree a record says it is measuring, and a second one that is somebody else's. */
const MY_ROOT = '/tmp/pretend-worktree-a';
const OTHER_ROOT = '/tmp/pretend-worktree-b';

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

function writeRecord(dir: string, pid: number, record?: unknown): void {
  spawnSync('mkdir', ['-p', dir]);
  const body = record ?? {
    pid,
    startedAt: new Date().toISOString(),
    command: 'bench run',
    tiers: ['synthetic'],
    root: MY_ROOT,
    whole: true,
  };
  writeFileSync(join(dir, `${pid}.json`), typeof body === 'string' ? body : JSON.stringify(body));
}

const SYNTH = ['synthetic'];

/** This run, as the refusals read it: whole-tier synthetic in MY_ROOT unless a case says else. */
const asRun = (over: Partial<{ tiers: string[]; whole: boolean; root: string }> = {}) => ({
  tiers: SYNTH,
  whole: true,
  root: MY_ROOT,
  ...over,
});

/** Another process that is certainly ALIVE. `process.pid + 1` is not: whether it names anything is
 *  a lottery the sweep then wins, and this suite is run beside a bench. */
const LIVE_OTHER = process.ppid;

describe('reading the marker', () => {
  test('no marker is a free worktree', () => {
    expect(readBenchLock(throwawayReg()).state).toBe('free');
  });

  test('a record naming a LIVE process is held', () => {
    const root = throwawayReg();
    writeRecord(root, process.pid);
    const state = readBenchLock(root);
    expect(state.state).toBe('held');
    expect(state.state === 'held' && state.records[0].pid).toBe(process.pid);
  });

  test('a record naming a DEAD process is stale — a SIGKILLed run must not block the next round', () => {
    const root = throwawayReg();
    writeRecord(root, deadPid());
    expect(readBenchLock(root).state).toBe('stale');
  });

  test('a record that names no pid at all is stale — nobody could ever clear it by waiting', () => {
    const root = throwawayReg();
    writeRecord(root, 1234, '{ half-writ');
    expect(readBenchLock(root).state).toBe('stale');
    writeRecord(root, 1234, { startedAt: 'now' });
    expect(readBenchLock(root).state).toBe('stale');
  });

  test('a live record among dead ones still holds the worktree', () => {
    const root = throwawayReg();
    writeRecord(root, deadPid());
    writeRecord(root, deadPid());
    writeRecord(root, process.pid);
    const state = readBenchLock(root);
    expect(state.state).toBe('held');
    expect(state.state === 'held' && state.records.map((r) => r.pid)).toEqual([process.pid]);
  });

  test('a plain FILE where the directory belongs names no live run, so it is stale not held', () => {
    const root = throwawayReg();
    writeFileSync(root, JSON.stringify({ pid: process.pid, command: 'bench run' }));
    expect(readBenchLock(root).state).toBe('stale');
  });

  test('a record naming ANOTHER worktree is still a live record — the register is machine-wide', () => {
    const root = throwawayReg();
    writeRecord(root, process.pid, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: 'bench run',
      tiers: SYNTH,
      root: OTHER_ROOT,
      whole: true,
    });
    const state = readBenchLock(root);
    expect(state.state).toBe('held');
    expect(state.state === 'held' && state.records[0].root).toBe(OTHER_ROOT);
  });
});

describe('taking and releasing it', () => {
  test('acquire records this pid, the time, the argv and the tiers; release removes it', () => {
    const root = throwawayReg();
    const path = acquireBenchLock('bench run --tier real', { tiers: ['real'], whole: true, root: MY_ROOT }, root);
    const record = JSON.parse(readFileSync(path, 'utf8')) as BenchLockRecord;
    expect(record.pid).toBe(process.pid);
    expect(record.command).toBe('bench run --tier real');
    expect(record.tiers).toEqual(['real']);
    expect(record.root).toBe(MY_ROOT);
    expect(record.whole).toBe(true);
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
    expect(readBenchLock(root).state).toBe('held');
    releaseBenchLock(root);
    expect(existsSync(path)).toBe(false);
    // The DIRECTORY stays. Removing it would race a neighbour that has just created it and not yet
    // written into it — an ENOENT out of a 35-minute command before it did any work — and an empty
    // directory outside every worktree costs nothing. `free` is what a reader sees either way.
    expect(readBenchLock(root).state).toBe('free');
  });

  test('release leaves SOMEONE ELSE’s record alone — clearing a live run would be the whole bug', () => {
    const root = throwawayReg();
    writeRecord(root, LIVE_OTHER);
    releaseBenchLock(root);
    expect(existsSync(join(root, `${LIVE_OTHER}.json`))).toBe(true);
  });

  test('acquire cannot EVICT a live run — one slot would make the guard lie when the second run ends', () => {
    // The failure this shape exists to prevent: a second run takes the marker, finishes, removes
    // it, and `bench in-flight` then clears an audit to edit the tree under a run still in flight.
    const root = throwawayReg();
    const other = LIVE_OTHER;
    writeRecord(root, other);
    acquireBenchLock('bench run --tier synthetic', asRun(), root);
    expect(readdirSync(root).sort()).toEqual([`${other}.json`, `${process.pid}.json`].sort());
    releaseBenchLock(root);
    expect(existsSync(join(root, `${other}.json`))).toBe(true);
    expect(readBenchLock(root).state).toBe('held');
  });

  test('acquire SWEEPS the records of dead runs', () => {
    const root = throwawayReg();
    const gone = deadPid();
    writeRecord(root, gone);
    acquireBenchLock('bench run', asRun(), root);
    expect(existsSync(join(root, `${gone}.json`))).toBe(false);
    releaseBenchLock(root);
  });

  test('releasing when there is no marker is not an error', () => {
    expect(() => releaseBenchLock(throwawayReg())).not.toThrow();
  });

  test('a DIRECTORY named `<pid>.json` is swept, not thrown on — one would brick every later run', () => {
    // `readFileSync` of it raises EISDIR, so it reads as an unreadable record; a non-recursive
    // `rmSync` in the sweep then raises EISDIR in turn and no `bench run` can start here again.
    const root = throwawayReg();
    spawnSync('mkdir', ['-p', join(root, '99999.json')]);
    expect(() => acquireBenchLock('bench run', asRun(), root)).not.toThrow();
    expect(existsSync(join(root, '99999.json'))).toBe(false);
    releaseBenchLock(root);
  });
});

describe('what a tree-editing phase is told', () => {
  test('a held worktree refuses, naming the record, the pid and the sticky sampler', () => {
    const root = throwawayReg();
    writeRecord(root, process.pid);
    const msg = benchInFlightRefusal(readBenchLock(root), MY_ROOT);
    expect(msg).toBeDefined();
    // The register it QUOTES is the one it read, never the default constant: every refusal here
    // names a path to `rm`, and naming one the reader did not read sends them at the wrong file.
    expect(msg).toContain(root);
    expect(msg).not.toContain(BENCH_LOCK_DIR);
    expect(msg).toContain(`pid ${process.pid}`);
    expect(msg).toMatch(/STICKY/);
  });

  test('a free or stale worktree does not — the phase proceeds', () => {
    const free = throwawayReg();
    expect(benchInFlightRefusal(readBenchLock(free), MY_ROOT)).toBeUndefined();
    const stale = throwawayReg();
    writeRecord(stale, deadPid());
    expect(benchInFlightRefusal(readBenchLock(stale), MY_ROOT)).toBeUndefined();
  });

  test('a run measuring ANOTHER worktree does not refuse an edit here — it cannot be dirtied from here', () => {
    // The other direction of the same rule that makes the register machine-wide: refusing on a
    // neighbour would block every round on this machine whenever any round is measuring.
    const root = throwawayReg();
    writeRecord(root, process.pid, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: 'bench run',
      tiers: SYNTH,
      root: OTHER_ROOT,
      whole: true,
    });
    expect(benchInFlightRefusal(readBenchLock(root), MY_ROOT)).toBeUndefined();
    // …and `bench in-flight` says so on stdout while still exiting 0.
    expect(benchLockStatus(root, MY_ROOT)).toBe(0);
  });

  test('a record that does not say WHICH worktree refuses anyway — unknown is not a clearance', () => {
    const root = throwawayReg();
    writeRecord(root, process.pid, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: 'bench run',
      tiers: SYNTH,
    });
    expect(benchInFlightRefusal(readBenchLock(root), MY_ROOT)).toBeDefined();
  });

  test('the tree-edit refusal is NOT tier-gated — any live run makes an edit cost the run', () => {
    const root = throwawayReg();
    writeRecord(root, process.pid, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: 'bench run --tier real',
      tiers: ['real'],
      root: MY_ROOT,
      whole: true,
    });
    expect(benchInFlightRefusal(readBenchLock(root), MY_ROOT)).toBeDefined();
  });

  test('`bench in-flight` exits 1 while a run is in flight and 0 otherwise', () => {
    const held = throwawayReg();
    writeRecord(held, process.pid);
    expect(benchLockStatus(held, MY_ROOT)).toBe(1);
    expect(benchLockStatus(throwawayReg(), MY_ROOT)).toBe(0);
    const stale = throwawayReg();
    writeRecord(stale, deadPid());
    expect(benchLockStatus(stale, MY_ROOT)).toBe(0);
  });
});

describe('what a SECOND bench run is told', () => {
  /** A live record, as one live run of the given shape. */
  const held = (over: Partial<{ tiers: string[]; whole: boolean; root: string }> = {}) => {
    const reg = throwawayReg();
    const r = { tiers: SYNTH, whole: true, root: MY_ROOT, ...over };
    writeRecord(reg, process.pid, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: `bench run --tier ${r.tiers.join('+')}`,
      ...r,
    });
    return readBenchLock(reg);
  };

  test('a run writing the SAME tier file in the SAME worktree is refused, and told what that does', () => {
    const msg = concurrentRunRefusal(held(), asRun());
    expect(msg).toContain('bench run REFUSED');
    expect(msg).toContain('apps/benchmark/results/synthetic.json');
    expect(concurrentRunRefusal(readBenchLock(throwawayReg()), asRun())).toBeUndefined();
  });

  test('a scoped run on a tier the live run in THIS worktree is not writing is allowed through', () => {
    // The dev loop the house rules and both briefs prescribe. Refusing it would send the round
    // looking for a way past the guard, and the invented way past is the `rm` that unprotects the
    // live run. `whole: false` because a `--only` probe is what that loop actually is.
    const scoped = asRun({ whole: false });
    expect(concurrentRunRefusal(held({ tiers: ['real'] }), scoped)).toBeUndefined();
    expect(concurrentRunRefusal(held({ tiers: SYNTH }), asRun({ tiers: ['real'], whole: false }))).toBeUndefined();
    expect(concurrentRunRefusal(held({ tiers: ['synthetic', 'real'] }), scoped)).toBeDefined();
  });

  test('the same-file refusal names the SCOPED escape and `--no-lock`, never `rm` of a live record', () => {
    // The message is what an agent reads at the moment it is looking for a way forward, so it must
    // not sanction the thing the house rules forbid three lines away: a second WHOLE tier beside a
    // live one. The word `scoped` is the whole point of the sentence.
    const msg = concurrentRunRefusal(held(), asRun()) ?? '';
    expect(msg).toMatch(/SCOPED/);
    expect(msg).toContain('--only');
    expect(msg).toContain('--no-lock');
    expect(msg).toMatch(/never[\s\S]*`rm` a record you did not write/);
  });

  test('TWO FULL BENCHES are refused across worktrees — the hazard with two recorded incidents', () => {
    // The house rule, mechanised. `2,704 s against a neighbour versus 1,800 s solo`, and a shard
    // killed by a neighbour writes a partial tier with NO error line.
    const msg = concurrentRunRefusal(held({ root: OTHER_ROOT, tiers: ['real'] }), asRun());
    expect(msg).toContain('bench run REFUSED');
    expect(msg).toContain('a full bench is already running on this machine');
    expect(msg).toContain(OTHER_ROOT);
    expect(msg).toContain('2,704 s');
  });

  test('…but only WHOLE against WHOLE: a scoped probe beside a neighbour is not refused', () => {
    // Both directions. A 15 s `--only` probe is not what fans 8 shards, and refusing it because a
    // neighbour is busy would be this guard inventing a rule nobody has an incident for.
    expect(concurrentRunRefusal(held({ root: OTHER_ROOT }), asRun({ whole: false }))).toBeUndefined();
    expect(concurrentRunRefusal(held({ root: OTHER_ROOT, whole: false }), asRun())).toBeUndefined();
  });

  test('a record carrying NO tiers is assumed to collide — an unknown is not a clearance', () => {
    const reg = throwawayReg();
    writeRecord(reg, process.pid, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: 'bench run',
      root: MY_ROOT,
    });
    expect(concurrentRunRefusal(readBenchLock(reg), asRun({ tiers: ['real'] }))).toBeDefined();
  });

  test('a STALE record does not refuse it — the next run sweeps what a SIGKILL left', () => {
    const reg = throwawayReg();
    writeRecord(reg, deadPid());
    expect(concurrentRunRefusal(readBenchLock(reg), asRun())).toBeUndefined();
    acquireBenchLock('bench run', asRun(), reg);
    const state = readBenchLock(reg);
    expect(state.state === 'held' && state.records[0].pid).toBe(process.pid);
    releaseBenchLock(reg);
  });
});

describe('the marker survives the ways a run actually ends', () => {
  // Nothing in-process can check this: these spawn a real child, so `process.on('exit')` and the
  // ABSENCE of signal handlers are what is under test.
  const child = (root: string, body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-lock-child-'));
    const script = join(dir, 'child.mjs');
    const lock = join(REPO_ROOT, 'apps', 'benchmark', 'src', 'run', 'lock.ts');
    writeFileSync(
      script,
      `import { acquireBenchLock } from ${JSON.stringify(lock)};\n` +
        "acquireBenchLock('bench run --tier synthetic', " +
        `{ tiers: ['synthetic'], whole: true, root: ${JSON.stringify(MY_ROOT)} }, ${JSON.stringify(root)});\n` +
        `console.log('ACQUIRED');\n${body}\n`,
    );
    return script;
  };

  test('a normal exit removes the record', () => {
    const root = throwawayReg();
    const r = spawnSync('npx', ['tsx', child(root, 'process.exit(0);')], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(r.stdout).toContain('ACQUIRED');
    expect(readBenchLock(root).state).toBe('free');
  }, 60_000);

  test('an uncaught throw removes it too — `cli.ts` leaves through a dozen exits', () => {
    const root = throwawayReg();
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
    const root = throwawayReg();
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
    expect(benchLockStatus(root, MY_ROOT)).toBe(0);
  }, 60_000);
});

describe('where the register lives', () => {
  test('OUTSIDE every worktree, so git can never see it', () => {
    // Load-bearing rather than tidy: a marker inside the tree is an untracked path, which is what
    // `preflight.ts` refuses to start on and what `provenance.ts` stamps a run dirty for — one
    // `.gitignore` edit away from causing the loss it exists to prevent. Outside, there is nothing
    // to gitignore and nothing to get wrong.
    expect(BENCH_LOCK_DIR.startsWith(`${REPO_ROOT}/`)).toBe(false);
    expect(
      spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--ignored=no'], { encoding: 'utf8' }).stdout,
    ).not.toContain('bench-running');
  });

  test('and at a path NO environment variable can move', () => {
    // Measured, and the reason `os.tmpdir()` is not used: an interactive shell on this machine
    // gives `/var/folders/…/T` from $TMPDIR while the same node with TMPDIR unset gives `/tmp`.
    // Two agents would hold two registers and each would read the other as absent — the guard
    // green while the hazard is live, which is worse than no guard.
    if (process.platform !== 'win32') {
      expect(BENCH_LOCK_DIR.startsWith('/tmp/')).toBe(true);
      const other = spawnSync('node', ['-e', 'console.log(require("os").tmpdir())'], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: '/var/folders/pretend/T' },
      }).stdout.trim();
      // `tmpdir()` moved with the variable; BENCH_LOCK_DIR is a constant that could not.
      expect(other).toBe('/var/folders/pretend/T');
    }
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

  test('`bench run` takes a record, and a shard child does not', () => {
    // The WRITE is all that is left here: the refusal read off the register is a preflight verdict
    // and is tested as one, against injected state, in `preflight.test.ts`.
    const runCase = switchCase('run');
    expect(runCase).toContain('acquireBenchLock(');
    // Eight shard children's records would say eight runs are in flight.
    expect(runCase).toContain('runTakesTheBenchLock(');
  });

  test('`bench in-flight` is a subcommand and is listed in the usage line', () => {
    expect(switchCase('in-flight')).toContain('benchLockStatus(');
    expect(cli).toMatch(/usage: bench <run\|in-flight\|/);
  });
});
