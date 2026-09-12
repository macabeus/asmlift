// AN EFFECT THE MACHINE PERFORMED MUST REACH THE SOURCE — `unreadResult` in
// `structure/structure.ts`, and the transitive use test behind it.
//
// `sideEffects` spells a call nothing consumes, because a call is an execution. "Nothing consumes
// it" cannot be answered by the analysis registry's USE SITES, which are syntactic: an op whose
// result feeds one pure op that is itself never rendered HAS a use site, so the call reads as
// consumed — and then neither the consumer nor the call is emitted. The function simply stops
// making the call. It compiles, it scores, and it computes something else.
//
// FOUND BY THE IR ORACLE, not by a reader. Without the transitive test, `irTraceOf` against the
// emitted tree over `generateSsaFn`'s acyclic seeds disagrees on 433 of 4,000, and every
// disagreement is a call the IR performed and the tree did not. Neither naming fuzz can see it:
// both their reference spellings drop the same call, which is the whole argument for an oracle that
// reads the IR rather than a second spelling.
//
// Three fixtures for the three rules the predicate is made of — the transitive walk, and the
// materialized-def branch `sideEffects` must test BEFORE `unreadResult`, which two of them pin.
// The third rule, `isSpelled`'s materialized base case, has no witness here and the fixture it
// was written for says why.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { count, irTraceOf, traceOf, tracesDiffer } from './helpers';

const lift = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return { fn, src: cBackend.emit(structure(fn, {})) };
};

// `fz15`, minimised: the call's one consumer is an `add` nobody reads. Under the syntactic use
// test the call has a use, so no statement is emitted for it, and the `add` is never rendered
// either — the call is gone.
const DEAD_CONSUMER = `fn deadconsumer {
^bb0(%0: s32):
  %1: s32 = call %0 {target="f0"}
  %2: s32 = add %1, %0
  ret %0
}
`;

// The same shape over a call the analysis MATERIALIZES — `%1`'s value has to survive `%2`, so it
// is bound to a local at its own position. A materialized def already spells its effect as
// `v = f0(…)`; routing it through the dead-op branch instead emits `expr(result)`, which for a
// named value is the NAME, so `v0;` replaces the assignment and the call is gone again. Under a
// transitive use test the two sets overlap constantly, which is why the exemption is part of the
// predicate and not a detail.
const MATERIALIZED = `fn materialized {
^bb0(%0: s32):
  %1: s32 = call %0 {target="f0"}
  %2: s32 = call %0 {target="f1"}
  %3: s32 = add %1, %0
  %4: u32 = icmp_slt %2, %0
  cond_br %4, ^bb1(), ^bb1()
^bb1():
  ret %0
}
`;

// THE THIRD RULE, AND IT IS UNWITNESSED — named here rather than left to read like the two above.
// `isSpelled` returns true for a materialized def as a BASE CASE, before asking whether anything
// reads it, because such a def renders at its own position whether or not its name is ever read.
// That is the right model of what `sideEffects` emits, but nothing in this repo can currently tell
// the two apart: with `rendersAtOwnPosition(op)` deleted from the base case the emitted C is
// byte-identical over the 16,000 functions the generator builds (depth 0-3, 4,000 seeds each) and
// the whole of `packages/core/test` passes, 2,589 of 2,589 — this fixture included.
//
// The reason it is inert on a CALL is that `unreadResult` already answers yes for one — `effects`
// puts it in `SPELLED_WHEN_DEAD_OPS` and its `reads` is not `true` — so the base case only changes
// the answer for an op `unreadResult` REFUSES while `sideEffects` still renders it at its own
// position: a non-volatile `load`/`aload`, whose `reads: true` keeps it out of the `exprstmt`
// branch. The generator emits no `load`, so no seed here reaches it. What this fixture does pin is
// the EMISSION — `%2`'s only consumer is a dead `add` in another block, which materializes it while
// leaving its name unread, and the call must be spelled exactly once.
const MATERIALIZED_UNREAD = `fn matunread {
^bb0(%0: s32):
  %1: s32 = call %0 {target="f0"}
  %2: s32 = call %1 {target="f1"}
  %3: u32 = icmp_slt %0, %0
  cond_br %3, ^bb1(), ^bb1()
^bb1():
  %4: s32 = add %2, %0
  ret %0
}
`;

test('a call whose only consumer is dead is still spelled', () => {
  expect(count(lift(DEAD_CONSUMER).src, 'f0(')).toBe(1);
});

test('a MATERIALIZED call whose only consumer is dead keeps its assignment', () => {
  const { src } = lift(MATERIALIZED);
  expect(count(src, 'f0(')).toBe(1);
  // the value goes somewhere — `v0;` would be the bare-statement branch, with the call dropped
  expect(src).toMatch(/=\s*f0\(/);
});

test('a call feeding a MATERIALIZED def that nothing reads is spelled ONCE, not twice', () => {
  const { src } = lift(MATERIALIZED_UNREAD);
  expect(count(src, 'f0(')).toBe(1);
  expect(count(src, 'f1(')).toBe(1);
});

// The oracle itself on all three fixtures: what the tree observes is what the IR observes. `traceOf`
// against another `traceOf` cannot make this assertion — the defect above was in every spelling.
test.each([
  ['dead consumer', DEAD_CONSUMER],
  ['materialized', MATERIALIZED],
  ['materialized, unread', MATERIALIZED_UNREAD],
])('%s: the tree observes what the IR observes', (_name, ir) => {
  const { fn, src } = lift(ir);
  expect(src).toBeTruthy();
  const tree = structure(fn, {});
  for (let seed = 1; seed <= 64; seed++) {
    expect(tracesDiffer({ off: irTraceOf(fn, seed), on: traceOf(tree, seed) }), `seed ${seed}`).toBe(false);
  }
});
