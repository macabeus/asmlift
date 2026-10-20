// The default shard count (src/run/default-jobs.ts): bounded by CPUs, by physical memory, by the
// memory available now, and by the cap. Every reading is injected — the test must not depend on what
// else this host is running.
import { describe, expect, it } from 'vitest';

import { RESERVE_BYTES, SHARD_BYTES } from '../src/run/admission';
import { MAX_DEFAULT_JOBS, defaultJobs } from '../src/run/default-jobs';

const GiB = 1024 ** 3;

const avail = (bytes: number) => ({ availableBytes: bytes, how: 'test' });
const plenty = avail(1024 * GiB);

describe('defaultJobs', () => {
  it('starts 3 shards on an 8-thread host with 7.5 GiB, where 8 ran it out of memory', () => {
    expect(defaultJobs(8, 7.5 * GiB, plenty)).toBe(3);
  });

  it('still starts 3 on this host quiet (MemAvailable 5.1 GiB + half of 9.4 GiB free swap)', () => {
    expect(defaultJobs(8, 7879056 * 1024, avail(5368340 * 1024 + (9899436 * 1024) / 2))).toBe(3);
  });

  it('starts fewer beside another heavy job, sized from what is available less the reserve', () => {
    expect(defaultJobs(8, 7.5 * GiB, avail(2 * SHARD_BYTES + RESERVE_BYTES))).toBe(2);
    expect(defaultJobs(8, 7.5 * GiB, avail(2 * SHARD_BYTES + RESERVE_BYTES - 1))).toBe(1);
  });

  it('is bounded by physical memory however much swap makes available', () => {
    expect(defaultJobs(16, 8 * GiB, plenty)).toBe(3);
  });

  it('is bounded by the CPU count when memory is plentiful', () => {
    expect(defaultJobs(4, 64 * GiB, plenty)).toBe(4);
  });

  it('never exceeds the cap', () => {
    expect(defaultJobs(32, 128 * GiB, plenty)).toBe(MAX_DEFAULT_JOBS);
  });

  it('starts at least one shard however little memory there is — admission refuses, not this', () => {
    expect(defaultJobs(8, 1 * GiB, plenty)).toBe(1);
    expect(defaultJobs(0, 16 * GiB, plenty)).toBe(1);
    expect(defaultJobs(8, 16 * GiB, avail(0))).toBe(1);
  });
});
