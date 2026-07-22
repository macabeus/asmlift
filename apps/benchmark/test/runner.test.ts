// Pin tests for the runner's pure pieces: the shard math the orchestrator's parent/child
// contract rides on, the ONE meta builder, and the no-silent-row-loss build-fail contract.
import type { FunctionResult } from '@asmlift/bench-schema';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { Case } from '../src/cases/types';
import { benchMeta, inShard, parseShard, runCases } from '../src/run/runner';

describe('parseShard (pinned)', () => {
  test('parses i/N', () => {
    expect(parseShard('0/1')).toEqual({ idx: 0, n: 1 });
    expect(parseShard('3/8')).toEqual({ idx: 3, n: 8 });
  });

  test('rejects malformed input loudly', () => {
    for (const bad of ['8/8', '-1/4', '2', 'a/b', '1/0', '']) {
      expect(() => parseShard(bad), bad).toThrow(/bad --shard/);
    }
  });

  test('inShard partitions every index into exactly one shard', () => {
    const idxs = Array.from({ length: 17 }, (_, i) => i);
    for (const i of idxs) {
      expect([0, 1, 2].filter((s) => inShard(i, { idx: s, n: 3 }))).toHaveLength(1);
    }
    const union = [0, 1, 2].flatMap((s) => idxs.filter((i) => inShard(i, { idx: s, n: 3 })));
    expect(union.sort((a, b) => a - b)).toEqual(idxs);
  });
});

describe('runCases toolchain availability (pinned)', () => {
  test('an unavailable toolchain skips its case — no row, no throw', () => {
    const c: Case = {
      id: 'synthetic:ghost:agbcc',
      tier: 'synthetic',
      sym: 'ghost',
      project: 'synthetic',
      language: 'c',
      features: [],
      loc: 1,
      refSource: 'int ghost;',
      toolchain: { available: () => false } as Case['toolchain'],
      build: () => {
        throw new Error('build must never run for an unavailable toolchain');
      },
    };
    const outPath = join(mkdtempSync(join(tmpdir(), 'bench-runner-test-')), 'part.json');
    const results = runCases([c], outPath);
    expect(results).toEqual([]);
    expect(JSON.parse(readFileSync(outPath, 'utf8')).results).toEqual([]);
  });
});

describe('runCases build failures (pinned)', () => {
  test('a target that cannot build fails the shard loudly, after flushing the other rows', () => {
    const c: Case = {
      id: 'synthetic:ghost:mwcc_242_81',
      tier: 'synthetic',
      sym: 'ghost',
      project: 'synthetic',
      language: 'c++',
      features: ['c++'],
      loc: 1,
      refSource: 'int ghost;',
      toolchain: { available: () => true } as Case['toolchain'],
      build: () => {
        throw new Error('mwcceppc (docker) failed: syntax error');
      },
    };
    const outPath = join(mkdtempSync(join(tmpdir(), 'bench-runner-test-')), 'part.json');
    expect(() => runCases([c], outPath)).toThrow(/1 target build\(s\) failed .* synthetic:ghost:mwcc_242_81/);
    // the part file is still written, so surviving rows are never lost to the throw
    expect(JSON.parse(readFileSync(outPath, 'utf8')).results).toEqual([]);
  });
});

describe('benchMeta (pinned)', () => {
  test('counts tiers and dedupes toolchains', () => {
    const rows = [
      { tier: 'synthetic', toolchain: 'agbcc' },
      { tier: 'synthetic', toolchain: 'ido7.1' },
      { tier: 'real', toolchain: 'agbcc' },
    ] as FunctionResult[];
    const m = benchMeta(rows);
    expect(m.counts).toEqual({ total: 3, synthetic: 2, real: 1 });
    expect(m.toolchains).toEqual(['agbcc', 'ido7.1']);
    // no machine identity in published artifacts (meta must never carry a hostname)
    expect(m).not.toHaveProperty('host');
  });
});
