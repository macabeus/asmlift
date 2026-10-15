// The unsigned-compare spelling (structure.ts unsignedCompareSpelling): an icmp_u* whose operands
// both render as signed-promoting C compiles to a signed compare — the u32-ness dies when a local
// declares with its first claimant's s32 type or when the operand is an inline `int`-typed
// tree. With the option on, one operand takes a (u32) cast (the side whose recovered value type
// is unsigned) and a mixed-claimant declaration reconciles to u32. On by default; OFF is the
// `/signed-cmp` variation, which publishes only byte-exact (signed-cmp.test.ts).
//
// The refusals are what these tests pin: a provably-unsigned operand leaves the spelling alone,
// and so does a compare whose operands both provably sit in [0, 2^31) — `(u8)x > 4` is
// value-faithful spelled signed, and the compiler picks the unsigned branch itself (the ult5
// matching fixture). ==/!= never cast.
//
// The SIGNED direction is not the variation and is pinned at the end of this file: there the opcode
// names the compare, so every operand short of a proof that it already renders signed takes a
// cast — a pointer-rendered side included.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { signedOverUnsignedCompare } from '../src/l3/typing';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

// `on` undefined ⇒ the option is not passed at all, so the test reads structure()'s own default.
const emit = (ir: string, on?: boolean): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, on === undefined ? {} : { unsignedCompareSpelling: on }));
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

// A masked value against a constant: `x & 65535` is in [0, 65535] whatever `x` is, so the compare
// means the same signed or unsigned and needs no cast (kmc's `unsigned short c = g() + 1; c >= 24`).
const MASKCMP = `fn maskcmp {
^bb0(%0: s32):
  %1: s32 = const {value=65535}
  %2: s32 = and %0, %1
  %3: s32 = const {value=24}
  %4: u32 = icmp_uge %2, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: s32 = const {value=1}
  ret %5
^bb2():
  %6: s32 = const {value=0}
  ret %6
}
`;

test('a masked operand keeps the signed spelling (the mask makes it non-negative)', () => {
  const src = emit(MASKCMP);
  expect(src).toMatch(/\(a0 & 65535\) (<|>=) 24/);
  expect(src).not.toContain('(u32)');
});

// `|` and `^` of two masked values set no bit either side lacks, so the result is non-negative too:
// `(a & 240 | b & 3 ^ 192) > 48` means the same signed or unsigned. The default still pins it,
// because the pin is codegen-visible (mwcc `cmplwi` against `cmpwi`, typing.ts
// spelledNonNegative), and the uncast spelling owes no proof.
const ORXORCMP = `fn orxorcmp {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=240}
  %3: s32 = and %0, %2
  %4: s32 = const {value=3}
  %5: s32 = and %1, %4
  %6: s32 = or %3, %5
  %7: s32 = const {value=192}
  %8: s32 = xor %6, %7
  %9: s32 = const {value=48}
  %10: u32 = icmp_ugt %8, %9
  cond_br %10, ^bb1(), ^bb2()
^bb1():
  %11: s32 = const {value=1}
  ret %11
^bb2():
  %12: s32 = const {value=0}
  ret %12
}
`;

const structured = (ir: string, on: boolean) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return structure(fn, { unsignedCompareSpelling: on });
};

test('an or/xor of masked operands keeps the pin, and its uncast spelling owes no proof', () => {
  expect(emit(ORXORCMP)).toContain('(u32)');
  const uncast = structured(ORXORCMP, false);
  expect(cBackend.emit(uncast)).not.toContain('(u32)');
  expect(signedOverUnsignedCompare(uncast)).toBe(false);
});

// One side that may be negative makes the whole `|` possibly negative: the uncast spelling owes it.
const ORNEGCMP = `fn ornegcmp {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=240}
  %3: s32 = and %0, %2
  %4: s32 = or %3, %1
  %5: s32 = const {value=48}
  %6: u32 = icmp_ugt %4, %5
  cond_br %6, ^bb1(), ^bb2()
^bb1():
  %7: s32 = const {value=1}
  ret %7
^bb2():
  %8: s32 = const {value=0}
  ret %8
}
`;

test('an or with a possibly-negative side owes the proof uncast', () => {
  expect(emit(ORNEGCMP)).toContain('(u32)');
  const uncast = structured(ORNEGCMP, false);
  expect(signedOverUnsignedCompare(uncast)).toBe(true);
  expect(signedOverUnsignedCompare(structured(ORNEGCMP, true))).toBe(false);
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

test('on by default: with no option set, an unsigned compare is spelled unsigned', () => {
  expect(emit(LOOPBOUND)).toMatch(/\(u32\)/);
  expect(emit(RECON)).toMatch(/u32 v\d+;/);
});

test('switched off, the spelling keeps the uncast signed rendering', () => {
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

// ── the SIGNED direction ───────────────────────────────────────────────────────────────────
// Not the variation, and not a spelling choice: an icmp_s* operand that renders UNSIGNED makes C
// compare unsigned, which is the compare the machine did not do. Where the other side is a
// constant the test folds away entirely — agbcc compiles `(u32)a / b < 0` to `mov r0, #0`,
// deleting the divide call with it. Always on, and it fires only where the rendering provably
// disagrees with the opcode.
const SIGNEDCMP = `fn signedcmp {
^bb0(%0: u32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_slt %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: s32 = const {value=1}
  ret %3
^bb2():
  %4: s32 = const {value=0}
  ret %4
}
`;

test('a signed compare over an unsigned-rendering operand takes the (s32) cast', () => {
  expect(emit(SIGNEDCMP, false)).toMatch(/\(s32\)a0 [<>]=? 0/);
});

// A signed compare whose operands already render signed is left alone — the everyday case, and
// the reason this cannot churn the corpus.
const SIGNEDOK = `fn signedok {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_slt %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: s32 = const {value=1}
  ret %3
^bb2():
  %4: s32 = const {value=0}
  ret %4
}
`;

test('a signed compare over signed-rendering operands keeps its spelling', () => {
  expect(emit(SIGNEDOK, false)).not.toContain('(s32)');
});

// An operand whose rendering the model CANNOT determine takes the cast just the same. A callee's
// return type is the project header's, not this function's — and with `u32 getv(void);` in scope
// agbcc compiles `if (getv() >= 0)` to `bl getv; mov r0, #0x0`, deleting the comparison and both
// arms, where `if ((s32)getv() >= 0)` keeps `cmp r0, #0; bge`.
const SIGNEDCMP_CALL = `fn signedcmpcall {
^bb0(%0: s32):
  %1: s32 = call {target="getv"}
  %2: s32 = const {value=0}
  %3: u32 = icmp_slt %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  ret %0
^bb2():
  %4: s32 = const {value=0}
  ret %4
}
`;

test('a signed compare over a call takes the (s32) cast', () => {
  expect(emit(SIGNEDCMP_CALL, false)).toMatch(/\(s32\)getv\(\) [<>]=? 0/);
});

// A constant too big for `int` renders UNSIGNED in C89 and drags the compare with it: over `int a`,
// `a <= -2147483648` compiles to `bls` where `a <= (s32)-2147483648` compiles to `ble`.
const SIGNEDCMP_INTMIN = `fn signedcmpintmin {
^bb0(%0: s32):
  %1: s32 = const {value=-2147483648}
  %2: u32 = icmp_sle %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: s32 = const {value=1}
  ret %3
^bb2():
  %4: s32 = const {value=0}
  ret %4
}
`;

test('a signed compare against a constant too big for `int` casts the constant', () => {
  expect(emit(SIGNEDCMP_INTMIN, false)).toContain('(s32)-2147483648');
});

// A POINTER-rendered side takes the pin too. C compares two addresses unsigned — compiled, agbcc
// spells `p < q` over `int *` as `bcc` and `(int)p < (int)q` as `blt`, IDO as `sltu` and `slt` —
// so an `icmp_slt` over pointers is a source that compared them as integers, and the bare
// `v0 < a1` would compile the unsigned branch.
const PTRWALK = `fn ptrwalk {
^bb0(%0: s32*, %1: s32*):
  %9: s32 = const {value=0}
  br ^bb1(%0, %9)
^bb1(%2: s32*, %10: s32):
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb2(%2, %10), ^bb3(%10)
^bb2(%4: s32*, %11: s32):
  %5: s32 = load %4 {off=0, width=4, signed=true}
  %6: s32 = const {value=4}
  %7: s32* = add %4, %6
  %8: s32 = add %11, %5
  br ^bb1(%7, %8)
^bb3(%12: s32):
  ret %12
}
`;

test('a signed compare between pointer-rendered operands casts both to s32', () => {
  expect(emit(PTRWALK, false)).toMatch(/while \(\(s32\)v0 < \(s32\)a1\)/);
});
