// A NAME ADOPTED WHILE SOMETHING STILL READS ITS OLD CONTENTS.
//
// `structure.ts`'s `canTakeName` asks which values live at the merge are STORED under the name it
// is about to overwrite. That is the whole question only while every value is stored somewhere. An
// inlined value is not: it is re-derived at its use out of whatever its operands are called then,
// so a value live across the merge whose expression mentions the name reads the merge's assignment
// rather than what it was defined from — and the emitted C computes a different number, at the
// same score, in ordinary-looking C.
//
// Both fixtures below are what agbcc really emits for the C in their comments, so this is a
// property of the committed path and not of hand-written IR. The rule is the structurer's, so it
// is given its own input here rather than reached through a frontend.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

/** `s32 t = a - b; if (a > 0) { a = a + b; } return a + t;` — agbcc: `sub r2,r0,r1 / cmp r0,#0 /
 *  ble .L3 / add r0,r0,r1 / .L3: add r0,r0,r2`. `%2` has no name and is live across the merge. */
const RE_DERIVED_ACROSS_MERGE = `fn f {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = sub %0, %1
  %3: unk32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: unk32 = add %0, %1
  br ^bb3(%5)
^bb2():
  br ^bb3(%0)
^bb3(%6: unk32):
  %7: unk32 = add %6, %2
  ret %7
}
`;

describe('a merge may not adopt a name an unnamed live value re-derives from', () => {
  test('the inlined difference keeps reading the value the asm computed it from', () => {
    const src = emit(RE_DERIVED_ACROSS_MERGE);
    // `a0 - a1` must be read from the ORIGINAL a0 — so a0 is never the merge's home here
    expect(src).not.toMatch(/a0 = a0 \+ a1/);
    expect(src).toContain('(a0 - a1)');
    // and the merge lands in a name of its own
    expect(src).toMatch(/v0 \+ \(a0 - a1\)/);
  });

  test('with nothing live across it the same merge still takes the name', () => {
    // The control that says the rule is not "never adopt": drop the one unnamed live value and the
    // adoption is sound again, which is the coalescing every loop and branch row depends on.
    const ir = RE_DERIVED_ACROSS_MERGE.replace('  %2: unk32 = sub %0, %1\n', '').replace('add %6, %2', 'add %6, %1');
    expect(emit(ir)).toMatch(/a0 = a0 \+ a1/);
  });
});
