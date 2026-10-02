// The stages `analyze` runs ahead of its fixpoint, and the two rule walks it drives, each on built
// IR. The rules are driven over `analysisStages`, the wiring `analyze` itself uses.
import { expect, test } from 'vitest';

import { type Fn, type Op, defOpMap, dominators, predecessors } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import {
  analysisStages,
  blockLiveIn,
  edgeArgUses,
  indexUses,
  makeLoopRules,
  makeRenderModel,
  nameAccess,
  namePureOp,
} from '../src/structure/analysis';

const built = (ir: string): Fn => {
  const fn = parse(ir);
  verify(fn);
  return fn;
};

/** the op at `blk`, `idx` */
const opAt = (fn: Fn, blk: number, idx: number): Op => fn.blocks[blk].ops[idx];

test("indexUses does not count a void function's ret operand as a use", () => {
  const fn = built(`fn f {
^bb0(%0: s32):
  %1: s32 = call %0 {target="g"}
  ret %1
}
`);
  const result = opAt(fn, 0, 0).results[0];
  expect(indexUses(fn, true).useSitesOf.has(result)).toBe(false);
  expect(indexUses(fn, false).useSitesOf.get(result)).toEqual([{ blk: fn.blocks[0], idx: 1, op: opAt(fn, 0, 1) }]);
});

test('indexUses keeps a const live across a call only when a call lies between it and a consumer', () => {
  const fn = built(`fn f {
^bb0(%0: s32):
  %1: s32 = const {value=5}
  %2: s32 = add %0, %1
  %3: s32 = call %2 {target="g"}
  %4: s32 = add %3, %1
  ret %4
}
`);
  const { liveAcrossCall } = indexUses(fn, false);
  expect(liveAcrossCall(opAt(fn, 0, 0), [opAt(fn, 0, 1), opAt(fn, 0, 3)])).toBe(true);
  expect(liveAcrossCall(opAt(fn, 0, 0), [opAt(fn, 0, 1)])).toBe(false);
});

// A self-loop counting %1 down: its latch is its only exit.
const SOLE_EXIT = `fn f {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=1}
  %3: s32 = sub %1, %2
  %4: s32 = const {value=0}
  %5: u32 = icmp_ne %3, %4
  cond_br %5, ^bb1(%3), ^bb2()
^bb2():
  ret %3
}
`;

// The same count with a second exit, from the header.
const TWO_EXITS = `fn f {
^bb0(%0: s32, %1: s32):
  br ^bb1(%0)
^bb1(%2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %1, %3
  cond_br %4, ^bb3(), ^bb2()
^bb2():
  %5: s32 = const {value=1}
  %6: s32 = sub %2, %5
  %7: u32 = icmp_ne %6, %3
  cond_br %7, ^bb1(%6), ^bb3()
^bb3():
  ret %2
}
`;

test("edgeArgUses counts a back-edge arg only from a latch that is its loop's only exit", () => {
  const sole = built(SOLE_EXIT);
  const counted = opAt(sole, 1, 1).results[0];
  const soleEdges = edgeArgUses(sole, dominators(sole));
  expect(soleEdges.backArgFed.get(counted)).toBe(1);
  expect(soleEdges.branchArgFed.has(counted)).toBe(true);
  expect(soleEdges.condBrArgFed.has(counted)).toBe(true);

  const two = built(TWO_EXITS);
  const update = opAt(two, 2, 1).results[0];
  const twoEdges = edgeArgUses(two, dominators(two));
  expect(twoEdges.backArgFed.has(update)).toBe(false);
  expect(twoEdges.branchArgFed.has(update)).toBe(true);
});

test('makeRenderModel follows a single-use pure chain to its anchor, and moves it at invalidate()', () => {
  const fn = built(`fn f {
^bb0(%0: s32):
  %1: s32 = const {value=3}
  %2: s32 = add %0, %1
  %3: s32 = mul %2, %0
  ret %3
}
`);
  const materialize = new Set<Op>();
  const render = makeRenderModel(indexUses(fn, false), materialize);
  const [add, mul] = [opAt(fn, 0, 1), opAt(fn, 0, 2)];
  expect(render.emitPos(add)).toEqual({ blk: fn.blocks[0], idx: 3 });
  expect(render.emitPositions(add)).toEqual([{ blk: fn.blocks[0], idx: 3 }]);
  materialize.add(mul);
  expect(render.anchored(mul)).toBe(true);
  expect(render.emitPos(add)).toEqual({ blk: fn.blocks[0], idx: 3 });
  render.invalidate();
  expect(render.emitPos(add)).toEqual({ blk: fn.blocks[0], idx: 2 });
  expect(render.emitPositions(add)).toEqual([{ blk: fn.blocks[0], idx: 2 }]);
});

// `do { s = &f->v; f = f->next; } while (--n); return s;` — ^bb1 is a self-loop.
const ESCAPE = `fn f {
^bb0(%0: s32*, %1: s32):
  br ^bb1(%0, %1)
^bb1(%2: s32*, %3: s32):
  %4: s32 = const {value=4}
  %5: s32* = add %2, %4
  %6: s32* = load %2 {off=0, signed=true, width=4}
  %7: s32 = const {value=1}
  %8: s32 = sub %3, %7
  %9: s32 = const {value=0}
  %10: u32 = icmp_ne %8, %9
  cond_br %10, ^bb1(%6, %8), ^bb2()
^bb2():
  %11: s32* = add %5, %4
  %12: s32* = add %6, %4
  %13: s32 = sub %11, %12
  ret %13
}
`;

test('makeLoopRules: a self-loop value read after the loop escapes ahead of the update', () => {
  const fn = built(ESCAPE);
  const dom = dominators(fn);
  const uses = indexUses(fn, false);
  const materialize = new Set<Op>();
  const loops = makeLoopRules({
    fn,
    dom,
    predsOf: predecessors(fn),
    liveIn: blockLiveIn(fn, false),
    uses,
    defOf: defOpMap(fn),
    render: makeRenderModel(uses, materialize),
    materialize,
  });
  const consumersOf = (op: Op): Op[] => uses.useSitesOf.get(op.results[0])!.map((s) => s.op);
  expect(loops.bottomTested.map((L) => L.header)).toEqual([fn.blocks[1]]);
  const [addr, next] = [opAt(fn, 1, 1), opAt(fn, 1, 2)];
  expect(loops.escapesAheadOfUpdate(addr, addr.results[0], consumersOf(addr))).toBe(true);
  // the post-update pointer is the back edge's own arg: read after the loop it is what the name holds
  expect(loops.escapesAheadOfUpdate(next, next.results[0], consumersOf(next))).toBe(false);
});

test('namePureOp names a const live across a call, and not one no call separates from its uses', () => {
  const across = built(`fn f {
^bb0(%0: s32):
  %1: s32 = const {value=5}
  %2: s32 = add %0, %1
  %3: s32 = call %2 {target="g"}
  %4: s32 = add %3, %1
  ret %4
}
`);
  const a = analysisStages(across, false, { defs: defOpMap(across), dom: dominators(across) });
  namePureOp(a.rules, a.state, opAt(across, 0, 0), across.blocks[0], false);
  expect([...a.state.materialize]).toEqual([opAt(across, 0, 0)]);

  const straight = built(`fn f {
^bb0(%0: s32):
  %1: s32 = const {value=5}
  %2: s32 = add %0, %1
  %3: s32 = add %2, %1
  ret %3
}
`);
  const s = analysisStages(straight, false, { defs: defOpMap(straight), dom: dominators(straight) });
  namePureOp(s.rules, s.state, opAt(straight, 0, 0), straight.blocks[0], false);
  expect(s.state.materialize.size).toBe(0);
});

test('nameAccess names a call one op reads twice, and inlines one it reads once', () => {
  const callRead = (consumer: string): { named: boolean } => {
    const fn = built(`fn f {
^bb0(%0: s32):
  %1: s32 = call %0 {target="g"}
  %2: s32 = mul ${consumer}
  ret %2
}
`);
    const { rules, state } = analysisStages(fn, false, { defs: defOpMap(fn), dom: dominators(fn) });
    nameAccess(rules, state, opAt(fn, 0, 0), fn.blocks[0]);
    return { named: state.materialize.has(opAt(fn, 0, 0)) };
  };
  expect(callRead('%1, %1')).toEqual({ named: true });
  expect(callRead('%1, %0')).toEqual({ named: false });
});
