// A READ OF A VOLATILE OBJECT IN A `&&`/`||`'s GUARDED OPERAND, which asmlift cannot place.
//
// `raise/shortcircuit.ts` may hoist a read out of the arm it guards, on the contract that the
// structurer inlines it back under C's own short circuit — so a read in the cone reached that
// position two ways and the emitted C is right for only one of them. For an ordinary cell both
// spellings read the same value and the choice is a matching question; for a cell the map declares
// volatile they are a missing hardware access and a duplicated one. The fold erased which the asm
// had, so the answer is a loud decline, the one `testSkipsAnEffect` gives an effect in the same
// position. Toolchain-free; `guarded-arm-call.test.ts` is the sibling for the op that can be placed.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, structure } from '../src/structure/structure';
import type { SymbolInfo } from '../src/symbols';

const emitWith = (ir: string, symbols?: Map<string, SymbolInfo>): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { returnsVoid: true, ...(symbols ? { symbols } : {}) }));
};

const VOLATILE_MAP = new Map<string, SymbolInfo>([['gVolReg', { name: 'gVolReg', kind: 'data', volatile: true }]]);
const PLAIN_MAP = new Map<string, SymbolInfo>([['gVolReg', { name: 'gVolReg', kind: 'data' }]]);

// `if (a0 > 0 && gVolReg != 0) g(a0);` — the read is the connective's SECOND operand. Lifted from
// two real agbcc objects: compiled from `int t = gVolReg; if (a > 0 && t != 0)` the `ldr` sits above
// the `cmp`, and from `if (a > 0 && gVolReg != 0)` below the `ble`. Both lift to this IR.
const GUARDED_READ = `fn v {
^bb0(%0: s32):
  %1: s32* = gaddr {sym="gVolReg"}
  %2: s32 = load %1 {off=0, signed=true, width=4}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  %5: u32 = icmp_ne %2, %3
  %6: u32 = logic_and %4, %5
  cond_br %6, ^bb1(), ^bb2()
^bb1():
  %7: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret
}
`;

test('a volatile read in an `&&`’s guarded operand declines, and names the cell', () => {
  expect(() => emitWith(GUARDED_READ, VOLATILE_MAP)).toThrow(StructureError);
  expect(() => emitWith(GUARDED_READ, VOLATILE_MAP)).toThrow(/guard a read of the volatile object 'gVolReg'/);
});

test('the declaration is what decides it — an ordinary cell keeps the connective', () => {
  const plain = emitWith(GUARDED_READ, PLAIN_MAP);
  expect(plain).toContain('a0 > 0 && gVolReg != 0');
  // and a map that does not carry the cell at all knows nothing, which is the same answer
  expect(emitWith(GUARDED_READ)).toBe(plain);
});

test('the FIRST operand is unconditional, so a volatile read there is placed already', () => {
  // The one-fact edit: C evaluates `gVolReg != 0` on every evaluation of the test, which is what
  // the asm does, and no fold can have moved it into that position.
  const src = emitWith(GUARDED_READ.replace('logic_and %4, %5', 'logic_and %5, %4'), VOLATILE_MAP);
  expect(src).toContain('gVolReg != 0 && a0 > 0');
});

// `extern volatile int gVolArr[8]; … if (a > 0 && gVolArr[i] != 0) g(a);` — the same hazard reached
// by a SUBSCRIPT, which names the object and no cell. The two agbcc objects, the `ldr` above the
// `cmp` and below the `ble`, emitted one `if (a0 > 0 && gVolArr[a1] != 0)` between them. The walked
// twin is the same access with no `aload` recovered: `gaddr + (i << 2)` under a plain `load`, which
// is what the base has to answer for when the offset is a runtime term either way.
const GUARDED_ELEMENT = `fn v {
^bb0(%0: s32, %1: s32):
  %2: s32* = gaddr {sym="gVolArr"}
  %3: s32 = aload %2, %1 {elemSize=4, signed=true}
  %4: s32 = const {value=0}
  %5: u32 = icmp_sgt %0, %4
  %6: u32 = icmp_ne %3, %4
  %7: u32 = logic_and %5, %6
  cond_br %7, ^bb1(), ^bb2()
^bb1():
  %8: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret
}
`;

const GUARDED_WALKED = `fn v {
^bb0(%0: s32, %1: s32):
  %2: s32* = gaddr {sym="gVolArr"}
  %3: s32 = const {value=2}
  %4: s32 = shl %1, %3
  %5: s32* = add %2, %4
  %6: s32 = load %5 {off=0, signed=true, width=4}
  %7: s32 = const {value=0}
  %8: u32 = icmp_sgt %0, %7
  %9: u32 = icmp_ne %6, %7
  %10: u32 = logic_and %8, %9
  cond_br %10, ^bb1(), ^bb2()
^bb1():
  %11: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret
}
`;

const VOLATILE_ARRAY = new Map<string, SymbolInfo>([
  [
    'gVolArr',
    {
      name: 'gVolArr',
      kind: 'data',
      volatile: true,
      shape: 'array',
      size: 32,
      elemSize: 4,
      elemSigned: true,
      dims: [8],
    },
  ],
]);

test.each([
  ['a subscript', GUARDED_ELEMENT],
  ['walked arithmetic', GUARDED_WALKED],
  ['a walk that counts down', GUARDED_WALKED.replace('add %2, %4', 'sub %2, %4')],
])('%s reaches the same volatile object, so it declines too', (_label, ir) => {
  expect(() => emitWith(ir, VOLATILE_ARRAY)).toThrow(/guard a read of the volatile object 'gVolArr'/);
});

// A MIXED-VOLATILITY STRUCT, which is what the `vu16 field;` idiom produces: pokeemerald's `gMain`
// declares 23 members and qualifies one, and six more of the corpus's mapped globals have the same
// shape. The guarded read is decided per MEMBER — the qualified one is the hazard above, an
// ordinary one beside it is an ordinary cell whose placement is a matching question.
const GUARDED_MEMBER = (off: number): string => `fn v {
^bb0(%0: s32):
  %1: s32* = gaddr {sym="gIo"}
  %2: s32 = load %1 {off=${off}, signed=true, width=4}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  %5: u32 = icmp_ne %2, %3
  %6: u32 = logic_and %4, %5
  cond_br %6, ^bb1(), ^bb2()
^bb1():
  %7: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret
}
`;

const MIXED_STRUCT = new Map<string, SymbolInfo>([
  [
    'gIo',
    {
      name: 'gIo',
      kind: 'data',
      shape: 'struct',
      structName: 'S',
      size: 8,
      layout: [
        { name: 'a', offset: 0, size: 4, signed: true },
        { name: 'b', offset: 4, size: 4, signed: true, volatile: true },
      ],
    },
  ],
]);

test('a plain member of a partly-volatile struct keeps the connective', () => {
  expect(emitWith(GUARDED_MEMBER(0), MIXED_STRUCT)).toContain('a0 > 0 && gIo.a != 0');
});

test('the volatile member of that same struct declines', () => {
  expect(() => emitWith(GUARDED_MEMBER(4), MIXED_STRUCT)).toThrow(/guard a read of the volatile object 'gIo'/);
});
