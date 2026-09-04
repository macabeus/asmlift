// M0 — the verifier-negative suite. Each case is malformed IR the
// verifier MUST reject; an untested safety net is a claim, not a net. Some cases are
// constructed as object graphs because they cannot be expressed in well-formed syntax
// (undefined-use, double-def).
import { expect, test } from 'vitest';

import { Block, Fn, mkOp, mkValue } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { VerifyError, verify } from '../src/ir/verify';

const fnOf = (blocks: Block[]): Fn => ({ name: 'bad', blocks, writeOrder: undefined });

test('rejects: block without a terminator', () => {
  expect(() => verify(parse(`fn f {\n^bb0():\n  %0: s32 = const {value=1}\n}\n`))).toThrow(VerifyError);
});

test('rejects: terminator not last (two terminators)', () => {
  expect(() => verify(parse(`fn f {\n^bb0():\n  ret\n  ret\n}\n`))).toThrow(VerifyError);
});

test('rejects: unknown opcode', () => {
  expect(() => verify(parse(`fn f {\n^bb0():\n  %0: s32 = frobnicate\n  ret %0\n}\n`))).toThrow(VerifyError);
});

test('rejects: successor arg count mismatches target block params', () => {
  expect(() => verify(parse(`fn f {\n^bb0():\n  br ^bb1()\n^bb1(%0: s32):\n  ret %0\n}\n`))).toThrow(VerifyError);
});

test('rejects: wrong operand arity', () => {
  // 'add' expects 2 operands; give it 1.
  const x = mkValue(T.s());
  const block: Block = {
    params: [],
    ops: [
      mkOp('const', { results: [x], attrs: { value: 1 } }),
      mkOp('add', { operands: [x], results: [mkValue(T.s())] }),
      mkOp('ret', { operands: [x] }),
    ],
  };
  expect(() => verify(fnOf([block]))).toThrow(VerifyError);
});

test('rejects: use of an undefined value', () => {
  const undef = mkValue(T.s()); // never defined by any op or param
  const block: Block = { params: [], ops: [mkOp('ret', { operands: [undef] })] };
  expect(() => verify(fnOf([block]))).toThrow(VerifyError);
});

test('rejects: value defined twice', () => {
  const x = mkValue(T.s());
  const block: Block = {
    params: [],
    ops: [
      mkOp('const', { results: [x], attrs: { value: 1 } }),
      mkOp('const', { results: [x], attrs: { value: 2 } }),
      mkOp('ret', { operands: [x] }),
    ],
  };
  expect(() => verify(fnOf([block]))).toThrow(VerifyError);
});

test('rejects: missing required attr', () => {
  const x = mkValue(T.s());
  const block: Block = {
    params: [],
    ops: [
      mkOp('const', { results: [x] }), // missing 'value'
      mkOp('ret', { operands: [x] }),
    ],
  };
  expect(() => verify(fnOf([block]))).toThrow(VerifyError);
});

test('rejects: use before def within a block', () => {
  const a = mkValue(T.s());
  const b = mkValue(T.s());
  // 'add' uses b before b is defined by the later const.
  const block: Block = {
    params: [],
    ops: [
      mkOp('const', { results: [a], attrs: { value: 1 } }),
      mkOp('add', { operands: [a, b], results: [mkValue(T.s())] }),
      mkOp('const', { results: [b], attrs: { value: 2 } }),
      mkOp('ret', { operands: [a] }),
    ],
  };
  expect(() => verify(fnOf([block]))).toThrow(VerifyError);
});

test('accepts: a well-formed function', () => {
  verify(parse(`fn f {\n^bb0(%0: s32):\n  %1: s32 = add %0, %0\n  ret %1\n}\n`));
});

// The shifts and `ret` are variadic, so their arity holes need bespoke verifier clauses (e.g. a
// 1-operand `shl` with no imm would pass a naive arity check). Malformed forms must fail at their
// source, not render `x << undefined` downstream.
test('rejects: shl with 1 operand and no imm attr', () => {
  const x = mkValue(T.s());
  const block: Block = {
    params: [],
    ops: [
      mkOp('const', { results: [x], attrs: { value: 1 } }),
      mkOp('shl', { operands: [x], results: [mkValue(T.s())] }),
      mkOp('ret', { operands: [x] }),
    ],
  };
  expect(() => verify(fnOf([block]))).toThrow(/'shl' must be 2 operands OR 1 operand/);
});

test('rejects: ret with more than one operand', () => {
  const x = mkValue(T.s());
  const block: Block = {
    params: [],
    ops: [mkOp('const', { results: [x], attrs: { value: 1 } }), mkOp('ret', { operands: [x, x, x] })],
  };
  expect(() => verify(fnOf([block]))).toThrow(/'ret' takes at most 1 operand/);
});

test('verify errors carry the fn/block/op location', () => {
  expect(() => verify(parse(`fn f {\n^bb0():\n  %0: s32 = frobnicate\n  ret %0\n}\n`))).toThrow(
    /\(fn 'f', block \^bb0, op 0\)/,
  );
});

// THE WRITE-ORDER RECORD'S CROSS-PASS OBLIGATION (ir/core.ts `WriteOrder`, `foldWriteOrder`). Its
// failure mode is silent — an unmeasured block's edge copies sort with no records, quietly
// changing their order and, on a cycle, which register is spilled — so it is checked, not trusted.
const MEASURED = `fn m {
^bb0(%0: s32, %1: s32):
  br ^bb1(%0, %1)
^bb1(%2: s32, %3: s32):
  ret %2
}`;
const measuredFn = (): Fn => {
  const fn = parse(MEASURED);
  const [entry, join] = fn.blocks;
  fn.writeOrder = {
    lastWrite: new Map([[entry, new Map([[join.params[1], 0]])]]),
    writes: new Map([
      [entry, 2],
      [join, 0],
    ]),
  };
  return fn;
};

test('accepts: a fully measured fn', () => {
  expect(() => verify(measuredFn())).not.toThrow();
});

test('rejects: a measured fn with a block carrying no write-order entry (a minted or unfolded block)', () => {
  const fn = measuredFn();
  fn.writeOrder!.writes.delete(fn.blocks[1]);
  expect(() => verify(fn)).toThrow(/carries no write-order entry/);
});

test("rejects: an ordinal outside its block's own write count (a fold that moved records without growing it)", () => {
  const fn = measuredFn();
  fn.writeOrder!.lastWrite.get(fn.blocks[0])!.set(fn.blocks[1].params[1], 7);
  expect(() => verify(fn)).toThrow(/outside its 2 writes/);
});

test('accepts: a fn with NO record at all — parsed IR is unmeasured, not measured-as-nothing', () => {
  expect(() => verify(parse(MEASURED))).not.toThrow();
});
