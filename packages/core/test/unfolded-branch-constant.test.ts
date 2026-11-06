// A RETURN OF THE VALUE A BRANCH TESTED, left unfolded where cse folds only the fall-through arm.
//
// One probe pair, `corpus/probe-rettail-pg-{copies,join}.c`, compiled by
// scripts/regen-rettail-probes.ts at every toolchain's canonical flags: `return gB` after `gB` is
// tested against 0, written as the `else` of `gB != 0` with the tail in both arms (`-copies`), and
// as the then arm of `gB == 0` before the tail written once (`-join`). The shape of Mario Party 3's
// `func_8010BD28_472F98_mgmode`.
//   1. which compilers fold the tested constant into a return on the branch's taken edge
//      (target.ts `foldsBranchConstantOnTakenEdge`), read from the objects themselves, and how the
//      flags set it (`targetFor`);
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { TOOLCHAIN_TARGETS, targetFor } from '../src/target';

const CORPUS = join(import.meta.dirname, 'corpus');
const fixture = (file: string) => readFileSync(join(CORPUS, file), 'utf8');

/** The instruction lines of a committed disassembly, without its provenance header. */
const instructions = (file: string): string[] =>
  fixture(file)
    .split('\n')
    .filter((l) => /^\s+[0-9a-f]+:\s+[a-z]/.test(l))
    .map((l) =>
      l
        .replace(/^\s+[0-9a-f]+:\s+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );

/** The delay slot of the `beqz` on `gB`, the branch to the early return. */
const returnSlot = (file: string): string => {
  const ins = instructions(file);
  const at = ins.findIndex((l, i) => l.startsWith('beqz ') && ins[i - 1]?.startsWith('lhu '));
  expect(at).toBeGreaterThan(0);
  return ins[at + 1];
};

const GCC_LANES = [
  { tc: 'gcc2.7.2', slug: 'gcc272', copies: 'nop' },
  { tc: 'gcc2.7.2kmc', slug: 'gcc272kmc', copies: 'move v0,zero' },
] as const;

describe('which compilers fold a branch-proven constant on the taken edge (`foldsBranchConstantOnTakenEdge`)', () => {
  test.each(GCC_LANES)('$tc: the declaration at canonical flags is what its own `pg` pair compiles to', (lane) => {
    expect(returnSlot(`${lane.slug}-rettail-pg-copies.asm`)).toBe(lane.copies);
    // the join's return is its branch's fall-through in the compiler's own jump, and folds
    expect(returnSlot(`${lane.slug}-rettail-pg-join.asm`)).toBe('move v0,zero');
    const { target } = targetFor(lane.tc, TOOLCHAIN_TARGETS[lane.tc].canonicalFlags);
    expect(target.compilerBehaviors.foldsBranchConstantOnTakenEdge).toBe(lane.copies !== 'nop');
  });

  test('gcc 2.x: only level 1 leaves the taken edge unfolded, and either cse switch folds it', () => {
    const at = (flags: string[]) =>
      targetFor('gcc2.7.2', flags).target.compilerBehaviors.foldsBranchConstantOnTakenEdge;
    expect(at(['-O1'])).toBe(false);
    expect(at(['-O'])).toBe(false);
    expect(at(['-O2'])).toBe(true);
    expect(at(['-O3'])).toBe(true);
    expect(at(['-Os'])).toBe(true);
    expect(at(['-O1', '-fcse-follow-jumps'])).toBe(true);
    expect(at(['-O1', '-fcse-skip-blocks'])).toBe(true);
    expect(at(['-O1', '-fcse-follow-jumps', '-fno-cse-follow-jumps'])).toBe(false);
  });

  test('absent where no probe says either: agbcc, ido7.1 and mwcc, at any level', () => {
    for (const [tc, flags] of [
      ['agbcc', ['-O1']],
      ['agbcc', ['-O2']],
      ['ido7.1', ['-O1']],
      ['mwcc_242_81', ['-O1']],
    ] as const) {
      expect(targetFor(tc, flags).target.compilerBehaviors.foldsBranchConstantOnTakenEdge).toBeUndefined();
    }
  });
});
