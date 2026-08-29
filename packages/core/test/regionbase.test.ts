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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { hoistScopedBases } from '../src/l3/scopebase';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

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

describe('the admission rules are judged over the REGION, and it is a refinement', () => {
  test('a region reached ONCE is left inline — the local would not pay for itself', () => {
    // The 21-point rule on the row this was built for: the single merged store below two arms keeps
    // its inline cast rather than earning a fourth local.
    const out = hoistScopedBases(
      fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [put(1), put(2)], else: [put(3), put(4)] }, put(5)]),
      { regions: 'per-region' },
    );
    expect(hoists(out!.body)).toEqual([]);
    expect((out!.body[1] as Extract<Stmt, { k: 'store' }>).lval).toMatchObject({ base: { k: 'var', name: 'g' } });
  });

  test('an offset repeated ACROSS regions but once WITHIN each is admitted', () => {
    // The whole-function tally is what refuses the DMA shape: offsets 0/1/2 are each touched once
    // per region and three times per function. Per region the rule is unchanged in meaning.
    const twice = fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [put(0), put(1)], else: [put(0), put(1)] }]);
    expect(hoistScopedBases(twice)).toBeNull();
    const out = hoistScopedBases(twice, { regions: 'per-region' });
    expect(hoists(arms(out).then)).toEqual(['p0']);
    expect(hoists(arms(out).else)).toEqual(['p1']);
  });

  test('and it is a REFINEMENT, not a relaxation — a poll repeating an offset IN one region is still refused', () => {
    // `p[2] = go; while (p[2] & BUSY) {}` is the shape basecse lost ProcessHBlankWait to. Inside
    // one region the tally still sees the repeat.
    const poll = fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [put(2), put(2)], else: [put(3), put(4)] }]);
    const out = hoistScopedBases(poll, { regions: 'per-region' });
    expect(hoists(arms(out).then)).toEqual([]); // the repeat is INSIDE this region
    expect(hoists(arms(out).else)).toEqual(['p0']); // ...and its sibling is judged on its own uses
  });

  test('regions-degenerate: a single region is basecse`s own question, and is left to it', () => {
    const one = fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [put(1), put(2)], else: [] }]);
    expect(hoists(arms(hoistScopedBases(one)).then)).toEqual(['p0']); // 'whole' still names it
    expect(hoistScopedBases(one, { regions: 'per-region' })).toBeNull();
  });

  test('key-already-homed: a function-top local already holding the base pays for nothing', () => {
    const homed: SFn = {
      ...fn([
        { k: 'assign', name: 'q', value: { k: 'cast', to: T.ptr(T.u(16)), e: { k: 'addr', name: 'g' } } },
        { k: 'if', cond: { k: 'const', value: 1 }, then: [put(1), put(2)], else: [put(3), put(4)] },
      ]),
      locals: [{ name: 'q', type: T.ptr(T.u(16)) }],
    };
    expect(hoistScopedBases(homed, { regions: 'per-region' })).toBeNull();
    // ...and it is the HOME that decided, not the shape
    const unhomed: SFn = { ...homed, body: homed.body.slice(1) };
    expect(hoists(arms(hoistScopedBases(unhomed, { regions: 'per-region' })).then)).toEqual(['p0']);
  });
});

describe('the lever is OFFERED, and it reaches the shape the row needs', () => {
  // The real `synthetic:dmascope` disassembly. Its DMA base 0x040000D4 is spelled in three disjoint
  // regions — each `if` arm of a loop body, and the post-loop tail — and no lever asmlift ships
  // binds it to more than ONE local: `basecse`/`/livebase`/`/scopebase` all place at most one.
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-dmascope.s'), 'utf8');
  const cands = enumerateCandidates('dmascope', asm, ARMV4T_AGBCC, {
    prototypes: { dmascope: { params: ['s32'], returnsVoid: true } },
  });

  /** distinct locals a candidate binds to the DMA register block */
  const dmaLocals = (src: string): number =>
    new Set(
      [...src.matchAll(/(\w+) = \(volatile s32 \*\)67109076;|(\w+) = \(s32 \*\)67109076;/g)].map((m) => m[1] ?? m[2]),
    ).size;

  test('`/regionbase` is in the fan', () => {
    expect(cands.filter((c) => c.label.includes('/regionbase')).length).toBeGreaterThan(0);
  });

  test('and it is the ONLY label that binds the base three times', () => {
    const three = cands.filter((c) => dmaLocals(c.source) >= 3);
    expect(three.length).toBeGreaterThan(0);
    expect(three.every((c) => c.label.includes('/regionbase'))).toBe(true);
  });
});
