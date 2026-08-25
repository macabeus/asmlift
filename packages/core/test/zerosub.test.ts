// The /zerosub re-spelling (l3/zerosub.ts): `-x` becomes `0 - x` when x is a subtraction the
// function also computes elsewhere. gcc 2.9 folds `-(a - b)` to `(b - a)` before CSE
// (gcc/fold-const.c:4821) but leaves `0 - (a - b)` as an unre-folded negate of the subtraction
// itself (gcc/fold-const.c:5085), so over a SHARED value the two spellings are a computation and
// a register apart — six instructions against five, compiled with agbcc.
//
// The refusals carry the lever: every operand shape the fold rule does not reach compiles the
// same either way, so firing there could only duplicate the primary.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { zeroSubNegates } from '../src/l3/zerosub';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const respell = (ir: string): string | null => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const alt = zeroSubNegates(structure(fn, {}));
  return alt === null ? null : cBackend.emit(alt);
};

// The GetAnchorCoord shape: one subtraction feeding both the branch test and the negate.
const SHARED = `fn sharedsub {
^bb0(%0: s32, %1: s32):
  %2: s32 = sub %1, %0
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %2, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: s32 = neg %2
  ret %5
^bb2():
  ret %2
}
`;

test('a negate over a shared subtraction re-spells as `0 - x`', () => {
  const src = respell(SHARED);
  expect(src).not.toBeNull();
  expect(src).toContain('0 - (a1 - a0)');
  expect(src).not.toMatch(/return -\(/);
});

// The same negate over a subtraction nothing else computes: RTL combine folds the negate back in
// and both spellings emit `sub r0, r1, r0`, so the lever declines rather than offer a duplicate.
const SINGLE = `fn singlesub {
^bb0(%0: s32, %1: s32):
  %2: s32 = sub %1, %0
  %3: s32 = neg %2
  ret %3
}
`;

test('a negate over a single-use subtraction declines', () => {
  expect(respell(SINGLE)).toBeNull();
});

// A shared ADD under the negate: `-(a + b)` has no fold rule to dodge, so both spellings compile
// identically and the lever must not fire.
const SHAREDADD = `fn sharedadd {
^bb0(%0: s32, %1: s32):
  %2: s32 = add %1, %0
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %2, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: s32 = neg %2
  ret %5
^bb2():
  ret %2
}
`;

test('a negate over a shared addition declines', () => {
  expect(respell(SHAREDADD)).toBeNull();
});

// A negate over a SHIFT of a shared subtraction — GetAnchorCoord's other arm. The negate's own
// operand is the shift, which the fold rule does not reach, so this arm keeps `-(…)`.
const OVERSHIFT = `fn negovershift {
^bb0(%0: s32, %1: s32):
  %2: s32 = sub %1, %0
  %3: s32 = const {value=9}
  %4: s32 = shr_s %2, %3
  %5: s32 = neg %4
  %6: s32 = const {value=0}
  %7: u32 = icmp_slt %2, %6
  cond_br %7, ^bb1(), ^bb2()
^bb1():
  ret %5
^bb2():
  ret %2
}
`;

test('a negate over a shift of a shared subtraction is left alone', () => {
  expect(respell(OVERSHIFT)).toBeNull();
});
