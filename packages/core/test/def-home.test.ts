// DEF-BLOCK PLACEMENT for memory reads (structure.ts `readsStayWhereWritten`, declared per
// compiler in TargetDescription.compilerBehaviors). WHERE the read happens, not where the value
// lives: a read whose every render sits in a block its own block STRICTLY DOMINATES emits as a
// named temp in its own block, instead of sinking and being re-read per arm.
//
// Not a differ-refereed axis. On a compiler that neither hoists a read to a dominator nor
// schedules one across a branch, asm placement is a FUNCTION of source placement — the sunk
// spelling is one that compiler could not have emitted from this asm — so there is nothing to
// referee. agbcc is such a compiler at -O2 (no sched.c/reorg.c in its SRCS; gcse.c runs
// one_code_hoisting_pass only under `optimize_size`); every other target leaves the field absent
// and the rule stands down.
//
// What these tests pin is the SCOPE: one render is enough (a "2+ sibling arms" rule would miss
// the short-circuit-into-a-call shape), renders in the def's own block are not this rule's
// business, and four refusals hold — address cones, multi-block loop-header seats, the loop
// PREHEADER (where loop invariant motion parks a read), and the right operand of a `&&`/`||`
// (where raise/shortcircuit.ts parks one).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC, structureOptionsFor } from '../src/target';

const emit = (ir: string, on: boolean, returnsVoid = true): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { readsStayWhereWritten: on, returnsVoid }));
};

const count = (s: string, needle: string): number => s.split(needle).length - 1;

// ── the isolate: one absolute byte read, two sibling arms ────────────────────────────────────
// `u32 s = *gKind; if (c & 1) *gOutA = s << 3; else *gOutB = s << 4;` — the benchmark's
// synthetic:readshare:agbcc row. Nothing writes between the read and either arm, so the
// multi-render barrier scan lets it sink and each arm re-reads it (a second ldrb AND a second
// pool word for the folded address, which agbcc emits and the once-above spelling does not).
const READSHARE = `fn readshare {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  %3: u32 = const {value=1}
  %4: u32 = and %0, %3
  %5: u32 = const {value=0}
  %6: u32 = icmp_ne %4, %5
  cond_br %6, ^bb1(), ^bb2()
^bb1():
  %7: u32 = const {value=3}
  %8: u32 = shl %2, %7
  %9: u32 = const {value=50340416}
  store %9, %8 {off=0, width=4}
  br ^bb3()
^bb2():
  %10: u32 = const {value=4}
  %11: u32 = shl %2, %10
  %12: u32 = const {value=50340420}
  store %12, %11 {off=0, width=4}
  br ^bb3()
^bb3():
  ret
}
`;

test('a read every render strictly dominates emits in its own block, once', () => {
  const on = emit(READSHARE, true);
  expect(count(on, '*(u8 *)134576844')).toBe(1);
  // and it lands ABOVE the branch, not inside an arm
  expect(on.indexOf('134576844')).toBeLessThan(on.indexOf('if ('));
});

test('without the compiler fact the same read sinks and is re-read per arm', () => {
  const off = emit(READSHARE, false);
  expect(count(off, '*(u8 *)134576844')).toBe(2);
  expect(off).not.toMatch(/= \*\(u8 \*\)134576844;/);
});

// ── the shape a "2+ sibling arms" rule would miss ────────────────────────────────────────────
// synthetic:readcall:agbcc: ONE consumer, inside a short-circuit's right operand, feeding a call
// argument. Keyed on strict dominance this is the same fact as the two-armed shape.
const READCALL = `fn readcall {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  %3: u32 = const {value=50340400}
  %4: u32 = load %3 {off=0, signed=false, width=1}
  %5: u32 = const {value=1}
  %6: u32 = and %4, %5
  %7: u32 = const {value=0}
  %8: u32 = icmp_ne %6, %7
  cond_br %8, ^bb1(), ^bb3()
^bb1():
  %9: u32 = const {value=2}
  %10: u32 = icmp_eq %0, %9
  cond_br %10, ^bb2(), ^bb3()
^bb2():
  %11: u32 = const {value=3}
  %12: u32 = shl %2, %11
  %13: s32 = call %12 {target="decomp"}
  br ^bb3()
^bb3():
  ret
}
`;

test('a single render in a strictly-dominated block is enough', () => {
  const on = emit(READCALL, true);
  expect(on).toMatch(/= \*\(u8 \*\)134576844;/);
  expect(count(on, '134576844')).toBe(1);
  expect(emit(READCALL, false)).not.toMatch(/= \*\(u8 \*\)134576844;/);
});

// ── not this rule's business: a render in the def's OWN block ────────────────────────────────
// The rule reads block-level evidence only, so a read whose consumer sits beside it says nothing
// about placement and must come out byte-identical either way (`x !== b` in the predicate).
const SAMEBLOCK = `fn sameblock {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  %3: u32 = const {value=3}
  %4: u32 = shl %2, %3
  %5: u32 = const {value=50340416}
  store %5, %4 {off=0, width=4}
  ret
}
`;

test('a read rendered in its own block is untouched', () => {
  expect(emit(SAMEBLOCK, true)).toBe(emit(SAMEBLOCK, false));
  expect(emit(SAMEBLOCK, true)).not.toMatch(/u32 v\d+;/);
});

// ── the refusal: a loop PREHEADER ────────────────────────────────────────────────────────────
// Loop invariant motion (loop.c) DOES run at -O2, and it is the one pass that still moves a read
// to a dominator. Compiled, `for (i=0;i<n;i++) t += *gK * i;` puts the read in the block AFTER the
// loop guard (`cmp/bge` then `ldr r0,.L8; ldr r4,[r0]`), while the read written above the loop
// lands ABOVE the guard. So a read seated in the preheader is evidence of a read in the BODY, and
// homing it there would spell the one source this asm rules out.
const PREHEADER = `fn preheader {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_slt %1, %0
  cond_br %2, ^bb1(), ^bb4(%1)
^bb1():
  %3: u32 = const {value=50339840}
  %4: s32 = load %3 {off=0, signed=true, width=4}
  br ^bb2(%1, %1)
^bb2(%5: s32, %6: s32):
  %7: s32 = mul %5, %4
  %8: s32 = add %6, %7
  %9: s32 = const {value=1}
  %10: s32 = add %5, %9
  %11: u32 = icmp_slt %10, %0
  cond_br %11, ^bb2(%10, %8), ^bb4(%8)
^bb4(%12: s32):
  %13: u32 = const {value=50340416}
  store %13, %12 {off=0, width=4}
  ret
}
`;

test('a read seated in the preheader of the loop it renders in is refused', () => {
  const on = emit(PREHEADER, true);
  expect(on).toBe(emit(PREHEADER, false));
  expect(on).not.toMatch(/= \*\(s32 \*\)50339840;/);
});

// The refusal is the PREHEADER, not "a loop lies between": the same read one block further up is
// beyond loop invariant motion's reach (it hoists to the immediate preheader), so it keeps the
// rule. Same CFG with an extra straight-line block carrying the read.
const ABOVEPRE = `fn abovepre {
^bb0(%0: s32):
  %1: u32 = const {value=50339840}
  %2: s32 = load %1 {off=0, signed=true, width=4}
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(), ^bb4(%3)
^bb1():
  br ^bb2(%3, %3)
^bb2(%5: s32, %6: s32):
  %7: s32 = mul %5, %2
  %8: s32 = add %6, %7
  %9: s32 = const {value=1}
  %10: s32 = add %5, %9
  %11: u32 = icmp_slt %10, %0
  cond_br %11, ^bb2(%10, %8), ^bb4(%8)
^bb4(%12: s32):
  %13: u32 = const {value=50340416}
  store %13, %12 {off=0, width=4}
  ret
}
`;

test('a read above the loop guard, not in the preheader, still homes at its def block', () => {
  expect(emit(ABOVEPRE, true)).toMatch(/= \*\(s32 \*\)50339840;/);
  expect(emit(ABOVEPRE, false)).not.toMatch(/= \*\(s32 \*\)50339840;/);
});

// ── the two inherited refusals ───────────────────────────────────────────────────────────────
// An address CONE: rendered standalone an `&g + i` loses the memAccess's inline byte-stride cast,
// so every homing rule refuses it (the cast-aware base machinery in l3/ serves those instead).
const CONE = `fn cone {
^bb0(%0: u32):
  %1: u16* = gaddr {sym="gTable"}
  %2: u32 = load %1 {off=0, signed=false, width=2}
  %3: u32 = const {value=1}
  %4: u32 = and %0, %3
  %5: u32 = const {value=0}
  %6: u32 = icmp_ne %4, %5
  cond_br %6, ^bb1(), ^bb2()
^bb1():
  %7: u32 = const {value=50340416}
  store %7, %2 {off=0, width=4}
  br ^bb3()
^bb2():
  %8: u32 = const {value=50340420}
  store %8, %2 {off=0, width=4}
  br ^bb3()
^bb3():
  ret
}
`;

test('a read through a gaddr cone is refused', () => {
  expect(emit(CONE, true)).toBe(emit(CONE, false));
});

// A MULTI-BLOCK LOOP HEADER seat: a test-at-top `while`'s condition has no seat for a
// materialized temp, so homing there trades a structuring function for a decline — the same
// refusal /addr-home, /expr-home and the live-across-a-loop rule already make.
const HEADERSEAT = `fn headerseat {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = const {value=50339840}
  %4: s32 = load %3 {off=0, signed=true, width=4}
  %5: u32 = icmp_slt %2, %0
  cond_br %5, ^bb2(), ^bb3()
^bb2():
  %6: s32 = const {value=3}
  %7: s32 = shl %4, %6
  %8: u32 = const {value=50340416}
  store %8, %7 {off=0, width=4}
  %9: s32 = const {value=1}
  %10: s32 = add %2, %9
  br ^bb1(%10)
^bb3():
  ret
}
`;

test('a read seated in a multi-block loop header is refused', () => {
  expect(emit(HEADERSEAT, true)).toBe(emit(HEADERSEAT, false));
});

// ── the per-compiler scoping ─────────────────────────────────────────────────────────────────
// The behavior was established for agbcc by reading its pass list and compiling the pair; the
// other three compilers all HAVE a scheduler and none has been put through that pair, so they
// leave it absent and the rule stands down rather than inheriting agbcc's evidence.
test('only the compiler shown the evidence declares the behavior', () => {
  expect(structureOptionsFor(ARMV4T_AGBCC, false).readsStayWhereWritten).toBe(true);
  expect(structureOptionsFor(MIPS_IDO, false).readsStayWhereWritten).toBeUndefined();
  expect(structureOptionsFor(PPC_MWCC, false).readsStayWhereWritten).toBeUndefined();
});

// ── the refusal: a read C evaluates only under a `&&`/`||` ───────────────────────────────────
// raise/shortcircuit.ts recovers a connective by hoisting the guarded arm's whole pure body —
// memory reads included — into the block ABOVE the branch (both its value form and its
// control-flow form do). ir/opcodes.ts states the safety argument in so many words: a read is
// deliberately not HOIST_UNSAFE because the structurer inlines it back into the `&&`/`||`
// right-hand side, where C's own short circuit re-guards it. So for a value in that cone the IR's
// def block is a FOLD ARTIFACT, not the block the asm read in, and naming it there dereferences
// past the guard the asm respected.
//
// The IR below is what `decompile()` recovers from agbcc -O2's own output for
// `s32 sc9(s32 *p) { return (p != 0) && (*p != 0); }` — asm `cmp r0,#0 / beq .L3 / ldr r1,[r0]`,
// so the `ldr` runs only when r0 != 0. Note the render block is a bare `ret` forwarding block: it
// is that cosmetic CFG seam, not an asm block boundary, that makes the dominance test true.
const SCGUARD = `fn sc9 {
^bb0(%0: s32*):
  %1: s32 = const {value=0}
  %2: s32 = load %0 {off=0, signed=true, width=4}
  %3: s32 = const {value=0}
  %4: u32 = icmp_ne %2, %3
  %5: u32 = icmp_ne %0, %1
  %6: s32 = logic_and %5, %4
  br ^bb1()
^bb1():
  ret %6
}
`;

test('a read inside a short-circuit right operand is refused', () => {
  const on = emit(SCGUARD, true, false);
  expect(on).toBe(emit(SCGUARD, false, false));
  expect(on).toContain('return a0 != 0 && *a0 != 0;');
  expect(on).not.toMatch(/v\d+ = \*a0;/); // never a statement above the guard
});
