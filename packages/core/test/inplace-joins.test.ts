// The in-place-join axis (structure.ts materializeJoinFeeds, rank.ts `/inplace`): a load whose
// result rides a `cond_br` edge as a successor arg is materialized, so the naming walk homes the
// merge in the load's own variable, the identity arm elides, and the `if` renders one-sided —
// `v = *p; if (v > 31) v = 32;`. Off by default.
//
// The scope conditions are what these tests pin: only a LOAD, and only a `cond_br` arg — a const
// merge copy stays `/defsite`'s question, and a plain `br` arg (a loop-carried value) stays the
// loop-param machinery's.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string, on: boolean): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { materializeJoinFeeds: on }));
};

// The clamp shape (a u16 load summed under a ceiling, inside a countdown loop): the load feeds
// the merge on the taken edge, the const 32 on the other.
const CLAMP = `fn clamp {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_sge %1, %0
  cond_br %2, ^bb5(%1), ^bb1()
^bb1():
  %3: u16* = const {value=50331664}
  br ^bb2(%3, %1, %0)
^bb2(%4: u16*, %5: s32, %6: s32):
  %7: s32 = load %4 {off=0, signed=false, width=2}
  %8: s32 = const {value=31}
  %9: u32 = icmp_sle %7, %8
  cond_br %9, ^bb4(%7), ^bb3()
^bb3():
  %10: s32 = const {value=32}
  br ^bb4(%10)
^bb4(%11: s32):
  %12: s32 = add %5, %11
  %13: s32 = const {value=2}
  %14: u16* = add %4, %13
  %15: s32 = const {value=1}
  %16: s32 = sub %6, %15
  %17: s32 = const {value=0}
  %18: u32 = icmp_ne %16, %17
  cond_br %18, ^bb2(%14, %12, %16), ^bb5(%12)
^bb5(%19: s32):
  ret %19
}
`;

test('a load feeding a cond_br join renders as a one-sided in-place overwrite', () => {
  const on = emit(CLAMP, true);
  expect(on).toContain('v0 = *v1;');
  // the single-line render is the one-sided form — a two-armed if opens a brace
  expect(on).toContain('if (v0 > 31) v0 = 32;');
  expect(on).not.toContain('v0 = 32;\n            } else');
});

test('off by default: the same IR keeps the fresh-variable two-armed spelling', () => {
  const off = emit(CLAMP, false);
  expect(off).toContain('if (*v0 > 31) {');
  expect(off).toContain('v3 = *v0;');
  expect(off).toContain('v3 = 32;');
  expect(emit(CLAMP, false)).toBe(off);
});

// A const feeding the same merge shape is NOT this axis's case — /defsite owns constant
// placement, and the load gate must leave it exactly as the default renders it.
const CONSTFED = `fn constfed {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=7}
  %3: u32 = icmp_ne %0, %2
  cond_br %3, ^bb2(%1), ^bb1()
^bb1():
  %4: s32 = const {value=1}
  br ^bb2(%4)
^bb2(%5: s32):
  ret %5
}
`;

test('a const-fed merge is untouched (that placement is /defsite)', () => {
  expect(emit(CONSTFED, true)).toBe(emit(CONSTFED, false));
});

// A load riding a PLAIN `br` arg is a loop-carried value: its home is the loop-param
// machinery's question, so the axis leaves it alone.
const BRFED = `fn brfed {
^bb0(%0: s32*):
  %1: s32 = load %0 {off=0, signed=true, width=4}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = sub %2, %3
  %5: s32 = const {value=0}
  %6: u32 = icmp_ne %4, %5
  cond_br %6, ^bb1(%4), ^bb2()
^bb2():
  ret %4
}
`;

test('a load feeding a plain br arg is untouched (loop-carried value)', () => {
  expect(emit(BRFED, true)).toBe(emit(BRFED, false));
});
