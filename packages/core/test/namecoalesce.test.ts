// UNIT tests for the merge-copy coalescer (structure/namecoalesce.ts) — the `/merge-names` axis.
//
// The acceptance cases and the ablations both run the REAL pass, through `structure()` on parsed
// IR, because what a gate protects is only visible in the emitted C: a merge the gate would have
// refused does not throw, it prints a function that reads the wrong variable. Each ablation
// therefore asserts BOTH sides — the gated spelling, and the wrong one the ablated table produces.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { Block, Op, Value, mkOp, mkValue } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { NAME_COALESCE_GATES, type NameCoalesceDeps, coalesceNames } from '../src/structure/namecoalesce';
import { structure } from '../src/structure/structure';

const emit = (ir: string, gate?: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(
    structure(fn, { coalesceMergeNames: true }, gate ? { nameCoalesceGates: without(NAME_COALESCE_GATES, gate) } : {}),
  );
};
const uncoalesced = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// Two arms, each clamping two loads through an inner join of its own — the chain the naming walk
// cannot follow, because it only ever adopts a name BACKWARD along one edge. ^bb7 takes the arm-A
// names and arm B pays a copy per value.
const JOIN_CHAIN = `fn joinchain {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: u32 = icmp_ne %0, %2
  cond_br %3, ^bb1(), ^bb4()
^bb1():
  %4: s32 = load %1 {off=0, signed=true, width=4}
  %5: s32 = const {value=31}
  %6: u32 = icmp_sgt %4, %5
  cond_br %6, ^bb2(%5), ^bb2(%4)
^bb2(%7: s32):
  %8: s32 = load %1 {off=4, signed=true, width=4}
  %9: s32 = const {value=31}
  %10: u32 = icmp_sgt %8, %9
  cond_br %10, ^bb3(%9), ^bb3(%8)
^bb3(%11: s32):
  br ^bb7(%7, %11)
^bb4():
  %12: s32 = load %1 {off=8, signed=true, width=4}
  %13: s32 = const {value=15}
  %14: u32 = icmp_sgt %12, %13
  cond_br %14, ^bb5(%13), ^bb5(%12)
^bb5(%15: s32):
  %16: s32 = load %1 {off=12, signed=true, width=4}
  %17: s32 = const {value=15}
  %18: u32 = icmp_sgt %16, %17
  cond_br %18, ^bb6(%17), ^bb6(%16)
^bb6(%19: s32):
  br ^bb7(%15, %19)
^bb7(%20: s32, %21: s32):
  %22: s32 = add %20, %21
  ret %22
}
`;

test('the two arms of a merge chain become one pair of variables', () => {
  const out = emit(JOIN_CHAIN);
  expect(out).not.toMatch(/v\d+ = v\d+;/); // no copy survives
  expect(out.match(/^ {4}s32 v\d+;$/gm)).toHaveLength(2);
  // arm B now writes the merge variables directly, which is what the source did
  expect(out).toContain('v0 = a1[2];');
});

test('the axis is off by default — the same function keeps four variables and two copies', () => {
  const out = uncoalesced(JOIN_CHAIN);
  expect(out.match(/^ {4}s32 v\d+;$/gm)).toHaveLength(4);
  expect(out).toContain('v0 = v2;');
  expect(out).toContain('v1 = v3;');
});

// `a()`'s result is read AFTER the join, so it is live where the merge variable is written. The
// naming walk gave the merge value arm B's name, leaving `v1 = v0` on arm A's edge.
const LIVE_ACROSS = `fn interfere {
^bb0(%0: s32):
  %1: s32 = call %0 {target="a"}
  %2: s32 = const {value=0}
  %3: u32 = icmp_ne %0, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  br ^bb3(%1)
^bb2():
  %4: s32 = call %0 {target="b"}
  br ^bb3(%4)
^bb3(%5: s32):
  %6: s32 = add %5, %1
  ret %6
}
`;

test('ablating interference clobbers a value live across the copy', () => {
  expect(emit(LIVE_ACROSS)).toContain('return v1 + v0;');
  // one variable for both, so `b()` overwrites the `a()` result the return still needs
  expect(emit(LIVE_ACROSS, 'interference')).toContain('return v0 + v0;');
});

// The `do-while` carries its own pre-update value out (fibonacci's `a`): ^bb3's parameter is the
// value the last iteration STARTED with, so sharing the loop variable's name would read it one
// iteration on. `loop-escape` is what keeps them apart.
const TRAILING_DOWHILE = `fn trailingdw {
^bb0(%0: s32):
  %1: s32 = const {value=1}
  %2: s32 = const {value=0}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sle %0, %3
  %5: s32 = const {value=0}
  cond_br %4, ^bb3(%5), ^bb1()
^bb1():
  %6: s32 = const {value=1}
  br ^bb2(%1, %6, %2)
^bb2(%7: s32, %8: s32, %9: s32):
  %10: s32 = const {value=1}
  %11: s32 = add %9, %10
  %12: u32 = icmp_slt %11, %0
  %13: s32 = add %7, %8
  cond_br %12, ^bb2(%8, %13, %11), ^bb3(%7)
^bb3(%14: s32):
  ret %14
}
`;

// A rotated loop whose post-loop read wants a pre-update value: `structure()` declines it, and the
// merged naming makes the guard that detects it stop firing. Found by differential fuzzing.
const UNLOCKS_A_DECLINE = `fn unlockdecline {
^bb0(%0: s32):
  %11: s32 = call %0 {target="f0"}
  %12: s32 = sub %11, %0
  br ^bb1(%12, %11, %12)
^bb1(%1: s32, %2: s32, %3: s32):
  %13: s32 = sub %0, %1
  %14: s32 = const {value=7}
  br ^bb2(%14)
^bb2(%4: s32):
  %15: s32 = sub %2, %13
  %16: s32 = sub %1, %2
  %17: s32 = const {value=13}
  br ^bb3(%13, %17, %2)
^bb3(%5: s32, %6: s32, %7: s32):
  br ^bb4()
^bb4():
  %18: s32 = const {value=11}
  %19: s32 = sub %7, %12
  %20: s32 = add %16, %11
  br ^bb5(%16, %14)
^bb5(%8: s32, %9: s32):
  %21: u32 = icmp_sgt %14, %9
  cond_br %21, ^bb1(%5, %8, %4), ^bb6(%14)
^bb6(%10: s32):
  %22: s32 = const {value=19}
  %23: s32 = call %18 {target="f2"}
  %24: s32 = call %15 {target="f0"}
  ret %4
}
`;

test('a post-loop value never takes its loop variable’s name', () => {
  expect(emit(TRAILING_DOWHILE)).toBe(uncoalesced(TRAILING_DOWHILE));
});

test('a candidate never unlocks a function the primary declines', () => {
  // `varName` is an input to the loop emitters' hazard predicates, not only to spelling: merging
  // two names turns a real edge copy into an identity one, and a guard that asks "does this edge
  // write anything" stops seeing the hazard. Structuring without the axis first is what makes that
  // structural rather than a list of patched guards — this function is one the fuzz found.
  expect(() => uncoalesced(UNLOCKS_A_DECLINE)).toThrow(/pre-update loop variable/);
  expect(() => emit(UNLOCKS_A_DECLINE)).toThrow(/pre-update loop variable/);
});

// ── the type rule, at the level it decides on ──────────────────────────────────────────────────
// Two names whose DECLARATIONS disagree. The shape is not constructible in parsed IR — a
// successor argument has its parameter's type — but it is reached 100 times over klonoa's 69
// liftable functions, because a name is declared by the FIRST value to take it and later adopters
// are not re-checked. So this one is driven at the pass's own boundary.
const v = (): Value => mkValue(T.s(32));
const twoNames = (
  xType: ReturnType<typeof T.s>,
  yType: ReturnType<typeof T.s>,
  o: { withSibling?: boolean } = {},
): { deps: NameCoalesceDeps; join: Value; sibling: Value } => {
  const join = v();
  // A second parameter of the SAME block, already carrying the name the merge would absorb.
  const sibling = v();
  const fromA = v();
  const fromB = v();
  const params = o.withSibling ? [join, sibling] : [join];
  const bJ: Block = { params, ops: [mkOp('ret', { operands: [join] })] };
  const defA = mkOp('call', { results: [fromA] });
  const defB = mkOp('call', { results: [fromB] });
  const argsOf = (a: Value, b: Value): Value[] => (o.withSibling ? [a, b] : [a]);
  const bA: Block = {
    params: [],
    ops: [defA, mkOp('br', { successors: [{ block: bJ, args: argsOf(fromA, fromB) }] })],
  };
  const bB: Block = {
    params: [],
    ops: [defB, mkOp('br', { successors: [{ block: bJ, args: argsOf(fromB, fromB) }] })],
  };
  const entry: Block = {
    params: [],
    ops: [
      mkOp('cond_br', {
        successors: [
          { block: bA, args: [] },
          { block: bB, args: [] },
        ],
      }),
    ],
  };
  const blocks = [entry, bA, bB, bJ];
  return {
    join,
    sibling,
    deps: {
      blocks,
      entry,
      preds: new Map<Block, Block[]>([
        [bA, [entry]],
        [bB, [entry]],
        [bJ, [bA, bB]],
      ]),
      liveIn: new Map(blocks.map((b) => [b, new Set<Value>()])),
      opBlock: new Map<Op, Block>([
        [defA, bA],
        [defB, bB],
      ]),
      opIndex: new Map<Op, number>([
        [defA, 0],
        [defB, 0],
      ]),
      useSitesOf: new Map(),
      defs: new Map<Value, Op>([
        [fromA, defA],
        [fromB, defB],
      ]),
      materialize: new Set([defA, defB]),
      varName: new Map([
        [fromA, 'v0'],
        [join, 'v0'],
        [fromB, 'v1'],
        ...(o.withSibling ? ([[sibling, 'v1']] as [Value, string][]) : []),
      ]),
      varType: new Map([
        ['v0', xType],
        ['v1', yType],
      ]),
      loops: [],
    },
  };
};

// `sibling-params` names a hazard `interference` is not built to see: two parameters of ONE block
// are written by the SAME edge copies, so neither is live where the other is written. It is not
// reachable from parsed IR the way the others are — zero refusals over klonoa's 69 liftable
// functions, because every constructible pair of simultaneously-live values interferes first — so
// like `type` it is driven at the pass's own boundary, on the shape it names.
test('ablating sibling-params puts two parameters of one block under one name', () => {
  const { deps, join, sibling } = twoNames(T.s(32), T.s(32), { withSibling: true });
  expect([...coalesceNames(deps).renames]).toEqual([]);
  const merged = coalesceNames(deps, without(NAME_COALESCE_GATES, 'sibling-params')).renames;
  expect([...merged]).toEqual([['v1', 'v0']]);
  // both parameters of the join now name one variable, so its in-edge copies write it twice
  const nameOf = (v: Value): string => merged.get(deps.varName.get(v)!) ?? deps.varName.get(v)!;
  expect(nameOf(join)).toBe(nameOf(sibling));
});

test('ablating type merges two names the declarations disagree about', () => {
  const { deps } = twoNames(T.u(32), T.ptr(T.u(8)));
  expect([...coalesceNames(deps).renames]).toEqual([]);
  // one declaration for both: the pointer's arithmetic would scale by the integer's width
  expect([...coalesceNames(deps, without(NAME_COALESCE_GATES, 'type')).renames]).toEqual([['v1', 'v0']]);
});

test('names the declarations agree about merge, and the refusal is attributed to the type rule', () => {
  const { deps } = twoNames(T.u(32), T.u(32));
  expect([...coalesceNames(deps).renames]).toEqual([['v1', 'v0']]);
  expect([...coalesceNames(twoNames(T.u(32), T.ptr(T.u(8))).deps).refusals]).toEqual([['type', 1]]);
});
