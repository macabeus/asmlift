// The fanned run's row queue (src/run/queue.ts): the claim order, the exclusive claims every shard
// takes rows through, and the journal a `--resume` continues from. Everything here is files in a
// scratch directory — the same files the shard children write, without a child.
import type { FunctionResult } from '@asmlift/bench-schema';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type Plan,
  claimOrder,
  claimer,
  journalRows,
  liveClaimers,
  partPath,
  readJournal,
  readPlan,
  recordedRankSeconds,
  releaseUnfinished,
  resumeRefusal,
  unaccounted,
  writePlan,
} from '../src/run/queue';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'bench-queue-test-'));
const row = (id: string): FunctionResult => ({ id, asmlift: {}, m2c: {} }) as FunctionResult;
const part = (dir: string, gen: number, shard: number, ids: string[], commit = 'c0ffee'): void =>
  writeFileSync(
    partPath(dir, gen, shard),
    JSON.stringify({ meta: { asmlift: { commit, dirty: false } }, results: ids.map(row) }),
  );

describe('the claim order', () => {
  it('puts the rows the artifact never priced first, then the dearest, and keeps dataset order on ties', () => {
    const secs = recordedRankSeconds([
      { id: 'cheap', asmlift: { rankSeconds: 1 } },
      { id: 'dear', asmlift: { rankSeconds: 900 } },
      { id: 'declined', asmlift: {} },
      { id: 'mid', asmlift: { rankSeconds: 30 } },
    ] as FunctionResult[]);
    expect(claimOrder(['cheap', 'new1', 'dear', 'declined', 'mid', 'new2'], secs)).toEqual([
      'new1',
      'declined',
      'new2',
      'dear',
      'mid',
      'cheap',
    ]);
  });
});

describe('the claims', () => {
  it('hand every row to exactly one of several claimers, whichever asks first', () => {
    const dir = scratch();
    writePlan(dir, { commit: 'c', ids: ['a', 'b', 'c', 'd', 'e'] });
    const one = claimer(dir, 'one');
    const two = claimer(dir, 'two');
    const got: [string, number][] = [];
    // interleaved unevenly, as a slow shard and a fast one would ask
    for (const who of [one, one, two, one, two, two, one, two]) {
      const k = who.claim();
      if (k !== undefined) {
        got.push([who === one ? 'one' : 'two', k]);
      }
    }
    expect(got.map(([, k]) => k).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(got).toEqual([
      ['one', 0],
      ['one', 1],
      ['two', 2],
      ['one', 3],
      ['two', 4],
    ]);
    expect(one.claim()).toBeUndefined();
  });

  it('stop once the orchestrator is gone, so an orphaned shard cannot race a resume', () => {
    const dir = scratch();
    writePlan(dir, { commit: 'c', ids: ['a', 'b'] });
    const gone = spawnSync('true').pid!;
    expect(claimer(dir, 'orphan', gone).claim()).toBeUndefined();
    expect(claimer(dir, 'live', process.pid).claim()).toBe(0);
  });
});

describe('the journal and --resume', () => {
  const plan: Plan = { commit: 'c0ffee', only: 'x', ids: ['a', 'b', 'c', 'd'] };

  it('refuses a resume on another commit or another selection, and one with nothing to resume', () => {
    expect(resumeRefusal(plan, { commit: 'c0ffee', only: 'x' })).toBeUndefined();
    expect(resumeRefusal(plan, { commit: 'deadbeef', only: 'x' })).toMatch(/measured c0ffee and HEAD is deadbeef/);
    expect(resumeRefusal(plan, { commit: 'c0ffee' })).toMatch(/--only x .* --only \(none\)/);
    expect(resumeRefusal(undefined, { commit: 'c0ffee' })).toMatch(/no unfinished run/);
    expect(resumeRefusal({ ...plan, commit: 'unknown' }, { commit: 'unknown', only: 'x' })).toMatch(
      /cannot say which commit/,
    );
  });

  it('re-queues exactly the claims no part file finished, and the next generation keeps the old rows', () => {
    const dir = scratch();
    writePlan(dir, plan);
    const c = claimer(dir, 'dead run');
    [0, 1, 2].forEach(() => c.claim());
    part(dir, 0, 0, ['a']);
    part(dir, 0, 1, ['c']);
    // `b` (claim 1) was in flight when the run died; `d` was never claimed
    const journal = readJournal(dir);
    expect(journal.nextGen).toBe(1);
    const done = new Set(journalRows(journal.parts).results.map((r) => r.id));
    expect(releaseUnfinished(dir, readPlan(dir)!, done)).toBe(1);
    expect(readdirSync(join(dir, 'claims')).sort()).toEqual(['0', '2']);

    const resumed = claimer(dir, 'resumed');
    expect([resumed.claim(), resumed.claim(), resumed.claim()]).toEqual([1, 3, undefined]);
    part(dir, 1, 0, ['b', 'd']);
    const all = journalRows(readJournal(dir).parts);
    expect(all.results.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(all.stamps).toHaveLength(3);
    expect(all.repeated).toBe(0);
  });

  it('blocks a run only on an unfinished claim held by a live shard child, never on a recycled pid', async () => {
    const dir = scratch();
    writePlan(dir, { commit: 'c', ids: ['a', 'b', 'c', 'd'] });
    const idle = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    const shard = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'cli.ts', 'run', '--claim', '0']);
    try {
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(join(dir, 'claims', '0'), 'pid 1 shard 0');
      writeFileSync(join(dir, 'claims', '1'), `pid ${idle.pid} shard 1`);
      writeFileSync(join(dir, 'claims', '2'), `pid ${shard.pid} shard 2`);
      writeFileSync(join(dir, 'claims', '3'), `pid ${shard.pid} shard 2`);
      part(dir, 0, 2, ['c']);
      expect(liveClaimers(dir)).toEqual([`${shard.pid} (pid ${shard.pid} shard 2)`]);
      part(dir, 1, 2, ['d']);
      expect(liveClaimers(dir)).toEqual([]);
    } finally {
      idle.kill();
      shard.kill();
    }
  });

  it('accounts a skipped row as accounted, and a claimed-but-unwritten one as not', () => {
    const dir = scratch();
    writeFileSync(
      partPath(dir, 0, 0),
      JSON.stringify({ meta: { asmlift: undefined }, results: [row('a')], skipped: ['b'] }),
    );
    const plan: Plan = { commit: 'c', ids: ['a', 'b', 'c'] };
    expect(unaccounted(plan, journalRows(readJournal(dir).parts))).toEqual(['c']);
  });

  it('counts a row two generations both measured, and keeps the later one', () => {
    const dir = scratch();
    part(dir, 0, 0, ['a']);
    part(dir, 1, 0, ['a']);
    expect(journalRows(readJournal(dir).parts).repeated).toBe(1);
  });

  it('reads an absent run directory as an empty journal', () => {
    const dir = join(scratch(), 'nope');
    expect(readJournal(dir)).toEqual({ parts: [], nextGen: 0 });
    expect(existsSync(dir)).toBe(false);
  });
});
