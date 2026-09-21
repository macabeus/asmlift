// A `do-while` whose bottom test reads a loop variable BEFORE the update the compiler has already
// emitted — `do { … } while (v0 != 0 && v1++ <= 9)`. The update leaves the foot of the body and is
// spelled at the leaf that reads it, which is the only C form that gets both facts right: the test
// sees the pre-update value, and the increment runs exactly on the iterations the machine ran it.
//
// Its refusals live in `PREUPDATE_COND_GATES` (structure/hazards.ts) and are ablated one at a time
// in hazards.test.ts, on hand-built values. What these pin is the other half: that the emitter
// reaches the fold at all, that the update really leaves the body, and that a shape the gates turn
// away declines loud and names the gate. One refusal beside them is not the table's: a `&&`/`||`
// the fold puts in the test may also skip an EFFECT the asm ran unconditionally, which
// `testSkipsAnEffect` asks of every `do-while`.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import type { Expr } from '../src/l3/ast';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, spellUpdateInCond, structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// `do { r = work(a0); } while (r != 0 && i++ <= 9)`, the kleod `DeleteAllSaveData` shape: ^bb1 is
// header and latch, %2 is the retry counter, and the bottom test reads it at %9 — one update behind
// the %5 the back edge carries. The `&&` puts the read in the arm the loop only evaluates when the
// first one held, which is also the only iteration that re-enters.
const RETRY_COUNT = `fn retrycount {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = call %0 {target="work"}
  %4: s32 = const {value=1}
  %5: s32 = add %2, %4
  %6: s32 = const {value=0}
  %7: u32 = icmp_ne %3, %6
  %8: s32 = const {value=9}
  %9: u32 = icmp_sle %2, %8
  %10: u32 = logic_and %7, %9
  cond_br %10, ^bb1(%5), ^bb2()
^bb2():
  ret %3
}
`;

// The one-fact edit: `||` in place of `&&`. The loop re-enters whenever the FIRST arm holds, on an
// iteration that never evaluated the second — so the counter would miss an increment the back edge
// still carries, and `folded-on-every-continue` refuses.
const RETRY_COUNT_OR = RETRY_COUNT.replace('logic_and', 'logic_or').replace('retrycount', 'retryor');

// The counter stepped by two: `n += 2` has no read-then-update operator in C, so
// `update-is-a-unit-step` refuses and the loop declines.
const RETRY_COUNT_BY_TWO = RETRY_COUNT.replace('%4: s32 = const {value=1}', '%4: s32 = const {value=2}').replace(
  'retrycount',
  'retrytwo',
);

test('the pre-update read in the bottom test is spelled `++`, and the update leaves the body', () => {
  // The counter is still DECLARED and still initialized: the `++` is its only reader, and a walk
  // that counted it as neither a read nor a write would drop both (l3/dce.ts).
  expect(emit(RETRY_COUNT)).toBe(
    's32 retrycount(s32 a0) {\n' +
      '    s32 v0;\n' +
      '    s32 v1;\n' +
      '    v1 = 0;\n' +
      '    do {\n' +
      '        v0 = work(a0);\n' +
      '    } while (v0 != 0 && v1++ <= 9);\n' +
      '    return v0;\n' +
      '}\n',
  );
});

test('a leaf an iteration can re-enter the loop without evaluating still declines', () => {
  expect(() => emit(RETRY_COUNT_OR)).toThrow(StructureError);
  expect(() => emit(RETRY_COUNT_OR)).toThrow(/no '\+\+' for the test's own read: folded-on-every-continue/);
});

test('an update with no `++` spelling still declines', () => {
  expect(() => emit(RETRY_COUNT_BY_TWO)).toThrow(/no '\+\+' for the test's own read: update-is-a-unit-step/);
});

// The same loop with the arms the other way round, an `||` joining them, and the COUNTER as the
// return value: `do { r = work(a0); } while (i++ <= 9 || r != 0); return i;`. Nothing but the test
// reads the call now, so it renders inlined — in the operand the `||` skips on every iteration the
// counter's arm answers true, while agbcc's `bl` sits ahead of both branches.
const RETRY_COUNT_CALL_IN_ARM = `fn retrycall {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = call %0 {target="work"}
  %4: s32 = const {value=1}
  %5: s32 = add %2, %4
  %6: s32 = const {value=0}
  %7: u32 = icmp_ne %3, %6
  %8: s32 = const {value=9}
  %9: u32 = icmp_sle %2, %8
  %10: u32 = logic_or %9, %7
  cond_br %10, ^bb1(%5), ^bb2(%5)
^bb2(%11: s32):
  ret %11
}
`;

test('a call the rendered test may skip declines, whatever the counter does', () => {
  expect(() => emit(RETRY_COUNT_CALL_IN_ARM)).toThrow(StructureError);
  expect(() => emit(RETRY_COUNT_CALL_IN_ARM)).toThrow(/an effect behind a '&&'\/'\|\|'/);
});

// The rewrite itself. Nothing reaches its null answers through `structure()` today — the gate that
// admits the fold has already established the count on the def tree — so the rule is pinned here
// rather than through a function no fixture can produce.
test('the rewrite refuses unless the rendered test names the variable exactly once', () => {
  const le = (l: Expr): Expr => ({ k: 'bin', op: '<=', l, r: { k: 'const', value: 9 } });
  const v = (name: string): Expr => ({ k: 'var', name });
  expect(spellUpdateInCond(le(v('v1')), 'v1', 1)).toEqual(le({ k: 'postincr', name: 'v1', by: 1 }));
  expect(spellUpdateInCond(le(v('v1')), 'v1', -1)).toEqual(le({ k: 'postincr', name: 'v1', by: -1 }));
  // named twice: C89 leaves which value the other read sees undefined
  expect(spellUpdateInCond({ k: 'bin', op: '&&', l: v('v1'), r: le(v('v1')) }, 'v1', 1)).toBe(null);
  // not named at all: the update would be dropped, not moved
  expect(spellUpdateInCond(le(v('v2')), 'v1', 1)).toBe(null);
  // `&v1` is not a read of v1, so it is not the leaf the update goes to either
  expect(spellUpdateInCond(le({ k: 'addr', name: 'v1' }), 'v1', 1)).toBe(null);
  // …and beside a readable leaf it is still a second mention: C89's rule counts `&v1`, so the `++`
  // has nowhere to go here either
  expect(
    spellUpdateInCond(
      { k: 'bin', op: '&&', l: { k: 'call', fn: 'f', args: [{ k: 'addr', name: 'v1' }] }, r: le(v('v1')) },
      'v1',
      1,
    ),
  ).toBe(null);
});
