// A `break` OUT OF A LOOP LANDS WHERE THE HEADER'S OWN EXIT DOES.
//
// A test-at-top `while` renders its exit region once, after the loop, and both of its exits reach
// it: the header's test, and any `break` from the latch. That region is rendered raw — no back-edge
// substitution — and on the header exit that is right, since the loop variables still hold the
// values the header read. A `break` leaves AFTER the latch's update copies, so a header value the
// region re-derives from an updated name is computed one iteration on. `structure.ts` then does not
// spell the `break` (the arm returns instead, where the copies have not run).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

/** `int g3(int a, int b, int c, int d){ int t = a, u = a; do { b = t ^ (b + t); if (c > 2) break; }
 *  while (--d > 0); a = b * u + b; return (b ^ a) * (u * a); }` at the synthetic tier's mwcc_242_81
 *  flags. The header computes `%8` and tests `c > 2`; the latch counts `d` down and hands `%8` back.
 *  After the loop `%8` is read on both exits. */
const HEADER_VALUE_READ_AFTER_BOTH_EXITS = `fn g3 {
^bb0(%0: s32, %1: s32, %2: s32, %3: s32):  ; writes=1
  br ^bb1(%1, %3) {fallthrough=true}  ; order ^bb1(-, -)
^bb1(%4: s32, %5: s32):  ; writes=2
  %6: s32 = const {value=2}
  %7: s32 = add %4, %0
  %8: s32 = xor %0, %7
  %9: u32 = icmp_sgt %2, %6
  cond_br %9, ^bb3(), ^bb2()  ; order ^bb3() ^bb2()
^bb2():  ; writes=1
  %10: s32 = const {value=-1}
  %11: s32 = add %5, %10
  %12: s32 = const {value=0}
  %13: u32 = icmp_sgt %11, %12
  cond_br %13, ^bb1(%8, %11), ^bb3()  ; order ^bb1(-, 0) ^bb3()
^bb3():  ; writes=5
  %14: s32 = mul %8, %0
  %15: s32 = add %8, %14
  %16: s32 = mul %0, %15
  %17: s32 = xor %8, %15
  %18: s32 = mul %17, %16
  ret %18
}`;

test('a header value read after a break is not re-derived from the updated name', () => {
  expect(emit(HEADER_VALUE_READ_AFTER_BOTH_EXITS)).toBe(
    's32 g3(s32 a0, s32 a1, s32 a2, s32 a3) {\n    s32 v0;\n    s32 v1;\n    v0 = a1;\n    v1 = a3;\n' +
      '    while (a2 <= 2) {\n        if (v1 + -1 <= 0) {\n            return (a0 ^ v0 + a0 ^ (a0 ^ v0 + a0) + (a0 ^ v0 + a0) * a0) * ' +
      '(a0 * ((a0 ^ v0 + a0) + (a0 ^ v0 + a0) * a0));\n        } else {\n            v0 = a0 ^ v0 + a0;\n' +
      '            v1 = v1 + -1;\n        }\n    }\n    return (a0 ^ v0 + a0 ^ (a0 ^ v0 + a0) + (a0 ^ v0 + a0) * a0) * ' +
      '(a0 * ((a0 ^ v0 + a0) + (a0 ^ v0 + a0) * a0));\n}\n',
  );
});
