// Prototype arity: a callee `params` given as a bare COUNT or as the typed parameter list a
// header extraction produces (`["u8"]`) must BOTH drive call-argument recovery. The typed-list
// form silently dropped every argument before protoArity normalized it (argc was the array, so
// `k < argc` was NaN → zero args) — a caller of such a callee lost its arguments.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { protoArity } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

describe('protoArity', () => {
  test('normalizes the count form, the typed-list form, and absence', () => {
    expect(protoArity({ params: 2 })).toBe(2);
    expect(protoArity({ params: ['u8'] })).toBe(1);
    expect(protoArity({ params: ['u8', 's32', 'void *'] })).toBe(3);
    // both zero-arity forms must survive the `??` chain as 0 (a void callee gets NO args, never
    // the arg-register fallback), so they are distinct from omitted.
    expect(protoArity({ params: 0 })).toBe(0);
    expect(protoArity({ params: [] })).toBe(0);
    expect(protoArity({ returnsVoid: true })).toBeUndefined(); // no params → frontend heuristic
    expect(protoArity(undefined)).toBeUndefined();
    // malformed (a bare string, not a list) → undefined (fall back), NOT "u8".length === 3.
    expect(protoArity({ params: 'u8' as unknown as string[] })).toBeUndefined();
  });
});

describe('call-argument recovery honors both proto forms', () => {
  const caller = 'caller:\n\tmov\tr0, #0x5\n\tbl\tcallee\n\tbx\tlr\n';
  const dc = (params: number | string[]) =>
    decompile('caller', caller, ARMV4T_AGBCC, {
      prototypes: { caller: { returnsVoid: true }, callee: { params } },
    }).source;

  test('a TYPED-LIST callee proto recovers the argument (the regression this fixes)', () => {
    expect(dc(['u8'])).toContain('callee(5)');
  });

  test('a COUNT callee proto recovers the argument identically', () => {
    expect(dc(1)).toContain('callee(5)');
  });
});
