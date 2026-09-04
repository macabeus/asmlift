// BYTE-GOLDENS for the structurer's mutable-state machinery — the paths a structure.ts refactor
// is riskiest on and that no other offline test byte-pins. Each fixture exists to exercise ONE
// specific piece of shared dynamic state inside structure():
//
//   • POST_LOOP_USE      — the `withSub` exit-region substitution: a post-loop computation must
//                          read the loop variable by its HEADER name (activeSub, prev === null).
//   • SEQUENTIAL_LOOPS   — a second loop INSIDE the first loop's exit region: structuring its
//                          exit re-enters `withSub` while a substitution is already active, so
//                          the maps MERGE (activeSub, prev !== null) — the one path the corpus
//                          never hit. Post-loop code reads values from BOTH loops.
//   • SWAP_CYCLE         — a back edge that swaps two loop-carried values: the parallel copy has
//                          a cycle, so `sequentialize` must break it with a `tempCounter` temp.
//                          Pins temp naming + copy order.
//   • base-CSE + globals — hand thumb asm through the FULL decompile(): pool-loaded global
//                          recovery (frontend) + reused-base hoisting (L3) as EMITTED C, which
//                          their own test files only assert at AST/fragment level.
//
// Full-source `toBe` pins on purpose: any refactor of structure() that changes ONE byte of these
// fails here, in CI, without a toolchain in the loop.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Value } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { decompile, raiseRecovered, structureChecked } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// while (i < n) i++; return i + n — the exit region COMPUTES with the loop value, so the
// substitution must spell it as the header var, not a stale SSA name.
const POST_LOOP_USE = `fn postloopuse {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(%2), ^bb3(%2)
^bb2(%4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %4, %5
  br ^bb1(%6)
^bb3(%7: s32):
  %8: s32 = add %7, %0
  ret %8
}
`;

test('post-loop use of the loop variable reads its header name (withSub substitution)', () => {
  expect(emit(POST_LOOP_USE)).toBe(
    's32 postloopuse(s32 a0) {\n    s32 v0;\n    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n    }\n' +
      '    return v0 + a0;\n}\n',
  );
});

// Loop A (i counts to n), then IN A'S EXIT REGION loop B (j += 2 up to i), then a return reading
// BOTH final values. B's exit-region withSub nests inside A's → the substitution maps merge.
const SEQUENTIAL_LOOPS = `fn twoloops {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(%2), ^bb3(%2)
^bb2(%4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %4, %5
  br ^bb1(%6)
^bb3(%7: s32):
  %8: s32 = const {value=0}
  br ^bb4(%8)
^bb4(%9: s32):
  %10: u32 = icmp_slt %9, %7
  cond_br %10, ^bb5(%9), ^bb6(%9)
^bb5(%11: s32):
  %12: s32 = const {value=2}
  %13: s32 = add %11, %12
  br ^bb4(%13)
^bb6(%14: s32):
  %15: s32 = add %14, %7
  ret %15
}
`;

test("a loop inside another loop's exit region merges the two substitutions (nested withSub)", () => {
  // `return v1 + v0` is the point: the merged map must resolve BOTH loop A's value (v0, from the
  // outer substitution) and loop B's (v1, from the inner) in one exit-region expression.
  expect(emit(SEQUENTIAL_LOOPS)).toBe(
    's32 twoloops(s32 a0) {\n    s32 v0;\n    s32 v1;\n' +
      '    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n    }\n' +
      '    for (v1 = 0; v1 < v0; v1 = v1 + 2) {\n    }\n' +
      '    return v1 + v0;\n}\n',
  );
});

// while (k < 10) { swap(a, b); k++; } return a — the back edge carries (b, a, k+1) against header
// params (a, b, k): the a/b copies form a cycle sequentialize must break with a temp.
const SWAP_CYCLE = `fn swapcycle {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%0, %1, %2)
^bb1(%3: s32, %4: s32, %5: s32):
  %6: s32 = const {value=10}
  %7: u32 = icmp_slt %5, %6
  cond_br %7, ^bb2(%3, %4, %5), ^bb3(%3)
^bb2(%8: s32, %9: s32, %10: s32):
  %11: s32 = const {value=1}
  %12: s32 = add %10, %11
  br ^bb1(%9, %8, %12)
^bb3(%13: s32):
  ret %13
}
`;

test('a swap-cycle back edge sequentializes through a temp (tempCounter)', () => {
  expect(emit(SWAP_CYCLE)).toBe(
    's32 swapcycle(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 t0;\n' +
      '    v0 = a0;\n    v1 = a1;\n    v2 = 0;\n    while (v2 < 10) {\n        v2 = v2 + 1;\n' +
      '        t0 = v0;\n        v0 = v1;\n        v1 = t0;\n    }\n    return v0;\n}\n',
  );
});

// The struct-arrays clean-golden shape (`p[i].a + p[i].b`, stride 8), through the pipeline's OWN
// shared spine (raiseRecovered → structureChecked) — the same stage order decompile() runs, so
// this pins the stride discriminator's emitted C, contracts and L3 passes included.
// struct-arrays-guards.test.ts only counts recognizer hits.
const STRUCT_ARRAY = `fn sget {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=0, signed=true, width=4}
  %6: s32 = load %4 {off=4, signed=false, width=2}
  %7: s32 = add %5, %6
  ret %7
}
`;

test('array-of-struct recovery, as emitted C (the shared raise spine)', () => {
  const fn = parse(STRUCT_ARRAY);
  verify(fn);
  raiseRecovered(fn, ARMV4T_AGBCC);
  const sfn = structureChecked(fn, { ...structureOptionsFor(ARMV4T_AGBCC, false), onGap: 'strict' });
  expect(cBackend.emit(sfn)).toBe(
    'struct Elem0 { s32 field_0; u16 field_4; u8 _pad0[2]; };\n' +
      's32 sget(struct Elem0 * a0, s32 a1) {\n    return a0[a1].field_0 + a0[a1].field_4;\n}\n',
  );
});

// Pool-loaded global + THREE distinct constant offsets through the same aggregate base: the
// frontend recovers `gCfg` from the pool word, and L3 base-CSE hoists the reused base into a
// typed local pointer. Emitted-C golden — basecse.test.ts/globals.test.ts stop at AST/fragments.
const BASECSE_ASM = [
  '\tldr\tr2, .L1',
  '\tmov\tr0, #0x1',
  '\tstrb\tr0, [r2]',
  '\tmov\tr0, #0x2',
  '\tstrb\tr0, [r2, #0x1]',
  '\tmov\tr0, #0x3',
  '\tstrb\tr0, [r2, #0x2]',
  '\tbx\tlr',
  '.L1:',
  '\t.word\tgCfg',
].join('\n');

test('pool-global recovery + base-CSE hoist, as emitted C (full pipeline)', () => {
  // (`return 3` is r0 live at `bx lr` under the no-proto default — faithful to the asm; pass
  // returnsVoid to suppress. The golden pins the hoist: one typed local, offsets as p0[i].)
  expect(decompile('initcfg', `initcfg:\n${BASECSE_ASM}\n`, ARMV4T_AGBCC).source).toBe(
    's32 initcfg(void) {\n    u8 * p0;\n    p0 = (u8 *)&gCfg;\n    *p0 = 1;\n    p0[1] = 2;\n' +
      '    p0[2] = 3;\n    return 3;\n}\n',
  );
});

// The SAME swap cycle with the frontend's write-order record attached (ir/core.ts `WriteOrder`):
// the latch wrote v1's register FIRST, then v0's, then v2's. `sequentialize` spills the first
// pending destination, so the record decides WHICH member becomes the temp — here v1, where the
// def-position proxy above (a param sorts before an in-block def) always picks v0. The parsed
// golden above stays as it is: a parsed Fn carries no record, and that refusal is what it pins.
test('a swap cycle with a write-order record spills the member the pred wrote first', () => {
  const fn = parse(SWAP_CYCLE);
  verify(fn);
  recoverTypes(fn);
  const [, header, latch] = fn.blocks;
  const [v0, v1, v2] = header.params;
  fn.writeOrder = {
    lastWrite: new Map([
      [
        latch,
        new Map([
          [v1, 0],
          [v0, 1],
          [v2, 2],
        ]),
      ],
    ]),
    writes: new Map([[latch, 3]]),
  };
  expect(cBackend.emit(structure(fn))).toBe(
    's32 swapcycle(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 t0;\n' +
      '    v0 = a0;\n    v1 = a1;\n    v2 = 0;\n    while (v2 < 10) {\n        v2 = v2 + 1;\n' +
      '        t0 = v1;\n        v1 = v0;\n        v0 = t0;\n    }\n    return v0;\n}\n',
  );
});

// The record says NOTHING about a destination the pred never wrote, and the rule does not invent
// an answer: that copy keeps the front position the def-position proxy has always given an
// argument the pred did not compute (structure.ts `NO_RECORD`). Here the latch wrote only v0's and
// v2's keys, so v1's copy is ordered ahead of both — and being first, v1 is the member the cycle
// spills, where the record-ordered sibling above spills v1's neighbour. (`v2 = v2 + 1` still leads
// the body: it is the one copy outside the cycle, and `sequentialize` emits every emittable copy
// before it breaks one.) Pinning an unrecorded copy at its param-order slot instead was measured
// over the 736 synthetic rows and loses four matches — armdef, loopfall, loopset, structarr, all
// agbcc, the first three of them matches before this round.
test('a destination the pred never wrote keeps the front slot, and the record orders the rest', () => {
  const fn = parse(SWAP_CYCLE);
  verify(fn);
  recoverTypes(fn);
  const [, header, latch] = fn.blocks;
  const [v0, , v2] = header.params;
  fn.writeOrder = {
    lastWrite: new Map([
      [
        latch,
        new Map([
          [v2, 0],
          [v0, 1],
        ]),
      ],
    ]),
    writes: new Map([[latch, 2]]),
  };
  expect(cBackend.emit(structure(fn))).toBe(
    's32 swapcycle(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 t0;\n' +
      '    v0 = a0;\n    v1 = a1;\n    v2 = 0;\n    while (v2 < 10) {\n        v2 = v2 + 1;\n' +
      '        t0 = v1;\n        v1 = v0;\n        v0 = t0;\n    }\n    return v0;\n}\n',
  );
});

// A MEASURED predecessor that recorded no destination of this edge is not an unmeasured one: it
// wrote registers, none of them a key this edge copies. Every copy is then a pass-through with no
// evidence, they all tie, and the param-order walk that built the list decides — NOT the
// def-position proxy, which is only reached when no frontend measured the block at all.
// THE EDGE-COPY ORDER FEEDS `recognizeForLoops`, NOT ONLY `sequentialize`. A `for` is recovered
// only when the induction update is the LAST statement of the body, so the same record that picks
// a cycle's temp also decides whether a loop is spelled `for` or `while` — and it decides it in
// both directions, which is what this pair pins. (It is why `synthetic:gcd:agbcc` is a `while`:
// agbcc wrote its dividend register last, so the modulo update is not the body's final statement.)
const FOR_ACC = `fn foracc {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1, %1, %0)
^bb1(%2: s32, %3: s32, %4: s32):
  %5: u32 = icmp_slt %3, %4
  cond_br %5, ^bb2(%2, %3, %4), ^bb3(%2)
^bb2(%6: s32, %7: s32, %8: s32):
  %9: s32 = const {value=1}
  %10: s32 = add %7, %9
  %11: s32 = add %6, %8
  br ^bb1(%11, %10, %8)
^bb3(%12: s32):
  ret %12
}`;
const forAccWith = (order: (acc: Value, ind: Value) => [Value, number][]): string => {
  const fn = parse(FOR_ACC);
  verify(fn);
  recoverTypes(fn);
  const [, header, latch] = fn.blocks;
  const [acc, ind] = header.params;
  fn.writeOrder = { lastWrite: new Map([[latch, new Map(order(acc, ind))]]), writes: new Map([[latch, 2]]) };
  return cBackend.emit(structure(fn));
};

test('a record that leaves the induction update last recovers a `for`…', () => {
  expect(
    forAccWith((acc, ind) => [
      [acc, 0],
      [ind, 1],
    ]),
  ).toBe(
    's32 foracc(s32 a0) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    v2 = a0;\n    v0 = 0;\n' +
      '    for (v1 = 0; v1 < v2; v1 = v1 + 1) {\n        v0 = v0 + v2;\n    }\n    return v0;\n}\n',
  );
});

test('…and one that moves it off the end leaves a `while`, from the same IR', () => {
  expect(
    forAccWith((acc, ind) => [
      [ind, 0],
      [acc, 1],
    ]),
  ).toBe(
    's32 foracc(s32 a0) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    v2 = a0;\n    v0 = 0;\n' +
      '    v1 = 0;\n    while (v1 < v2) {\n        v1 = v1 + 1;\n        v0 = v0 + v2;\n    }\n' +
      '    return v0;\n}\n',
  );
});

test('a measured pred that wrote none of the edge keys leaves the copies in param order', () => {
  const fn = parse(SWAP_CYCLE);
  verify(fn);
  recoverTypes(fn);
  const [, , latch] = fn.blocks;
  fn.writeOrder = { lastWrite: new Map(), writes: new Map([[latch, 4]]) };
  expect(cBackend.emit(structure(fn))).toBe(
    's32 swapcycle(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 t0;\n' +
      '    v0 = a0;\n    v1 = a1;\n    v2 = 0;\n    while (v2 < 10) {\n        v2 = v2 + 1;\n' +
      '        t0 = v0;\n        v0 = v1;\n        v1 = t0;\n    }\n    return v0;\n}\n',
  );
});
