// A NESTED LOOP'S CARRIED VALUE — `enclosingCarrierName` in `structure/structure.ts`.
//
// An accumulator updated inside an inner loop, and read after the outer one, is a parameter of
// BOTH loop headers. Seeded as two variables it is spelled `v3 = v1; do { … v3 … } while (…);
// v1 = v3;`, two copies the machine did not make. Whether it made them is what the frontend's
// write-order record says: the outer header wrote nothing into the inner parameter's key, so the
// value crossed into the inner loop in the register it already had.
//
// The fixture is `synthetic:nestacc1:agbcc`'s shape, with the data read spelled as a call so the
// interpreter in `helpers.ts` can run it. The last two pairs are the two collisions the walk's
// `enclosingNames` exclusion exists for, reached through this rule, and what refuses each one.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Block, Fn, Value } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { CARRIER_NAME_GATES, structure } from '../src/structure/structure';
import { irTraceOf, traceOf } from './helpers';
import { INNER_CLOBBERS_OUTER } from './loop-escape-witnesses';

const NEST = `fn nest {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=0}
  br ^bb1(%1, %2)
^bb1(%3: s32, %4: s32):
  %5: s32 = const {value=0}
  %6: s32 = const {value=1}
  %7: s32 = add %3, %6
  br ^bb2(%5, %4)
^bb2(%8: s32, %9: s32):
  %10: s32 = call %8 {target="f0"}
  %11: u32 = icmp_slt %10, %0
  cond_br %11, ^bb4(%9), ^bb3()
^bb3():
  %12: s32 = const {value=1}
  %13: s32 = add %9, %12
  br ^bb4(%13)
^bb4(%14: s32):
  %15: s32 = const {value=1}
  %16: s32 = add %8, %15
  %17: s32 = const {value=7}
  %18: u32 = icmp_slt %16, %17
  cond_br %18, ^bb2(%16, %14), ^bb5()
^bb5():
  %19: s32 = const {value=5}
  %20: u32 = icmp_slt %7, %19
  cond_br %20, ^bb1(%7, %14), ^bb6()
^bb6():
  ret %14
}
`;

/** Parse, and attach a write-order record the way a frontend would: every block measured, and
 *  `wrote` naming, per block, the params of its successors whose key it wrote last. Measurement is
 *  all-or-nothing per function (`ir/verify.ts`), so "the outer header wrote nothing" is an empty
 *  entry, not a missing one. */
const lifted = (ir: string, wrote: (fn: Fn) => Map<Block, Map<Value, number>> = () => new Map()): Fn => {
  const fn = parse(ir);
  const lastWrite = wrote(fn);
  const writes = new Map(fn.blocks.map((b) => [b, lastWrite.get(b)?.size ?? 0] as const));
  fn.writeOrder = { lastWrite, writes };
  verify(fn);
  recoverTypes(fn);
  return fn;
};

const emit = (fn: Fn, gate?: string): string =>
  cBackend.emit(structure(fn, {}, gate ? { carrierNameGates: without(CARRIER_NAME_GATES, gate) } : {}));

/** The spelling that adopts no name at all — correct by construction, the fuzz's own reference. */
const reference = (fn: Fn) =>
  structure(fn, {}, { carrierNameGates: [{ id: 'none', why: 'reference', sound: false, rejects: () => true }] });

const copies = (src: string): string[] => src.match(/\bv\d+ = v\d+;/g) ?? [];

test('an accumulator the outer header passes through unwritten is one variable across the nest', () => {
  const out = emit(lifted(NEST));
  expect(copies(out)).toEqual([]);
  expect(out).toMatch(/v1 = v1 \+ 1;/);
  expect(out).toMatch(/return v1;/);
});

test('an outer header that WROTE the inner key keeps the copy the source spelled', () => {
  const fn = lifted(NEST, (f) => new Map([[f.blocks[1], new Map([[f.blocks[2].params[1], 0]])]]));
  expect(copies(emit(fn)).length).toBe(2);
});

test('an unmeasured function keeps two variables — no record, no evidence', () => {
  const fn = parse(NEST);
  verify(fn);
  recoverTypes(fn);
  expect(copies(emit(fn)).length).toBe(2);
});

// ── the collisions `enclosingNames` excludes wholesale, and the gate that refuses each ─────────
// The outer loop's value is still READ after the inner loop ran — `f1(acc)` at the outer latch,
// with `acc` as it was before the inner loop. Under one name the inner loop overwrites it.
const READ_PAST = NEST.replace('^bb5():\n', '^bb5():\n  %21: s32 = call %4 {target="f1"}\n');

test('an enclosing value still live past the inner loop keeps its own name (carrier-live)', () => {
  const fn = lifted(READ_PAST);
  expect(copies(emit(fn)).length).toBe(2);
  for (let seed = 1; seed <= 64; seed++) {
    expect(traceOf(structure(fn), seed)).toEqual(traceOf(reference(fn), seed));
  }
});

test('ablating carrier-live lets the inner loop overwrite the value the outer latch reads', () => {
  const fn = lifted(READ_PAST);
  expect(copies(emit(fn, 'carrier-live'))).toEqual([]);
  const ablated = structure(fn, {}, { carrierNameGates: without(CARRIER_NAME_GATES, 'carrier-live') });
  const differs = [...Array(64).keys()].some(
    (s) => JSON.stringify(traceOf(ablated, s + 1)) !== JSON.stringify(traceOf(reference(fn), s + 1)),
  );
  expect(differs).toBe(true);
});

// The inner INDUCTION variable starts at the outer one (`for (j = i; …)`), and the outer back edge
// hands `i` the outer update `i + 1` — not anything the inner loop produced. The value is carried
// by one loop, not both, and `carriedByBothLoops` refuses before `canTakeName` is asked.
const INDUCTION = NEST.replace('br ^bb2(%5, %4)', 'br ^bb2(%3, %4)');

test('an inner induction variable seeded from the outer one keeps its own name (carried by one loop)', () => {
  const fn = lifted(INDUCTION);
  expect(emit(fn)).toMatch(/v2 = v0;/);
  for (let seed = 1; seed <= 64; seed++) {
    expect(traceOf(structure(fn), seed)).toEqual(irTraceOf(fn, seed));
  }
});

// The same induction variable, now SHARED by the two loops (the outer back edge hands `i` the
// inner loop's final `j`), so the clause above admits it — and an unnamed `i + 1` still read after
// the inner loop (`f1(i + 1)` at the outer latch) is re-derived there from `i`'s name. That is
// `re-derives`' refusal, reached through this rule.
const RE_DERIVES = INDUCTION.replace(
  '  %20: u32 = icmp_slt %7, %19\n  cond_br %20, ^bb1(%7, %14), ^bb6()',
  '  %21: s32 = call %7 {target="f1"}\n  %20: u32 = icmp_slt %16, %19\n  cond_br %20, ^bb1(%16, %14), ^bb6()',
);

test('an unnamed value re-derived from the shared induction variable keeps it apart (re-derives)', () => {
  const fn = lifted(RE_DERIVES);
  expect(emit(fn)).toMatch(/v2 = v0;/);
  for (let seed = 1; seed <= 64; seed++) {
    expect(traceOf(structure(fn), seed)).toEqual(irTraceOf(fn, seed));
  }
});

test('ablating re-derives advances the outer induction variable inside the inner loop', () => {
  const fn = lifted(RE_DERIVES);
  expect(copies(emit(fn, 're-derives'))).toEqual([]);
  const ablated = structure(fn, {}, { carrierNameGates: without(CARRIER_NAME_GATES, 're-derives') });
  const differs = [...Array(64).keys()].some(
    (s) => JSON.stringify(traceOf(ablated, s + 1)) !== JSON.stringify(irTraceOf(fn, s + 1)),
  );
  expect(differs).toBe(true);
});

// ── the collision `canTakeName` cannot see: `carriedByBothLoops` ──────────────────────────────
// `namecoalesce.test.ts`'s frozen `INNER_CLOBBERS_OUTER` pair, given the one record fact this rule
// reads. Sharing the name also hands it to the inner back edge's argument (`backArgName`) and to
// the outer back edge's un-rotation alias; neither is in `varName`, so neither `carrier-live` nor
// `re-derives` sees the reader. The outer back edge hands the enclosing slot something the inner
// loop did not produce, so the rule must refuse: without the clause both return another number,
// and nothing throws. Two records per witness — every block passing everything through, and only
// the outer header leaving the inner parameter's key unwritten (every other key WRITTEN, so no
// other admission can be the one that fires).
const passThrough = (): Map<Block, Map<Value, number>> => new Map();
const onlyTheInnerKeyUnwritten =
  (slot: number) =>
  (fn: Fn): Map<Block, Map<Value, number>> => {
    const unwritten = fn.blocks[2].params[slot];
    const record = new Map<Block, Map<Value, number>>();
    for (const b of fn.blocks) {
      const keys = new Map<Value, number>();
      for (const op of b.ops) {
        for (const s of op.successors) {
          for (const p of s.block.params) {
            if (!(b === fn.blocks[1] && p === unwritten)) {
              keys.set(p, keys.size);
            }
          }
        }
      }
      record.set(b, keys);
    }
    return record;
  };

test.each(
  INNER_CLOBBERS_OUTER.flatMap(({ seed, ir }) => [
    { seed, ir, record: 'pass-through', wrote: passThrough },
    { seed, ir, record: 'only the inner key unwritten', wrote: onlyTheInnerKeyUnwritten(0) },
  ]),
)('a value the outer back edge replaces is not the inner loop’s to share (seed $seed, $record)', ({ ir, wrote }) => {
  const fn = lifted(ir, wrote);
  const tree = structure(fn);
  const ref = reference(fn);
  for (let seed = 1; seed <= 64; seed++) {
    let want;
    try {
      want = traceOf(ref, seed);
    } catch {
      continue; // the step cap: this input loops forever in every spelling
    }
    expect(traceOf(tree, seed)).toEqual(want);
  }
});

// ── the scope refusals, pinned by what they refuse ────────────────────────────────────────────
// Neither is a soundness guard — the name is `carriedByBothLoops`' and `canTakeName`'s to judge —
// they bound what the record can be evidence FOR. Widening either is a decision about new evidence
// (the architect's note names the register-key identity), so each keeps a fixture that goes red.
//
// A block between the enclosing header and the inner one: the record is per predecessor, so the
// block could have made the copy and no record would say so. (Two refusals decide this together —
// the forward predecessor is not a loop header, and the argument is not its param — and no fixture
// separates them from `carriedByBothLoops`, which needs both too.)
const PREHEADER = NEST.replace(
  '  br ^bb2(%5, %4)\n^bb2(',
  '  br ^bb7()\n^bb7():\n  %30: s32 = const {value=0}\n  br ^bb2(%30, %4)\n^bb2(',
);

test('a block between the enclosing header and the inner one keeps two variables', () => {
  expect(copies(emit(lifted(PREHEADER))).length).toBe(2);
});

// An inner header entered from a second block too: the record for `E` says nothing about the
// other edge.
const TWO_ENTRIES = NEST.replace(
  '  br ^bb2(%5, %4)\n^bb2(',
  '  %31: u32 = icmp_slt %3, %0\n  cond_br %31, ^bb2(%5, %4), ^bb7()\n^bb7():\n  %32: s32 = const {value=2}\n  br ^bb2(%32, %4)\n^bb2(',
);

test('an inner header with a second forward predecessor keeps two variables', () => {
  expect(copies(emit(lifted(TWO_ENTRIES))).length).toBeGreaterThan(0);
});
