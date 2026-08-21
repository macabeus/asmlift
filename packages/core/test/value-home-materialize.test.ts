// The two register-home materialization rules in structure/analysis.ts:
//
//   • copyInterdependent — a parallel-copy arg read by a SIBLING arg's def-tree. Inlined, the
//     sibling's copy re-derives the whole expression (and `sequentialize` spills old-value temps
//     to untangle the order): arithmetic the compiler performed once, emitted per reader. The
//     coupled-recurrence loop is the canonical shape (`a += b*b; b += a;`).
//   • liveAcrossLoop — an access performed BEFORE a loop whose single use renders AFTER it.
//     Rendering at the use re-schedules the access to the far side of the loop; the compiler
//     parked the value in a callee-saved register for the loop's whole duration instead.
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

// a += b*b; b += a; — a' is a back-edge arg AND is read by b's update. Unmaterialized, b's copy
// re-derives `a + b*b` in old values through a swap temp; materialized, both spell in-place.
const COUPLED = `fn recur {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_sle %2, %3
  cond_br %4, ^bb2(%0, %1), ^bb1(%0, %1, %2)
^bb1(%5: s32, %6: s32, %7: s32):
  %8: s32 = mul %6, %6
  %9: s32 = add %5, %8
  %10: s32 = add %6, %9
  %11: s32 = const {value=1}
  %12: s32 = sub %7, %11
  %13: u32 = icmp_ne %12, %3
  cond_br %13, ^bb1(%9, %10, %12), ^bb2(%9, %10)
^bb2(%14: s32, %15: s32):
  %16: s32 = add %14, %15
  ret %16
}
`;

test('a copy arg read by its sibling materializes: in-place updates, no re-derivation, no swap temp', () => {
  const c = emit(COUPLED);
  expect(c).toContain('v0 = v0 + v1 * v1;');
  expect(c).toContain('v1 = v1 + v0;');
  expect(c).not.toContain('t0'); // no sequentialize spill
  // the product appears ONCE — the sibling reads the materialized name, never the expression
  expect(c.match(/v1 \* v1/g)?.length).toBe(1);
});

// keep = p[1] before the loop, read once after it. Inline rendering would move the load to the
// far side of the loop; the compiler performed it before and carried the value across.
const CROSS_LOAD = `fn crossload {
^bb0(%0: s32, %1: s32):
  %2: s32 = load %0 {off=4, width=4, signed=1}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sle %1, %3
  cond_br %4, ^bb2(%1), ^bb1(%1)
^bb1(%5: s32):
  %6: s32 = const {value=1}
  %7: s32 = sub %5, %6
  %8: u32 = icmp_ne %7, %3
  cond_br %8, ^bb1(%7), ^bb2(%7)
^bb2(%9: s32):
  %10: s32 = add %9, %2
  ret %10
}
`;

test('a load live across a loop materializes before it instead of sinking past it', () => {
  const c = emit(CROSS_LOAD);
  const loadAt = c.search(/v\d+ = \(\(s32 \*\)a0\)\[1\];/);
  const ifAt = c.indexOf('if (');
  expect(loadAt).toBeGreaterThanOrEqual(0);
  expect(ifAt).toBeGreaterThan(0);
  expect(loadAt).toBeLessThan(ifAt); // the access stays on the def's side of the loop
});
