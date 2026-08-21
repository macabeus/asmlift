// The /uns-cmp axis (structure.ts unsignedCompareSpelling): an icmp_u* whose operands both
// render as signed-promoting C compiles to a signed compare — the u32-ness dies when a local
// declares with its first claimant's s32 type or when the operand is an inline `int`-typed
// tree. With the axis on, one operand takes a (u32) cast (the side whose recovered value type
// is unsigned) and a mixed-claimant declaration reconciles to u32. Off by default: a signed
// spelling that byte-matched was proved non-negative by the compiler, so the differ referees.
//
// The refusals are what these tests pin: a provably-unsigned operand leaves the spelling alone,
// and so does a compare whose operands both provably sit in [0, 2^31) — `(u8)x > 4` is
// value-faithful spelled signed, and the compiler picks the unsigned branch itself (the ult5
// matching fixture). ==/!= never cast; icmp_s* is out of scope.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string, on = true): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { unsignedCompareSpelling: on }));
};

// A u32 counter merged through a name an s32 value claims first: the loop param's compare
// against the shl bound must stay unsigned in C. The shl's C type is `int` (the left operand's),
// so without the cast the compare renders signed.
const LOOPBOUND = `fn loopbound {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=4}
  %3: u32 = shl %2, %0
  %4: s32 = const {value=0}
  br ^bb1(%4)
^bb1(%5: s32):
  %6: s32 = const {value=1}
  %7: s32 = add %5, %6
  %8: u32 = icmp_ult %7, %3
  cond_br %8, ^bb1(%7), ^bb2()
^bb2():
  ret %7
}
`;

test('an unsigned compare over signed-rendering operands takes the (u32) cast', () => {
  const src = emit(LOOPBOUND);
  expect(src).toMatch(/\(u32\)/);
  // the cast lands on a compare operand, not on the unrelated add
  expect(src).toMatch(/while \(.*\(u32\).*<.*\)|< \(u32\)/);
});

// The same compare with the bound held in a u32-DECLARED local (materialized via a second
// consumer statement is not needed — a plain u32 var operand suffices): provably unsigned,
// no cast churn.
const TYPED = `fn typedcmp {
^bb0(%0: u32, %1: u32):
  %2: u32 = icmp_ult %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: s32 = const {value=1}
  ret %3
^bb2():
  %4: s32 = const {value=0}
  ret %4
}
`;

test('a provably-unsigned operand keeps its spelling', () => {
  expect(emit(TYPED)).not.toContain('(u32)');
});

// Both operands provably in [0, 2^31): the signed spelling agrees with the unsigned compare on
// every input, and the compiler emits the unsigned branch for it — no cast.
const BYTECMP = `fn bytecmp {
^bb0(%0: s32):
  %1: s32 = zext %0 {width=8}
  %2: s32 = const {value=4}
  %3: u32 = icmp_ugt %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  %4: s32 = const {value=0}
  ret %4
^bb2():
  %5: s32 = const {value=1}
  ret %5
}
`;

test('a byte-range compare keeps the signed spelling (both sides non-negative)', () => {
  expect(emit(BYTECMP)).not.toContain('(u32)(u8)');
});

// Sign-agnostic compares never cast.
const EQCMP = `fn eqcmp {
^bb0(%0: s32, %1: s32):
  %2: u32 = icmp_eq %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: s32 = const {value=1}
  ret %3
^bb2():
  %4: s32 = const {value=0}
  ret %4
}
`;

test('==/!= never cast', () => {
  expect(emit(EQCMP)).not.toContain('(u32)');
});

// ── declaration-signedness reconciliation (structure.ts) ─────────────────────────────────────
// A name's declared type is its first claimant's; a u32 loop counter often gets claimed first by
// an s32 sibling and declares s32 — which a later re-spell can smuggle into a compare the cast
// site already judged (the initfirst guard swap). The declaration flips to u32 when some value
// under the name is u32 and none carries signed-use evidence.

// The counter merges an s32-typed init path with a u32-typed post-increment (typed by its
// icmp_ult use): the declaration must come out u32 and the compare needs no cast.
const RECON = `fn recon {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=16}
  %3: u32 = shl %2, %0
  %4: s32 = const {value=0}
  br ^bb1(%4)
^bb1(%5: s32):
  %6: s32 = const {value=50339840}
  %7: s32 = add %5, %6
  store %7, %5 {off=0, width=1}
  %8: s32 = const {value=1}
  %9: u32 = add %5, %8
  %10: u32 = icmp_ult %9, %3
  cond_br %10, ^bb1(%9), ^bb2()
^bb2():
  ret %9
}
`;

test('a mixed-claimant counter with unsigned-only evidence declares u32', () => {
  const src = emit(RECON);
  expect(src).toMatch(/u32 v\d+;/);
});

// The same counter ALSO feeding a signed compare: the flip must refuse — flipping would render
// the icmp_slt unsigned, the wrongness this family exists to prevent, just mirrored.
const RECONS = RECON.replace('fn recon', 'fn recons').replace(
  '^bb2():\n  ret %9',
  `^bb2():
  %11: s32 = const {value=0}
  %12: u32 = icmp_slt %9, %11
  cond_br %12, ^bb3(), ^bb4()
^bb3():
  ret %11
^bb4():
  ret %9`,
);

test('signed-use evidence blocks the flip', () => {
  const src = emit(RECONS);
  expect(src).not.toMatch(/u32 v\d+;/);
});

test('off by default: the axis-off spelling keeps the uncast signed rendering', () => {
  expect(emit(LOOPBOUND, false)).not.toContain('(u32)');
  expect(emit(RECON, false)).not.toMatch(/u32 v\d+;/);
});

// A claimant feeding a SIGNED compare through an inline pure expression: the evidence is the
// signed op's transitive input cone, so the flip must refuse — `v - 5 < 0` rendered over a u32
// v is always false in C where the machine's compare was signed.
const RECOND = RECON.replace('fn recon', 'fn recond').replace(
  `^bb2():
  ret %9`,
  `^bb2():
  %11: s32 = const {value=5}
  %12: s32 = sub %9, %11
  %13: s32 = const {value=0}
  %14: u32 = icmp_slt %12, %13
  cond_br %14, ^bb3(), ^bb4()
^bb3():
  ret %13
^bb4():
  ret %9`,
);

test('signed evidence through a derived expression blocks the flip', () => {
  expect(emit(RECOND)).not.toMatch(/u32 v\d+;/);
});

// A pointer-rendered compare side never takes the cast: `p < end` is already the unsigned
// compare, and (u32)p would be a pointer/int constraint violation.
const PTRCMP = `fn ptrcmp {
^bb0(%0: u32, %1: u32):
  %2: s32 = load %0 {off=0, signed=false, width=2}
  %3: u32 = icmp_ult %0, %1
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  ret %2
^bb2():
  %4: s32 = const {value=0}
  ret %4
}
`;

test('a pointer-rendered side keeps its spelling', () => {
  expect(emit(PTRCMP)).not.toContain('(u32)');
});

// The kept-guard substitution channel: gsub renders the init ARG under the loop variable's
// name, so a SIGNED zero-trip guard over the arg is evidence against the name even though the
// arg claims it in neither naming map — the taint crosses edge arg↔param identities.
const GSUB = `fn gsubhole {
^bb0(%0: s32, %1: u32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_sgt %0, %2
  cond_br %3, ^bb1(%0), ^bb2()
^bb1(%4: s32):
  %5: s32 = const {value=1}
  %6: u32 = sub %4, %5
  store %6, %0 {off=0, width=4}
  %7: u32 = icmp_ugt %6, %1
  cond_br %7, ^bb1(%6), ^bb2()
^bb2():
  ret %2
}
`;

test('a signed guard over the loop-init arg blocks the flip through the substitution channel', () => {
  expect(emit(GSUB)).not.toMatch(/u32 v\d+;/);
});
