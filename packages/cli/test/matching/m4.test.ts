// M4 — prove BOTH seams.
//  (a) Language-backend seam: the SAME L3 AST emits C *and* Pascal; every language
//      divergence (`:=`, `div`, name-assignment return) lives in the backend.
//  (b) The COMPILER axis is CONSUMED, not decorative: flipping `target.compiler` — with the
//      ISA and asm held constant — changes the output, because the soft-div idiom pattern is
//      gated on the compiler, not on an `arch ==` branch or on hwDivide (KMC GCC has hardware
//      divide yet still strength-reduces `/2` to the shift idiom, so the compiler is the true
//      predicate).
import { cBackend } from '@asmlift/core/backend/c';
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { SDIV_POW2_2 } from '@asmlift/core/pattern/engine';
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, TargetDescription } from '@asmlift/core/target';
import { compileTargetAsm } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

test('M4a: one L3 AST → two languages (C and Pascal)', () => {
  const asm = compileTargetAsm('int clamp0(int x){ if (x < 0) return 0; return x; }');
  const c = decompile('clamp0', asm, ARMV4T_AGBCC, { backend: cBackend }).source;
  const p = decompile('clamp0', asm, ARMV4T_AGBCC, { backend: pascalBackend }).source;
  console.log('C:\n' + c + '\nPascal:\n' + p);

  expect(c).toContain('s32 clamp0(');
  expect(c).toContain('return a0;');

  expect(p).toContain('function clamp0(a0: Integer): Integer;');
  expect(p).toContain('begin');
  expect(p).toContain('a0 := 0;'); // Pascal assignment
  expect(p).toContain('clamp0 := a0;'); // neutral "return a value" → name-assignment
  expect(p).not.toContain('return');
});

test('M4a: the neutral `/` node lowers to C `/` and Pascal `div`', () => {
  const asm = compileTargetAsm('int half(int x){ return x / 2; }');
  const c = decompile('half', asm, ARMV4T_AGBCC, { patterns: [SDIV_POW2_2], backend: cBackend }).source;
  const p = decompile('half', asm, ARMV4T_AGBCC, { patterns: [SDIV_POW2_2], backend: pascalBackend }).source;
  expect(c).toContain('a0 / 2');
  expect(p).toContain('a0 div 2');
});

test('M4b: flipping target.compiler changes the output (the compiler axis is consumed)', () => {
  const asm = compileTargetAsm('int half(int x){ return x / 2; }');
  const folds: TargetDescription = ARMV4T_AGBCC; // compiler: "agbcc"
  const other: TargetDescription = { ...ARMV4T_AGBCC, compiler: 'ido' }; // a compiler the idiom isn't tagged for

  const a = decompile('half', asm, folds, { patterns: [SDIV_POW2_2] });
  const b = decompile('half', asm, other, { patterns: [SDIV_POW2_2] });

  // same asm, same ISA, ONLY the compiler differs → different output (patternApplies gates on it).
  expect(a.patternHits).toBe(1); // agbcc emits this /2 idiom → the fold applies
  expect(b.patternHits).toBe(0); // …and is gated OFF for a compiler the pattern isn't tagged for
  expect(a.source).toContain('/ 2');
  expect(b.source).not.toContain('/ 2');
  expect(a.source).not.toBe(b.source);
});
