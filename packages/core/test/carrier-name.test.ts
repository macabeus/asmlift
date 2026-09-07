// UNIT tests for CARRIER_NAME_GATES — the naming walk's admission table (`canTakeName`, inside
// `structure/structure.ts`). Whether a block parameter may be SPELLED with a name that already
// exists is what decides whether its in-edge copies survive into the C.
//
// The whole-program check is `carrier-name-fuzz.test.ts`. These pin the two rules that sweep
// cannot reach, each by ablating it and asserting BOTH sides — the gated spelling and what the
// ablated table does instead. Neither is reachable by the fuzz for a stated reason: its generator
// makes every value `s32`, so no pair of declarations can disagree about a sub-word signedness,
// and it emits no loop whose body holds a merge that outlives it.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { CARRIER_NAME_GATES, structure } from '../src/structure/structure';

const emit = (ir: string, gate?: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, {}, gate ? { carrierNameGates: without(CARRIER_NAME_GATES, gate) } : {}));
};

// ── carrier-sign ──────────────────────────────────────────────────────────────────────────────
// A `u8` parameter and an `s8` carrier are the SAME WIDTH and a different value at every read: a
// narrow declaration is where the extension went, and reading `a0` re-applies zero-extension where
// the graph says the carrier was sign-extended. This is the shape `structure.ts`'s own comment
// names from sa3's `sub_80B4654`, at the smallest size that reproduces it.
const SIGN_CARRIER = `fn signcarrier {
^bb0(%0: u8, %1: s32*):
  %2: s32 = load %1 {off=0, width=4, signed=true}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %2, %3
  cond_br %4, ^bb2(%0), ^bb1()
^bb1():
  %5: s8 = const {value=7}
  br ^bb2(%5)
^bb2(%6: s8):
  %7: s32 = sext %6 {width=8}
  ret %7
}
`;

test('an s8 carrier does not adopt a u8 parameter name', () => {
  const out = emit(SIGN_CARRIER);
  expect(out).toMatch(/s8 v0;/);
  expect(out).not.toMatch(/a0 = 7;/);
});

test('ablating carrier-sign reads an s8 carrier through a u8 name', () => {
  const out = emit(SIGN_CARRIER, 'carrier-sign');
  // the merge now writes the PARAMETER, whose `u8` declaration re-applies the wrong extension
  expect(out).toMatch(/a0 = 7;/);
  expect(out).not.toMatch(/s8 v0;/);
});

// ── carrier-write ─────────────────────────────────────────────────────────────────────────────
// A do-while whose body holds a two-armed merge that OUTLIVES the loop. The merge's carrier is the
// loop variable itself, dead by the merge's own block — so `carrier-live` admits it — and the loop
// variable's update is NOT the merge, so the two are different values. The update copy is emitted
// at the bottom of the body, where it also runs on the exiting iteration, so under a shared name
// the post-loop read would see the update instead of the merge.
const SUNK_UPDATE = `fn sunkupdate {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = call %3 {target="f0"}
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb2(%3), ^bb2(%4)
^bb2(%6: s32):
  %7: s32 = add %4, %0
  %8: u32 = icmp_slt %7, %1
  cond_br %8, ^bb1(%7), ^bb3()
^bb3():
  ret %6
}
`;

test('a merge that outlives its loop keeps its own name', () => {
  const out = emit(SUNK_UPDATE);
  // the loop variable is v1 and the merge is v2 — two variables, and the return reads the merge
  expect(out).toMatch(/return v2;/);
  expect(out).toMatch(/v1 = v0 \+ a0;/);
});

test('ablating carrier-write reads a loop variable past its sunk update', () => {
  // The naming that gate refuses is not merely worse: the merge and the loop variable become one
  // variable that the update overwrites on the way out. The do-while emitter's own pre-update
  // hazard sees it and declines LOUDLY — which is what a refusal downstream of a lost gate is
  // supposed to look like, and is the reason this shape has no wrong-answer twin to assert.
  expect(() => emit(SUNK_UPDATE, 'carrier-write')).toThrow(/pre-update loop variable/);
});
