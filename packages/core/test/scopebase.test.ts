// The `/scopebase` lever (l3/scopebase.ts): name a reused global base at the INNERMOST scope that
// holds its uses.
//
// It exists because `basecse.ts` hoists only to the FUNCTION TOP and only for an `addr`/`const`
// base. Both limits cost real bytes: a top-level hoist extends a live range the original never had,
// and the rank-aware bare spelling `gSym[0][i]` has a `var` base that basecse cannot see. These pin
// the scope choice and every refusal — the lever is differ-refereed, so its risk is spelling
// quality, not correctness of the winner, but a wrong REWRITE would still be shown on a nonmatch row.
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

const store = (dst: Expr, src: Expr): Stmt => ({ k: 'store', lval: dst, value: src });

const fn = (body: Stmt[], globals = G): SFn => ({
  name: 'f',
  params: [],
  locals: [],
  globals,
  retType: T.void(),
  body,
});

/** The hoist assignments introduced at the head of a statement list. */
const hoists = (list: Stmt[]): string[] =>
  list.filter((s): s is Extract<Stmt, { k: 'assign' }> => s.k === 'assign' && s.name.startsWith('p')).map((s) => s.name);

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

  test('uses spanning the FUNCTION BODY decline — that is basecse’s hoist, not this one', () => {
    // Emitting it here would duplicate the primary spelling rather than add a distinct candidate.
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
      hoistScopedBases(fn([{ k: 'if', cond: { k: 'const', value: 1 }, then: [store(ix(1), { k: 'const', value: 0 })], else: [] }])),
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
    const arm: Stmt[] = [
      store(ix(1), ix(2)),
      store(ix(3, { width: 1 }), ix(4, { width: 1 })),
    ];
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
