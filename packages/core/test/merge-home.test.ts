// The merge-feed-home axis (structure.ts homeMergeFeeds, rank.ts `/merge-home`): a pure value one
// join's incoming edges render into the SAME parameter slot from 2+ places materializes in the
// block that dominates them — the value the source computed once above the branch, where the
// default has no name to reference on an edge and re-derives the whole expression per arm. Off by
// default.
//
// What these tests pin is the SCOPE, since a merge slot is the whole evidence: only the MAXIMAL
// shared value homes (every node under a shared expression is itself rendered twice), only a def
// the join's every arm reaches, and the refusals hold — a value computed separately in each arm, a
// standalone address, a memory read, and a join inside a loop.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { hasMergeFeedHome } from '../src/structure/analysis';
import { structure } from '../src/structure/structure';

const emit = (ir: string, on: boolean, returnsVoid = true): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { homeMergeFeeds: on, returnsVoid }));
};

const count = (s: string, needle: string): number => s.split(needle).length - 1;

// ── the isolate: armexpr's shape ─────────────────────────────────────────────────────────────
// `s32 m = (b & 1) ? 0x400 : 0;` above an `if`, whose two arms merge it. The whole
// `neg/orr/asr #31/and` chain is one value defined in the entry block; one arm passes it through
// and the other ors a bit in, so the default renders the chain twice.
const ARMEXPR = `fn armexpr {
^bb0(%0: s32, %1: s32, %2: s32*):
  %3: s32 = const {value=1}
  %4: s32 = and %1, %3
  %5: s32 = neg %4
  %6: s32 = or %5, %4
  %7: s32 = shr_s %6 {imm=31}
  %8: s32 = const {value=128}
  %9: s32 = shl %8 {imm=3}
  %10: s32 = and %7, %9
  %11: s32 = const {value=0}
  %12: u32 = icmp_eq %0, %11
  cond_br %12, ^bb2(), ^bb1()
^bb1():
  %13: s32 = const {value=0}
  store %2, %13 {off=0, width=4}
  br ^bb3(%10)
^bb2():
  store %2, %3 {off=0, width=4}
  %14: s32 = const {value=128}
  %15: s32 = shl %14 {imm=2}
  %16: s32 = or %10, %15
  br ^bb3(%16)
^bb3(%17: s32):
  store %2, %17 {off=4, width=4}
  ret
}
`;

test('a merge-fed expression homes once above the branch', () => {
  const on = emit(ARMEXPR, true);
  expect(count(on, '>> 31')).toBe(1);
  // the home is the whole chain, and it is what the arms read
  expect(on).toMatch(/v0 = \(-\(a1 & 1\) \| a1 & 1\) >> 31 & 128 << 3;/);
  expect(on).toMatch(/v0 = v0 \| 128 << 2;/);
  expect(hasMergeFeedHome(parse(ARMEXPR))).toBe(true);
});

test('off by default: the same IR re-derives the chain in every arm', () => {
  const off = emit(ARMEXPR, false);
  expect(count(off, '>> 31')).toBe(2);
});

test('only the MAXIMAL feeder homes — one local, not one per cone node', () => {
  // every value under the chain is rendered twice too; homing all of them would spell
  // `v0 = 1; v1 = a1 & v0; …` where the source spelled one expression
  const on = emit(ARMEXPR, true);
  expect(count(on, 's32 v')).toBe(1);
});

// ── THE OVER-FIRE CONTROL: armkeep ───────────────────────────────────────────────────────────
// The same pure expression computed in BOTH arms and consumed inside each. agbcc keeps both
// copies, so hoisting is wrong here — and the axis cannot see it: the two `(b << 3) + 7`s are
// separate SSA values with per-arm defs, and the only value their cones share is a block
// PARAMETER, which has no def op to materialize.
const ARMKEEP = `fn armkeep {
^bb0(%0: s32, %1: s32, %2: s32*):
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %0, %3
  cond_br %4, ^bb2(), ^bb1()
^bb1():
  %5: s32 = shl %1 {imm=3}
  %6: s32 = const {value=7}
  %7: s32 = add %5, %6
  store %2, %7 {off=0, width=4}
  br ^bb3(%7)
^bb2():
  %8: s32 = shl %1 {imm=3}
  %9: s32 = const {value=7}
  %10: s32 = add %8, %9
  store %2, %10 {off=4, width=4}
  br ^bb3(%10)
^bb3(%11: s32):
  ret %11
}
`;

test('a value each arm computes for itself is not homed', () => {
  expect(emit(ARMKEEP, true, false)).toBe(emit(ARMKEEP, false, false));
  expect(hasMergeFeedHome(parse(ARMKEEP))).toBe(false);
});

// ── the const admission: maskchain's `s32 m = 0;` ────────────────────────────────────────────
// A const two arms of one merge carry is the ONE const a homing scope admits: every other scope
// excludes consts because a re-derived const is re-materialization, the compiler's own behavior,
// while a const held across a branch is a register it reserved (`mov r5, #0` once, not per arm).
const MERGECONST = `fn mergeconst {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: s32 = const {value=8}
  %4: s32 = and %3, %0
  %5: s32 = const {value=0}
  %6: u32 = icmp_eq %4, %5
  cond_br %6, ^bb2(), ^bb1()
^bb1():
  %7: s32 = const {value=1024}
  br ^bb3(%7)
^bb2():
  %8: s32 = const {value=4}
  %9: s32 = and %8, %0
  %10: s32 = const {value=0}
  %11: u32 = icmp_eq %9, %10
  cond_br %11, ^bb3(%2), ^bb3(%2)
^bb3(%12: s32):
  store %1, %12 {off=0, width=4}
  ret
}
`;

test('a const two of a merge slot’s edges carry homes above the branch', () => {
  const on = emit(MERGECONST, true);
  expect(count(on, '= 0;')).toBe(1);
  expect(on).toMatch(/v0 = 0;\n\s+if /);
  expect(hasMergeFeedHome(parse(MERGECONST))).toBe(true);
  expect(count(emit(MERGECONST, false), '= 0;')).toBe(2);
});

// ── refusal: a join inside a loop ────────────────────────────────────────────────────────────
// A loop-carried merge parameter's "definition above the branch" is the loop's entry initializer,
// whose placement `/defsite/loop-entry` already decides.
const LOOPJOIN = `fn loopjoin {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  br ^bb1(%2, %2)
^bb1(%3: s32, %4: s32):
  %5: s32 = const {value=1}
  %6: s32 = and %3, %5
  %7: s32 = const {value=0}
  %8: u32 = icmp_eq %6, %7
  %9: s32 = const {value=64}
  cond_br %8, ^bb3(%9), ^bb2()
^bb2():
  %10: s32 = or %9, %5
  br ^bb3(%10)
^bb3(%11: s32):
  %12: s32 = const {value=1}
  %13: s32 = add %3, %12
  %14: u32 = icmp_slt %13, %0
  store %1, %11 {off=0, width=4}
  cond_br %14, ^bb1(%13, %11), ^bb4()
^bb4():
  ret
}
`;

test('a join inside a loop is refused', () => {
  expect(emit(LOOPJOIN, true)).toBe(emit(LOOPJOIN, false));
  expect(hasMergeFeedHome(parse(LOOPJOIN))).toBe(false);
});

// ── refusal: a standalone address ────────────────────────────────────────────────────────────
// Rendered standalone an `&g + i` loses the memAccess's inline byte-stride cast, so the value
// changes; the cast-aware base machinery in l3/ serves those bases instead.
const ADDRFEED = `fn addrfeed {
^bb0(%0: s32, %1: s32*):
  %2: s32* = gaddr {sym="gTable"}
  %3: s32 = const {value=8}
  %4: s32* = add %2, %3
  %5: s32 = const {value=0}
  %6: u32 = icmp_eq %0, %5
  cond_br %6, ^bb2(), ^bb1()
^bb1():
  br ^bb3(%4)
^bb2():
  %7: s32 = const {value=4}
  %8: s32* = add %4, %7
  br ^bb3(%8)
^bb3(%9: s32*):
  %10: s32 = load %9 {off=0, signed=true, width=4}
  store %1, %10 {off=0, width=4}
  ret
}
`;

test('an address feeder is refused', () => {
  expect(emit(ADDRFEED, true)).toBe(emit(ADDRFEED, false));
  expect(hasMergeFeedHome(parse(ADDRFEED))).toBe(false);
});

// ── refusal: a memory read ───────────────────────────────────────────────────────────────────
// WHERE a read happens is the read rules' question (`/inplace`, readsStayWhereWritten): moving one
// to a dominating block runs it on paths the asm never ran it on.
const READFEED = `fn readfeed {
^bb0(%0: s32, %1: s32*):
  %2: s32 = load %1 {off=8, signed=true, width=4}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %0, %3
  cond_br %4, ^bb2(), ^bb1()
^bb1():
  br ^bb3(%2)
^bb2():
  %5: s32 = const {value=1}
  %6: s32 = or %2, %5
  br ^bb3(%6)
^bb3(%7: s32):
  store %1, %7 {off=0, width=4}
  ret
}
`;

test('a memory read feeder is refused', () => {
  const on = emit(READFEED, true);
  expect(on).toBe(emit(READFEED, false));
  expect(hasMergeFeedHome(parse(READFEED))).toBe(false);
});

// ── refusal: a shared SUBEXPRESSION no edge carries ──────────────────────────────────────────
// Both arms derive from one dominating value and neither passes it on: the value is not the merge
// variable on any path, so nothing says the compiler reserved a register for it across the branch.
// `armkeep` is the row that prices hoisting this class — agbcc keeps both copies.
const SUBEXPR = `fn subexpr {
^bb0(%0: s32, %1: s32, %2: s32*):
  %3: s32 = const {value=3}
  %4: s32 = shl %1, %3
  %5: s32 = const {value=0}
  %6: u32 = icmp_eq %0, %5
  cond_br %6, ^bb2(), ^bb1()
^bb1():
  %7: s32 = const {value=1}
  %8: s32 = or %4, %7
  br ^bb3(%8)
^bb2():
  %9: s32 = const {value=2}
  %10: s32 = or %4, %9
  br ^bb3(%10)
^bb3(%11: s32):
  store %2, %11 {off=0, width=4}
  ret
}
`;

test('a shared subexpression no edge carries is refused', () => {
  expect(emit(SUBEXPR, true)).toBe(emit(SUBEXPR, false));
  expect(hasMergeFeedHome(parse(SUBEXPR))).toBe(false);
});

// ── the COPY-SITE count: how many places the slot's edge assignments render ───────────────────
// `predecessors` lists a block once per successor EDGE, so a join two of one block's edges reach
// appears twice there; walking that against the same block's successors tallies each of those
// edges twice, and a value carried on ONE of them satisfies both halves of the evidence. These
// two pin the count against the shapes where an edge count and a render count come apart.

// One `cond_br` whose two arms both target the join, each carrying its OWN value. `%A` is the
// shared subexpression (rendered twice, carried by neither); `%X` and `%Y` render once each.
const TWOEDGE = `fn twoedge {
^bb0(%0: s32, %1: s32, %9: s32*):
  %c1: s32 = const {value=1}
  %A: s32 = and %1, %c1
  %c2: s32 = const {value=8}
  %X: s32 = or %A, %c2
  %c3: s32 = const {value=16}
  %Y: s32 = or %A, %c3
  %z: s32 = const {value=0}
  %t: u32 = icmp_eq %0, %z
  cond_br %t, ^bb3(%X), ^bb3(%Y)
^bb3(%p: s32):
  store %9, %p {off=0, width=4}
  ret
}
`;

test('a value ONE edge carries is not homed, however many edges the join has', () => {
  expect(emit(TWOEDGE, true)).toBe(emit(TWOEDGE, false));
  expect(hasMergeFeedHome(parse(TWOEDGE))).toBe(false);
});

// A `switch_br` naming the join in two table slots — `case 0: case 1:` sharing one body, which
// structure.ts's Regime B emits ONCE (and refuses outright if the two slots' args disagree). Two
// edges, ONE copy: the value is rendered once, so the duplication evidence is absent.
const SWDUP = `fn swdup {
^bb0(%0: s32, %1: s32, %9: s32*):
  %c1: s32 = const {value=1}
  %A: s32 = and %1, %c1
  %c8: s32 = const {value=8}
  %X: s32 = or %A, %c8
  switch_br %0, ^bb3(%X), ^bb3(%X), ^bb2() {cases=[0;1]}
^bb2():
  %c2: s32 = const {value=2}
  br ^bb3(%c2)
^bb3(%p: s32):
  store %9, %p {off=0, width=4}
  ret
}
`;

test('two case labels sharing one body are ONE copy site, not two', () => {
  const off = emit(SWDUP, false);
  expect(off).toMatch(/case 0:\s*\n\s+case 1:\s*\n\s+v0 = a1 & 1 \| 8;/);
  expect(emit(SWDUP, true)).toBe(off);
  expect(hasMergeFeedHome(parse(SWDUP))).toBe(false);
});

// ── refusal: a TRAPPING op ───────────────────────────────────────────────────────────────────
// `REEVAL_UNSAFE_OPS` is effects ∪ reads ∪ traps, and the divides are the traps half. Homed, a
// divide becomes an unconditional statement at its def block — which raise/shortcircuit.ts or a
// fold may have made, and which the arms' own guard no longer covers.
const DIVFEED = `fn divfeed {
^bb0(%0: s32, %1: s32, %9: s32*):
  %Q: s32 = sdiv %0, %1
  %z: s32 = const {value=0}
  %t: u32 = icmp_slt %0, %z
  cond_br %t, ^bb1(), ^bb2()
^bb1():
  br ^bb3(%Q)
^bb2():
  %c4: s32 = const {value=4}
  %Y: s32 = or %Q, %c4
  br ^bb3(%Y)
^bb3(%p: s32):
  store %9, %p {off=0, width=4}
  ret
}
`;

test('a trapping divide is refused as a feeder', () => {
  expect(emit(DIVFEED, true)).toBe(emit(DIVFEED, false));
  expect(hasMergeFeedHome(parse(DIVFEED))).toBe(false);
});

// ── refusal: an `undef` ──────────────────────────────────────────────────────────────────────
// The axis's premise is a value the source COMPUTED once above the branch. An uninitialised
// register was never computed, so homing it spells `v0 = uninit_r5;` — a copy of a value nothing
// wrote, which no asm can have.
const UNDEFFEED = `fn undeffeed {
^bb0(%0: s32, %1: s32*):
  %2: s32 = undef {key="r5"}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %0, %3
  cond_br %4, ^bb2(), ^bb1()
^bb1():
  br ^bb3(%2)
^bb2():
  %5: s32 = const {value=1}
  %6: s32 = or %2, %5
  br ^bb3(%6)
^bb3(%7: s32):
  store %1, %7 {off=0, width=4}
  ret
}
`;

test('an uninitialised register is refused as a feeder', () => {
  expect(emit(UNDEFFEED, true)).toBe(emit(UNDEFFEED, false));
  expect(hasMergeFeedHome(parse(UNDEFFEED))).toBe(false);
});

// ── refusal: a short-circuit-guarded cone holding a memory read ──────────────────────────────
// raise/shortcircuit.ts hoists the guarded arm's pure body into the block ABOVE the branch on the
// contract that the structurer inlines it back under C's own short circuit, so a value in that
// cone has a FOLD-ARTIFACT def block. Homed there it emits `v0 = *p | 1;` above `p != 0`. The
// refusal is narrowed to an ORDER-SENSITIVE cone on purpose: a pure guarded value re-spelled above
// the connective computes the same thing on the same paths (and refusing those costs
// `synthetic:modpow2:ido7.1` two points for no soundness gain).
const SCREAD = `fn scread {
^bb0(%0: s32*, %9: s32*, %8: s32):
  %L: s32 = load %0 {off=0, width=4, signed=true}
  %c1: s32 = const {value=1}
  %A: s32 = or %L, %c1
  %z: s32 = const {value=0}
  %ne: u32 = icmp_ne %0, %z
  %gt: u32 = icmp_sgt %A, %z
  %an: s32 = logic_and %ne, %gt
  %f: u32 = icmp_eq %an, %z
  cond_br %f, ^bb4(), ^bb1()
^bb1():
  %t2: u32 = icmp_slt %8, %z
  cond_br %t2, ^bb2(), ^bb3()
^bb2():
  br ^bb5(%A)
^bb3():
  %c4: s32 = const {value=4}
  %Y: s32 = or %A, %c4
  br ^bb5(%Y)
^bb4():
  %c0: s32 = const {value=0}
  br ^bb5(%c0)
^bb5(%p: s32):
  store %9, %p {off=0, width=4}
  ret
}
`;

test('a short-circuit-guarded value whose cone holds a read is refused', () => {
  expect(emit(SCREAD, true)).toBe(emit(SCREAD, false));
  expect(hasMergeFeedHome(parse(SCREAD))).toBe(false);
});
