// The playground's ranking ends at a failure every candidate would share: a dead objdiff engine,
// or a target it cannot parse. The scorer and its engine are real. `agbcc` is replaced whole, as
// candidate-compile.test.ts explains: it assembles to and compiles to fixed objects.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { EngineFailedError, UndiffableError, createScorer, loadEngine } from '@matchkit/scoring';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

import { rankCandidatesInBrowser } from '../src/pages/playground/score-wasm';

const objects = join(import.meta.dirname, '../../../packages/cli/test/offline/fixtures/objdiff');
const read = (name: string) => new Uint8Array(readFileSync(join(objects, name)));

const state = vi.hoisted(() => ({
  compiles: 0,
  target: new Uint8Array(),
  candidate: new Uint8Array(),
  onCompile: undefined as (() => void) | undefined,
}));

vi.mock('agbcc', () => ({
  assemble: async () => ({ ok: true, obj: state.target, stderr: '' }),
  compileToObject: async () => {
    state.compiles++;
    state.onCompile?.();
    return { ok: true, obj: state.candidate, stderr: '' };
  },
  preloadAgbcc: async () => {},
}));

const asm = readFileSync(join(import.meta.dirname, '../../../packages/core/test/corpus/agbcc-clamp0.s'), 'utf8');
beforeEach(() => {
  state.compiles = 0;
  state.target = read('target.o');
  state.candidate = read('candidate-diff.o');
  state.onCompile = undefined;
});

test('a target the engine cannot parse ends the ranking before any compile', async () => {
  state.target = new TextEncoder().encode('not an object');
  await expect(rankCandidatesInBrowser('clamp0', asm, ARMV4T_AGBCC, [])).rejects.toThrow(UndiffableError);
  expect(state.compiles).toBe(0);
});

// Last: it kills the engine this file shares.
test('an engine that dies during the ranking ends it at the first score', async () => {
  const scorer = createScorer(await loadEngine());
  const target = scorer.parseTarget(read('target.o'));
  state.onCompile = () => {
    state.onCompile = undefined;
    for (let panics = 0; panics < 20_000; panics++) {
      try {
        scorer.score(target, read('candidate-odd-size.o'), 'add_one');
      } catch (error) {
        if (error instanceof EngineFailedError) {
          return;
        }
      }
    }
    throw new Error('the engine survived 20,000 panics');
  };
  await expect(rankCandidatesInBrowser('clamp0', asm, ARMV4T_AGBCC, [])).rejects.toThrow(EngineFailedError);
  expect(state.compiles).toBe(1);
}, 60_000);
