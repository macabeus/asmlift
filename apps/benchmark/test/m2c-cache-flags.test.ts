// The m2c half of a row is cached by everything its result depends on, and the flags m2c's
// candidate compiles with are one of those inputs. `sa3:sa2__sub_808558C:agbcc` is the case: its
// build unit (`src/game/math.c`) compiles at `-fhex-asm -mthumb-interwork -O2`, the target object
// is byte-identical to the one the canonical flags build, and m2c's candidate scores 15 there
// against 16 at the canonical flags, so a key without the flags serves the 16.
import type { DecompilerResult } from '@asmlift/bench-schema';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

const CANONICAL = ['-mthumb-interwork', '-Wimplicit', '-O2', '-fhex-asm', '-fprologue-bugfix'];
const MATH_C = ['-fhex-asm', '-mthumb-interwork', '-O2'];

const scored = (score: number): DecompilerResult => ({
  decompiler: 'm2c',
  outcome: 'nonmatch',
  source: 'int sa2__sub_808558C(void) { return 0; }',
  score,
  maxScore: 40,
  compileErrors: null,
  quality: { score: 100, lines: 1, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 },
});

const restore = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

const scratch = mkdtempSync(join(tmpdir(), 'm2c-cache-flags-'));
const saved = { m2c: process.env.ASMLIFT_M2C_DIR, cache: process.env.ASMLIFT_BENCH_CACHE };
let cache: typeof import('../src/cache');
let cacheDir: string;
let before: Set<string>;

beforeAll(async () => {
  // The key names the m2c checkout's commit and refuses a dirty one; an empty repository is clean.
  const m2c = join(scratch, 'm2c');
  const identity = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  spawnSync('git', ['init', '-q', m2c]);
  spawnSync('git', ['-C', m2c, ...identity, 'commit', '-q', '--allow-empty', '-m', '.']);
  process.env.ASMLIFT_M2C_DIR = m2c;
  delete process.env.ASMLIFT_BENCH_CACHE;
  vi.resetModules();
  cache = await import('../src/cache');
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
  restore('ASMLIFT_M2C_DIR', saved.m2c);
  restore('ASMLIFT_BENCH_CACHE', saved.cache);
  vi.resetModules();
});

test('a byte-identical target at other candidate flags is a miss, not the other flags’ result', () => {
  const obj = join(scratch, 'sa2__sub_808558C.o');
  writeFileSync(obj, 'the same target object at both flag sets');
  // the asm names the scratch directory, so this test's keys are its own
  const inputs = { tcId: 'agbcc', sym: 'sa2__sub_808558C', asm: `\tbx lr @ ${scratch}\n`, obj } as const;
  const computed: number[] = [];
  const run = (cflags: string[], score: number) =>
    cache.cachedM2cResult({ ...inputs, cflags }, () => (computed.push(score), scored(score)));

  expect(run(CANONICAL, 16).score).toBe(16);
  expect(run(MATH_C, 15).score).toBe(15);
  expect(run(CANONICAL, -1).score).toBe(16);
  expect(run(MATH_C, -1).score).toBe(15);
  expect(computed).toEqual([16, 15]);
});
