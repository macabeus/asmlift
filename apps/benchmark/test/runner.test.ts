// Pin tests for the runner's pure pieces: the shard math the orchestrator's parent/child
// contract rides on, the ONE meta builder, and the no-silent-row-loss build-fail contract.
import type { DecompilerResult, FunctionResult } from '@asmlift/bench-schema';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { Case } from '../src/cases/types';
import { benchMeta, fmt, inShard, parseShard, runCases } from '../src/run/runner';

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

  test('writeEmpty: false leaves an EXISTING tier file byte-for-byte alone when every row SKIPs', () => {
    // The default above is the shard CHILD's contract: a part file is always written and the
    // stitcher owns <tier>.json. The serial path writes <tier>.json DIRECTLY, and a row that is
    // SELECTED and then SKIPPED walks past cli.ts's `cases.length === 0` guard with cases.length
    // > 0 and 0 results — which replaced a 594-row synthetic.json with a 287-byte `results: []`
    // and exited 0, and the next `bench merge` published the other tier alone. The loss is
    // SILENT, so only a test that puts real content in the file first can see it.
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
    const outPath = join(mkdtempSync(join(tmpdir(), 'bench-runner-test-')), 'synthetic.json');
    const sentinel = JSON.stringify({ meta: { counts: { total: 1 } }, results: [{ id: 'synthetic:kept:agbcc' }] });
    writeFileSync(outPath, sentinel);

    expect(runCases([c], outPath, { idx: 0, n: 1 }, { writeEmpty: false })).toEqual([]);
    expect(readFileSync(outPath, 'utf8'), 'the previous tier file survives a run that measured nothing').toBe(sentinel);

    // …and the DEFAULT still clobbers it, which is what makes `writeEmpty: false` the load-bearing
    // half rather than a flag that happens to agree with the behaviour either way.
    expect(runCases([c], outPath)).toEqual([]);
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

// A gap's score is a numerator over a denominator that MOVES: `maxScore` is the objdiff row count
// of the winning candidate's alignment, so a better candidate changes it (404 → 387 on
// `kleod:CountCollectedGems:agbcc`). A line printing only the numerator reads as a subtraction on
// a fixed scale, and that reading sent an attribution round hunting for capability gaps to explain
// a denominator move.
describe('fmt renders a gap over its denominator', () => {
  const d = (over: Partial<DecompilerResult>): DecompilerResult =>
    ({ outcome: 'nonmatch', ...over }) as DecompilerResult;

  test('a scored gap prints score/maxScore', () => {
    expect(fmt(d({ score: 171, maxScore: 387 }))).toBe('diff:171/387');
    expect(fmt(d({ score: 290, maxScore: 404 }))).toBe('diff:290/404');
  });

  test('an unscored denominator degrades to the bare numerator rather than printing null', () => {
    expect(fmt(d({ score: 12, maxScore: null }))).toBe('diff:12');
  });

  // The artifact types it `number | null`, but this renderer also runs over hand-built and older
  // objects where the key is simply ABSENT, and `diff:12/undefined` is a worse answer than
  // `diff:12`.
  test('an ABSENT denominator degrades the same way a null one does', () => {
    expect(fmt(d({ score: 12, maxScore: undefined as unknown as null }))).toBe('diff:12');
  });

  test('the other outcomes are untouched', () => {
    expect(fmt(d({ outcome: 'match' }))).toBe('MATCH');
    expect(fmt(d({ outcome: 'noncompile', compileErrors: 3 }))).toBe('noncompile(3)');
    expect(fmt(d({ outcome: 'declined', errorMarkers: ['a', 'b'] }))).toBe('declined(2 gap(s))');
    expect(fmt(d({ outcome: 'failed' }))).toBe('failed');
  });
});
