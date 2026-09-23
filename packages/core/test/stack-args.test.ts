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
type Protos = Record<string, { params?: number | string[]; returnsVoid?: boolean }>;
const src = (asm: string, prototypes: Protos) => decompile('f', asm, ARMV4T_AGBCC, { prototypes }).source;
const slotOffsets = (asm: string, prototypes: Protos) =>
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
      /one-word frame is an object whose address escapes the function, and the two name the same word/,
    );
  });

  test('a store into the licensed area that no call reads refuses instead of dropping', () => {
    // The exemption that lets a licensed offset past condition (a) is per OFFSET, so on its own it
    // would also excuse a write into the argument area still staged where the function ends.
    const leftover =
      HEAD +
      '\tadd\tsp, sp, #-0x4\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tstr\tr0, [sp]\n\tbl\tfive\n\tb\t.L2\n.L1:\n\tstr\tr1, [sp]\n.L2:\n' +
      TAIL('0x4');
    expect(() => src(leftover, P5)).toThrow(/is still staged where this function ends/);
  });

  test('a LOAD off a licensed slot refuses — the callee owns that word across the call', () => {
    // The word is staged, the call takes it, and then this function reads the offset back. What
    // the `ldr` sees is whatever the CALLEE left there (AAPCS lets a callee assign to a stack
    // parameter), so it is a GAP — but the staging store is still its reaching def, and without
    // this refusal the `ldr` arm renders the value the CALLER passed, an `a0` standing in for an
    // unknown. Neither the per-offset exemption nor the pending-set dataflow can see it: the call
    // already consumed the offset, so the load clears nothing.
    const reload =
      HEAD + '\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tfive\n\tldr\tr1, [sp]\n\tadd\tr0, r0, r1\n' + TAIL('0x4');
    expect(() => src(reload, P5)).toThrow(
      /\[sp,#0\] is an outgoing stack-argument slot .* but this function also LOADS it/,
    );
  });

  test('…and so does a load BEFORE the staging store, on the layout the licence rests on', () => {
    // ACCUMULATE_OUTGOING_ARGS puts the locals ABOVE the area, so an offset this function loads is
    // not an argument offset. Reading it as a local AND handing it to a callee are two claims
    // about one word; the licence is the thing that would have to be wrong, so it refuses.
    const before =
      HEAD + '\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr1, [sp]\n\tstr\tr1, [sp]\n\tbl\tfive\n' + TAIL('0x4');
    expect(() => src(before, P5)).toThrow(/but this function also LOADS it/);
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

describe('the declaration must say how many WORDS, and a parameter list is parameters', () => {
  // The block is words, `declaredArgWidths` is words, and the lowering maps word k to slot
  // k - |argRegs|. A C PARAMETER COUNT is a fourth number and is the same as the other three only
  // while every parameter occupies one word — a `long long` or a by-value struct breaks it. A
  // `long long` is READ as two words; a by-value struct, a project typedef and a floating type
  // asmlift cannot size at all — `prototypesFromSymbols` drops a whole entry rather than try —
  // and a list holding one states no layout, so the block is laid out from the machine instead.
  const TWO = HEAD + '\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tbl\tfd\n' + TAIL('0x8');

  test('a declared pair the block would split refuses, naming the parameter', () => {
    // The dangerous case, because the two witnesses agree by coincidence: read for its LENGTH
    // alone, six declared parameters size a two-word block and the code stages two words, so the
    // equality holds — and consuming it hands `fd` six arguments where the fifth `long long` spans
    // both staged words (`fd(a0, a1, a0, a1, a2, a3)`). The fifth parameter's halves are both in
    // the block and the refusal names it.
    for (const params of [
      ['s32', 's32', 's32', 's32', 'long long', 's32'],
      // Same assembly, the declaration `void fd(s32, s32, s32, s32, long long)` that really
      // produced it. The word counts disagree here, so the may-set check would refuse anyway — but
      // on `[sp,#4] also reaches the call unread`, which sends a reader hunting for a store when
      // the fact to know is the parameter.
      ['s32', 's32', 's32', 's32', 'long long'],
    ]) {
      expect(() => src(TWO, { fd: { params } })).toThrow(
        /handed to `fd` outside the argument registers — its parameter 5 is 64 bits wide .* both halves are in this frame's outgoing stack block/,
      );
    }
  });

  // A SPELLING NOTHING CAN SIZE STATES NO LAYOUT, so it licenses no block and the verdict is
  // whatever this shape gets with nothing declared. DECLARING MORE MAY NOT DO LESS, and the
  // refusing direction is where that is easiest to get wrong: an earlier cut refused eagerly here
  // with a sentence naming the parameter, which read well and was a function that declined a shape
  // it lifts when told nothing — and it was off by one at the only arity where its own reason
  // applied, so the sp-as-data message it existed to pre-empt surfaced anyway.
  test('an unsizable spelling past the argument registers leaves the undeclared verdict standing', () => {
    const undeclared = () => src(TWO, {});
    expect(undeclared).toThrow(/stack pointer used as data/);
    expect(() => src(TWO, { fd: { params: ['s32', 's32', 's32', 's32', 'TaskFunc', 's32'] } })).toThrow(
      /stack pointer used as data/,
    );
    // …and a COUNT, which states argument registers directly, is what gets past it.
    expect(src(TWO, { fd: { params: 6 } })).toContain('fd(a0, a1, a2, a3, a0, a1)');
  });

  test('every spelling asmlift can width is one word, and those are consumed', () => {
    expect(src(TWO, { fd: { params: ['s32', 'u16', 'void *', 'char', 'int', 'unsigned'] } })).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3) {\n    return fd(a0, a1, a2, a3, a0, a1);\n}\n',
    );
  });

  test('a COUNT declaration carries no spellings, so it is taken at its word', () => {
    // `{ params: 6 }` states six WORDS and nothing checkable about their types — the same trust
    // `returnsVoid` gets. A count that lies is garbage in, and it is the reason the typed form is
    // the one that can be checked at all.
    expect(src(TWO, { fd: { params: 6 } })).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3) {\n    return fd(a0, a1, a2, a3, a0, a1);\n}\n',
    );
  });
});

describe('the outgoing area is a COMPILER fact the target declares', () => {
  // `compilerBehaviors.stagesOutgoingArgsInFrame` is agbcc's ACCUMULATE_OUTGOING_ARGS: arguments
  // 5+ go into an area the CALLER reserved at the bottom of its own frame. A compiler that pushes
  // them at the call site instead stages nothing inside the frame, so the licence — whose evidence
  // is an agbcc compile table — must not be inherited by a second armv4t compiler.
  test('a target that does not claim the area licenses nothing, and refuses as before', () => {
    const { stagesOutgoingArgsInFrame, ...rest } = ARMV4T_AGBCC.compilerBehaviors;
    const pushes = { ...ARMV4T_AGBCC, compilerBehaviors: rest };
    expect(stagesOutgoingArgsInFrame).toBe(true);
    expect(() => decompile('f', FIVE, pushes, { prototypes: P5 }).source).toThrow(
      /the store to \[sp,#0\] is never reloaded and its lower slots are supplied/,
    );
  });
});
