// The parameter-merge-home rule (structure.ts freshParamMerge): a merge that conditionally
// overwrites a function PARAMETER takes its own local instead of assigning back into the
// parameter's name. Off by default.
//
// What these tests pin is the SCOPE. The carrier decides: an entry parameter, or a home this rule
// itself minted — and nothing else, so a merge over ordinary locals keeps the adoption the rest of
// the naming walk rests on. The refusals are here too: a redundant phi (which overwrites nothing),
// and a loop header (whose init copy already IS the seed this rule mints for a plain merge).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { type StructureOptions, structure } from '../src/structure/structure';

const emit = (ir: string, on: boolean, extra: StructureOptions = {}): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { freshParamMerge: on, ...extra }));
};

// ── the isolate: `int m = a>b?a:b; return m>c?m:c;` at agbcc -O2 ──────────────────────────────
// Two merges in a row. The first is over the parameters `a1`/`a0`; the second is over `a2` and the
// first merge's own result, which is what makes the rule's second clause observable.
const MAX3 = `fn max3 {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: u32 = icmp_sge %1, %0
  cond_br %3, ^bb2(%1), ^bb1()
^bb1():
  br ^bb2(%0)
^bb2(%4: s32):
  %5: u32 = icmp_sge %2, %4
  cond_br %5, ^bb4(%2), ^bb3()
^bb3():
  br ^bb4(%4)
^bb4(%6: s32):
  ret %6
}
`;

test('a merge over parameters takes its own home instead of writing one of them', () => {
  expect(emit(MAX3, false)).toMatch(/a1 = a0;/);
  const on = emit(MAX3, true);
  expect(on).not.toMatch(/a[012] = /);
  expect(on).toMatch(/v0 = a0;/);
});

test('…and the merge above it does not take that home either — two values, two homes', () => {
  // `%6` merges the parameter `a2` with `%4`, the home the rule just minted. Adopting it would
  // chain both values through one register; the rule refuses its own homes for that reason.
  const on = emit(MAX3, true);
  expect(on).toMatch(/s32 v1;/);
  expect(on).toMatch(/return v1;/);
});

// ── a REDUNDANT phi is not an overwrite ──────────────────────────────────────────────────────
// Every edge passes `%0`, so the merge is a pure alias of the parameter: a fresh home would buy a
// copy and move nothing.
const ALIAS = `fn aliasmerge {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %0, %2
  cond_br %3, ^bb2(%0), ^bb1()
^bb1():
  store %1, %2 {off=0, width=4}
  br ^bb2(%0)
^bb2(%4: s32):
  ret %4
}
`;

test('a redundant phi over one parameter keeps the parameter', () => {
  expect(emit(ALIAS, true)).toBe(emit(ALIAS, false));
  expect(emit(ALIAS, true)).toMatch(/return a0;/);
});

// ── an ordinary LOCAL still lends its name ───────────────────────────────────────────────────
// Two merges again, but the first is over constants — so its home is one the naming walk minted on
// its own, not one this rule did. The second merge adopts it exactly as before.
const CHAINLOCAL = `fn chainlocal {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: s32 = const {value=7}
  %4: u32 = icmp_eq %0, %2
  cond_br %4, ^bb2(%3), ^bb1()
^bb1():
  store %1, %3 {off=0, width=4}
  br ^bb2(%2)
^bb2(%5: s32):
  %6: u32 = icmp_sgt %5, %2
  cond_br %6, ^bb4(%5), ^bb3()
^bb3():
  %7: s32 = const {value=9}
  br ^bb4(%7)
^bb4(%8: s32):
  ret %8
}
`;

test('a merge over ordinary locals is untouched — the second clause is not "every local"', () => {
  expect(emit(CHAINLOCAL, true)).toBe(emit(CHAINLOCAL, false));
  expect(emit(CHAINLOCAL, true)).toMatch(/if \(v0 <= 0\) v0 = 9;/);
});

// ── a LOOP HEADER keeps its seat ─────────────────────────────────────────────────────────────
// `seedLoopParams` names header params before this walk runs, and on a coalesceLoopInit target it
// deliberately keeps the induction variable in the parameter's register — the init copy vanishes.
// That decision is the loop's, and this rule never reaches it.
const LOOPHDR = `fn loopsum {
^bb0(%0: s32, %1: s32):
  br ^bb1(%0, %1)
^bb1(%2: s32, %3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %2, %4
  %6: s32 = add %3, %2
  %7: u32 = icmp_sgt %5, %4
  cond_br %7, ^bb1(%5, %6), ^bb2(%6)
^bb2(%8: s32):
  ret %8
}
`;

test('a loop header still coalesces onto its init parameter', () => {
  const on = emit(LOOPHDR, true, { coalesceLoopInit: true });
  expect(on).toBe(emit(LOOPHDR, false, { coalesceLoopInit: true }));
  expect(on).toMatch(/a0 = a0 - 1;/);
});
