// The playground's ranking ends at a failure every candidate would share: a dead objdiff engine,
// or a target it cannot parse. Recorded per candidate, either one compiled the rest of the fan in
// the browser for nothing, then reported "no scorable candidate".
// `agbcc` is replaced whole: the real package cannot be imported under vitest's ESM loader
// (candidate-compile.test.ts says why).
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { EngineFailedError, UndiffableError } from '@matchkit/scoring';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

import { rankCandidatesInBrowser } from '../src/pages/playground/score-wasm';

const state = vi.hoisted(() => ({ compiles: 0, failure: 'engine' as 'engine' | 'target' }));

vi.mock('agbcc', () => ({
  assemble: async () => ({ ok: true, obj: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), stderr: '' }),
  compileToObject: async () => {
    state.compiles++;
    return { ok: true, obj: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), stderr: '' };
  },
  preloadAgbcc: async () => {},
}));

vi.mock('@matchkit/scoring', async (importOriginal) => {
  const real = await importOriginal<typeof import('@matchkit/scoring')>();
  return {
    ...real,
    loadEngine: async () => ({}),
    createScorer: () => ({
      parseTarget: () => {
        if (state.failure === 'target') {
          throw new real.UndiffableError('the target object could not be parsed: Could not read file magic');
        }
        return { dispose: () => {} };
      },
      score: () => {
        throw new real.EngineFailedError();
      },
    }),
  };
});

const asm = readFileSync(join(import.meta.dirname, '../../../packages/core/test/corpus/agbcc-clamp0.s'), 'utf8');
beforeEach(() => {
  state.compiles = 0;
});

test('a dead engine ends the ranking after the first score', async () => {
  state.failure = 'engine';
  await expect(rankCandidatesInBrowser('clamp0', asm, ARMV4T_AGBCC, [])).rejects.toThrow(EngineFailedError);
  expect(state.compiles).toBe(1);
});

test('a target the engine cannot parse ends the ranking before any compile', async () => {
  state.failure = 'target';
  await expect(rankCandidatesInBrowser('clamp0', asm, ARMV4T_AGBCC, [])).rejects.toThrow(UndiffableError);
  expect(state.compiles).toBe(0);
});
