// The derived-read-home axis (structure.ts homeDerivedReads, rank.ts `/derived-home`): a pure
// non-const value with 2+ consumers standing on a memory read materializes, and the read then
// renders exactly once inside it — the register the asm carried the DERIVED value in, where the
// default homes the read and re-derives the computation at every use. Off by default.
//
// What these tests pin is the SCOPE, since the sibling homing axes already own the neighbouring
// shapes: the read is what admits a straight-line value at all (nothing else in the cone is
// evidence the compiler kept a register), and the refusals hold — a cone crossing a `call`, a
// standalone address in the cone, a write (a store or a call) able to execute between the read and
// the value's own position, and a value inside a loop its read sits outside.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { hasDerivedReadHome } from '../src/structure/analysis';
import { structure } from '../src/structure/structure';

const emit = (ir: string, on: boolean, returnsVoid = true): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { homeDerivedReads: on, returnsVoid }));
};

const count = (s: string, needle: string): number => s.split(needle).length - 1;

// ── the isolate: ReadKeyInput's shape, reduced ───────────────────────────────────────────────
// `u16 pressed = 0x3FF ^ REG_KEYINPUT;` stored twice and tested once. The read cannot render at
// three places (it is a halfword MMIO read with stores in between), so today it homes and the xor
// re-derives from that local per use — three `eor`s where the asm has one.
const DERIVED = `fn derived {
^bb0():
  %0: u32 = const {value=67109168}
  %1: u32 = load %0 {off=0, signed=false, width=2}
  %2: u32 = const {value=1023}
  %3: u32 = xor %2, %1
  %4: u32 = const {value=50333696}
  store %4, %3 {off=0, width=2}
  %5: u32 = const {value=50333700}
  store %5, %3 {off=0, width=2}
  %6: u32 = const {value=15}
  %7: u32 = and %3, %6
  ret %7
}
`;

test('a multi-consumer value over a read homes, and the read renders once inside it', () => {
  const on = emit(DERIVED, true, false);
  expect(count(on, '1023 ^')).toBe(1);
  expect(count(on, '67109168')).toBe(1);
  expect(hasDerivedReadHome(parse(DERIVED))).toBe(true);
});

test('off by default: the read homes instead and the xor re-derives per use', () => {
  const off = emit(DERIVED, false, false);
  expect(count(off, '1023 ^')).toBe(3);
  expect(emit(DERIVED, false, false)).toBe(off);
});

// The same multi-use arithmetic with NO read under it — derivable from a parameter and constants
// at every use, which is what the compiler re-materializes for free (the small-constant class).
const NOREAD = `fn noread {
^bb0(%0: u32):
  %1: u32 = const {value=1023}
  %2: u32 = xor %1, %0
  %3: u32 = const {value=50333696}
  store %3, %2 {off=0, width=2}
  %4: u32 = const {value=50333700}
  store %4, %2 {off=0, width=2}
  ret %2
}
`;

test('a value with no read in its cone is not homed', () => {
  expect(emit(NOREAD, true, false)).toBe(emit(NOREAD, false, false));
  expect(hasDerivedReadHome(parse(NOREAD))).toBe(false);
});

// A cone crossing a CALL: homing the value would move the call to the value's own position, which
// is a side effect executing somewhere the asm never ran it.
const OVERCALL = `fn overcall {
^bb0(%0: u32):
  %1: u32 = call %0 {target="get"}
  %2: u32 = const {value=1023}
  %3: u32 = xor %2, %1
  %4: u32 = const {value=50333696}
  store %4, %3 {off=0, width=2}
  %5: u32 = const {value=50333700}
  store %5, %3 {off=0, width=2}
  ret %3
}
`;

test('a cone crossing a call is not homed', () => {
  expect(emit(OVERCALL, true, false)).toBe(emit(OVERCALL, false, false));
  expect(hasDerivedReadHome(parse(OVERCALL))).toBe(false);
});

// A gaddr reached OUTSIDE a read's address: rendered standalone the address computation loses the
// memAccess's inline byte-stride cast, so the value it names is not the value the uses see. (The
// same gaddr UNDER a read is this axis's own clientele — the DERIVED fixture's `/raw-globals`
// sibling — because the address stays inline at the deref.)
const ADDRCONE = `fn addrcone {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  %3: u16* = gaddr {sym="gTable"}
  %4: u16* = add %3, %2
  %5: u32 = load %4 {off=0, signed=false, width=2}
  %6: u32 = load %4 {off=2, signed=false, width=2}
  %7: u32 = add %5, %6
  ret %7
}
`;

test('a standalone address in the cone is not homed', () => {
  expect(emit(ADDRCONE, true, false)).toBe(emit(ADDRCONE, false, false));
  expect(hasDerivedReadHome(parse(ADDRCONE))).toBe(false);
});

// A store between the read and the value: homing moves the read down across it, and on this IR the
// store may alias, so the read would see memory it never saw. The enumeration gate cannot know
// (it has no positioned model) — the axis's own rule is what refuses.
const WRITEBETWEEN = `fn writebetween {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  store %0, %1 {off=0, width=4}
  %3: u32 = const {value=1023}
  %4: u32 = xor %3, %2
  %5: u32 = const {value=50333696}
  store %5, %4 {off=0, width=2}
  %6: u32 = const {value=50333700}
  store %6, %4 {off=0, width=2}
  ret %4
}
`;

test('a write between the read and the value refuses the home', () => {
  expect(emit(WRITEBETWEEN, true, false)).toBe(emit(WRITEBETWEEN, false, false));
  expect(hasDerivedReadHome(parse(WRITEBETWEEN))).toBe(true); // the gate admits; the rule refuses
});

// The read outside a loop, the value inside it: rendering the read at the value's own position
// runs it once per iteration. Nothing writes here, so no barrier sees it — for a volatile cell
// that is a second ACCESS, and for any other a second load.
const READINLOOP = `fn readinloop {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  %3: u32 = const {value=0}
  br ^bb1(%3)
^bb1(%4: u32):
  %5: u32 = const {value=1023}
  %6: u32 = xor %5, %2
  %7: u32 = add %4, %6
  %8: u32 = mul %7, %6
  %9: u32 = const {value=10}
  %10: u32 = icmp_ult %8, %9
  cond_br %10, ^bb1(%8), ^bb2()
^bb2():
  ret %8
}
`;

test('a value inside a loop its read sits outside is not homed', () => {
  expect(emit(READINLOOP, true, false)).toBe(emit(READINLOOP, false, false));
});

// A call between the read and the value: it may write anything the read looked at, so moving the
// read past it is the same refusal a store earns (`call` is in EFFECTFUL_OPS).
const CALLBETWEEN = `fn callbetween {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  %3: u32 = call %0 {target="side"}
  %4: u32 = const {value=1023}
  %5: u32 = xor %4, %2
  %6: u32 = const {value=50333696}
  store %6, %5 {off=0, width=2}
  %7: u32 = const {value=50333700}
  store %7, %5 {off=0, width=2}
  ret %3
}
`;

test('a call between the read and the value refuses the home', () => {
  expect(emit(CALLBETWEEN, true, false)).toBe(emit(CALLBETWEEN, false, false));
});
