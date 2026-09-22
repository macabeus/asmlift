// Signatures the C standard fixes (proto.ts STANDARD_SIGNATURES), consumed by the frontend's
// arity lookup. What an entry buys is what RUNTIME_HELPERS buys for `__divsi3`: the call's
// ARGUMENTS ARE RECOVERED. Without one the guess is revisited in `finish()` and a call whose
// argument registers were never written in this function keeps none of them.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { type Prototypes, returnsWithoutHiddenPointer } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

// four incoming parameters, all live at the call — `r3` is kept by a copy so it has a reaching
// def and the heuristic cannot narrow
const callsWith4ParamsLive = (callee: string) =>
  `f:\n\tpush\t{r4, lr}\n\tadd\tr4, r3, #0\n\tbl\t${callee}\n\tadd\tr0, r4, #0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;

const lift = (callee: string, prototypes = {}) =>
  decompile('f', callsWith4ParamsLive(callee), ARMV4T_AGBCC, { prototypes }).source;

test('an undeclared callee loses arguments the function never wrote', () => {
  expect(lift('g')).toContain('g();');
});

test('`memcpy` takes three, because the standard says so and no header is needed', () => {
  expect(lift('memcpy')).toContain('memcpy(a0, a1, a2)');
});

test('the project`s own header still wins over the standard table', () => {
  // a decomp may be building against its own re-declaration, and that is the one that decides
  expect(lift('memcpy', { memcpy: { params: 2 } })).toContain('memcpy(a0, a1)');
});

// THE RETURN IS PART OF WHAT THE STANDARD FIXES, and it is the half no project header ever
// carried: `FnProto` has `returnsVoid` and nothing else about a return, so before an entry spelled
// one there was no way to say "this callee returns in a register". The frame-object audit is the
// consumer — a captured frame address handed over at argument 0 is an out-parameter or a hidden
// struct-return pointer, and only a statement about the return tells them apart.
test('the standard fixes `memcpy`s return, so nothing needs to declare it', () => {
  expect(returnsWithoutHiddenPointer('memcpy', {})).toBe(true);
});

test('a callee nobody has described returns nothing known, and the answer is no', () => {
  expect(returnsWithoutHiddenPointer('g', {})).toBe(false);
  expect(returnsWithoutHiddenPointer('g', { g: { params: 3 } })).toBe(false);
  expect(returnsWithoutHiddenPointer('g', { g: { params: 3, returnsVoid: true } })).toBe(true);
});

test('a callee named after an `Object.prototype` member is not described by that', () => {
  // `'toString' in STANDARD_SIGNATURES` is true, and a decomp may well have a `valueOf`
  expect(returnsWithoutHiddenPointer('toString', {})).toBe(false);
  expect(returnsWithoutHiddenPointer('valueOf', { valueOf: { params: 1 } })).toBe(false);
});

// A TABLE THAT CAME FROM OUTSIDE. `decompile` is a published entry point and runs no
// `validatePrototypes`, so a library consumer's parsed JSON arrives exactly as it was written —
// and a malformed entry must reach the audit as silence, which every other reader of this table
// already treats it as.
const captureAtArg0 =
  'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n' +
  '\tmov\tr2, #0x10\n\tbl\tg\n\tadd\tsp, sp, #0x10\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';

test('a null entry says nothing about the return, like an absent one', () => {
  expect(returnsWithoutHiddenPointer('g', JSON.parse('{"g": null}') as Prototypes)).toBe(false);
});

test('…and the lift declines through its own channel rather than crashing', () => {
  expect(() =>
    decompile('f', captureAtArg0, ARMV4T_AGBCC, { prototypes: JSON.parse('{"g": null}') as Prototypes }),
  ).toThrow(/`g` takes it at argument 0 and nothing says what that callee returns/);
});
