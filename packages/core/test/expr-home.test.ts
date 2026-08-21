// The loop-expression-home axis (structure.ts homeLoopExprs, rank.ts `/expr-home`): a pure
// non-const value defined outside a loop with 2+ distinct consumers inside it materializes into
// a local carrying the value's recovered type — the register the compiler holds across the
// iterations — where the default re-derives the expression at each use. Off by default.
//
// The scope conditions are what these tests pin: the consumers must sit inside a loop the def is
// outside (straight-line multi-use stays inline — the small-constant class), shared memory-access
// bases stay /addr-home's, and gaddr/laddr cones stay out.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { hasLoopSharedPureValue } from '../src/structure/analysis';
import { structure } from '../src/structure/structure';

const emit = (ir: string, on: boolean): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { homeLoopExprs: on }));
};

const count = (s: string, needle: string): number => s.split(needle).length - 1;

// The sizebound shape, reduced: `16 << a0` defined at entry, consumed by the loop bound and a
// product inside the loop.
const LOOPSHARED = `fn loopshared {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=16}
  %3: u32 = shl %2, %0
  %4: s32 = const {value=0}
  br ^bb1(%4)
^bb1(%5: s32):
  %6: s32 = mul %5, %3
  %7: s32 = const {value=50339840}
  %8: s32 = add %5, %7
  store %8, %6 {off=0, width=4}
  %9: s32 = const {value=1}
  %10: s32 = add %5, %9
  %11: u32 = icmp_ult %10, %3
  cond_br %11, ^bb1(%10), ^bb2()
^bb2():
  ret %10
}
`;

test('a loop-shared pure value homes into a local of its recovered type', () => {
  const on = emit(LOOPSHARED, true);
  expect(count(on, '16 <<')).toBe(1);
  expect(on).toMatch(/u32 v\d+;/); // the u32 IR type reaches the declaration
  expect(hasLoopSharedPureValue(parse(LOOPSHARED))).toBe(true);
});

test('off by default: the same IR re-derives per use', () => {
  const off = emit(LOOPSHARED, false);
  expect(count(off, '16 <<')).toBeGreaterThanOrEqual(2);
  expect(emit(LOOPSHARED, false)).toBe(off);
});

// The same multi-use value with every consumer in STRAIGHT LINE: the compiler re-materializes
// cheap arithmetic there, so the axis must stay silent.
const STRAIGHT = `fn straight {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=16}
  %3: u32 = shl %2, %0
  %4: s32 = mul %1, %3
  %5: s32 = add %4, %3
  ret %5
}
`;

test('straight-line multi-use is not homed', () => {
  expect(emit(STRAIGHT, true)).toBe(emit(STRAIGHT, false));
  expect(hasLoopSharedPureValue(parse(STRAIGHT))).toBe(false);
});

// One consumer inside the loop, one outside: the in-loop count is 1 — not homed.
const ONEIN = `fn onein {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=16}
  %3: u32 = shl %2, %0
  %4: s32 = mul %1, %3
  br ^bb1(%4)
^bb1(%5: s32):
  %6: s32 = const {value=1}
  %7: s32 = sub %5, %6
  %8: u32 = icmp_ult %7, %3
  cond_br %8, ^bb1(%7), ^bb2()
^bb2():
  ret %7
}
`;

test('a single in-loop consumer is not homed', () => {
  const on = emit(ONEIN, true);
  expect(count(on, '16 <<')).toBeGreaterThanOrEqual(2);
});
