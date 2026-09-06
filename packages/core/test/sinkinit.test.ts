import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { assertHoistsDominate } from '../src/contracts';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { stmtLists } from '../src/l3/ast';
import { BASECSE_GATES, ORDERBASE_GATES, admittedBases, hoistBaseLocals } from '../src/l3/basecse';
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

  test('`head` keeps the run at the top; `first-use` moves what it can, and NAMES what moved', () => {
    const body = [init('p0', 0x3001100), plain(), plain(), read('p0', 2)];
    const sfn = fn(body);
    expect(placeBaseLocals(sfn, [], 'head')).toEqual({ body, moved: [], nested: [] });
    const sunk = placeBaseLocals(sfn, [], 'first-use');
    expect(sunk.body.map((s) => s.k)).toEqual(['store', 'store', 'assign', 'store']);
    expect(sunk.moved).toEqual(['p0']);
    // a flat placement can put nothing in a nested list, which is what `nested` is for
    expect(sunk.nested).toEqual([]);
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
    expect(placeBaseLocals(sfn, minted, 'prepend')).toEqual({ body: [...minted, ...body], moved: [], nested: [] });
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
  const fan = enumerateCandidates(
    'mixpoll',
    readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-mixpoll.s'), 'utf8'),
    ARMV4T_AGBCC,
    { prototypes: { mixpoll: { returnsVoid: true } } },
  );
  const labels = fan.map((x) => x.label);
  const sourceOf = (label: string): string | undefined => fan.find((c) => c.label === label)?.source;

  test('the joint spelling reaches the differ, over the whole admission roster', () => {
    expect(labels).toContain('signed/livebase/sinkinit');
    // PINNED AS A PROGRAM, because a label is not an attribution (see the `seen` dedup in rank.ts).
    // WHICH route emits the sunk narrow program is exactly what `seen` decides, and it moves under
    // roster edits that change no program at all: on this fixture `/unfolded` binds the same
    // register file `/livebase-block` does, its roster row runs before the `/livebase ×` product
    // loops, and it places at first use — so it takes the label today, and ablating that row leaves
    // the same 60 distinct sources with the same sunk program relabelled
    // `signed/livebase-block/volatile/sinkinit`. A label-keyed assertion goes red there for a
    // program that never moved. A substring one (`some label contains livebase-block`) fails the
    // other way: the twelve HEAD-placed narrow candidates satisfy it with the sunk spelling gone
    // entirely.
    //
    // So SEARCH for the program and let whichever route produced it own the label. What has to hold
    // is that the narrow admission's bases reach the differ SUNK: the same declarations and the same
    // statements as the head-placed narrow candidate, differing only in where the base init sits
    // relative to the loop counter's `v0 = 0;`. Ablating the narrow family itself (`single-cell` out
    // of LIVEBASE_BLOCK_GATES) takes `head` away and this goes red, which is the regression it is
    // for.
    const head = sourceOf('signed/livebase-block/volatile');
    expect(head).toBeDefined();
    expect(head!.indexOf('v0 = 0;')).toBeGreaterThan(head!.indexOf('p0 = (s32 *)'));
    const sameLines = (a: string, b: string): boolean =>
      a.split('\n').sort().join('\n') === b.split('\n').sort().join('\n');
    const sunk = fan.filter(
      (cand) =>
        cand.source !== head &&
        sameLines(cand.source, head!) &&
        cand.source.indexOf('v0 = 0;') < cand.source.indexOf('p0 = (s32 *)'),
    );
    expect(sunk).toHaveLength(1);
    // Its label today is `signed/unfolded/volatile`, and `signed/livebase-block/volatile/sinkinit`
    // with that roster row ablated. Deliberately NOT asserted: either is the same program. That
    // leaves the ROSTER ROW unpinned here by design — `basecse.test.ts`'s "and the ROSTER offers
    // it" owns that subject, keyed on the base SET only that row parks. Two tests, two subjects;
    // this one stays label-free.
  });

  test('and it is reachable no other way: the plain lever finds nothing to sink here', () => {
    expect(labels.filter((l) => l.includes('sinkinit') && !l.includes('livebase'))).toEqual([]);
  });
});

describe('`scope` is the third placement: the init goes INSIDE the block holding every use', () => {
  // The gap l3/scopebase.ts names in its own header — "the init still lands ABOVE the `if`, because
  // sinking INTO the arm is what needs the domination work" — as a value of the placement argument
  // the roster already states. `first-use` reaches only the TOP-LEVEL statement list, so a base
  // whose every use is inside one arm stays live across everything before that arm.
  const guarded = (uses: Stmt[]): SFn =>
    fn([init('p0', 0x3001100), plain(), { k: 'if', cond: c(1), then: uses, else: [] }]);
  const kinds = (sfn: SFn, placement: 'head' | 'first-use' | 'scope'): unknown =>
    placeBaseLocals(sfn, [], placement).body.map((s) => (s.k === 'if' ? ['if', s.then.map((t) => t.k)] : s.k));

  test('a use confined to one `if` arm: `first-use` stops above the `if`, `scope` goes inside it', () => {
    const sfn = guarded([read('p0', 1), plain()]);
    expect(kinds(sfn, 'first-use')).toEqual(['store', 'assign', ['if', ['store', 'store']]]);
    expect(kinds(sfn, 'scope')).toEqual(['store', ['if', ['assign', 'store', 'store']]]);
    expect(placeBaseLocals(sfn, [], 'scope').moved).toEqual(['p0']);
  });

  test('the arm is entered at the FIRST use inside it, not at its top', () => {
    const sfn = guarded([plain(), read('p0', 1)]);
    expect(kinds(sfn, 'scope')).toEqual(['store', ['if', ['store', 'assign', 'store']]]);
  });

  test('uses in BOTH arms have no inner list holding all of them: `scope` is `first-use`', () => {
    const sfn = fn([
      init('p0', 0x3001100),
      plain(),
      { k: 'if', cond: c(1), then: [read('p0', 1)], else: [read('p0', 2)] },
    ]);
    expect(placeBaseLocals(sfn, [], 'scope').body).toEqual(placeBaseLocals(sfn, [], 'first-use').body);
  });

  test('a use in the `if` CONDITION itself keeps the init above the `if`', () => {
    const sfn = fn([
      init('p0', 0x3001100),
      plain(),
      {
        k: 'if',
        cond: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(0), width: 1, signed: false },
        then: [read('p0', 1)],
        else: [],
      },
    ]);
    expect(placeBaseLocals(sfn, [], 'scope').body).toEqual(placeBaseLocals(sfn, [], 'first-use').body);
  });

  test('a list at TWO tree positions is never a scope site: both positions mention it', () => {
    // Nothing in the L3 contract forbids the sharing, and an init spliced into a shared list would
    // be written twice. The descent cannot reach one — two mentioning statements stop it at their
    // common list — and this is that invariant, asserted where breaking it would be silent.
    const shared: Stmt[] = [read('p0', 1)];
    const sfn = fn([
      init('p0', 0x3001100),
      { k: 'if', cond: c(1), then: shared, else: [] },
      { k: 'if', cond: c(2), then: shared, else: [] },
    ]);
    expect(placeBaseLocals(sfn, [], 'scope').body).toEqual(placeBaseLocals(sfn, [], 'head').body);
  });

  test('a local the function assigns again does not sink — the move would cross that write', () => {
    const sfn = fn([
      init('p0', 0x3001100),
      { k: 'if', cond: c(1), then: [init('p0', 0x3001200), read('p0', 1)], else: [] },
    ]);
    expect(placeBaseLocals(sfn, [], 'scope').body).toEqual(placeBaseLocals(sfn, [], 'head').body);
  });
});

describe('the `scope` placement DECLINES where it degenerates (l3/basecse.ts)', () => {
  // A `scope` run that put nothing in a nested list emits the `first-use` tree. `rank.ts` withholds
  // the flat `first-use` row for this gate table deliberately (ORDERBASE_ADMISSIONS: measured at
  // zero over the four rows where it differs from `head`), so returning that tree here ships the
  // withheld candidate under the scoped one's name. Over each project's whole `asm` tree, map-ful:
  // of the 48 functions `ORDERBASE_GATES` admits, 7 place an init inside a nested list and 41 do
  // not — and for 29 of the 41 the withheld spelling is one no other roster row produces.
  const held = (body: Stmt[], locals: SFn['locals'] = []): SFn => ({
    name: 'f',
    params: [{ name: 'a0', type: T.ptr(T.s(32)) }],
    locals,
    retType: T.void(),
    body,
  });
  // Three reads of one const base — the smallest shape BASECSE_GATES admits (2+ uses, no loop, no
  // repeated constant offset).
  const cuse = (i: number): Stmt => ({
    k: 'store',
    lval: { k: 'index', base: c(0x40000d4), idx: c(i), width: 4, signed: true },
    value: c(0),
  });
  const uses = [0, 1, 2].map(cuse);

  test('every init landed in the TOP-LEVEL list: `scope` declines, and the flat placements answer', () => {
    const flat = held([plain(), ...uses]);
    expect(hoistBaseLocals(flat, BASECSE_GATES, 'scope')).toBeNull();
    // …and it is not that the shape has no hoist: the flat placements both produce one, and they
    // produce DIFFERENT trees, so the withheld row is exactly what `scope` would have restated.
    const head = hoistBaseLocals(flat, BASECSE_GATES, 'head');
    const firstUse = hoistBaseLocals(flat, BASECSE_GATES, 'first-use');
    expect(head.body.map((s) => s.k)).toEqual(['assign', 'store', 'store', 'store', 'store']);
    expect(firstUse.body.map((s) => s.k)).toEqual(['store', 'assign', 'store', 'store', 'store']);
  });

  test('an init that reaches a nested list still answers, and the init is INSIDE it', () => {
    const nested = held([plain(), { k: 'if', cond: c(1), then: uses, else: [] }]);
    const out = hoistBaseLocals(nested, BASECSE_GATES, 'scope');
    expect(out).not.toBeNull();
    const arm = out!.body[1];
    expect(arm.k === 'if' && arm.then.map((s) => s.k)).toEqual(['assign', 'store', 'store', 'store']);
  });

  test('no base admitted at all is a decline too, not the unhoisted tree under a scoped label', () => {
    expect(hoistBaseLocals(held([plain(), cuse(0)]), BASECSE_GATES, 'scope')).toBeNull();
    expect(hoistBaseLocals(held([plain(), cuse(0)]), BASECSE_GATES, 'head').body).toHaveLength(2);
  });

  test('the domination check judges what MOVED, inherited inits included — not only what was minted', () => {
    // `hoistBaseLocals` inherits the leading run `structureChecked` already committed (pipeline.ts)
    // and `scope` moves those inits too. Judging only the minted names left every inherited one
    // argued rather than checked; `moved` is the placer's own report of the motion, so the check's
    // population is the motion by construction.
    const sfn = fn(
      [init('p0', 0x3001100), plain(), { k: 'if', cond: c(1), then: [read('p0', 1), read('p1', 2)], else: [] }],
      [
        { name: 'p0', type: U8P },
        { name: 'p1', type: U8P },
      ],
    );
    const r = placeBaseLocals(sfn, [init('p1', 0x4000000) as BaseInit], 'scope');
    expect(r.moved).toEqual(['p0', 'p1']);
    expect(r.nested).toEqual(['p0', 'p1']);
  });
});

describe('`scope` descends through every construct that opens a list, not just `if`', () => {
  // `stmtLists`/`mapStmtLists` are exhaustive over the five list-carrying kinds. `switch` has real
  // inhabitants in the sa3 checkout, no benchmark row among them: `Task_809A1C4` sinks one base
  // into its `case 0` arm and a second into its `case 90`, in both symbol-map arms.
  const around = (s: Stmt): SFn => fn([init('p0', 0x3001100), plain(), s]);
  const inside = (sfn: SFn): unknown => {
    const body = placeBaseLocals(sfn, [], 'scope').body;
    const lists = (s: Stmt): unknown => stmtLists(s).map((l) => l.map((x) => x.k));
    return body.map((s) => (s.k === 'assign' ? s.name : stmtLists(s).length === 0 ? s.k : [s.k, lists(s)]));
  };

  test('a `while` body holding every mention takes the init', () => {
    expect(inside(around({ k: 'while', cond: c(1), body: [read('p0', 1), plain()] }))).toEqual([
      'store',
      ['while', [['assign', 'store', 'store']]],
    ]);
  });

  test('a `dowhile` body does too', () => {
    expect(inside(around({ k: 'dowhile', cond: c(1), body: [plain(), read('p0', 1)] }))).toEqual([
      'store',
      ['dowhile', [['store', 'assign', 'store']]],
    ]);
  });

  test('a `for` body does, and a mention in its `init`/`inc` — statements no list holds — stops it', () => {
    const counted = (body: Stmt[], inc: Stmt = plain()): Stmt => ({
      k: 'for',
      init: plain(),
      cond: c(1),
      inc,
      body,
    });
    expect(inside(around(counted([read('p0', 1)])))).toEqual(['store', ['for', [['assign', 'store']]]]);
    // the `inc` mentions it and no nested list holds that mention: the init stays above the loop
    const withInc = around(counted([read('p0', 1)], read('p0', 2)));
    expect(placeBaseLocals(withInc, [], 'scope').body).toEqual(placeBaseLocals(withInc, [], 'first-use').body);
  });

  test('a `for` whose `init` IS one of its body statements keeps the hoist above the loop', () => {
    // Nothing in the L3 contract forbids one `Stmt` object sitting at two tree positions
    // (l3/scopebase.ts records a producer that shares an expression node), and a `for` is the one
    // kind whose children are not all in the lists it opens. Were the descent to subtract the
    // opened lists by IDENTITY, the shared statement would read as opened, the mention in the
    // `init` — which runs before the body — would go unseen, and the init would sink below it.
    const shared = read('p0', 1);
    const loop: Stmt = { k: 'for', init: shared, cond: c(1), inc: plain(), body: [shared] };
    const sfn = around(loop);
    expect(placeBaseLocals(sfn, [], 'scope').body).toEqual(placeBaseLocals(sfn, [], 'first-use').body);
  });

  test('one `switch` arm holding every mention takes the init; two arms stop at the switch', () => {
    const arm = (values: number[], body: Stmt[]) => ({ values, body, fallsThrough: false });
    const one: Stmt = {
      k: 'switch',
      scrutinee: c(1),
      cases: [arm([0], [plain()]), arm([1], [read('p0', 1)])],
    };
    expect(inside(around(one))).toEqual(['store', ['switch', [['store'], ['assign', 'store']]]]);
    const two: Stmt = {
      k: 'switch',
      scrutinee: c(1),
      cases: [arm([0], [read('p0', 1)]), arm([1], [read('p0', 2)])],
    };
    expect(placeBaseLocals(around(two), [], 'scope').body).toEqual(placeBaseLocals(around(two), [], 'first-use').body);
  });

  test('a `switch` DEFAULT arm is a list like any other — `mapStmtLists` rebuilds it', () => {
    const sw: Stmt = {
      k: 'switch',
      scrutinee: c(1),
      cases: [{ values: [0], body: [plain()], fallsThrough: false }],
      default: [read('p0', 1)],
      defaultAt: 1,
    };
    const out = placeBaseLocals(around(sw), [], 'scope').body[1];
    expect(out.k === 'switch' && out.default?.map((s) => s.k)).toEqual(['assign', 'store']);
    // the rebuild carries the fields `mapStmtLists` spreads rather than dropping them
    expect(out.k === 'switch' && out.defaultAt).toBe(1);
  });

  test('two nesting levels: the descent continues while each level holds every mention', () => {
    const inner: Stmt = { k: 'while', cond: c(1), body: [read('p0', 1)] };
    const out = placeBaseLocals(around({ k: 'if', cond: c(1), then: [plain(), inner], else: [] }), [], 'scope').body;
    const arm = out[1];
    const loop = arm.k === 'if' ? arm.then[1] : null;
    expect(loop?.k === 'while' && loop.body.map((s) => s.k)).toEqual(['assign', 'store']);
  });
});

describe('the descent into a LOOP body: sound here, and unreachable from every shipped table', () => {
  // The mechanism allows it and `scopeSite`'s header argues why it is safe — a base init is a cast
  // of an `addr`/`const` leaf, so re-running it each iteration re-assigns the same link-time
  // constant and every mention is still dominated. That argument is only half the answer, and this
  // is the other half: no gate table that any caller pairs with `scope` admits a base used inside a
  // loop, so no candidate carries the spelling. `BASECSE_GATES`' `loop` rule rejects it, and
  // `ORDERBASE_GATES` — the one roster table at this placement — inherits that rule
  // (it ablates only `cast-base` and `single-use`).
  const loopUse = (i: number): Stmt => ({
    k: 'store',
    lval: { k: 'index', base: c(0x40000d4), idx: c(i), width: 4, signed: true },
    value: c(0),
  });
  const inLoop: SFn = {
    name: 'f',
    params: [{ name: 'a0', type: T.ptr(T.s(32)) }],
    locals: [],
    retType: T.void(),
    body: [plain(), { k: 'while', cond: c(1), body: [loopUse(0), loopUse(1), loopUse(2)] }],
  };

  test('neither table admits a base whose uses are inside a loop, at any placement', () => {
    expect(admittedBases(inLoop, BASECSE_GATES)).toEqual([]);
    expect(admittedBases(inLoop, ORDERBASE_GATES)).toEqual([]);
    expect(hoistBaseLocals(inLoop, ORDERBASE_GATES, 'scope')).toBeNull();
  });

  test('and where the mechanism IS handed one, the tree it emits still dominates every use', () => {
    // Reached only through `placeBaseLocals` directly, which is where the pinning belongs: the
    // init re-assigns the same constant per iteration, so the read below it is reached.
    const sfn = fn([init('p0', 0x3001100), plain(), { k: 'while', cond: c(1), body: [read('p0', 1)] }]);
    const out = { ...sfn, body: placeBaseLocals(sfn, [], 'scope').body };
    expect(() => assertHoistsDominate(out, new Set(['p0']))).not.toThrow();
  });
});
