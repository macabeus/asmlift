// A declared struct or union on a target (src/aggregate.ts). Every row of the tables is a compiled
// fact: agbcc at the corpus flags, a caller `T t = mk(x);` reading the result — through memory when
// agbcc reserves a frame and hands `mov r0, sp` over, in r0 when it calls `bl mk` with no frame —
// and mwcc at the synthetic tier's.
import { describe, expect, test } from 'vitest';

import {
  aggregateSize,
  aggregateType,
  byValueCallArgs,
  byValueRefusal,
  returnsInMemory,
  returnsWithoutHiddenPointer,
} from '../src/aggregate';
import { T } from '../src/ir/types';
import { type AggregateLayout, type AggregateMember, spellableProto } from '../src/proto';
import { prototypesFromContext } from '../src/proto-context';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC } from '../src/target';

const struct = (...members: AggregateMember[]): AggregateLayout => ({ kind: 'struct', members });
const union = (...members: AggregateMember[]): AggregateLayout => ({ kind: 'union', members });
const m = (name: string, type: AggregateMember['type'], extra: Partial<AggregateMember> = {}): AggregateMember => ({
  name,
  type,
  ...extra,
});

describe('agbcc (thumb.c:1423-1493)', () => {
  test.each<[string, AggregateLayout, boolean | undefined]>([
    ['{ u32 w[16]; }', struct(m('w', 'u32', { dims: [16] })), true],
    ['{ u8 a, b, c, d; } — one word, four members', struct(...['a', 'b', 'c', 'd'].map((n) => m(n, 'u8'))), true],
    ['{ u32 a, b; }', struct(m('a', 'u32'), m('b', 'u32')), true],
    ['{ u8 a[5]; } — one member, two words', struct(m('a', 'u8', { dims: [5] })), true],
    ['{ u32 x; }', struct(m('x', 'u32')), false],
    ['{ u32 w[1]; }', struct(m('w', 'u32', { dims: [1] })), false],
    ['{ u8 a; } — a word once rounded', struct(m('a', 'u8')), false],
    ['union { u32 a; u16 b; }', union(m('a', 'u32'), m('b', 'u16')), false],
    ['union { u32 w; u8 b[4]; } — an array member', union(m('w', 'u32'), m('b', 'u8', { dims: [4] })), true],
    [
      'union { struct { u8 a, b; } s; u32 w; } — a member that would be',
      union(m('s', struct(m('a', 'u8'), m('b', 'u8'))), m('w', 'u32')),
      true,
    ],
    ['{ u32 a : 8; u32 b : 8; }', struct(m('a', 'u32', { bits: 8 }), m('b', 'u32', { bits: 8 })), false],
    ['{ u32 a : 20; u32 b : 20; } — 40 bits', struct(m('a', 'u32', { bits: 20 }), m('b', 'u32', { bits: 20 })), true],
    ['{ float x; }', struct(m('x', 'float')), false],
    ['{ enum E k; }', struct(m('k', 'enum E')), false],
    // a zero-width bitfield moves what follows to a word, which this does not place
    [
      '{ u8 a : 2; u8 : 0; u8 b : 2; }',
      struct(m('a', 'u8', { bits: 2 }), m('', 'u8', { bits: 0 }), m('b', 'u8', { bits: 2 })),
      undefined,
    ],
    ['a struct whose members were not read', { kind: 'struct' }, undefined],
  ])('%s', (_label, layout, inMemory) => {
    expect(returnsInMemory(layout, ARMV4T_AGBCC)).toBe(inMemory);
  });

  test('sizes round every aggregate to a word, and align a long long to one', () => {
    // compiled: `sizeof(struct { u8 c; long long v; })` is 12 and a `long long` alone 8
    expect(aggregateSize(struct(m('c', 'u8'), m('v', 'long long')), ARMV4T_AGBCC)).toEqual({ size: 12, align: 4 });
    expect(aggregateSize(struct(m('a', 'u8')), ARMV4T_AGBCC)).toEqual({ size: 4, align: 4 });
    expect(aggregateSize(struct(m('w', 'u32', { dims: [16] })), ARMV4T_AGBCC)?.size).toBe(64);
  });

  // compiled: `sizeof` of each, and `(int)&((T *)0)->c` for the member past the bitfields
  test('bitfields pack at the next bit, straddling a byte or a word; floats and enums have a size', () => {
    const bf = (...widths: number[]) => widths.map((bits, i) => m(`b${i}`, 'u32', { bits }));
    expect(aggregateSize(struct(...bf(31, 31, 2)), ARMV4T_AGBCC)?.size).toBe(8);
    expect(aggregateSize(struct(...bf(20, 20, 20)), ARMV4T_AGBCC)?.size).toBe(8);
    expect(aggregateType('P', 'struct P', struct(...bf(20, 20), m('c', 'u8')), ARMV4T_AGBCC)).toEqual({
      ...T.struct('P', [{ off: 5, type: T.u(8), name: 'c' }], 8),
      declared: 'struct P',
    });
    expect(aggregateSize(struct(...bf(20, 20), m('c', 'u8')), ARMV4T_AGBCC)?.size).toBe(8);
    expect(aggregateSize(struct(m('a', 'u8'), m('b', 'u32', { bits: 30 })), ARMV4T_AGBCC)?.size).toBe(8);
    expect(aggregateSize(struct(m('a', 'u8'), m('b', 'u32', { bits: 4 })), ARMV4T_AGBCC)?.size).toBe(4);
    // `{u8 a; double d;}` is 12: a double aligns to a word here
    expect(aggregateSize(struct(m('a', 'u8'), m('d', 'double')), ARMV4T_AGBCC)).toEqual({ size: 12, align: 4 });
    expect(aggregateSize(struct(m('c', 'u8'), m('k', 'enum E')), ARMV4T_AGBCC)?.size).toBe(8);
  });
});

// compiled on mwcc_242_81, mwcc_233_163n and mwcc_247_107: `gT = mkT(i)` stores r3 (and r4) after
// the call up to 8 bytes, and hands `addi r3, …` over ahead of it past that
describe('mwcc (8 bytes or less in r3/r3:r4)', () => {
  test.each<[string, AggregateLayout, boolean | undefined]>([
    ['{ u8 a, b, c, d; }', struct(...['a', 'b', 'c', 'd'].map((n) => m(n, 'u8'))), false],
    ['{ u8 a[5]; } — 5 bytes, not rounded', struct(m('a', 'u8', { dims: [5] })), false],
    ['{ u32 a, b; }', struct(m('a', 'u32'), m('b', 'u32')), false],
    ['{ u8 a[9]; }', struct(m('a', 'u8', { dims: [9] })), true],
    ['{ u32 a, b, c; }', struct(m('a', 'u32'), m('b', 'u32'), m('c', 'u32')), true],
    ['union { u32 a; u16 b; }', union(m('a', 'u32'), m('b', 'u16')), false],
    ['a struct whose members were not read', { kind: 'struct' }, undefined],
  ])('%s', (_label, layout, inMemory) => {
    expect(returnsInMemory(layout, PPC_MWCC)).toBe(inMemory);
  });

  test('a struct of two floats is 8 bytes, and comes back in r3:r4', () => {
    expect(returnsInMemory(struct(m('x', 'float'), m('y', 'float')), PPC_MWCC)).toBe(false);
    expect(aggregateSize(struct(m('a', 'u8'), m('d', 'double')), PPC_MWCC)).toEqual({ size: 16, align: 8 });
  });

  // nothing here has measured how mwcc sizes an enum or places a bitfield
  test('an enum or a bitfield member leaves it unsized', () => {
    expect(returnsInMemory(struct(m('k', 'enum E')), PPC_MWCC)).toBeUndefined();
    expect(returnsInMemory(struct(m('a', 'u32', { bits: 8 })), PPC_MWCC)).toBeUndefined();
  });

  test('a long long aligns to 8', () => {
    // compiled: `struct { u8 a; long long d; }` puts `d` at 8 and sizes 16
    expect(aggregateSize(struct(m('a', 'u8'), m('d', 'long long')), PPC_MWCC)).toEqual({ size: 16, align: 8 });
  });
});

// compiled on ido7.1, gcc2.7.2kmc and gcc2.7.2: `T t = mkT(x);` hands `addiu a0,sp,N` over ahead of
// the `jal` for every one of these, a one-byte struct and a union included
describe('O32 (every aggregate through memory)', () => {
  test.each<[string, AggregateLayout]>([
    ['{ u8 c; }', struct(m('c', 'u8'))],
    ['{ u32 x; }', struct(m('x', 'u32'))],
    ['{ float f; }', struct(m('f', 'float'))],
    ['{ u32 a, b, c; }', struct(m('a', 'u32'), m('b', 'u32'), m('c', 'u32'))],
    ['union { u32 a; u16 b; }', union(m('a', 'u32'), m('b', 'u16'))],
    ['{ u32 a : 8; u32 b : 8; }', struct(m('a', 'u32', { bits: 8 }), m('b', 'u32', { bits: 8 }))],
    ['a struct whose members were not read', { kind: 'struct' }],
  ])('%s', (_label, layout) => {
    expect(returnsInMemory(layout, MIPS_IDO)).toBe(true);
    expect(returnsInMemory(layout, MIPS_GCC)).toBe(true);
  });

  test('a callee returning one is handed a hidden pointer', () => {
    const mkw = { params: ['s32'], returns: 'struct W1', returnLayout: struct(m('x', 'u32')) };
    for (const target of [MIPS_IDO, MIPS_GCC]) {
      expect(returnsWithoutHiddenPointer('mkw', { mkw }, target)).toBe(false);
    }
    // the same declaration comes back in r0 on agbcc
    expect(returnsWithoutHiddenPointer('mkw', { mkw }, ARMV4T_AGBCC)).toBe(true);
  });
});

test('a target that states no rule answers nothing', () => {
  const unstated = { ...PPC_MWCC, compilerBehaviors: { ...PPC_MWCC.compilerBehaviors, aggregateReturn: undefined } };
  expect(returnsInMemory(struct(m('w', 'u32', { dims: [16] })), unstated)).toBeUndefined();
});

// The IR struct a return temp is declared as: a field at its offset for each member the IR can type,
// and the headers' own spelling, which marks it theirs
test('a declared struct lays out as an IR struct, or not at all', () => {
  const s = struct(
    m('a', 'u8'),
    m('w', 's16', { dims: [2, 3] }),
    m('p', 'const u8 *'),
    m('o', 'struct Opaque *'),
    m('f', 'float'),
  );
  expect(aggregateType('S', 'S_t', s, ARMV4T_AGBCC)).toEqual({
    ...T.struct(
      'S',
      [
        { off: 0, type: T.u(8), name: 'a' },
        { off: 2, type: T.array(T.array(T.s(16), 3), 2), name: 'w' },
        { off: 16, type: T.ptr(T.u(8)), name: 'p' },
        { off: 20, type: T.ptr(T.void()), name: 'o' },
        { off: 24, type: T.f32(), name: 'f' },
      ],
      28,
    ),
    declared: 'S_t',
  });
  // a member the IR cannot type has no field; the struct is still the size its members give it
  expect(
    aggregateType('S', 'struct S', struct(m('in', struct(m('a', 'u8'))), m('c', 'char'), m('w', 'u32')), ARMV4T_AGBCC),
  ).toEqual({ ...T.struct('S', [{ off: 8, type: T.u(32), name: 'w' }], 12), declared: 'struct S' });
  for (const layout of [union(m('a', 'u32')), struct(m('a', 'u8', { bits: 0 })), { kind: 'struct' as const }]) {
    expect(aggregateType('S', 'struct S', layout, ARMV4T_AGBCC)).toBeUndefined();
  }
});

// `struct A { u16 a, b, c, d; s8 e, f; };` — ten bytes, a word-rounded twelve on agbcc
const PASSED_A = {
  kind: 'struct' as const,
  members: [
    ...['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u16' })),
    { name: 'e', type: 's8' },
    { name: 'f', type: 's8' },
  ],
};

describe('a struct passed by value in argument words', () => {
  test('takes its size in words, after the parameters before it', () => {
    const laid = byValueCallArgs({ params: ['s32', 'struct A'], byValueLayouts: { 1: PASSED_A } }, ARMV4T_AGBCC);
    expect(laid?.widths).toEqual([32, 32, 32, 32]);
    expect(laid?.byValue.map(({ param, word, words }) => ({ param, word, words }))).toEqual([
      { param: 1, word: 1, words: 3 },
    ]);
    expect(laid?.byValue[0].type).toMatchObject({ kind: 'struct', name: 'A', size: 12, declared: 'struct A' });
  });

  test('a typedef name it is listed under is its tag', () => {
    const laid = byValueCallArgs(
      { params: ['A_t'], byValueParams: [0], byValueLayouts: { 0: PASSED_A } },
      ARMV4T_AGBCC,
    );
    expect(laid?.byValue[0].type).toMatchObject({ name: 'A_t', declared: 'A_t' });
  });

  test('a target that passes one no other way, a union, or a struct it cannot size states nothing', () => {
    const p = { params: ['struct A'], byValueLayouts: { 0: PASSED_A } };
    expect(byValueCallArgs(p, PPC_MWCC)).toBeUndefined();
    expect(
      byValueCallArgs({ ...p, byValueLayouts: { 0: { ...PASSED_A, kind: 'union' as const } } }, ARMV4T_AGBCC),
    ).toBeUndefined();
    expect(byValueCallArgs({ ...p, byValueLayouts: { 0: { kind: 'struct' as const } } }, ARMV4T_AGBCC)).toBeUndefined();
    // …and a declaration with no struct passed by value is `declaredCallArgs`'s alone
    expect(byValueCallArgs({ params: ['s32'], byValueLayouts: {} }, ARMV4T_AGBCC)).toBeUndefined();
  });

  describe('on O32, which starts an 8-aligned aggregate at an even word', () => {
    const O32 = MIPS_GCC;
    const L = { kind: 'struct' as const, members: [{ name: 'v', type: 's64' }] };
    const Q = { kind: 'struct' as const, members: ['a', 'b'].map((name) => ({ name, type: 'u32' })) };

    test('a `long long` member aligns the struct to 8', () => {
      expect(aggregateSize(L, O32)).toEqual({ size: 8, align: 8 });
      const CL = { kind: 'struct' as const, members: [{ name: 'c', type: 'u8' }, ...L.members] };
      expect(aggregateSize(CL, O32)).toEqual({ size: 16, align: 8 });
    });

    test('at an even word it is placed where it starts', () => {
      expect(byValueCallArgs({ params: ['struct L'], byValueLayouts: { 0: L } }, O32)?.widths).toEqual([32, 32]);
      const two = byValueCallArgs({ params: ['s32', 's32', 'struct L'], byValueLayouts: { 2: L } }, O32);
      expect(two?.byValue.map(({ word, words }) => ({ word, words }))).toEqual([{ word: 2, words: 2 }]);
    });

    test('at an odd word it would skip one, and refuses', () => {
      const p = { params: ['s32', 'struct L'], byValueLayouts: { 1: L } };
      expect(byValueCallArgs(p, O32)).toBeUndefined();
      expect(byValueRefusal(p, O32)).toEqual({
        param: 1,
        refused: expect.stringMatching(/aligned to 8 and would start at an odd argument word/),
      });
      // a word-aligned struct at the same place is consecutive words, as agbcc places every one
      expect(byValueCallArgs({ params: ['s32', 'struct Q'], byValueLayouts: { 1: Q } }, O32)?.widths).toEqual([
        32, 32, 32,
      ]);
      expect(byValueCallArgs(p, ARMV4T_AGBCC)?.widths).toEqual([32, 32, 32]);
    });

    // one rule for every 8-aligned argument: the `long long` skips a1, so the struct after it
    // starts at a4's word, which is even (`wordsOf`)
    test('a struct after a `long long` counts the word the `long long` skipped', () => {
      const after = byValueCallArgs({ params: ['s32', 's64', 'struct L'], byValueLayouts: { 2: L } }, O32);
      expect(after?.widths).toEqual([32, 64, 32, 32]);
      expect(byValueRefusal({ params: ['s64', 's32', 'struct L'], byValueLayouts: { 2: L } }, O32)?.refused).toMatch(
        /would start at an odd argument word/,
      );
    });
  });

  test('says why it places none', () => {
    const p = { params: ['struct A'], byValueLayouts: { 0: PASSED_A } };
    expect(byValueRefusal(p, PPC_MWCC)?.refused).toMatch(/this target states no rule/);
    expect(byValueRefusal({ params: ['s32', 'struct A'] }, ARMV4T_AGBCC)).toEqual({
      param: 1,
      refused: expect.stringMatching(/does not lay it out/),
    });
    expect(
      byValueRefusal({ ...p, byValueLayouts: { 0: { ...PASSED_A, kind: 'union' as const } } }, ARMV4T_AGBCC)?.refused,
    ).toMatch(/is a union/);
    expect(
      byValueRefusal({ params: ['struct A', 'Opaque'], byValueLayouts: { 0: PASSED_A } }, ARMV4T_AGBCC)?.refused,
    ).toMatch(/its parameter 2 'Opaque' is not sized/);
    // …and none where it places them, or where no struct is passed by value
    expect(byValueRefusal(p, ARMV4T_AGBCC)).toBeUndefined();
    expect(byValueRefusal({ params: ['s32'] }, ARMV4T_AGBCC)).toBeUndefined();
  });

  test('the callee prints only where the lift passed the struct, and its `void` with it', () => {
    const p = { params: ['struct A'], byValueLayouts: { 0: PASSED_A }, returnsVoid: true };
    expect(spellableProto(p, ARMV4T_AGBCC)).toBeUndefined();
    expect(spellableProto(p, ARMV4T_AGBCC, undefined, new Set([0]))).toEqual({ params: ['struct A'], returns: 'void' });
    expect(spellableProto({ ...p, byValueLayouts: {} }, ARMV4T_AGBCC, undefined, new Set([0]))).toBeUndefined();
  });

  test("a context's struct definition is the layout", () => {
    const p = prototypesFromContext(
      'struct A { unsigned short a, b, c, d; signed char e, f; }; typedef struct A A_t; void take2(struct A a); void t(int x, A_t y);',
      'c',
    );
    expect(p.take2?.byValueLayouts?.[0]?.members?.map((m) => m.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(p.t?.byValueParams).toEqual([1]);
    expect(Object.keys(p.t?.byValueLayouts ?? {})).toEqual(['1']);
  });
});
