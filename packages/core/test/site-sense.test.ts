// `/site-sense` — the per-SITE branch sense (structure.ts senseFromFoldEvidence), read off the
// orientation a short-circuit fold recorded (raise/shortcircuit.ts `scSharedOnFall`) instead of
// off the per-FUNCTION boolean. The whole point is the MIXED spelling: a function whose two `if`s
// were written in opposite senses reaches neither value of `negateJoinedBranchSense`.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Fn } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

// Two JOINED ifs in sequence, each storing through its own pointer, reconverging on the final ret.
const TWOJOINED = `fn twojoined {
^bb0(%0: s32, %1: s32*, %2: s32*):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: s32 = const {value=1}
  store %1, %5 {off=0, width=4}
  br ^bb3()
^bb2():
  %6: s32 = const {value=2}
  store %1, %6 {off=0, width=4}
  br ^bb3()
^bb3():
  %7: u32 = icmp_sgt %0, %3
  cond_br %7, ^bb4(), ^bb5()
^bb4():
  %8: s32 = const {value=3}
  store %2, %8 {off=0, width=4}
  br ^bb6()
^bb5():
  %9: s32 = const {value=4}
  store %2, %9 {off=0, width=4}
  br ^bb6()
^bb6():
  ret %0
}
`;

/** Parse TWOJOINED and stamp each `cond_br` with the fold orientation the caller names: which
 *  SOURCE arm the shared block is (`scSharedOnFall`), which SUCCESSOR SLOT it landed in
 *  (`scSharedIsTaken`, the fold's `gIsFall`), and whether a long-branch trampoline sat on either
 *  edge (`scEdgeRelayed`). A bare boolean is the short-branch, unchained layout — shared in the
 *  TAKEN slot, no relay — which is every site of the rows the axis shipped on. */
function stamped(...shared: (boolean | undefined | [onFall: boolean, isTaken: boolean, relayed?: boolean])[]): Fn {
  const fn = parse(TWOJOINED);
  verify(fn);
  recoverTypes(fn);
  let i = 0;
  for (const b of fn.blocks) {
    const t = b.ops[b.ops.length - 1];
    if (t.opcode === 'cond_br') {
      const v = shared[i++];
      if (v !== undefined) {
        const [onFall, isTaken, relayed] = typeof v === 'boolean' ? [v, true, false] : v;
        t.attrs.scSharedOnFall = onFall;
        t.attrs.scSharedIsTaken = isTaken;
        t.attrs.scEdgeRelayed = relayed ?? false;
      }
    }
  }
  return fn;
}
const emit = (fn: Fn, opts: Parameters<typeof structure>[1]): string => cBackend.emit(structure(fn, opts));

describe('/site-sense reads the fold’s orientation, per site', () => {
  test('a MIXED pair of stamps spells what neither value of the boolean can', () => {
    // The stamps say: site 1's shared arm was branched to (the `&&` layout, so the layout reading
    // stands), site 2's was fallen into (the `||` layout, so the positive spelling is the source's).
    const mixed = emit(stamped(false, true), { senseFromFoldEvidence: true });
    expect(mixed).not.toBe(emit(stamped(false, true), { negateJoinedBranchSense: true }));
    expect(mixed).not.toBe(emit(stamped(false, true), { negateJoinedBranchSense: false }));
    // …and it is exactly the two halves: site 1 as the boolean-true spelling, site 2 as false.
    const ifs = (src: string) => src.split('\n').filter((l) => l.includes('if ('));
    expect(ifs(mixed)[0]).toBe(ifs(emit(stamped(false, true), { negateJoinedBranchSense: true }))[0]);
    expect(ifs(mixed)[1]).toBe(ifs(emit(stamped(false, true), { negateJoinedBranchSense: false }))[1]);
  });

  test('OFF, the stamps are inert — the boolean still decides both sites', () => {
    expect(emit(stamped(false, true), {})).toBe(emit(stamped(undefined, undefined), {}));
  });

  test('an UNSTAMPED site keeps its boolean while its stamped neighbour does not', () => {
    // A function mixes folded and unfolded `if`s, and the axis must not claim the unfolded one:
    // there is no evidence there, so the per-function lever is still the only answer.
    const half = emit(stamped(true, undefined), { senseFromFoldEvidence: true });
    const ifs = (src: string) => src.split('\n').filter((l) => l.includes('if ('));
    expect(ifs(half)[0]).toBe(ifs(emit(stamped(undefined, undefined), { negateJoinedBranchSense: false }))[0]);
    expect(ifs(half)[1]).toBe(ifs(emit(stamped(undefined, undefined), { negateJoinedBranchSense: true }))[1]);
    // …and stamping that same site the other way leaves the whole function on the boolean's
    // spelling, so the stamp is what moved it and not the axis being on.
    expect(emit(stamped(false, undefined), { senseFromFoldEvidence: true })).toBe(
      emit(stamped(undefined, undefined), {}),
    );
  });

  test('the SLOT stamp inverts the reading — one source arm, two layouts', () => {
    // Same `scSharedOnFall` at both sites, opposite `scSharedIsTaken`: the shared block is the
    // source's `else` either way, but at the second site it is the FALL successor, so the taken
    // arm already holds the source's `then` and no negation is owed. One stamp cannot express
    // that pair, which is what the chained fold (`(a || b) && c`, whose outer `^g` is the head's
    // TAKEN edge) and the long-branch layout both produce.
    const ifs = (src: string) => src.split('\n').filter((l) => l.includes('if ('));
    const mixed = ifs(emit(stamped([false, true], [false, false]), { senseFromFoldEvidence: true }));
    expect(mixed[0]).toBe(ifs(emit(stamped(undefined, undefined), { negateJoinedBranchSense: true }))[0]);
    expect(mixed[1]).toBe(ifs(emit(stamped(undefined, undefined), { negateJoinedBranchSense: false }))[1]);
  });

  test('the LONG-BRANCH `&&` cell is positive — `synthetic:ifand_far`’s spelling, which no score pins', () => {
    // `[true, false]`: the shared arm was FALLEN INTO and landed in the FALL slot. Under the
    // source-order premise that pair cannot happen — a fallen-into arm is the source's `then`, and
    // the `then` is not what an `&&` fold puts in the fall slot — so reaching it means the premise's
    // layout assumption is the thing that failed: agbcc inverted the last test over a long branch
    // and laid the `else` arm first. The source's `then` is still in the taken slot, so the site is
    // POSITIVE, exactly as at the chained quadrant below it.
    //
    // Measured, not assumed: `synthetic:ifand_far` (`if (a && b) {64 stores} else {…}`) stamps
    // exactly this pair at its single fold, and lifting its own asm with the axis on spells
    // `a0 != 0 && a1 != 0` — the source. The `foldEvidence !== sharedIsTaken` reading spelled the
    // dual there, `a0 == 0 || a1 == 0`, and nothing in the corpus could see it: the row MATCHES on
    // `/flip-join` with or without this axis.
    //
    // POSITIVE IS NOT UNIVERSALLY RIGHT HERE, and one committed row says so: the two long-branch
    // sites of `kleod:CheckWorldCompletion:agbcc` want OPPOSITE spellings against its own
    // `refSource` — positive at the `(x & 0x80) != 0 && (y & 0x7F) != 0x7F` guard, negated at the
    // three-`return 1` ladder below it. This asserts the better of two constants, not a decided
    // cell; the row is 45/191 with the same winner either way, so nothing in the corpus referees
    // it. What would decide it is a site fact the fold does not carry — or the per-site
    // `/sense-N` mask, which does not have to pick.
    const ifs = (src: string) => src.split('\n').filter((l) => l.includes('if ('));
    const both = ifs(emit(stamped([true, false], [false, false]), { senseFromFoldEvidence: true }));
    const positive = ifs(emit(stamped(undefined, undefined), { negateJoinedBranchSense: false }));
    expect(both[0]).toBe(positive[0]); // long branch
    expect(both[1]).toBe(positive[1]); // chained fold
    // …and the TAKEN-slot quadrants still split, which is the half the one-stamp reading had right.
    const taken = ifs(emit(stamped([true, true], [false, true]), { senseFromFoldEvidence: true }));
    expect(taken[0]).toBe(positive[0]);
    expect(taken[1]).toBe(ifs(emit(stamped(undefined, undefined), { negateJoinedBranchSense: true }))[1]);
  });

  test('the LONG-BRANCH `||` cell is positive too — the pair the short `&&` also stamps', () => {
    // `[false, true, true]`: shared arm branched to, landed in the TAKEN slot, and a trampoline on
    // one of the edges. Site 1 is that; site 2 is the SAME two booleans without the relay, i.e. the
    // short-branch `&&`. They must come out OPPOSITE, which is the whole reason the third stamp
    // exists — two booleans put these two sites in one cell.
    //
    // Measured on the rows, each lifted from its own compiled asm: `synthetic:ifor_far`
    // (`if (a || b) {64 stores} else {…}`) stamps `false/true/relayed` and, with the axis on,
    // spells `a0 != 0 || a1 != 0` — its source. Without the relay stamp it spelled the dual,
    // `a0 == 0 && a1 == 0`, and no score could see that either: the row MATCHes 0/139 on
    // `/flip-join` exactly as `ifand_far` does at 0/140. `synthetic:ifand_near` stamps
    // `false/true/not relayed` and wants the negated spelling.
    const ifs = (src: string) => src.split('\n').filter((l) => l.includes('if ('));
    const mixed = ifs(emit(stamped([false, true, true], [false, true, false]), { senseFromFoldEvidence: true }));
    expect(mixed[0]).toBe(ifs(emit(stamped(undefined, undefined), { negateJoinedBranchSense: false }))[0]);
    expect(mixed[1]).toBe(ifs(emit(stamped(undefined, undefined), { negateJoinedBranchSense: true }))[1]);
  });

  test('REFUSES a partially-stamped site — the slot alone is not evidence', () => {
    // `scSharedIsTaken` without `scSharedOnFall` says where the shared block went and nothing about
    // which arm the source wrote there. The site keeps its boolean rather than guessing. Same for a
    // site carrying the two old stamps and not the relay: a reader that defaulted the missing one
    // to `false` would spell every long `||` as its dual, which is the defect this stamp closed.
    const half = parse(TWOJOINED);
    verify(half);
    recoverTypes(half);
    half.blocks[0].ops[half.blocks[0].ops.length - 1].attrs.scSharedIsTaken = false;
    expect(emit(half, { senseFromFoldEvidence: true })).toBe(emit(stamped(undefined, undefined), {}));

    const noRelay = parse(TWOJOINED);
    verify(noRelay);
    recoverTypes(noRelay);
    const t = noRelay.blocks[0].ops[noRelay.blocks[0].ops.length - 1];
    t.attrs.scSharedOnFall = false;
    t.attrs.scSharedIsTaken = true;
    expect(emit(noRelay, { senseFromFoldEvidence: true })).toBe(emit(stamped(undefined, undefined), {}));
  });
});
