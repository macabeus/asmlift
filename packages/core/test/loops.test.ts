// Unit tests for the natural-loop discovery module (src/structure/loops.ts) — the CFG analysis the
// structurer consumes for loop recovery. Pure over
// the CFG: no emitter, no type recovery, no toolchain. Pins the structural facts the classifier
// depends on (back-edge headers, natural-loop bodies, single vs multi latch, exit edges, self-loop
// flag, nesting) so a discovery regression is caught here, not diffused into a decompile mismatch.
import { expect, test } from 'vitest';

import type { Block } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { analyzeLoops, dominators } from '../src/structure/loops';

function forestOf(ir: string) {
  const fn = parse(ir);
  const forest = analyzeLoops(fn, dominators(fn));
  const idx = (b: Block) => fn.blocks.indexOf(b);
  return { fn, forest, idx };
}

test('test-at-top while: header, single latch, body excludes the exit, single exit edge', () => {
  // ^bb1 header (tests), ^bb2 body/latch (back-edge to ^bb1), ^bb3 exit (returns).
  const { forest, idx } = forestOf(`fn f {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: u32 = icmp_slt %1, %0
  cond_br %2, ^bb2(%1), ^bb3(%1)
^bb2(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  br ^bb1(%5)
^bb3(%6: s32):
  ret %6
}
`);
  const headers = [...forest.byHeader.values()];
  expect(headers.length).toBe(1);
  const nl = headers[0];
  expect(idx(nl.header)).toBe(1);
  expect(nl.selfLoop).toBe(false);
  expect(nl.latches.map(idx)).toEqual([2]);
  expect([...nl.body].map(idx).sort()).toEqual([1, 2]); // exit ^bb3 NOT in the body
  expect(nl.exitEdges.map((e) => `${idx(e.from)}->${idx(e.to)}`)).toEqual(['1->3']);
  expect(nl.forwardPreds.map(idx)).toEqual([0]);
});

test('early return inside a loop: ret-block is NOT in the body, and is NOT a real exit-vs-header edge', () => {
  // ^bb1 header; ^bb2 body has an early `ret` to ^bb3 AND the back-edge to ^bb1; ^bb4 is the exit.
  const { forest, idx } = forestOf(`fn g {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: u32 = icmp_ne %1, %0
  cond_br %2, ^bb2(%1), ^bb4(%1)
^bb2(%3: s32):
  %4: s32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb3(), ^bb1(%3)
^bb3():
  %6: s32 = const {value=7}
  ret %6
^bb4(%7: s32):
  ret %7
}
`);
  const nl = [...forest.byHeader.values()][0];
  expect(idx(nl.header)).toBe(1);
  expect([...nl.body].map(idx).sort()).toEqual([1, 2]); // ^bb3 (early ret) and ^bb4 (exit) excluded
  // exit edges = header→^bb4 (the real exit) and body^bb2→^bb3 (the early return). The classifier
  // distinguishes them: only ^bb2→^bb3 targets a ret block.
  const edges = nl.exitEdges.map((e) => `${idx(e.from)}->${idx(e.to)}`).sort();
  expect(edges).toEqual(['1->4', '2->3']);
});

test('self-loop is flagged (guarded → emitWhile; unguarded → single-block do-while)', () => {
  const { forest, idx } = forestOf(`fn s {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=1}
  %3: s32 = sub %1, %2
  %4: u32 = icmp_ne %3, %0
  cond_br %4, ^bb1(%3), ^bb2(%3)
^bb2(%5: s32):
  ret %5
}
`);
  const nl = [...forest.byHeader.values()][0];
  expect(idx(nl.header)).toBe(1);
  expect(nl.selfLoop).toBe(true);
  expect(nl.latches.map(idx)).toEqual([1]);
});

test('nested loops: two headers, inner nested under outer', () => {
  // outer header ^bb1, inner header ^bb2 (self-loop), inner exits back to the outer latch.
  const { forest, idx } = forestOf(`fn n {
^bb0(%0: s32):
  br ^bb1(%0, %0)
^bb1(%1: s32, %2: s32):
  br ^bb2(%1, %2)
^bb2(%3: s32, %4: s32):
  %5: s32 = const {value=1}
  %6: s32 = sub %4, %5
  %7: u32 = icmp_ne %6, %0
  cond_br %7, ^bb2(%3, %6), ^bb3(%3)
^bb3(%8: s32):
  %9: s32 = const {value=1}
  %10: s32 = sub %8, %9
  %11: u32 = icmp_ne %10, %0
  cond_br %11, ^bb1(%10, %10), ^bb4(%10)
^bb4(%12: s32):
  ret %12
}
`);
  const headers = [...forest.byHeader.keys()].map(idx).sort();
  expect(headers).toEqual([1, 2]);
  const outer = [...forest.byHeader.values()].find((l) => idx(l.header) === 1)!;
  const inner = [...forest.byHeader.values()].find((l) => idx(l.header) === 2)!;
  expect(inner.selfLoop).toBe(true);
  // the inner header sits inside the outer body; nesting parent of inner = outer.
  expect(outer.body.has(inner.header)).toBe(true);
  expect(forest.parent.get(inner.header) === outer.header).toBe(true);
  expect(forest.parent.get(outer.header)).toBe(null);
});

test('no loop → empty forest', () => {
  const { forest } = forestOf(`fn straight {
^bb0(%0: s32):
  %1: u32 = icmp_slt %0, %0
  cond_br %1, ^bb1(), ^bb2()
^bb1():
  ret %0
^bb2():
  ret %0
}
`);
  expect(forest.byHeader.size).toBe(0);
});
