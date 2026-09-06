// The `/unreduce` lever (l3/unreduce.ts): a loop-carried accumulator is deleted and each read
// spelled as its closed form in the counter. What these tests pin is the pair of claims the
// rewrite rests on — that the closed form is RELATED to the counter's own start by the
// accumulator's stride (checked structurally, in all three accepted shapes), and that every way
// the `acc == g(ctr)` invariant could be broken DECLINES rather than approximating. Each gate in
// UNREDUCE_GATES is one accepted fixture with one fact edited.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { type IrType, T } from '../src/ir/types';
import { type Expr, type SFn, type Stmt } from '../src/l3/ast';
import { type Gate, firstRejection, without } from '../src/l3/gates';
import { type AccCtx, UNREDUCE_GATES, type UnreduceResult, unreduceAccumulators } from '../src/l3/unreduce';
import { ARMV4T_AGBCC } from '../src/target';

/** the GBA I/O page, as target.ts declares it */
const GBA: readonly [number, number] = [0x04000000, 0x04000400];

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const cell = (addr: number): Expr => ({
  k: 'index',
  base: c(addr),
  idx: c(0),
  width: 4,
  signed: true,
});
const plus = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '+', l, r });
const shl = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '<<', l, r });
const mul = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '*', l, r });
const set = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const st = (lval: Expr, value: Expr): Stmt => ({ k: 'store', lval, value });

/** synthetic:dmafill's own shape: `acc = (a0 << 6) + a1` stepped by 64 against a counter by 1 */
const fill = (over: Partial<SFn> = {}, body?: Stmt[]): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: T.s(32) },
    { name: 'a1', type: T.s(32) },
  ],
  locals: [
    { name: 'acc', type: T.s(32) },
    { name: 'i', type: T.s(32) },
  ],
  retType: T.void(),
  body: body ?? [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ],
  ...over,
});

const emit = (r: UnreduceResult | null): string => (r === null ? '<declined>' : cBackend.emit(r.sfn));

test('a shift-scaled accumulator becomes the closed form in the counter', () => {
  const out = unreduceAccumulators(fill(), GBA);
  expect(emit(out)).toContain('*(s32 *)67109080 = (i << 6) + a1;');
  // the accumulator, its init and its step are all gone
  expect(emit(out)).not.toContain('acc');
  expect(out!.sfn.locals.map((l) => l.name)).toEqual(['i']);
  // read-only: the input tree is not mutated
  expect(cBackend.emit(fill())).toContain('*(s32 *)67109080 = acc;');
});

test('a PRODUCT-scaled accumulator relates through an invariant multiplier', () => {
  // klonoa's LoadBGTilemapData (a checkout function, not a benchmark row) has this shape in its
  // SOURCE — the stride is an expression rather than a constant, carried in the init as the
  // start's multiplier. The lever does not reach it there (every loop in that function is nested,
  // and this pass walks top-level loops only, instrumented over all 1344 of its trees), so the
  // fixture is the shape and not the row.
  const stride = shl(c(16), v('a1'));
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(mul(stride, v('a0')), c(8))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), stride)), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(emit(unreduceAccumulators(s, GBA))).toContain('*(s32 *)67109080 = (16 << a1) * i + 8;');
});

test('a bare counter relates when the two strides agree', () => {
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(v('a0'), c(8))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(1))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(emit(unreduceAccumulators(s, GBA))).toContain('*(s32 *)67109080 = i + 8;');
});

test('a `for` loop reads its counter out of init and inc', () => {
  const s = fill({}, [
    set('acc', plus(shl(v('a0'), c(6)), v('a1'))),
    {
      k: 'for',
      init: set('i', v('a0')),
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      inc: set('i', plus(v('i'), c(1))),
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64)))],
    },
  ]);
  expect(emit(unreduceAccumulators(s, GBA))).toContain('*(s32 *)67109080 = (i << 6) + a1;');
});

/** synthetic:offgiv's shape: the counter starts at the LITERAL 0, so the compiler folded its
 *  start out of the giv's init and left `acc = a1` — counter-free. `over` edits one fact. */
const folded = (o: { start?: Expr; accStep?: Expr; ctrStep?: Expr; init?: Expr } = {}): SFn =>
  fill({}, [
    set('i', o.start ?? c(0)),
    set('acc', o.init ?? v('a1')),
    {
      k: 'while',
      cond: { k: 'bin', op: '<', l: v('i'), r: v('a0') },
      body: [
        st(cell(0x040000d8), v('acc')),
        set('acc', plus(v('acc'), o.accStep ?? c(64))),
        set('i', plus(v('i'), o.ctrStep ?? c(1))),
      ],
    },
  ]);

/** The context the PASS builds for a tree's accumulator, captured through the `gates` seam. The
 *  five relation gates are keyed on WHICH reason `relate` returned, so a hand-written `declined`
 *  would test the table against itself and a tag that stopped matching its tree would pass: every
 *  ablation below therefore reads its context off the tree it also runs the pass on. The capture
 *  rejects, so nothing is rewritten. */
const ctxFor = (s: SFn): AccCtx => {
  const seen: AccCtx[] = [];
  const capture: Gate<AccCtx> = {
    id: 'capture',
    why: 'test probe: record the context and admit nothing',
    sound: false,
    rejects: (x) => {
      seen.push(x);
      return true;
    },
  };
  unreduceAccumulators(s, GBA, undefined, [capture]);
  if (seen.length !== 1) {
    throw new Error(`expected one accumulator to reach the gates, got ${seen.length}`);
  }
  return seen[0];
};
test('an init the compiler folded the counter’s start out of relates ADDITIVELY', () => {
  // The other of the two ways a compiler's giv relates to its counter. `dmafill` starts at the
  // parameter `lo`, so the init `base + lo * 64` NAMES the start and substitution recovers it.
  // Start at a constant and agbcc folds `base + 0 * 64` to `base` before anything reaches the
  // asm — nothing to substitute, and the closed form is the init PLUS the scaled counter.
  expect(emit(unreduceAccumulators(folded(), GBA))).toContain('*(s32 *)67109080 = a1 + (i << 6);');
  expect(emit(unreduceAccumulators(folded(), GBA))).not.toContain('acc');
});

test('a folded init whose stride is the counter’s own needs no shift', () => {
  expect(emit(unreduceAccumulators(folded({ accStep: c(1) }), GBA))).toContain('*(s32 *)67109080 = a1 + i;');
});

test('a counter-free init declines unless its start is the constant 0', () => {
  // SCOPE, and the reason it is a refusal rather than a widening: the general closed form is
  // `INIT + (ctr - start) * (K / d)`, and a non-zero start spells a bias term no corpus row asks
  // for. This is `nonzero-start`'s own population — the start IS a constant, and it is not 0.
  const tree = folded({ start: c(1) });
  expect(unreduceAccumulators(tree, GBA)).toBeNull();
  expect(ctxFor(tree).declined).toBe('nonzero-start');
  // …and ablating the gate is what makes the guard differential rather than decorative: with
  // `nonzero-start` gone, no other gate catches this row — each of the five owns one tag.
  expect(firstRejection(without(UNREDUCE_GATES, 'nonzero-start'), ctxFor(tree))).toBeNull();
});

test('an init that never names the counter declines', () => {
  // A symbolic start cannot have folded, so an init that does not name it is simply not a function
  // of the counter — and the additive form is unavailable, because re-deriving `ctr - start` would
  // put a new read of the start expression at every use, which none of the five re-evaluation
  // gates asks about. `unrelated-start`'s own population, and no other gate covers it.
  const tree = folded({ start: v('a1'), init: v('a0') });
  expect(unreduceAccumulators(tree, GBA)).toBeNull();
  expect(ctxFor(tree).declined).toBe('unrelated-start');
  expect(firstRejection(without(UNREDUCE_GATES, 'unrelated-start'), ctxFor(tree))).toBeNull();
});

test('a counter-free init declines when the counter does not step by one', () => {
  // the closed form would carry the ratio `K / d`, which is not a shift when `d` is not 1
  const tree = folded({ ctrStep: c(2) });
  expect(unreduceAccumulators(tree, GBA)).toBeNull();
  expect(ctxFor(tree).declined).toBe('step-ratio');
  expect(firstRejection(without(UNREDUCE_GATES, 'step-ratio'), ctxFor(tree))).toBeNull();
});

test('a counter-free init declines when the accumulator’s stride is not a power of two', () => {
  const tree = folded({ accStep: c(48) });
  expect(unreduceAccumulators(tree, GBA)).toBeNull();
  expect(unreduceAccumulators(folded({ accStep: v('a1') }), GBA)).toBeNull();
  expect(ctxFor(tree).declined).toBe('stride-not-shift');
  expect(ctxFor(folded({ accStep: v('a1') })).declined).toBe('stride-not-shift');
  expect(firstRejection(without(UNREDUCE_GATES, 'stride-not-shift'), ctxFor(tree))).toBeNull();
});

test('an ABLATED relation gate declines rather than emitting a deleted local', () => {
  // `gates.ts` prescribes the differential ablation: drop one entry and re-run the pass, the real
  // predicate on real input. Five gates reject a reason `relate` declined for, so with one of them
  // gone the pass reaches a candidate that has NO closed form — while the init statement and the
  // declaration are deleted regardless. Substituting nothing there emits C reading a variable that
  // is no longer declared, silently; the pass refuses instead.
  for (const [id, tree] of [
    ['nonzero-start', folded({ start: c(1) })],
    ['step-ratio', folded({ ctrStep: c(2) })],
    ['stride-not-shift', folded({ accStep: c(48) })],
    ['unrelated-start', folded({ start: v('a1'), init: v('a0') })],
  ] as const) {
    expect(unreduceAccumulators(tree, GBA, undefined, without(UNREDUCE_GATES, id))).toBeNull();
  }
});

test('a folded init that READS MEMORY still answers to the device-write proof gate', () => {
  // The new branch admits a class the substitutional one could not reach — an init that is a bare
  // memory read, which under the old rule had no counter subterm and so never related at all. The
  // proof requirement is not weakened by getting there another way.
  const read = { ...cell(0x03001048) };
  const armed = fill({}, [
    set('i', c(0)),
    set('acc', read),
    {
      k: 'while',
      cond: { k: 'bin', op: '<', l: v('i'), r: v('a0') },
      body: [
        st(cell(0x040000dc), c(0x81000020)),
        st(cell(0x040000d8), v('acc')),
        set('acc', plus(v('acc'), c(64))),
        set('i', plus(v('i'), c(1))),
      ],
    },
  ]);
  const out = unreduceAccumulators(armed, GBA, ARMV4T_AGBCC.capabilities?.deviceMemoryWriters);
  expect(emit(out)).toContain('*(s32 *)50335816 + (i << 6)');
  expect(out!.needsProof).toBe(true);
});

test('a stride that does not match the init’s scale declines', () => {
  // the init scales the counter by 2^6 but the accumulator walks by 32 — no linear relation
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(32))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
  expect(ctxFor(s).declined).toBe('scale-mismatch');
  expect(firstRejection(without(UNREDUCE_GATES, 'scale-mismatch'), ctxFor(s))).toBeNull();
});

test('an init that never names a symbolic counter start declines, in a `while` too', () => {
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', v('a1')),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a third assignment to the accumulator declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift(set('acc', c(0)));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an address-taken accumulator declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift(st(cell(0x040000d4), { k: 'addr', name: 'acc' }));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a pinned accumulator declines, on every pin a local can carry', () => {
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.s(32), volatile: true },
          { name: 'i', type: T.s(32) },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.s(32), frame: { loads: 1, stores: 1 } },
          { name: 'i', type: T.s(32) },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
  // …a POINTER-to-volatile accumulator. Deleting one re-spells `*p = 0` as a raw cast with no
  // qualifier on it: a volatile store silently made plain, which is the one wrongness the differ
  // cannot referee.
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.ptr(T.u(16)), pointeeVolatile: true },
          { name: 'i', type: T.s(32) },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
  // …and an `undef`-homed one, whose declaration says the asm READ the slot before writing it.
  // That fact lives nowhere but the declaration, so deleting the local deletes the recovery.
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.s(32), uninit: true },
          { name: 'i', type: T.s(32) },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
});

test('a volatile counter declines', () => {
  // Substitution puts the counter where every accumulator read stood, so a counter read once per
  // iteration is read once per USE. For a volatile object the access COUNT is the semantics.
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.s(32) },
          { name: 'i', type: T.s(32), volatile: true },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
});

test('an accumulator read after the loop declines', () => {
  const s = fill();
  s.body.push(st(cell(0x040000dc), v('acc')));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a read below the step declines', () => {
  // below its own step the accumulator is one stride ahead of the counter, so the closed form
  // would spell a value one iteration early
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.splice(2, 0, st(cell(0x040000dc), v('acc')));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a counter assigned inside an arm declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift({ k: 'if', cond: c(1), then: [set('i', c(0))], else: [] });
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an address-taken counter declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift(st(cell(0x040000d4), { k: 'addr', name: 'i' }));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a `continue` in the body declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift({ k: 'if', cond: c(1), then: [{ k: 'continue' }], else: [] });
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a call in the init declines', () => {
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), { k: 'call', fn: 'g', args: [] })),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a volatile read in the init declines', () => {
  const volatileRead: Expr = {
    k: 'index',
    base: { k: 'cast', to: T.ptr(T.s(32)), volatile: true, e: c(0x03001048) },
    idx: c(0),
    width: 4,
    signed: true,
  };
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), volatileRead)),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a moved read declines unless the region writes only device cells', () => {
  const read = { ...cell(0x03001048) };
  const loopWith = (write: Expr): SFn =>
    fill({}, [
      set('i', v('a0')),
      set('acc', plus(shl(v('a0'), c(6)), read)),
      {
        k: 'while',
        cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
        body: [st(write, v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
      },
    ]);
  // every write inside the declared device window, the read rooted outside it: admitted
  expect(emit(unreduceAccumulators(loopWith(cell(0x040000d8)), GBA))).toContain('(i << 6) + *(s32 *)50335816');
  // one write to ordinary memory, and the loop could have changed what the read sees
  expect(unreduceAccumulators(loopWith(cell(0x03001100)), GBA)).toBeNull();
  // …and with no declared window there is nothing to place either address in
  expect(unreduceAccumulators(loopWith(cell(0x040000d8)), undefined)).toBeNull();
});

test('a read whose ROOT is outside the window but whose CELL is inside it declines', () => {
  // `((s32 *)0x03FFFFF0)[8]` denotes 0x04000010 — BG0HOFS. Resolving only the chain's root places
  // it in EWRAM and admits it for duplication, which is exactly what the read-side half exists to
  // prevent. The write side always resolved the whole address; now both do, where they can.
  const read: Expr = { k: 'index', base: c(0x03fffff0), idx: c(8), width: 4, signed: true };
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), read)),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an effect the loop evaluates OUTSIDE its body still bars a moved read', () => {
  // The aliasing walk used to scan `loop.body` alone. A `for` evaluates its inc every iteration and
  // its cond before every one, so a call there writes just as much as a call in the body does.
  const read = { ...cell(0x03001048) };
  const withCond = (cond: Expr, inc: Stmt): SFn =>
    fill({ locals: [{ name: 'acc', type: T.s(32) }] }, [
      set('acc', plus(shl(v('a1'), c(6)), read)),
      {
        k: 'for',
        init: set('a0', v('a1')),
        cond,
        inc,
        body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64)))],
      },
    ]);
  const plainCond: Expr = { k: 'bin', op: '<=', l: v('a0'), r: plus(v('a1'), c(3)) };
  const plainInc = set('a0', plus(v('a0'), c(1)));
  // the same loop with no effect outside the body is admitted, so the two below isolate the scan
  expect(emit(unreduceAccumulators(withCond(plainCond, plainInc), GBA))).toContain('(a0 << 6) + *(s32 *)50335816');
  expect(
    unreduceAccumulators(withCond({ k: 'bin', op: '<=', l: { k: 'call', fn: 'g', args: [] }, r: c(3) }, plainInc), GBA),
  ).toBeNull();
  expect(unreduceAccumulators(withCond(plainCond, st(cell(0x03001100), c(1))), GBA)).toBeNull();
});

test('a moved read over a loop that ARMS A TRANSFER is offered only under proof', () => {
  // The gates place every write the C performs. What they cannot place is the write the DEVICE
  // performs in answer to one: storing to DMA3CNT starts a transfer into ordinary memory, so the
  // loop CAN change what the moved read sees. The candidate still exists — its one corpus
  // inhabitant is a byte-exact match — but it carries `needsProof`, and rank.ts publishes such a
  // spelling only at a byte-exact score.
  const read = { ...cell(0x03003430) };
  const loopWriting = (addr: number, width = 4): SFn =>
    fill({}, [
      set('i', v('a0')),
      set('acc', plus(shl(v('a0'), c(6)), read)),
      {
        k: 'while',
        cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
        body: [
          st({ k: 'index', base: c(addr), idx: c(0), width, signed: true }, v('acc')),
          set('acc', plus(v('acc'), c(64))),
          set('i', plus(v('i'), c(1))),
        ],
      },
    ]);
  const DMA_TRIGGERS = ARMV4T_AGBCC.capabilities.deviceMemoryWriters;
  // DMA3DAD stages a transfer and starts nothing — no proof needed
  expect(unreduceAccumulators(loopWriting(0x040000d8), GBA, DMA_TRIGGERS)!.needsProof).toBe(false);
  // the 32-bit DMA3CNT write every GBA DMA macro ends with REACHES the enable halfword at +2
  expect(unreduceAccumulators(loopWriting(0x040000dc), GBA, DMA_TRIGGERS)!.needsProof).toBe(true);
  // …and a HALFWORD write to DMA3CNT_L does not
  expect(unreduceAccumulators(loopWriting(0x040000dc, 2), GBA, DMA_TRIGGERS)!.needsProof).toBe(false);
  // a target that declares no trigger list claims nothing: every device write may be one
  expect(unreduceAccumulators(loopWriting(0x040000d8), GBA, undefined)!.needsProof).toBe(true);
  // and a closed form that reads no memory has nothing to prove whatever the loop arms
  expect(unreduceAccumulators(fill(), GBA, undefined)!.needsProof).toBe(false);

  // ARMED ABOVE THE LOOP is the same transfer. A repeating DMA keeps writing for as long as it is
  // enabled, so where the arming STORE stands says nothing about when the device writes — which is
  // why the trigger scan is the whole prefix and not the motion region.
  const armedAbove = fill({}, [
    // above BOTH anchors, so it is outside the motion region and only the prefix scan can see it
    st({ k: 'index', base: c(0x040000dc), idx: c(0), width: 4, signed: true }, c(0xa2000020)),
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), read)),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(armedAbove, GBA, DMA_TRIGGERS)!.needsProof).toBe(true);
});

test('a closed form that reads no memory needs no window at all', () => {
  expect(emit(unreduceAccumulators(fill(), undefined))).toContain('(i << 6) + a1');
});

test('a nested loop is out of scope — the pass walks TOP-LEVEL loops only', () => {
  // The reason is the SCAN, not the fixture: the init and the counter start here stand above the
  // loop exactly as they do in the accepted case, and the pass still never looks. 91 of the 189
  // loop-bearing corpus trees are in this position (see the file header). A decline here names no
  // gate, which is why the scope is written down rather than inferred from a table that answers
  // for a smaller population than it appears to.
  const s = fill();
  const inner = s.body[2];
  expect(
    unreduceAccumulators(fill({}, [s.body[0], s.body[1], { k: 'while', cond: c(1), body: [inner] }]), GBA),
  ).toBeNull();
});

test('an init reading a name the region assigns declines, in every part of it', () => {
  // `w` is loop-carried, so evaluating the init inside the loop reads a different value
  const s = fill(
    {
      locals: [
        { name: 'acc', type: T.s(32) },
        { name: 'i', type: T.s(32) },
        { name: 'w', type: T.s(32) },
      ],
    },
    [
      set('i', v('a0')),
      set('w', c(0)),
      set('acc', plus(shl(v('a0'), c(6)), v('w'))),
      {
        k: 'while',
        cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
        body: [
          st(cell(0x040000d8), v('acc')),
          set('w', plus(v('w'), c(1))),
          set('acc', plus(v('acc'), c(64))),
          set('i', plus(v('i'), c(1))),
        ],
      },
    ],
  );
  expect(unreduceAccumulators(s, GBA)).toBeNull();

  // …AND THE `for` CASE, which asking `loop.body` alone could not see: a `for`'s counter is
  // stepped in `loop.inc`, so the ONE name this gate exists to catch was invisible on exactly the
  // loop kind whose stepper lives outside the body. Here `a0` is both the counter AND a name the
  // init reads; the closed form `(a0 << 6) + a0` re-reads it after it has moved, and diverges from
  // the first iteration on. Executed both ways at four input vectors, all four diverge.
  const forCtr = fill({ locals: [{ name: 'acc', type: T.s(32) }] }, [
    set('acc', plus(shl(v('a1'), c(6)), v('a0'))),
    {
      k: 'for',
      init: set('a0', v('a1')),
      cond: { k: 'bin', op: '<=', l: v('a0'), r: plus(v('a1'), c(3)) },
      inc: set('a0', plus(v('a0'), c(1))),
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64)))],
    },
  ]);
  expect(unreduceAccumulators(forCtr, GBA)).toBeNull();

  // …AND THE PRE-LOOP GAP, which is the rest of the distance the init travels. The region opens
  // at whichever of the two anchors comes FIRST, so all three of these are inside it: a write
  // between the init and the loop, a write between the two anchors when the counter's start is
  // taken LAST, and a store to memory the init read. Each diverges on every input vector.
  const gap = (between: Stmt[], head?: Stmt[]): SFn =>
    fill({}, [
      ...(head ?? [set('i', v('a0')), set('acc', plus(shl(v('a0'), c(6)), v('a1')))]),
      ...between,
      {
        k: 'while',
        cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
        body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
      },
    ]);
  // the accepted shape, to show the region is not a blanket bar
  expect(emit(unreduceAccumulators(gap([]), GBA))).toContain('(i << 6) + a1');
  // a free name of the init, rewritten below it
  expect(unreduceAccumulators(gap([set('a1', plus(v('a1'), c(100)))]), GBA)).toBeNull();
  // the counter's start taken AFTER the init, off a value that has since moved
  expect(
    unreduceAccumulators(
      gap([], [set('acc', plus(shl(v('a0'), c(6)), v('a1'))), set('a0', plus(v('a0'), c(1))), set('i', v('a0'))]),
      GBA,
    ),
  ).toBeNull();
  // …and the memory half of the same question
  expect(
    unreduceAccumulators(
      gap([st(cell(0x02000000), c(777))], [set('i', v('a0')), set('acc', plus(shl(v('a0'), c(6)), cell(0x02000000)))]),
      GBA,
    ),
  ).toBeNull();
});

test('an init reading an address-escaped local declines', () => {
  // `init-loop-var`'s other half. Nothing here ASSIGNS `w` — the loop hands its address to a
  // callee, so the write is one no C-level assignment spells and `assignCount` cannot see. The
  // closed form re-reads `w` once per iteration and picks up whatever the callee left.
  const s = fill(
    {
      locals: [
        { name: 'acc', type: T.s(32) },
        { name: 'i', type: T.s(32) },
        { name: 'w', type: T.s(32) },
      ],
    },
    [
      // above BOTH anchors, so the motion region does not contain it and `init-loop-var` — which
      // reads assignment — has nothing to say. The escape is the only fact left.
      set('w', c(1)),
      set('i', v('a0')),
      set('acc', plus(shl(v('a0'), c(6)), v('w'))),
      {
        k: 'while',
        cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
        body: [
          { k: 'exprstmt', value: { k: 'call', fn: 'bump', args: [{ k: 'addr', name: 'w' }] } },
          st(cell(0x040000d8), v('acc')),
          set('acc', plus(v('acc'), c(64))),
          set('i', plus(v('i'), c(1))),
        ],
      },
    ],
  );
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a scale between the counter and the sum must carry the WHOLE stride', () => {
  // `(a0 << 6) + a1` walked by 1: the counter's own stride through that shift is 64, so no
  // substitution relates the two. A rule that fell back to the bare counter here would spell a
  // closed form 64× too fast — and would compile, and would score.
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(1))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an enclosing operator that is not a sum declines', () => {
  // `8 - a0` walks by -1 per step of the counter, not +1: only a `+` spine preserves the stride
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', { k: 'bin', op: '-', l: c(8), r: v('a0') }),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(1))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a call inside the counter start declines — the init statement is deleted, not moved', () => {
  const call: Expr = { k: 'call', fn: 'g', args: [] };
  const s = fill({}, [
    set('i', call),
    set('acc', plus(shl(call, c(6)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

// ── stride-units ────────────────────────────────────────────────────────────────────────────

/** `fill`'s shape with a POINTER accumulator: `p = INIT; … p = p + 32`, which on a `u16 *`
 *  advances 64 BYTES per iteration. `init` and the accumulator's declared type are the two facts
 *  this family edits. */
const ptrWalk = (accType: IrType, init: Expr, body?: Stmt[]): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: T.s(32) },
    { name: 'a1', type: T.s(32) },
  ],
  locals: [
    { name: 'p', type: accType },
    { name: 'i', type: T.s(32) },
  ],
  retType: T.void(),
  body: body ?? [
    set('i', c(0)),
    set('p', init),
    {
      k: 'while',
      cond: { k: 'bin', op: '<', l: v('i'), r: v('a0') },
      body: [st(cell(0x040000d4), v('p')), set('p', plus(v('p'), c(32))), set('i', plus(v('i'), c(1)))],
    },
  ],
});

test('an accumulator whose step counts different units than its init declines', () => {
  // (a) THE FOLDED PATH. `p` is a `u16 *`, so `p + 32` is 64 bytes; the init is an INTEGER
  // expression, so `init + (i << 5)` is 32. Found on klonoa's UpdateHUDTimePanel under a symbol
  // map, where the same asm lifts with a `u16 *` accumulator and the candidate walked half the
  // intended stride — clean-compiling, marker-free, and addressing the wrong halfword.
  const intInit = plus({ k: 'cast', to: T.u(32), e: { k: 'addr', name: 'gBuf' } }, c(1444));
  expect(unreduceAccumulators(ptrWalk(T.ptr(T.u(16)), intInit), GBA)).toBeNull();
  // and it is the GATE that refuses, not the relation: ablated, the wrong stride ships
  expect(
    emit(
      unreduceAccumulators(ptrWalk(T.ptr(T.u(16)), intInit), GBA, undefined, without(UNREDUCE_GATES, 'stride-units')),
    ),
  ).toContain('+ (i << 5)');
  // (b) THE SUBSTITUTIONAL PATH, which has the same hazard and predates the folded branch: the
  // init names the counter's start under the accumulator's own numeric stride, and `rec` rebuilds
  // it in the INIT's units rather than the accumulator's.
  const subst = ptrWalk(T.ptr(T.u(16)), plus(shl(v('a0'), c(5)), v('a1')), [
    set('i', v('a0')),
    set('p', plus(shl(v('a0'), c(5)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d4), v('p')), set('p', plus(v('p'), c(32))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(subst, GBA)).toBeNull();
  expect(emit(unreduceAccumulators(subst, GBA, undefined, without(UNREDUCE_GATES, 'stride-units')))).toContain(
    '(i << 5) + a1',
  );
  // (c) A NARROW INTEGER accumulator is the same question in the other direction: `u16 acc`
  // stepped by 64 WRAPS at 65536 and the closed form does not, so the two agree for 1024
  // iterations and then do not.
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.u(16) },
          { name: 'i', type: T.s(32) },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
  // (d) …and a pointee with no size this file can name — `void *`, a struct — is unknown, not one.
  expect(unreduceAccumulators(ptrWalk(T.ptr(T.void()), intInit), GBA)).toBeNull();
});

test('an accumulator and an init in the SAME units still relate', () => {
  // The gate is a units check and not a pointer ban: `p` and the init are both `u16 *`, so the
  // closed form's `+` scales by 2 exactly as `p + 32` does.
  const ptrInit: Expr = { k: 'cast', to: T.ptr(T.u(16)), e: c(0x03000900) };
  expect(emit(unreduceAccumulators(ptrWalk(T.ptr(T.u(16)), ptrInit), GBA))).toContain('(u16 *)50333952 + (i << 5)');
});

test('a stride the frontend spelled as a constant expression still relates', () => {
  // 256 does not fit Thumb's `add rd, #imm8`, so agbcc emits `mov #128 / lsl #1` and the recovered
  // step is the NODE `128 << 1`. Every stated scope condition holds — start 0, counter steps by 1,
  // the stride is a constant power of two — so refusing on the spelling refuses the class's own
  // member. synthetic:offgiv3 is the row.
  expect(emit(unreduceAccumulators(folded({ accStep: shl(c(128), c(1)) }), GBA))).toContain(
    '*(s32 *)67109080 = a1 + (i << 8);',
  );
  // …and the same for the other two ways a constant stride is spelled arithmetically
  expect(emit(unreduceAccumulators(folded({ accStep: mul(c(8), c(8)) }), GBA))).toContain('a1 + (i << 6);');
  expect(emit(unreduceAccumulators(folded({ accStep: plus(c(60), c(4)) }), GBA))).toContain('a1 + (i << 6);');
  // a folded stride that is still not a power of two is still refused
  expect(unreduceAccumulators(folded({ accStep: plus(c(40), c(8)) }), GBA)).toBeNull();
});

test('a zero init leaves the scaled counter standing alone', () => {
  // `0 + (i << 6)` is a spelling no source writes. Reached on synthetic:nestedloop:mwcc_242_81,
  // whose accumulator starts at 0 — a PPC row, in a lever whose gate census is agbcc-shaped.
  expect(emit(unreduceAccumulators(folded({ init: c(0) }), GBA))).toContain('*(s32 *)67109080 = i << 6;');
  expect(emit(unreduceAccumulators(folded({ init: c(0) }), GBA))).not.toContain('0 +');
});
