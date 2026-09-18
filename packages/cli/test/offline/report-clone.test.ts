// The mid-pipeline SCORE PROBE and the headline must structure the same program.
//
// `decompileWithReport` scores a pattern's delta by cloning the fn as it stands, raising and
// structuring the clone, and scoring that. The clone is therefore not a convenience: it is the
// program the reported `scoreDelta` is about, so anything on `Fn` the structurer reads and the
// clone drops makes the probe measure a program asmlift does not emit.
//
// `Fn.writeOrder` (the frontend's per-edge write-order measurement) is exactly such a field: with
// it the agbcc gcd lift spells its latch copies in the compiler's order, without it the
// def-position proxy picks the other cycle member AND `recognizeForLoops` then sees a different
// last statement. One lift, two sources — which is what this pins.
import { cBackend } from '@asmlift/core/backend/c';
import { frontendFor } from '@asmlift/core/frontend/registry';
import { raiseRecovered, structureChecked } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO, structureOptionsFor } from '@asmlift/core/target';
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

// `Fn.paramEvidence` is the second record keyed by VALUE, and the one whose mis-keying is silent in
// a way `writeOrder`'s is not: raise/paramwidth.ts reads an unmeasured parameter as proof the
// declaration was WIDE, so a clone carrying the original's keys reports every parameter unmeasured
// and the probe scores a signature the ranked path never emits. Ablating the re-key in `report.ts`
// leaves every other test in `packages/cli` and `packages/core` green and flips the probe's emitted
// C from `s32 f(s8 a0){ return a0; }` to `s32 f(s32 a0){ return (s8)a0; }`.
//
// IDO 7.1's own object for `int f(signed char x){ return x; }`, at the
// `synthetic:sextb:ido7.1` row's flags (`-mips2 -O2 -32 -non_shared -G 0`).
const NARROW_PARAM = [
  '00000000 <f>:',
  '   0:\tsw\ta0,0(sp)',
  '   4:\tsll\ta0,a0,0x18',
  '   8:\tjr\tra',
  '   c:\tsra\tv0,a0,0x18',
  '',
].join('\n');

test('the parameter evidence is keyed by the CLONE’s parameters, not the original’s', () => {
  const fn = frontendFor(MIPS_IDO).lift('f', NARROW_PARAM, MIPS_IDO, {});
  expect(fn.paramEvidence?.size).toBe(1);
  const clone = structuredCloneFn(fn);
  const evidence = clone.paramEvidence!;
  expect(evidence.size).toBe(fn.paramEvidence!.size);
  const params = new Set(clone.blocks.flatMap((b) => b.params));
  const originals = new Set(fn.blocks.flatMap((b) => b.params));
  for (const p of evidence.keys()) {
    expect(params.has(p)).toBe(true);
    expect(originals.has(p)).toBe(false);
  }
  // The OBSERVATIONS survive the re-key: this parameter is homed dead and widened in place, which
  // is the pair raise/paramwidth.ts needs before it may narrow one.
  expect([...evidence.values()]).toEqual([{ deadHome: true, selfRedefined: true }]);
});
