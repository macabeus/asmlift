// A LOOP VARIABLE READ AFTER THE LOOP IS ONE UPDATE BEHIND, and reading it under the loop's own
// name is a silent miscompile.
//
// Both loop emitters that place the update at the BOTTOM of the body — the self-loop `while` and
// the do-while — leave the name holding the value the test failed on. The back-edge ARG means
// that; the block PARAM means the value at the top of that last iteration, and `sub` maps only the
// former. agbcc spells the difference out by keeping a second register for it:
//
//   .L10: add r3, r1, #0   @ r3 = n            for (n = 0; n < i; n++) { ...; }
//         add r1, r3, #0x1 @ r1 = n + 1        *(s32 *)(b + m*24 + 4) = n;   <- n, not n+1
//         blt .L10
//         str r3, [r2, #0x4]
//
// `structure/hazards.ts` used to exempt every loop-carried param from the escape check on the
// grounds that "a post-loop read of the updated name is exactly the intended final value" — true
// of the back-edge arg, false of the param. The emitted C stored `i` where the reference stored
// `i - 1`; it compiled, it scored, and no gate saw it, because regression, diff and corpus sweeps
// measure REACH and never correctness. It is a decline now.
//
// A refusal test that declines for the WRONG reason reads as a pass, so each case pins the message
// and carries a positive control differing in ONE fact.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// The lifted shape of the agbcc listing above, reduced to one loop. ^bb1 is header and latch; the
// counter %2 is updated to %4 and the back edge carries %4, so post-loop the name holds %4's
// value. ^bb2 stores %2 — the PRE-update counter.
const STORE_PREUPDATE = `fn storepre {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  br ^bb1(%9)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4), ^bb2()
^bb2():
  store %0, %2 {off=4, width=4}
  ret
}
`;

// THE ONE FACT CHANGED: the store takes the POST-update value, which is what the name holds.
const STORE_POSTUPDATE = STORE_PREUPDATE.replace('store %0, %2 {off=4, width=4}', 'store %0, %4 {off=4, width=4}');

// THE SAME PROGRAM, SPELLED THE OTHER WAY: the pre-update value crosses the exit as an edge ARG
// into a merge param instead of being read from the header param. `sinkablePreUpdateSlots` REPAIRS
// this one — the copy moves into the body, ahead of the update — so the two spellings of one
// hazard get opposite answers, and the boundary between them is an SSA-construction artifact
// rather than a property of the program. Pinned here so the decline above is read as scoped to
// "no exit slot to sink", never as "this hazard is unrepairable".
const STORE_PREUPDATE_ON_EDGE = `fn storepre {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  br ^bb1(%9)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4), ^bb2(%2)
^bb2(%6: s32):
  store %0, %6 {off=4, width=4}
  ret
}
`;

test('a post-loop store of the PRE-update counter declines instead of storing the post-update one', () => {
  expect(() => emit(STORE_PREUPDATE)).toThrow(StructureError);
  expect(() => emit(STORE_PREUPDATE)).toThrow(/reads a pre-update loop variable/);
});

test('the same loop storing the POST-update counter emits, and stores the counter', () => {
  const out = emit(STORE_POSTUPDATE);
  expect(out).toMatch(/while \(|do \{/);
  // whatever the counter is named, the store takes it — not a second local
  const name = out.match(/(\w+) = \1 \+ 1;/)?.[1];
  expect(name).toBeDefined();
  expect(out).toContain(`= ${name};`);
});

test('the same pre-update value crossing the exit EDGE is repaired, not declined', () => {
  const out = emit(STORE_PREUPDATE_ON_EDGE);
  const counter = out.match(/(\w+) = \1 \+ 1;/)?.[1];
  expect(counter).toBeDefined();
  // the trailing copy sits inside the body AHEAD of the update, so it holds the pre-update value
  const trailing = out.match(new RegExp(`(\\w+) = ${counter};\\s+${counter} = ${counter} \\+ 1;`))?.[1];
  expect(trailing).toBeDefined();
  // and the post-loop store takes that copy, never the moved-on counter
  expect(out).toContain(`= ${trailing};`);
  expect(out).not.toContain(`= ${counter};\n    return`);
});
