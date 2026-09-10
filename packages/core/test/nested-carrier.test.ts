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
import { traceOf } from './helpers';

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

// The inner INDUCTION variable starts at the outer one (`for (j = i; …)`), and the outer update
// `i + 1` is an unnamed value re-derived at the outer latch — from `i`'s name, which the inner loop
// would have advanced.
const INDUCTION = NEST.replace('br ^bb2(%5, %4)', 'br ^bb2(%3, %4)');

test('an inner induction variable seeded from the outer one keeps its own name (re-derives)', () => {
  const fn = lifted(INDUCTION);
  expect(emit(fn)).toMatch(/v2 = v0;/);
  for (let seed = 1; seed <= 64; seed++) {
    expect(traceOf(structure(fn), seed)).toEqual(traceOf(reference(fn), seed));
  }
});

test('ablating re-derives advances the outer induction variable inside the inner loop', () => {
  const fn = lifted(INDUCTION);
  expect(copies(emit(fn, 're-derives'))).toEqual([]);
  const ablated = structure(fn, {}, { carrierNameGates: without(CARRIER_NAME_GATES, 're-derives') });
  const differs = [...Array(64).keys()].some(
    (s) => JSON.stringify(traceOf(ablated, s + 1)) !== JSON.stringify(traceOf(reference(fn), s + 1)),
  );
  expect(differs).toBe(true);
});
