// A NARROW DECLARED LOCAL, extended once at every read. agbcc holds an `s16` local in a full
// register and re-extends it at each use, so a narrow loop carrier arrives with exactly one reader —
// its own extension. Recovered wide instead, every use re-spells the cast, and `gcc/loop.c`'s
// `basic_induction_var` then eliminates the index the narrow spelling keeps (the file header carries
// the compiled evidence).
//
// The refusals carry the file's weight, and the SOUNDNESS is split across two of them, because the
// truncation a narrow declaration performs is observable from two sides. `raw-reader` is the
// carrier's side: typing it narrow is unobservable only while the carrier's single reader reads
// just those bits. `edge-reader` is the ARGUMENTS' side, and it is not implied by the first — the
// C names an in-edge value with the carrier's variable, so that value's OTHER readers read the
// truncation too.
//
// Each refusal is ABLATED against its own fixture — `without` drops that one gate and the pass must
// then narrow, which is also what proves the fixture is refused by that gate alone. TWO cannot meet
// that standard and each says so where it stands: `NOT_AN_EXTENSION` (a wide counter breaks several
// rules at once) is pinned by ATTRIBUTION, and `reader-is-extension`/`cast-width` are one argument
// in two entries, so what they get is a JOINT ablation. The behavioural half of the table — that
// narrowing changes no program — is narrowlocal-fuzz.test.ts's.
//
// The two carriers of the accepted fixture are its own control: `narrowcnt`'s accumulator sits in
// the same block, the same loop and the same terminator as its counter, and is refused while the
// counter narrows. Three refusals are one-fact edits of that fixture; `NOT_AN_EXTENSION` (the
// benchmark's `widecnt` row) and `ENTRY_PARAM` (the sibling pass's shape) are their own, because
// neither is reachable by editing one fact. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { firstRejection, without } from '../src/l3/gates';
import {
  NARROW_LOCAL_GATES,
  type NarrowLocalOptions,
  narrowBlockLocals,
  narrowLocalCandidates,
} from '../src/raise/narrowlocal';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

/** The per-compiler fact `edge-extends`'s join clause is gated on — `THUMB_AGBCC`'s setting, which
 *  is where the header's 2x2 was compiled and scored. Every fixture below is run WITH it, because
 *  the clause is inert without it; the one test that leaves it off is `a target that claims no
 *  single-SET hoist gets no join evidence`, which is that inertness. */
const AGBCC: NarrowLocalOptions = { hoistsSingleSetArm: true };

const run = (ir: string, opts: NarrowLocalOptions = AGBCC) => {
  const fn = parse(ir);
  verify(fn);
  const n = narrowBlockLocals(fn, NARROW_LOCAL_GATES, opts);
  verify(fn);
  return { fn, n, ir: print(fn) };
};
/** the same pass with one gate dropped — the ablation each refusal below is measured against */
const runWithout = (ir: string, gate: string): number => {
  const fn = parse(ir);
  verify(fn);
  return narrowBlockLocals(fn, without(NARROW_LOCAL_GATES, gate), AGBCC);
};
const emit = (ir: string): string => {
  const { fn } = run(ir);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};
/** which gate the table names for each block parameter — the table's ATTRIBUTION, not its verdict */
const reasons = (ir: string, opts: NarrowLocalOptions = AGBCC): (string | null)[] => {
  const fn = parse(ir);
  return narrowLocalCandidates(fn, undefined, opts).map(({ c }) => firstRejection(NARROW_LOCAL_GATES, c));
};

/** the benchmark's `narrowcnt` row as it reaches this pass: `s16 i` summed into an `s32` total.
 *  `%2` is the narrow counter — sole reader `%4`, its own sign extension. `%3` is the accumulator,
 *  read by the `add` itself, and it is the control that must stay wide. */
const NARROW_COUNTER = `fn f {
^bb0():
  %0: unk32 = const {value=0}
  %1: unk32 = const {value=0}
  br ^bb1(%1, %0)
^bb1(%2: unk32, %3: unk32):
  %4: unk32 = sext %2 {width=16}
  %5: unk32 = add %3, %4
  %6: unk32 = const {value=1}
  %7: unk32 = add %4, %6
  %8: unk32 = zext %7 {width=16}
  %9: unk32 = sext %8 {width=16}
  %10: unk32 = const {value=9}
  %11: u32 = icmp_sle %9, %10
  cond_br %11, ^bb1(%8, %5), ^bb2()
^bb2():
  ret %5
}
`;

/** the benchmark's `widecnt` row: the same loop with an `s32` counter — no extension anywhere, so
 *  the counter's sole reader is the `add` that increments it. */
const NOT_AN_EXTENSION = `fn f {
^bb0():
  %0: unk32 = const {value=0}
  %1: unk32 = const {value=0}
  br ^bb1(%1, %0)
^bb1(%2: unk32, %3: unk32):
  %4: unk32 = add %3, %2
  %5: unk32 = const {value=1}
  %6: unk32 = add %2, %5
  %7: unk32 = const {value=9}
  %8: u32 = icmp_sle %6, %7
  cond_br %8, ^bb1(%6, %4), ^bb2()
^bb2():
  ret %4
}
`;

/** an ENTRY parameter whose sole reader is its prologue extension — raise/paramwidth.ts's shape,
 *  and the one place a narrow width is settled by a caller's declaration rather than by this pass. */
const ENTRY_PARAM = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = sext %0 {width=16}
  store %1, %2 {off=0, width=4}
  ret
}
`;

/** a MERGE carrier — no loop — whose two in-edges are plain wide adds. Its sole reader is one
 *  `sext16`, so half one of the soundness argument holds, and `s16 v` and `s32 v` + `(s16)v` are
 *  equally faithful spellings of it. `edge-extends` is what leaves that choice unspoken. */
const MERGE_NO_TRUNCATION = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = const {value=1}
  %3: unk32 = add %0, %2
  %4: unk32 = const {value=0}
  %5: u32 = icmp_sgt %0, %4
  cond_br %5, ^bb1(%3), ^bb2()
^bb2():
  %6: unk32 = add %0, %0
  br ^bb1(%6)
^bb1(%7: unk32):
  %8: unk32 = sext %7 {width=16}
  store %1, %8 {off=0, width=4}
  ret
}
`;

/** the SAME merge with the truncation gcc sinks past the join: the carrier's reader is the `zext`
 *  write-back and the sole reader of THAT is the `sext` the declaration is read through — `s16 v;
 *  if (…) v = a + b; else v = a - b; *out = v;` as agbcc compiles it. Refusing it costs 6, scored
 *  in packages/cli/test/matching/narrow-local.test.ts. */
const MERGE_SUNK_TRUNCATION = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = const {value=1}
  %3: unk32 = add %0, %2
  %4: unk32 = const {value=0}
  %5: u32 = icmp_sgt %0, %4
  cond_br %5, ^bb1(%3), ^bb2()
^bb2():
  %6: unk32 = add %0, %0
  br ^bb1(%6)
^bb1(%7: unk32):
  %8: unk32 = zext %7 {width=16}
  %9: unk32 = sext %8 {width=16}
  store %1, %9 {off=0, width=4}
  ret
}
`;

/** THE JOIN SHAPE, and it is the fact the header's rows three and four turn on. `mergeu16`'s own
 *  ROM: `u16 v; if (c) { v = a + b; } else { v = a - b; } out[0] = v;` compiled by this benchmark's
 *  agbcc leaves a DIAMOND — the join has two predecessors and neither of them branches to the
 *  other. `gcc/jump.c:443-445` collapses `if (…) x = a; else x = b;` into `x = b; if (…) x = a;`
 *  only while the else arm is ONE insn holding ONE SET (its guard at `:895-902`), and
 *  `gcc/thumb.h:344` PROMOTE_MODE expands a narrow-declared assignment into the arithmetic PLUS its
 *  truncation pair — five insns, not one SET. So a surviving diamond is positive evidence that the
 *  source DECLARED the local narrow. Same carrier, same single `zext16` reader, same raw in-edges
 *  as MERGE_NO_TRUNCATION below; only the shape of the join differs. */
const MERGE_DIAMOND = `fn f {
^bb0(%0: unk32, %1: unk32, %2: s32*, %3: unk32):
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb1()
^bb1():
  %6: unk32 = add %0, %1
  br ^bb3(%6)
^bb2():
  %7: unk32 = sub %0, %1
  br ^bb3(%7)
^bb3(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

/** THE OTHER HALF OF THE 2x2 and the sharpest control in this file: `s32 v; … out[0] = (u16)v;`,
 *  which is the benchmark's `mergecastu` row. Identical to MERGE_DIAMOND in every field the gate
 *  table reads — one `zext16` reader, raw in-edges, no sunk write-back — and it must stay REFUSED,
 *  because agbcc really did take `jump.c`'s hoist here: the else arm is computed before the compare
 *  and the join has the CONDITIONAL BRANCH itself as a predecessor. MERGE_NO_TRUNCATION is the
 *  `sext` cell of the same column and is this shape too. */
const MERGE_HOISTED_ARM = `fn f {
^bb0(%0: unk32, %1: unk32, %2: s32*, %3: unk32):
  %6: unk32 = sub %0, %1
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(%6), ^bb1()
^bb1():
  %7: unk32 = add %0, %1
  br ^bb2(%7)
^bb2(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

/** THE SAME DIAMOND WITH AN ARM GCC COULD NOT HAVE HOISTED. `jump.c:895-902` wants the else arm to
 *  be ONE insn holding ONE SET, and that guard fails for a big arm whatever the local's width — so
 *  here the surviving diamond says nothing about the declaration, and the carrier must stay refused
 *  rather than narrowed on evidence that is not evidence. Measured over the sa3 corpus, this is 23
 *  the arm-SIZE reading of the guard already refuses; MERGE_DIAMOND_LOAD_ARMS and
 *  MERGE_DIAMOND_POOL_ARM are the two it did not, and each is a lost byte-match. */
const MERGE_DIAMOND_BIG_ARM = `fn f {
^bb0(%0: unk32, %1: unk32, %2: s32*, %3: unk32):
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb1()
^bb1():
  %6: unk32 = add %0, %1
  %10: unk32 = mul %6, %0
  %11: unk32 = add %10, %1
  br ^bb3(%11)
^bb2():
  %7: unk32 = sub %0, %1
  br ^bb3(%7)
^bb3(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

/** THE BENCHMARK'S `mergeldcast` ROW: the same diamond with both arms a single LOAD. One SET each
 *  by op count, so an arm-SIZE test admits it — and `gcc/jump.c:483`'s `! may_trap_p` refuses to
 *  speculate a MEM above the compare (`gcc/rtlanal.c:1770` MEM -> `rtx_addr_can_trap_p`, `:144` a
 *  plain pseudo address CAN trap), so agbcc leaves the diamond for the CAST spelling too and it
 *  says nothing. Narrowed, `s32 v; … *out = (u16)v` is spelled `u16 v` and the row scores 6. */
const MERGE_DIAMOND_LOAD_ARMS = `fn f {
^bb0(%0: s32*, %1: s32*, %3: unk32):
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb1()
^bb1():
  %6: unk32 = load %1 {off=0, signed=true, width=4}
  br ^bb3(%6)
^bb2():
  %7: unk32 = load %1 {off=4, signed=true, width=4}
  br ^bb3(%7)
^bb3(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %0, %9 {off=0, width=4}
  ret
}
`;

/** THE BENCHMARK'S `mergepool` ROW: one arm is `v = a + 0x12345`, which thumb spells as a literal-
 *  pool `ldr` and then an `add` — one C assignment, TWO insns, no `single_set`. In the lifted IR it
 *  is a `const` feeding an `add`, and the IR does not say which immediates the target can fold, so
 *  constants count toward the arm's op budget. The foldable twin (`a + 3`, one `adds`) is refused
 *  here too and that costs nothing: agbcc really hoists it, so its join is not a diamond at all. */
const MERGE_DIAMOND_POOL_ARM = `fn f {
^bb0(%0: unk32, %1: unk32, %2: s32*, %3: unk32):
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb1()
^bb1():
  %10: unk32 = const {value=74565}
  %6: unk32 = add %0, %10
  br ^bb3(%6)
^bb2():
  %7: unk32 = sub %0, %1
  br ^bb3(%7)
^bb3(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

/** A ROTATED LOOP HEADER, and it IS a two-predecessor join whose predecessors do not branch to each
 *  other — the preheader and the latch are distinct blocks. `gcc/jump.c` never considers a back-edge
 *  merge, so nothing about a declaration follows from this diamond surviving; the head test is what
 *  refuses it (the preheader's sole predecessor is not the latch's). NARROW_COUNTER is NOT a witness
 *  for this: it is a SELF-loop, where the header's own latch is the header, and the old
 *  "neither predecessor branches to the other" clause refused it for a reason that does not
 *  generalise to two blocks. */
const LOOP_HEADER_DIAMOND = `fn f {
^bb0(%1: s32*):
  %2: unk32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: unk32):
  %4: unk32 = zext %3 {width=16}
  %20: unk32 = const {value=1}
  %7: unk32 = add %4, %20
  %21: unk32 = const {value=9}
  %5: u32 = icmp_slt %4, %21
  cond_br %5, ^bb2(), ^bb3()
^bb2():
  br ^bb1(%7)
^bb3():
  store %1, %4 {off=0, width=4}
  ret
}
`;

/** AN ARM THE FRONTEND INVENTED. `^bb3` is an empty forwarding block cut at a label whose own
 *  predecessor is another join, not the head — there is no `x = b;` insn for `gcc/jump.c:478`'s
 *  `single_set` to match, so the transform's shape never existed in either direction. This is
 *  `sub_80B6198` in the sa3 checkout's carrier, the ONE corpus carrier the arm-size test admitted. */
const MERGE_FORWARDED_ARM = `fn f {
^bb0(%0: unk32, %2: s32*, %3: unk32):
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb1(), ^bb4()
^bb1():
  %14: unk32 = const {value=1}
  %15: u32 = icmp_eq %0, %14
  cond_br %15, ^bb2(), ^bb6()
^bb2():
  %10: unk32 = const {value=8}
  br ^bb3(%10)
^bb6():
  %11: unk32 = const {value=9}
  br ^bb3(%11)
^bb3(%12: unk32):
  br ^bb5(%12)
^bb4():
  %13: unk32 = zext %0 {width=16}
  br ^bb5(%13)
^bb5(%8: unk32):
  %9: unk32 = sext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

/** ONE PREDECESSOR REACHING THE JOIN TWICE. `predecessorsOf` deduplicates, so this is a ONE-armed
 *  join and not a diamond; `ir/core.ts`'s `predecessors` lists a block once per EDGE and would
 *  report two. The two models are not interchangeable and this fixture is what says so. */
/** THE SAME ARM WITH A SYMBOL MAP. Without one an absolute pool word lifts to `const`; with one it
 *  is promoted to `gaddr`. An arm test that exempted constants therefore flipped on the MAP and not
 *  on the program — the same ROM getting a different local depending on whether `--elf` was passed,
 *  and the real tier runs map-FUL on every row while the synthetic tier runs map-less, so no gate
 *  saw it. Counting every value-producing op makes the two spellings identical (and the load beside
 *  them is unspeculatable either way); this fixture is MERGE_DIAMOND_MAPLESS's twin and the two must
 *  agree. */
const MERGE_DIAMOND_MAPFUL = `fn f {
^bb0(%2: s32*, %3: unk32):
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb1()
^bb1():
  %14: unk32 = gaddr {sym=gTable}
  %6: unk32 = load %14 {off=0, signed=true, width=4}
  br ^bb3(%6)
^bb2():
  %15: unk32 = gaddr {sym=gTable}
  %7: unk32 = load %15 {off=4, signed=true, width=4}
  br ^bb3(%7)
^bb3(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

/** …and the map-LESS spelling of it: the pool word as a bare `const`. */
const MERGE_DIAMOND_MAPLESS = `fn f {
^bb0(%2: s32*, %3: unk32):
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb1()
^bb1():
  %14: unk32 = const {value=134221824}
  %6: unk32 = load %14 {off=0, signed=true, width=4}
  br ^bb3(%6)
^bb2():
  %15: unk32 = const {value=134221824}
  %7: unk32 = load %15 {off=4, signed=true, width=4}
  br ^bb3(%7)
^bb3(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

/** AN ARM HOLDING A CARRIER OF ITS OWN. `^bb1` is two value-producing ops — the sibling's `sext16`
 *  and the `add` — so the join `^bb3` is NOT hoistable and must stay refused. But this pass narrows
 *  the SIBLING first, which DELETES that `sext`, and re-reading the arm afterwards finds one op and
 *  calls the join hoistable. The arm gcc compiled had `lsl / asr / add` in it; judging the rewritten
 *  one prices a program agbcc never saw, and makes a carrier's spelling depend on whether an
 *  unrelated sibling happened to narrow. `mergeShapes` snapshots the shape before the first rewrite,
 *  which is what this fixture pins. */
const MERGE_ARM_WITH_SIBLING = `fn f {
^bb0(%0: unk32, %1: unk32, %2: s32*, %3: unk32):
  %30: unk32 = sext %0 {width=16}
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb1(%30)
^bb1(%20: unk32):
  %21: unk32 = sext %20 {width=16}
  %6: unk32 = add %21, %1
  br ^bb3(%6)
^bb2():
  %7: unk32 = sub %0, %1
  br ^bb3(%7)
^bb3(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

const MERGE_DOUBLE_EDGE = `fn f {
^bb0(%0: unk32, %1: unk32, %2: s32*, %3: unk32):
  %6: unk32 = add %0, %1
  %4: unk32 = const {value=0}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb3(%6), ^bb3(%6)
^bb3(%8: unk32):
  %9: unk32 = zext %8 {width=16}
  store %2, %9 {off=0, width=4}
  ret
}
`;

describe('a block parameter extended at its only read is declared at that width', () => {
  test('a sole `sext {16}` types the carrier `s16` and drops the extension', () => {
    const { n, fn, ir } = run(NARROW_COUNTER);
    expect(n).toBe(1);
    expect(fn.blocks[1].params[0].type).toEqual({ kind: 'int', width: 16, signed: true });
    // the accumulator beside it keeps its register width
    expect(fn.blocks[1].params[1].type).toEqual({ kind: 'unknown', width: 32 });
    // one `sext` left: the loop test's, which reads the carrier's NEXT value, not the carrier
    expect(ir.match(/sext/g)).toHaveLength(1);
    expect(ir).toMatch(/add %3, %2/);
  });

  test('…and the emitted local carries the width, with no cast at the body use', () => {
    const src = emit(NARROW_COUNTER);
    expect(src).toContain('s16 v0');
    expect(src).toContain('v1 = v1 + v0;');
  });

  test('a truncation sunk past the join is the write-back, and narrows the merge carrier', () => {
    // `edge-extends` reads WHERE the truncation is, not whether an in-edge carries one. In a loop
    // it rides the back edge; across a plain merge gcc sinks the one common truncation past the
    // join, where an in-edge test alone reads a real narrow local as a cast. The pair
    // `zext {w}` -> `sext {w}` is what no cast on a wide local writes.
    const { n, fn, ir } = run(MERGE_SUNK_TRUNCATION);
    expect(n).toBe(1);
    expect(fn.blocks[2].params[0].type).toEqual({ kind: 'int', width: 16, signed: false });
    // the `zext` is gone and the `sext` now reads the carrier: `*out = (s16)v0`
    expect(ir).not.toMatch(/zext/);
    expect(ir.match(/sext/g)).toHaveLength(1);
  });

  test('the extension kind picks the signedness and its width the type', () => {
    // The whole loop moves to the new width, not just the carrier's own read: a `zext16` write-back
    // under an `s8` carrier is not a signedness variant, it is a different (and refused) program —
    // `edge-reader` reads exactly that disagreement.
    const at = (op: string, width: number) =>
      run(NARROW_COUNTER.replaceAll('width=16', `width=${width}`).replace('sext %2 {width=', `${op} %2 {width=`)).fn
        .blocks[1].params[0].type;
    expect(at('zext', 16)).toEqual({ kind: 'int', width: 16, signed: false });
    expect(at('sext', 8)).toEqual({ kind: 'int', width: 8, signed: true });
    expect(at('zext', 8)).toEqual({ kind: 'int', width: 8, signed: false });
  });
});

describe('the join shape is recorded as evidence', () => {
  // The FIELD only — no gate reads it in this commit, so every verdict below is the one the table
  // gave before it existed. What it records is a property of the CFG the pass already walks: a
  // two-armed merge, i.e. exactly two predecessor blocks with neither branching to the other. The
  // hoisted shape fails it because the join's own predecessor is the conditional branch that also
  // targets the other arm.
  const diamonds = (ir: string): boolean[] => {
    const fn = parse(ir);
    return narrowLocalCandidates(fn, undefined, AGBCC).map(({ c }) => c.mergeDiamond);
  };
  const hoistable = (ir: string, opts: NarrowLocalOptions = AGBCC): boolean[] => {
    const fn = parse(ir);
    return narrowLocalCandidates(fn, undefined, opts).map(({ c }) => c.armsHoistable);
  };

  test('a two-armed merge is a diamond and a hoisted arm is not', () => {
    // every entry parameter is judged too and none of them is a merge; the carrier is last
    expect(diamonds(MERGE_DIAMOND)).toEqual([false, false, false, false, true]);
    expect(diamonds(MERGE_HOISTED_ARM)).toEqual([false, false, false, false, false]);
    expect(diamonds(MERGE_DIAMOND).at(-1)).toBe(true);
    expect(diamonds(MERGE_HOISTED_ARM).at(-1)).toBe(false);
    // the file's existing merge fixtures are BOTH the hoisted shape — `gcc/jump.c` took the hoist
    expect(diamonds(MERGE_NO_TRUNCATION).at(-1)).toBe(false);
    expect(diamonds(MERGE_SUNK_TRUNCATION).at(-1)).toBe(false);
    // and a loop header is not a two-armed merge either: its in-edges are the preheader and a latch
    // that the header itself branches to
    expect(diamonds(NARROW_COUNTER)).toEqual([false, false]);
  });

  test('a surviving diamond narrows and a hoisted arm does not', () => {
    // THE 2x2's THIRD AND FOURTH ROWS, decided. Both fixtures present this table with one
    // `zext16` reader over raw in-edges and no sunk write-back — identical in every other field —
    // and they are the two spellings the header calls indistinguishable. The join separates them.
    const { n, fn, ir } = run(MERGE_DIAMOND);
    expect(n).toBe(1);
    expect(fn.blocks[3].params[0].type).toEqual({ kind: 'int', width: 16, signed: false });
    expect(ir).not.toMatch(/zext/);

    // and the hoisted twin — `s32 v; … *out = (u16)v`, the benchmark's `mergecastu` row — is still
    // refused, by this gate and no other
    expect(run(MERGE_HOISTED_ARM).n).toBe(0);
    expect(reasons(MERGE_HOISTED_ARM).at(-1)).toBe('edge-extends');
    expect(runWithout(MERGE_HOISTED_ARM, 'edge-extends')).toBe(1);
  });

  test('a diamond gcc could not have hoisted is not evidence, and is refused', () => {
    // The mechanism is `jump.c`'s guard and the guard is about the ARM, so reading only the join
    // reads half of it. An arm too big for ONE SET keeps its diamond whatever the local's width,
    // and narrowing there would be a spelling guess dressed as evidence. Measured over 2288 sa3
    // functions, 28 of the 40 `edge-extends` refusals are diamonds and NONE of them has arms gcc
    // could have collapsed.
    expect(diamonds(MERGE_DIAMOND_BIG_ARM).at(-1)).toBe(true);
    expect(hoistable(MERGE_DIAMOND_BIG_ARM).at(-1)).toBe(false);
    expect(run(MERGE_DIAMOND_BIG_ARM).n).toBe(0);
    expect(reasons(MERGE_DIAMOND_BIG_ARM).at(-1)).toBe('edge-extends');
    expect(runWithout(MERGE_DIAMOND_BIG_ARM, 'edge-extends')).toBe(1);
    // the accepted diamond's own arms are one `add` and one `sub` — exactly what gcc hoists
    expect(hoistable(MERGE_DIAMOND).at(-1)).toBe(true);
  });

  test('an arm gcc could not SPECULATE is not one SET, however few ops it holds', () => {
    // `gcc/jump.c:483` `! may_trap_p (SET_SRC (temp4))`, and `gcc/rtlanal.c:1770-1771` sends a MEM
    // to `rtx_addr_can_trap_p` where `:144-147` says a plain pseudo address CAN trap. So a load is
    // one op and never one hoistable SET — the diamond survives under BOTH spellings and carries
    // nothing. Counting ops alone spells `u16 v` for a source that wrote the cast: the benchmark's
    // `mergeldcast` row, MATCH at base and 6 with an arm test that reads only the size.
    expect(diamonds(MERGE_DIAMOND_LOAD_ARMS).at(-1)).toBe(true);
    expect(hoistable(MERGE_DIAMOND_LOAD_ARMS).at(-1)).toBe(false);
    expect(run(MERGE_DIAMOND_LOAD_ARMS).n).toBe(0);
    expect(reasons(MERGE_DIAMOND_LOAD_ARMS).at(-1)).toBe('edge-extends');
    expect(runWithout(MERGE_DIAMOND_LOAD_ARMS, 'edge-extends')).toBe(1);
  });

  test('a constant counts toward the arm: one C assignment is not always one insn', () => {
    // `v = a + 0x12345` is a pool `ldr` and an `add`. The IR spells foldable and unfoldable
    // immediates identically, so the budget counts both; the benchmark's `mergepool` row is this
    // shape and scores 1 when the constant is exempted.
    expect(diamonds(MERGE_DIAMOND_POOL_ARM).at(-1)).toBe(true);
    expect(hoistable(MERGE_DIAMOND_POOL_ARM).at(-1)).toBe(false);
    expect(run(MERGE_DIAMOND_POOL_ARM).n).toBe(0);
    expect(reasons(MERGE_DIAMOND_POOL_ARM).at(-1)).toBe('edge-extends');
  });

  test('a rotated loop header is a two-armed merge and is still not this evidence', () => {
    // The file used to claim a loop header fails the diamond test "for the same reason" a hoisted
    // join does — the header branching to the latch that branches back. That is only true of a
    // SELF-loop, which is what NARROW_COUNTER is. Here the latch is its own block, neither
    // predecessor branches to the other, and the old clause admitted it. The head test is what
    // refuses it: the preheader's sole predecessor is not the latch's.
    const armless = LOOP_HEADER_DIAMOND;
    expect(diamonds(armless)).toEqual([false, false]);
    expect(run(armless).n).toBe(0);
    expect(reasons(armless).at(-1)).toBe('edge-extends');
  });

  test('an empty forwarding arm has no insn to be one SET, and is refused as the head is not shared', () => {
    // `sub_80B6198` in the sa3 checkout — the ONE corpus carrier an arm-SIZE test admitted, and a misclassification:
    // `^bb3` is a nested join flattened by the frontend, not an `if`/`else` arm.
    expect(diamonds(MERGE_FORWARDED_ARM).at(-1)).toBe(false);
    expect(hoistable(MERGE_FORWARDED_ARM).at(-1)).toBe(false);
    expect(run(MERGE_FORWARDED_ARM).n).toBe(0);
    expect(reasons(MERGE_FORWARDED_ARM).at(-1)).toBe('edge-extends');
  });

  test('the same ROM gets the same local with and without a symbol map', () => {
    // A DECOMPILER ANSWER THAT DEPENDS ON `--elf` IS NOT A PROPERTY OF THE PROGRAM. The pool word
    // lifts to `const` map-less and to `gaddr` map-ful, so exempting constants from the arm's op
    // budget made the verdict a function of the invocation. The real tier is map-FUL on 252/252
    // rows and the synthetic tier is map-less, so this asymmetry was structurally invisible to
    // `bench diff`.
    expect(diamonds(MERGE_DIAMOND_MAPFUL).at(-1)).toBe(diamonds(MERGE_DIAMOND_MAPLESS).at(-1));
    expect(hoistable(MERGE_DIAMOND_MAPFUL).at(-1)).toBe(hoistable(MERGE_DIAMOND_MAPLESS).at(-1));
    expect(hoistable(MERGE_DIAMOND_MAPFUL).at(-1)).toBe(false);
    expect(run(MERGE_DIAMOND_MAPFUL).n).toBe(run(MERGE_DIAMOND_MAPLESS).n);
    expect(run(MERGE_DIAMOND_MAPFUL).n).toBe(0);
  });

  test('the arm is judged as agbcc compiled it, not as this pass rewrote it', () => {
    // ORDER-INDEPENDENCE, and it is not free: `narrowBlockLocals` re-enumerates after every rewrite
    // because the EDGE rules of a later carrier read the ops an earlier one changed. The join shape
    // is the one thing that must NOT be re-read — it is a fact about the lifted asm. Here the
    // sibling in `^bb1` narrows, deleting the `sext` that made the arm two ops; the join's verdict
    // must be the one taken before that.
    const { n, fn } = run(MERGE_ARM_WITH_SIBLING);
    expect(n).toBe(1); // the sibling, and only the sibling
    expect(fn.blocks[1].params[0].type).toEqual({ kind: 'int', width: 16, signed: true });
    expect(fn.blocks[3].params[0].type).toEqual({ kind: 'unknown', width: 32 });
    expect(hoistable(MERGE_ARM_WITH_SIBLING).at(-1)).toBe(false);
    expect(reasons(MERGE_ARM_WITH_SIBLING).at(-1)).toBe('edge-extends');
  });

  test('a block reached twice from one predecessor is ONE arm', () => {
    // `predecessorsOf`'s dedup is SEMANTICS: swapping in `ir/core.ts`'s `predecessors`, which lists
    // one entry per EDGE, makes this join look two-armed. Over 2288 sa3 functions the two models
    // disagree on 26 blocks and on 8 of them the shared one reports the two predecessors this file
    // reads — so the swap is a silent behaviour change, and this is the test that fails on it.
    expect(diamonds(MERGE_DOUBLE_EDGE).at(-1)).toBe(false);
    expect(run(MERGE_DOUBLE_EDGE).n).toBe(0);
    expect(reasons(MERGE_DOUBLE_EDGE).at(-1)).toBe('edge-extends');
  });

  test('a target that claims no single-SET hoist gets no join evidence', () => {
    // The join clause is a claim about gcc 2.x's `jump_optimize`, not about C, so it is
    // `TargetDescription.compilerBehaviors.hoistsSingleSetArm` and absent means the target claims
    // nothing. Same fixture, same IR, the option off: the shape is still a diamond and the
    // evidence field is false, so the pass behaves exactly as it did before the clause existed.
    expect(diamonds(MERGE_DIAMOND).at(-1)).toBe(true);
    expect(hoistable(MERGE_DIAMOND, {}).at(-1)).toBe(false);
    expect(run(MERGE_DIAMOND, {}).n).toBe(0);
    expect(reasons(MERGE_DIAMOND, {}).at(-1)).toBe('edge-extends');
  });
});

describe('refusals', () => {
  test('a second reader of the raw carrier refuses the narrowing', () => {
    // The accumulator reads the counter itself as well as its cast, so the bits a narrow
    // declaration drops are observable and no such declaration produces this IR.
    const ir = NARROW_COUNTER.replace('%5: unk32 = add %3, %4', '%5: unk32 = add %3, %2');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'raw-reader')).toBe(1);
  });

  test('a carrier whose sole reader is not an extension states no width', () => {
    expect(run(NOT_AN_EXTENSION).n).toBe(0);
    // ATTRIBUTION, not ablation. A wide counter violates several rules at once, so no single
    // `without` makes this fixture narrow — what a gate table owes here is the RIGHT reason, and
    // below `cast-width` this refusal reads as "a width no C type spells". Both of this fixture's
    // carriers — the counter and the accumulator — are read by the `add`.
    expect(reasons(NOT_AN_EXTENSION)).toEqual(['reader-is-extension', 'reader-is-extension']);
    // and the accepted fixture's own accumulator is the same refusal, beside a narrowed counter
    expect(reasons(NARROW_COUNTER)).toEqual([null, 'reader-is-extension']);
  });

  test('a carrier forwarded as a branch argument refuses the narrowing', () => {
    // The exit edge hands the counter to another block, which reads it at its full width.
    const ir = NARROW_COUNTER.replace('cond_br %11, ^bb1(%8, %5), ^bb2()', 'cond_br %11, ^bb1(%8, %5), ^bb2(%2)')
      .replace('^bb2():', '^bb2(%12: unk32):')
      .replace('ret %5', 'ret %12');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'forwarded')).toBe(1);
  });

  test('a width no C type spells is refused', () => {
    const ir = NARROW_COUNTER.replace('sext %2 {width=16}', 'sext %2 {width=24}');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'cast-width')).toBe(1);
  });

  test('the width pair is jointly load-bearing and neither half alone', () => {
    // `reader-is-extension` and `cast-width` are one soundness argument in two entries: a
    // non-extension reader states `width = 0`, which the other refuses. So ablating EITHER changes
    // nothing — which is not a licence to call either unsound, and not a guard a `sound: true`
    // flag can rest on. Ablating BOTH is: the pass types the carrier `u0` and splices out the op
    // that read it, so the function returns the carrier where the graph returns `carrier + 1`.
    const ir = `fn f {
^bb0():
  %0: unk32 = const {value=0}
  %1: unk32 = const {value=1}
  br ^bb1(%0)
^bb1(%2: unk32):
  %3: unk32 = add %2, %1
  ret %3
}
`;
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'reader-is-extension')).toBe(0);
    expect(runWithout(ir, 'cast-width')).toBe(0);
    const fn = parse(ir);
    const both = without(without(NARROW_LOCAL_GATES, 'reader-is-extension'), 'cast-width');
    expect(narrowBlockLocals(fn, both)).toBe(1);
    expect(fn.blocks[1].params[0].type).toEqual({ kind: 'int', width: 0, signed: false });
    expect(print(fn)).not.toMatch(/add/);
  });

  test('a parameter the pointer recovery already typed is left alone', () => {
    // The struct/array recognizers run ahead of this pass and write exactly such a type; only the
    // type stands between a recovered `s32 *` carrier and an `s16` declaration.
    const ir = NARROW_COUNTER.replace('^bb1(%2: unk32,', '^bb1(%2: s32*,');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'param-typed')).toBe(1);
  });

  test('an in-edge value read at full width elsewhere refuses the narrowing', () => {
    // THE SECOND HALF OF THE SOUNDNESS ARGUMENT. The loop test reads the back-edge value ITSELF
    // instead of a re-extension of it, so that value is observed at a width the carrier's
    // declaration does not keep — and `structure.ts` gives it the carrier's name. The compiled
    // consequence (an infinite loop out of assembly that terminates) is in narrowlocal.ts's header.
    // The edge still EXTENDS, so `edge-extends` admits it and this gate is the only one refusing.
    const ir = NARROW_COUNTER.replace('  %9: unk32 = sext %8 {width=16}\n', '').replace('icmp_sle %9', 'icmp_sle %8');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'edge-reader')).toBe(1);
  });

  test('a merge whose in-edges carry no truncation is a cast, not a declaration', () => {
    // EVIDENCE, not soundness — `s32 v` with one `(s16)v` at the use computes the same numbers.
    // This fixture is `mergecast`'s cell: one `sext16` over raw in-edges AND a HOISTED join, which
    // is what agbcc leaves when the source cast a wide local. Refusing it costs `mergecast:agbcc`
    // its match, measured. The carrier the join clause re-decides is the DIAMOND above; over 2288
    // sa3 sources this refusal falls only 40 -> 39, because 31 of its 32 diamonds have arms gcc
    // could not have collapsed either way — which is why these fixtures and the ablated fuzz arm
    // carry the rule and no score does.
    expect(run(MERGE_NO_TRUNCATION).n).toBe(0);
    expect(runWithout(MERGE_NO_TRUNCATION, 'edge-extends')).toBe(1);
    // and the same fixture with the truncation SUNK to the join is admitted — the two differ by
    // exactly the write-back `zext`, which is the evidence
    expect(run(MERGE_SUNK_TRUNCATION).n).toBe(1);
  });

  test('an entry parameter is left to raise/paramwidth.ts', () => {
    // Same shape, decided by a different rule: a caller's declaration outranks the inference there,
    // and this pass has no prototype to check against.
    expect(run(ENTRY_PARAM).n).toBe(0);
    expect(runWithout(ENTRY_PARAM, 'entry-param')).toBe(1);
  });
});

describe('the L1→L2 promise both width passes rest on', () => {
  // This pass and raise/paramwidth.ts write a type BEFORE the type-recovery stage, so both are
  // sound only while `recoverTypes` leaves an already-typed value alone. Every write in recover.ts
  // is guarded by `kind === 'unknown'` today, and docs/level-tower.md's L1→L2 postcondition
  // (`assertTypesRecovered`) checks only that nothing is STILL unknown — so nothing on the
  // committed path would notice the day one of those guards goes. Pinned here rather than left as
  // a reading, in the idiom of test/addr-placement.test.ts.
  test('recoverTypes leaves a pre-typed block parameter at the width the raise stage set', () => {
    const { fn } = run(NARROW_COUNTER);
    expect(fn.blocks[1].params[0].type).toEqual({ kind: 'int', width: 16, signed: true });
    recoverTypes(fn);
    expect(fn.blocks[1].params[0].type).toEqual({ kind: 'int', width: 16, signed: true });
  });
});

describe("a wide name is not a narrow carrier's home", () => {
  // The converse of param-width.test.ts's "a narrow parameter is not a wide value's home". A name's
  // declared type is fixed by its FIRST claimant and never re-checked, so a narrow carrier adopting
  // a name of a different shape is DECLARED as that shape — while its one reading extension is
  // already gone, deleted against the promise that reading the local re-applies it. Both fixtures
  // are POST-RAISE IR: the rule under test is the structurer's, and giving it its own input keeps
  // it pinned when the raise gates above move.
  const emitOf = (ir: string): string => {
    const fn = parse(ir);
    verify(fn);
    recoverTypes(fn);
    return cBackend.emit(structure(fn));
  };

  // A WIDTH mismatch. The merge reaches the structurer with `a0` — an unknown, i.e. a full word —
  // as an incoming argument, and taking that name emits `*a1 = a0` where the graph says
  // `*a1 = (s16)a0`: 70000 stored instead of 4464.
  const MERGE_ONTO_WIDE_NAME = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = const {value=0}
  %3: u32 = icmp_sle %0, %2
  cond_br %3, ^bb1(), ^bb2(%0)
^bb1():
  %4: unk32 = const {value=70000}
  br ^bb2(%4)
^bb2(%5: s16):
  store %1, %5 {off=0, width=4}
  ret
}
`;

  // A SIGNEDNESS mismatch at the SAME width, which the width rule alone admits. This is `sa3`'s
  // `sub_80B4654` as the two raise passes leave it: a `u8` parameter merged with a `zext8` arm and
  // read through `lsls #24 / asrs #24`, so the carrier is `s8`. Adopting the `u8` parameter's name
  // re-applies the WRONG extension — 144 where the target passes -112 for every byte with bit 7
  // set, and agbcc emits `lsr` where the target has `asr`.
  const MERGE_ONTO_UNSIGNED_NAME = `fn f {
^bb0(%0: s32*, %1: u8, %2: unk32, %3: unk32):
  %4: unk32 = const {value=4}
  %5: u32 = icmp_sle %3, %4
  cond_br %5, ^bb1(), ^bb2(%1)
^bb1():
  %6: unk32 = zext %2 {width=8}
  br ^bb2(%6)
^bb2(%7: s8):
  store %0, %7 {off=0, width=4}
  ret
}
`;

  test('a narrowed carrier whose incoming value is a wide name takes a fresh name', () => {
    const src = emitOf(MERGE_ONTO_WIDE_NAME);
    expect(src).toContain('s16 v0');
    expect(src).toContain('*a1 = v0;');
    // the truncation the graph states must not have been dropped along with the extension
    expect(src).not.toMatch(/\*a1 = a0;/);
  });

  test('a narrowed carrier whose incoming value is an UNSIGNED name of the same width takes a fresh name', () => {
    const src = emitOf(MERGE_ONTO_UNSIGNED_NAME);
    expect(src).toContain('s8 v0');
    expect(src).toContain('*a0 = v0;');
    // `a1` is `u8`: reading the carrier through it zero-extends where the graph sign-extends
    expect(src).not.toMatch(/\*a0 = a1;/);
  });
});
