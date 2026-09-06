// A `for`'s INIT is a DEF, and the dominance walk has to read it as one.
//
// `assertHoistsDominate` judged a `for` as one flat list of head expressions — init, cond, inc —
// and then looked for a defining assignment only at `st.k === 'assign'`, which a `for` node is
// not. So a local whose only def is the loop's init and whose uses are its cond, its inc and its
// body reads as undominated. That is exactly what `l3/reindex.ts` mints: an induction variable
// declared by `declareIv` and assigned nowhere but the `for` it builds.
//
// It matters because `assertPlacementSurvives` is a DIFFERENTIAL that early-returns when the
// BEFORE tree fails: a false rejection there does not refuse a candidate, it silently switches the
// check off for every composition built on a re-indexed tree.
import { describe, expect, test } from 'vitest';

import { assertHoistsDominate, assertPlacementSurvives } from '../src/contracts';
import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';

const counted = (body: Stmt[]): Stmt => ({
  k: 'for',
  init: { k: 'assign', name: 'i0', value: { k: 'const', value: 0 } },
  cond: { k: 'bin', op: '<', l: { k: 'var', name: 'i0' }, r: { k: 'const', value: 4 } },
  inc: {
    k: 'assign',
    name: 'i0',
    value: { k: 'bin', op: '+', l: { k: 'var', name: 'i0' }, r: { k: 'const', value: 1 } },
  },
  body,
});

const fn = (body: Stmt[]): SFn => ({
  name: 'probe',
  params: [],
  locals: [{ name: 'i0', type: T.s(32) }],
  retType: T.void(),
  body,
});

describe('the dominance walk reads a loop as a loop', () => {
  const iv = new Set(['i0']);

  test('an induction variable defined in the `for` init dominates cond, inc and body', () => {
    expect(() =>
      assertHoistsDominate(fn([counted([{ k: 'exprstmt', value: { k: 'var', name: 'i0' } }])]), iv),
    ).not.toThrow();
  });

  test('…and after the loop too — the init runs unconditionally', () => {
    const body = [counted([]), { k: 'exprstmt', value: { k: 'var', name: 'i0' } } as Stmt];
    expect(() => assertHoistsDominate(fn(body), iv)).not.toThrow();
  });

  test('a read the init does NOT reach still throws', () => {
    const body = [{ k: 'exprstmt', value: { k: 'var', name: 'i0' } } as Stmt, counted([])];
    expect(() => assertHoistsDominate(fn(body), iv)).toThrow(/assignment does not reach/);
  });

  test('a def inside the BODY does not reach the condition above it', () => {
    const loop: Stmt = {
      k: 'while',
      cond: { k: 'var', name: 'p0' },
      body: [{ k: 'assign', name: 'p0', value: { k: 'const', value: 1 } }],
    };
    const s: SFn = { ...fn([loop]), locals: [{ name: 'p0', type: T.s(32) }] };
    expect(() => assertHoistsDominate(s, new Set(['p0']))).toThrow(/assignment does not reach/);
  });

  test('the DIFFERENTIAL over a re-indexed tree is live, not vacuously satisfied', () => {
    // before: the counted loop, legal. after: the same tree with the init moved below the loop —
    // the stranding a def-moving pass composed onto `reindexWalks` would produce. The check may
    // only pass this if it never judged `before` at all.
    const before = fn([counted([{ k: 'exprstmt', value: { k: 'var', name: 'i0' } }])]);
    const stranded = counted([{ k: 'exprstmt', value: { k: 'var', name: 'i0' } }]) as Stmt & { k: 'for' };
    const after = fn([
      { ...stranded, init: { k: 'exprstmt', value: { k: 'const', value: 0 } } },
      { k: 'assign', name: 'i0', value: { k: 'const', value: 0 } },
    ]);
    expect(() => assertPlacementSurvives(before, after, iv)).toThrow(/assignment does not reach/);
  });
});

describe('an ADDRESS taken of a hoisted local is a use the walk must see', () => {
  // The placing passes count `&p` as a mention (l3/hoist.ts) — an init has to precede the address
  // being taken as surely as it must precede a read, because the address is what a callee reads
  // through. A walk that counted only `var` would be weaker than the descent it guards, in exactly
  // the position that descent refuses to cross.
  const held = (body: Stmt[]): SFn => ({ ...fn(body), locals: [{ name: 'p0', type: T.ptr(T.u(8)) }] });
  const takeAddr: Stmt = { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'p0' }] } };
  const def: Stmt = { k: 'assign', name: 'p0', value: { k: 'const', value: 0x3001100 } };

  test('an address taken where the assignment does not reach throws', () => {
    expect(() => assertHoistsDominate(held([takeAddr, def]), new Set(['p0']))).toThrow(/assignment does not reach/);
  });

  test('…and the same address below the assignment does not', () => {
    expect(() => assertHoistsDominate(held([def, takeAddr]), new Set(['p0']))).not.toThrow();
  });

  test('an address taken in an arm the assignment does not reach throws', () => {
    const body: Stmt[] = [{ k: 'if', cond: { k: 'const', value: 1 }, then: [def], else: [] }, takeAddr];
    expect(() => assertHoistsDominate(held(body), new Set(['p0']))).toThrow(/assignment does not reach/);
  });
});
