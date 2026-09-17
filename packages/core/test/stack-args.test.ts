// OUTGOING STACK ARGUMENTS — the words a call's arguments 5+ occupy at the bottom of this frame.
//
// agbcc's ACCUMULATE_OUTGOING_ARGS stages them at [sp,#0] upward and the CALLEE reads them, so
// nothing this function does ever reloads one. That makes them indistinguishable, by code alone,
// from a dead local — which is why consuming them needs a second witness, the callee's DECLARED
// parameter count, and why the two must agree EXACTLY before a word is consumed. Every test below
// is one way they can disagree, plus the two ways they agree.
//
// The asymmetry is deliberate and each half has its own test: "nothing extra" is judged against
// the MAY set (the weakest thing that could still be a word this call takes) and "nothing missing"
// against the MUST set (a slot the callee reads must be written on every path, or the argument is
// whatever the frame held). The must set being an intersection over predecessors is what licenses
// a tail-merged call site and refuses the same shape with one arm not storing.
import { describe, expect, test } from 'vitest';

import { lift } from '../src/frontend/thumb';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const HEAD = 'f:\n\tpush\t{r4, lr}\n';
const TAIL = (n: string) => `\tadd\tsp, sp, #${n}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
const src = (asm: string, prototypes: Record<string, { params?: number; returnsVoid?: boolean }>) =>
  decompile('f', asm, ARMV4T_AGBCC, { prototypes }).source;
const slotOffsets = (asm: string, prototypes: Record<string, { params?: number; returnsVoid?: boolean }>) =>
  [...(lift('f', asm, ARMV4T_AGBCC, prototypes).slotHomes ?? new Map()).values()]
    .flatMap((s: Set<number>) => [...s])
    .sort((a, b) => a - b);

// The shape `synthetic:stkarg` is built from: one word staged for a five-parameter callee.
const FIVE =
  HEAD +
  '\tadd\tsp, sp, #-0x4\n\tadd\tr2, r0, r1\n\tsub\tr3, r0, r1\n\tmov\tr4, r0\n\tmul\tr4, r4, r1\n\tstr\tr4, [sp]\n\tbl\tfive\n' +
  TAIL('0x4');
const P5 = { five: { params: 5 } };

describe('a licensed outgoing block becomes the call’s arguments', () => {
  test('one staged word is argument 5, not a dead local', () => {
    expect(src(FIVE, P5)).toBe('s32 f(s32 a0, s32 a1) {\n    return five(a0, a1, a0 + a1, a0 - a1, a0 * a1);\n}\n');
  });

  test('five staged words are arguments 5..9 in frame order', () => {
    // kleod's sub_0804C300 shape: the whole 0x14 frame is the block of a nine-parameter callee.
    const nine =
      HEAD +
      '\tadd\tsp, sp, #-0x14\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tstr\tr0, [sp, #0x8]\n' +
      '\tstr\tr1, [sp, #0xc]\n\tstr\tr0, [sp, #0x10]\n\tbl\tnine\n' +
      TAIL('0x14');
    expect(src(nine, { nine: { params: 9 } })).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3) {\n    return nine(a0, a1, a2, a3, a0, a1, a0, a1, a0);\n}\n',
    );
  });

  test('a TAIL-MERGED call site is licensed: the must set is an intersection over predecessors', () => {
    // agbcc does tail-merge — sa3's `Task_BonusFlower_Spawn` stores argument 5 in both
    // predecessors with the `bl` in the join. Per-block scanning let a LABEL decide this.
    const merged =
      HEAD +
      '\tadd\tsp, sp, #-0x4\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tstr\tr0, [sp]\n\tb\t.L2\n.L1:\n\tstr\tr1, [sp]\n.L2:\n\tbl\tfive\n' +
      TAIL('0x4');
    expect(src(merged, P5)).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3) {\n    s32 v0;\n    if (a0 != 0) {\n        v0 = a0;\n    } else {\n        v0 = a1;\n    }\n    return five(a0, a1, a2, a3, v0);\n}\n',
    );
  });
});

describe('the two witnesses must agree, and a disagreement declines naming what it saw', () => {
  test('a word the declaration does not account for refuses — the variadic hole', () => {
    // `sprintf` truthfully declares two and is handed six: a declared parameter list is a LOWER
    // bound on the words a call pushes (multi-word parameters, a variadic tail, a hidden
    // struct-return pointer), so an arity-only acceptance deleted the words it did not cover.
    const extra = HEAD + '\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tbl\tfive\n' + TAIL('0x8');
    expect(() => src(extra, P5)).toThrow(/block is \[sp,#0\] — but \[sp,#4\] also reaches the call unread/);
  });

  test('a word the code never stages refuses rather than reading uninitialised frame', () => {
    const short = HEAD + '\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tbl\tsix\n' + TAIL('0x8');
    expect(() => src(short, { six: { params: 6 } })).toThrow(/\[sp,#4\] is not stored on every path to the call/);
  });

  test('…and a word stored on ONE arm of a branch is not stored on every path', () => {
    // The same fixture as the licensed tail-merge above with one arm’s store removed. What the
    // callee would read on the other path is whatever the frame held, which is a GAP — and a gap
    // must refuse, never render as a plausible value (m2c’s `Unable to find stack arg 0x0`).
    const oneArm =
      HEAD + '\tadd\tsp, sp, #-0x4\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp]\n.L2:\n\tbl\tfive\n' + TAIL('0x4');
    expect(() => src(oneArm, P5)).toThrow(/\[sp,#0\] is not stored on every path to the call/);
  });

  test('a one-word frame cannot be both a callee’s argument slot and an addressable local', () => {
    const both = HEAD + '\tadd\tsp, sp, #-0x4\n\tstr\tr4, [sp]\n\tbl\tfive\n\tmov\tr0, sp\n\tbl\tuse\n' + TAIL('0x4');
    expect(() => src(both, { ...P5, use: { params: 1, returnsVoid: true } })).toThrow(
      /one-word frame is an object whose address is passed to a callee, and the two name the same word/,
    );
  });

  test('a store into the licensed area that no call reads refuses instead of dropping', () => {
    // The exemption that lets a licensed offset past condition (a) is per OFFSET, so on its own it
    // would also excuse a write into the argument area that reaches a return still pending.
    const leftover =
      HEAD +
      '\tadd\tsp, sp, #-0x4\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tstr\tr0, [sp]\n\tbl\tfive\n\tb\t.L2\n.L1:\n\tstr\tr1, [sp]\n.L2:\n' +
      TAIL('0x4');
    expect(() => src(leftover, P5)).toThrow(/reaches a return unconsumed/);
  });
});

describe('an argument slot is owned storage that this function does not DECLARE', () => {
  // `LiveInModel.declaredLocals` feeds `ir/core.ts` SlotHomes, which `l3/slotorder.ts` orders the
  // declaration list by. An argument slot's offset is an ABI POSITION, not an `expand_decl` rank,
  // so consuming a block without narrowing the range would start minting declaration ranks out of
  // argument slots with no diagnostic. Measured by ablation: with the range left at
  // `[0, localArea)` these same four fixtures stamp [0], [0,4,8,12,16], [0,0,0] and [0,4].
  test('a licensed block is stamped nowhere', () => {
    expect(slotOffsets(FIVE, P5)).toEqual([]);
  });

  test('a real spill ABOVE the block keeps its rank, and the block takes none', () => {
    const spillAbove =
      HEAD +
      '\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp, #0x4]\n\tldr\tr4, [sp, #0x4]\n\tstr\tr4, [sp]\n\tbl\tfive\n' +
      TAIL('0x8');
    expect(src(spillAbove, P5)).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3) {\n    return five(a0, a1, a2, a3, a0);\n}\n',
    );
    expect(slotOffsets(spillAbove, P5)).toEqual([4]);
  });
});
