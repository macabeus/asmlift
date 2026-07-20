// M1 — the thin vertical slice, end to end, scored by REAL objdiff.
// A branch function (not a straight-line leaf): agbcc compiles `clamp0` to a diamond
// that reconverges at .L4 — a genuine block-argument JOIN. asmlift lifts it (Braun SSA),
// recovers types, structures the diamond back into an `if`, emits C, recompiles with the
// real agbcc, and objdiff-scores it against the target. Target: score 0 (byte-exact).
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

const REFERENCE_C = 'int clamp0(int x){ if (x < 0) return 0; return x; }';

test('M1: lift → structure → emit → recompile → objdiff score 0 on a branch function', () => {
  const targetAsm = compileTargetAsm(REFERENCE_C);
  const targetObj = assembleTarget(targetAsm);

  const { source, ir } = decompile('clamp0', targetAsm, ARMV4T_AGBCC);

  // The frontend produced a real multi-block CFG with a block-argument join.
  expect(ir.raw).toContain('cond_br');
  const joinBlocks = ir.raw.split('\n').filter((l) => /^\^bb\d+\(%\d+:/.test(l));
  expect(joinBlocks.length).toBeGreaterThanOrEqual(2); // entry params + at least one join param

  // The emitted C recovered the `if` and the return.
  expect(source).toContain('if (');
  expect(source).toContain('return');

  const s = scoreC(source, 'clamp0', targetObj);
  if (!s.match) {
    console.log('emitted C:\n' + source);
    console.log('L1 IR:\n' + ir.raw);
    console.log('objdiff:', JSON.stringify(s));
  }
  expect(s.match).toBe(true);
  expect(s.score).toBe(0);
});

test('M1: emitted C is deterministic', () => {
  const asm = compileTargetAsm(REFERENCE_C);
  const a = decompile('clamp0', asm, ARMV4T_AGBCC).source;
  const b = decompile('clamp0', asm, ARMV4T_AGBCC).source;
  expect(a).toBe(b);
});
