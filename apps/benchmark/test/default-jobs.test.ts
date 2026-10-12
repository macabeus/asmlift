// The default shard count (src/run/default-jobs.ts): bounded by CPUs, by memory, and by the cap.
import { describe, expect, it } from 'vitest';

import { MAX_DEFAULT_JOBS, defaultJobs } from '../src/run/default-jobs';

const GiB = 1024 ** 3;

describe('defaultJobs', () => {
  it('starts 3 shards on an 8-thread host with 7.5 GiB, where 8 ran it out of memory', () => {
    expect(defaultJobs(8, 7.5 * GiB)).toBe(3);
  });

  it('is bounded by the CPU count when memory is plentiful', () => {
    expect(defaultJobs(4, 64 * GiB)).toBe(4);
  });

  it('never exceeds the cap', () => {
    expect(defaultJobs(32, 128 * GiB)).toBe(MAX_DEFAULT_JOBS);
  });

  it('starts at least one shard however little memory there is', () => {
    expect(defaultJobs(8, 1 * GiB)).toBe(1);
    expect(defaultJobs(0, 16 * GiB)).toBe(1);
  });
});
