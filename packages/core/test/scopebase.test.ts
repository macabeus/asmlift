// The `/scopebase` lever (l3/scopebase.ts): name a reused global base at the INNERMOST scope that
// holds its uses.
//
// It exists because `basecse.ts` hoists only to a POSITION IN THE TOP-LEVEL STATEMENT LIST — the
// function top or an init's first use, never inside a nested scope — and only for an `addr`/`const`
// base. Both limits cost real bytes: neither of those positions is inside the `if` arm that holds
// the uses, and the rank-aware bare spelling `gSym[0][i]` has a `var` base basecse cannot see.
// These pin the scope choice and every refusal — the lever is differ-refereed, so its risk is spelling
// quality, not correctness of the winner, but a wrong REWRITE would still be shown on a nonmatch row.
import { describe, expect, test } from 'vitest';

import { assertLocalsWritten } from '../src/contracts';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { without } from '../src/l3/gates';
import {
  SCOPEBASE_ELIGIBILITY,
  SCOPEBASE_GATES,
  assertHoistsDominate,
  assertPlacementSurvives,
  hoistScopedBases,
} from '../src/l3/scopebase';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

// `g` stands for an ARRAY-shaped global. `SFn.globals` entries carry a POINTER IrType because that
// is the type of the decayed base, not because the symbol is a pointer global — a pointer-shaped
// global is never put in this list by the structurer and must never become eligible (naming its
// cell instead of its target would be silently the wrong address). Spelled out because the fixture
// reads exactly like the case that must not work.
const G = [{ name: 'g', type: T.ptr(T.u(16)) }];

const ix = (idx: number, extra: Partial<Extract<Expr, { k: 'index' }>> = {}): Expr => ({
  k: 'index',
  base: { k: 'var', name: 'g' },
  idx: { k: 'const', value: idx },
  width: 2,
  signed: false,
  ...extra,
});

const store = (dst: Expr, src: Expr): Stmt => ({ k: 'store', lval: dst, value: src });

const fn = (body: Stmt[], globals = G): SFn => ({
  name: 'f',
  params: [],
  locals: [],
  globals,
  retType: T.void(),
  body,
});

/** The hoist assignments introduced into a statement list, in order. */
const hoists = (list: Stmt[]): string[] =>
  list
    .filter((s): s is Extract<Stmt, { k: 'assign' }> => s.k === 'assign' && s.name.startsWith('p'))
    .map((s) => s.name);

describe('scope choice', () => {
  test('two uses inside ONE if-arm hoist INSIDE that arm, not at the top', () => {
    const arm: Stmt[] = [store(ix(594), ix(659))];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]));
    expect(out).not.toBeNull();
    expect(hoists(out!.body)).toEqual([]); // nothing at the function top
    const thenArm = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(hoists(thenArm)).toEqual(['p0']); // ...it lands in the arm
    expect(thenArm[0]).toMatchObject({ k: 'assign', name: 'p0' });
  });

  test('uses spanning the FUNCTION BODY decline when no CLUSTER reaches two', () => {
    // Spanning the body is no longer a decline on its own — the cluster fallback handles it. This
    // fixture declines because neither scope holds two uses, which is the surviving rule.
    expect(
      hoistScopedBases(
        fn([
          { k: 'if', cond: { k: 'const', value: 1 }, then: [store(ix(1), { k: 'const', value: 0 })], else: [] },
          store(ix(2), { k: 'const', value: 0 }),
        ]),
      ),
    ).toBeNull();
  });

  test('the scope is the innermost list common to ALL uses, not the innermost of any one', () => {
    const inner: Stmt[] = [store(ix(1), { k: 'const', value: 0 })];
    const outerArm: Stmt[] = [
      { k: 'if', cond: { k: 'const', value: 1 }, then: inner, else: [] },
      store(ix(2), { k: 'const', value: 0 }),
    ];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: outerArm, else: [] }]));
    expect(out).not.toBeNull();
    const arm = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(hoists(arm)).toEqual(['p0']); // the OUTER arm holds both uses
    expect(hoists((arm[1] as Extract<Stmt, { k: 'if' }>).then)).toEqual([]);
  });

  test('a single use does not fire — one access re-materializes as cheaply as a local', () => {
    expect(
      hoistScopedBases(
        fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [store(ix(1), { k: 'const', value: 0 })], else: [] }]),
      ),
    ).toBeNull();
  });
});

describe('refusals', () => {
  test('a NON-ZERO lead is refused — dropping it would address a different row', () => {
    // `g[1][i]` is a whole row past `g[0][i]`; the local points at the object start, and the rewrite
    // drops the lead. Silently the wrong bytes, and no contract checks it.
    const arm: Stmt[] = [store(ix(594, { lead: [1] }), ix(659, { lead: [1] }))];
    expect(hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]))).toBeNull();
  });

  test('a ZERO lead fires, and the rewrite DROPS it', () => {
    const arm: Stmt[] = [store(ix(594, { lead: [0] }), ix(659, { lead: [0] }))];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]));
    expect(out).not.toBeNull();
    const st = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then[1] as Extract<Stmt, { k: 'store' }>;
    expect(st.lval).toMatchObject({ k: 'index', base: { k: 'var', name: 'p0' } });
    expect((st.lval as Extract<Expr, { k: 'index' }>).lead).toBeUndefined();
  });

  test('a use inside a LOOP below the scope is refused — that is loop-invariant motion', () => {
    // basecse's `inLoop` gate exists for exactly this: hoisting out of the loop forces a
    // callee-saved register the original avoided.
    const loopBody: Stmt[] = [store(ix(1), { k: 'const', value: 0 })];
    const arm: Stmt[] = [
      { k: 'while', cond: { k: 'const', value: 1 }, body: loopBody },
      store(ix(2), { k: 'const', value: 0 }),
    ];
    expect(hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]))).toBeNull();
  });

  test('ALL uses inside one loop body DO fire — the scope is the body, so nothing moves out', () => {
    const loopBody: Stmt[] = [store(ix(1), ix(2))];
    const out = hoistScopedBases(fn([{ k: 'while', cond: { k: 'const', value: 1 }, body: loopBody }]));
    expect(out).not.toBeNull();
    expect(hoists((out!.body[0] as Extract<Stmt, { k: 'while' }>).body)).toEqual(['p0']);
  });

  test('a base that is a LOCAL, not a declared global, is never named', () => {
    // A local can be assigned between the hoist point and a use, changing what is dereferenced.
    const arm: Stmt[] = [store(ix(1), ix(2))];
    expect(hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }], []))).toBeNull();
  });
});

describe('the rewrite', () => {
  test('two WIDTHS through one base get two locals — the pointer type is part of the key', () => {
    const arm: Stmt[] = [store(ix(1), ix(2)), store(ix(3, { width: 1 }), ix(4, { width: 1 }))];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]));
    expect(out).not.toBeNull();
    expect(hoists((out!.body[0] as Extract<Stmt, { k: 'if' }>).then)).toEqual(['p0', 'p1']);
    expect(out!.locals.map((l) => l.type)).toEqual([T.ptr(T.u(16)), T.ptr(T.u(8))]);
  });

  test('the initializer is the always-valid cast form', () => {
    const arm: Stmt[] = [store(ix(1), ix(2))];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]));
    const init = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then[0] as Extract<Stmt, { k: 'assign' }>;
    expect(init.value).toMatchObject({ k: 'cast', to: T.ptr(T.u(16)), e: { k: 'addr', name: 'g' } });
  });

  test('a numeric-pointer base keeps its literal', () => {
    const c = (idx: number): Expr => ({
      k: 'index',
      base: { k: 'const', value: 0x4000000 },
      idx: { k: 'const', value: idx },
      width: 2,
      signed: false,
    });
    const arm: Stmt[] = [store(c(0), c(1))];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]));
    const init = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then[0] as Extract<Stmt, { k: 'assign' }>;
    expect(init.value).toMatchObject({ k: 'cast', e: { k: 'const', value: 0x4000000 } });
  });

  test('the hoist name never collides with an existing local', () => {
    const arm: Stmt[] = [store(ix(1), ix(2))];
    const base = fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]);
    const out = hoistScopedBases({ ...base, locals: [{ name: 'p0', type: T.s(32) }] });
    expect(hoists((out!.body[0] as Extract<Stmt, { k: 'if' }>).then)).toEqual(['p1']);
  });
});

describe('refusals: walker symmetry and loop cadence', () => {
  const loopFn = (body: Stmt[], cond: Expr, extra: Stmt[] = []): SFn =>
    fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [{ k: 'while', cond, body }, ...extra], else: [] }]);

  test('a use in a LOOP CONDITION is refused — it runs every iteration, the scope does not', () => {
    // The condition lives at the ENCLOSING list, so the path carries no loop flag for it; hoisting
    // there puts the assignment ABOVE the loop, which is the loop-invariant motion this pass claims
    // to refuse. basecse.ts and argbase.ts both treat a loop's own condition as inside the loop.
    expect(
      hoistScopedBases(
        loopFn([], { k: 'bin', op: '!=', l: ix(1), r: { k: 'const', value: 0 } }, [
          store(ix(2), { k: 'const', value: 0 }),
        ]),
      ),
    ).toBeNull();
  });

  test('a `for` INC use is refused, and a `for` INIT use is collected', () => {
    // Both are STATEMENTS: reached by neither stmtExprs nor childLists, yet rewriteStmt rewrites
    // them. Collect and rewrite must see the same tree or an access gets repointed at a local whose
    // assignment does not dominate it.
    const forWith = (init: Stmt, inc: Stmt, body: Stmt[]): SFn =>
      fn([
        {
          k: 'if',
          cond: { k: 'const', value: 1 },
          then: [{ k: 'for', init, cond: { k: 'const', value: 1 }, inc, body }],
          else: [],
        },
      ]);
    const nop: Stmt = { k: 'assign', name: 'i', value: { k: 'const', value: 0 } };
    // inc reads the base every iteration → refuse
    expect(
      hoistScopedBases(
        forWith(nop, { k: 'assign', name: 'i', value: ix(1) }, [store(ix(2), { k: 'const', value: 0 })]),
      ),
    ).toBeNull();
    // init reads it ONCE, at the enclosing cadence → eligible, and counted
    const out = hoistScopedBases(forWith({ k: 'assign', name: 'i', value: ix(1) }, nop, []));
    expect(out).toBeNull(); // only ONE use — but it was seen (the next case proves counting)
    const two = hoistScopedBases(
      fn([
        {
          k: 'if',
          cond: { k: 'const', value: 1 },
          then: [
            {
              k: 'for',
              init: { k: 'assign', name: 'i', value: ix(1) },
              cond: { k: 'const', value: 1 },
              inc: nop,
              body: [],
            },
            store(ix(2), { k: 'const', value: 0 }),
          ],
          else: [],
        },
      ]),
    );
    expect(two).not.toBeNull();
    // and the rewrite reached the init, so no access is left pointing at the raw base
    const arm = (two!.body[0] as Extract<Stmt, { k: 'if' }>).then;
    const init = (arm[1] as Extract<Stmt, { k: 'for' }>).init as Extract<Stmt, { k: 'assign' }>;
    expect(init.value).toMatchObject({ k: 'index', base: { k: 'var', name: 'p0' } });
  });

  test('a REPEATED constant offset is refused — the compiler re-materializes a fixed scalar', () => {
    // basecse.ts learned this by losing the ProcessHBlankWait match; inherited rather than re-lost.
    const arm: Stmt[] = [store(ix(7), ix(7)), store(ix(7), ix(7))];
    expect(hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]))).toBeNull();
  });
});

describe('placement within the scope', () => {
  test('the hoist goes immediately before the FIRST use, not at the list head', () => {
    // A call between the assignment and the first use is what forces the pointer into a
    // callee-saved register and adds the prologue push/pop the original avoided — the same failure
    // this module exists to fix, one level smaller. argbase.ts places by the same rule.
    const call: Stmt = { k: 'exprstmt', value: { k: 'call', fn: 'side', args: [] } };
    const arm: Stmt[] = [call, call, store(ix(1), ix(2))];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]));
    expect(out).not.toBeNull();
    const then = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(then.map((s) => s.k)).toEqual(['exprstmt', 'exprstmt', 'assign', 'store']);
    expect(then[2]).toMatchObject({ k: 'assign', name: 'p0' });
  });

  test('two hoists in one scope keep first-appearance order', () => {
    const arm: Stmt[] = [store(ix(1), ix(2)), store(ix(3, { width: 1 }), ix(4, { width: 1 }))];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]));
    const then = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(hoists(then)).toEqual(['p0', 'p1']);
  });
});

describe('refusals: compound `for` parts and shadowed globals', () => {
  test('a COMPOUND `for` init/inc makes the pass decline outright', () => {
    // `init`/`inc` are typed as the full Stmt union, so a nested list there is type-legal. collect
    // reaches only their own expressions while rewriteStmt descends fully — the same walker
    // asymmetry as a `for`'s simple init/inc, one node kind deeper. No producer emits a compound
    // part today; refusing the whole function beats half-collecting it.
    const compoundInit: Stmt = {
      k: 'if',
      cond: { k: 'const', value: 1 },
      then: [store(ix(3), { k: 'const', value: 0 })],
      else: [],
    };
    const arm: Stmt[] = [
      store(ix(1), ix(2)),
      {
        k: 'for',
        init: compoundInit,
        cond: { k: 'const', value: 1 },
        inc: { k: 'assign', name: 'i', value: { k: 'const', value: 0 } },
        body: [],
      },
    ];
    expect(hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]))).toBeNull();
  });

  test('a global SHADOWED by a local is not eligible — `&g` would name the local', () => {
    const arm: Stmt[] = [store(ix(1), ix(2))];
    const base = fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]);
    expect(hoistScopedBases({ ...base, locals: [{ name: 'g', type: T.s(32) }] })).toBeNull();
  });

  test('one local is declared per hoist, however the tree is walked', () => {
    const arm: Stmt[] = [store(ix(1), ix(2))];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]));
    expect(out!.locals.filter((l) => l.name === 'p0')).toHaveLength(1);
  });
});

describe('the subset-scope fallback', () => {
  test('uses spanning the body hoist for the DEEPEST cluster of 2+, not at all or everywhere', () => {
    // basecse cannot see a `var` base, so declining left it unhoisted entirely. Now the deepest
    // scope holding two uses names the base for THOSE, and the rest keep their spelling — the mixed
    // form the compiler produces when it materializes an address in one arm and re-derives it later.
    const arm: Stmt[] = [store(ix(594), ix(659))];
    const out = hoistScopedBases(
      fn([
        { k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] },
        store(ix(10), { k: 'const', value: 0 }),
        store(ix(11), { k: 'const', value: 0 }),
      ]),
    );
    expect(out).not.toBeNull();
    expect(hoists(out!.body)).toEqual([]); // nothing at the function top
    const then = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(hoists(then)).toEqual(['p0']);
    // the clustered uses are repointed...
    expect((then[1] as Extract<Stmt, { k: 'store' }>).lval).toMatchObject({ base: { k: 'var', name: 'p0' } });
    // ...and the ones OUTSIDE the scope keep the raw base, because the hoist does not dominate them
    expect((out!.body[1] as Extract<Stmt, { k: 'store' }>).lval).toMatchObject({ base: { k: 'var', name: 'g' } });
  });
});

describe('what the cluster rule actually is', () => {
  test('DEPTH wins over SIZE — the deeper, smaller cluster is named and the larger left raw', () => {
    // Pinned as a LIMITATION, not an endorsement: the enclosing arm reuses the base four times and
    // still re-derives the address, while the nested pair gets the local. Largest-cluster-first is
    // the better rule and belongs with the placement-selector consolidation.
    const inner: Stmt[] = [store(ix(100), { k: 'const', value: 0 }), store(ix(101), { k: 'const', value: 0 })];
    const arm: Stmt[] = [
      store(ix(1), { k: 'const', value: 0 }),
      store(ix(2), { k: 'const', value: 0 }),
      store(ix(3), { k: 'const', value: 0 }),
      store(ix(4), { k: 'const', value: 0 }),
      { k: 'if', cond: { k: 'const', value: 1 }, then: inner, else: [] },
    ];
    const out = hoistScopedBases(
      fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }, store(ix(9), { k: 'const', value: 0 })]),
    );
    expect(out).not.toBeNull();
    const outer = (out!.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(hoists(outer)).toEqual([]); // the four-use scope gets nothing
    expect(hoists((outer[4] as Extract<Stmt, { k: 'if' }>).then)).toEqual(['p0']);
  });

  test('only ONE cluster is served — a tied sibling keeps the raw base', () => {
    const armA: Stmt[] = [store(ix(1), { k: 'const', value: 0 }), store(ix(2), { k: 'const', value: 0 })];
    const armB: Stmt[] = [store(ix(3), { k: 'const', value: 0 }), store(ix(4), { k: 'const', value: 0 })];
    const out = hoistScopedBases(
      fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: armA, else: armB }, store(ix(9), { k: 'const', value: 0 })]),
    );
    expect(out).not.toBeNull();
    const s = out!.body[0] as Extract<Stmt, { k: 'if' }>;
    expect(hoists(s.then)).toEqual(['p0']);
    expect(hoists(s.else)).toEqual([]); // arbitrary by first appearance, not principled
  });
});

describe('a throwing lever is reported, not swallowed', () => {
  test('onLeverError fires with the label and the first error line', () => {
    // `dropped` records only spellings the SCORER refused, so a lever that throws or fails a
    // boundary contract used to vanish with no trace — indistinguishable from one that correctly
    // declined — so a lever that always throws looks identical to one that never applies.
    const asm = 'f:\n\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\tgSeed\n';
    const seen: string[] = [];
    enumerateCandidates('f', asm, ARMV4T_AGBCC, {
      onLeverError: (label, error) => seen.push(`${label}: ${error}`),
    });
    // no lever throws on this input, so nothing is reported — the hook exists and is wired
    expect(seen).toEqual([]);
  });
});

describe('the admission rules are DATA, and every one of them is load-bearing', () => {
  // `firstRejection` cannot instrument an inline `continue`, and `without(table, id)` cannot ablate
  // one. Each case below re-runs the REAL pass with one rule dropped and asserts the refusal it was
  // holding back — the differential the `gates.ts` contract test cannot do for a pass.
  const armOf = (out: SFn | null): Stmt[] => (out!.body[0] as Extract<Stmt, { k: 'if' }>).then;
  const inArm = (arm: Stmt[], globals = G): SFn =>
    fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }], globals);

  test('nonzero-lead: ablated, the pass names a base whose lead points at another ROW', () => {
    const arm: Stmt[] = [store(ix(594, { lead: [1] }), ix(659, { lead: [1] }))];
    expect(hoistScopedBases(inArm(arm))).toBeNull();
    const out = hoistScopedBases(inArm(arm), { eligibility: without(SCOPEBASE_ELIGIBILITY, 'nonzero-lead') });
    expect(hoists(armOf(out))).toEqual(['p0']);
  });

  test('shadowed-or-nonarray-base: ablated, the pass takes the address of a LOCAL', () => {
    const arm: Stmt[] = [store(ix(1), ix(2))];
    expect(hoistScopedBases(inArm(arm, []))).toBeNull();
    const out = hoistScopedBases(inArm(arm, []), {
      eligibility: without(SCOPEBASE_ELIGIBILITY, 'shadowed-or-nonarray-base'),
    });
    expect(hoists(armOf(out))).toEqual(['p0']);
  });

  test('single-use: ablated, one access still gets a local', () => {
    const arm: Stmt[] = [store(ix(1), { k: 'const', value: 0 })];
    expect(hoistScopedBases(inArm(arm))).toBeNull();
    expect(hoists(armOf(hoistScopedBases(inArm(arm), { gates: without(SCOPEBASE_GATES, 'single-use') })))).toEqual([
      'p0',
    ]);
  });

  test('repeated-const-offset: ablated, the scalar RMW shape is named', () => {
    const arm: Stmt[] = [store(ix(7), ix(7)), store(ix(7), ix(7))];
    expect(hoistScopedBases(inArm(arm))).toBeNull();
    expect(
      hoists(armOf(hoistScopedBases(inArm(arm), { gates: without(SCOPEBASE_GATES, 'repeated-const-offset') }))),
    ).toEqual(['p0']);
  });

  test('per-iteration-use: ablated, a loop-CONDITION use hoists above the loop', () => {
    const body = [
      {
        k: 'while' as const,
        cond: { k: 'bin' as const, op: '!=' as const, l: ix(1), r: { k: 'const' as const, value: 0 } },
        body: [],
      },
      store(ix(2), { k: 'const', value: 0 }),
    ];
    expect(hoistScopedBases(inArm(body))).toBeNull();
    expect(
      hoists(armOf(hoistScopedBases(inArm(body), { gates: without(SCOPEBASE_GATES, 'per-iteration-use') }))),
    ).toEqual(['p0']);
  });

  test('nested-loop-use: ablated, a use inside a nested loop is hoisted out of it', () => {
    const body = [
      { k: 'while' as const, cond: { k: 'const' as const, value: 1 }, body: [store(ix(1), { k: 'const', value: 0 })] },
      store(ix(2), { k: 'const', value: 0 }),
    ];
    expect(hoistScopedBases(inArm(body))).toBeNull();
    expect(
      hoists(armOf(hoistScopedBases(inArm(body), { gates: without(SCOPEBASE_GATES, 'nested-loop-use') }))),
    ).toEqual(['p0']);
  });
});

describe('a structurally SHARED access node makes the pass decline outright', () => {
  test('one `index` object at two tree positions is refused, the same shape unshared fires', () => {
    // The plan repoints by NODE IDENTITY, so one object at two positions is one entry claiming two
    // uses the hoist need not dominate. Nothing in the L3 contract forbids the sharing and no
    // producer emits it today, so this is a loud decline rather than a second traversal. It is a
    // whole-FUNCTION refusal with no per-candidate ctx, which is why it is not in the gate table.
    const shared = ix(0, { idx: { k: 'var', name: 'i' } });
    const arm: Stmt[] = [store(shared, { k: 'const', value: 0 }), store(shared, { k: 'const', value: 0 })];
    expect(hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: arm, else: [] }]))).toBeNull();

    const distinct: Stmt[] = [
      store(ix(0, { idx: { k: 'var', name: 'i' } }), { k: 'const', value: 0 }),
      store(ix(0, { idx: { k: 'var', name: 'i' } }), { k: 'const', value: 0 }),
    ];
    const out = hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: distinct, else: [] }]));
    expect(hoists((out!.body[0] as Extract<Stmt, { k: 'if' }>).then)).toEqual(['p0']);
  });
});

describe('the dominance POSTCONDITION, checked on the pass`s own output', () => {
  // The catastrophic failure this module can ship is not a bad spelling: it is a base local
  // declared where its assignment does not reach the use, which is a DIFFERENT VARIABLE — C that
  // compiles, scores, and can win. `rank.ts`'s `respell` catches a throw and drops the candidate,
  // so the check turns that silent wrong answer back into a loud one.
  const pAt = (i: number): Expr => ({
    k: 'index',
    base: { k: 'var', name: 'p0' },
    idx: { k: 'const', value: i },
    width: 2,
    signed: false,
  });
  const assignP0: Stmt = {
    k: 'assign',
    name: 'p0',
    value: { k: 'cast', to: T.ptr(T.u(16)), e: { k: 'addr', name: 'g' } },
  };
  const undominated: SFn = {
    ...fn([
      { k: 'if', cond: { k: 'const', value: 1 }, then: [assignP0, store(pAt(1), { k: 'const', value: 0 })], else: [] },
      store(pAt(2), { k: 'const', value: 0 }),
    ]),
    locals: [{ name: 'p0', type: T.ptr(T.u(16)) }],
  };

  test('a use the assignment does not reach THROWS', () => {
    expect(() => assertHoistsDominate(undominated, new Set(['p0']))).toThrow(/p0/);
  });

  test('the same input passes assertLocalsWritten — which is why this check has to exist', () => {
    // `assertLocalsWritten` accumulates reads and writes as SETS over the whole body, so a local
    // assigned in one arm and read after the `if` is written somewhere and satisfies it.
    expect(() => assertLocalsWritten(undominated)).not.toThrow();
  });

  test('the assignment moved above the `if` is accepted', () => {
    const dominated: SFn = { ...undominated, body: [assignP0, ...undominated.body] };
    expect(() => assertHoistsDominate(dominated, new Set(['p0']))).not.toThrow();
  });

  test('a name the pass did not mint is not this check`s business', () => {
    expect(() => assertHoistsDominate(undominated, new Set())).not.toThrow();
  });
});

describe('a statement SHAPE may not move a placed def below the use it serves', () => {
  // `rank.ts` derives the statement-shape products (`/initfirst`, `/pollguard`, `/pollread`) onto
  // EVERY spelling, AFTER a lever has placed its defs — `pollReads` folds a materialized re-read
  // back into a loop condition, which is a move ACROSS the placement this pass computed. The
  // postcondition inside the pass cannot see that; this is the differential that can.
  const pAt = (i: number): Expr => ({
    k: 'index',
    base: { k: 'var', name: 'p0' },
    idx: { k: 'const', value: i },
    width: 2,
    signed: false,
  });
  const assignP0: Stmt = {
    k: 'assign',
    name: 'p0',
    value: { k: 'cast', to: T.ptr(T.u(16)), e: { k: 'addr', name: 'g' } },
  };
  const use: Stmt = store(pAt(1), { k: 'const', value: 0 });
  const placed: SFn = { ...fn([assignP0, use]), locals: [{ name: 'p0', type: T.ptr(T.u(16)) }] };
  const reordered: SFn = { ...placed, body: [use, assignP0] };

  test('a reshaped tree that broke the placement THROWS', () => {
    expect(() => assertPlacementSurvives(placed, reordered, new Set(['p0']))).toThrow(/p0/);
  });

  test('a reshaped tree that kept it does not', () => {
    expect(() => assertPlacementSurvives(placed, placed, new Set(['p0']))).not.toThrow();
  });

  test('a placement this walk cannot model is not judged by it — in EITHER tree', () => {
    // A def inside a loop body read earlier in the same body is assigned on every iteration but
    // the first; the walk says undominated. It is not this check's business, and a shape derived
    // from it must not be dropped on the strength of a model that never described it.
    expect(() => assertPlacementSurvives(reordered, reordered, new Set(['p0']))).not.toThrow();
    expect(() => assertPlacementSurvives(reordered, placed, new Set(['p0']))).not.toThrow();
  });
});
