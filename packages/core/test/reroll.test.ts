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
import { PRE_STRUCTURE_FOLDS } from '../src/raise/pre-structure';
import { recoverTypes } from '../src/raise/recover';
import {
  type FoldedTopTest,
  type PeeledTest,
  REROLL_GATES,
  TOP_TEST_GATES,
  rerollPeeledTests,
} from '../src/raise/reroll';
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

/** `synthetic:break_value:agbcc` as it reaches the folds: the break leaves through ^bb3, an empty
 *  block carrying i to the shared exit, so the latch's out-edge and the entry's do not land on one
 *  block until the trampoline fold splices ^bb3 out. */
const BREAK_VALUE_PRE_TRAMPOLINE = `fn break_value {
^bb0():
  %0: s32 = const {value=1}
  %1: s32 = const {value=1}
  %2: u8* = gaddr {sym="gTab"}
  %3: s32 = load %2 {off=1, signed=false, width=1}
  %4: s32* = gaddr {sym="gOut"}
  %5: s32 = gaddr {sym="gVal"}
  %6: s32 = const {value=28}
  %7: u32 = icmp_eq %3, %6
  cond_br %7, ^bb4(%0), ^bb1(%1)
^bb1(%8: s32):
  %9: s32 = const {value=1}
  %10: u32 = add %8, %9
  %11: u32 = const {value=8}
  %12: u32 = icmp_ugt %10, %11
  cond_br %12, ^bb4(%0), ^bb2()
^bb2():
  %13: u8* = add %10, %2
  %14: s32 = load %13 {off=0, signed=false, width=1}
  %15: s32 = const {value=28}
  %16: u32 = icmp_ne %14, %15
  cond_br %16, ^bb1(%10), ^bb3()
^bb3():
  br ^bb4(%10) {fallthrough=true}
^bb4(%17: s32):
  %18: u8* = add %17, %5
  %19: s32 = load %18 {off=0, signed=false, width=1}
  store %4, %19 {off=0, width=4}
  ret
}`;

test('the re-roll reads the shape the trampoline fold leaves, so the trampoline runs first', () => {
  // Each fold runs once, in the record's order, with no fixpoint across folds: run before the
  // trampoline, the re-roll sees the latch leave for ^bb3 and the entry for ^bb4, and declines.
  const alone = rerolled(BREAK_VALUE_PRE_TRAMPOLINE);
  expect(alone.n).toBe(0);
  const ids = PRE_STRUCTURE_FOLDS.map((f) => f.id);
  expect(ids.indexOf('trampoline')).toBeLessThan(ids.indexOf('reroll'));
  const fn = parse(BREAK_VALUE_PRE_TRAMPOLINE);
  verify(fn);
  recoverTypes(fn);
  const ran = PRE_STRUCTURE_FOLDS.map((f) => {
    const n = f.run(fn);
    verify(fn);
    return [f.id, n] as const;
  });
  expect(Object.fromEntries(ran)).toMatchObject({ trampoline: 1, reroll: 1 });
  const src = cBackend.emit(structure(fn, { returnsVoid: true, littleEndian: true }));
  expect(src.match(/gTab/g)).toHaveLength(1); // the test is written once, in the loop
});

// ── THE TOP TEST THE COMPILER FOLDED AWAY (reroll.ts `restoreTopTest`) ─────────────────────────
//
// With a constant bound the rotated loop's exit test, read on the entry values, provably stays in:
// the source tested at the top (`for (i = 0; i < 16; i++)`), and the re-rolled loop says so again.

const bounded = (ir: string) =>
  ir.replace('  %9: u32 = icmp_slt %8, %1\n', '  %40: s32 = const {value=16}\n  %9: u32 = icmp_slt %8, %40\n');
const TOP = bounded(PEELED);
const TOP_ARITH = bounded(PEELED_ARITH);
const emitted = (ir: string, gates?: readonly Gate<FoldedTopTest>[]) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  rerollPeeledTests(fn, REROLL_GATES, gates);
  verify(fn);
  return { fn, src: cBackend.emit(structure(fn)) };
};

test('a re-rolled loop whose exit test stays in on entry is tested at the top', () => {
  const { src } = emitted(TOP);
  expect(src).toContain('for (v0 = 0; v0 < 16; v0 = v0 + 1) {');
  expect(src).not.toContain('while (1)');
  expect(src.match(/hit\(/g)).toHaveLength(1);
  const { fn } = emitted(TOP_ARITH);
  const sfn = structure(fn);
  expect(irAgreement(TOP_ARITH, sfn, SEEDS)).toEqual({ judged: 300, disagree: 0 });
  expect(irAgreement(TOP_ARITH, readabilityRewrites(sfn), SEEDS)).toEqual({ judged: 300, disagree: 0 });
});

/** The loop starts at 20, past the bound: the exit test leaves on entry, after one iteration. */
const starts20 = (ir: string) =>
  ir
    .replace('  %2: s32 = const {value=0}\n', '  %2: s32 = const {value=0}\n  %60: s32 = const {value=20}\n')
    .replace('cond_br %5, ^bb3(), ^bb1(%2)', 'cond_br %5, ^bb3(), ^bb1(%60)');
const LEAVES = starts20(TOP).replace('%3: s32 = load %0 {off=0,', '%3: s32 = load %0 {off=20,');
const LEAVES_ARITH = starts20(TOP_ARITH).replace('%3: s32 = add %2, %2', '%3: s32 = add %60, %60');

test('an exit test true on the entry values keeps the bottom test', () => {
  expect(rerolled(LEAVES).n).toBe(1);
  expect(emitted(LEAVES).src).toContain('while (1) {');
});

test('an exit test against a parameter keeps the bottom test', () => {
  expect(emitted(PEELED).src).toContain('while (1) {');
});

test('an exit test that reads memory keeps the bottom test', () => {
  const loaded = PEELED.replace(
    '  %9: u32 = icmp_slt %8, %1\n',
    '  %40: s32* = gaddr {sym="gN"}\n  %41: s32 = load %40 {off=0, signed=true, width=4}\n  %9: u32 = icmp_slt %8, %41\n',
  );
  expect(emitted(loaded).src).toContain('while (1) {');
});

/** The bound is `1 + 15`, over the `1` the increment reads too, which stays in the latch. */
const SHARES_INCREMENT = (ir: string) =>
  ir.replace(
    '  %9: u32 = icmp_slt %8, %1\n',
    '  %40: s32 = const {value=15}\n  %41: s32 = add %7, %40\n  %9: u32 = icmp_slt %8, %41\n',
  );

test('an exit test reading a constant the increment shares keeps the bottom test', () => {
  expect(emitted(SHARES_INCREMENT(PEELED)).src).toContain('while (1) {');
});

test('an exit that its edges hand different values keeps the bottom test', () => {
  const carries = TOP.replace('cond_br %9, ^bb2(), ^bb4()', 'cond_br %9, ^bb2(), ^bb4(%8)')
    .replace('  br ^bb4()\n^bb4():', '  br ^bb4(%2)\n^bb4(%50: s32):')
    .replace('%14: s32 = call {target="out"}', '%14: s32 = call %50 {target="out"}');
  const kept = emitted(carries);
  expect(kept.src).toContain('while (1) {');
  // a heuristic: without it the head is restored all the same
  expect(emitted(carries, without(TOP_TEST_GATES, 'exit-value-differs')).fn.blocks).toHaveLength(
    kept.fn.blocks.length + 1,
  );
});

/** `gOut = i` after the loop: the latch hands the exit `exitArg`, the arm the counter it tested. */
const OWN_VALUE_EXIT = (exitArg: string) =>
  TOP_ARITH.replace('cond_br %9, ^bb2(), ^bb4()', 'cond_br %9, ^bb2(), ^bb4(' + exitArg + ')')
    .replace('cond_br %5, ^bb3(), ^bb1(%2)', 'cond_br %5, ^bb3(%2), ^bb1(%2)')
    .replace('cond_br %12, ^bb3(), ^bb1(%8)', 'cond_br %12, ^bb3(%8), ^bb1(%8)')
    .replace(
      '^bb3():\n  %13: s32 = call %1 {target="hit"}\n  br ^bb4()',
      '^bb3(%51: s32):\n  %13: s32 = call %1 {target="hit"}\n  br ^bb4(%51)',
    )
    .replace('^bb4():', '^bb4(%50: s32):')
    .replace('%14: s32 = call {target="out"}', '%14: s32 = call %50 {target="out"}');

test('an exit that takes the loop’s own value from every edge is tested at the top', () => {
  // the counter the latch hands round and the one the arm tested are one value after the rotation
  const own = OWN_VALUE_EXIT('%8');
  const { fn, src } = emitted(own);
  expect(src).toContain('for (v0 = 0; v0 < 16; v0 = v0 + 1) {');
  expect(src.match(/hit\(/g)).toHaveLength(1);
  expect(irAgreement(own, structure(fn), SEEDS)).toEqual({ judged: 300, disagree: 0 });
});

/** The body tests `a1 < 2i` rather than `2i == a1`, so that skipping its first iteration shows on
 *  the seeds the oracle draws, not on one in four billion. */
const lessThan = (ir: string) =>
  ir.replace('icmp_eq %3, %4', 'icmp_slt %4, %3').replace('icmp_eq %11, %4', 'icmp_slt %4, %11');

test('each top-test refusal above is its rule’s alone', () => {
  // without the rule the head goes ahead, and either breaks the IR or changes what it computes
  const cases: [string, string][] = [
    ['reads-loop-value', SHARES_INCREMENT(PEELED_ARITH)],
    ['not-staying-at-entry', lessThan(LEAVES_ARITH)],
    ['not-staying-at-entry', lessThan(PEELED_ARITH)],
    // the exit reads the counter before its increment, which the new head has not got
    ['reads-loop-value', OWN_VALUE_EXIT('%6')],
  ];
  for (const [id, ir] of cases) {
    expect(emitted(ir).src, id).toContain('while (1) {');
    let disagree: number;
    try {
      disagree = irAgreement(ir, structure(emitted(ir, without(TOP_TEST_GATES, id)).fn), SEEDS).disagree;
    } catch {
      disagree = 1;
    }
    expect(disagree, id).toBeGreaterThan(0);
  }
});

/** The hit arm can return as well as break: `if (p[i] == 7) { if (hit(a1)) return 2; break; }`. */
const returnsAndBreaks = (ir: string) =>
  ir.replace(
    '^bb3():\n  %13: s32 = call %1 {target="hit"}\n  br ^bb4()',
    '^bb3():\n  %13: s32 = call %1 {target="hit"}\n  cond_br %13, ^bb5(), ^bb4()\n^bb5():\n  %15: s32 = const {value=2}\n  ret %15',
  );

test('an arm that can both return and reach the exit is written inside the restored loop', () => {
  // the arm owns its `ret` (no other edge enters it), so the `while` writes it as the `return` it is,
  // ahead of the `break`, and the loop is tested at the top
  const { src } = emitted(returnsAndBreaks(TOP));
  expect(src).toContain('for (v0 = 0; v0 < 16; v0 = v0 + 1) {');
  expect(src).not.toContain('while (1)');
  expect(src.match(/hit\(/g)).toHaveLength(1);
  expect(src).toMatch(/return 2;[\s\S]*break;/);
  const arith = returnsAndBreaks(TOP_ARITH);
  const sfn = structure(emitted(arith).fn);
  expect(irAgreement(arith, sfn, SEEDS)).toEqual({ judged: 300, disagree: 0 });
  expect(irAgreement(arith, readabilityRewrites(sfn), SEEDS)).toEqual({ judged: 300, disagree: 0 });
});

/** The arm reads `j = a1 + 3`, computed ahead of the loop: `j = n + 3; for (…) { if (…) { hit(j); break; } }`. */
const readsInvariant = (ir: string) =>
  ir
    .replace(
      '  %2: s32 = const {value=0}\n',
      '  %2: s32 = const {value=0}\n  %30: s32 = const {value=3}\n  %31: s32 = add %1, %30\n',
    )
    .replace('%13: s32 = call %1 {target="hit"}', '%13: s32 = call %31 {target="hit"}');

test('a value the arm reads, computed ahead of the loop, is named ahead of it', () => {
  // it crosses the loop in a register; inlined into the arm, every profile computes it there instead
  const { src } = emitted(readsInvariant(TOP));
  const named = src.match(/(v\d+) = a1 \+ 3;/);
  expect(named).not.toBeNull();
  expect(src.indexOf(named![0])).toBeLessThan(src.indexOf('for ('));
  expect(src).toContain(`hit(${named![1]});`);
  expect(irAgreement(readsInvariant(TOP_ARITH), structure(emitted(readsInvariant(TOP_ARITH)).fn), SEEDS)).toEqual({
    judged: 300,
    disagree: 0,
  });
});

/** `for (i = 0; i < n; i++)`: the copied exit test stays in front as a guard, `0 < a1`, and the
 *  peeled first test sits in the block it enters. */
const guarded = (ir: string) =>
  ir.replace(
    '^bb0(%0: u8*, %1: s32):\n  %2: s32 = const {value=0}\n',
    '^bb0(%0: u8*, %1: s32):\n  %2: s32 = const {value=0}\n  %20: u32 = icmp_slt %2, %1\n  cond_br %20, ^bb5(), ^bb4()\n^bb5():\n',
  );
const GUARDED = guarded(PEELED);
const GUARDED_ARITH = guarded(PEELED_ARITH);

test('a re-rolled loop entered under its own exit test is tested at the top, and the guard goes', () => {
  const { fn, src } = emitted(GUARDED);
  expect(src).toContain('for (v0 = 0; v0 < a1; v0 = v0 + 1) {');
  expect(src).not.toContain('while (1)');
  expect(src).not.toMatch(/if \(0 < a1\)/); // the guard is gone, not kept around the loop
  expect(fn.blocks[0].ops.at(-1)?.opcode).toBe('br');
  const arith = emitted(GUARDED_ARITH).fn;
  for (const sfn of [structure(arith), readabilityRewrites(structure(arith))]) {
    expect(irAgreement(GUARDED_ARITH, sfn, SEEDS)).toEqual({ judged: 300, disagree: 0 });
  }
});

test('a guard that is not the exit test on the entry values, or code between it and the loop, keeps it', () => {
  // the guard asks `1 < a1`, a test the loop's first iteration does not make
  const other = GUARDED_ARITH.replace(
    '  %20: u32 = icmp_slt %2, %1\n',
    '  %21: s32 = const {value=1}\n  %20: u32 = icmp_slt %21, %1\n',
  );
  // the block the guard enters calls out before the loop: it would run on the way out as well
  const runs = GUARDED_ARITH.replace('^bb5():\n', '^bb5():\n  %22: s32 = call {target="pre"}\n');
  for (const ir of [other, runs]) {
    const { fn, src } = emitted(ir);
    expect(src).toContain('while (1) {');
    expect(irAgreement(ir, structure(fn), SEEDS)).toEqual({ judged: 300, disagree: 0 });
  }
});

/** A void function whose loop exits straight into the epilogue: return-sinking gave the arm its own
 *  copy of the `ret`, marked as the fall-through into the epilogue it was. */
const SUNK = (attrs: string) =>
  TOP.replace(
    '^bb3():\n  %13: s32 = call %1 {target="hit"}\n  br ^bb4()',
    `^bb3():\n  %13: s32 = call %1 {target="hit"}\n  ret${attrs}`,
  ).replace('  %14: s32 = call {target="out"}\n  ret %14', '  ret');

test('an arm that fell into the exit’s return breaks to it in the restored loop', () => {
  const { src } = emitted(SUNK(' {fallthrough=true}'));
  expect(src).toContain('for (v0 = 0; v0 < 16; v0 = v0 + 1) {');
  expect(src).toMatch(/hit\(a1\);\s*break;/);
  // an arm that branched to the epilogue wrote its `return;`, and keeps it
  expect(emitted(SUNK('')).src).toMatch(/hit\(a1\);\s*return;/);
});
