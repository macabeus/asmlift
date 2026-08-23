import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { LIVEBASE_BLOCK_GATES, LIVEBASE_GATES, hoistReusedGlobalBases } from '../src/l3/basecse';
import { without } from '../src/l3/gates';
import { volatilePtrLocals } from '../src/l3/volatileptr';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const idx = (name: string, i: Expr, width = 1): Expr => ({
  k: 'index',
  base: { k: 'addr', name },
  idx: i,
  width,
  signed: false,
});
const cidx = (value: number, i: Expr, width = 4): Expr => ({
  k: 'index',
  base: { k: 'const', value },
  idx: i,
  width,
  signed: true,
});
const c = (value: number): Expr => ({ k: 'const', value });
const fn = (body: Stmt[]): SFn => ({ name: 'f', params: [], locals: [], retType: T.void(), body });

describe('reused-global-base hoisting', () => {
  test('a numeric pointer CONSTANT (MMIO/RAM base) indexed at ≥2 distinct offsets is hoisted', () => {
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) },
        { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(0) },
        { k: 'store', lval: cidx(0x40000d4, c(2)), value: c(0) },
      ]),
    );
    expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.s(32)) }]);
    expect(out.body[0]).toEqual({
      k: 'assign',
      name: 'p0',
      value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'const', value: 0x40000d4 } },
    });
    expect(out.body[1]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(0), width: 4, signed: true },
      value: c(0),
    });
  });

  test('a const base at the SAME single constant offset (MMIO read-modify-write) is NOT hoisted', () => {
    // `*(u16 *)0x4000200 |= 2; *(u16 *)0x4000200 &= 0xFFFD` — a scalar RMW the compiler
    // re-materializes; hoisting it mismatches (it broke ProcessHBlankWait). Both accesses at idx 0.
    const body: Stmt[] = [
      { k: 'store', lval: cidx(0x4000200, c(0), 2), value: c(2) },
      { k: 'store', lval: cidx(0x4000200, c(0), 2), value: c(16) },
    ];
    const out = hoistReusedGlobalBases(fn(body));
    expect(out.body).toEqual(body);
    expect(out.locals).toEqual([]);
  });

  test('a global at the SAME variable index at ≥2 sites IS hoisted (not a fixed-offset scalar)', () => {
    const vi: Expr = { k: 'var', name: 'a0' };
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'assign', name: 't', value: idx('gSin', vi) },
        { k: 'assign', name: 'u', value: idx('gSin', vi) },
      ]),
    );
    expect(out.locals.map((l) => l.name)).toEqual(['p0']);
  });

  test('a global indexed at ≥2 sites is hoisted into a typed local pointer', () => {
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: idx('gTable', c(5)), value: c(0) },
        { k: 'store', lval: idx('gTable', c(6)), value: c(0) },
      ]),
    );
    // a `u8 *p0 = (u8 *)&gTable` local is introduced, and both accesses point at it.
    expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.int(8, false)) }]);
    expect(out.body[0]).toEqual({
      k: 'assign',
      name: 'p0',
      value: { k: 'cast', to: T.ptr(T.int(8, false)), e: { k: 'addr', name: 'gTable' } },
    });
    expect(out.body[1]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(5), width: 1, signed: false },
      value: c(0),
    });
    expect(out.body[2]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(6), width: 1, signed: false },
      value: c(0),
    });
  });

  test('a global indexed ONCE is left inline (no hoist)', () => {
    const body: Stmt[] = [{ k: 'store', lval: idx('gTable', c(5)), value: c(0) }];
    const out = hoistReusedGlobalBases(fn(body));
    expect(out.body).toEqual(body);
    expect(out.locals).toEqual([]);
  });

  test('two DIFFERENT globals each indexed twice both hoist, in first-use order', () => {
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: idx('gA', c(0)), value: c(1) },
        { k: 'store', lval: idx('gB', c(0)), value: c(1) },
        { k: 'store', lval: idx('gA', c(4)), value: c(1) },
        { k: 'store', lval: idx('gB', c(4)), value: c(1) },
      ]),
    );
    expect(out.locals.map((l) => l.name)).toEqual(['p0', 'p1']); // gA first, gB second
    expect((out.body[0] as { value: { e: { name: string } } }).value.e.name).toBe('gA');
    expect((out.body[1] as { value: { e: { name: string } } }).value.e.name).toBe('gB');
  });

  test('a base used INSIDE a loop is NOT hoisted (avoids callee-saved push/pop)', () => {
    const body: Stmt[] = [
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '!=', l: idx('gTable', c(0)), r: c(0) },
        body: [{ k: 'store', lval: idx('gTable', c(4)), value: c(0) }],
      },
    ];
    const out = hoistReusedGlobalBases(fn(body));
    expect(out.body).toEqual(body); // unchanged
    expect(out.locals).toEqual([]);
  });

  test('same global at DIFFERENT widths is not merged (distinct pointer types)', () => {
    // gTable read as u8 once and as a u16 once → neither key reaches 2, nothing hoists.
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: idx('gTable', c(0), 1), value: c(0) },
        { k: 'store', lval: idx('gTable', c(0), 2), value: c(0) },
      ]),
    );
    expect(out.locals).toEqual([]);
  });
});

describe('/livebase admission (LIVEBASE_GATES: placement heuristics ablated)', () => {
  // The MMIO poll: three stores plus a busy-wait re-read of the same fixed offset, all through
  // one constant base. `loop` and `repeated-const-offset` both reject it, yet the compiler holds
  // the base in ONE register throughout — the shape the lever exists for.
  const poll = (): SFn =>
    fn([
      { k: 'store', lval: cidx(0x40000d4, c(0)), value: { k: 'var', name: 'a0' } },
      { k: 'store', lval: cidx(0x40000d4, c(1)), value: { k: 'var', name: 'a1' } },
      { k: 'store', lval: cidx(0x40000d4, c(2)), value: { k: 'var', name: 'a2' } },
      { k: 'dowhile', cond: { k: 'bin', op: '!=', l: cidx(0x40000d4, c(2)), r: c(0) }, body: [] },
    ]);

  test('the poll shape: default gates refuse, LIVEBASE_GATES hoists every access onto one local', () => {
    const input = poll();
    expect(hoistReusedGlobalBases(input)).toBe(input);

    const out = hoistReusedGlobalBases(poll(), LIVEBASE_GATES);
    expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.s(32)) }]);
    expect(out.body[0]).toEqual({
      k: 'assign',
      name: 'p0',
      value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'const', value: 0x40000d4 } },
    });
    const dw = out.body[4] as Stmt & { k: 'dowhile' };
    expect((dw.cond as Expr & { k: 'bin' }).l).toEqual({
      k: 'index',
      base: { k: 'var', name: 'p0' },
      idx: c(2),
      width: 4,
      signed: true,
    });
  });

  test('the /livebase/volatile product: the hoisted numeric base qualifies for the volatile lever', () => {
    const out = hoistReusedGlobalBases(poll(), LIVEBASE_GATES);
    const vol = volatilePtrLocals(out);
    expect(vol?.locals.find((l) => l.name === 'p0')?.pointeeVolatile).toBe(true);
  });

  test('single-use survives the ablation: one access is still refused, and by the SAME object', () => {
    const input = fn([{ k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) }]);
    expect(hoistReusedGlobalBases(input, LIVEBASE_GATES)).toBe(input);
  });

  // Mixed admitted+refused bases: the lever re-runs on a tree whose head already holds the
  // default run's init, and pool-load order is FIRST-USE order across both — whichever base the
  // body touches first gets its init first, not whichever pass hoisted it.
  const admitted = (v: string): Stmt[] => [
    { k: 'store', lval: cidx(0x3001000, c(0)), value: { k: 'var', name: v } },
    { k: 'store', lval: cidx(0x3001000, c(1)), value: { k: 'var', name: v } },
  ];
  const refusedLoop: Stmt = {
    k: 'dowhile',
    cond: { k: 'bin', op: '!=', l: cidx(0x40000d4, c(2)), r: c(0) },
    body: [{ k: 'store', lval: cidx(0x40000d4, c(2)), value: c(1) }],
  };
  const initOrder = (body: Stmt[]): (number | undefined)[] => {
    const afterDefault = hoistReusedGlobalBases(fn(body));
    const out = hoistReusedGlobalBases(afterDefault, LIVEBASE_GATES);
    expect(out.locals.map((l) => l.name)).toEqual(['p0', 'p1']);
    return out.body.slice(0, 2).map((s) => {
      const a = s as Stmt & { k: 'assign' };
      return (a.value as Expr & { k: 'cast' }).e.k === 'const'
        ? ((a.value as Expr & { k: 'cast' }).e as Expr & { k: 'const' }).value
        : undefined;
    });
  };

  test('mixed bases, admitted base first-used first: its init stays first', () => {
    expect(initOrder([...admitted('a0'), refusedLoop])).toEqual([0x3001000, 0x40000d4]);
  });

  test('mixed bases, refused base first-used first: the lever init moves ahead of the default one', () => {
    expect(initOrder([refusedLoop, ...admitted('a0')])).toEqual([0x40000d4, 0x3001000]);
  });

  test('a head write to a `volatile` local ends the reorderable run: volatile write order is kept', () => {
    const input: SFn = {
      ...fn([
        { k: 'assign', name: 'v1', value: { k: 'cast', to: T.ptr(T.int(8, false)), e: c(0x111) } },
        { k: 'assign', name: 'v2', value: { k: 'cast', to: T.ptr(T.int(8, false)), e: c(0x222) } },
        { k: 'store', lval: cidx(0x3001000, c(0)), value: { k: 'var', name: 'v2' } },
        { k: 'store', lval: cidx(0x3001000, c(1)), value: { k: 'var', name: 'v1' } },
      ]),
      locals: [
        { name: 'v1', type: T.ptr(T.int(8, false)), volatile: true },
        { name: 'v2', type: T.ptr(T.int(8, false)), volatile: true },
      ],
    };
    const out = hoistReusedGlobalBases(input);
    // the hoist init lands above, and v1/v2 keep their order even though v2 is first-used first
    expect(out.body.slice(0, 3).map((s) => (s as Stmt & { k: 'assign' }).name)).toEqual(['p0', 'v1', 'v2']);
  });

  test('a base the default gates already admitted leaves nothing: the lever declines', () => {
    const hoisted = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) },
        { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(0) },
      ]),
    );
    expect(hoisted.locals).toHaveLength(1);
    expect(hoistReusedGlobalBases(hoisted, LIVEBASE_GATES)).toBe(hoisted);
  });
});

describe('the block admission (WHICH admitted bases get the local)', () => {
  // One MMIO register file indexed at three cells, beside two scalar cells re-read in place — all
  // three bases in the same loop, so the default gates refuse every one and only /livebase's
  // ablation admits them. The source spelled the register file as a pointer and the scalars as
  // bare derefs; the all-or-nothing hoist cannot say that, `single-cell` can.
  const mixed = (): SFn =>
    fn([
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '!=', l: cidx(0x40000d4, c(2)), r: c(0) },
        body: [
          { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(1) },
          { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(2) },
          { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(3) },
          { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(4) },
          { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) },
          { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(0) },
        ],
      },
    ]);
  const boundBases = (s: SFn): number[] =>
    s.body
      .filter((x): x is Stmt & { k: 'assign' } => x.k === 'assign')
      .map((x) => ((x.value as Expr & { k: 'cast' }).e as Expr & { k: 'const' }).value);

  test('the register file binds and the scalar cells stay inline', () => {
    // the register file first: `collect` reads the loop's own CONDITION before its body
    expect(boundBases(hoistReusedGlobalBases(mixed(), LIVEBASE_GATES))).toEqual([0x40000d4, 0x3001048, 0x3002048]);
    expect(boundBases(hoistReusedGlobalBases(mixed(), LIVEBASE_BLOCK_GATES))).toEqual([0x40000d4]);
  });

  test('the unhoisted cells keep the spelling they had', () => {
    const block = hoistReusedGlobalBases(mixed(), LIVEBASE_BLOCK_GATES);
    const loop = block.body[1] as Stmt & { k: 'dowhile' };
    expect((loop.body[0] as Stmt & { k: 'store' }).lval).toEqual(cidx(0x3001048, c(0), 2));
    expect((loop.body[4] as Stmt & { k: 'store' }).lval).toEqual({
      k: 'index',
      base: { k: 'var', name: 'p0' },
      idx: c(0),
      width: 4,
      signed: true,
    });
  });

  test("the axis is one gate: ablating `single-cell` is /livebase's own admission", () => {
    expect(without(LIVEBASE_BLOCK_GATES, 'single-cell').map((g) => g.id)).toEqual(LIVEBASE_GATES.map((g) => g.id));
    expect(boundBases(hoistReusedGlobalBases(mixed(), without(LIVEBASE_BLOCK_GATES, 'single-cell')))).toEqual(
      boundBases(hoistReusedGlobalBases(mixed(), LIVEBASE_GATES)),
    );
  });

  test('a VARIABLE index reaches a block of cells however few constant offsets it also touches', () => {
    const walk = fn([
      { k: 'store', lval: cidx(0x3001048, { k: 'var', name: 'a0' }, 2), value: c(1) },
      { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(2) },
      { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(3) },
      { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(4) },
    ]);
    expect(boundBases(hoistReusedGlobalBases(walk, LIVEBASE_BLOCK_GATES))).toEqual([0x3001048]);
  });

  test('the two DEGENERATE admissions, which rank turns into a decline', () => {
    // all cells: nothing left to hoist, and the pass says so by returning the tree it was given
    const cells = fn([
      { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(1) },
      { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(2) },
      { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(3) },
      { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(4) },
    ]);
    expect(hoistReusedGlobalBases(cells, LIVEBASE_BLOCK_GATES)).toBe(cells);
    // all blocks: the gate rejects nothing, so this IS the /livebase hoist
    const blocks = fn([
      { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(1) },
      { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(2) },
    ]);
    expect(boundBases(hoistReusedGlobalBases(blocks, LIVEBASE_BLOCK_GATES))).toEqual(
      boundBases(hoistReusedGlobalBases(blocks, LIVEBASE_GATES)),
    );
  });

  test('the narrower hoist never changes what an access MEANS: same bases, fewer of them bound', () => {
    const all = boundBases(hoistReusedGlobalBases(mixed(), LIVEBASE_GATES));
    const block = boundBases(hoistReusedGlobalBases(mixed(), LIVEBASE_BLOCK_GATES));
    expect(block.every((b) => all.includes(b))).toBe(true);
    expect(block.length).toBeLessThan(all.length);
  });
});

describe('the block admission is WIRED into enumeration', () => {
  // Two real agbcc outputs, so no toolchain: `corpus/agbcc-mixpoll.s` is synthetic:mixpoll:agbcc —
  // one DMA register file at three offsets beside three IWRAM halfwords read-modified in place,
  // the shape that needs a proper subset of its bases bound — and `corpus/agbcc-onepoll.s` is its
  // control, byte-identical C with the halfwords deleted. Which spelling wins is the benchmark's
  // business; these pin what reaches the differ at all.
  const candsFor = (sym: string) =>
    enumerateCandidates(
      sym,
      readFileSync(join(import.meta.dirname, 'corpus', `agbcc-${sym}.s`), 'utf8'),
      ARMV4T_AGBCC,
      { prototypes: { [sym]: { returnsVoid: true } } },
    );
  const cands = candsFor('mixpoll');

  test('the narrower hoist reaches the candidate list, plain and volatile', () => {
    expect(cands.filter((x) => x.label.startsWith('signed/livebase')).map((x) => x.label)).toEqual([
      'signed/livebase',
      'signed/livebase/volatile',
      'signed/livebase-block',
      'signed/livebase-block/volatile',
    ]);
  });

  test('it binds the register file alone and leaves the scalar cells inline', () => {
    const src = cands.find((x) => x.label === 'signed/livebase-block/volatile')!.source;
    expect(src).toContain('volatile s32 * p0;');
    expect(src).toContain('p0 = (s32 *)67109076;');
    expect(src).toContain('*(u16 *)50335816 = *(u16 *)50335816 + 1;');
    expect(src).not.toContain('50335816;'); // no init binds it
  });

  test('one base and no cell beside it ⇒ it DECLINES rather than repeat /livebase', () => {
    const labels = candsFor('onepoll').map((x) => x.label);
    expect(labels).toContain('signed/livebase/volatile');
    expect(labels.filter((l) => l.includes('livebase-block'))).toEqual([]);
  });
});
