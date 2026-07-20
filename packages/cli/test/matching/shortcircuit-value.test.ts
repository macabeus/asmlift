// Boolean-VALUE short-circuit recovery (`return a && b`). The value form compiles to a diamond
// merging 0/1 into a returned phi; lowered naively as a merge variable with agbcc's branchless
// `(-b|b)>>31` second operand, it misses. raise/shortcircuit.ts folds `(-x|x)>>31` → `x != 0` and
// collapses the diamond (iteratively, so `&&`-chains fold bottom-up) into a `logic_and` value,
// printed `a != 0 && b != 0` — which recompiles to the exact diamond. Scored byte-exact on agbcc
// through the differ-ranked path.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';

const run = (sym: string, src: string) => {
  const asm = compileTargetAsm(src);
  return { r: decompile(sym, asm, ARMV4T_AGBCC), rk: decompileRanked(sym, asm, ARMV4T_AGBCC, assembleTarget(asm)) };
};

describe('boolean-value && recovery: matches byte-exact and prints &&', () => {
  const CASES = [
    { sym: 'land', c: 'int land(int a, int b){ return a && b; }' }, // raw values, branchless b!=0
    { sym: 'andcmp', c: 'int andcmp(int a, int b){ return a > 0 && b > 0; }' }, // &&-chain of comparisons
    { sym: 'and3', c: 'int and3(int a, int b, int c){ return a > 0 && b > 0 && c > 0; }' }, // 3-way chain
    { sym: 'andmix', c: 'int andmix(int a, int b){ return a && b > 5; }' }, // mixed operands
  ];
  for (const { sym, c } of CASES) {
    test(`${sym} folds to && and matches`, () => {
      const { r, rk } = run(sym, c);
      expect(r.source).toContain('&&'); // the connective was recovered (single-shot already folds it)
      expect(r.source).not.toContain('v0'); // no merge variable
      expect(r.source).not.toContain('>> 31'); // branchless bool-normalize was folded away
      expect(rk.best.score.match).toBe(true);
    });
  }
});
