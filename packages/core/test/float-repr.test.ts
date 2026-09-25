// A hardware floating-point value as an IR type: what the kind is, what it is not, and how each
// backend spells it. `docs/floating-point.md` says which frontends mint one.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { mkOp, mkValue } from '../src/ir/core';
import { T, intWidth, parseType, typeEquals, typeToString } from '../src/ir/types';
import { recoverTypes } from '../src/raise/recover';
import { C_TYPEDEFS } from '../src/target';

describe('a float is its own kind, not an integer width', () => {
  test('both widths round-trip through the IR text', () => {
    expect(typeToString(T.f32())).toBe('f32');
    expect(typeToString(T.f64())).toBe('f64');
    expect(parseType('f32')).toEqual(T.f32());
    expect(parseType('f64')).toEqual(T.f64());
  });

  // THE PREDICATE BOTH WIDTH READERS SHARE (ir/types.ts `intWidth`). The verifier reads a null as
  // "not in the integer width rule", the 64-bit helper recogniser as "refuse to fold": both are
  // right for a float, and a float that answered a width would enter integer arithmetic in both.
  test('it carries no integer width', () => {
    expect(intWidth(T.f32())).toBeNull();
    expect(intWidth(T.f64())).toBeNull();
  });

  test('the two widths are different types, and neither is the integer of its width', () => {
    expect(typeEquals(T.f32(), T.f32())).toBe(true);
    expect(typeEquals(T.f32(), T.f64())).toBe(false);
    expect(typeEquals(T.f32(), T.s(32))).toBe(false);
    expect(typeEquals(T.f64(), T.s(64))).toBe(false);
  });

  // Recovery types only `unknown`s, so a value the frontend minted as a float leaves it one: the s32
  // default must never reach it.
  test('type recovery leaves a float alone', () => {
    const a = mkValue(T.f32());
    const fn = {
      name: 'f',
      blocks: [{ params: [a], ops: [mkOp('ret', { operands: [a] })] }],
      writeOrder: undefined,
      slotHomes: undefined,
      paramEvidence: undefined,
    };
    recoverTypes(fn);
    expect(a.type).toEqual(T.f32());
  });
});

describe('what the backends can spell', () => {
  const sfn = (t: ReturnType<typeof T.f32>) => ({
    name: 'f',
    params: [{ name: 'a0', type: t }],
    locals: [],
    retType: t,
    body: [{ k: 'return' as const, value: { k: 'var' as const, name: 'a0' } }],
  });

  // The C89 keywords, which no translation unit has to declare — so the prelude stays integer-only
  // and a project context that already typedefs `f32` cannot collide with it.
  test('C spells the keyword, and the prelude declares no float typedef', () => {
    expect(cBackend.emit(sfn(T.f32()))).toContain('float f(float a0)');
    expect(cBackend.emit(sfn(T.f64()))).toContain('double f(double a0)');
    expect(C_TYPEDEFS).not.toMatch(/float|double/);
  });

  test('the Pascal backend refuses a float rather than spelling it as an integer', () => {
    expect(() => pascalBackend.emit(sfn(T.f32()))).toThrow(/no faithful spelling for a float-typed value/);
  });
});
