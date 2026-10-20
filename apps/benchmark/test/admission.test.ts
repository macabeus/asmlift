// The memory admission check every heavy command calls (src/run/admission.ts). Every reading here is
// INJECTED: a test that read this machine's /proc/meminfo would pass or fail on whatever else the
// host happens to be running.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../src/config';
import {
  ADMISSION_ENV,
  type MemoryReading,
  PEAK_BYTES,
  RESERVE_BYTES,
  SHARD_BYTES,
  admissionRefusal,
  admissionVerdict,
  parseMeminfo,
  readAvailableMemory,
  unitsThatFit,
  vitestRequest,
} from '../src/run/admission';

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

const meminfo = (memAvailableKb: number, swapFreeKb: number): string =>
  `MemTotal: 7879056 kB\nMemAvailable: ${memAvailableKb} kB\nSwapFree: ${swapFreeKb} kB\n`;

const linux = (text: string) => ({ platform: 'linux', meminfo: () => text, freemem: () => 0 });

const runRequest = (shards: number) => ({
  command: 'bench run',
  needBytes: shards * SHARD_BYTES,
  need: `${shards} shards × 2.5 GB`,
  instead: 'run fewer shards',
});

describe('parseMeminfo', () => {
  it('reads MemAvailable and SwapFree in bytes', () => {
    expect(parseMeminfo(QUIET_MEMINFO)).toEqual({ memAvailable: 5368340 * kB, swapFree: 9899436 * kB });
  });

  it('has no answer without MemAvailable (a kernel before 3.14)', () => {
    expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 500 kB\n')).toBeUndefined();
  });

  it('reads a missing SwapFree as no swap', () => {
    expect(parseMeminfo('MemAvailable: 1000 kB\n')).toEqual({ memAvailable: 1000 * kB, swapFree: 0 });
  });
});

describe('readAvailableMemory', () => {
  it('counts MemAvailable plus half of the free swap on Linux', () => {
    const r = readAvailableMemory(linux(QUIET_MEMINFO));
    expect(r.availableBytes).toBe(5368340 * kB + Math.floor((9899436 * kB) / 2));
    expect(r.how).toContain('MemAvailable');
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

  it('reads os.freemem() and never /proc/meminfo on macOS', () => {
    const r = readAvailableMemory({
      platform: 'darwin',
      meminfo: () => {
        throw new Error('macOS has no /proc/meminfo, and this reader must not be called');
      },
      freemem: () => 6 * GB,
    });
    expect(r.availableBytes).toBe(6 * GB);
  });
});

describe('admissionVerdict', () => {
  const reading = (bytes: number): MemoryReading => ({ availableBytes: bytes, how: 'test' });

  it('admits a request that fits beside the reserve, and refuses one that does not', () => {
    expect(admissionVerdict(runRequest(1), reading(SHARD_BYTES + RESERVE_BYTES))).toBeUndefined();
    expect(admissionVerdict(runRequest(1), reading(SHARD_BYTES + RESERVE_BYTES - 1))).toContain('REFUSED');
  });

  it('admits a solo `bench run --jobs 3` on this host quiet, which has run safely for weeks', () => {
    expect(admissionVerdict(runRequest(3), readAvailableMemory(linux(QUIET_MEMINFO)))).toBeUndefined();
  });

  it('refuses the 13:18 pair: a whole-corpus sweep --base started beside a --jobs 3 run', () => {
    // The quiet host, less the ~8.0 GB the run held at the OOM, taken out of RAM first and then swap.
    const runHeld = 8.0 * GB;
    const ram = 5368340 * kB;
    const swap = 9899436 * kB - (runHeld - ram);
    const beside = readAvailableMemory(linux(meminfo(0, Math.floor(swap / kB))));
    const sweepBase = { command: 'bench sweep', needBytes: 2 * PEAK_BYTES.sweepPass, need: '2 passes' };
    expect(admissionVerdict(sweepBase, beside)).toContain('bench sweep REFUSED');
  });

  it('names the need, what is available, how it was read, and the way forward', () => {
    const text = admissionVerdict(runRequest(3), { availableBytes: 4 * GB, how: 'MemAvailable 4.0 GB' })!;
    expect(text).toContain('~7.5 GB');
    expect(text).toContain('3 shards × 2.5 GB');
    expect(text).toContain('3.5 GB to give');
    expect(text).toContain('MemAvailable 4.0 GB');
    expect(text).toContain('run fewer shards');
    expect(text).toContain(`${ADMISSION_ENV}=off`);
  });

  it('never prints a negative amount to give', () => {
    expect(admissionVerdict(runRequest(1), { availableBytes: 0, how: 'none' })).toContain('0.0 GB to give');
  });
});

describe('admissionRefusal', () => {
  const starved = { ...linux(meminfo(100_000, 0)) };

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

describe('the vitest gate entry point', () => {
  it('prices the workers it is given', () => {
    expect(vitestRequest(3).needBytes).toBe(3 * PEAK_BYTES.vitestWorker);
  });

  it('runs from the gate script and exits 0 when the check is off', () => {
    const r = spawnSync(
      join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      [join(REPO_ROOT, 'apps/benchmark/src/run/admission.ts'), 'vitest', '3'],
      { encoding: 'utf8', env: { ...process.env, [ADMISSION_ENV]: 'off' } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`${ADMISSION_ENV}=off`);
  });

  it('exits 2 on an argument it does not know', () => {
    const r = spawnSync(
      join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      [join(REPO_ROOT, 'apps/benchmark/src/run/admission.ts'), 'bogus'],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
  });
});
