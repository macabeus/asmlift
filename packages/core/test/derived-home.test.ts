// The derived-read-home axis (structure.ts homeDerivedReads, rank.ts `/derived-home`): a pure
// non-const value with 2+ consumers standing on a memory read materializes, and the read then
// renders exactly once inside it — the register the asm carried the DERIVED value in, where the
// default homes the read and re-derives the computation at every use. Off by default.
//
// What these tests pin is the SCOPE, since the sibling homing axes already own the neighbouring
// shapes: the read is what admits a straight-line value at all (nothing else in the cone is
// evidence the compiler kept a register), and the refusals hold — a cone crossing a `call`, a
// standalone address in the cone, a write (a store or a call) able to execute between the read and
// the value's own position, and a read outside the value's own block — above a branch or outside a
// loop — where homing would change which paths read, and how often.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { hasDerivedReadHome } from '../src/structure/analysis';
import { structure } from '../src/structure/structure';
import type { SymbolInfo } from '../src/symbols';

const emitWith = (ir: string, on: boolean, symbols?: Map<string, SymbolInfo>, returnsVoid = true): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { homeDerivedReads: on, returnsVoid, ...(symbols ? { symbols } : {}) }));
};

const emit = (ir: string, on: boolean, returnsVoid = true): string => emitWith(ir, on, undefined, returnsVoid);

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

// A cone crossing a CALL, with the call ABOVE the read so no write barrier stands between the read
// and the value: homing moves the call DOWN to the value's own position, a side effect executing
// somewhere the asm never ran it. Without the cone's `call` refusal this emits
// `v0 = *(u8 *)134576844 ^ get(a0);` — the read first, where the asm called first.
const OVERCALL = `fn overcall {
^bb0(%0: u32):
  %1: u32 = call %0 {target="get"}
  %2: u32 = const {value=134576844}
  %3: u32 = load %2 {off=0, signed=false, width=1}
  %4: u32 = xor %3, %1
  %5: u32 = const {value=50333696}
  store %5, %4 {off=0, width=2}
  %6: u32 = const {value=50333700}
  store %6, %4 {off=0, width=2}
  ret %4
}
`;

test('a cone crossing a call is not homed', () => {
  expect(emit(OVERCALL, true, false)).toBe(emit(OVERCALL, false, false));
  expect(hasDerivedReadHome(parse(OVERCALL))).toBe(false);
});

// A gaddr reached OUTSIDE a read's address: rendered standalone the address computation loses the
// memAccess's inline byte-stride cast, so the value it names is not the value the uses see. (The
// same gaddr UNDER a read is this axis's own clientele — the DERIVED fixture's `/raw-globals`
// sibling — because the address stays inline at the deref.) The sum is INT-typed, so the
// pointer-value refusal cannot pre-empt this one: without the cone's gaddr arm it homes as
// `v0 = (u32)&gTable + *(u8 *)134576844;`.
const ADDRCONE = `fn addrcone {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  %3: u8* = gaddr {sym="gTable"}
  %4: u32 = add %3, %2
  %5: u32 = const {value=3}
  %6: u32 = mul %4, %5
  %7: u32 = add %4, %6
  ret %7
}
`;

test('a standalone address in the cone is not homed', () => {
  expect(emit(ADDRCONE, true, false)).toBe(emit(ADDRCONE, false, false));
  expect(hasDerivedReadHome(parse(ADDRCONE))).toBe(false);
});

// The value IS an address — a pointer loaded from a global, offset and then both dereferenced and
// compared. Its gaddr sits UNDER the read, where the cone walk stops, so only the value's own type
// answers: homed, the byte offset renders OUTSIDE the pointer cast, `(u16 *)(gPtr + 8)` where the
// inline form reads `*(v0 + 4)` — element arithmetic, +16 bytes against +8.
const PTRVALUE = `fn ptrvalue {
^bb0(%0: u32):
  %1: u16** = gaddr {sym="gPtr"}
  %2: u16* = load %1 {off=0, signed=false, width=4}
  %3: u32 = const {value=8}
  %4: u16* = add %2, %3
  %5: u32 = load %4 {off=0, signed=false, width=2}
  %6: u32 = load %4 {off=2, signed=false, width=2}
  %7: u32 = add %5, %6
  %8: u32 = const {value=0}
  %9: u32 = icmp_ne %4, %8
  %10: u32 = add %7, %9
  ret %10
}
`;

test('a value that is itself an address is not homed', () => {
  const off = emit(PTRVALUE, false, false);
  expect(emit(PTRVALUE, true, false)).toBe(off);
  expect(off).toContain('*(v0 + 4)');
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

// The read above a branch, the value inside one arm: rendering the read at the value's own
// position runs it only when the arm is taken. Harmless for an ordinary cell and a worse spelling
// than the asm's, but for a VOLATILE one it is an access that no longer happens — and no write
// barrier can see that either.
const READABOVEBRANCH = `fn readabovebranch {
^bb0(%0: u32):
  %1: u32 = const {value=67109168}
  %2: u32 = load %1 {off=0, signed=false, width=2}
  %3: u32 = const {value=0}
  %4: u32 = icmp_ne %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: u32 = const {value=1023}
  %6: u32 = xor %5, %2
  %7: u32 = const {value=50333696}
  store %7, %6 {off=0, width=2}
  %8: u32 = const {value=50333700}
  store %8, %6 {off=0, width=2}
  br ^bb2()
^bb2():
  ret
}
`;

test('a value in a block its read sits above is not homed', () => {
  expect(emit(READABOVEBRANCH, true)).toBe(emit(READABOVEBRANCH, false));
});

// ── the read renders ONCE ────────────────────────────────────────────────────────────────────
// The axis's whole claim. Homing resolves a render position for a read that had none, so any
// SECOND consumer of that read resolves a second one and the multi-render load rule inlines it at
// both — two accesses where the asm has one `ldrh`.

// `0x3FF ^ REG_KEYINPUT` twice-consumed, with the raw halfword consumed once more beside it.
const SECONDUSE = `fn seconduse {
^bb0():
  %0: u32 = const {value=67109168}
  %1: u32 = load %0 {off=0, signed=false, width=2}
  %2: u32 = const {value=1023}
  %3: u32 = xor %2, %1
  %4: u32 = add %3, %1
  %5: u32 = mul %4, %3
  ret %5
}
`;

test('a read consumed outside the homed value is not homed — it would render twice', () => {
  expect(emit(SECONDUSE, true, false)).toBe(emit(SECONDUSE, false, false));
  expect(count(emit(SECONDUSE, true, false), '67109168')).toBe(1);
});

// TWO values over ONE read of a global the map declares volatile. Each is the other's second
// consumer, so the same rule refuses both — and `volatileGlobal`'s contract (a volatile read is
// neither duplicated nor moved), which `/reread-globals` honours in this same shape, holds here too.
const TWOHOMES = `fn twohomes {
^bb0():
  %0: s32* = gaddr {sym="gVolReg"}
  %1: s32 = load %0 {off=0, signed=true, width=4}
  %2: s32 = const {value=1023}
  %3: s32 = xor %1, %2
  %4: s32 = const {value=15}
  %5: s32 = and %1, %4
  %6: s32* = gaddr {sym="gOutA"}
  store %6, %3 {off=0, width=4}
  %7: s32* = gaddr {sym="gOutB"}
  store %7, %3 {off=0, width=4}
  %8: s32* = gaddr {sym="gOutC"}
  store %8, %5 {off=0, width=4}
  %9: s32* = gaddr {sym="gOutD"}
  store %9, %5 {off=0, width=4}
  ret
}
`;

test('two values over one volatile read leave it reading once', () => {
  const volatileMap = new Map<string, SymbolInfo>([['gVolReg', { name: 'gVolReg', kind: 'data', volatile: true }]]);
  const on = emitWith(TWOHOMES, true, volatileMap);
  expect(count(on, 'gVolReg')).toBe(1);
  expect(on).toBe(emitWith(TWOHOMES, false, volatileMap));
});

// Two independent MMIO reads whose derived values sit in the opposite order. Homing both would put
// 0x04000134's access before 0x04000130's; a read outside the cone bars the move, so the lower
// value homes and the upper read keeps its own position.
const REORDER = `fn reorder {
^bb0():
  %0: u32 = const {value=67109168}
  %1: u32 = load %0 {off=0, signed=false, width=2}
  %2: u32 = const {value=67109172}
  %3: u32 = load %2 {off=0, signed=false, width=2}
  %4: u32 = const {value=1023}
  %5: u32 = xor %4, %3
  %6: u32 = xor %4, %1
  %7: u32 = const {value=50333696}
  store %7, %5 {off=0, width=2}
  %8: u32 = const {value=50333698}
  store %8, %5 {off=0, width=2}
  %9: u32 = const {value=50333700}
  store %9, %6 {off=0, width=2}
  %10: u32 = const {value=50333702}
  store %10, %6 {off=0, width=2}
  ret
}
`;

test('a read outside the cone bars the move, so two accesses keep their order', () => {
  const on = emit(REORDER, true);
  expect(on.indexOf('67109168')).toBeLessThan(on.indexOf('67109172'));
});
