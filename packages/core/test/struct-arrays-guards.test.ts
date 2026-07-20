// The struct-arrays clean-gate guards, pinned at the IR level — one test per hole the
// adversarial round REPRODUCED as silent wrong bytes or a loud regression when the pass first
// wired (2026-07-17). Each hostile shape must make recognizeStructArrays DECLINE (count 0);
// the golden shape still fires. Offline: hand-written IR, no toolchain.
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recognizeStructArrays } from '../src/raise/struct-arrays';

const run = (ir: string): number => {
  const fn = parse(ir);
  verify(fn);
  return recognizeStructArrays(fn);
};

// the clean golden: one element pointer, disjoint aligned fields, base untyped and un-derefed
const GOLDEN = `fn ok {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=0, signed=true, width=4}
  %6: s32 = load %4 {off=4, signed=false, width=2}
  %7: s32 = add %5, %6
  ret %7
}
`;

describe('struct-arrays clean-gate — adversarial-round pins', () => {
  test('the golden single-element-pointer shape still fires', () => {
    expect(run(GOLDEN)).toBe(1);
  });

  test('F1a: elem as the store VALUE of its own access declines (operand positions > 0 are uses)', () => {
    expect(
      run(`fn f1a {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  store %4, %4 {off=4, width=4}
  ret %1
}
`),
    ).toBe(0);
  });

  test('F1b: elem carried as a successor block-arg declines (a use the operand scan never sees)', () => {
    expect(
      run(`fn f1b {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = const {value=8}
  %4: s32 = mul %1, %3
  %5: s32 = add %0, %4
  %6: s32 = load %5 {off=0, signed=true, width=4}
  %7: u32 = icmp_ne %6, %2
  cond_br %7, ^bb1(%5), ^bb1(%0)
^bb1(%8: s32):
  %9: s32 = load %8 {off=0, signed=true, width=4}
  ret %9
}
`),
    ).toBe(0);
  });

  test('F2: overlapping field offsets decline (withPadding assumes disjoint fields)', () => {
    expect(
      run(`fn f2 {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=0, signed=true, width=4}
  %6: s32 = load %4 {off=2, signed=false, width=2}
  %7: s32 = add %5, %6
  ret %7
}
`),
    ).toBe(0);
  });

  test('F3: a same-offset width CONFLICT declines (collapsing widths deletes a byte-range)', () => {
    expect(
      run(`fn f3 {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=4, signed=false, width=2}
  store %4, %5 {off=4, width=4}
  ret %5
}
`),
    ).toBe(0);
  });

  test('F4: a base with DIRECT memory accesses declines (the retype would poison arr->x)', () => {
    expect(
      run(`fn f4 {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %0 {off=0, signed=true, width=4}
  %6: s32 = load %4 {off=4, signed=true, width=4}
  %7: s32 = add %5, %6
  ret %7
}
`),
    ).toBe(0);
  });

  test('F5: a base with element pointers at TWO strides declines entirely (ambiguous view)', () => {
    expect(
      run(`fn f5 {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = const {value=12}
  %4: s32 = mul %1, %3
  %5: s32 = add %0, %4
  %6: s32 = load %5 {off=0, signed=true, width=4}
  %7: s32 = const {value=8}
  %8: s32 = mul %2, %7
  %9: s32 = add %0, %8
  %10: s32 = load %9 {off=0, signed=true, width=4}
  %11: s32 = add %6, %10
  ret %11
}
`),
    ).toBe(0); // two strides over one base is a reinterpreted view or 2D layout — decline over guess
  });

  test('rematerialized element pointers (same base, same stride) recover TOGETHER as one struct', () => {
    // the GetGender shape: the compiler materializes the same element address twice; a
    // first-claims-the-base rule would leave the twin raw — a mixed spelling worse than either.
    expect(
      run(`fn twin {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=28}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=16, signed=false, width=1}
  %6: s32 = const {value=28}
  %7: s32 = mul %1, %6
  %8: s32 = add %0, %7
  %9: s32 = load %8 {off=16, signed=false, width=1}
  %10: s32 = add %5, %9
  ret %10
}
`),
    ).toBe(1); // ONE group, ONE struct, both twins rewritten
  });

  test('F6: a misaligned field declines; a stride the widest field does not divide declines', () => {
    expect(
      run(`fn f6a {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=1, signed=false, width=2}
  ret %5
}
`),
    ).toBe(0);
    expect(
      run(`fn f6b {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=6}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=0, signed=true, width=4}
  ret %5
}
`),
    ).toBe(0); // stride 6 % widest field 4 ≠ 0 — the declared sizeof would not be 6
  });
});

describe('remediation-verifier pins — stale values and signedness', () => {
  test('chained groups: a load DEFINING another group base survives its own rewrite (no dead values)', () => {
    // `q = o[i].p; return q[j].a + q[j].b;` — group O's rewrite must not kill the value group Q
    // captured as its base; the aload reuses the load's result, so nothing goes stale.
    const fn = parse(`fn chain {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = const {value=8}
  %4: s32 = mul %1, %3
  %5: s32 = add %0, %4
  %6: unk32 = load %5 {off=0, signed=true, width=4}
  %7: s32 = const {value=8}
  %8: s32 = mul %2, %7
  %9: s32 = add %6, %8
  %10: s32 = load %9 {off=0, signed=true, width=4}
  %11: s32 = load %9 {off=4, signed=true, width=4}
  %12: s32 = add %10, %11
  ret %12
}
`);
    verify(fn);
    expect(recognizeStructArrays(fn)).toBe(2); // both groups recover
    verify(fn); // and every operand still has a live def — the crash shape
  });

  test('same-offset LOAD signedness conflict declines (merging drops one extension)', () => {
    expect(
      run(`fn mixsign {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=0, signed=true, width=2}
  %6: s32 = load %4 {off=0, signed=false, width=2}
  %7: s32 = add %5, %6
  ret %7
}
`),
    ).toBe(0);
  });

  test('a STORE at a loaded offset does NOT sign-conflict (store signedness is convention, not fact)', () => {
    // the common lha + sth pair on one field — must still recover, signed from the LOAD
    expect(
      run(`fn ldst {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=4, signed=true, width=2}
  store %4, %5 {off=4, width=2}
  ret %5
}
`),
    ).toBe(1);
  });
});
