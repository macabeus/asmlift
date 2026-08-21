// The address-home axis (structure.ts homeSharedAddresses, rank.ts `/addr-home`): a pure computed
// address dereferenced at 2+ sites materializes into a local, and so do the multi-render loads
// through it — the source's `u8 *entry = ...; type = entry[1]; idx = entry[0];` spelling, where
// the default re-derives the address (a pool literal per folded offset) and re-reads per use.
// Off by default.
//
// The scope conditions are what these tests pin: base-slot-only consumption, 2+ distinct memory
// accesses, no gaddr/laddr in the cone, and loads homed only through an axis-homed base.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { hasHomeableSharedAddress } from '../src/structure/analysis';
import { structure } from '../src/structure/structure';

const emit = (ir: string, on: boolean): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { homeSharedAddresses: on }));
};

const count = (s: string, needle: string): number => s.split(needle).length - 1;

// The entry-pair shape: one computed address, two byte loads through it (offsets 1 and 0), each
// loaded value read again past the branch.
const PAIR = `fn pair {
^bb0(%0: u32, %1: u32):
  %2: s32 = const {value=2}
  %3: u32 = shl %0, %2
  %4: s32 = const {value=1}
  %5: u32 = shl %1, %4
  %6: u32 = add %3, %5
  %7: s32 = const {value=134576844}
  %8: u32 = add %6, %7
  %9: s32 = load %8 {off=1, signed=false, width=1}
  %10: s32 = load %8 {off=0, signed=false, width=1}
  %11: u32 = icmp_ne %9, %2
  cond_br %11, ^bb1(), ^bb2()
^bb1():
  %12: s32 = add %9, %10
  br ^bb3(%12)
^bb2():
  %13: s32 = sub %10, %9
  br ^bb3(%13)
^bb3(%14: s32):
  ret %14
}
`;

test('a shared computed address homes into a local, and the loads through it home too', () => {
  const on = emit(PAIR, true);
  // the address derives once, into a named local
  expect(count(on, '134576844')).toBe(1);
  expect(on).toMatch(/v\d+ = \(a0 << 2\) \+ \(a1 << 1\) \+ 134576844;/);
  // both loads render as named pre-branch temps through the homed base
  expect(on).toMatch(/v\d+ = \(\(u8 \*\)v\d+\)\[1\];/);
  expect(on).toMatch(/v\d+ = \*\(u8 \*\)v\d+;/);
});

test('off by default: the same IR keeps the re-derive spelling', () => {
  const off = emit(PAIR, false);
  expect(count(off, '134576844')).toBeGreaterThanOrEqual(2);
  expect(emit(PAIR, false)).toBe(off);
});

test('the enumeration gate sees the pair shape', () => {
  expect(hasHomeableSharedAddress(parse(PAIR))).toBe(true);
});

// The base ALSO escapes into arithmetic (returned as a value) — not base-slot-only, so the axis
// must stay silent: the home is justified by shared-base reuse alone.
const ESCAPES = PAIR.replace('  %12: s32 = add %9, %10', '  %12: s32 = add %8, %10');

test('a base that escapes into arithmetic is not homed', () => {
  const on = emit(ESCAPES, true);
  expect(count(on, '134576844')).toBeGreaterThanOrEqual(2);
  expect(hasHomeableSharedAddress(parse(ESCAPES))).toBe(false);
});

// One deref only: a single access re-materializes as cheaply as a named local would.
const SINGLE = `fn single {
^bb0(%0: u32, %1: u32):
  %2: s32 = const {value=2}
  %3: u32 = shl %0, %2
  %4: s32 = const {value=1}
  %5: u32 = shl %1, %4
  %6: u32 = add %3, %5
  %7: s32 = const {value=134576844}
  %8: u32 = add %6, %7
  %9: s32 = load %8 {off=1, signed=false, width=1}
  %10: s32 = add %9, %9
  ret %10
}
`;

test('a base with one access is not homed', () => {
  expect(emit(SINGLE, true)).toBe(emit(SINGLE, false));
  expect(hasHomeableSharedAddress(parse(SINGLE))).toBe(false);
});

// A gaddr in the cone: rendered standalone, the address computation loses the memAccess's
// byte-stride cast — those stay with the cast-aware base machinery (the addressCone refusal).
const GADDR = `fn withsym {
^bb0(%0: u32):
  %1: u16* = gaddr {sym="gTable"}
  %2: u32 = add %1, %0
  %3: s32 = load %2 {off=0, signed=false, width=2}
  %4: s32 = load %2 {off=2, signed=false, width=2}
  %5: s32 = icmp_ne %3, %4
  cond_br %5, ^bb1(), ^bb2()
^bb1():
  br ^bb2()
^bb2():
  %6: s32 = add %3, %4
  ret %6
}
`;

test('a base whose cone holds a gaddr is not homed', () => {
  expect(emit(GADDR, true)).toBe(emit(GADDR, false));
  expect(hasHomeableSharedAddress(parse(GADDR))).toBe(false);
});
