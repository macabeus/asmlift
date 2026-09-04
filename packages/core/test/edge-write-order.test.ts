// The write-order record (ir/core.ts `WriteOrder`, measured in frontend/ssa.ts): for every edge
// into a block with params, the order in which the predecessor LAST WROTE each param's key.
//
// Driven on the builder directly first, in the style of ssa-frame-model.test.ts, because the datum
// is a property of SSA construction and not of any ISA; then once through the real Thumb frontend
// on the shape that motivates it — a modulo loop whose latch and entry each write the two header
// registers in an order the value graph cannot show.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { makeSsaBuilder } from '../src/frontend/ssa';
import { type Block, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { ARMV4T_AGBCC } from '../src/target';

const val = () => mkValue(T.unk(32));

/** Entry ^0 writes r2 then r0 and falls into the header ^1, which reads both (two phis), writes r0
 *  then r2, and loops back to itself or exits to ^2. */
const rotatingLoop = () => {
  const ssa = makeSsaBuilder('rot', 3, [[], [0, 1], [1]]);
  const [b0, b1, b2] = ssa.irBlocks;
  ssa.writeVar('r2', 0, val());
  ssa.writeVar('r0', 0, val());
  b0.ops.push(mkOp('br', { successors: [{ block: b1, args: [] }] }));
  ssa.markFilled(0);
  const r0 = ssa.readVar('r0', 1);
  const r2 = ssa.readVar('r2', 1);
  const sum = val();
  b1.ops.push(mkOp('add', { operands: [r0, r2], results: [sum] }));
  ssa.writeVar('r0', 1, sum);
  ssa.writeVar('r2', 1, r0);
  b1.ops.push(
    mkOp('cond_br', {
      operands: [sum],
      successors: [
        { block: b1, args: [] },
        { block: b2, args: [] },
      ],
    }),
  );
  ssa.markFilled(1);
  b2.ops.push(mkOp('ret', { operands: [ssa.readVar('r0', 2)] }));
  ssa.markFilled(2);
  ssa.finish();
  const [phiR0, phiR2] = b1.params;
  return { ssa, b0, b1, phiR0, phiR2 };
};

test('each edge records the order the predecessor last wrote each param key', () => {
  const { ssa, b0, b1, phiR0, phiR2 } = rotatingLoop();
  const order = ssa.fn.writeOrder!;
  expect(b1.params.length).toBe(2);
  // entry: r2 before r0 — the r0 phi's copy comes LATER on this edge
  expect(order.lastWrite.get(b0)!.get(phiR0)!).toBeGreaterThan(order.lastWrite.get(b0)!.get(phiR2)!);
  // latch: r0 before r2 — the same two params, the other way round
  expect(order.lastWrite.get(b1)!.get(phiR0)!).toBeLessThan(order.lastWrite.get(b1)!.get(phiR2)!);
  // every builder block is measured, and the count is the number of writeVar calls
  expect(order.writes.get(b0)).toBe(2);
  expect(order.writes.get(b1)).toBe(2);
  expect(order.writes.get(ssa.irBlocks[2])).toBe(0);
});

test('a key the predecessor never wrote has NO record — the arg passes through, it is not "first"', () => {
  // if (c) x = 1; — the join's phi gets a record from the arm that wrote x and none from the arm
  // that did not, while that arm is still MEASURED (it has a write count).
  const ssa = makeSsaBuilder('j', 4, [[], [0], [0], [1, 2]]);
  const [b0, b1, b2, b3] = ssa.irBlocks;
  const c = ssa.readVar('r1', 0);
  ssa.writeVar('r0', 0, val());
  b0.ops.push(
    mkOp('cond_br', {
      operands: [c],
      successors: [
        { block: b1, args: [] },
        { block: b2, args: [] },
      ],
    }),
  );
  ssa.markFilled(0);
  ssa.writeVar('r0', 1, val());
  b1.ops.push(mkOp('br', { successors: [{ block: b3, args: [] }] }));
  ssa.markFilled(1);
  b2.ops.push(mkOp('br', { successors: [{ block: b3, args: [] }] }));
  ssa.markFilled(2);
  b3.ops.push(mkOp('ret', { operands: [ssa.readVar('r0', 3)] }));
  ssa.markFilled(3);
  ssa.finish();
  const order = ssa.fn.writeOrder!;
  const [phi] = b3.params;
  expect(b3.params.length).toBe(1);
  expect(order.lastWrite.get(b1)!.get(phi)).toBe(0);
  expect(order.lastWrite.get(b2)?.get(phi)).toBeUndefined();
  expect(order.writes.get(b2)).toBe(0);
});

test('a phi the builder retires as trivial leaves no record behind', () => {
  // r3 is read in the header, never written anywhere: its phi is trivial and finish() removes it.
  const ssa = makeSsaBuilder('t', 2, [[], [0, 1]]);
  const [b0, b1] = ssa.irBlocks;
  b0.ops.push(mkOp('br', { successors: [{ block: b1, args: [] }] }));
  ssa.markFilled(0);
  const r3 = ssa.readVar('r3', 1);
  ssa.writeVar('r0', 1, r3);
  b1.ops.push(mkOp('br', { successors: [{ block: b1, args: [] }] }));
  ssa.markFilled(1);
  ssa.finish();
  expect(b1.params.length).toBe(0);
  const recorded = [...ssa.fn.writeOrder!.lastWrite.values()].flatMap((m) => [...m.keys()]);
  expect(recorded).toEqual([]);
});

// ── through the real frontend ─────────────────────────────────────────────────────────────────
// agbcc's gcd (`while (b) { t = b; b = a % b; a = t; }`, benchmark row synthetic:gcd:agbcc — the
// same asm). The entry writes `add r2, r0` THEN `add r0, r1`; the latch writes r0 (the `bl __modsi3`
// result) THEN
// `add r2, r4`. Both are copies the value graph erases (a copy is the same SSA value), so the
// record is the only place the order survives.
const GCD_S = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-gcd.s'), 'utf8');

test('Thumb: the entry and the latch write the gcd header registers in opposite orders', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('gcd', GCD_S, ARMV4T_AGBCC, {}, undefined, undefined);
  const order = fn.writeOrder!;
  const header = fn.blocks.find((b) => b.ops[b.ops.length - 1].successors.some((s) => s.block === b))!;
  expect(header.params.length).toBe(2);
  const entry = fn.blocks[0];
  const on = (pred: Block, p: Value) => order.lastWrite.get(pred)!.get(p)!;
  const [pa, pb] = header.params;
  // the param written LAST in the entry (r0, the divisor's home) is written FIRST in the latch
  const divisor = on(entry, pa) > on(entry, pb) ? pa : pb;
  const dividend = divisor === pa ? pb : pa;
  expect(on(header, divisor)).toBeLessThan(on(header, dividend));
  // and the latch's arg for the divisor is the modulo (defined in the latch), the dividend's is the
  // old divisor param itself — the copy the target spells `add r2, r4, #0`
  const back = header.ops[header.ops.length - 1].successors.find((s) => s.block === header)!;
  expect(back.args[header.params.indexOf(dividend)]).toBe(divisor);
  expect(back.args[header.params.indexOf(divisor)]).not.toBe(divisor);
});
