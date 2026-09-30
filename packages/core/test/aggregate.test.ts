// A declared struct or union on a target (src/aggregate.ts). Every row of the tables is a compiled
// fact: agbcc at the corpus flags, a caller `T t = mk(x);` reading the result — through memory when
// agbcc reserves a frame and hands `mov r0, sp` over, in r0 when it calls `bl mk` with no frame —
// and mwcc at the synthetic tier's.
import { describe, expect, test } from 'vitest';

import { aggregateSize, aggregateType, returnsInMemory } from '../src/aggregate';
import { T } from '../src/ir/types';
import type { AggregateLayout, AggregateMember } from '../src/proto';
import { ARMV4T_AGBCC, PPC_MWCC } from '../src/target';

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
    expect(aggregateType('P', 'struct P', struct(...bf(20, 20), m('c', 'u8')), ARMV4T_AGBCC)).toBeUndefined();
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

test('a target that states no rule answers nothing', () => {
  const unstated = { ...PPC_MWCC, compilerBehaviors: { ...PPC_MWCC.compilerBehaviors, aggregateReturn: undefined } };
  expect(returnsInMemory(struct(m('w', 'u32', { dims: [16] })), unstated)).toBeUndefined();
});

// The struct a local of the returned type is declared as: every member a field at its offset, and
// spelled as the headers spell it, which marks it theirs
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
  for (const layout of [
    union(m('a', 'u32')),
    struct(m('a', 'u32', { bits: 3 })),
    struct(m('in', struct(m('a', 'u8')))),
    struct(m('c', 'char')),
    { kind: 'struct' as const },
  ]) {
    expect(aggregateType('S', 'struct S', layout, ARMV4T_AGBCC)).toBeUndefined();
  }
});
