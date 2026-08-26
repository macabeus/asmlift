import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { type BaseInit, placeBaseLocals } from '../src/l3/hoist';
import { sinkInitsToFirstUse } from '../src/l3/sinkinit';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const U8P = T.ptr(T.int(8, false));
const c = (value: number): Expr => ({ k: 'const', value });
const init = (name: string, addr: number): Stmt => ({ k: 'assign', name, value: { k: 'cast', to: U8P, e: c(addr) } });
const read = (name: string, i: number): Stmt => ({
  k: 'store',
  lval: { k: 'index', base: { k: 'var', name: 'a0' }, idx: c(i), width: 4, signed: true },
  value: { k: 'index', base: { k: 'var', name }, idx: c(i), width: 1, signed: false },
});
const plain = (): Stmt => ({
  k: 'store',
  lval: { k: 'index', base: { k: 'var', name: 'a0' }, idx: c(0), width: 4, signed: true },
  value: c(1),
});
const fn = (body: Stmt[], locals: SFn['locals'] = [{ name: 'p0', type: U8P }]): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: T.ptr(T.s(32)) }],
  locals,
  retType: T.void(),
  body,
});

describe('sinking a leading base init to its first use', () => {
  test('an init whose first use is two statements down moves to sit immediately above it', () => {
    const out = sinkInitsToFirstUse(fn([init('p0', 0x3001100), plain(), plain(), read('p0', 2)]));
    expect(out?.body.map((s) => s.k)).toEqual(['store', 'store', 'assign', 'store']);
    expect(out?.body[2]).toEqual(init('p0', 0x3001100));
  });

  test('an init already sitting above its first use declines: nothing to move', () => {
    expect(sinkInitsToFirstUse(fn([init('p0', 0x3001100), read('p0', 0), plain()]))).toBeNull();
  });

  test('a `volatile` local ends the run: its write order is observable', () => {
    const body = [init('p0', 0x3001100), plain(), read('p0', 1)];
    expect(sinkInitsToFirstUse(fn(body, [{ name: 'p0', type: U8P, volatile: true }]))).toBeNull();
  });

  test('a local the function writes again is refused: the sink would cross that write', () => {
    const body: Stmt[] = [
      init('p0', 0x3001100),
      plain(),
      { k: 'assign', name: 'p0', value: { k: 'cast', to: U8P, e: c(0x3001200) } },
      read('p0', 2),
    ];
    expect(sinkInitsToFirstUse(fn(body))).toBeNull();
  });

  test('an `&p` escape counts as the first use, so the init stops above it', () => {
    // the first-use query is l3/hoist.ts's, shared with basecse.ts; an init that crossed the
    // escape would hand out the address of an unwritten cell
    const escape: Stmt = { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'p0' }] } };
    const out = sinkInitsToFirstUse(fn([init('p0', 0x3001100), plain(), escape, read('p0', 3)]));
    expect(out?.body.map((s) => s.k)).toEqual(['store', 'assign', 'exprstmt', 'store']);
  });

  test('a first use nested inside an `if` sinks only to the `if`, never into the arm', () => {
    const arm: Stmt = { k: 'if', cond: c(1), then: [read('p0', 1)], else: [] };
    const out = sinkInitsToFirstUse(fn([init('p0', 0x3001100), plain(), arm]));
    expect(out?.body.map((s) => s.k)).toEqual(['store', 'assign', 'if']);
  });

  test('two inits each land at their own first use, in body order', () => {
    const out = sinkInitsToFirstUse(
      fn(
        [init('p0', 0x3001100), init('p1', 0x4000000), plain(), read('p1', 2), read('p0', 3)],
        [
          { name: 'p0', type: U8P },
          { name: 'p1', type: U8P },
        ],
      ),
    );
    expect(out?.body.map((s) => (s.k === 'assign' ? s.name : s.k))).toEqual(['store', 'p1', 'store', 'p0', 'store']);
  });

  test('nothing mentions the init: it stays at the head rather than sinking to the end', () => {
    expect(sinkInitsToFirstUse(fn([init('p0', 0x3001100), plain()]))).toBeNull();
  });

  test('no leading init at all: the lever declines', () => {
    expect(sinkInitsToFirstUse(fn([plain(), init('p0', 0x3001100), read('p0', 1)]))).toBeNull();
  });
});

describe('both placements are ONE mechanism with a policy argument (l3/hoist.ts)', () => {
  // basecse.ts and sinkinit.ts answer "where does the run go" differently and nothing else, so the
  // two answers are two values of one parameter. Pinned here because a caller re-growing its own
  // placement is exactly the drift this fold removed. `prepend` is not one of them — it is
  // nearbase.ts's abstention from the ordering, pinned separately below.
  const named = (name: string, addr: number): BaseInit => init(name, addr) as BaseInit;

  test('`head` keeps the run at the top; `first-use` moves what it can, and says how much moved', () => {
    const body = [init('p0', 0x3001100), plain(), plain(), read('p0', 2)];
    const sfn = fn(body);
    expect(placeBaseLocals(sfn, [], 'head')).toEqual({ body, moved: 0 });
    const sunk = placeBaseLocals(sfn, [], 'first-use');
    expect(sunk.body.map((s) => s.k)).toEqual(['store', 'store', 'assign', 'store']);
    expect(sunk.moved).toBe(1);
  });

  test('a MINTED init obeys the same policy — the minting caller adds no placement of its own', () => {
    const body = [init('p0', 0x3001100), plain(), read('p1', 1), read('p0', 2)];
    const locals = [
      { name: 'p0', type: U8P },
      { name: 'p1', type: U8P },
    ];
    const sfn = fn(body, locals);
    const minted = [named('p1', 0x4000000)];
    // head: pool-load order, so the base first USED (p1) leads even though it was minted second
    expect(placeBaseLocals(sfn, minted, 'head').body.map((s) => (s.k === 'assign' ? s.name : s.k))).toEqual([
      'p1',
      'p0',
      'store',
      'store',
      'store',
    ]);
    expect(placeBaseLocals(sfn, minted, 'first-use').body.map((s) => (s.k === 'assign' ? s.name : s.k))).toEqual([
      'store',
      'p1',
      'store',
      'p0',
      'store',
    ]);
  });
});

// The `/sinkinit` SUFFIX has two producers in `rank.ts` — `/livebase*/sinkinit` composes a second
// pass on top of a head hoist, `/basefold/sinkinit` is one hoist placed at first use — and a label
// read out of a `[score]` log or an artifact row does not say which. They must therefore be the
// SAME TRANSFORM, or one suffix names two things in the namespace cross-round attribution greps.
describe('composition and argument are one transform: sink(head(x)) === firstUse(x)', () => {
  // The only place they could disagree is the order of the inits that CANNOT move, which is the
  // half of the run whose order the compiler still reads as pool-load order. `placeBaseLocals`
  // orders the whole run by first use BEFORE consulting the policy, which is what makes the two
  // agree; order it only on the `head` branch and this test is what fails.
  const named = (name: string, sym: string): BaseInit => ({
    k: 'assign',
    name,
    value: { k: 'cast', to: U8P, e: { k: 'addr', name: sym } },
  });
  const touch = (name: string): Stmt => ({
    k: 'store',
    lval: { k: 'index', base: { k: 'var', name }, idx: c(0), width: 1, signed: false },
    value: c(1),
  });

  test('with immovable inits whose input order is NOT first-use order', () => {
    // pA and pB are each assigned twice, so neither can move; in the body pB is touched first, so
    // a first-use ordering has to put pB above pA even though pA was minted first. pC moves.
    const locals = ['pA', 'pB', 'pC'].map((name) => ({ name, type: U8P }));
    const body: Stmt[] = [
      named('pA', 'gA'),
      named('pB', 'gB'),
      named('pC', 'gC'),
      touch('pB'),
      touch('pA'),
      named('pA', 'gA2'),
      named('pB', 'gB2'),
      touch('pC'),
    ];
    const sfn: SFn = { name: 'f', params: [], locals, retType: T.void(), body };
    const head = { ...sfn, body: placeBaseLocals(sfn, [], 'head').body };
    const composed = sinkInitsToFirstUse(head);
    const argued = { ...sfn, body: placeBaseLocals(sfn, [], 'first-use').body };
    expect(composed).not.toBeNull();
    expect(composed!.body).toEqual(argued.body);
    // …and the order really is the first-use one, not the input one — otherwise this would pass
    // for the trivial reason that neither did anything.
    expect(argued.body.slice(0, 2).map((st) => (st.k === 'assign' ? st.name : st.k))).toEqual(['pB', 'pA']);
  });

  test('two inits assigning the SAME local keep their sequence — a stable sort is load-bearing', () => {
    // They write one cell, so their order is the only thing that says which value it holds after
    // the run. Both share a first-use key, so only sort stability keeps them apart.
    const locals = [{ name: 'p0', type: U8P }];
    const body: Stmt[] = [named('p0', 'gFirst'), named('p0', 'gSecond'), touch('p0')];
    const sfn: SFn = { name: 'f', params: [], locals, retType: T.void(), body };
    for (const placement of ['head', 'first-use'] as const) {
      const out = placeBaseLocals(sfn, [], placement).body;
      expect(out.filter((st) => st.k === 'assign')).toEqual([named('p0', 'gFirst'), named('p0', 'gSecond')]);
    }
  });

  test('inits that SINK to the same statement keep first-use order, not the reverse of it', () => {
    // The splice loop inserts at one index repeatedly, so the last init spliced lands on top —
    // without a descending tie-break a run that sinks together comes out backwards, and the whole
    // point of the sort above is that this order is the compiler's pool-load order. `head` cannot
    // hit it (it never splices), so composition and argument would silently disagree here.
    const locals = ['p0', 'p1'].map((name) => ({ name, type: U8P }));
    const body: Stmt[] = [
      named('p0', 'gA'),
      named('p1', 'gB'),
      plain(),
      {
        k: 'exprstmt',
        value: {
          k: 'call',
          fn: 'sink',
          args: [
            { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(0), width: 1, signed: false },
            { k: 'index', base: { k: 'var', name: 'p1' }, idx: c(0), width: 1, signed: false },
          ],
        },
      },
    ];
    const sfn: SFn = { name: 'f', params: [], locals, retType: T.void(), body };
    const argued = placeBaseLocals(sfn, [], 'first-use');
    expect(argued.body.map((st) => (st.k === 'assign' ? st.name : st.k))).toEqual(['store', 'p0', 'p1', 'exprstmt']);
    // …and the composed spelling agrees, which is the invariant the suffix rests on
    expect(sinkInitsToFirstUse({ ...sfn, body: placeBaseLocals(sfn, [], 'head').body })!.body).toEqual(argued.body);
  });
});

describe("`prepend` is nearbase.ts's ABSTENTION, not a third position", () => {
  // It consults neither the first-use query nor the ordering sort. Stated in l3/hoist.ts and
  // pinned here so a reader who takes the enum for one axis is corrected by a failing test rather
  // than by a compiled row: `l3/nearbase.ts` relies on the run beneath it keeping its own order
  // (synthetic:dmafield), and `l3/basecse.ts` is typed out of reaching this value at all.
  const named = (name: string, sym: string): BaseInit => ({
    k: 'assign',
    name,
    value: { k: 'cast', to: U8P, e: { k: 'addr', name: sym } },
  });
  const touch = (name: string): Stmt => ({
    k: 'store',
    lval: { k: 'index', base: { k: 'var', name }, idx: c(0), width: 1, signed: false },
    value: c(1),
  });

  test('it is exactly [...minted, ...body], even when the run below is out of first-use order', () => {
    const locals = ['q0', 'q1', 'p0'].map((name) => ({ name, type: U8P }));
    // q1 leads the run but q0 is touched first, so first-use order would reorder them
    const body: Stmt[] = [named('q1', 'gQ1'), named('q0', 'gQ0'), touch('q0'), touch('p0'), touch('q1')];
    const sfn: SFn = { name: 'f', params: [], locals, retType: T.void(), body };
    const minted = [named('p0', 'gP0')];
    expect(placeBaseLocals(sfn, minted, 'prepend')).toEqual({ body: [...minted, ...body], moved: 0 });
    // …and sinking a prepend result is NOT the same as asking for `first-use` outright, because
    // the run it hands the stable sort is in prepend's order: where first use does not separate a
    // minted init from an existing one, the minted one keeps the lead `prepend` gave it. That is
    // what `/nearbase/sinkinit` offers (rank.ts) — one transform, a different input — and writing
    // "sink(prepend(x)) === firstUse(x)" by analogy with `head` is the mistake this pins.
    const tie: SFn = {
      ...sfn,
      locals: [
        { name: 'q0', type: U8P },
        { name: 'p0', type: U8P },
      ],
      // q0 and p0 are first used by the SAME statement, so first use does not separate them
      body: [
        named('q0', 'gQ0'),
        touch('unrelated'),
        {
          k: 'exprstmt',
          value: {
            k: 'call',
            fn: 'sink',
            args: [
              { k: 'index', base: { k: 'var', name: 'q0' }, idx: c(0), width: 1, signed: false },
              { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(0), width: 1, signed: false },
            ],
          },
        },
      ],
    };
    const sunkPrepend = sinkInitsToFirstUse({ ...tie, body: placeBaseLocals(tie, minted, 'prepend').body });
    expect(sunkPrepend!.body.map((st) => (st.k === 'assign' ? st.name : st.k))).toEqual([
      'store',
      'p0',
      'q0',
      'exprstmt',
    ]);
    expect(placeBaseLocals(tie, minted, 'first-use').body.map((st) => (st.k === 'assign' ? st.name : st.k))).toEqual([
      'store',
      'q0',
      'p0',
      'exprstmt',
    ]);
    // the contrast: `head` sits in the same POSITION and reorders, so the two are not one axis
    expect(placeBaseLocals(sfn, minted, 'head').body.map((st) => (st.k === 'assign' ? st.name : st.k))).toEqual([
      'q0',
      'p0',
      'q1',
      'store',
      'store',
      'store',
    ]);
  });
});

describe('the /livebase pairing is WIRED into enumeration', () => {
  // `corpus/agbcc-mixpoll.s` is synthetic:mixpoll:agbcc — an MMIO poll whose bases the DEFAULT
  // hoist refuses outright, so the tree this lever reads on its own carries no init at all.
  const labels = enumerateCandidates(
    'mixpoll',
    readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-mixpoll.s'), 'utf8'),
    ARMV4T_AGBCC,
    { prototypes: { mixpoll: { returnsVoid: true } } },
  ).map((x) => x.label);

  test('the joint spelling reaches the differ, over the whole admission roster', () => {
    expect(labels).toContain('signed/livebase/sinkinit');
    expect(labels).toContain('signed/livebase-block/volatile/sinkinit');
  });

  test('and it is reachable no other way: the plain lever finds nothing to sink here', () => {
    expect(labels.filter((l) => l.includes('sinkinit') && !l.includes('livebase'))).toEqual([]);
  });
});
