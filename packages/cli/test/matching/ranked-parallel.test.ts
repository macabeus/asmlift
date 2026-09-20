// `decompileRankedParallel` must be the SAME ranking as `decompileRanked` — only the candidate
// compiles move off the main thread. A pooled run is what the out-of-harness ranked enumeration
// uses (a 20k-candidate function is ~85% subprocess), so a divergence here would mean a round
// planning on a number the benchmark's serial path never produces.
//
// The pool's own concurrency (one scratch slot per worker, one shared world probe) is pinned
// offline in test/offline/compile-command.test.ts; what THIS suite can pin, with the real
// toolchain, is the property that matters downstream: identical winner, identical per-candidate
// scores in identical order, identical drops.
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { NoScorableCandidateError } from '@asmlift/core/rank';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { joinVariations } from '@asmlift/core/variation-tokens';
import { assembleTarget, compileCandAgbcc, compileTargetAsm } from '@asmlift/toolchains';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { decompileRanked, decompileRankedParallel } from '../../src/rank';

// the registered agbcc candidate compiler, handed to the pool as its per-worker compiler
const worker = () => async (source: string) => compileCandAgbcc(source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);

const bothWays = async (sym: string, src: string) => {
  const asm = compileTargetAsm(src, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
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
    expect(joinVariations(pooled.winner.variations)).toBe(joinVariations(serial.winner.variations));
    expect(pooled.winner.source).toBe(serial.winner.source);
    expect(pooled.winner.score).toEqual(serial.winner.score);
    expect(pooled.candidates.map((c) => [joinVariations(c.variations), c.score.score])).toEqual(
      serial.candidates.map((c) => [joinVariations(c.variations), c.score.score]),
    );
    expect(pooled.dropped).toEqual(serial.dropped);
  });

  test('jobs: 1 is the same answer as jobs: 8 — the schedule cannot choose the winner', async () => {
    const asm = compileTargetAsm('int half(int x){ return x / 2; }', TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
    const obj = assembleTarget(asm);
    const one = await decompileRankedParallel('half', asm, ARMV4T_AGBCC, obj, { jobs: 1, worker });
    const many = await decompileRankedParallel('half', asm, ARMV4T_AGBCC, obj, { jobs: 8, worker });
    expect(joinVariations(many.winner.variations)).toBe(joinVariations(one.winner.variations));
    expect(many.candidates.map((c) => [joinVariations(c.variations), c.score.score])).toEqual(
      one.candidates.map((c) => [joinVariations(c.variations), c.score.score]),
    );
  });

  // The lifetime the real pool runs under: `compilersFromCommand`'s `worker()` hands out ONE
  // scratch directory per worker and EMPTIES it before each compile, so a worker's object is
  // valid only until that worker asks for the next one. The driver is what has to honour that —
  // it must score each object the moment it lands. `compileCandAgbcc` above mkdtemps per call and
  // would therefore keep every object alive, hiding a driver that batched the compiles and scored
  // afterwards; this worker reproduces the real lifetime so that shape cannot pass.
  const slotDirs: string[] = [];
  const slotWorker = () => {
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-ranklife-'));
    slotDirs.push(dir);
    const obj = join(dir, 'cand.o');
    return async (source: string) => {
      rmSync(obj, { force: true });
      copyFileSync(compileCandAgbcc(source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags), obj);
      return obj;
    };
  };
  afterAll(() => slotDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  test('a worker whose object is wiped by its NEXT compile still ranks identically', async () => {
    const asm = compileTargetAsm(
      'int ifor(int a, int b){ if (a || b) return 42; return 7; }',
      TOOLCHAIN_TARGETS.agbcc.canonicalFlags,
    );
    const obj = assembleTarget(asm);
    const serial = decompileRanked('ifor', asm, ARMV4T_AGBCC, obj);
    const pooled = await decompileRankedParallel('ifor', asm, ARMV4T_AGBCC, obj, { jobs: 3, worker: slotWorker });
    expect(pooled.dropped).toEqual(serial.dropped); // a stale/absent object would land here
    expect(joinVariations(pooled.winner.variations)).toBe(joinVariations(serial.winner.variations));
    expect(pooled.candidates.map((c) => [joinVariations(c.variations), c.score.score])).toEqual(
      serial.candidates.map((c) => [joinVariations(c.variations), c.score.score]),
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
      return compileCandAgbcc(source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
    };
    const asm = compileTargetAsm(
      'int ifor(int a, int b){ if (a || b) return 42; return 7; }',
      TOOLCHAIN_TARGETS.agbcc.canonicalFlags,
    );
    const r = await decompileRankedParallel('ifor', asm, ARMV4T_AGBCC, assembleTarget(asm), {
      jobs: 3,
      worker: flaky,
    });
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.dropped.every((d) => d.error.includes('synthetic compile failure'))).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  // THE STILLBORN STOP (core stillborn.ts) is the one place the pool's ORDER matters: the default
  // alone, then the probes, then the rest — and the rest not at all when the verdict says so. A
  // pool that scheduled the whole fan at once would compile candidates the serial path never
  // reaches, and the two paths would disagree on how many were compiled.
  const asmOf = (src: string) => compileTargetAsm(src, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  const IFOR = 'int ifor(int a, int b){ if (a || b) return 42; return 7; }';
  const stillbornOf = async (run: () => Promise<unknown> | unknown): Promise<NoScorableCandidateError> => {
    try {
      await run();
    } catch (e) {
      if (e instanceof NoScorableCandidateError) {
        return e;
      }
      throw e;
    }
    throw new Error('ranked a fan whose every compile was refused');
  };

  test('a fan refused for ONE reason stops after the probes, on the pool exactly as on the serial path', async () => {
    const refuse = (): never => {
      throw new CompilerRejection("agbcc failed: c.c:4: too many arguments to function `g'");
    };
    let pooledCompiles = 0;
    const asm = asmOf(IFOR);
    const obj = assembleTarget(asm);
    const pooled = await stillbornOf(() =>
      decompileRankedParallel('ifor', asm, ARMV4T_AGBCC, obj, {
        jobs: 4,
        worker: () => async () => {
          pooledCompiles++;
          return refuse();
        },
      }),
    );
    const serial = await stillbornOf(() => decompileRanked('ifor', asm, ARMV4T_AGBCC, obj, { compile: refuse }));
    // what was compiled is the dropped list, and only that reached a worker
    expect(pooled.notCompiled.length).toBeGreaterThan(0);
    expect(pooledCompiles).toBe(pooled.dropped.length);
    expect(pooled.dropped).toEqual(serial.dropped);
    expect(pooled.notCompiled).toEqual(serial.notCompiled);
    expect(pooled.message).toContain('NOT COMPILED');
  });

  test('a fan whose refusals DIFFER is compiled whole on the pool too', async () => {
    // the diagnostic carries a digest of the candidate's own source, so no two keys agree
    let pooledCompiles = 0;
    const asm = asmOf(IFOR);
    const obj = assembleTarget(asm);
    const pooled = await stillbornOf(() =>
      decompileRankedParallel('ifor', asm, ARMV4T_AGBCC, obj, {
        jobs: 4,
        worker: () => async (source: string) => {
          pooledCompiles++;
          const digest = createHash('sha256').update(source).digest('hex').slice(0, 8);
          throw new CompilerRejection(`agbcc failed: c.c:4: invalid operands to binary ${digest}`);
        },
      }),
    );
    expect(pooled.notCompiled).toEqual([]);
    expect(pooledCompiles).toBe(pooled.dropped.length);
    expect(pooled.dropped.length).toBeGreaterThan(2);
  });
});
