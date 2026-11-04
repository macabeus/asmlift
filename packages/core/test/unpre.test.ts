// A BLOCK PARAMETER EVERY EDGE HANDS ONE PURE EXPRESSION (raise/unpre.ts) — agbcc's gcse PRE puts a
// loop's `i + 1` on the switch edge and keeps a falling arm's own sum in the same register, so the
// case fallen into takes `i + 1` from both edges. The fold recomputes it in the block.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { type Block, type Fn, type Value, defOpMap, dominators } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { PRE_STRUCTURE_FOLDS } from '../src/raise/pre-structure';
import { UNPRE_GATES, recomputeDerivedParams, recomputeRedundantParams, strideDerivedParams } from '../src/raise/unpre';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

// `case 0:` falls into `case 1:`; the dispatch hands `case 1:` `a0` and `a0 + 1`, and `case 0:` hands
// it what `fallArgs` names. `%5` is `case 0:`'s own `a0 + 1`, `%6` the constant 9, `%11` a load.
const fallIr = (fallArgs: string, dispatchSum = '%3') => `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %0, %2
  %10: s32 = load %0 {off=0, signed=true, width=4}
  switch_br %1, ^bb1(), ^bb2(%0, ${dispatchSum}), ^bb3() {cases=[0;1]}
^bb1():
  %4: s32 = const {value=1}
  %5: s32 = add %0, %4
  %6: s32 = const {value=9}
  %11: s32 = load %0 {off=0, signed=true, width=4}
  br ^bb2(${fallArgs})
^bb2(%7: s32, %8: s32):
  %9: s32 = call %7, %8 {target="side2"}
  br ^bb3()
^bb3():
  ret
}
`;
const fold = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const n = recomputeRedundantParams(fn);
  verify(fn);
  return { n, fn, emit: () => cBackend.emit(structure(fn, { returnsVoid: true })) };
};

test('both edges hand the parameter `a0 + 1`: it is recomputed in the block and the fall-through lifts', () => {
  const { n, fn, emit } = fold(fallIr('%0, %5'));
  expect(n).toBe(1);
  expect(fn.blocks[2].params).toHaveLength(1);
  expect(emit()).toMatch(/case 0:\s*case 1:\s*side2\(a0, a0 \+ 1\);/);
});

test('a different value from one edge is a real join, and the switch-edge copy still refuses', () => {
  const { n, emit } = fold(fallIr('%0, %6'));
  expect(n).toBe(0);
  expect(emit).toThrow(/takes a value from the switch edge/);
});

test('equal loads are not recomputed: memory may change between the edge and the block', () => {
  const { n, emit } = fold(fallIr('%0, %11', '%10'));
  expect(n).toBe(0);
  expect(emit).toThrow(/takes a value from the switch edge/);
});

test('a recomputed leaf keeps its own name where the falling edge sets the parameter beside it', () => {
  // `case 0:` hands the first parameter 9: the recomputed `a0 + 1` reads `a0`, which is live beside
  // that parameter in `case 1:`, so the parameter needs a name of its own — whose switch-edge copy
  // `v = a0;` the fall path would re-run over the 9. That refusal is the one the structurer owes.
  const { n, emit } = fold(fallIr('%6, %5'));
  expect(n).toBe(1);
  expect(emit).toThrow(/takes a value from the switch edge/);
});

test('a case parameter both edges hand one constant is left to the passes that spell merges of constants', () => {
  // `%2` and `%4` are both the constant 1 (`%6`, the 9, would be a real join and prove nothing)
  const { n } = fold(fallIr('%0, %4', '%2'));
  expect(n).toBe(0);
  // the rule that keeps it out, and the fold's own precondition holds there
  const fn = parse(fallIr('%0, %4', '%2'));
  expect(recomputeRedundantParams(fn, without(UNPRE_GATES, 'operand-free'))).toBe(1);
  verify(fn);
});

// A loop inside `case 1:` whose back edge hands the parameter itself: the waiver ir/simplify.ts's
// trivial phi takes, shared through `trivialPhiValue`.
const LOOPED_CASE = `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %0, %2
  switch_br %1, ^bb1(), ^bb2(%3), ^bb3() {cases=[0;1]}
^bb1():
  %4: s32 = const {value=1}
  %5: s32 = add %0, %4
  br ^bb2(%5)
^bb2(%7: s32):
  %9: s32 = call %7 {target="side1"}
  %10: s32 = const {value=0}
  %11: u32 = icmp_eq %9, %10
  cond_br %11, ^bb2(%7), ^bb3()
^bb3():
  ret
}
`;

test('a back edge handing the case its own parameter is waived, as for a trivial phi', () => {
  const { n, fn, emit } = fold(LOOPED_CASE);
  expect(n).toBe(1);
  expect(fn.blocks[2].params).toHaveLength(0);
  expect(emit()).toMatch(/side1\(a0 \+ 1\)/);
});

// The two arms of an `if` each compute `a0 << 2` and merge it, as agbcc does where the source wrote
// the sum in each arm (pointer-word-temp.test.ts's pokeemerald shape). Recomputed at every join, the
// full bench loses two MATCHes (raise/unpre.ts's header has the measurement).
const IF_JOIN = `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  %4: s32 = const {value=2}
  %5: s32 = shl %0, %4
  br ^bb3(%5)
^bb2():
  %6: s32 = const {value=2}
  %7: s32 = shl %0, %6
  br ^bb3(%7)
^bb3(%8: s32):
  %9: s32 = call %8 {target="side1"}
  ret
}
`;

test('an ordinary join is not a case fallen into, and keeps its parameter (the scope gate)', () => {
  expect(fold(IF_JOIN).n).toBe(0);
  // the same IR with the gate lifted: the fold's own precondition holds there
  const fn = parse(IF_JOIN);
  expect(recomputeRedundantParams(fn, without(UNPRE_GATES, 'not-switch-join'))).toBe(1);
  verify(fn);
});

// The switch's EXIT is the other join the gate admits: the dispatch hands it `a0 + 1` by its default
// edge (the last successor — a bounds test straight to the loop latch, as in `synthetic:sw_fallpre`,
// whose MATCH rests on this firing), `case 0:` hands it the same SSA value, and `case 1:` its own
// sum. `exitFrom` names the block the third edge into the exit comes from.
const exitIr = (exitFrom = '^bb2') => `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %0, %2
  %4: s32 = const {value=0}
  %5: u32 = icmp_eq %0, %4
  cond_br %5, ^bb4(), ^bb5()
^bb5():
  switch_br %1, ^bb1(), ^bb2(), ^bb3(%3) {cases=[0;1]}
^bb1():
  %6: s32 = call %0 {target="side1"}
  br ^bb3(%3)
^bb2():
  %7: s32 = call %0 {target="side1"}
  %8: s32 = const {value=1}
  %9: s32 = add %0, %8
  br ^bb3(%9)
^bb4():
  br ${exitFrom === '^bb4' ? '^bb3(%3)' : '^bb6()'}
^bb6():
  ret
^bb3(%10: s32):
  %11: s32 = call %10 {target="side1"}
  ret
}
`;

test("the switch's exit, entered by the default edge, is recomputed too: no `default:` arm holds a copy", () => {
  const { n, fn, emit } = fold(exitIr());
  expect(n).toBe(1);
  expect(fn.blocks.slice(1).every((b) => b.params.length === 0)).toBe(true);
  const c = emit();
  expect(c).not.toMatch(/default:/);
  expect(c).toMatch(/side1\(a0 \+ 1\);/);
});

test('a join the switch reaches by its default edge but code outside the switch also enters is left alone', () => {
  // `^bb4` (before the dispatch, not dominated by it) also hands the exit `a0 + 1`
  expect(fold(exitIr('^bb4')).n).toBe(0);
});

// IDO's counted loop (`synthetic:sw_gotocase2:ido7.1`): the loop-invariant bound `hi + 1` is
// computed again in the delay slot of every arm's `b latch`, so the latch takes it as a parameter
// both arms hand it. A latch is no switch join; the scope admits it as a loop's latch.
const latchIr = (secondBound = '%9: s32 = add %1, %8') => `fn f {
^bb0(%0: s32, %1: s32):
  br ^bb1(%0)
^bb1(%2: s32):
  %3: s32 = load %2 {off=0, signed=true, width=4}
  %4: s32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb3()
^bb2():
  %6: s32 = const {value=1}
  %7: s32 = add %1, %6
  br ^bb4(%7)
^bb3():
  %10: s32 = call %2 {target="side1"}
  %8: s32 = const {value=1}
  ${secondBound}
  br ^bb4(%9)
^bb4(%11: s32):
  %12: s32 = const {value=1}
  %13: s32 = add %2, %12
  %14: u32 = icmp_ne %11, %13
  cond_br %14, ^bb1(%13), ^bb5()
^bb5():
  ret
}
`;

/** the block holding `latchIr`'s test, wherever the fold leaves it */
const latchOf = (fn: Fn) => fn.blocks.find((b) => b.ops.some((op) => op.opcode === 'icmp_ne'))!;

test("a loop's latch every arm hands the bound `hi + 1` recomputes it, and its test reads it inline", () => {
  const { n, fn } = fold(latchIr());
  expect(n).toBe(1);
  expect(latchOf(fn).params).toHaveLength(0);
});

test("the arms' copies the latch fold leaves unread are deleted, and an arm left holding nothing is threaded", () => {
  // KMC steps `gA[i]`'s pointer in the default arm, which falls into the latch, and in the slot of
  // the branch into the latch's second entry (`synthetic:sw_gotocase2:gcc2.7.2kmc`): #2 held only its
  // copy, so its edge now goes to the latch itself, and #3 keeps its call
  const { n, fn } = fold(latchIr());
  expect(n).toBe(1);
  expect(fn.blocks.map((b) => b.ops.map((op) => op.opcode).join(' '))).toEqual([
    'br',
    'load const icmp_eq cond_br',
    'call br',
    'const add const add icmp_ne cond_br',
    'ret',
  ]);
  const [taken, fall] = fn.blocks[1].ops.at(-1)!.successors;
  expect(taken.block).toBe(latchOf(fn));
  expect(fall.block).toBe(fn.blocks[2]);
});

test('an arm that keeps an op of its own is not threaded', () => {
  // #2 calls before its copy: the sweep deletes the copy and leaves the call
  const { n, fn } = fold(
    latchIr().replace(
      '  %6: s32 = const {value=1}\n',
      '  %6: s32 = const {value=1}\n  %15: s32 = call %6 {target="side2"}\n',
    ),
  );
  expect(n).toBe(1);
  expect(fn.blocks).toHaveLength(6);
  expect(fn.blocks[2].ops.map((op) => op.opcode)).toEqual(['const', 'call', 'br']);
});

test('the recomputed value takes the type of the parameter it replaces, not the arm op it was cloned from', () => {
  // type recovery types a parameter by its uses (an unsigned compare: `u32`) and the arms' adds by
  // their operands (`s32`); the reconciliation of declared signedness reads what stands in the
  // parameter's place, and a `u32` counter that declared `s32` would overflow where the asm wraps
  // (kleod's `sub_080240F4`)
  const { n, fn } = fold(latchIr().replace('^bb4(%11: s32):', '^bb4(%11: u32):'));
  expect(n).toBe(1);
  const root = defOpMap(fn).get(latchOf(fn).ops.find((op) => op.opcode === 'icmp_ne')!.operands[0])!;
  expect(root.opcode).toBe('add');
  expect(root.results[0].type).toEqual({ kind: 'int', width: 32, signed: false });
});

test('a latch handed two different values keeps its parameter', () => {
  expect(fold(latchIr('%9: s32 = add %0, %8')).n).toBe(0);
});

test('the fold runs last in the pre-structure record', () => {
  expect(PRE_STRUCTURE_FOLDS.map((f) => f.id).at(-1)).toBe('unpre');
});

// ── A SIBLING'S LEAF (`recomputeDerivedParams`) ──────────────────────────────────────────────────
//
// gcc 2.7.2's strength-reduced `for (i = lo; i < hi; i++) use(i << 3)`, with `+ 3` for the `<< 3`
// (an op the trace oracle models): the loop's entry hands the header `(lo, lo + 3)`, the latch
// `(i + 1, (i + 1) + 3)`. `%5` is `%4 + 3` at every entry.
const derivedIr = ({
  entry = '%3: s32 = add %0, %2',
  back = '%9: s32 = add %8, %2',
  test = '%10: u32 = icmp_slt %8, %1',
} = {}) => `fn d {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=3}
  ${entry}
  br ^bb1(%0, %3)
^bb1(%4: s32, %5: s32):
  %6: s32 = call %5 {target="use"}
  %7: s32 = const {value=1}
  %8: s32 = add %4, %7
  ${back}
  ${test}
  cond_br %10, ^bb1(%8, %9), ^bb2()
^bb2():
  ret
}
`;
const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);
const derived = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const n = recomputeDerivedParams(fn);
  verify(fn);
  const sfn = structure(fn, { returnsVoid: true });
  return { n, fn, src: cBackend.emit(sfn), agreement: irAgreement(ir, sfn, SEEDS) };
};

test("a param every edge hands the same op of a sibling's argument is that op of the sibling", () => {
  const r = derived(derivedIr());
  expect(r.n).toBe(1);
  expect(r.fn.blocks[1].params).toHaveLength(1);
  // the entry's `lo + 3` and the latch's `(i + 1) + 3`, read by nothing now, go with it: the
  // header's `i + 3` and the latch's `i + 1` are the adds left
  expect(r.fn.blocks.flatMap((b) => b.ops).filter((o) => o.opcode === 'add')).toHaveLength(2);
  expect(r.src).toMatch(/use\(\w+ \+ 3\)/);
  expect(r.agreement.disagree).toBe(0);
  expect(r.agreement.judged).toBe(SEEDS.length);
});

test('a test that reads the derived back-edge value reads the op of the updated sibling', () => {
  // `(i + 1) + 3 < hi`: the derived param's back-edge value, which stays the latch's own op
  const r = derived(derivedIr({ test: '%10: u32 = icmp_slt %9, %1' }));
  expect(r.n).toBe(1);
  expect(r.agreement.disagree).toBe(0);
  expect(r.agreement.judged).toBe(SEEDS.length);
});

test('two constants of one value on the two edges are one operand', () => {
  const r = derived(derivedIr({ back: '%11: s32 = const {value=3}\n  %9: s32 = add %8, %11' }));
  expect(r.n).toBe(1);
  expect(r.agreement.disagree).toBe(0);
});

test('a param no one op of the sibling computes is left alone', () => {
  // two opcodes, two constants, and an operand that is neither the sibling's argument nor shared
  expect(derived(derivedIr({ entry: '%3: s32 = sub %0, %2' })).n).toBe(0);
  expect(derived(derivedIr({ back: '%11: s32 = const {value=2}\n  %9: s32 = add %8, %11' })).n).toBe(0);
  expect(derived(derivedIr({ back: '%9: s32 = add %8, %4' })).n).toBe(0);
});

test('a load of the sibling is not recomputed: memory may change between the edge and the block', () => {
  // `*lo` loaded ahead of the store `*lo = 9`, then `*(i + 1)` in the latch: read at the header's
  // head, the first trip would see the 9
  const ir = derivedIr({
    entry:
      '%3: s32 = load %0 {off=0, signed=false, width=4}\n  %12: s32 = const {value=9}\n  store %0, %12 {off=0, width=4}',
    back: '%9: s32 = load %8 {off=0, signed=false, width=4}',
  });
  expect(derived(ir).n).toBe(0);
});

test('the derived-param fold runs just ahead of the congruent one', () => {
  const ids = PRE_STRUCTURE_FOLDS.map((f) => f.id);
  expect(ids.indexOf('derivedparam')).toBe(ids.indexOf('unpre') - 1);
});

// ── A SIBLING'S STRIDE (`strideDerivedParams`) ───────────────────────────────────────────────────
//
// IDO's `for (i = lo; i <= hi; i++) .. gE[i] ..`: the entry hands the header `(gE + (lo << 3), lo)`
// and the back edge `(p + 8, i + 1)`. `p` is G(i) = `gE + (i << 3)` at every entry, by induction.
const strideIr = ({
  entry = '%4: s32 = shl %0 {imm=3}\n  %5: s32 = add %4, %3',
  step = '%11: s32 = const {value=8}',
  base = '%3: s32 = gaddr {sym="gE"}',
  ivStep = '%9: s32 = const {value=1}',
} = {}) => `fn s {
^bb0(%0: s32, %1: s32):
  ${base}
  ${entry}
  br ^bb1(%5, %0)
^bb1(%6: s32, %7: s32):
  %8: s32 = load %6 {off=4, signed=false, width=1}
  %12: s32 = call %8 {target="use"}
  ${ivStep}
  %10: s32 = add %7, %9
  ${step}
  %13: s32 = add %6, %11
  %14: u32 = icmp_slt %1, %10
  cond_br %14, ^bb2(), ^bb1(%13, %10)
^bb2():
  ret
}
`;
const strides = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const defs = defOpMap(fn);
  const dom = dominators(fn);
  const home = new Map<Value, Block>();
  for (const b of fn.blocks) {
    b.params.forEach((p) => home.set(p, b));
    b.ops.forEach((o) => o.results.forEach((r) => home.set(r, b)));
  }
  const h = fn.blocks[1];
  const [entry] = fn.blocks[0].ops.at(-1)!.successors;
  const back = fn.blocks[1].ops.at(-1)!.successors[1];
  return strideDerivedParams(defs, h, entry, back, (v) => {
    const at = home.get(v);
    return at !== undefined && at !== h && dom.get(h)!.has(at);
  });
};

test('a pointer that starts at `B + (lo << s)` and steps by `1 << s` beside `i` is G(i)', () => {
  const got = strides(strideIr());
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ j: 0, i: 1 });
  expect(got[0].ops.map((o) => o.opcode)).toEqual(['shl', 'add']);
});

test('a stride of `i * M` with K = D * M is G(i) too', () => {
  const got = strides(
    strideIr({
      entry: '%15: s32 = const {value=12}\n  %4: s32 = mul %0, %15\n  %5: s32 = add %3, %4',
      step: '%11: s32 = const {value=12}',
    }),
  );
  expect(got).toHaveLength(1);
});

test('a step that is not T(D) is no stride', () => {
  expect(strides(strideIr({ step: '%11: s32 = const {value=12}' }))).toHaveLength(0);
  // the counter stepping by two: K would have to be 16
  expect(strides(strideIr({ ivStep: '%9: s32 = const {value=2}' }))).toHaveLength(0);
});

test('a base the caller does not place outside the loop is no stride', () => {
  // the same IR, with the caller's dominance answer withheld for every value
  const fn = parse(strideIr());
  verify(fn);
  const h = fn.blocks[1];
  const entry = fn.blocks[0].ops.at(-1)!.successors[0];
  const back = h.ops.at(-1)!.successors[1];
  expect(strideDerivedParams(defOpMap(fn), h, entry, back, () => false)).toHaveLength(0);
});

test('a pointer that is G of the counter and of a shifted sibling is read as G of the counter', () => {
  // KMC's `for (i = lo; i <= hi; i++) .. gE[i].f .. gE[i].x ..`: the header takes `(i << 3,
  // gE + (i << 3), i)`, the shift stepped by 8 as well. The pointer is `x + gE` of the shift too, but
  // the `for` names the counter, so the shift is the sibling asked last
  const fn = parse(`fn s {
^bb0(%0: s32, %1: s32):
  %3: s32 = gaddr {sym="gE"}
  %4: s32 = shl %0 {imm=3}
  %5: s32 = add %4, %3
  br ^bb1(%4, %5, %0)
^bb1(%6: s32, %7: s32, %8: s32):
  %20: s32 = add %3, %6
  %21: s32 = load %20 {off=5, signed=false, width=1}
  %22: s32 = call %21 {target="use"}
  %23: s32 = load %7 {off=0, signed=true, width=4}
  %24: s32 = call %23 {target="use"}
  %9: s32 = const {value=1}
  %10: s32 = add %8, %9
  %11: s32 = const {value=8}
  %12: s32 = add %6, %11
  %13: s32 = const {value=8}
  %14: s32 = add %7, %13
  %15: u32 = icmp_slt %1, %10
  cond_br %15, ^bb2(), ^bb1(%12, %14, %10)
^bb2():
  ret
}
`);
  verify(fn);
  const h = fn.blocks[1];
  const entry = fn.blocks[0].ops.at(-1)!.successors[0];
  const back = h.ops.at(-1)!.successors[1];
  const got = strideDerivedParams(defOpMap(fn), h, entry, back, (v) =>
    fn.blocks[0].ops.some((o) => o.results.includes(v)),
  );
  expect(got.map(({ j, i }) => ({ j, i }))).toEqual([
    { j: 0, i: 2 },
    { j: 1, i: 2 },
  ]);
  expect(got[1].ops.map((o) => o.opcode)).toEqual(['shl', 'add']);
});
