// The VALUE-HOME axis (structure.ts `rereadGlobals`, rank.ts `/reread-globals`): may a read of a
// named global render at each of its uses, instead of being cached in a local the source never had?
//
// Two mechanisms invent that local, and both are here:
//   1. the WRITE BARRIER — any store between the read and its use bars re-rendering, even a store
//      to an unrelated global that cannot possibly change what the read sees;
//   2. the RENDER POSITION — a pure expression consumed twice has no single emit position, so
//      every read feeding it is materialized, however harmless re-reading would be.
//
// Materializing is always sound, so the default spelling is never WRONG — it is just often not the
// one the compiler was given. Hence an axis the differ referees, and hence the refusal tests: a
// same-global store, an unresolvable base, a call, and a volatile declaration must all keep the
// local.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import type { SymbolInfo } from '../src/symbols';

const emit = (ir: string, rereadGlobals: boolean, symbols?: Map<string, SymbolInfo>): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { rereadGlobals, ...(symbols ? { symbols } : {}) }));
};

// `gOut = gValue; return gValue;` — the read is used twice, with a store to ANOTHER global between
// the def and the second render.
const STORE_BETWEEN = `fn f {
^bb0():
  %0: s32* = gaddr {sym="gValue"}
  %1: s32 = load %0 {off=0, signed=true, width=4}
  %2: s32* = gaddr {sym="gOut"}
  store %2, %1 {off=0, width=4}
  ret %1
}
`;

// the same shape, but the store goes to the very global being read
const SAME_GLOBAL = `fn f {
^bb0():
  %0: s32* = gaddr {sym="gValue"}
  %1: s32 = load %0 {off=0, signed=true, width=4}
  store %0, %1 {off=4, width=4}
  ret %1
}
`;

// the store's base is a parameter — unknown memory, which may well BE gValue
const UNKNOWN_BASE = `fn f {
^bb0(%p: s32*):
  %0: s32* = gaddr {sym="gValue"}
  %1: s32 = load %0 {off=0, signed=true, width=4}
  store %p, %1 {off=0, width=4}
  ret %1
}
`;

// a call sits between the read and its second render — it may write anything
const CALL_BETWEEN = `fn f {
^bb0():
  %0: s32* = gaddr {sym="gValue"}
  %1: s32 = load %0 {off=0, signed=true, width=4}
  %2: s32 = call %1 {target="sink"}
  ret %1
}
`;

describe('the write barrier', () => {
  test('OFF: a store to an unrelated global forces the read into a local', () => {
    const out = emit(STORE_BETWEEN, false);
    expect(out).toContain('v0 = gValue;');
    expect(out).toContain('gOut = v0;');
    expect(out).toContain('return v0;');
  });

  test('ON: the read renders at each use — the spelling the source had', () => {
    const out = emit(STORE_BETWEEN, true);
    expect(out).toContain('gOut = gValue;');
    expect(out).toContain('return gValue;');
    expect(out).not.toContain('v0');
  });

  test('a store to the SAME global still bars — offsets are not compared', () => {
    // (the interior store also makes gValue an AGGREGATE, hence the address-cast spelling)
    expect(emit(SAME_GLOBAL, true)).toContain('v0 = *(s32 *)&gValue;');
  });

  test('a store through an unresolvable base still bars', () => {
    expect(emit(UNKNOWN_BASE, true)).toContain('v0 = gValue;');
  });

  test('a call still bars — it may write anything', () => {
    expect(emit(CALL_BETWEEN, true)).toContain('v0 = gValue;');
  });
});

describe('the render position', () => {
  // `gOut = (gValue << 1) + gValue; return (gValue << 1) + gValue;` — the pure expression is
  // consumed twice, so it has no single emit position and every read feeding it is materialized.
  const TWO_RENDERS = `fn f {
^bb0():
  %0: s32* = gaddr {sym="gValue"}
  %1: s32 = load %0 {off=0, signed=true, width=4}
  %2: s32 = shl %1 {imm=1}
  %3: s32 = load %0 {off=0, signed=true, width=4}
  %4: s32 = add %2, %3
  %5: s32* = gaddr {sym="gOut"}
  store %5, %4 {off=0, width=4}
  ret %4
}
`;

  test('OFF: two locals, because the expression they feed renders twice', () => {
    const out = emit(TWO_RENDERS, false);
    expect(out).toContain('v0 = gValue;');
    expect(out).toContain('v1 = gValue;');
  });

  test('ON: every render position is path-checked instead of refusing outright', () => {
    const out = emit(TWO_RENDERS, true);
    expect(out).toContain('gOut = (gValue << 1) + gValue;');
    expect(out).toContain('return (gValue << 1) + gValue;');
  });
});

describe('volatile', () => {
  const volatileMap = new Map<string, SymbolInfo>([
    ['gValue', { name: 'gValue', kind: 'data', volatile: true }],
  ]);

  test('a read the map declares VOLATILE keeps its local — the access may not be duplicated', () => {
    expect(emit(STORE_BETWEEN, true, volatileMap)).toContain('v0 = gValue;');
  });

  test('the same map without the volatile qualifier re-reads', () => {
    const plain = new Map<string, SymbolInfo>([['gValue', { name: 'gValue', kind: 'data' }]]);
    expect(emit(STORE_BETWEEN, true, plain)).toContain('gOut = gValue;');
  });
});
