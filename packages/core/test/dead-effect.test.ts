// AN EFFECT THE MACHINE PERFORMED MUST REACH THE SOURCE — `unreadResult` in
// `structure/structure.ts`, and the transitive use test behind it.
//
// `sideEffects` spells a call nothing consumes, because a call is an execution. What decided
// "nothing consumes it" was the analysis registry's USE SITES, which are syntactic: an op whose
// result feeds one pure op that is itself never rendered HAS a use site, so the call read as
// consumed — and then neither the consumer nor the call was emitted. The function simply stopped
// making the call. It compiles, it scores, and it computes something else.
//
// FOUND BY THE IR ORACLE, not by a reader. `irTraceOf` against the emitted tree over
// `generateSsaFn`'s acyclic seeds disagreed on 433 of 4,000, and every disagreement was a call the
// IR performed and the tree did not. Neither naming fuzz could see it: both their reference
// spellings dropped the same call, which is the whole argument for an oracle that reads the IR
// rather than a second spelling.
//
// Three fixtures, one per rule the predicate is made of — the transitive walk, the materialized-def
// exemption `unreadResult` needs in front of it, and `isSpelled`'s materialized BASE CASE, which is
// a third rule and not a restatement of the second.
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
// named value is the NAME, so `v0;` replaces the assignment and the call is gone again. The two
// sets barely met while the use test was syntactic; under the transitive test they overlap
// constantly, which is why the exemption is part of the predicate and not a detail.
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

// THE THIRD RULE, and the one the sweeps cannot see. `isSpelled` returns true for a materialized
// def as a BASE CASE, before asking whether anything reads it — because such a def renders at its
// own position whether or not its name is ever read. Drop that base case and the walk instead asks
// the question, gets "nothing spelled reads `%2`", and reports the f1 call unspelled; `%1` then has
// no spelled use either, so `unreadResult` fires on it and emits a BARE `f0(a0);` statement — on
// top of the `f1(f0(a0))` the materialized def still renders. The call runs TWICE.
//
// Ablated, that costs exactly 2 emitted lines over the generator's 16,000 functions (depth 0-3,
// 4,000 seeds each: `fz3585` at depth 2 and `fz377` at depth 3, byte-identical everywhere else) —
// and the IR oracle scores both unchanged, because a function is judged at its own seed only and
// neither extra call is on that seed's path. So the sweeps CANNOT pin this rule at any size, and
// the whole core suite passes with the base case deleted. It takes a fixture, which is this one:
// `%2`'s only consumer is a dead `add` in another block, which is what materializes it while
// leaving its name unread.
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
