// A dead objdiff engine ends a ranking: it fails every later score, so no later candidate compiles.
// The engine is killed for real, by an object it panics on; vitest runs each file in its own worker.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { EngineFailedError, UndiffableError } from '@match-kit/scoring';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, expect, test } from 'vitest';

import { decompileRanked, decompileRankedParallel, enumerateRanked } from '../../src/rank';
import { scoreObjects } from '../../src/score';

const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', 'objdiff', name);
const TARGET = fixture('target.o');
const asm = readFileSync(join(import.meta.dirname, '../../../core/test/corpus/agbcc-clamp0.s'), 'utf8');

// More than one candidate, so stopping after the first is observable.
const fan = enumerateRanked('clamp0', asm, ARMV4T_AGBCC, {}).length;
let compiles = 0;
beforeEach(() => {
  compiles = 0;
});
const compile = async (): Promise<string> => {
  compiles++;
  return fixture('candidate-diff.o');
};

beforeAll(() => {
  for (let panics = 0; panics < 20_000; panics++) {
    try {
      scoreObjects(TARGET, fixture('candidate-odd-size.o'), 'add_one');
    } catch (error) {
      if (error instanceof EngineFailedError) {
        return;
      }
      expect(error).toBeInstanceOf(UndiffableError);
    }
  }
  throw new Error('the engine survived 20,000 panics');
}, 60_000);

test('the serial ranking stops at the failure and throws it', async () => {
  await expect(decompileRanked('clamp0', asm, ARMV4T_AGBCC, TARGET, { compile })).rejects.toThrow(EngineFailedError);
  expect(fan).toBeGreaterThan(1);
  expect(compiles).toBe(1);
});

test('the parallel ranking stops at the failure and throws it', async () => {
  await expect(
    decompileRankedParallel('clamp0', asm, ARMV4T_AGBCC, TARGET, {
      jobs: 1,
      worker: () => async () => compile(),
    }),
  ).rejects.toThrow(EngineFailedError);
  expect(fan).toBeGreaterThan(1);
  expect(compiles).toBe(1);
});
