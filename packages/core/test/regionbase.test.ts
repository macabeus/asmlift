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
import {
  REGIONBASE_GATES,
  REGION_RULES,
  type RegionRule,
  SCOPEBASE_GATES,
  applyScopedBasePlan,
  assertPlanOwnership,
  hoistScopedBases,
  planScopedBases,
} from '../src/l3/scopebase';
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

  test('regions-degenerate: a single region is left to the function-top hoist', () => {
    const one = fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [put(1), put(2)], else: [] }]);
    expect(hoists(arms(hoistScopedBases(one)).then)).toEqual(['p0']); // 'whole' still names it
    expect(hoistScopedBases(one, { regions: 'per-region' })).toBeNull();
  });

  test('a base the function ALREADY homes is served anyway', () => {
    // No rule refuses a key because some statement already assigned that base to a local, and the
    // absence is deliberate. Such a rule has to be RECURSIVE (`/defsite` sinks the home into the
    // arms) and CAST-OPTIONAL (a base home reaches L3 as a bare `v0 = 67109076`; the backend
    // spells the cast from the local's declared type) to mean what it says — and stated that way
    // it costs `synthetic:dmascope2` twelve points, diff:13 to diff:25.
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

  test('`regions-degenerate` refuses a spelling no other reading of this pass offers', () => {
    // One arm with THREE direct uses plus a nested loop holding one more. `'whole'` refuses the
    // key on `nested-loop-use`; `'per-region'` makes the arm a region with two-or-more uses whose
    // only sibling has one, so `regions-degenerate` refuses it as degenerate. Ablate that rule
    // alone and the hoist appears. The rule is an honest fan saving — but its saving is not always
    // a duplicate.
    const F = fn([
      {
        k: 'if',
        cond: { k: 'const', value: 1 },
        then: [put(1), put(2), put(3), { k: 'while', cond: { k: 'const', value: 9 }, body: [put(4)] }],
        else: [],
      },
    ]);
    expect(hoistScopedBases(F)).toBeNull();
    expect(hoistScopedBases(F, { regions: 'per-region' })).toBeNull();
    const ablated = hoistScopedBases(F, {
      regions: 'per-region',
      gates: without(REGIONBASE_GATES, 'regions-degenerate'),
    });
    expect(ablated?.locals.map((l) => l.name)).toEqual(['p0']);
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

  test('and every label that binds the base three times is this pass, or a pipe THROUGH it', () => {
    // `/livebase-block/homesplit` (l3/homesplit.ts) pipes a head hoist into this pass with one key
    // withheld, so the region reading it applies is this one — which is why the claim is about the
    // PASS and not about a label. `dmascope` stopped being a lever-clean control for `/regionbase`
    // the moment that pairing existed; the dataset block comment predicted exactly this.
    const three = cands.filter((c) => dmaLocals(c.source) >= 3);
    expect(three.length).toBeGreaterThan(0);
    expect(three.every((c) => /\/regionbase|\/homesplit/.test(c.label))).toBe(true);
  });
});

describe('the PLAN is a value, and its OWNERSHIP is a contract', () => {
  // `planScopedBases` is the census half of this pass — which keys it found, which regions it
  // admitted, and for a key it serves nowhere the id of the rule that refused it first;
  // `hoistScopedBases` is the applier. The split is what lets a caller ask whether one particular
  // key would be split without applying anything, which is what `rank.ts` gates the
  // `/livebase-block/homesplit` pairing on.
  test('the plan names every key and every entry', () => {
    const plan = planScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' });
    expect(plan.keys).toEqual(['n:g 2 false']);
    expect(plan.entries.map((e) => e.name)).toEqual(['p0', 'p1', 'p2']);
    expect(plan.entries.every((e) => e.key === 'n:g 2 false')).toBe(true);
    expect([...plan.refusals]).toEqual([]);
  });

  test('…and a key it serves nowhere names the DECIDING rule rather than vanishing', () => {
    const one = fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [put(1), put(2)], else: [] }]);
    const plan = planScopedBases(one, { regions: 'per-region' });
    expect(plan.entries).toEqual([]);
    expect(plan.refusals.get('n:g 2 false')).toBe('regions-degenerate');
  });

  test('the applier mints exactly the plan’s locals, in the plan’s order', () => {
    const plan = planScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' });
    const out = hoistScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' });
    expect(out!.locals.map((l) => l.name)).toEqual(plan.entries.map((e) => e.name));
  });

  test('the plan is DETERMINISTIC — two runs over one tree name the same entries', () => {
    const shape = (p: ReturnType<typeof planScopedBases>): string[] =>
      p.entries.map((e) => `${e.key} ${e.name} ${e.before}`);
    expect(shape(planScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' }))).toEqual(
      shape(planScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' })),
    );
  });

  // `repoint.set(node, name)` is LAST-WRITE-WINS. It fires zero times under either shipped region
  // rule — both partitions are node-disjoint by construction — so the only way to show the check
  // load-bearing is to hand the pass a rule that violates the property. Without it an overlapping
  // partition repoints an access at whichever entry ran last, whose assignment need not dominate
  // it: the silent-wrong-variable failure this file's header names, not a compile error.
  const OVERLAPPING: RegionRule = {
    ...REGION_RULES['per-region'],
    partition: (all, body) => {
      const [one] = REGION_RULES['per-region'].partition(all, body);
      return [one, { ...one, uses: [...one.uses] }];
    },
  };

  test('two plan entries claiming ONE access node throw', () => {
    expect(() => planScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region', rule: OVERLAPPING })).toThrow(
      /claimed by two plan entries/,
    );
  });

  test('…and the applier throws through the same contract rather than emitting the tree', () => {
    expect(() => hoistScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region', rule: OVERLAPPING })).toThrow(
      /claimed by two plan entries/,
    );
  });

  test('a plan whose entries share a NAME, or shadow a declared local, throws', () => {
    // The applier appends `plan`'s names to `sfn.locals` wholesale, so either shape emits a
    // duplicate C declaration. `nameAllocator` is what keeps both unreachable today — including
    // across the rank.ts PIPE, where the second pass re-derives its taken names from the tree the
    // first produced; the contract is what keeps that a checked property rather than an argument.
    const entry = { name: 'p0', key: 'n:g 2 false' };
    expect(() => assertPlanOwnership(TWO_ARMS_AND_A_TAIL, [entry, { ...entry }])).toThrow(/mints `p0`/);
    const shadow: SFn = { ...TWO_ARMS_AND_A_TAIL, locals: [{ name: 'p0', type: T.ptr(T.u(16)) }] };
    expect(() => assertPlanOwnership(shadow, [entry])).toThrow(/mints `p0`/);
  });

  test('…and freshness is `takenNames`, not the declared locals — a param or a body name counts', () => {
    // `nameAllocator` mints against `takenNames`: params, locals, every `var`/`addr`/`call` name,
    // every assignment target. A plan entry that only shadows one of those is not a duplicate
    // declaration — it is a DIFFERENT VARIABLE, which is the failure class this contract is for,
    // so the check has to read the same set the allocator does.
    const entry = { name: 'p0', key: 'n:g 2 false' };
    const param: SFn = { ...TWO_ARMS_AND_A_TAIL, params: [{ name: 'p0', type: T.s(32) }] };
    expect(() => assertPlanOwnership(param, [entry])).toThrow(/mints `p0`/);
    const assigned: SFn = {
      ...TWO_ARMS_AND_A_TAIL,
      body: [{ k: 'assign', name: 'p0', value: { k: 'const', value: 0 } }, ...TWO_ARMS_AND_A_TAIL.body],
    };
    expect(() => assertPlanOwnership(assigned, [entry])).toThrow(/mints `p0`/);
  });

  test('the applier applies the plan it is HANDED, so a caller can count and rewrite one decision', () => {
    // l3/homesplit.ts has to know how many locals the withheld key got AND emit the tree. Two runs
    // of the planner is a second predicate that could disagree with the first; this is the seam
    // that makes it one.
    const plan = planScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' });
    expect(applyScopedBasePlan(TWO_ARMS_AND_A_TAIL, plan)).toEqual(
      hoistScopedBases(TWO_ARMS_AND_A_TAIL, { regions: 'per-region' }),
    );
    expect(applyScopedBasePlan(TWO_ARMS_AND_A_TAIL, { ...plan, entries: [] })).toBeNull();
  });

  test('…and the pipe rank.ts uses really does re-derive its taken names', () => {
    // hoistScopedBases over a tree that already declares `p0` must not mint a second `p0`.
    const already: SFn = { ...TWO_ARMS_AND_A_TAIL, locals: [{ name: 'p0', type: T.ptr(T.u(16)) }] };
    const out = hoistScopedBases(already, { regions: 'per-region' });
    expect(out!.locals.map((l) => l.name)).toEqual(['p0', 'p1', 'p2', 'p3']);
  });
});
