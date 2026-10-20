// The memory admission check every heavy command calls (src/run/admission.ts). Every reading here is
// INJECTED: a test that read this machine's /proc/meminfo would pass or fail on whatever else the
// host happens to be running.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { vitestWorkers } from '../../../vitest.memory-admission';
import {
  ADMISSION_ENV,
  type MemoryReading,
  PEAK_BYTES,
  RESERVE_BYTES,
  SHARD_BYTES,
  admissionRefusal,
  admissionVerdict,
  legacyNeedBytes,
  parseMeminfo,
  parsePsTable,
  parseSwaps,
  parseVmStat,
  processTreeBytes,
  readAdmissibleMemory,
  readAvailableMemory,
  runRequest as shippedRunRequest,
  unitsThatFit,
  unspentBudgets,
  vitestRequest,
  zramCredit,
} from '../src/run/admission';
import type { BenchLockRecord, BenchLockState } from '../src/run/lock';

const kB = 1024;
const GB = 1e9;

/** /proc/meminfo as this host printed it at 14:26 on 2026-10-20, quiet. */
const QUIET_MEMINFO = [
  'MemTotal:        7879056 kB',
  'MemFree:         1767568 kB',
  'MemAvailable:    5368340 kB',
  'SwapTotal:       9975800 kB',
  'SwapFree:        9899436 kB',
].join('\n');

/** This host's meminfo with the two figures that move; SwapTotal is this host's. */
const meminfo = (memAvailableKb: number, swapFreeKb: number): string =>
  `MemTotal: 7879056 kB\nMemAvailable: ${memAvailableKb} kB\nSwapTotal: 9975800 kB\nSwapFree: ${swapFreeKb} kB\n`;

/** This host's /proc/swaps (a 2 GB swapfile at priority -1, an 8.1 GB zram device at 100) with the
 *  swap in use that `SwapFree` says, taken by zram first as the kernel's priorities do. */
const hostSwaps = (swapFreeKb: number): string => {
  const used = 9975800 - swapFreeKb;
  const zram = Math.min(used, 7878652);
  return [
    'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority',
    `/swapfile                               file\t\t2097148\t\t${used - zram}\t\t-1`,
    `/dev/zram0                              partition\t7878652\t\t${zram}\t\t100`,
  ].join('\n');
};

const linux = (text: string, swaps?: string) => {
  const free = /^SwapFree:\s+(\d+)/m.exec(text);
  return {
    platform: 'linux',
    meminfo: () => text,
    swaps: () => swaps ?? hostSwaps(free ? Number(free[1]) : 9975800),
    freemem: () => 0,
  };
};

/** The shipped `bench run` request at `shards` shards over a whole tier, with no live reading. */
const runRequest = (shards: number) => shippedRunRequest(shards, undefined, () => 0);

describe('parseMeminfo', () => {
  it('reads MemAvailable in bytes', () => {
    expect(parseMeminfo(QUIET_MEMINFO)).toBe(5368340 * kB);
  });

  it('has no answer without MemAvailable (a kernel before 3.14)', () => {
    expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 500 kB\n')).toBeUndefined();
  });
});

describe('the swap admission counts', () => {
  it('reads /proc/swaps as this host prints it', () => {
    expect(parseSwaps(hostSwaps(9899436))).toEqual([
      { name: '/swapfile', type: 'file', sizeBytes: 2097148 * kB, usedBytes: 0 },
      { name: '/dev/zram0', type: 'partition', sizeBytes: 7878652 * kB, usedBytes: 76364 * kB },
    ]);
  });

  it('credits each zram device above half its size, and disk swap not at all', () => {
    const zram = { name: '/dev/zram0', type: 'partition', sizeBytes: 8 * GB, usedBytes: 1 * GB };
    expect(zramCredit([zram]).bytes).toBe(3 * GB);
    expect(zramCredit([{ ...zram, usedBytes: 5 * GB }]).bytes).toBe(0);
    expect(zramCredit([{ ...zram, name: '/dev/zram1' }, zram]).bytes).toBe(6 * GB);
    expect(zramCredit([{ name: '/swapfile', type: 'file', sizeBytes: 32 * GB, usedBytes: 0 }]).bytes).toBe(0);
    expect(zramCredit([{ name: '/dev/sda2', type: 'partition', sizeBytes: 16 * GB, usedBytes: 0 }]).bytes).toBe(0);
  });
});

describe('readAvailableMemory', () => {
  it('counts MemAvailable plus the zram free above half its size on Linux, and no disk swap', () => {
    const r = readAvailableMemory(linux(QUIET_MEMINFO));
    expect(r.availableBytes).toBe(5368340 * kB + Math.floor((7878652 * kB) / 2) - 76364 * kB);
    expect(r.how).toContain('MemAvailable');
    expect(r.how).toContain('zram');
    expect(r.how).toContain('disk swap not counted');
  });

  it('counts no swap once zram use has reached half of the device', () => {
    expect(readAvailableMemory(linux(meminfo(1000, 4000000))).availableBytes).toBe(1000 * kB);
  });

  it('counts no swap where /proc/swaps cannot be read', () => {
    const r = readAvailableMemory({
      ...linux(QUIET_MEMINFO),
      swaps: () => {
        throw new Error('ENOENT');
      },
    });
    expect(r.availableBytes).toBe(5368340 * kB);
  });

  it('does not grow with a disk swapfile: 16 GiB of RAM and 32 GiB of disk swap admit no more than RAM', () => {
    // The architecture breaker's host: a run at --jobs 6, a 7-worker vitest, a fan and a project
    // sweep were all admitted together, 27 GB of need on 17.2 GB of RAM.
    const big = linux(
      'MemTotal: 16777216 kB\nMemAvailable: 13631488 kB\nSwapTotal: 33554432 kB\nSwapFree: 33554432 kB\n',
      'Filename\tType\tSize\tUsed\tPriority\n/swapfile file 33554432 0 -2\n',
    );
    const r = readAvailableMemory(big);
    expect(r.availableBytes).toBe(13631488 * kB);
    expect(admissionVerdict(runRequest(6), r)).toContain('REFUSED');
  });

  it('falls back to os.freemem(), counting no swap, where /proc/meminfo has no MemAvailable', () => {
    const r = readAvailableMemory({ platform: 'linux', meminfo: () => 'MemFree: 1 kB\n', freemem: () => 3 * GB });
    expect(r.availableBytes).toBe(3 * GB);
    expect(r.how).toContain('os.freemem()');
  });

  it('falls back to os.freemem() where /proc/meminfo cannot be read', () => {
    const r = readAvailableMemory({
      platform: 'linux',
      meminfo: () => {
        throw new Error('ENOENT');
      },
      freemem: () => 2 * GB,
    });
    expect(r.availableBytes).toBe(2 * GB);
  });

  it('reads vm_stat and never /proc/meminfo on macOS', () => {
    const r = readAvailableMemory({
      platform: 'darwin',
      meminfo: () => {
        throw new Error('macOS has no /proc/meminfo, and this reader must not be called');
      },
      vmStat: () => VM_STAT,
      freemem: () => 1 * GB,
    });
    expect(r.availableBytes).toBe((20000 + 300000 + 15000 + 5000) * 16384);
    expect(r.how).toContain('vm_stat');
  });

  it('falls back to os.freemem() on macOS where vm_stat cannot be run or read', () => {
    const fail = () => {
      throw new Error('ENOENT');
    };
    expect(readAvailableMemory({ platform: 'darwin', vmStat: fail, freemem: () => 6 * GB }).availableBytes).toBe(
      6 * GB,
    );
    expect(
      readAvailableMemory({ platform: 'darwin', vmStat: () => 'garbage', freemem: () => 6 * GB }).availableBytes,
    ).toBe(6 * GB);
  });

  it('does not refuse the gate on a Mac whose free pages are few but whose inactive pages are many', () => {
    // free pages alone, 1.0 GB, refused the 3-worker gate and a 1-shard run
    const mac = { platform: 'darwin', vmStat: () => VM_STAT, freemem: () => 1 * GB, lockState: freeRegister, env: {} };
    expect(admissionRefusal(vitestRequest(3), { ...mac, vmStat: () => 'garbage' })).toContain('REFUSED');
    expect(admissionRefusal(vitestRequest(3), mac)).toBeUndefined();
    expect(admissionRefusal(runRequest(1), mac)).toBeUndefined();
  });
});

/** `vm_stat` output in the shape macOS prints it; 16 KiB pages (Apple silicon). */
const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               20000.',
  'Pages active:                            400000.',
  'Pages inactive:                          300000.',
  'Pages speculative:                         5000.',
  'Pages throttled:                              0.',
  'Pages wired down:                        150000.',
  'Pages purgeable:                          15000.',
  '"Translation faults":                 123456789.',
].join('\n');

describe('parseVmStat', () => {
  it('reads free + inactive + purgeable + speculative pages at the page size it prints', () => {
    expect(parseVmStat(VM_STAT)).toBe(340000 * 16384);
  });

  it('has no answer without the page size or the free count', () => {
    expect(parseVmStat('Pages free: 10.\n')).toBeUndefined();
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\n')).toBeUndefined();
  });
});

describe('admissionVerdict', () => {
  const reading = (bytes: number): MemoryReading => ({ availableBytes: bytes, how: 'test' });

  it('admits a request that fits beside the reserve, and refuses one that does not', () => {
    expect(admissionVerdict(runRequest(1), reading(SHARD_BYTES + RESERVE_BYTES))).toBeUndefined();
    expect(admissionVerdict(runRequest(1), reading(SHARD_BYTES + RESERVE_BYTES - 1))).toContain('REFUSED');
  });

  it('admits a solo `bench run --jobs 3` on this host quiet, which has run safely for weeks, and not --jobs 4', () => {
    expect(admissionVerdict(runRequest(3), readAvailableMemory(linux(QUIET_MEMINFO)))).toBeUndefined();
    // what `default-jobs.ts` sizes this host at; swap counted as half of SwapTotal admitted 4
    expect(admissionVerdict(runRequest(4), readAvailableMemory(linux(QUIET_MEMINFO)))).toContain('REFUSED');
  });

  it('refuses the 13:18 pair: a whole-corpus sweep --base started beside a --jobs 3 run', () => {
    // The quiet host, less the ~8.0 GB the run held at the OOM, taken out of RAM first and then swap.
    const runHeld = 8.0 * GB;
    const ram = 5368340 * kB;
    const swap = 9899436 * kB - (runHeld - ram);
    const beside = readAvailableMemory(linux(meminfo(0, Math.floor(swap / kB))));
    // as it was then, both passes live at once, and as it is now
    const then = { command: 'bench sweep', needBytes: 2 * PEAK_BYTES.sweepPass, need: '2 passes' };
    const now = { command: 'bench sweep', needBytes: PEAK_BYTES.sweepBase, need: 'one pass + records' };
    expect(admissionVerdict(then, beside)).toContain('bench sweep REFUSED');
    expect(admissionVerdict(now, beside)).toContain('bench sweep REFUSED');
  });

  it('refuses a 3-worker vitest gate beside a --jobs 3 run at its peak, as measured on this host', () => {
    // 2026-10-20, MEMGUARD's own gate bench mid-run: MemAvailable 0.6 GB, SwapFree 6.8 GB.
    const peak = readAvailableMemory(linux(meminfo(Math.round((0.6 * GB) / kB), Math.round((6.8 * GB) / kB))));
    expect(admissionVerdict(vitestRequest(3), peak)).toContain('REFUSED');
  });

  it('names the need, what is available, how it was read, and the way forward', () => {
    const text = admissionVerdict(runRequest(3), { availableBytes: 4 * GB, how: 'MemAvailable 4.0 GB' })!;
    expect(text).toContain('~7.5 GB');
    expect(text).toContain('3 shards × 2.5 GB');
    expect(text).toContain('3.5 GB to give');
    expect(text).toContain('MemAvailable 4.0 GB');
    expect(text).toContain('scope it with `--only`');
    expect(text).toContain(`${ADMISSION_ENV}=off`);
    // the rule and the numbers, not one host's incident
    expect(text).not.toContain('13:18');
    expect(text).not.toContain('desktop');
  });

  it('says to wait only when the register holds a heavy job', () => {
    const solo = admissionVerdict(runRequest(3), { availableBytes: 4 * GB, how: 'x', registeredJobs: 0 })!;
    expect(solo).not.toContain('Wait');
    expect(solo).toContain('No heavy job is registered');
    const beside = admissionVerdict(runRequest(3), { availableBytes: 4 * GB, how: 'x', registeredJobs: 2 })!;
    expect(beside).toContain('Wait for the 2 heavy jobs registered on this machine');
    expect(
      admissionRefusal(runRequest(3), { ...linux(meminfo(100_000, 9975800)), lockState: freeRegister, env: {} }),
    ).toContain('No heavy job is registered');
  });

  it('never prints a negative amount to give', () => {
    expect(admissionVerdict(runRequest(1), { availableBytes: 0, how: 'none' })).toContain('0.0 GB to give');
  });
});

/** No live record: the register must not depend on what this host happens to be running. */
const freeRegister = (): BenchLockState => ({ state: 'free', path: '/nowhere' });

describe('admissionRefusal', () => {
  const starved = { ...linux(meminfo(100_000, 0)), lockState: freeRegister };

  it('reads the machine through the injected reader and refuses', () => {
    expect(admissionRefusal(runRequest(1), { ...starved, env: {} })).toContain('bench run REFUSED');
  });

  it(`skips the check, saying so, when ${ADMISSION_ENV}=off`, () => {
    const said: string[] = [];
    expect(
      admissionRefusal(runRequest(1), { ...starved, env: { [ADMISSION_ENV]: 'off' }, warn: (s) => said.push(s) }),
    ).toBeUndefined();
    expect(said.join('\n')).toContain(`${ADMISSION_ENV}=off`);
  });

  it('is not turned off by any other value', () => {
    expect(admissionRefusal(runRequest(1), { ...starved, env: { [ADMISSION_ENV]: '0' } })).toContain('REFUSED');
  });
});

describe('unitsThatFit', () => {
  it('counts whole units after the reserve, and never fewer than none', () => {
    expect(unitsThatFit(SHARD_BYTES, { availableBytes: 3 * SHARD_BYTES + RESERVE_BYTES, how: '' })).toBe(3);
    expect(unitsThatFit(SHARD_BYTES, { availableBytes: 3 * SHARD_BYTES + RESERVE_BYTES - 1, how: '' })).toBe(2);
    expect(unitsThatFit(SHARD_BYTES, { availableBytes: 0, how: '' })).toBe(0);
  });
});

describe('what `bench run` asks for (the request cli.ts builds)', () => {
  it('starts one shard per row up to --jobs, and --jobs shards over a whole tier', () => {
    expect(shippedRunRequest(3, undefined, () => 0).needBytes).toBe(3 * SHARD_BYTES);
    expect(shippedRunRequest(3, 1, () => 0).needBytes).toBe(SHARD_BYTES);
    expect(shippedRunRequest(3, 1, () => 0).need).toBe('1 shard × 2.5 GB');
    expect(shippedRunRequest(2, 40, () => 0).needBytes).toBe(2 * SHARD_BYTES);
    // a selection that names no row still starts the run's own process
    expect(shippedRunRequest(3, 0, () => 0).needBytes).toBe(SHARD_BYTES);
  });

  it('advises the --jobs that fits now, or scoping when not one shard does', () => {
    expect(shippedRunRequest(3, undefined, () => 2).instead).toBe('run `--jobs 2`, which fits now');
    expect(shippedRunRequest(3, undefined, () => 0).instead).toBe('scope it with `--only`');
  });
});

describe('what a vitest run asks for (vitest.memory-admission.ts)', () => {
  type Cfg = Parameters<typeof vitestWorkers>[0];
  const cfg = (c: Record<string, unknown>): Cfg => ({ pool: 'forks', ...c }) as unknown as Cfg;

  it('prices the workers it is given', () => {
    expect(vitestRequest(3).needBytes).toBe(3 * PEAK_BYTES.vitestWorker);
  });

  it('counts the workers the pool will start: maxForks, then maxWorkers, then vitest’s own default', () => {
    expect(vitestWorkers(cfg({ maxWorkers: 3 }), 8)).toBe(3);
    expect(vitestWorkers(cfg({ maxWorkers: 3, poolOptions: { forks: { maxForks: 2 } } }), 8)).toBe(2);
    // `pnpm test:offline` and a bare `pnpm exec vitest run`: no --maxWorkers, so cpus - 1
    expect(vitestWorkers(cfg({}), 8)).toBe(7);
    expect(vitestWorkers(cfg({ watch: true }), 8)).toBe(4);
    expect(vitestWorkers(cfg({ pool: 'threads', poolOptions: { threads: { maxThreads: 5 } } }), 8)).toBe(5);
    expect(vitestWorkers(cfg({}), 1)).toBe(1);
  });

  it('counts one worker for a single fork, as the matching config runs', () => {
    expect(vitestWorkers(cfg({ maxWorkers: 3, poolOptions: { forks: { singleFork: true } } }), 8)).toBe(1);
    expect(vitestWorkers(cfg({ maxWorkers: 3, fileParallelism: false }), 8)).toBe(1);
  });

  it('advises the worker count, the one thing that lowers its price — not the file count', () => {
    // vitest itself reads `--maxWorkers`; `VITEST_MAX_WORKERS` only through the gate script
    expect(vitestRequest(3).instead).toContain('`--maxWorkers=1`');
    expect(vitestRequest(3).instead).toContain('gate-vitest.sh');
    expect(vitestRequest(3).instead).not.toMatch(/^.*, or one test file$/);
  });
});

/** A fake /proc: each entry is [pid, ppid, VmRSS kB, VmSwap kB]. */
function fakeProc(procs: [number, number, number, number][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-proc-'));
  for (const [pid, ppid, rss, swap] of procs) {
    mkdirSync(join(dir, String(pid)));
    // a comm with a space and a parenthesis, which a split on spaces would misread
    writeFileSync(join(dir, String(pid), 'stat'), `${pid} (node (x) y) S ${ppid} 1 1 0\n`);
    writeFileSync(join(dir, String(pid), 'status'), `Name: node\nVmRSS:\t${rss} kB\nVmSwap:\t${swap} kB\n`);
  }
  mkdirSync(join(dir, 'self'));
  return dir;
}

describe('what registered jobs have still to take', () => {
  const record = (pid: number, needBytes?: number): BenchLockRecord => ({
    pid,
    startedAt: new Date().toISOString(),
    command: 'bench run --jobs 3',
    tiers: ['synthetic', 'real'],
    whole: true,
    ...(needBytes !== undefined ? { needBytes } : {}),
  });
  const held = (...records: BenchLockRecord[]): BenchLockState => ({ state: 'held', path: '/reg', records });

  it('sums rss+swap over a process and every descendant, and nothing else', () => {
    const proc = fakeProc([
      [100, 1, 1000, 0],
      [101, 100, 2000, 500],
      [102, 101, 3000, 0],
      [200, 1, 99999, 0],
    ]);
    expect(processTreeBytes(100, proc)).toBe((1000 + 2000 + 500 + 3000) * kB);
    expect(processTreeBytes(102, proc)).toBe(3000 * kB);
    expect(processTreeBytes(300, proc)).toBeUndefined();
    expect(processTreeBytes(100, '/no/such/proc', () => '')).toBeUndefined();
  });

  it('reads the tree from `ps` where there is no /proc, as on macOS', () => {
    const ps = ['  100     1  1000', '  101   100  2000', '  102   101  3000', '  200     1 99999', 'garbage'].join(
      '\n',
    );
    expect(parsePsTable(ps).get(101)).toEqual([100, 2000 * kB]);
    expect(processTreeBytes(100, '/no/such/proc', () => ps)).toBe(6000 * kB);
    expect(processTreeBytes(102, '/no/such/proc', () => ps)).toBe(3000 * kB);
    expect(processTreeBytes(300, '/no/such/proc', () => ps)).toBeUndefined();
    const fail = () => {
      throw new Error('ENOENT');
    };
    expect(processTreeBytes(100, '/no/such/proc', fail)).toBeUndefined();
  });

  it('subtracts what a live job was admitted with less what its tree holds, never below nothing', () => {
    const bytes = { 1: 1 * GB, 2: 9 * GB } as Record<number, number>;
    const r = unspentBudgets(held(record(1, 7.5 * GB), record(2, 2 * GB)), (pid) => bytes[pid]);
    expect(r).toEqual({ bytes: 6.5 * GB, jobs: 1 });
  });

  it('promises a live record’s whole need when its tree cannot be read, and nothing for a free register', () => {
    // a Mac whose `ps` failed too: before, every promise there was dropped
    expect(unspentBudgets(held(record(1, 7.5 * GB)), () => undefined)).toEqual({ bytes: 7.5 * GB, jobs: 1 });
    expect(unspentBudgets(freeRegister(), () => 0)).toEqual({ bytes: 0, jobs: 0 });
  });

  it('prices a record written without a need as the `bench run` an older base started', () => {
    const host = { cpus: 8, totalmem: 7.88e9 };
    expect(legacyNeedBytes({ command: 'bench run --jobs 3 --detach' }, host)).toBe(3 * SHARD_BYTES);
    expect(legacyNeedBytes({ command: 'bench run --jobs=2' }, host)).toBe(2 * SHARD_BYTES);
    expect(legacyNeedBytes({ command: 'bench run --serial --only Foo' }, host)).toBe(SHARD_BYTES);
    // no --jobs: the older default, min(8, cpus, totalmem / 2.5 GB) — 3 on this host
    expect(legacyNeedBytes({ command: 'bench run' }, host)).toBe(3 * SHARD_BYTES);
    expect(legacyNeedBytes({ command: 'bench run' }, { cpus: 2, totalmem: 64e9 })).toBe(2 * SHARD_BYTES);
    expect(legacyNeedBytes({ command: 'bench run', kind: 'sweep' }, host)).toBe(PEAK_BYTES.sweepBase);
    // an older full run ramping up, as the 13:18 incident's mixed-base lanes ran: it promised 0
    const old = record(1);
    expect(unspentBudgets(held(old), () => 2.8 * GB).bytes).toBe(legacyNeedBytes(old) - 2.8 * GB);
  });

  it('refuses a vitest gate beside a full bench still ramping up, which a reading of NOW alone admits', () => {
    // A --jobs 3 run early on, holding 1 GB of its 7.5 GB out of the quiet host's RAM (a shape, not a
    // measurement: docs/bench-cost.md §5 has the measured ramp).
    const deps = { ...linux(meminfo(5368340 - Math.round(GB / kB), 9899436)), env: {} };
    expect(admissionRefusal(vitestRequest(3), { ...deps, lockState: freeRegister })).toBeUndefined();
    const ramping = { ...deps, lockState: () => held(record(1, 3 * SHARD_BYTES)), held: () => 1 * GB };
    expect(readAdmissibleMemory(ramping).how).toContain('6.5 GB that 1 registered job has still to take');
    expect(admissionRefusal(vitestRequest(3), ramping)).toContain('REFUSED');
  });

  it('decides a gate and a run the same in either order, now that the gate promises its need too', () => {
    // The breaker's probe: MemAvailable 5.1 GB, SwapFree 10.1 of 10.2 GB, the first job's tree
    // holding 0.4 GB. Before the gate took a record, gate-then-run was ADMITTED and run-then-gate
    // REFUSED.
    const deps = { ...linux(meminfo(Math.round((5.1 * GB) / kB), Math.round((10.1 * GB) / kB))), env: {} };
    const gate = vitestRequest(3);
    const gateJob: BenchLockRecord = {
      ...record(7, gate.needBytes),
      command: 'gate-vitest vitest (3 workers)',
      tiers: [],
      whole: false,
      kind: 'job',
    };
    const runFirst = { ...deps, lockState: () => held(record(7, 3 * SHARD_BYTES)), held: () => 0.4 * GB };
    const gateFirst = { ...deps, lockState: () => held(gateJob), held: () => 0.4 * GB };
    expect(admissionRefusal(gate, runFirst)).toContain('REFUSED');
    expect(admissionRefusal(runRequest(3), gateFirst)).toContain('REFUSED');
  });

  it('decides them the same on a Mac, where no /proc can say what a job holds', () => {
    // The breaker's probe: vm_stat reading 9.0 GB, and the first job's tree unreadable. Before, an
    // unreadable tree promised nothing, and both orders were ADMITTED: 10.5 GB of need on 9.0 GB.
    const pages = Math.round((9.0 * GB) / 16384);
    const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${pages}.\n`;
    const mac = { platform: 'darwin', vmStat: () => vmStat, freemem: () => 0, env: {}, held: () => undefined };
    const gate = vitestRequest(3);
    const gateJob: BenchLockRecord = { ...record(7, gate.needBytes), tiers: [], whole: false, kind: 'job' };
    expect(admissionRefusal(runRequest(3), { ...mac, lockState: () => held(gateJob) })).toContain('REFUSED');
    expect(admissionRefusal(gate, { ...mac, lockState: () => held(record(7, 3 * SHARD_BYTES)) })).toContain('REFUSED');
    expect(admissionRefusal(runRequest(3), { ...mac, lockState: freeRegister })).toBeUndefined();
  });
});
