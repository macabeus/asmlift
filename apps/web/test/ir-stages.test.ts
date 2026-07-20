// Guards the IR-dump semantics the playground's Pipeline tab relies on: the dumps are successive
// prints of the same function, so folded === raw exactly when no idiom pattern fired — and the
// "x / 2" example exists precisely because folding IS a visible no-op everywhere else.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { expect, test } from 'vitest';

import { EXAMPLES } from '../src/pages/playground/examples';

test('the idiom-folding example changes the IR between lifted and folded', () => {
  const ex = EXAMPLES.find((e) => e.label.includes('idiom folding'))!;
  const r = decompile('half', ex.asm, ARMV4T_AGBCC, { onGap: 'annotate' });
  expect(r.patternHits).toBe(1);
  expect(r.ir.raw).not.toBe(r.ir.folded);
  expect(r.ir.folded).toContain('sdiv');
  expect(r.source).toBe('s32 half(s32 a0) {\n    return a0 / 2;\n}\n');
});

test('a no-pattern function folds to identical IR (what the Pipeline tab dims as no-change)', () => {
  const ex = EXAMPLES.find((e) => e.label.includes('clamp to zero (if-assign)'))!;
  const r = decompile('clamp0', ex.asm, ARMV4T_AGBCC, { onGap: 'annotate' });
  expect(r.patternHits).toBe(0);
  expect(r.ir.raw).toBe(r.ir.folded);
});
