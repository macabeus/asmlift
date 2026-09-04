// The mid-pipeline SCORE PROBE and the headline must structure the same program.
//
// `decompileWithReport` scores a pattern's delta by cloning the fn as it stands, raising and
// structuring the clone, and scoring that. The clone is therefore not a convenience: it is the
// program the reported `scoreDelta` is about. Anything on `Fn` the structurer reads and the clone
// drops makes the probe measure a program asmlift does not emit — the same defect the file's
// symbol-map comments call out, one field over.
//
// `Fn.writeOrder` (the frontend's per-edge write-order measurement) is exactly such a field: with
// it the agbcc gcd lift spells its latch copies in the compiler's order, without it the
// def-position proxy picks the other cycle member AND `recognizeForLoops` then sees a different
// last statement. One lift, two sources — which is what this pins.
import { cBackend } from '@asmlift/core/backend/c';
import { frontendFor } from '@asmlift/core/frontend/registry';
import { raiseRecovered, structureChecked } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, structureOptionsFor } from '@asmlift/core/target';
import { expect, test } from 'vitest';

import { structuredCloneFn } from '../../src/report';

// synthetic:gcd:agbcc's own disassembly (packages/core/test/corpus/agbcc-gcd.s).
const GCD = [
  '\t.code\t16',
  '\t.globl\tgcd',
  '\t.thumb_func',
  'gcd:',
  '\tpush\t{r4, lr}',
  '\tadd\tr2, r0, #0',
  '\tadd\tr0, r1, #0',
  '\tcmp\tr0, #0',
  '\tbeq\t.L4\t@cond_branch',
  '.L5:',
  '\tadd\tr4, r0, #0',
  '\tadd\tr0, r2, #0',
  '\tadd\tr1, r4, #0',
  '\tbl\t__modsi3',
  '\tadd\tr2, r4, #0',
  '\tcmp\tr0, #0',
  '\tbne\t.L5\t@cond_branch',
  '.L4:',
  '\tadd\tr0, r2, #0',
  '\tpop\t{r4}',
  '\tpop\t{r1}',
  '\tbx\tr1',
  '',
].join('\n');

const emit = (fn: Parameters<typeof raiseRecovered>[0]) => {
  raiseRecovered(fn, ARMV4T_AGBCC, {}, undefined);
  return cBackend.emit(
    structureChecked(fn, {
      ...structureOptionsFor(ARMV4T_AGBCC, false),
      spellSwitchFallthrough: cBackend.spellsSwitchFallthrough,
    }),
  );
};

test('the score probe clones every side table the structurer reads: same lift, same source', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('gcd', GCD, ARMV4T_AGBCC, {}, undefined, undefined);
  expect(fn.writeOrder).toBeDefined();
  const clone = structuredCloneFn(fn);
  expect(clone.writeOrder).toBeDefined();
  expect(emit(clone)).toBe(emit(fn));
});

test('…and the cloned record is keyed by the CLONE’s objects, not the original’s', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('gcd', GCD, ARMV4T_AGBCC, {}, undefined, undefined);
  const clone = structuredCloneFn(fn);
  const order = clone.writeOrder!;
  expect(order.writes.size).toBeGreaterThan(0);
  // Every block the clone's record measures is a block OF THE CLONE (a shallow copy of the
  // reference would key on the original's blocks, every lookup would miss, and every destination
  // would fall to "no record" — worse than the proxy, and silent).
  for (const b of order.writes.keys()) {
    expect(clone.blocks).toContain(b);
    expect(fn.blocks).not.toContain(b);
  }
  const params = new Set(clone.blocks.flatMap((b) => b.params));
  for (const rec of order.lastWrite.values()) {
    for (const p of rec.keys()) {
      expect(params.has(p)).toBe(true);
    }
  }
});
