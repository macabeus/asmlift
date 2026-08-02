// Control-flow short-circuit recovery (raise/shortcircuit.ts `recognizeBranchShortCircuit`):
// `if (a || b) X else Y` reaches the IR as two `cond_br` blocks sharing a target, and without this
// fold the structurer tail-duplicates the shared block into both arms.
//
// The four orientation cases are the whole truth table (which of the head's edges leads to the
// second condition × which of the second's edges rejoins the head's other successor), so each gets
// a test. The refusals get one each too: every one of them is a way the fold would be WRONG, not a
// missed opportunity, and a silently-relaxed guard is exactly what these pin down.
import { describe, expect, test } from 'vitest';

import { type Block, type Fn, type Op, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { recognizeBranchShortCircuit } from '../src/raise/shortcircuit';

const blk = (ops: Op[], params: Value[] = []): Block => ({ params, ops });

/** `k = <n>; out = k <cmp> k` — a self-contained comparison whose operands are really defined, so
 *  `verify` on the folded result is a real check and not vacuously satisfied. */
function cmp(out: Value, opcode: 'icmp_eq' | 'icmp_ne' = 'icmp_ne'): Op[] {
  const a = mkValue(T.unk(32));
  const b = mkValue(T.unk(32));
  return [
    mkOp('const', { results: [a], attrs: { value: 6 } }),
    mkOp('const', { results: [b], attrs: { value: 1 } }),
    mkOp(opcode, { operands: [a, b], results: [out] }),
  ];
}

/** A head `cond_br(c1)` + second-condition block `cond_br(c2)` sharing one target.
 *
 *  `gOnTaken` puts the second block on the head's TAKEN edge (the `&&` orientation); otherwise it
 *  is the fall edge (`||`). `sharedOnGTaken` puts the shared block on the second block's taken
 *  edge, which decides whether its condition needs negating. */
function chain(opts: {
  gOnTaken: boolean;
  sharedOnGTaken: boolean;
  gBody?: (out: Value) => Op[];
  gParams?: Value[];
  sharedArgsFromH?: Value[];
  sharedArgsFromG?: Value[];
  sharedParams?: Value[];
  extraPredOfG?: boolean;
}): Fn {
  const shared = blk([mkOp('ret', { operands: [] })], opts.sharedParams ?? []);
  const other = blk([mkOp('ret', { operands: [] })]);
  const c2 = mkValue(T.unk(32));
  const gBody = opts.gBody ? opts.gBody(c2) : cmp(c2);
  const g = blk(
    [
      ...gBody,
      {
        ...mkOp('cond_br', { operands: [c2] }),
        successors: opts.sharedOnGTaken
          ? [
              { block: shared, args: opts.sharedArgsFromG ?? [] },
              { block: other, args: [] },
            ]
          : [
              { block: other, args: [] },
              { block: shared, args: opts.sharedArgsFromG ?? [] },
            ],
      },
    ],
    opts.gParams ?? [],
  );
  const c1 = mkValue(T.unk(32));
  const hEdgeShared = { block: shared, args: opts.sharedArgsFromH ?? [] };
  const head = blk([
    ...(opts.sharedArgsFromH ?? []).map((v) => mkOp('const', { results: [v], attrs: { value: 7 } })),
    ...(opts.sharedArgsFromG ?? [])
      .filter((v) => !(opts.sharedArgsFromH ?? []).includes(v))
      .map((v) => mkOp('const', { results: [v], attrs: { value: 8 } })),
    ...cmp(c1, 'icmp_eq'),
    {
      ...mkOp('cond_br', { operands: [c1] }),
      successors: opts.gOnTaken ? [{ block: g, args: [] }, hEdgeShared] : [hEdgeShared, { block: g, args: [] }],
    },
  ]);
  const blocks = [head, g, shared, other];
  if (opts.extraPredOfG) {
    // a second, unrelated entry into `g` — the fold would delete a block still reachable
    blocks.splice(1, 0, blk([{ ...mkOp('br'), successors: [{ block: g, args: [] }] }]));
  }
  return { name: 'f', blocks };
}

/** The connective a fold produced, or null when nothing fired. */
const connective = (fn: Fn): string | null =>
  fn.blocks.flatMap((b) => b.ops).find((o) => o.opcode === 'logic_or' || o.opcode === 'logic_and')?.opcode ?? null;

describe('the four orientations', () => {
  test('second block on the FALL edge, shared on its TAKEN → `c1 || c2`, no negation', () => {
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true });
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(connective(fn)).toBe('logic_or');
    expect(fn.blocks).toHaveLength(3); // the second-condition block is gone
    // no negation was needed: the original icmp_ne is still the connective's right operand, so the
    // head holds exactly the two comparisons that were already there
    const ops = fn.blocks[0].ops.map((o) => o.opcode);
    expect(ops.filter((o) => o === 'icmp_ne')).toHaveLength(1);
    expect(ops.filter((o) => o === 'icmp_eq')).toHaveLength(1);
    verify(fn);
  });

  test('second block on the FALL edge, shared on its FALL → `c1 || !c2`', () => {
    const fn = chain({ gOnTaken: false, sharedOnGTaken: false });
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(connective(fn)).toBe('logic_or');
    // the second condition is NEGATED (icmp_ne → icmp_eq) so it points at the shared block
    const ops = fn.blocks[0].ops.map((o) => o.opcode);
    expect(ops.filter((o) => o === 'icmp_eq')).toHaveLength(2);
    verify(fn);
  });

  test('second block on the TAKEN edge, other on its TAKEN → `c1 && c2`', () => {
    const fn = chain({ gOnTaken: true, sharedOnGTaken: false });
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(connective(fn)).toBe('logic_and');
    const ops = fn.blocks[0].ops.map((o) => o.opcode);
    expect(ops.filter((o) => o === 'icmp_ne')).toHaveLength(1);
    expect(ops.filter((o) => o === 'icmp_eq')).toHaveLength(1);
    verify(fn);
  });

  test('second block on the TAKEN edge, other on its FALL → `c1 && !c2`', () => {
    const fn = chain({ gOnTaken: true, sharedOnGTaken: true });
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(connective(fn)).toBe('logic_and');
    const ops = fn.blocks[0].ops.map((o) => o.opcode);
    expect(ops.filter((o) => o === 'icmp_eq')).toHaveLength(2);
    verify(fn);
  });

  test('the surviving cond_br keeps the head’s unchanged successor slot', () => {
    // `||`: the head branched TAKEN to the shared block and still does, so the branch sense the
    // frontend read out of the asm survives the fold.
    const or = chain({ gOnTaken: false, sharedOnGTaken: true });
    const sharedBefore = or.blocks[0].ops.at(-1)!.successors[0].block;
    recognizeBranchShortCircuit(or);
    expect(or.blocks[0].ops.at(-1)!.successors[0].block).toBe(sharedBefore);
    // `&&`: the head branched TAKEN to the second condition, whose decision selects the OTHER
    // block — so `other` takes that slot.
    const and = chain({ gOnTaken: true, sharedOnGTaken: false });
    const otherBefore = and.blocks[1].ops.at(-1)!.successors[0].block;
    recognizeBranchShortCircuit(and);
    expect(and.blocks[0].ops.at(-1)!.successors[0].block).toBe(otherBefore);
  });
});

describe('refusals', () => {
  test('a second predecessor of the condition block: folding would delete a live block', () => {
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true, extraPredOfG: true });
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
    expect(connective(fn)).toBeNull();
  });

  test('block params on the condition block: the head’s edge binds them', () => {
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true, gParams: [mkValue(T.unk(32))] });
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });

  test('a SIDE EFFECT in the second condition would run unconditionally', () => {
    // `a || (*p = 1)`: the store moves into the head, which always executes.
    const fn = chain({
      gOnTaken: false,
      sharedOnGTaken: true,
      gBody: (out) => [
        mkOp('store', { operands: [mkValue(T.ptr(T.u(8))), mkValue(T.unk(32))], attrs: { off: 0, width: 1 } }),
        mkOp('icmp_ne', { operands: [mkValue(T.unk(32)), mkValue(T.unk(32))], results: [out] }),
      ],
    });
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });

  test('a value defined in the condition block that ESCAPES it is not folded', () => {
    // The structurer would materialize it into a local, rendering the second condition's work as a
    // statement BEFORE the `if` — unconditionally.
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true });
    const escaping = fn.blocks[1].ops[1].results[0]; // the second condition value itself
    fn.blocks[3].ops.unshift(mkOp('neg', { operands: [escaping], results: [mkValue(T.unk(32))] }));
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });

  test('a value defined in the condition block used TWICE is not folded', () => {
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true });
    const local = fn.blocks[1].ops[1].results[0];
    fn.blocks[1].ops.splice(2, 0, mkOp('neg', { operands: [local], results: [mkValue(T.unk(32))] }));
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });

  test('DIFFERENT args on the two edges into the shared block: only one edge survives', () => {
    const p = mkValue(T.unk(32));
    const fromH = mkValue(T.unk(32));
    const fromG = mkValue(T.unk(32));
    const fn = chain({
      gOnTaken: false,
      sharedOnGTaken: true,
      sharedParams: [p],
      sharedArgsFromH: [fromH],
      sharedArgsFromG: [fromG],
    });
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });

  test('IDENTICAL args on the two edges into the shared block DO fold', () => {
    const p = mkValue(T.unk(32));
    const same = mkValue(T.unk(32));
    const fn = chain({
      gOnTaken: false,
      sharedOnGTaken: true,
      sharedParams: [p],
      sharedArgsFromH: [same],
      sharedArgsFromG: [same],
    });
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(fn.blocks[0].ops.at(-1)!.successors[0].args).toEqual([same]);
  });

  test('a non-negatable second condition is refused when the orientation needs negating', () => {
    // `and`/`or`/arith are not in NEGATE_ICMP: there is no sound one-op inverse to build.
    const fn = chain({
      gOnTaken: false,
      sharedOnGTaken: false, // needs the negation
      gBody: (out) => [mkOp('and', { operands: [mkValue(T.unk(32)), mkValue(T.unk(32))], results: [out] })],
    });
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });

  test('a degenerate second condition (both edges to one block) is refused', () => {
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true });
    const g = fn.blocks[1];
    g.ops.at(-1)!.successors[1] = { block: g.ops.at(-1)!.successors[0].block, args: [] };
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });

  test('a second block that does NOT rejoin the head’s other successor is refused', () => {
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true });
    const stray = blk([mkOp('ret', { operands: [] })]);
    fn.blocks.push(stray);
    fn.blocks[1].ops.at(-1)!.successors[0] = { block: stray, args: [] };
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });
});

describe('chains', () => {
  test('`a || b || c` folds one condition per round, left to right', () => {
    // head → g1 → g2, all three rejoining one shared block.
    const shared = blk([mkOp('ret', { operands: [] })]);
    const other = blk([mkOp('ret', { operands: [] })]);
    const mk = (): { b: Block; c: Value } => {
      const c = mkValue(T.unk(32));
      return { c, b: blk(cmp(c)) };
    };
    const g2 = mk();
    g2.b.ops.push({
      ...mkOp('cond_br', { operands: [g2.c] }),
      successors: [
        { block: shared, args: [] },
        { block: other, args: [] },
      ],
    });
    const g1 = mk();
    g1.b.ops.push({
      ...mkOp('cond_br', { operands: [g1.c] }),
      successors: [
        { block: shared, args: [] },
        { block: g2.b, args: [] },
      ],
    });
    const h = mk();
    h.b.ops.push({
      ...mkOp('cond_br', { operands: [h.c] }),
      successors: [
        { block: shared, args: [] },
        { block: g1.b, args: [] },
      ],
    });
    const fn: Fn = { name: 'f', blocks: [h.b, g1.b, g2.b, shared, other] };
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(fn.blocks).toHaveLength(3); // both condition blocks consumed
    expect(fn.blocks[0].ops.filter((o) => o.opcode === 'logic_or')).toHaveLength(2);
    verify(fn);
  });
});
