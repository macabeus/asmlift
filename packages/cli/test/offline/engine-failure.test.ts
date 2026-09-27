// A dead objdiff engine ends a ranking: it fails every later score, so no later candidate compiles.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { EngineFailedError } from '@matchkit/scoring';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

import { decompileRanked, decompileRankedParallel, enumerateRanked } from '../../src/rank';

vi.mock('@matchkit/scoring/files', async () => {
  const { EngineFailedError } = await import('@matchkit/scoring');
  return {
    releaseTarget: () => {},
    scoreFiles: () => {
      throw new EngineFailedError();
    },
  };
});

const asm = readFileSync(join(import.meta.dirname, '../../../core/test/corpus/agbcc-clamp0.s'), 'utf8');
let compiles = 0;
beforeEach(() => {
  compiles = 0;
});
const compile = (): string => {
  compiles++;
  return '/nonexistent.o';
};

test('the fan has more than one candidate, so stopping at the first is observable', () => {
  expect(enumerateRanked('clamp0', asm, ARMV4T_AGBCC, { compile }).length).toBeGreaterThan(1);
});

test('the serial ranking stops at the failure and throws it', () => {
  expect(() => decompileRanked('clamp0', asm, ARMV4T_AGBCC, '/nonexistent.o', { compile })).toThrow(EngineFailedError);
  expect(compiles).toBe(1);
});

test('the parallel ranking stops at the failure and throws it', async () => {
  await expect(
    decompileRankedParallel('clamp0', asm, ARMV4T_AGBCC, '/nonexistent.o', {
      jobs: 1,
      worker: () => async () => compile(),
    }),
  ).rejects.toThrow(EngineFailedError);
  expect(compiles).toBe(1);
});
