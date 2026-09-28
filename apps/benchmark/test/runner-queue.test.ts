// `runCases` off a tier's shared queue (src/run/queue.ts), on real agbcc rows: the claims a shard
// respects, the numbering every shard's lines share, and the journal a `--resume` continues from.
// No module is mocked, so this needs agbcc and skips without it.
import type { FunctionResult } from '@asmlift/bench-schema';
import { agbccAvailable } from '@asmlift/toolchains';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { syntheticCases } from '../src/cases/synthetic';
import {
  claimer,
  journalRows,
  partPath,
  planCases,
  readJournal,
  readPlan,
  releaseUnfinished,
  unaccounted,
  writePlan,
} from '../src/run/queue';
import { runCases } from '../src/run/runner';

const IDS = ['synthetic:divc:agbcc', 'synthetic:udivc:agbcc', 'synthetic:divv:agbcc'];

describe.skipIf(!agbccAvailable())('a shard taking rows off the queue', () => {
  test('measures only unclaimed rows, numbered by queue place, and a resume measures exactly the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-runner-queue-'));
    writePlan(dir, { commit: 'c0ffee', ids: IDS });
    const cases = planCases(dir, syntheticCases({ toolchain: 'agbcc' }));
    // a shard that died holding row 1: its claim is on disk, its row in no part file
    writeFileSync(join(dir, 'claims', '1'), 'dead shard');

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(l));
    try {
      const first = runCases(cases, partPath(dir, 0, 0), { claimer: claimer(dir, 's0'), tag: ' s0' });
      expect(first.map((r: FunctionResult) => r.id)).toEqual([IDS[0], IDS[2]]);
      expect(lines.filter((l) => l.startsWith('[')).map((l) => l.split(' ')[0])).toEqual(['[1/3]', '[3/3]']);

      const plan = readPlan(dir)!;
      const journal = journalRows(readJournal(dir).parts);
      expect(unaccounted(plan, journal)).toEqual([IDS[1]]);
      expect(releaseUnfinished(dir, plan, new Set(journal.results.map((r) => r.id)))).toBe(1);

      lines.length = 0;
      const resumed = runCases(cases, partPath(dir, 1, 0), { claimer: claimer(dir, 's0'), tag: ' s0' });
      expect(resumed.map((r: FunctionResult) => r.id)).toEqual([IDS[1]]);
      expect(lines.filter((l) => l.startsWith('[')).map((l) => l.split(' ')[0])).toEqual(['[2/3]']);
      expect(unaccounted(plan, journalRows(readJournal(dir).parts))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});
