// The guarded self-loop's TWO emitted forms (structure.ts, the fusion site). A guard-shaped
// cond_br in front of a self-loop is fused into a `while` ONLY under the guard proof — the guard
// is provably the loop's own test, so the `while`'s re-test subsumes it. An UNPROVEN guard keeps
// its `if`, with the loop as a bottom-tested `do-while` inside it (gcc's "guard + do-while"
// lowering, emitted as itself): every test the asm performs appears in the C. The kept form also
// carries no header-purity restriction — its first test runs after the body — so a header holding
// a MATERIALIZED def structures instead of declining.
import { expect, test } from 'vitest';

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

// Guard `n <= 0` beside latch `n != 0` — the countdown-`for` lowering (agbcc/gcc reverse the
// induction variable, so the two predicates differ). Fusing to `while (v != 0)` would run a loop
// the source skipped for every negative n; the guard must survive as its own `if`.
const UNPROVEN = `fn keptguard {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_sle %0, %1
  cond_br %2, ^bb2(%0), ^bb1(%0)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  %6: u32 = icmp_ne %5, %1
  cond_br %6, ^bb1(%5), ^bb2(%5)
^bb2(%7: s32):
  ret %7
}
`;

test('an unproven guard keeps its if: guard + do-while, both tests emitted', () => {
  const c = emit(UNPROVEN);
  // the guard reads the loop variable the init just assigned — the parked register's spelling
  expect(c).toContain('if (v0 > 0)');
  expect(c).toContain('do {');
  expect(c).toContain('} while (v0 != 0);');
  expect(c).not.toContain('while (v0 != 0) {'); // not the fused while
});

// Same shape, but the guard `n != 0` IS the latch's test at entry (n-1 substituted back to n) —
// the proof holds and the fused `while` stays.
const PROVEN = `fn fusedguard {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(%0), ^bb2(%0)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  %6: u32 = icmp_ne %5, %1
  cond_br %6, ^bb1(%5), ^bb2(%5)
^bb2(%7: s32):
  ret %7
}
`;

test('a proven guard still fuses (for-recognition then folds the init in)', () => {
  const c = emit(PROVEN);
  expect(c).toContain('for (v0 = a0; v0 != 0; v0 = v0 - 1)');
  expect(c).not.toContain('do {');
});

// A MATERIALIZED def in the header (a call whose result is read twice must execute once). The
// fused `while`'s first test would read its temp before the body assigned it, so fusion is out —
// but the kept-guard do-while tests after the body and structures fine.
const MATERIALIZED_HEADER = `fn matheader {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(%0), ^bb2(%0)
^bb1(%3: s32):
  %4: s32 = call {target="f"}
  %5: s32 = add %4, %4
  %6: s32 = sub %3, %5
  %7: u32 = icmp_ne %6, %1
  cond_br %7, ^bb1(%6), ^bb2(%6)
^bb2(%8: s32):
  ret %8
}
`;

test('a materialized header def structures as guard + do-while instead of declining', () => {
  const c = emit(MATERIALIZED_HEADER);
  // the shared `0` is materialized (two reads live across the call), hence `!= v0`; the guard
  // reads the counter through its loop-variable name
  expect(c).toContain('if (v2 != v0)');
  expect(c).toContain('= f();'); // the call's temp, assigned inside the body
  expect(c).toContain('do {');
});
