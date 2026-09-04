// Unit tests for empty-latch folding (src/raise/latch.ts) — the CFG cleanup that splices out a
// back-edge block SSA construction emptied by turning its register copy into an edge argument.
// Pure over the CFG: no frontend, no type recovery, no toolchain. Every refusal here has a POSITIVE
// CONTROL — an accepted fixture one fact away from it — so a test cannot pass because the fold was
// never reachable in the first place.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { dominators } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { decompile } from '../src/pipeline';
import { LATCH_GATES, foldEmptyLatches } from '../src/raise/latch';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';

/** `^bb2` is the empty latch: no params, one `br` back to the header `^bb1`, carrying the update. */
const LATCH = `fn f {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %1, %2
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb3(%3)
^bb2():
  br ^bb1(%3)
^bb3(%5: s32):
  ret %5
}
`;

test('an empty latch is spliced out and its edge args ride the predecessor edge', () => {
  const fn = parse(LATCH);
  expect(foldEmptyLatches(fn)).toBe(1);
  verify(fn);
  expect(fn.blocks.length).toBe(3);
  expect(print(fn)).toContain('cond_br %4, ^bb1(%3), ^bb2(%3)');
});

test('a PREHEADER is the same empty block and is refused — it dominates the header, not the reverse', () => {
  // ^bb1 guards the loop; ^bb2 is the empty preheader feeding the self-looping header ^bb3 its init.
  const fn = parse(`fn g {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_slt %1, %0
  cond_br %2, ^bb2(), ^bb3(%1)
^bb2():
  br ^bb1(%1)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: u32 = icmp_slt %5, %0
  cond_br %6, ^bb1(%5), ^bb3(%5)
^bb3(%7: s32):
  ret %7
}
`);
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('an inner PREHEADER inside an outer loop is refused — its guard would be dropped', () => {
  // ^bb2 is the inner loop's preheader. The inner header ^bb3 REACHES it, round the outer back-edge
  // ^bb4 → ^bb1 → ^bb2, so a reachability-gated fold eats it and hands the structurer the
  // guard-fused shape. Dominance refuses: ^bb2 dominates ^bb3, not the reverse. This is the case
  // that makes the gate DOMINANCE and not `reaches` — the flat preheader above is refused by both.
  const fn = parse(`fn nest {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_slt %1, %0
  cond_br %3, ^bb2(), ^bb5(%1)
^bb2():
  br ^bb3(%2)
^bb3(%4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %4, %5
  %7: u32 = icmp_slt %6, %0
  cond_br %7, ^bb3(%6), ^bb4()
^bb4():
  %8: s32 = const {value=1}
  %9: s32 = add %1, %8
  br ^bb1(%9)
^bb5(%10: s32):
  ret %10
}
`);
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('a block branching to ITSELF is refused — every block dominates itself', () => {
  const fn = parse(`fn h {
^bb0(%0: s32):
  br ^bb1()
^bb1():
  br ^bb1()
}
`);
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('a latch with a param is refused — its args are a join, not this edge’s copy', () => {
  const fn = parse(
    LATCH.replace('^bb2():\n  br ^bb1(%3)', '^bb2(%6: s32):\n  br ^bb1(%6)').replace('^bb2(), ', '^bb2(%3), '),
  );
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('a latch that does WORK is refused — the ops would be lost with the block', () => {
  const fn = parse(LATCH.replace('^bb2():\n  br ^bb1(%3)', '^bb2():\n  %6: s32 = const {value=9}\n  br ^bb1(%6)'));
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('a latch holding a STORE is refused — nothing downstream would notice it vanish', () => {
  // The refusal that is genuinely SOUND rather than merely better, and the fixture has to be a
  // side-effecting op with no result. Drop a value-producing one and `verify` catches the dangling
  // value; drop a `store` and nothing does — `assertEffectsPreserved` tallies `call` and `opaque`
  // only, so the write is simply gone from the emitted C.
  const fn = parse(LATCH.replace('^bb2():\n  br ^bb1(%3)', '^bb2():\n  store %0, %3 {off=0, width=4}\n  br ^bb1(%3)'));
  expect(foldEmptyLatches(fn)).toBe(0);
  expect(print(fn)).toContain('store %0, %3');
});

test('chained latches fold to a fixpoint, and every removal keeps dominance sound', () => {
  const fn = parse(`fn k {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %1, %2
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb4(%3)
^bb2():
  br ^bb3()
^bb3():
  br ^bb1(%3)
^bb4(%5: s32):
  ret %5
}
`);
  expect(foldEmptyLatches(fn)).toBe(2);
  verify(fn);
  expect(fn.blocks.length).toBe(3);
  // ^bb2 was not a latch on entry — its target ^bb3 does not dominate it. It becomes one only once
  // ^bb3 is gone, which is what iterating to a fixpoint buys.
  expect(print(fn)).toContain('cond_br %4, ^bb1(%3), ^bb2(%3)');
});

test('two edges into one block after a fold: loop recovery still declines, it does not emit', () => {
  // ^bb2's predecessor ^bb1 already branches to the target ^bb1, so folding leaves a terminator with
  // both edges continuing the loop — a block with no exit, which loop recovery refuses either way.
  const fn = parse(`fn dup {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %1, %2
  %4: s32 = const {value=2}
  %5: s32 = add %1, %4
  %6: u32 = icmp_slt %3, %0
  cond_br %6, ^bb1(%3), ^bb2()
^bb2():
  br ^bb1(%5)
}
`);
  expect(foldEmptyLatches(fn)).toBe(1);
  verify(fn); // the args are still dominating defs — the fold cannot break SSA
  expect(print(fn)).toContain('cond_br %6, ^bb1(%3), ^bb1(%5)');
  expect(() => structure(fn, { returnsVoid: true, littleEndian: true })).toThrow(/unrecovered back-edge/);
});

test('dominators: a latch is dominated by its header, a preheader is not', () => {
  const fn = parse(LATCH);
  const dom = dominators(fn);
  const [entry, header, latch] = fn.blocks;
  expect(dom.get(latch)!.has(header)).toBe(true);
  expect(dom.get(header)!.has(latch)).toBe(false);
  expect(dom.get(header)!.has(entry)).toBe(true);
});

// THE POSITIVE CONTROL for the dominance gate, run through the emitter rather than through a fold
// count alone — and because the gates are a table, the ablation is a value passed to the real
// pass, not a test-only branch inside it. Two layers stand between this fold and a dropped guard:
// this gate refuses to fold the preheader (the guard's cond_br never takes the fusable shape), and
// the guarded-self-loop emitter's own guard proof refuses to fuse an unproven guard (it survives
// as its `if` around a `do-while`). Ablating the first layer must land in the second — the guard
// stays in the C either way.
test('ablating the dominance gate hands a guard to the kept-guard loop emitter', () => {
  // The guard tests `a0 != 0`; the loop tests `v < a0`. They are different predicates, so a fusion
  // admitted on shape alone would delete the guard outright.
  const IR = `fn g {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb2(), ^bb3(%1)
^bb2():
  br ^bb1(%1)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: u32 = icmp_slt %5, %0
  cond_br %6, ^bb1(%5), ^bb3(%5)
^bb3(%7: s32):
  ret %7
}
`;
  const emit = (fn: ReturnType<typeof parse>) =>
    cBackend.emit(structure(fn, { returnsVoid: false, littleEndian: true }));

  const kept = parse(IR);
  expect(foldEmptyLatches(kept)).toBe(0);
  // the asm branches on `a0 != 0`; the guard is two-armed and joined, so the default joined sense
  // emits the negation with the arms swapped
  expect(emit(kept)).toContain('a0 == 0');

  const ablated = parse(IR);
  expect(foldEmptyLatches(ablated, without(LATCH_GATES, 'target-dominates'))).toBe(1);
  // at a0 = -5 the asm returns 1; a fused `while (v0 < a0)` would return 0
  const c = emit(ablated);
  expect(c).toContain('a0 != 0'); // the guard survives the fold — one-armed here, so the asm's own sense
  expect(c).toContain('do {'); // as the kept-guard form — the second layer, not a lucky no-fuse
});

// THE WIRING. Every test above calls `foldEmptyLatches` directly, so deleting the call in
// `pipeline.ts` leaves all of them green. This one goes in as Thumb asm and out as C, on the free-
// list walk the pass was built for: `add r3, r0, #0` is the register copy SSA turns into an edge
// argument, leaving `b .L6` alone in its block. Without the fold the whole function declines with
// "unrecovered back-edge".
test('the pass is WIRED: a trampoline latch structures end to end', () => {
  const asm = [
    'f:',
    '\tpush\t{r4, lr}',
    '\tadd\tr2, r1, #0',
    '\tldr\tr3, [r0]',
    '.L6:',
    '\tldr\tr1, [r3, #0x4]',
    '\tcmp\tr2, r1',
    '\tbhi\t.L7',
    '\tcmp\tr2, r1',
    '\tbne\t.L8',
    '\tadd\tr0, r3, #0',
    '\tb\t.L13',
    '.L8:',
    '\tadd\tr0, r2, #0',
    '\tadd\tr0, r0, #0x8',
    '\tcmp\tr0, r1',
    '\tbgt\t.L7',
    '\tadd\tr0, r3, #0',
    '\tb\t.L13',
    '.L7:',
    '\tldr\tr0, [r3]',
    '\tcmp\tr0, #0',
    '\tbeq\t.L3',
    '\tadd\tr3, r0, #0',
    '\tb\t.L6',
    '.L3:',
    '\tmov\tr0, #0',
    '.L13:',
    '\tpop\t{r4}',
    '\tpop\t{r1}',
    '\tbx\tr1',
  ].join('\n');
  expect(decompile('f', asm, ARMV4T_AGBCC).source).toContain('} while (v0 != 0);');
});

// ── the write-order record rides the fold ─────────────────────────────────────────────────────
// The latch's copies became edge args, so the builder's write-order record (ir/core.ts
// `WriteOrder`) names them under the LATCH. Once the edge is re-pointed the copies happen at the end
// of the predecessor, after that block's own writes — and the record must say so, or the folded edge
// sorts the latch's copy as if it were written before everything the predecessor wrote.
const withOrder = (fn: ReturnType<typeof parse>, lastWrite: [number, number, number][], writes: [number, number][]) => {
  fn.writeOrder = {
    lastWrite: new Map(lastWrite.map(([b, i, at]) => [fn.blocks[b], new Map([[fn.blocks[1].params[i], at]])] as const)),
    writes: new Map(writes.map(([b, n]) => [fn.blocks[b], n] as const)),
  };
  return fn;
};

test("a folded latch's copy is recorded AFTER the predecessor's own writes", () => {
  // the latch (^bb2) wrote the header's key once (ordinal 0); ^bb1 made three writes of its own
  const fn = withOrder(
    parse(LATCH),
    [[2, 0, 0]],
    [
      [1, 3],
      [2, 1],
    ],
  );
  const [, header] = fn.blocks;
  const [phi] = header.params;
  expect(foldEmptyLatches(fn)).toBe(1);
  expect(fn.writeOrder!.lastWrite.get(header)!.get(phi)).toBe(3);
  expect(fn.writeOrder!.writes.get(header)).toBe(4);
});

test("a latch that wrote nothing leaves the predecessor's records as they were", () => {
  const fn = withOrder(
    parse(LATCH),
    [[1, 0, 1]],
    [
      [1, 3],
      [2, 0],
    ],
  );
  const [, header] = fn.blocks;
  const [phi] = header.params;
  expect(foldEmptyLatches(fn)).toBe(1);
  expect(fn.writeOrder!.lastWrite.get(header)!.get(phi)).toBe(1);
  expect(fn.writeOrder!.writes.get(header)).toBe(3);
});

test('an UNMEASURED predecessor takes no record — the fold refuses to invent its write count', () => {
  const fn = withOrder(parse(LATCH), [[2, 0, 0]], [[2, 1]]);
  const [, header] = fn.blocks;
  expect(foldEmptyLatches(fn)).toBe(1);
  expect(fn.writeOrder!.lastWrite.get(header)).toBeUndefined();
  expect(fn.writeOrder!.writes.has(header)).toBe(false);
});
