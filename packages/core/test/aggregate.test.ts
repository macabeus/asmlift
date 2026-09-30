// A declared struct or union on a target (src/aggregate.ts). Every row of the tables is a compiled
// fact: agbcc at the corpus flags, a caller `T t = mk(x);` reading the result — through memory when
// agbcc reserves a frame and hands `mov r0, sp` over, in r0 when it calls `bl mk` with no frame.
import { describe, expect, test } from 'vitest';

import { aggregateSize, returnsInMemory } from '../src/aggregate';
import type { AggregateLayout, AggregateMember } from '../src/proto';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC } from '../src/target';

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
    // compiled into r0, and left open here: bitfield packing is not modelled
    ['{ u32 a : 8; u32 b : 8; }', struct(m('a', 'u32', { bits: 8 }), m('b', 'u32', { bits: 8 })), undefined],
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
});

test('IDO returns every aggregate through memory, a one-word one included', () => {
  expect(returnsInMemory(struct(m('x', 'u32')), MIPS_IDO)).toBe(true);
  expect(returnsInMemory({ kind: 'union' }, MIPS_IDO)).toBe(true);
});

test('a target that states no rule answers nothing', () => {
  expect(returnsInMemory(struct(m('w', 'u32', { dims: [16] })), PPC_MWCC)).toBeUndefined();
  expect(aggregateSize(struct(m('x', 'u32')), PPC_MWCC)).toBeUndefined();
});
