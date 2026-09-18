// DEAD PARAMETER HOMES (ir/core.ts `DeadParamHomes`) — the ABI argument-home store, recorded by
// the shared SSA builder because the lift itself destroys it.
//
// The store never becomes an op: a word sp-relative store is a write to the SSA key `sp@k`
// (`stackSlotKey`), so a slot nothing reloads leaves no reader, no op and no value behind. That
// erasure is right — it is what keeps `sp` from becoming a spurious pointer parameter — and it
// also erases the only thing IDO 7.1 `-O2` emits for a DECLARED-NARROW parameter. This file pins
// the stamp that survives it, at the two places that carry it: the builder, and the score probe's
// clone.
//
// What the stamp does NOT claim is as pinned as what it does. It is not a frame classification (a
// slot that is read back buys none), not a spill record (an ordinary value's dead spill buys none),
// and not a verdict about any compiler — `compilerBehaviors.narrowParamWitness` owns that half.
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { makeSsaBuilder, stackSlotKey } from '../src/frontend/ssa';
import { mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

const val = () => mkValue(T.unk(32));
const liftMips = (asm: string, target = MIPS_IDO) => frontendFor(target).lift('f', asm, target, {});

// ── the stamp, in the SHARED builder ──────────────────────────────────────────────────────────

test('a parameter written to a slot nothing reads back is stamped', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0); // def-less read ⇒ the entry parameter
  ssa.writeVar(stackSlotKey(0), 0, a0); // `sw a0,0(sp)` — the ABI home store
  const r = val();
  b0.ops.push(mkOp('sext', { operands: [a0], results: [r], attrs: { width: 8 } }));
  b0.ops.push(mkOp('ret', { operands: [r] }));
  ssa.markFilled(0);
  ssa.finish();
  expect([...(ssa.fn.deadParamHomes ?? [])]).toEqual([a0]);
});

test('a slot that IS read back buys no stamp — the store is live and declares nothing', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  ssa.writeVar(stackSlotKey(0), 0, a0);
  b0.ops.push(mkOp('ret', { operands: [ssa.readVar(stackSlotKey(0), 0)] })); // `lw v0,0(sp)`
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.deadParamHomes?.size).toBe(0);
});

test('an ordinary value\u2019s dead spill buys no stamp — only an incoming ARGUMENT carries a declaration', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const t = val();
  b0.ops.push(mkOp('const', { results: [t], attrs: { imm: 7 } }));
  ssa.writeVar(stackSlotKey(4), 0, t);
  b0.ops.push(mkOp('ret', { operands: [t] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.deadParamHomes?.size).toBe(0);
});

test('an ordinary register write buys no stamp — a slot key is what carries an offset', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  ssa.writeVar('v0', 0, a0);
  b0.ops.push(mkOp('ret', { operands: [a0] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.deadParamHomes?.size).toBe(0);
});

test('the record is EMPTY, never absent, on a function that homes nothing — this builder measured it', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  b0.ops.push(mkOp('ret', { operands: [ssa.readVar('a0', 0)] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.deadParamHomes).toEqual(new Set());
});

// ── through a real MIPS lift: IDO's own probe pair ────────────────────────────────────────────
//
// Both objects come from IDO 7.1 at the `synthetic:sextb:ido7.1` row's own flags
// (`-c -Xcpluscomm -mips2 -O2 -32 -non_shared -G 0`). They lift to the SAME value graph — one
// parameter, `shl 24`, `shr_s 24`, `ret` — which is the whole point: the home store is the only
// thing in the object that tells the two source spellings apart.

const NARROW_PARAM = // int f(s8 x){ return x; }
  '00000000 <f>:\n   0:\tsw\ta0,0(sp)\n   4:\tsll\ta0,a0,0x18\n   8:\tjr\tra\n   c:\tsra\tv0,a0,0x18\n';
const BODY_CAST = '00000000 <f>:\n   0:\tsll\tv0,a0,0x18\n   4:\tjr\tra\n   8:\tsra\tv0,v0,0x18\n'; // int f(s32 x){ return (s8)x; }

test("IDO's narrow-parameter spelling stamps the parameter it homed", () => {
  const fn = liftMips(NARROW_PARAM);
  expect(fn.blocks[0].params).toHaveLength(1);
  expect([...(fn.deadParamHomes ?? [])]).toEqual([fn.blocks[0].params[0]]);
});

test("IDO's body-cast spelling stamps nothing — it emitted no home store", () => {
  const fn = liftMips(BODY_CAST);
  expect(fn.deadParamHomes?.size).toBe(0);
});

test('the two spellings lift to the same value graph, so the stamp is the ONLY discriminator', () => {
  const ops = (asm: string) => liftMips(asm).blocks[0].ops.map((o) => o.opcode);
  expect(ops(NARROW_PARAM)).toEqual(ops(BODY_CAST));
});

test('the stamp is a measurement, not a target verdict — the same asm stamps under any MIPS target', () => {
  expect(liftMips(NARROW_PARAM).deadParamHomes?.size).toBe(1);
  expect(liftMips(NARROW_PARAM, MIPS_GCC).deadParamHomes?.size).toBe(1);
});

test('parsed IR carries no record — nobody measured that function', async () => {
  const { parse } = await import('../src/ir/parse');
  expect(parse('fn f {\n^bb0():\n  ret\n}').deadParamHomes).toBeUndefined();
});
