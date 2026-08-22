// `decompileRankedParallel` must be the SAME ranking as `decompileRanked` — only the candidate
// compiles move off the main thread. A pooled run is what the out-of-harness ranked enumeration
// uses (a 20k-candidate function is ~85% subprocess), so a divergence here would mean a round
// planning on a number the benchmark's serial path never produces.
//
// The pool's own concurrency (one scratch slot per worker, one shared world probe) is pinned
// offline in test/offline/compile-command.test.ts; what THIS suite can pin, with the real
// toolchain, is the property that matters downstream: identical winner, identical per-candidate
// scores in identical order, identical drops.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileCandAgbcc, compileTargetAsm } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked, decompileRankedParallel } from '../../src/rank';

// the registered agbcc candidate compiler, handed to the pool as its per-worker compiler
const worker = () => async (source: string) => compileCandAgbcc(source);

const bothWays = async (sym: string, src: string) => {
  const asm = compileTargetAsm(src);
  const obj = assembleTarget(asm);
  const serial = decompileRanked(sym, asm, ARMV4T_AGBCC, obj);
  const pooled = await decompileRankedParallel(sym, asm, ARMV4T_AGBCC, obj, { jobs: 4, worker });
  return { serial, pooled };
};

describe('the pooled ranked run is the serial ranked run', () => {
  test('a multi-candidate function ranks identically, candidate for candidate', async () => {
    // `||` short-circuit: both branch senses are emitted, so the set is genuinely multi-candidate
    // and the winner is decided by score rather than by being the only survivor
    const { serial, pooled } = await bothWays('ifor', 'int ifor(int a, int b){ if (a || b) return 42; return 7; }');
    expect(pooled.candidates.length).toBeGreaterThan(1);
    expect(pooled.best.label).toBe(serial.best.label);
    expect(pooled.best.source).toBe(serial.best.source);
    expect(pooled.best.score).toEqual(serial.best.score);
    expect(pooled.candidates.map((c) => [c.label, c.score.score])).toEqual(
      serial.candidates.map((c) => [c.label, c.score.score]),
    );
    expect(pooled.dropped).toEqual(serial.dropped);
  });

  test('jobs: 1 is the same answer as jobs: 8 — the schedule cannot choose the winner', async () => {
    const asm = compileTargetAsm('int half(int x){ return x / 2; }');
    const obj = assembleTarget(asm);
    const one = await decompileRankedParallel('half', asm, ARMV4T_AGBCC, obj, { jobs: 1, worker });
    const many = await decompileRankedParallel('half', asm, ARMV4T_AGBCC, obj, { jobs: 8, worker });
    expect(many.best.label).toBe(one.best.label);
    expect(many.candidates.map((c) => [c.label, c.score.score])).toEqual(
      one.candidates.map((c) => [c.label, c.score.score]),
    );
  });

  test('a candidate that fails to build is DROPPED the same way, not fatal', async () => {
    // one worker whose compiler refuses every other candidate: the survivors must still rank,
    // and the refusals must land in `dropped` in enumeration order
    let n = 0;
    const flaky = () => async (source: string) => {
      if (n++ % 2 === 1) {
        throw new Error('synthetic compile failure');
      }
      return compileCandAgbcc(source);
    };
    const asm = compileTargetAsm('int ifor(int a, int b){ if (a || b) return 42; return 7; }');
    const r = await decompileRankedParallel('ifor', asm, ARMV4T_AGBCC, assembleTarget(asm), {
      jobs: 3,
      worker: flaky,
    });
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.dropped.every((d) => d.error.includes('synthetic compile failure'))).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});
