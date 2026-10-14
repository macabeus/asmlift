// A LOOP TEST THE COMPILER PEELED INTO THE ENTRY (raise/reroll.ts `rerollPeeledTests`).
//
// agbcc rotates `for (i = 0; i < n; i++) { if (p[i] == 7) { hit(); break; } } out();` so the loop is
// entered at its increment, and tests p[0] in the entry block. The arm then has a predecessor outside
// the loop, and no loop spelling owns it (`synthetic:break_code:agbcc`). The entry's test is the
// loop's first iteration; rotated back, the test block heads the loop and the arm has one way in.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { type Gate, without } from '../src/l3/gates';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { type PeeledTest, REROLL_GATES, rerollPeeledTests } from '../src/raise/reroll';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const PEELED = `fn peeled {
^bb0(%0: u8*, %1: s32):
  %2: s32 = const {value=0}
  %3: s32 = load %0 {off=0, signed=false, width=1}
  %4: s32 = const {value=7}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb3(), ^bb1(%2)
^bb1(%6: s32):
  %7: s32 = const {value=1}
  %8: s32 = add %6, %7
  %9: u32 = icmp_slt %8, %1
  cond_br %9, ^bb2(), ^bb4()
^bb2():
  %10: u8* = add %8, %0
  %11: s32 = load %10 {off=0, signed=false, width=1}
  %12: u32 = icmp_eq %11, %4
  cond_br %12, ^bb3(), ^bb1(%8)
^bb3():
  %13: s32 = call %1 {target="hit"}
  br ^bb4()
^bb4():
  %14: s32 = call {target="out"}
  ret %14
}`;

const rerolled = (ir: string, gates: readonly Gate<PeeledTest>[] = REROLL_GATES) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const n = rerollPeeledTests(fn, gates);
  verify(fn);
  return { n, fn };
};

test('an entry test that is the loop’s own at its first values is the first iteration', () => {
  const { n, fn } = rerolled(PEELED);
  expect(n).toBe(1);
  const sfn = structure(fn);
  const src = cBackend.emit(sfn);
  expect(src.match(/hit\(/g)).toHaveLength(1);
  expect(src.match(/\*a0|a0\[/g)).toHaveLength(1); // the test is written once, in the loop
});

/** The same rotation over a test the trace oracle models (it has no loads or multiplies): `if (i + i == a1)`. */
const PEELED_ARITH = PEELED.replace('%3: s32 = load %0 {off=0, signed=false, width=1}', '%3: s32 = add %2, %2')
  .replace('%4: s32 = const {value=7}', '%4: s32 = add %1, %2')
  .replace('%10: u8* = add %8, %0', '%10: s32 = add %8, %2')
  .replace('%11: s32 = load %10 {off=0, signed=false, width=1}', '%11: s32 = add %10, %8');

test('the rotated loop computes what the peeled one does', () => {
  const { n, fn } = rerolled(PEELED_ARITH);
  expect(n).toBe(1);
  const sfn = structure(fn);
  expect(cBackend.emit(sfn).match(/hit\(/g)).toHaveLength(1);
  expect(irAgreement(PEELED_ARITH, sfn, SEEDS)).toEqual({ judged: 300, disagree: 0 });
  expect(irAgreement(PEELED_ARITH, readabilityRewrites(sfn), SEEDS)).toEqual({ judged: 300, disagree: 0 });
});

test('an entry test that differs from the loop’s at its first values is left alone', () => {
  // the entry compares with 8, the loop with 7
  const other = PEELED.replace(
    '  %5: u32 = icmp_eq %3, %4\n',
    '  %20: s32 = const {value=8}\n  %5: u32 = icmp_eq %3, %20\n',
  );
  expect(rerolled(other).n).toBe(0);
  // …and so is one reading another element: the entry tests p[1], which is not the first iteration's
  expect(rerolled(PEELED.replace('%3: s32 = load %0 {off=0,', '%3: s32 = load %0 {off=1,')).n).toBe(0);
});

test('an entry that writes memory after its test reads it is left alone', () => {
  const writes = PEELED.replace(
    '  %4: s32 = const {value=7}\n',
    '  %4: s32 = const {value=7}\n  store %0, %4 {off=0, width=1}\n',
  );
  expect(rerolled(writes).n).toBe(0);
});

test('a test that calls is left alone — the entry’s call would run as well', () => {
  const calls = PEELED.replace(
    '%3: s32 = load %0 {off=0, signed=false, width=1}',
    '%3: s32 = call %2 {target="t"}',
  ).replace('%11: s32 = load %10 {off=0, signed=false, width=1}', '%11: s32 = call %8 {target="t"}');
  expect(rerolled(calls).n).toBe(0);
});

// agbcc -O2 of `for (i = 0; i < 16; i++) { gCnt++; if (gTab[i] == 7) { gHit = 1; break; } } gOut = 0;`
// peels `gCnt++` into the entry WITH the first test, and the latch repeats it. The tests compare,
// but rotated, the latch would run its `gCnt++` on the first iteration while the entry kept its own:
// one increment more than the asm.
const PEELED_EFFECT = PEELED.replace(
  '^bb0(%0: u8*, %1: s32):\n',
  '^bb0(%0: u8*, %1: s32):\n  %30: s32* = gaddr {sym="gCnt"}\n  %31: s32 = load %30 {off=0, signed=true, width=4}\n' +
    '  %32: s32 = const {value=1}\n  %33: s32 = add %31, %32\n  store %30, %33 {off=0, width=4}\n',
).replace(
  '^bb2():\n',
  '^bb2():\n  %34: s32 = load %30 {off=0, signed=true, width=4}\n  %35: s32 = add %34, %32\n  store %30, %35 {off=0, width=4}\n',
);

test('a latch that runs an effect besides its test is left alone — the entry’s peeled copy stays', () => {
  expect(rerolled(PEELED_EFFECT).n).toBe(0);
});

test('a latch that reads memory outside its test is left alone — the first iteration would read it once more', () => {
  const reads = PEELED.replace(
    '^bb2():\n',
    '^bb2():\n  %30: s32* = gaddr {sym="gReg"}\n  %31: s32 = load %30 {off=0, signed=false, width=1}\n',
  );
  expect(rerolled(reads).n).toBe(0);
});

// The loop's admission is `REROLL_GATES`; each fixture below is refused by one rule alone.

/** The latch compares with a `7` the header computes, not the entry's. */
const READS_HEADER = PEELED.replace('^bb1(%6: s32):\n', '^bb1(%6: s32):\n  %40: s32 = const {value=7}\n').replace(
  '%12: u32 = icmp_eq %11, %4',
  '%12: u32 = icmp_eq %11, %40',
);

test('a latch that reads a header value it does not hand round is left alone', () => {
  expect(rerolled(READS_HEADER).n).toBe(0);
});

/** A second header param, which the latch hands a constant of its own. */
const BACK_ARG_IN_LATCH = PEELED.replace('cond_br %5, ^bb3(), ^bb1(%2)', 'cond_br %5, ^bb3(), ^bb1(%2, %2)')
  .replace('^bb1(%6: s32):', '^bb1(%6: s32, %41: s32):')
  .replace('  cond_br %12, ^bb3(), ^bb1(%8)', '  %42: s32 = const {value=5}\n  cond_br %12, ^bb3(), ^bb1(%8, %42)');

test('a back-edge arg the latch computes itself is left alone', () => {
  expect(rerolled(BACK_ARG_IN_LATCH).n).toBe(0);
});

/** The latch hands `i` to both header params, which enter as `0` and `a1`; the entry tests `p[a1]`,
 *  which is the latch's test if `i` enters as `a1` — true of the second param only. */
const BACK_ARG_REPEATED = PEELED.replace(
  '  %3: s32 = load %0 {off=0, signed=false, width=1}',
  '  %50: u8* = add %1, %0\n  %3: s32 = load %50 {off=0, signed=false, width=1}',
)
  .replace('cond_br %5, ^bb3(), ^bb1(%2)', 'cond_br %5, ^bb3(), ^bb1(%2, %1)')
  .replace('^bb1(%6: s32):', '^bb1(%6: s32, %41: s32):')
  .replace('cond_br %12, ^bb3(), ^bb1(%8)', 'cond_br %12, ^bb3(), ^bb1(%8, %8)');

test('a latch that hands one value to two header params is left alone', () => {
  expect(rerolled(BACK_ARG_REPEATED).n).toBe(0);
});

test('each refusal above is its rule’s alone', () => {
  const cases: [string, string][] = [
    ['latch-reads-header', READS_HEADER],
    ['back-arg-in-latch', BACK_ARG_IN_LATCH],
    ['back-arg-repeated', BACK_ARG_REPEATED],
    ['latch-runs-more', PEELED_EFFECT],
  ];
  for (const [id, ir] of cases) {
    const ablated = without(REROLL_GATES, id);
    // without the rule the rotation goes ahead, and either breaks the IR or changes what it computes
    let n: number;
    try {
      n = rerolled(ir, ablated).n;
    } catch {
      n = 1;
    }
    expect(n, id).toBe(1);
  }
});

test('the rotation keeps the write-order record saying who wrote each key it re-targets', () => {
  // Measured as a frontend would: E wrote the key of H's param, H computed the back-edge value,
  // T copied nothing. A missing entry on a measured block reads as "key unwritten" (ir/core.ts
  // `WriteOrder`), which licenses a nested loop's parameter to take the enclosing header's name.
  const fn = parse(PEELED);
  verify(fn);
  recoverTypes(fn);
  const [E, H, T] = fn.blocks;
  const p = H.params[0];
  fn.writeOrder = {
    lastWrite: new Map([[E, new Map([[p, 0]])]]),
    writes: new Map(fn.blocks.map((b, i) => [b, i === 2 ? 1 : 2] as const)),
  };
  expect(rerollPeeledTests(fn)).toBe(1);
  verify(fn); // ordinals inside each block's count
  const q = T.params[0];
  expect(fn.writeOrder.lastWrite.get(E)?.get(q)).toBe(0); // E's edge, re-targeted: same write
  expect(fn.writeOrder.lastWrite.get(E)?.has(p)).toBe(false);
  expect(fn.writeOrder.lastWrite.get(H)?.has(q)).toBe(true); // H computes what the back edge carries
  expect(fn.writeOrder.lastWrite.get(T)?.has(p) ?? false).toBe(false);
});
