// The `/regionbase` selector (l3/scopebase.ts): a base address the source spells N times inside N
// disjoint regions is N LOCALS, one per region — not one local at function scope and not none.
//
// It is the same pass under a second region rule, not a second pass: `'whole'` picks ONE scope for
// a key (the innermost list holding every use, else the deepest cluster of two), `'per-region'`
// partitions the key's uses by their INNERMOST ENCLOSING LIST and serves each surviving partition.
//
// WHY THE COUNT AND NOT THE SCOPE. agbcc discriminates on how many distinct locals with disjoint
// live ranges exist, not on where they are declared: the three-locals-at-function-top spelling and
// the three-block-scoped-declarations spelling assemble to byte-identical code on the row this was
// built for. So there is no nested declaration block here and none is needed — the locals are
// declared at function top and only their ASSIGNMENTS are placed per region.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { hoistScopedBases } from '../src/l3/scopebase';

const G = [{ name: 'g', type: T.ptr(T.u(16)) }];

const ix = (idx: number, extra: Partial<Extract<Expr, { k: 'index' }>> = {}): Expr => ({
  k: 'index',
  base: { k: 'var', name: 'g' },
  idx: { k: 'const', value: idx },
  width: 2,
  signed: false,
  ...extra,
});

const put = (idx: number): Stmt => ({ k: 'store', lval: ix(idx), value: { k: 'const', value: 0 } });

const fn = (body: Stmt[]): SFn => ({ name: 'f', params: [], locals: [], globals: G, retType: T.void(), body });

/** The hoist assignments introduced into a statement list, in order. */
const hoists = (list: Stmt[]): string[] =>
  list
    .filter((s): s is Extract<Stmt, { k: 'assign' }> => s.k === 'assign' && s.name.startsWith('p'))
    .map((s) => s.name);

const arms = (out: SFn | null): { then: Stmt[]; else: Stmt[] } => {
  const s = out!.body[0] as Extract<Stmt, { k: 'if' }>;
  return { then: s.then, else: s.else };
};

/** Two arms and a tail, six distinct offsets — so no rule but the region rule can decide. */
const TWO_ARMS_AND_A_TAIL = fn([
  { k: 'if', cond: { k: 'const', value: 1 }, then: [put(1), put(2)], else: [put(3), put(4)] },
  put(5),
  put(6),
]);

describe('the region rule is a SELECTOR over one collected index', () => {
  test("'whole' is unchanged — one cluster, the first-appearing of the two arms", () => {
    const out = hoistScopedBases(TWO_ARMS_AND_A_TAIL);
    expect(out).not.toBeNull();
    expect(hoists(out!.body)).toEqual([]);
    expect(hoists(arms(out).then)).toEqual(['p0']);
    expect(hoists(arms(out).else)).toEqual([]);
  });

  test("'per-region' serves EVERY partition — one local per arm, plus the function-body tail", () => {
    const out = hoistScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' });
    expect(out).not.toBeNull();
    expect(hoists(arms(out).then)).toEqual(['p0']);
    expect(hoists(arms(out).else)).toEqual(['p1']);
    expect(hoists(out!.body)).toEqual(['p2']);
    expect(out!.locals.map((l) => l.name)).toEqual(['p0', 'p1', 'p2']);
  });

  test('the FUNCTION BODY is a region like any other, and its assignment sits before its first use', () => {
    // Not an antichain of scope-disjoint regions: the body list ENCLOSES both arms and is served
    // anyway. What separates it from the arms is only which uses are DIRECT.
    const out = hoistScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' });
    expect(out!.body.map((s) => s.k)).toEqual(['if', 'assign', 'store', 'store']);
  });

  test('each region names only its OWN uses — nothing crosses a region boundary', () => {
    const out = hoistScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' });
    const baseOf = (s: Stmt): unknown => (s as Extract<Stmt, { k: 'store' }>).lval;
    expect(baseOf(arms(out).then[1])).toMatchObject({ base: { k: 'var', name: 'p0' } });
    expect(baseOf(arms(out).then[2])).toMatchObject({ base: { k: 'var', name: 'p0' } });
    expect(baseOf(arms(out).else[1])).toMatchObject({ base: { k: 'var', name: 'p1' } });
    expect(baseOf(out!.body[2])).toMatchObject({ base: { k: 'var', name: 'p2' } });
  });
});
