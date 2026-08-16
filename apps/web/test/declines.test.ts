// The decline classifier is FIRST-MATCH over an ordered list, and its ORDER is the whole product:
// it decides which missing capability the blocker Pareto tells the next round to build. Nothing
// tested it, and reordering one entry silently collapsed the largest MIPS family into the generic
// bucket — the classes still all existed, the counts just moved. These pin the orderings that
// actually overlap.
import type { FunctionResult } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

import { DECLINE_CLASSES, declineClassesOf } from '../src/pages/benchmark/lib/declines';

/** a declined row carrying exactly these markers */
const row = (...errorMarkers: string[]) =>
  ({ asmlift: { outcome: 'declined', errorMarkers } }) as unknown as FunctionResult;

const classOf = (marker: string) => declineClassesOf(row(marker))[0];

describe('specific instruction families beat the generic opaque bucket', () => {
  // `opaque-ops` is `unmodelled instruction` with NO mnemonic filter, so it subsumes every class
  // that matches a named instruction. It must sit below all of them.
  test.each([
    ['mtc1', 'float'],
    ['mfc1', 'float'],
    ['cvt.s.w', 'float'],
    ['add.s', 'float'],
    ['lwc1', 'float'],
    ['fmr', 'float'],
    ['stfd', 'float'],
  ])("unmodelled instruction '%s' classifies as %s, not opaque-ops", (mnemonic, want) => {
    expect(classOf(`structure: unmodelled instruction '${mnemonic}'`)).toBe(want);
  });

  test('a mnemonic in no family still lands in opaque-ops', () => {
    expect(classOf("structure: unmodelled instruction 'clz'")).toBe('opaque-ops');
  });
});

describe('the instruction cause beats the shape symptom', () => {
  // An `opaque` makes its block impure, so a shape recognizer refuses and the decline reads as a
  // loop/switch problem. pipeline.ts `attributeOpaques` appends the instruction; these pin that the
  // appended half is the one that wins, or the attribution would be cosmetic.
  test('a loop-shape decline naming an unmodelled instruction is opaque-ops', () => {
    expect(
      classOf(
        "structure: cannot structure 'f': unrecovered back-edge into block #1 (loop-recovery declined " +
          'this shape: multi-latch, irreducible/overlapping loops, a conditional continue, or an unsafe ' +
          "break) — and the function carries unmodelled instruction 'clz', which is the more likely cause",
      ),
    ).toBe('opaque-ops');
  });

  test('…and the FLOAT family still wins over both', () => {
    expect(
      classOf(
        "structure: cannot structure 'f': unrecovered back-edge into block #1 (loop-recovery declined " +
          "this shape) — and the function carries unmodelled instruction 'mtc1', which is the more likely cause",
      ),
    ).toBe('float');
  });

  test('a loop-shape decline with NO unmodelled instruction is still loop-shapes', () => {
    // Without this, "always classify as opaque-ops" would pass the two tests above.
    expect(classOf("structure: cannot structure 'f': unrecovered back-edge into block #1")).toBe('loop-shapes');
  });
});

describe('all three "unmodelled …" message spellings are classified', () => {
  // The frontend and the structurer word this differently, and a spelling nobody matched fell into
  // "other" — which reads as "we do not know what blocks these" when in fact we do.
  test.each([
    ["structure: unmodelled instruction 'mtc1'", 'float'],
    ["lift: unmodelled effect instruction 'mtc1' — no register destination to degrade", 'float'],
    ["lift: unmodelled store-class instruction 'swc1' — a memory write cannot be skipped", 'store-class'],
    ["structure: unmodelled instruction 'clz'", 'opaque-ops'],
    ["lift: unmodelled effect instruction 'teq' — no register destination to degrade", 'opaque-ops'],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });
});

describe('the list is well-formed', () => {
  test('keys are unique', () => {
    const keys = DECLINE_CLASSES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('no pattern carries the global flag', () => {
    // A `/g` RegExp reused across `.test()` calls advances `lastIndex` and returns alternating
    // answers — the classifier calls each pattern once per marker, so this would be nondeterministic.
    expect(DECLINE_CLASSES.filter((c) => c.pattern.global)).toEqual([]);
  });

  test('an unrecognised reason is preserved as "other", never dropped', () => {
    expect(classOf('structure: something nobody has classified yet')).toBe('other');
  });
});
