// A 64-bit integer as ONE IR value: the representation's own invariants, checked where they are
// stated rather than where a later pass would notice them missing.
//
// The three opcodes and the two verifier rules are the whole of it. `concat` builds the value from
// its halves and `lo32`/`hi32` read one back; nothing else changes, because every arithmetic op
// already carries its width in its operand types.
import { describe, expect, test } from 'vitest';

import { pascalBackend } from '../src/backend/pascal';
import { Block, Fn, mkOp, mkValue } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { T, parseType, typeToString } from '../src/ir/types';
import { VerifyError, verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { C_TYPEDEFS } from '../src/target';

const fnOf = (blocks: Block[]): Fn => ({
  name: 'f',
  blocks,
  writeOrder: undefined,
  slotHomes: undefined,
  paramEvidence: undefined,
});
/** One block: the ops, then a `ret`. */
const oneBlock = (params: Block['params'], ops: Block['ops']): Fn => fnOf([{ params, ops: [...ops, mkOp('ret')] }]);

describe('the type already had the width', () => {
  test('a 64-bit integer round-trips through the IR text', () => {
    expect(typeToString(T.s(64))).toBe('s64');
    expect(typeToString(T.u(64))).toBe('u64');
    expect(parseType('s64')).toEqual(T.s(64));
    expect(parseType('u64')).toEqual(T.u(64));
  });

  test('a width-64 add parses and verifies, with no new arithmetic opcode', () => {
    const fn = parse(`fn f {\n^bb0(%0: s64, %1: s64):\n  %2: s64 = add %0, %1\n  ret %2\n}\n`);
    expect(() => verify(fn)).not.toThrow();
  });
});

describe('the three opcodes have a shape, and it is checked', () => {
  const wide = () => mkValue(T.s(64));
  const narrow = () => mkValue(T.s(32));

  test('concat takes two 32-bit halves and yields the 64-bit value', () => {
    const [lo, hi, v] = [narrow(), narrow(), wide()];
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [v] })]))).not.toThrow();
  });

  test('a concat whose RESULT is 32 bits is rejected', () => {
    const [lo, hi, v] = [narrow(), narrow(), narrow()];
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [v] })]))).toThrow(
      /'concat' result must be an integer of width 64/,
    );
  });

  test('a concat whose HALF is 64 bits is rejected', () => {
    const [lo, hi, v] = [wide(), narrow(), wide()];
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [v] })]))).toThrow(
      /'concat' half must be an integer of width 32/,
    );
  });

  test('lo32 and hi32 read a half off the 64-bit value', () => {
    const [v, lo, hi] = [wide(), narrow(), narrow()];
    expect(() =>
      verify(
        oneBlock([v], [mkOp('lo32', { operands: [v], results: [lo] }), mkOp('hi32', { operands: [v], results: [hi] })]),
      ),
    ).not.toThrow();
  });

  test('a projection off a 32-bit value is rejected', () => {
    const [v, lo] = [narrow(), narrow()];
    expect(() => verify(oneBlock([v], [mkOp('lo32', { operands: [v], results: [lo] })]))).toThrow(
      /'lo32' operand must be an integer of width 64/,
    );
  });

  // At L1 every value is `unknown`, so a rule that skipped that kind would be vacuous exactly where
  // the frontend builds these.
  test('the shape rules quantify over `unknown`, not only over recovered integers', () => {
    const [lo, hi, v] = [mkValue(T.unk(32)), mkValue(T.unk(32)), mkValue(T.unk(64))];
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [v] })]))).not.toThrow();
    const bad = mkValue(T.unk(32));
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [bad] })]))).toThrow(
      VerifyError,
    );
  });
});

describe('64 does not mix', () => {
  test('an add over one 64-bit and one 32-bit operand is rejected', () => {
    const [a, b, r] = [mkValue(T.s(64)), mkValue(T.s(32)), mkValue(T.s(64))];
    expect(() => verify(oneBlock([a, b], [mkOp('add', { operands: [a, b], results: [r] })]))).toThrow(
      /'add' mixes a 64-bit operand with a narrower one/,
    );
  });

  test('a 64-bit add whose RESULT is 32 bits is rejected — the truncation a cast site would make', () => {
    const [a, b, r] = [mkValue(T.s(64)), mkValue(T.s(64)), mkValue(T.s(32))];
    expect(() => verify(oneBlock([a, b], [mkOp('add', { operands: [a, b], results: [r] })]))).toThrow(VerifyError);
  });

  test('a compare over two 64-bit operands is fine — its RESULT is a C `int`', () => {
    const [a, b, r] = [mkValue(T.s(64)), mkValue(T.s(64)), mkValue(T.u(32))];
    expect(() => verify(oneBlock([a, b], [mkOp('icmp_slt', { operands: [a, b], results: [r] })]))).not.toThrow();
  });

  test('a 64-bit shift by a 32-bit COUNT is what the machine does, and verifies', () => {
    const [a, n, r] = [mkValue(T.s(64)), mkValue(T.s(32)), mkValue(T.s(64))];
    expect(() => verify(oneBlock([a, n], [mkOp('shl', { operands: [a, n], results: [r] })]))).not.toThrow();
  });

  test('a shift whose SHIFTED operand is 32 bits and whose result is 64 is rejected', () => {
    const [a, n, r] = [mkValue(T.s(32)), mkValue(T.s(32)), mkValue(T.s(64))];
    expect(() => verify(oneBlock([a, n], [mkOp('shl', { operands: [a, n], results: [r] })]))).toThrow(VerifyError);
  });

  test('a narrow parameter still meets a word — the rule is a quarantine, not width agreement', () => {
    // `raise/paramwidth.ts` narrows a declared parameter to 8 or 16 bits, and `add(p_u8, x_s32)` is
    // an ordinary correct L1 shape. Full width agreement would be false on 32-bit IR today.
    const [a, b, r] = [mkValue(T.u(8)), mkValue(T.s(32)), mkValue(T.s(32))];
    expect(() => verify(oneBlock([a, b], [mkOp('add', { operands: [a, b], results: [r] })]))).not.toThrow();
  });
});

describe('what recovery does with a width it did not choose', () => {
  test('an unknown value settles at its OWN width, not at 32', () => {
    const [a, r] = [mkValue(T.unk(64)), mkValue(T.unk(64))];
    const fn = oneBlock([a], [mkOp('neg', { operands: [a], results: [r] })]);
    recoverTypes(fn);
    expect(r.type).toEqual(T.s(64));
    expect(a.type).toEqual(T.s(64));
  });
});

describe('what the backends can spell', () => {
  test('the C prelude declares s64 and u64', () => {
    expect(C_TYPEDEFS).toContain('typedef long long s64;');
    expect(C_TYPEDEFS).toContain('typedef unsigned long long u64;');
  });

  test('the Pascal backend refuses a 64-bit integer rather than narrowing it', () => {
    expect(() =>
      pascalBackend.emit({
        name: 'f',
        params: [{ name: 'a', type: T.s(64) }],
        locals: [],
        retType: T.void(),
        body: [],
      }),
    ).toThrow(/no spelling for a 64-bit integer/);
  });
});
