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
import { NARROW_LOCAL_GATES, narrowBlockLocals, narrowLocalCandidates } from '../src/raise/narrowlocal';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const run = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const n = narrowBlockLocals(fn);
  verify(fn);
  return { fn, n, ir: print(fn) };
};
/** the same pass with one gate dropped — the ablation each refusal below is measured against */
const runWithout = (ir: string, gate: string): number => {
  const fn = parse(ir);
  verify(fn);
  return narrowBlockLocals(fn, without(NARROW_LOCAL_GATES, gate));
};
const emit = (ir: string): string => {
  const { fn } = run(ir);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};
/** which gate the table names for each block parameter — the table's ATTRIBUTION, not its verdict */
const reasons = (ir: string): (string | null)[] =>
  narrowLocalCandidates(parse(ir)).map(({ c }) => firstRejection(NARROW_LOCAL_GATES, c));

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
    // With ONE extension the two spellings are the same IR in this pass's whole vocabulary: `u16 v`
    // and `s32 v` + `(u16)v` both arrive as a merge carrier read by one `zext16` over raw in-edges,
    // and they want opposite answers (the file header carries all four compiled round-trips). This
    // refusal is therefore a CHOICE — keep the wide spelling where the asm does not say — and its
    // price is 40 of 128 carriers over 2288 sa3 functions, none of them on a benchmark row. The
    // `mergecast` row in the synthetic dataset is what holds the choice to a score.
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
