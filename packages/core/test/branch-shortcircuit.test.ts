// Control-flow short-circuit recovery (raise/shortcircuit.ts `recognizeBranchShortCircuit`):
// `if (a || b) X else Y` reaches the IR as two `cond_br` blocks sharing a target, and without this
// fold the structurer tail-duplicates the shared block into both arms.
//
// The four orientation cases are the whole truth table (which of the head's edges leads to the
// second condition × which of the second's edges rejoins the head's other successor), so each gets
// a test. The refusals get one each too: every one of them is a way the fold would be WRONG, not a
// missed opportunity, and a silently-relaxed guard is exactly what these pin down.
import { describe, expect, test } from 'vitest';

import {
  type Block,
  type Fn,
  type Op,
  type Value,
  forwardingTarget as forwardingTargetOf,
  mkOp,
  mkValue,
} from '../src/ir/core';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { recognizeBranchShortCircuit, recognizeShortCircuit } from '../src/raise/shortcircuit';

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
  /** Put each edge into `shared` behind its OWN chain of single-`br` blocks, the shape agbcc leaves
   *  when a Thumb conditional cannot reach its target and the real branch is emitted separately.
   *  `true` is one relay per edge; a number builds a chain that deep. */
  trampolines?: boolean | number;
}): Fn {
  // `shared` RETURNS a value the head defines. That is what makes a half-dropped relay chain
  // observable: an unreachable block still branching here collapses this block's dominator set, and
  // the use below is what `verify` then rejects. With a bare `ret` the damage is invisible.
  const fromHead = mkValue(T.unk(32));
  const shared = blk([mkOp('ret', { operands: [fromHead] })], opts.sharedParams ?? []);
  const trampolines: Block[] = [];
  /** the edge to write into a terminator: straight to `shared`, or through a fresh forwarder */
  const toShared = (args: Value[]): { block: Block; args: Value[] } => {
    if (!opts.trampolines) {
      return { block: shared, args };
    }
    const depth = opts.trampolines === true ? 1 : opts.trampolines;
    let head = { block: shared, args };
    for (let i = 0; i < depth; i++) {
      const t = blk([{ ...mkOp('br'), successors: [head] }]);
      trampolines.push(t);
      head = { block: t, args: [] };
    }
    return head;
  };
  const other = blk([mkOp('ret', { operands: [] })]);
  const c2 = mkValue(T.unk(32));
  const gBody = opts.gBody ? opts.gBody(c2) : cmp(c2);
  const g = blk(
    [
      ...gBody,
      {
        ...mkOp('cond_br', { operands: [c2] }),
        successors: opts.sharedOnGTaken
          ? [toShared(opts.sharedArgsFromG ?? []), { block: other, args: [] }]
          : [{ block: other, args: [] }, toShared(opts.sharedArgsFromG ?? [])],
      },
    ],
    opts.gParams ?? [],
  );
  const c1 = mkValue(T.unk(32));
  const hEdgeShared = toShared(opts.sharedArgsFromH ?? []);
  const head = blk([
    mkOp('const', { results: [fromHead], attrs: { value: 9 } }),
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
  const blocks = [head, g, ...trampolines, shared, other];
  if (opts.extraPredOfG) {
    // a second, unrelated entry into `g` — the fold would delete a block still reachable
    blocks.splice(1, 0, blk([{ ...mkOp('br'), successors: [{ block: g, args: [] }] }]));
  }
  return { name: 'f', blocks };
}

/** The connective a fold produced, or null when nothing fired. */
const connective = (fn: Fn): string | null =>
  fn.blocks.flatMap((b) => b.ops).find((o) => o.opcode === 'logic_or' || o.opcode === 'logic_and')?.opcode ?? null;

describe('a shared block behind long-branch trampolines', () => {
  // A Thumb conditional branch reaches ±256 bytes. Past that agbcc inverts it and emits the real
  // target as a separate `b`, so two sites reaching one block arrive as two DISTINCT forwarding
  // blocks and the fold's successor-identity test sees two unrelated targets. `forwardingTarget`
  // answers "same destination?" by RESOLVING rather than rewriting: normalising the blocks away
  // instead costs pokeemerald:SetMauvilleOldManLanguage:agbcc its output, and merging identical
  // ones costs synthetic:sw_op:agbcc its match.
  test('the fold looks through them and still picks the right connective', () => {
    const fn = chain({ gOnTaken: true, sharedOnGTaken: false, trampolines: true });
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(connective(fn)).toBe('logic_and');
    verify(fn);
  });

  test('both orientations survive the indirection', () => {
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true, trampolines: true });
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(connective(fn)).toBe('logic_or');
    verify(fn);
  });

  test('the forwarder the fold stops using is dropped, not left dangling', () => {
    // An unreachable block that still branches somewhere poisons the dominance of everything it
    // points at, so leaving it behind turns this fold into a verify failure two passes later.
    const fn = chain({ gOnTaken: true, sharedOnGTaken: false, trampolines: true });
    expect(fn.blocks).toHaveLength(6); // head, g, 2 forwarders, shared, other
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    expect(fn.blocks).toHaveLength(4); // g and the head's forwarder are both gone
    const reachable = new Set<Block>([fn.blocks[0]]);
    for (const b of fn.blocks) {
      for (const succ of b.ops[b.ops.length - 1].successors ?? []) {
        reachable.add(succ.block);
      }
    }
    expect(fn.blocks.filter((b) => !reachable.has(b))).toHaveLength(0);
    verify(fn);
  });

  test('a CHAIN of relays is dropped to the end, not one link', () => {
    // Stopping after the first link leaves the second unreachable and still branching into the
    // shared block, which is the same dominance failure the drop exists to prevent, one hop out.
    const fn = chain({ gOnTaken: true, sharedOnGTaken: false, trampolines: 3 });
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
    const reachable = new Set<Block>([fn.blocks[0]]);
    for (const b of fn.blocks) {
      for (const succ of b.ops[b.ops.length - 1].successors ?? []) {
        reachable.add(succ.block);
      }
    }
    expect(fn.blocks.filter((b) => !reachable.has(b))).toHaveLength(0);
    verify(fn);
  });

  test('REFUSED: a relay onto a comparison TREE — the fold would disqualify switch recovery', () => {
    // agbcc puts a relay on a tree's default edge, so resolving one walks this fold into a dispatch
    // chain. Rewriting a test's `cond_br` operand to a connective permanently disqualifies
    // switch-recover.ts (its `isCmpOpcode` gate), so a scrutinee compared against constants more
    // than once is left alone — here ^h's split node is RELATIONAL and ^g's leaf is an equality,
    // which the pairwise test used on a direct edge would not catch.
    const fn = relayedComparisonTree();
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
    expect(connective(fn)).toBeNull();
    verify(fn);
  });

  test('REFUSED: both of the second block’s edges rejoin the shared block', () => {
    // No "other" arm is left, so nothing decides which side the connective guards. Only resolution
    // can produce it — an edge that lands on the shared block directly is preferred — so BOTH of
    // ^g's edges have to be relayed for this to be reached at all.
    const fn = chain({ gOnTaken: true, sharedOnGTaken: false, trampolines: true });
    const shared = fn.blocks.find((b) => b.ops[0].opcode === 'ret')!;
    const g = fn.blocks[1];
    const gt = g.ops[g.ops.length - 1];
    const extraRelay = blk([{ ...mkOp('br'), successors: [{ block: shared, args: [] }] }]);
    fn.blocks.splice(fn.blocks.indexOf(shared), 0, extraRelay);
    gt.successors = gt.successors.map((sc) =>
      forwardingTargetOf(sc.block) === shared ? sc : { block: extraRelay, args: [] },
    );
    expect(gt.successors.every((sc) => forwardingTargetOf(sc.block) === shared)).toBe(true);
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
    expect(connective(fn)).toBeNull();
    verify(fn);
  });

  test('REFUSED: a forwarder carrying block arguments is not followed', () => {
    // Two relays into one block are interchangeable only when neither supplies a value. These carry
    // DIFFERENT ones, so treating them as one destination would keep the surviving edge's value and
    // silently drop the other — the two `const 7`/`const 8` the head defines are what tells them
    // apart. `sameArgs` cannot catch it: the args sit on the relays' own branches, and the edges
    // this fold compares are the empty ones INTO the relays.
    const fn = chain({
      gOnTaken: true,
      sharedOnGTaken: false,
      trampolines: true,
      sharedParams: [mkValue(T.unk(32))],
      sharedArgsFromH: [mkValue(T.unk(32))],
      sharedArgsFromG: [mkValue(T.unk(32))],
    });
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
    expect(connective(fn)).toBeNull();
    verify(fn);
  });
});

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

describe('the refusals found by the adversarial round', () => {
  test('the ENTRY block is never folded away — `predecessors()` cannot see the entry edge', () => {
    // The shape from the reproduced MIPS miscompile: the entry block is ALSO the loop header, so
    // its only REAL predecessor is the latch and it passes the sole-predecessor test — while the
    // soundness argument fails, because on the first iteration it runs BEFORE the head. Folding
    // hoists its guard past the body and moves `fn.blocks[0]` elsewhere, turning an entry-guarded
    // `while` into a `do…while` whose body runs once unconditionally. No contract catches it.
    //
    // Built so the ONLY candidate fold is `g === entry`: the body ends in `br` (never a second
    // condition) and the exit is a `ret`, so the latch is the sole possible head.
    const exit = blk([mkOp('ret', { operands: [] })]);
    const guard = mkValue(T.unk(32));
    const entry = blk(cmp(guard));
    const body = blk([
      mkOp('store', { operands: [mkValue(T.ptr(T.u(8))), mkValue(T.unk(32))], attrs: { off: 0, width: 1 } }),
    ]);
    const back = mkValue(T.unk(32));
    const latch = blk(cmp(back));
    entry.ops.push({
      ...mkOp('cond_br', { operands: [guard] }),
      successors: [
        { block: exit, args: [] },
        { block: body, args: [] },
      ],
    });
    body.ops.push({ ...mkOp('br'), successors: [{ block: latch, args: [] }] });
    latch.ops.push({
      ...mkOp('cond_br', { operands: [back] }),
      successors: [
        { block: exit, args: [] },
        { block: entry, args: [] },
      ],
    });
    const fn: Fn = { name: 'f', blocks: [entry, body, latch, exit] };
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
    expect(fn.blocks[0]).toBe(entry);
  });

  test('a comparison TREE over one scrutinee is left for switch recovery', () => {
    // `switch (x) { case 1: case 2: … }` compiles to exactly this fold's input shape. Taking it
    // would replace the `cond_br`'s icmp with a `logic_or`, which switch-recover.ts's isCmpOpcode
    // gate rejects — permanently degrading a clean `switch` into nested ifs.
    expect(recognizeBranchShortCircuit(comparisonTree())).toBe(false);
  });

  test('a RELATIONAL pair on one value still folds — a range check is a real connective', () => {
    // The switch gate keys on EQUALITY tests: `x >= lo && x <= hi` shares a scrutinee but is not a
    // dispatch tree, and refusing it would lose a genuine `&&`.
    const shared = blk([mkOp('ret', { operands: [] })]);
    const other = blk([mkOp('ret', { operands: [] })]);
    const x = mkValue(T.unk(32));
    const rel = (op: 'icmp_sge' | 'icmp_sle', v: number, out: Value): Op[] => {
      const k = mkValue(T.unk(32));
      return [mkOp('const', { results: [k], attrs: { value: v } }), mkOp(op, { operands: [x, k], results: [out] })];
    };
    const c2 = mkValue(T.unk(32));
    const g = blk([
      ...rel('icmp_sle', 10, c2),
      {
        ...mkOp('cond_br', { operands: [c2] }),
        successors: [
          { block: shared, args: [] },
          { block: other, args: [] },
        ],
      },
    ]);
    const c1 = mkValue(T.unk(32));
    const head = blk([
      mkOp('load', { operands: [mkValue(T.ptr(T.u(32)))], results: [x], attrs: { off: 0, signed: false, width: 4 } }),
      ...rel('icmp_sge', 1, c1),
      {
        ...mkOp('cond_br', { operands: [c1] }),
        successors: [
          { block: shared, args: [] },
          { block: g, args: [] },
        ],
      },
    ]);
    const fn: Fn = { name: 'f', blocks: [head, g, shared, other] };
    expect(recognizeBranchShortCircuit(fn)).toBe(true);
  });

  test('an `opaque` in the second condition is not hoisted out of the arm it guards', () => {
    // EFFECTFUL_OPS now includes `opaque`, and analysis.ts treats it as a memory writer and a barrier.
    // This fold takes the stricter model: an unmodelled instruction must not become unconditional.
    const fn = chain({
      gOnTaken: false,
      sharedOnGTaken: true,
      gBody: (out) => [
        mkOp('opaque', { operands: [], results: [mkValue(T.unk(32))], attrs: { text: '???' } }),
        ...cmp(out),
      ],
    });
    expect(recognizeBranchShortCircuit(fn)).toBe(false);
  });
});

/** The same tree reached through RELAYS, with a RELATIONAL split node on the head — the shape that
 *  escapes the pairwise test and needs the function-wide count. */
function relayedComparisonTree(): Fn {
  const x = mkValue(T.unk(32));
  const constTest = (out: Value, k: number, opcode: 'icmp_eq' | 'icmp_sgt'): Op[] => {
    const c = mkValue(T.unk(32));
    return [mkOp('const', { results: [c], attrs: { value: k } }), mkOp(opcode, { operands: [x, c], results: [out] })];
  };
  const fn = chain({
    gOnTaken: true,
    sharedOnGTaken: false,
    trampolines: true,
    gBody: (out) => constTest(out, 20, 'icmp_eq'),
  });
  const head = fn.blocks[0];
  const c1 = head.ops[head.ops.length - 1].operands[0];
  // `x` must not be a constant itself, or neither test reads as "value against a constant"
  const seed = mkValue(T.unk(32));
  // keep the head's first op — the value `shared` returns — and replace only the comparison
  head.ops.splice(
    1,
    head.ops.length - 2,
    mkOp('const', { results: [seed], attrs: { value: 3 } }),
    mkOp('add', { operands: [seed, seed], results: [x] }),
    ...constTest(c1, 10, 'icmp_sgt'),
  );
  return fn;
}

/** `x == 1` on the head, `x == 2` on the second block, both reaching one shared block — the shape
 *  `switch (x) { case 1: case 2: … }` compiles to, and the one `if (x == 1 || x == 2)` compiles to
 *  as well WHERE THE SWITCH HAS NOTHING ELSE TO DISPATCH ON. They part as soon as it does (agbcc
 *  20 instructions against 16 at two case groups), which is why the choice is the differ's. */
function comparisonTree(): Fn {
  const shared = blk([mkOp('ret', { operands: [] })]);
  const other = blk([mkOp('ret', { operands: [] })]);
  const x = mkValue(T.unk(32)); // ONE scrutinee, compared against two constants
  const mkTest = (v: number, out: Value): Op[] => {
    const k = mkValue(T.unk(32));
    return [
      mkOp('const', { results: [k], attrs: { value: v } }),
      mkOp('icmp_eq', { operands: [x, k], results: [out] }),
    ];
  };
  const c2 = mkValue(T.unk(32));
  const g = blk([
    ...mkTest(2, c2),
    {
      ...mkOp('cond_br', { operands: [c2] }),
      successors: [
        { block: shared, args: [] },
        { block: other, args: [] },
      ],
    },
  ]);
  const c1 = mkValue(T.unk(32));
  // `x` is computed, not a `const`: `constTestScrutinee` wants exactly one side of each `icmp`
  // constant, and a constant scrutinee reads as neither test comparing a value against one.
  const seed = mkValue(T.unk(32));
  const head = blk([
    mkOp('const', { results: [seed], attrs: { value: 3 } }),
    mkOp('add', { operands: [seed, seed], results: [x] }),
    ...mkTest(1, c1),
    {
      ...mkOp('cond_br', { operands: [c1] }),
      successors: [
        { block: shared, args: [] },
        { block: g, args: [] },
      ],
    },
  ]);
  return { name: 'f', blocks: [head, g, shared, other] };
}

// The tree-ownership refusal chooses a SPELLING where every other refusal in this pass guards
// soundness, so it is the one with a second arm: `foldTreeOwned` takes the fold, `onTreeOwned`
// reports the site either way, and rank.ts gates its axis on that report.
describe('the connective-vs-tree axis', () => {
  test('`foldTreeOwned` takes the fold the tree refusal owns, and the result verifies', () => {
    const fn = comparisonTree();
    expect(recognizeBranchShortCircuit(fn, { foldTreeOwned: true })).toBe(true);
    expect(connective(fn)).toBe('logic_or');
    verify(fn);
  });

  test('the relayed clause does NOT move with the flag — it is a different statement', () => {
    // The pairwise clause is switch-recover.ts's own PRE1, a NECESSARY condition for recovery, so
    // it refuses "a switch could not be ruled out here" — close enough to a spelling question that
    // an axis can referee it. The relayed clause is a blunt function-wide COUNT that fires on an
    // ordinary loop counter (see the REFUSALS note) with no second legitimate spelling behind it.
    // It has no inhabitant in any benchmark row, so widening it would be scaffolding.
    const fn = relayedComparisonTree();
    let seen = 0;
    expect(recognizeBranchShortCircuit(fn, { foldTreeOwned: true, onTreeOwned: () => seen++ })).toBe(false);
    expect(connective(fn)).toBeNull();
    expect(seen).toBe(0); // and it is not reported either — the axis has no inhabitant here
    verify(fn);
  });

  test('`onTreeOwned` reports the site while the default still refuses it', () => {
    let seen = 0;
    const fn = comparisonTree();
    expect(recognizeBranchShortCircuit(fn, { onTreeOwned: () => seen++ })).toBe(false);
    expect(seen).toBeGreaterThan(0);
  });

  test('…and stays silent where a LATER refusal would have stopped the fold anyway', () => {
    // The gate is asked LAST. A site the tree refusal owns but that `sameArgs` also refuses has no
    // `/connective` candidate to offer, and reporting it would double the row's whole candidate
    // cross to enumerate duplicates the dedup collapses.
    const fn = comparisonTree();
    const h = fn.blocks[0];
    const ht = h.ops[h.ops.length - 1];
    // give the shared edge from ^h an argument its sibling from ^g does not carry
    const shared = forwardingTargetOf(ht.successors[0].block);
    shared.params.push(mkValue(T.unk(32)));
    ht.successors[0].args = [mkValue(T.unk(32))];
    let seen = 0;
    expect(recognizeBranchShortCircuit(fn, { onTreeOwned: () => seen++ })).toBe(false);
    expect(seen).toBe(0);
  });

  test('…and stays silent where the fold was going to happen anyway', () => {
    // A RELATIONAL pair shares a scrutinee and is not a dispatch tree, so it never reaches the
    // refusal — reporting it would enumerate the axis on a function with no inhabitant for it.
    let seen = 0;
    const fn = chain({ gOnTaken: false, sharedOnGTaken: true });
    expect(recognizeBranchShortCircuit(fn, { onTreeOwned: () => seen++ })).toBe(true);
    expect(seen).toBe(0);
  });

  test('the flag widens the SHAPE only — every other refusal still applies', () => {
    // The tree fixture with a side effect in the second block: folding would run the store
    // unconditionally, and that is wrong under either spelling.
    const fn = comparisonTree();
    fn.blocks[1].ops.unshift(
      mkOp('store', { operands: [mkValue(T.ptr(T.u(8))), mkValue(T.unk(32))], attrs: { off: 0, width: 1 } }),
    );
    expect(recognizeBranchShortCircuit(fn, { foldTreeOwned: true })).toBe(false);
  });
});

describe('the VALUE form shares the entry-block refusal', () => {
  test('a feeder that is the entry block is not folded away', () => {
    // Same hazard, same file, opposite fold: `recognizeShortCircuit` deletes its feeder too, and
    // `predecessors()` is blind to the entry edge for it as well. PRE-EXISTING — `main` miscompiles
    // the MIPS shape this mirrors — and fixed alongside the branch form because the branch form's
    // own note used to claim this fold was safe.
    const merge = blk([mkOp('ret', { operands: [] })], [mkValue(T.unk(32))]);
    const vb = mkValue(T.unk(32));
    const entry = blk(cmp(vb)); // entry AND the value form's feeder
    const c = mkValue(T.unk(32));
    const head = blk(cmp(c));
    const zero = mkValue(T.unk(32));
    head.ops.splice(head.ops.length - 1, 0, mkOp('const', { results: [zero], attrs: { value: 0 } }));
    head.ops.push({
      ...mkOp('cond_br', { operands: [c] }),
      successors: [
        { block: merge, args: [zero] },
        { block: entry, args: [] },
      ],
    });
    entry.ops.push({ ...mkOp('br'), successors: [{ block: merge, args: [vb] }] });
    const other = blk([{ ...mkOp('br'), successors: [{ block: merge, args: [vb] }] }]);
    const fn: Fn = { name: 'f', blocks: [entry, head, other, merge] };
    expect(recognizeShortCircuit(fn)).toBe(false);
    expect(fn.blocks[0]).toBe(entry);
  });
});
