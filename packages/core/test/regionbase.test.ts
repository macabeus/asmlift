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
// declared at function top and only their ASSIGNMENTS are placed per region. This file cannot
// CHECK that (it is toolchain-free); packages/cli/test/matching/decl-scope-axis.test.ts compiles
// both spellings and compares the bytes, in BOTH directions — placement free, count not.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { without } from '../src/l3/gates';
import { REGIONBASE_GATES, REGION_RULES, SCOPEBASE_GATES, hoistScopedBases } from '../src/l3/scopebase';
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

  test('a base the function ALREADY homes is served anyway — `key-already-homed` is gone', () => {
    // The rule refused a key when a function-top statement already assigned that base to a local.
    // It was priced at ZERO on the row it was written against, and it MISSED the shape it names on
    // two counts at once: `homedBases` scanned top-level statements only, while `/defsite` sinks
    // the home into the arms; and it required a `cast` wrapper, while a base home reaches L3 as a
    // bare `v0 = 67109076` (the backend spells the cast from the local's declared type). The
    // branch's own published `synthetic:dmascope2` winner was the counterexample.
    //
    // Made to mean what it says — recursive, cast-optional — it costs that row 12 points
    // (diff:13 -> diff:25, back to the pre-lever winner). A rule measured at zero may not take
    // twelve, so it is deleted rather than repaired.
    const homed: SFn = {
      ...fn([
        { k: 'assign', name: 'q', value: { k: 'cast', to: T.ptr(T.u(16)), e: { k: 'addr', name: 'g' } } },
        { k: 'if', cond: { k: 'const', value: 1 }, then: [put(1), put(2)], else: [put(3), put(4)] },
      ]),
      locals: [{ name: 'q', type: T.ptr(T.u(16)) }],
    };
    const out = hoistScopedBases(homed, { regions: 'per-region' });
    const iff = out!.body[1] as Extract<Stmt, { k: 'if' }>;
    expect(hoists(iff.then)).toEqual(['p0']);
    expect(hoists(iff.else)).toEqual(['p1']);
    expect(REGIONBASE_GATES.map((g) => g.id)).not.toContain('key-already-homed');
  });
});

describe('the region RULE is a VALUE, not a string branched on in three places', () => {
  test('a rule carries its partition, its table, and the population its counting rules judge', () => {
    expect(REGION_RULES['per-region'].id).toBe('per-region');
    expect(REGION_RULES['per-region'].gates).toBe(REGIONBASE_GATES);
    expect(REGION_RULES.whole.gates).toBe(SCOPEBASE_GATES);
    // the POPULATION is the rule's answer, not a ternary at the call site: `'whole'` tallies the
    // KEY's uses (its cluster fallback serves a subset of them), `'per-region'` the region's own.
    const key = ['a', 'b', 'c'] as unknown as Parameters<(typeof REGION_RULES)['whole']['judged']>[1];
    const region = { scope: [], depth: 0, uses: ['a'] } as unknown as Parameters<
      (typeof REGION_RULES)['whole']['judged']
    >[0];
    expect(REGION_RULES.whole.judged(region, key)).toBe(key);
    expect(REGION_RULES['per-region'].judged(region, key)).toEqual(['a']);
  });

  test('the PER-REGION reading of a counting rule has its own id', () => {
    // `single-use` over the key and `single-use` over one region are two predicates. Sharing an id
    // makes `without(table, id)` two different ablations and a price table ambiguous about which
    // reading it priced.
    const ids = REGIONBASE_GATES.map((g) => g.id);
    expect(ids).toContain('region-single-use');
    expect(ids).toContain('region-repeated-const-offset');
    expect(ids).not.toContain('single-use');
    expect(ids).not.toContain('repeated-const-offset');
  });

  test('…and ablating it is an ablation of ONE predicate', () => {
    // the single-use tail below two arms: refused by the per-region reading, admitted without it
    const oneUse = fn([
      { k: 'if', cond: { k: 'const', value: 1 }, then: [put(1), put(2)], else: [put(3), put(4)] },
      put(5),
    ]);
    expect(hoists(hoistScopedBases(oneUse, { regions: 'per-region' })!.body)).toEqual([]);
    const ablated = hoistScopedBases(oneUse, {
      regions: 'per-region',
      gates: without(REGIONBASE_GATES, 'region-single-use'),
    });
    expect(hoists(ablated!.body)).toEqual(['p2']);
  });
});

describe('a rule the region rule makes VACUOUS is dropped, not left reading as safety', () => {
  // A use inside a loop NESTED BELOW the region is a shape `perRegions` cannot produce: a region's
  // depth is its uses' own `path.length`, so `u.loop.slice(depth)` is the empty slice for every use
  // it judges, and a use inside a nested loop is its OWN region at its own depth. Kept in the
  // table, `nested-loop-use` would read as one of four inherited rules that bind — and a reviewer
  // would reasonably believe it.
  const IN_A_NESTED_LOOP = fn([
    {
      k: 'if',
      cond: { k: 'const', value: 1 },
      then: [put(1), put(2), { k: 'while', cond: { k: 'const', value: 1 }, body: [put(7), put(8)] }],
      else: [],
    },
  ]);

  /** every `nestedLoop` the admission table is asked about, under one region rule */
  const nestedLoopFlags = (regions: 'whole' | 'per-region'): boolean[] => {
    const seen: boolean[] = [];
    const probe = {
      id: 'probe',
      why: 'records the ctx and admits — a census, not a rule',
      sound: false,
      rejects: (c: { nestedLoop: boolean }) => {
        seen.push(c.nestedLoop);
        return false;
      },
    };
    const table = regions === 'whole' ? SCOPEBASE_GATES : REGIONBASE_GATES;
    hoistScopedBases(IN_A_NESTED_LOOP, { regions, gates: [probe, ...table] });
    return seen;
  };

  test("`'whole'` really is asked the question — the fixture is not vacuous", () => {
    expect(nestedLoopFlags('whole').some(Boolean)).toBe(true);
  });

  test("…and under `'per-region'` the answer is always false, so the rule is not in the table", () => {
    const flags = nestedLoopFlags('per-region');
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.some(Boolean)).toBe(false);
    expect(REGIONBASE_GATES.map((g) => g.id)).not.toContain('nested-loop-use');
    expect(SCOPEBASE_GATES.map((g) => g.id)).toContain('nested-loop-use');
  });

  test('every counting rule is renamed for its per-region population — the whole id SET', () => {
    // A rule added to `COUNTING_RULES` reaches `REGIONBASE_GATES` renamed by construction. This
    // pins the other direction: a rule added anywhere else in `SCOPEBASE_GATES` would arrive
    // un-renamed, under an id already meaning a different population.
    expect(SCOPEBASE_GATES.map((g) => g.id)).toEqual([
      'single-use',
      'repeated-const-offset',
      'per-iteration-use',
      'nested-loop-use',
    ]);
    expect(REGIONBASE_GATES.map((g) => g.id)).toEqual([
      'region-single-use',
      'region-repeated-const-offset',
      'per-iteration-use',
      'regions-degenerate',
    ]);
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

  test('`/regionbase/volatile` is in the fan too — the device base keeps its qualifier', () => {
    // The lever's own shape is a DEVICE block (0x040000D4). Without this product every region
    // local it wins with is published UNqualified, and `compareScored`'s deviceVolatile tie-break
    // has no qualified twin to prefer — the qualifier would be given up by an absence in the fan
    // rather than by a measurement.
    const vol = cands.filter((c) => c.label.includes('/regionbase/volatile'));
    expect(vol.length).toBeGreaterThan(0);
    // the qualifier lands on the DECLARATION of the minted locals, not on the cast
    expect(vol.every((c) => /volatile s32 \* p0;/.test(c.source))).toBe(true);
  });

  test('…and the store the lever leaves INLINE keeps its qualifier too', () => {
    // The lever homes the regions that hold two or more direct uses and leaves every other
    // spelling of the same device address inline — here `((s32 *)67109076)[2] = v1;`, the write to
    // REG_DMA0CNT that starts the transfer. `/volatile` qualifies a pointer LOCAL and cannot reach
    // a store that stays inline; `/vol-store` is the pass that can, and until it was paired with
    // this lever the winning source dropped a device qualifier the un-hoisted spelling carries.
    const triple = cands.filter((c) => c.label.includes('/regionbase/volatile/vol-store'));
    expect(triple.length).toBeGreaterThan(0);
    expect(triple.every((c) => /volatile s32 \* p0;/.test(c.source))).toBe(true);
    expect(triple.every((c) => /\(\(volatile s32 \*\)67109076\)\[2\] =/.test(c.source))).toBe(true);
    // and no candidate loses one: the pair-less spelling is still in the fan
    expect(cands.some((c) => c.label.includes('/regionbase/volatile') && !c.label.includes('vol-store'))).toBe(true);
  });

  test('and it is the ONLY label that binds the base three times', () => {
    const three = cands.filter((c) => dmaLocals(c.source) >= 3);
    expect(three.length).toBeGreaterThan(0);
    expect(three.every((c) => c.label.includes('/regionbase'))).toBe(true);
  });
});
