// A CALL IN A `&&`/`||`'s GUARDED OPERAND runs on every evaluation of the test in the asm and on
// only some of them in the C.
//
// Two facts hold it up and they are independent. That the inlined C is WRONG needs only dominance:
// `verify()` requires a def to dominate its uses, so a value the connective reads was produced on
// every path that evaluates the connective, while C's own short circuit skips the guarded operand —
// fewer calls, and whatever the callee wrote goes with them. That materializing the call at its DEF
// is the fix needs the second: `call` is in `HOIST_UNSAFE_OPS`, so `raise/shortcircuit.ts` never
// lifted one out of the arm it guards, and the def block is the block the asm called in.
//
// No contract catches it. `assertEffectsPreserved` (contracts.ts) refuses a call the emitted C
// DROPS and one it runs more times than the asm does on some path, never one it runs FEWER times —
// the hole `edge-arg-call.test.ts` names for the sibling placement rule. Toolchain-free.
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

// `if (a0 > 0 && f2(a0) != 0)` — the call is the connective's SECOND operand.
const GUARDED_AND = `fn f {
^bb0(%0: s32):
  %1: s32 = call %0 {target="f2"}
  %2: s32 = const {value=0}
  %3: u32 = icmp_sgt %0, %2
  %4: u32 = icmp_ne %1, %2
  %5: u32 = logic_and %3, %4
  cond_br %5, ^bb1(), ^bb2()
^bb1():
  %6: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret %0
}
`;

test('a call in an `&&`’s guarded operand is emitted ahead of the test', () => {
  const src = emit(GUARDED_AND);
  expect(src).toMatch(/v0 = f2\(a0\);\s*\n\s*if /);
  expect(src.match(/f2\(/g)).toHaveLength(1);
  // and the test now reads the NAME, in the operand it always occupied
  expect(src).toContain('a0 > 0 && v0 != 0');
});

test('`||` guards its second operand the same way', () => {
  const src = emit(GUARDED_AND.replace('logic_and', 'logic_or'));
  expect(src).toMatch(/v0 = f2\(a0\);\s*\n\s*if /);
  expect(src.match(/f2\(/g)).toHaveLength(1);
  expect(src).toContain('a0 > 0 || v0 != 0');
});

test('the FIRST operand is unconditional, and the rule leaves it inlined', () => {
  // C evaluates `f2(a0) != 0` on every evaluation of the test, which is what the asm does — the
  // one-fact edit that shows the rule is about the guarded side and not about calls in tests.
  const src = emit(GUARDED_AND.replace('logic_and %3, %4', 'logic_and %4, %3'));
  expect(src).toContain('f2(a0) != 0 && a0 > 0');
  expect(src.match(/f2\(/g)).toHaveLength(1);
});

// The same connective as a VALUE: `return a0 > 0 && f2(a0) != 0;`. raise/shortcircuit.ts mints this
// one at its own site, out of a value-merge diamond rather than a branch pair, and the bench feature
// vocabulary counts it as a different recovery (bench-schema/src/features.ts) — so the rule is
// asked of it separately.
const GUARDED_AND_VALUE = `fn f {
^bb0(%0: s32):
  %1: s32 = call %0 {target="f2"}
  %2: s32 = const {value=0}
  %3: u32 = icmp_sgt %0, %2
  %4: u32 = icmp_ne %1, %2
  %5: u32 = logic_and %3, %4
  ret %5
}
`;

test('the connective in VALUE position guards its second operand too', () => {
  const src = emit(GUARDED_AND_VALUE);
  expect(src).toMatch(/v0 = f2\(a0\);\s*\n\s*return /);
  expect(src.match(/f2\(/g)).toHaveLength(1);
  expect(src).toContain('return a0 > 0 && v0 != 0');
});

test('a call reached THROUGH the guarded operand’s cone counts too', () => {
  // The set is the operand's transitive cone, not the operand itself: here the connective reads a
  // comparison of a SUM, and the call is two ops below it.
  const ir = GUARDED_AND.replace('  %4: u32 = icmp_ne %1, %2', '  %7: s32 = add %1, %0\n  %4: u32 = icmp_ne %7, %2');
  const src = emit(ir);
  expect(src).toMatch(/v0 = f2\(a0\);\s*\n\s*if /);
  expect(src.match(/f2\(/g)).toHaveLength(1);
});
