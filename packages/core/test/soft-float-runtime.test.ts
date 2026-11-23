// agbcc's single-precision runtime where a float crosses something other than a helper: an argument
// the function hands back, an unsigned word converted, and a callee's declared `float` parameter
// (`raise/floathelpers.ts`). The corpus is compiled at agbcc -O2 from the
// sources its header lists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-soft-float-rt.s'), 'utf8');
const lift = (name: string) => decompile(name, asm, ARMV4T_AGBCC).source;

describe('an argument the function returns', () => {
  // `return a;` moves the word whole into r0, so the compare's operand is the float it returns.
  test('returned beside the compare that reads it', () => {
    expect(lift('fkeep')).toBe('float fkeep(float a0, float a1) {\n    if (a0 < a1) gI = 1;\n    return a0;\n}\n');
    expect(lift('fkeep2')).toBe('float fkeep2(float a0, float a1) {\n    if (!(a0 < a1)) gI = 1;\n    return a0;\n}\n');
  });

  // The other return hands back the word 5, which a float function would convert to 5.0f.
  test('returned beside an integer return refuses', () => {
    expect(() => lift('fkeepi')).toThrow("no model for the runtime helper '__ltsf2'");
  });
});

// `(float)u` as agbcc open-codes it (gcc/optabs.c:3591-3622): `__floatsisf` where the word fits a
// signed one, else `(u & 1) | (u >> 1)` converted and doubled through `__addsf3` (raise/unsigned-float.ts).
describe('an unsigned word converted to a single', () => {
  test('the diamond is the unsigned conversion', () => {
    expect(lift('u2f')).toBe('float u2f(s32 a0) {\n    return (float)(u32)a0;\n}\n');
    expect(lift('u2fmul')).toBe('float u2fmul(s32 a0, float a1) {\n    return (float)(u32)a0 * a1;\n}\n');
  });

  // The same diamond spelled in C by hand is the same conversion.
  test('the source spelling of the open-coding', () => {
    expect(lift('u2fhand')).toBe('float u2fhand(s32 a0) {\n    return (float)(u32)a0;\n}\n');
  });

  test.each([
    ['u2fmask', 'another mask constant'],
    ['u2fshift', 'another shift'],
    ['u2fpeek', 'the halved conversion read inside the arm'],
  ])('%s: %s is no unsigned conversion', (name) => {
    expect(() => lift(name)).toThrow("no model for the runtime helper '__floatsisf'");
  });

  // A float stored is a word read; and beside a return of an argument nothing reads as a float, the
  // function's other return is a word.
  test.each(['u2fst', 'u2fmix'])('%s: the converted value read as a word refuses', (name) => {
    expect(() => lift(name)).toThrow("no model for the runtime helper '__floatsisf'");
  });
});

// A callee declared to take a `float` is handed it in the next one general word (proto.ts
// `declaredCallArgs` `singles`), and the soft-float boundary reads that word as the float or refuses.
describe('a declared float parameter of an ordinary callee', () => {
  const prototypes: Prototypes = {
    h1: { params: ['int', 'float'], returnsVoid: true },
    h2: { params: ['double', 'float'], returnsVoid: true },
    h3: { params: ['int', 'int', 'int', 'int', 'float'], returnsVoid: true },
    h4: { params: ['float', 'double'], returnsVoid: true },
    g1: { params: ['float'], returns: 'float' },
  };
  const declared = (name: string) => decompile(name, asm, ARMV4T_AGBCC, { prototypes }).source;

  test.each([
    ['fpass1', 'void fpass1(s32 a0, float a1) {\n    h1(a0 + 1, a1);\n}\n'],
    ['fpass2', 'void fpass2(double a0, float a1) {\n    h2(a0, a1);\n}\n'],
    ['fpass3', 'void fpass3(float a0) {\n    h3(1, 2, 3, 4, a0);\n}\n'],
    ['fpass4', 'void fpass4(float a0, double a1) {\n    h4(a0, a1);\n}\n'],
  ])('%s: an argument passed on in its word', (name, source) => {
    expect(declared(name)).toBe(source);
  });

  test('a helper result handed to it', () => {
    expect(declared('fcallarg')).toBe(
      'float fcallarg(float a0, float a1) {\n    float v0;\n    v0 = a0 * a1;\n    return g1(v0);\n}\n',
    );
  });

  // A word loaded from memory is no float the ABI handed over whole; C would convert it at the call.
  test('a loaded word refuses', () => {
    expect(() => declared('fpassw')).toThrow("argument 2 of the call to 'h1' is a `float` its callee declares");
  });
});
