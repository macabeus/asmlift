// M0 — determinism is STRUCTURAL, not conventional. Value identity is object identity;
// names are assigned at print time by traversal. So the printed form is independent of
// the names in the source text and of construction order, and there is no global
// counter to forget to reset.
import { expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';

const A = `fn f {
^bb0(%0: s32):
  %1: s32 = add %0, %0
  %2: s32 = add %1, %0
  ret %2
}
`;

// Same structure, deliberately different (non-sequential) textual value names.
const A_RENAMED = `fn f {
^bb0(%7: s32):
  %3: s32 = add %7, %7
  %9: s32 = add %3, %7
  ret %9
}
`;

test('alpha-variant inputs print byte-identically', () => {
  expect(print(parse(A_RENAMED))).toBe(print(parse(A)));
});

test('printing is idempotent across repeated runs', () => {
  const fn = parse(A);
  expect(print(fn)).toBe(print(fn));
  expect(print(fn)).toBe(A);
});

test('no cross-function contamination (independent identity)', () => {
  // Parsing/printing one function never perturbs another; both are stable regardless
  // of order, because there is no shared mutable counter.
  const f = parse(A);
  const g = parse(`fn g {\n^bb0(%0: u8*):\n  %1: u8 = load %0 {off=0, signed=false, width=8}\n  ret %1\n}\n`);
  const f1 = print(f),
    g1 = print(g);
  print(g);
  print(f); // interleave
  expect(print(f)).toBe(f1);
  expect(print(g)).toBe(g1);
});
