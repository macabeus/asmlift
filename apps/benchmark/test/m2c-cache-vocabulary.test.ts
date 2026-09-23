// The outcome classifier runs INSIDE the cached m2c computation, so the marker table it reads is
// an input to every entry on disk. It used to be carried by `cache.ts`'s hand-bumped `v`, and the
// one time that mattered nobody bumped it: `SECOND_REG` joined `DECLINE_MARKERS`, four rows
// re-ran for unrelated reasons, and `synthetic:llpass:agbcc` replayed a v20 entry — published as
// `nonmatch` with a score, over source the same commit's rule declines.
//
// So the table is keyed as DATA (`DECLINE_VOCABULARY`) and misses naturally. This is the gate for
// that: swap the vocabulary and the same inputs must RECOMPUTE, not replay. The second half is the
// one that would go quietly wrong — a `markers` field the key builder drops would still pass the
// first half of any test that only checked a hit.
import type { DecompilerResult } from '@asmlift/bench-schema';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

import { DECLINE_VOCABULARY } from '../src/eval/outcome';

const scratch = mkdtempSync(join(tmpdir(), 'm2c-cache-vocab-'));
const saved = { m2c: process.env.ASMLIFT_M2C_DIR, cache: process.env.ASMLIFT_BENCH_CACHE };
let cacheDir: string;
let before: Set<string>;

const result = (source: string): DecompilerResult => ({
  decompiler: 'm2c',
  outcome: 'nonmatch',
  source,
  score: 8,
  maxScore: 11,
  compileErrors: null,
  quality: { score: 100, lines: 1, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 },
});

beforeAll(async () => {
  // The key names the m2c checkout's commit and refuses a dirty one; an empty repository is clean.
  const m2c = join(scratch, 'm2c');
  const identity = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  spawnSync('git', ['init', '-q', m2c]);
  spawnSync('git', ['-C', m2c, ...identity, 'commit', '-q', '--allow-empty', '-m', '.']);
  process.env.ASMLIFT_M2C_DIR = m2c;
  delete process.env.ASMLIFT_BENCH_CACHE;
  cacheDir = (await import('../src/config')).CACHE_DIR;
  mkdirSync(cacheDir, { recursive: true });
  before = new Set(readdirSync(cacheDir));
});

afterAll(() => {
  for (const f of readdirSync(cacheDir)) {
    if (f.startsWith('m2c-') && !before.has(f)) {
      rmSync(join(cacheDir, f), { force: true });
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    const key = k === 'm2c' ? 'ASMLIFT_M2C_DIR' : 'ASMLIFT_BENCH_CACHE';
    if (v === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = v;
    }
  }
  vi.resetModules();
  vi.doUnmock('../src/eval/outcome');
});

// Widening a pattern reclassifies rows exactly as adding a marker does, so the regex SOURCE has to
// be in the string and not only the name — a vocabulary built from names alone would serve a stale
// label for every row a widened pattern newly claims.
test('the vocabulary carries every marker name AND every pattern', async () => {
  const { declineMarkersIn } = await import('../src/eval/outcome');
  for (const name of ['ASMLIFT_ERROR', 'M2C_ERROR', 'M2C_CARRY', 'SECOND_REG', '? placeholder']) {
    expect(DECLINE_VOCABULARY).toContain(name);
  }
  expect(DECLINE_VOCABULARY).toContain('SECOND_REG=SECOND_REG');
  expect(declineMarkersIn('x = SECOND_REG(y);')).toEqual(['SECOND_REG']);
});

test('a changed marker vocabulary is a MISS, and an unchanged one is a hit', async () => {
  // the asm names the scratch directory, so this test's keys are its own
  const obj = join(scratch, 'sym.o');
  rmSync(obj, { force: true });
  mkdirSync(join(scratch, 'o'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(obj, 'target object');
  const inputs = { tcId: 'agbcc', cflags: ['-O2'], sym: 'sym', asm: `\tbx lr @ ${scratch}\n`, obj } as const;

  const run = async (vocabulary: string, source: string, computed: string[]) => {
    vi.resetModules();
    vi.doMock('../src/eval/outcome', async () => ({
      ...(await vi.importActual<typeof import('../src/eval/outcome')>('../src/eval/outcome')),
      DECLINE_VOCABULARY: vocabulary,
    }));
    const cache = await import('../src/cache');
    return cache.cachedM2cResult(inputs, () => (computed.push(source), result(source)));
  };

  const computed: string[] = [];
  expect((await run('A', 'first', computed)).source).toBe('first');
  // same vocabulary, same inputs → served, and the second compute never runs
  expect((await run('A', 'second', computed)).source).toBe('first');
  // a marker added → the entry is a different question and must be asked again
  expect((await run('A\nSECOND_REG=SECOND_REG', 'third', computed)).source).toBe('third');
  expect(computed).toEqual(['first', 'third']);
});
