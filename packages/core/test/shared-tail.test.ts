// THE SHARED DEFAULT TAIL — `structure()`'s `followEarlyReturns` and `raise/tailsink.ts`, which
// rank.ts enumerates together as the `/shared-tail` twin.
//
// The source shape is one tail written ONCE, after an `if`, with every other path into a `ret`
// an early `return;`. agbcc reaches it two ways, and each fixture below is one of them:
//   - the compiler LEFT an arm returning on its own and shared the rest (`synthetic:gcseinner`):
//     the follow alone recovers it;
//   - the arms cross-jumped into one `store; ret` (`synthetic:gcsetail`): the tail has to be sunk
//     back into the arms before the follow can see them as early returns.
// Every refusal has a positive control one fact away from it.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Fn } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { tallying } from '../src/l3/gates';
import { TAIL_SINK_GATES, sinkStoreTails } from '../src/raise/tailsink';
import { enumerateCandidates } from '../src/rank';
import { hasDivergentSharedRet, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';
import { count } from './helpers';

const emit = (fn: Fn, followEarlyReturns: boolean) =>
  cBackend.emit(structure(fn, { returnsVoid: true, followEarlyReturns }));

/** `gcsetail` without its loop: `^bb4` is the path both sides of `^bb0` fall into, `^bb3` an arm
 *  reached from the else side only, and both branch into the one store tail `^bb5`. */
const CROSS_JUMPED = `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32* = gaddr {sym="gQ"}
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: s32 = call %0 {target="work"}
  br ^bb4()
^bb2():
  %6: u32 = icmp_slt %1, %3
  cond_br %6, ^bb3(), ^bb4()
^bb3():
  %7: s32 = const {value=7}
  br ^bb5(%7)
^bb4():
  %8: s32 = const {value=9}
  br ^bb5(%8)
^bb5(%9: s32):
  store %2, %9 {off=4, width=4}
  ret
}
`;

/** `gcseinner`'s shape: the arm `^bb3` keeps its OWN `ret`, and `^bb4` — reached from both sides —
 *  is the tail the source wrote once. */
const LEFT_RETURNING = `fn g {
^bb0(%0: s32, %1: s32):
  %2: s32* = gaddr {sym="gQ"}
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: s32 = call %0 {target="work"}
  br ^bb4()
^bb2():
  %6: u32 = icmp_slt %1, %3
  cond_br %6, ^bb3(), ^bb4()
^bb3():
  %7: s32 = const {value=7}
  store %2, %7 {off=4, width=4}
  ret
^bb4():
  %8: s32 = const {value=9}
  store %2, %8 {off=4, width=4}
  ret
}
`;

test('a region both arms of a divergent `if` reach is its follow, and the other `ret` an early return', () => {
  const fn = parse(LEFT_RETURNING);
  verify(fn);
  expect(hasDivergentSharedRet(fn)).toBe(true);
  // Off, the arms diverge and the shared store is written in each; on, once, after the `if`.
  expect(count(emit(fn, false), '[1] = 9;')).toBe(2);
  const on = emit(fn, true);
  expect(count(on, '[1] = 9;')).toBe(1);
  expect(on).toMatch(/\[1\] = 7;\s+return;\s+}\s+} else {\s+work\(a0\);\s+}\s+\(\(s32 \*\)&gQ\)\[1\] = 9;/);
});

test('an `if` whose returning arms share nothing keeps them divergent', () => {
  // `^bb3` and `^bb4` are each reached from ONE side, so no region is the follow.
  const fn = parse(LEFT_RETURNING.replace('cond_br %6, ^bb3(), ^bb4()', 'br ^bb3()'));
  verify(fn);
  expect(hasDivergentSharedRet(fn)).toBe(false);
  expect(emit(fn, true)).toBe(emit(fn, false));
});

test("the enclosing region's follow is never emitted inside an arm", () => {
  // Inside the else side, `^bb2`'s arms share `^bb6` — but `^bb5` also reaches `^bb7`, the OUTER
  // `if`'s follow, without passing `^bb6`. Taking `^bb6` as `^bb2`'s follow would structure that
  // path into `^bb7` inside the arm; the refusal keeps `^bb7` once, after the outer `if`.
  const fn = parse(`fn h {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32* = gaddr {sym="gQ"}
  %4: s32 = const {value=0}
  %5: u32 = icmp_slt %0, %4
  cond_br %5, ^bb1(), ^bb2()
^bb1():
  %6: s32 = call %0 {target="work"}
  br ^bb7()
^bb2():
  %7: u32 = icmp_slt %1, %4
  cond_br %7, ^bb3(), ^bb4()
^bb3():
  %8: s32 = const {value=3}
  br ^bb6(%8)
^bb4():
  %9: u32 = icmp_slt %2, %4
  cond_br %9, ^bb5(), ^bb7()
^bb5():
  %10: s32 = const {value=4}
  br ^bb6(%10)
^bb6(%11: s32):
  store %3, %11 {off=8, width=4}
  ret
^bb7():
  %12: s32 = const {value=9}
  store %3, %12 {off=4, width=4}
  ret
}
`);
  verify(fn);
  const follows: number[] = [];
  const on = cBackend.emit(
    structure(
      fn,
      { returnsVoid: true, followEarlyReturns: true },
      { onEarlyReturnFollow: (s) => follows.push(s.block) },
    ),
  );
  expect(follows).toEqual([0]);
  expect(count(on, '[1] = 9;')).toBe(1);
});

test('a cross-jumped store tail is sunk into the one-sided arm and kept for the path both sides reach', () => {
  const fn = parse(CROSS_JUMPED);
  verify(fn);
  expect(sinkStoreTails(fn)).toBe(true);
  verify(fn);
  const ir = print(fn);
  expect(ir).toContain('%7: s32 = const {value=7}\n  store %2, %7 {off=4, width=4}\n  ret');
  expect(ir).toContain('store %2, %8 {off=4, width=4}\n  ret');
  expect(count(emit(fn, true), '[1] = 9;')).toBe(1);
});

test('the two terms are one capability: sunk without the follow, the tail is written on every path', () => {
  const fn = parse(CROSS_JUMPED);
  expect(count(emit(fn, true), '[1] = v')).toBe(1); // unsunk: one merged store, whatever the option
  sinkStoreTails(fn);
  expect(count(emit(fn, false), '[1] = 9;')).toBe(2);
  expect(count(emit(fn, true), '[1] = 9;')).toBe(1);
});

test('a tail whose arms are each reached from ONE side has no kept path and is not sunk', () => {
  // `gcsedup`'s shape: both sources hang off the inner `if`, so neither is what both sides of the
  // tail's dominator fall into.
  const fn = parse(CROSS_JUMPED.replace('cond_br %4, ^bb1(), ^bb2()', 'cond_br %4, ^bb2(), ^bb2()'));
  const t1 = tallying(TAIL_SINK_GATES);
  expect(sinkStoreTails(fn, t1.gates)).toBe(false);
  expect(t1.refusals().map(([id]) => id)).toEqual(['dominator-is-not-a-branch']);
  const one = parse(
    CROSS_JUMPED.replace('  %5: s32 = call %0 {target="work"}\n  br ^bb4()', '  br ^bb6()').replace(
      '^bb5(%9: s32):',
      '^bb6():\n  ret\n^bb5(%9: s32):',
    ),
  );
  verify(one);
  const t2 = tallying(TAIL_SINK_GATES);
  expect(sinkStoreTails(one, t2.gates)).toBe(false);
  expect(t2.refusals().map(([id]) => id)).toEqual(['no-single-path-from-both-sides']);
});

test('an arm that reaches the tail by a conditional branch refuses; the kept path may', () => {
  const armCond = parse(
    CROSS_JUMPED.replace('cond_br %6, ^bb3(), ^bb4()', 'cond_br %6, ^bb5(%3), ^bb4()').replace(
      '^bb3():\n  %7: s32 = const {value=7}\n  br ^bb5(%7)\n',
      '',
    ),
  );
  verify(armCond);
  const t = tallying(TAIL_SINK_GATES);
  expect(sinkStoreTails(armCond, t.gates)).toBe(false);
  expect(t.refusals().map(([id]) => id)).toEqual(['conditional-arm']);
});

test('an arm that branches into the tail through a pure forwarder gets its copy too', () => {
  // `gcsefwd`'s shape: `^bb6` forwards to the tail, and the one-sided arm `^bb3` reaches it only
  // through the forwarder, which the both-sides path `^bb4` also uses.
  const fn = parse(
    CROSS_JUMPED.replace('  br ^bb5(%7)', '  br ^bb6(%7)')
      .replace('  br ^bb5(%8)', '  br ^bb6(%8)')
      .replace('^bb5(%9: s32):', '^bb6(%10: s32):\n  br ^bb5(%10)\n^bb5(%9: s32):'),
  );
  verify(fn);
  expect(sinkStoreTails(fn)).toBe(true);
  verify(fn);
  expect(print(fn)).toContain('%7: s32 = const {value=7}\n  store %2, %7 {off=4, width=4}\n  ret');
  expect(count(emit(fn, true), '[1] = 9;')).toBe(1);
});

// The rank.ts half, on hand-lifted Thumb bodies: `/shared-tail` is a DISTINCT source beside the
// spellings it does not replace, which the fan keeps — the same IR can come from the duplicated
// source (`gcsepre`/`gcsepredup` lift byte-identical), so only the differ decides.
const P = { f: { params: 2, returnsVoid: true } };
const THUMB_LEFT =
  'f:\n\tpush\t{lr}\n\tldr\tr2, .L9\n\tcmp\tr0, #0\n\tblt\t.L3\n\tcmp\tr1, #0\n\tbge\t.L5\n' +
  '\tmov\tr3, #7\n\tstr\tr3, [r2, #4]\n\tb\t.L6\n.L3:\n\tstr\tr1, [r2, #8]\n.L5:\n\tmov\tr3, #9\n' +
  '\tstr\tr3, [r2, #4]\n.L6:\n\tpop\t{r0}\n\tbx\tr0\n.L10:\n\t.align\t2, 0\n.L9:\n\t.word\tgQ\n';

test('rank.ts enumerates `/shared-tail` where an arm the compiler left returning shares the rest', () => {
  const cands = enumerateCandidates('f', THUMB_LEFT, ARMV4T_AGBCC, { prototypes: P });
  const twin = cands.filter((c) => c.label.includes('/shared-tail'));
  expect(twin.length).toBeGreaterThan(0);
  expect(twin.every((c) => count(c.source, ' = 9;') === 1 && /= 7;\s+return;/.test(c.source))).toBe(true);
  expect(cands.some((c) => c.label === 'unsigned' && count(c.source, ' = 9;') === 2)).toBe(true);
});

// The cross-jumped tail, which only the sink turns into early returns.
const THUMB =
  'f:\n\tpush\t{lr}\n\tldr\tr2, .L9\n\tcmp\tr0, #0\n\tblt\t.L3\n\tcmp\tr1, #0\n\tbge\t.L5\n' +
  '\tmov\tr3, #7\n\tb\t.L6\n.L3:\n\tstr\tr1, [r2, #8]\n.L5:\n\tmov\tr3, #9\n.L6:\n\tstr\tr3, [r2, #4]\n' +
  '\tpop\t{r0}\n\tbx\tr0\n.L10:\n\t.align\t2, 0\n.L9:\n\t.word\tgQ\n';

test('rank.ts enumerates `/shared-tail` on a cross-jumped tail, beside the unsunk spellings', () => {
  const cands = enumerateCandidates('f', THUMB, ARMV4T_AGBCC, { prototypes: P });
  const twin = cands.filter((c) => c.label.includes('/shared-tail'));
  expect(twin.length).toBeGreaterThan(0);
  expect(twin.every((c) => count(c.source, ' = 9;') === 1 && /= 7;\s+return;/.test(c.source))).toBe(true);
  expect(cands.some((c) => c.label === 'unsigned' && c.source.includes('[1] = v0;'))).toBe(true);
  expect(cands.some((c) => c.label === 'unsigned/unmerge')).toBe(true);
});
