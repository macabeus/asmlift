// DEF-BLOCK PLACEMENT for memory reads (structure.ts `readsStayWhereWritten`, declared per
// compiler in TargetDescription.compilerBehaviors). WHERE the read happens, not where the value
// lives: a read whose every render sits in a block its own block STRICTLY DOMINATES emits as a
// named temp in its own block, instead of sinking and being re-read per arm.
//
// Not a differ-refereed axis: where the compiler neither hoists a read to a dominator nor
// schedules one across a branch, the sunk spelling is one it could not have emitted from this asm.
// agbcc is such a compiler at -O2; the evidence, and what a compiler owes before declaring it, is
// at TargetDescription.compilerBehaviors.
//
// What these tests pin is the SCOPE: one render is enough (a "2+ sibling arms" rule would miss
// the short-circuit-into-a-call shape), renders in the def's own block are not this rule's
// business, and five refusals hold — a multi-block loop-header seat, a fall-through seam (no
// branch between read and render), the loop PREHEADER (where loop invariant motion parks a read),
// the right operand of a `&&`/`||` (where raise/shortcircuit.ts parks one), and a read that is
// only a block parameter's incoming copy.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC, structureOptionsFor } from '../src/target';

const emit = (ir: string, on: boolean, returnsVoid = true, rereadGlobals = false): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { readsStayWhereWritten: on, rereadGlobals, returnsVoid }));
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

// ── the refusal: a FALL-THROUGH seam, where no branch separates read from render ─────────────
// The IR below is what `decompile()` recovers from klonoa's StreamCmd_SetMusicParams, whose `.s`
// carries a stray `sub_0804E9AC:` between the last `ldrh` and the `bl` that consumes it — a label
// nothing branches to, which splits one straight line of asm into a dominating pair of blocks.
// Compiled and assembled, the inlined read reproduces the object byte for byte (104 of 104) and
// the named one misses by four.
const SEAM = `fn seam {
^bb0():
  %0: u16* = const {value=50352656}
  %1: s32 = load %0 {off=0, signed=false, width=2}
  br ^bb1()
^bb1():
  %2: s32 = const {value=50357936}
  %3: s32 = const {value=255}
  %4: s32 = call %2, %3, %1 {target="m4aMPlayVolumeControl"}
  ret
}
`;

test('a read whose render only a fall-through separates from it is refused', () => {
  const on = emit(SEAM, true);
  expect(on).toBe(emit(SEAM, false));
  expect(on).toContain('m4aMPlayVolumeControl(50357936, 255, *(u16 *)50352656);');
});

// The refusal is "no branch between", not "the def block does not itself branch": a seam ABOVE a
// real branch keeps the rule, because the divergence still lies between the read and both renders.
const SEAMTHENBRANCH = `fn seamthenbranch {
^bb0(%0: u32):
  %1: u32 = const {value=134576844}
  %2: u32 = load %1 {off=0, signed=false, width=1}
  br ^bb1()
^bb1():
  %3: u32 = const {value=1}
  %4: u32 = and %0, %3
  %5: u32 = const {value=0}
  %6: u32 = icmp_ne %4, %5
  cond_br %6, ^bb2(), ^bb3()
^bb2():
  %7: u32 = const {value=3}
  %8: u32 = shl %2, %7
  %9: u32 = const {value=50340416}
  store %9, %8 {off=0, width=4}
  br ^bb4()
^bb3():
  %10: u32 = const {value=4}
  %11: u32 = shl %2, %10
  %12: u32 = const {value=50340420}
  store %12, %11 {off=0, width=4}
  br ^bb4()
^bb4():
  ret
}
`;

test('a fall-through above a real branch still homes at the def block', () => {
  expect(count(emit(SEAMTHENBRANCH, true), '134576844')).toBe(1);
  expect(count(emit(SEAMTHENBRANCH, false), '134576844')).toBe(2);
});

// ── the refusal: a loop PREHEADER ────────────────────────────────────────────────────────────
// The CFG agbcc -O2 emits for `for (i=0;i<n;i++) t += gK * i;`, where loop invariant motion parks
// the read below the loop guard — the one landing spot a source read above the loop could not
// have produced.
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

// ── a read through a NAMED global ────────────────────────────────────────────────────────────
// The rules that home an ADDRESS refuse a gaddr/laddr cone, because rendering `&g + i` standalone
// loses the memAccess's inline byte-stride cast. Homing what a load RETURNS is not that case: the
// name holds the scalar and the address stays inline at the deref. Compiled, `extern int gK; ... k
// = gK; if (c&1) A(k<<3); else B(k<<4);` and the same body with `*(int*)0x03000100` in place of gK
// emit identical code down to the one pool word, one `ldr r2,[r1]` above the `beq` — and the
// per-arm spelling of either emits two `ldr`s and two pool words.
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

test('a read through a named global homes at its def block, address still inline', () => {
  const on = emit(CONE, true);
  expect(on).toMatch(/v\d+ = gTable;/);
  expect(count(on, 'gTable')).toBe(1);
  expect(count(emit(CONE, false), 'gTable')).toBe(2);
});

// Which is where this rule and the `/reread-globals` axis meet: the axis spells a named global's
// read at each of its uses, this rule spells it once at the def block, and the rule runs first —
// so on a declaring target the axis reaches only reads whose renders sit in their own block.
test('the def-block rule pre-empts the value-home axis on a strictly dominated read', () => {
  expect(count(emit(CONE, false, true, true), 'gTable')).toBe(2);
  expect(emit(CONE, true, true, true)).toBe(emit(CONE, true));
});

// ── the inherited refusal: a MULTI-BLOCK LOOP HEADER seat ────────────────────────────────────
// A test-at-top `while`'s condition has no statement position for a materialized temp, so homing
// there trades a structuring function for a decline — the same refusal /addr-home, /expr-home and
// the live-across-a-loop rule already make.
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
// raise/shortcircuit.ts hoists a connective's guarded arm into the block above the branch, so the
// IR's def block there is a fold artifact and naming the read dereferences past the guard the asm
// respected. Two fixtures, because the seam refusal above covers the first one too.
//
// The IR below is what `decompile()` recovers from agbcc -O2's own output for
// `s32 sc9(s32 *p) { return (p != 0) && (*p != 0); }` — asm `cmp r0,#0 / beq .L3 / ldr r1,[r0]`,
// so the `ldr` runs only when r0 != 0.
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

// The same refusal where nothing else stands in its way: the connective's value is consumed once,
// past a branch of its own, so the fold's head block really is strictly dominating and separated
// by a branch. From agbcc -O2's output for
//   extern int gA;
//   void f(int *p, int c) { int t = (p != 0) && (*p != 0); if (c & 1) { gA = t; } }
// — asm `cmp r0,#0 / beq .L3 / ldr r1,[r0]`, so the `ldr` again runs only when r0 != 0.
const SCFAR = `fn f {
^bb0(%0: s32*, %1: s32):
  %2: s32 = const {value=0}
  %3: s32 = load %0 {off=0, signed=true, width=4}
  %4: s32 = const {value=0}
  %5: u32 = icmp_ne %3, %4
  %6: u32 = icmp_ne %0, %2
  %7: s32 = logic_and %6, %5
  br ^bb1()
^bb1():
  %8: s32 = const {value=1}
  %9: s32* = and %8, %1
  %10: s32 = const {value=0}
  %11: u32 = icmp_eq %9, %10
  cond_br %11, ^bb3(%9), ^bb2()
^bb2():
  %12: s32* = gaddr {sym="gA"}
  store %12, %7 {off=0, width=4}
  br ^bb3(%12)
^bb3(%13: s32*):
  ret %13
}
`;

test('a short-circuit read is refused even with a branch between it and its render', () => {
  const on = emit(SCFAR, true, false);
  expect(on).toBe(emit(SCFAR, false, false));
  expect(on).toContain('gA = a0 != 0 && *a0 != 0;');
  expect(on).not.toMatch(/v\d+ = \*a0;/);
});

// ── the refusal that holds itself: partial redundancy elimination ────────────────────────────
// agbcc's gcse.c runs `one_pre_gcse_pass` on the `else` of `if (optimize_size)`, so it DOES run at
// -O2 and it DOES move loads. Compiled,
//
//   void f(int c, int *p) { if (c) { p[0] = p[4]; } else { p[1] = 7; } p[2] = p[4]; }
//
// emits `ldr r0,[r1,#0x10]` in the then-arm AND a second one as the LAST insn of the else arm —
// a read that arm never spelled — with the merge's read deleted. So the asm's read block is not
// proof of the source's, which is why the rule's claim runs the other way (a read SPELLED in a
// block is EMITTED in it). This shape needs no refusal of its own: PRE leaves one read per
// incoming path feeding a merge parameter, so each render is in its own read's block and the
// render-position test declines. The IR below is what `decompile()` recovers from that output.
const PREINSERT = `fn f {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %0, %2
  cond_br %3, ^bb2(), ^bb1()
^bb1():
  %4: s32 = load %1 {off=16, signed=true, width=4}
  store %1, %4 {off=0, width=4}
  br ^bb3(%4)
^bb2():
  %5: s32 = const {value=7}
  store %1, %5 {off=4, width=4}
  %6: s32 = load %1 {off=16, signed=true, width=4}
  br ^bb3(%6)
^bb3(%7: s32):
  store %1, %7 {off=8, width=4}
  ret %7
}
`;

test('a read PRE inserted into a sibling arm keeps its per-arm spelling', () => {
  const on = emit(PREINSERT, true, false);
  expect(on).toBe(emit(PREINSERT, false, false));
  expect(count(on, 'a1[4]')).toBe(2); // one per arm, exactly as the asm reads it
});

// ── the other half of the scope: an `aload` ──────────────────────────────────────────────────
// The rule admits both memory reads. An `aload`'s address is a runtime index, so its per-arm cost
// is the duplicated `ldr` plus the index arithmetic rather than a second pool word — a different
// cost, the same placement fact. This is the shape carrying `synthetic:armshare:agbcc`, whose
// homed read (`kind`) lifts as an `aload` through a struct-array base.
const ALOADSHARE = `fn aloadshare {
^bb0(%0: s32*, %1: u32, %2: u32):
  %3: s32 = aload %0, %1 {elemSize=4, signed=true}
  %4: u32 = const {value=1}
  %5: u32 = and %2, %4
  %6: u32 = const {value=0}
  %7: u32 = icmp_ne %5, %6
  cond_br %7, ^bb1(), ^bb2()
^bb1():
  %8: u32 = const {value=50340416}
  store %8, %3 {off=0, width=4}
  br ^bb3()
^bb2():
  %9: u32 = const {value=50340420}
  store %9, %3 {off=0, width=4}
  br ^bb3()
^bb3():
  ret
}
`;

test('an indexed read homes at its def block too', () => {
  expect(emit(ALOADSHARE, true)).toMatch(/v\d+ = a0\[a1\];/);
  expect(count(emit(ALOADSHARE, true), 'a0[a1]')).toBe(1);
  expect(emit(ALOADSHARE, false)).not.toMatch(/v\d+ = a0\[a1\];/);
  expect(count(emit(ALOADSHARE, false), 'a0[a1]')).toBe(2);
});

// ── the refusal: the read IS a block parameter's incoming copy ───────────────────────────────
// A value whose every use is a successor ARGUMENT already has a home — the parameter. Inlined,
// the edge assignment is the read (`v1 = *gBase;`); materialized it becomes two names and a copy
// between them (`v0 = *gBase; … v1 = v0;`) where the asm loaded straight into the register the
// parameter became. That copy costs more than the placement gains: the four m4a track loops
// (m4aMPlayVolumeControl, m4aMPlayPitchControl, m4aMPlayLFOSpeedSet, FadeOutBody) are this shape,
// and homing them scored 26→33, 36→39, 28→31 and 69→73 against their own objects.
//
// The IR is what `decompile()` recovers from agbcc -O2's output for
//   void loopinit(u32 mask){ u8 *p = *gBase; s32 i = *gCount; s32 b = 1;
//     if (i > 0) { do { if (mask & b) p[19] = 3; b <<= 1; p += 80; i--; } while (i > 0); } }
// — the read really does sit above the loop guard there, so it is the SPELLING that fails.
const LOOPINIT = `fn loopinit {
^bb0(%0: s32):
  %1: s32* = const {value=50345012}
  %2: u8* = load %1 {off=0, signed=true, width=4}
  %3: s32 = const {value=4}
  %4: s32* = sub %1, %3
  %5: s32 = load %4 {off=0, signed=true, width=4}
  %6: s32 = const {value=1}
  %7: s32 = const {value=0}
  %8: u32 = icmp_sle %5, %7
  cond_br %8, ^bb5(), ^bb1()
^bb1():
  %9: s32 = const {value=3}
  br ^bb2(%6, %2, %5)
^bb2(%10: s32, %11: u8*, %12: s32):
  %13: s32 = and %0, %10
  %14: s32 = const {value=0}
  %15: u32 = icmp_eq %13, %14
  cond_br %15, ^bb4(), ^bb3()
^bb3():
  store %11, %9 {off=19, width=1}
  br ^bb4()
^bb4():
  %16: s32 = shl %10 {imm=1}
  %17: s32 = const {value=80}
  %18: u8* = add %11, %17
  %19: s32 = const {value=1}
  %20: s32 = sub %12, %19
  %21: s32 = const {value=0}
  %22: u32 = icmp_sgt %20, %21
  cond_br %22, ^bb2(%16, %18, %20), ^bb5()
^bb5():
  ret
}
`;

test('a read that only feeds a block parameter is refused', () => {
  const on = emit(LOOPINIT, true);
  expect(on).toBe(emit(LOOPINIT, false));
  expect(count(on, '(u8 *)*(s32 *)50345012')).toBe(1); // one name, no copy through a temp
});
