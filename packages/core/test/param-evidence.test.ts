// PARAMETER EVIDENCE (ir/core.ts `ParamEvidence`) — the two things IDO's object shows about an
// entry parameter that the lift destroys, recorded by the shared SSA builder.
//
// `deadHome`: a word sp-relative store is a write to the SSA key `sp@k` (`stackSlotKey`), so a slot
// nothing reloads leaves no reader, no op and no value behind. That erasure is right — it is what
// keeps `sp` from becoming a spurious pointer parameter — and it also erases the ABI argument-home
// store. `selfRedefined`: SSA renames, so nothing downstream can tell a value the machine put back
// in the argument's OWN register from one it put in a scratch.
//
// This file pins both, at the two places they are carried: the builder, and the score probe's clone
// (`packages/cli/test/offline/report-clone.test.ts`).
//
// What the record does NOT claim is as pinned as what it does. Neither half is a frame
// classification, neither is a spill record, and neither is a verdict about any compiler —
// `compilerBehaviors.narrowParamWitness` owns that half, and raise/paramwidth.ts reads the PAIR
// because each one alone has a compiled counterexample.
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { makeSsaBuilder, stackSlotKey } from '../src/frontend/ssa';
import { mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

const val = () => mkValue(T.unk(32));
const liftMips = (asm: string, target = MIPS_IDO) => frontendFor(target).lift('f', asm, target, {});
const obs = (fn: ReturnType<typeof liftMips>, i: number) => fn.paramEvidence?.get(fn.blocks[0].params[i]);

// ── the dead home store, in the SHARED builder ────────────────────────────────────────────────

test('a parameter written to a slot nothing reads back is recorded as homed', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0); // def-less read ⇒ the entry parameter
  ssa.writeVar(stackSlotKey(0), 0, a0); // `sw a0,0(sp)` — the ABI home store
  const r = val();
  b0.ops.push(mkOp('sext', { operands: [a0], results: [r], attrs: { width: 8 } }));
  b0.ops.push(mkOp('ret', { operands: [r] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.paramEvidence?.get(a0)?.deadHome).toBe(true);
});

test('a slot that IS read back buys no record — the store is live and declares nothing', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  ssa.writeVar(stackSlotKey(0), 0, a0);
  b0.ops.push(mkOp('ret', { operands: [ssa.readVar(stackSlotKey(0), 0)] })); // `lw v0,0(sp)`
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.paramEvidence?.get(a0)?.deadHome).toBe(false);
});

test('an ordinary value\u2019s dead spill buys nothing — only an incoming ARGUMENT carries a declaration', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const t = val();
  b0.ops.push(mkOp('const', { results: [t], attrs: { imm: 7 } }));
  ssa.writeVar(stackSlotKey(4), 0, t);
  b0.ops.push(mkOp('ret', { operands: [t] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.paramEvidence?.get(t)).toBeUndefined();
  expect([...(ssa.fn.paramEvidence ?? [])].some(([, o]) => o.deadHome)).toBe(false);
});

test('an ordinary register write is no home — a slot key is what carries an offset', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  ssa.writeVar('v0', 0, a0);
  b0.ops.push(mkOp('ret', { operands: [a0] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.paramEvidence?.get(a0)?.deadHome).toBe(false);
});

// ── the in-place redefinition, in the SHARED builder ──────────────────────────────────────────

test('the first entry write to a parameter\u2019s own register, from that parameter, is recorded', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  const shifted = val();
  b0.ops.push(mkOp('shl', { operands: [a0], results: [shifted], attrs: { imm: 24 } }));
  ssa.writeVar('a0', 0, shifted); // `sll a0,a0,0x18`
  b0.ops.push(mkOp('ret', { operands: [shifted] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.paramEvidence?.get(a0)?.selfRedefined).toBe(true);
});

test('a widening that lands in a SCRATCH register is not an in-place redefinition', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  const shifted = val();
  b0.ops.push(mkOp('shl', { operands: [a0], results: [shifted], attrs: { imm: 24 } }));
  ssa.writeVar('v0', 0, shifted); // `sll v0,a0,0x18`
  b0.ops.push(mkOp('ret', { operands: [shifted] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.paramEvidence?.get(a0)?.selfRedefined).toBe(false);
});

test('only the FIRST write counts — a later one is the allocator reusing a finished register', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  const seven = val();
  b0.ops.push(mkOp('const', { results: [seven], attrs: { imm: 7 } }));
  ssa.writeVar('a0', 0, seven); // an unrelated value lands in a0 first
  const shifted = val();
  b0.ops.push(mkOp('shl', { operands: [a0], results: [shifted], attrs: { imm: 24 } }));
  ssa.writeVar('a0', 0, shifted);
  b0.ops.push(mkOp('ret', { operands: [shifted] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.paramEvidence?.get(a0)?.selfRedefined).toBe(false);
});

test('a write in a LATER block is not prologue work — the argument register is body state by then', () => {
  const ssa = makeSsaBuilder('f', 2, [[], [0]]);
  const [b0, b1] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  const scratch = val();
  b0.ops.push(mkOp('shl', { operands: [a0], results: [scratch], attrs: { imm: 24 } })); // `sll v0,a0,0x18`
  ssa.writeVar('v0', 0, scratch);
  b0.ops.push(mkOp('br', { successors: [{ block: b1, args: [] }] }));
  ssa.markFilled(0);
  const later = val();
  b1.ops.push(mkOp('shl', { operands: [a0], results: [later], attrs: { imm: 24 } }));
  ssa.writeVar('a0', 1, later); // the argument register, written where body code has already run
  b1.ops.push(mkOp('ret', { operands: [later] }));
  ssa.markFilled(1);
  ssa.finish();
  expect(ssa.fn.paramEvidence?.get(a0)?.selfRedefined).toBe(false);
});

test('the record is PRESENT and all-false on a function that shows neither — this builder measured it', () => {
  const ssa = makeSsaBuilder('f', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const a0 = ssa.readVar('a0', 0);
  b0.ops.push(mkOp('ret', { operands: [a0] }));
  ssa.markFilled(0);
  ssa.finish();
  expect([...(ssa.fn.paramEvidence ?? [])]).toEqual([[a0, { deadHome: false, selfRedefined: false }]]);
});

// ── through a real MIPS lift: IDO's own probes ────────────────────────────────────────────────
//
// Every object below comes from IDO 7.1 at the `synthetic:sextb:ido7.1` row's own flags
// (`-c -Xcpluscomm -mips2 -O2 -32 -non_shared -G 0`). The first two lift to the SAME value graph —
// one parameter, `shl 24`, `shr_s 24`, `ret` — which is the whole point: nothing IN the graph tells
// the two source spellings apart. The last two are why it takes BOTH observations: each is a
// non-declaration that shows exactly one of them.

const NARROW_PARAM = // int f(s8 x){ return x; }
  '00000000 <f>:\n   0:\tsw\ta0,0(sp)\n   4:\tsll\ta0,a0,0x18\n   8:\tjr\tra\n   c:\tsra\tv0,a0,0x18\n';
const BODY_CAST = '00000000 <f>:\n   0:\tsll\tv0,a0,0x18\n   4:\tjr\tra\n   8:\tsra\tv0,v0,0x18\n'; // int f(s32 x){ return (s8)x; }
const SELF_ASSIGNED_CAST = '00000000 <f>:\n   0:\tsll\ta0,a0,0x18\n   4:\tjr\tra\n   8:\tsra\tv0,a0,0x18\n'; // int f(int x){ x = (signed char)x; return x; }
const LONG_LONG_LOW_HALF = // int f(long long x){ return (signed char)x; }
  '00000000 <f>:\n   0:\tsll\tv0,a1,0x18\n   4:\tsra\tv0,v0,0x18\n   8:\tsw\ta0,0(sp)\n   c:\tjr\tra\n  10:\tsw\ta1,4(sp)\n';

test("IDO's narrow-parameter spelling shows BOTH: homed dead and widened in place", () => {
  const fn = liftMips(NARROW_PARAM);
  expect(fn.blocks[0].params).toHaveLength(1);
  expect(obs(fn, 0)).toEqual({ deadHome: true, selfRedefined: true });
});

test("IDO's body-cast spelling shows NEITHER — no home store, and the `sll` lands in a scratch", () => {
  expect(obs(liftMips(BODY_CAST), 0)).toEqual({ deadHome: false, selfRedefined: false });
});

test('a WIDE parameter the source casts back onto itself is widened in place but never homed', () => {
  expect(obs(liftMips(SELF_ASSIGNED_CAST), 0)).toEqual({ deadHome: false, selfRedefined: true });
});

test("a 64-bit parameter's low half is homed dead but widened in a scratch — the other counterexample", () => {
  const fn = liftMips(LONG_LONG_LOW_HALF);
  expect(fn.blocks[0].params).toHaveLength(2);
  expect(obs(fn, 1)).toEqual({ deadHome: true, selfRedefined: false });
});

test('the first two spellings lift to the same value graph, so this record is the ONLY discriminator', () => {
  const ops = (asm: string) => liftMips(asm).blocks[0].ops.map((o) => o.opcode);
  expect(ops(NARROW_PARAM)).toEqual(ops(BODY_CAST));
});

test('the record is a measurement, not a target verdict — the same asm records the same under any MIPS target', () => {
  expect(obs(liftMips(NARROW_PARAM), 0)).toEqual(obs(liftMips(NARROW_PARAM, MIPS_GCC), 0));
});

test('parsed IR carries no record — nobody measured that function', async () => {
  const { parse } = await import('../src/ir/parse');
  expect(parse('fn f {\n^bb0():\n  ret\n}').paramEvidence).toBeUndefined();
});
