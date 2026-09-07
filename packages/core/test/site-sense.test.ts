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

/** Parse TWOJOINED and stamp each `cond_br` with the fold orientation the caller names. */
function stamped(...shared: (boolean | undefined)[]): Fn {
  const fn = parse(TWOJOINED);
  verify(fn);
  recoverTypes(fn);
  let i = 0;
  for (const b of fn.blocks) {
    const t = b.ops[b.ops.length - 1];
    if (t.opcode === 'cond_br') {
      const v = shared[i++];
      if (v !== undefined) {
        t.attrs.scSharedOnFall = v;
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
});
