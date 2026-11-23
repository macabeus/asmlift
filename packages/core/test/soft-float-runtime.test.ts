// agbcc's soft-float runtime where a value crosses something other than a helper's own operands: an
// argument the function hands back, an unsigned word converted, a callee's declared `float`
// parameter (`raise/floathelpers.ts`), and a helper's result handed to the guessed call after it
// (frontend/call-plan.ts). The corpus is compiled at agbcc -O2 from the sources its header lists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { UNSIGNED_TO_SINGLE } from '../src/runtime-helpers';
import { ARMV4T_AGBCC, targetFor } from '../src/target';

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
// signed one, else `(u & 1) | (u >> 1)` converted and doubled through `__addsf3`
// (raise/unsigned-float.ts).
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
  // function's other return is a word. The diamond is still the conversion, so the fold refuses it
  // as the one call of its table entry (`UNSIGNED_TO_SINGLE`), and the gap names that.
  test.each(['u2fst', 'u2fmix'])('%s: the converted value read as a word refuses', (name) => {
    expect(() => lift(name)).toThrow(`no model for the runtime helper '${UNSIGNED_TO_SINGLE}'`);
  });
});

// A callee declared to take a `float` is handed it in the next one general word (proto.ts
// `declaredCallArgs` `floats`), and the soft-float boundary reads that word as the float or refuses.
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

  // `f32` is a project's typedef of `float` (proto.ts `floatingSpelling`): laid out as the keyword is.
  test('a parameter and a return spelled through a float typedef', () => {
    const g2: Prototypes = { g2: { params: ['f32'], returns: 'f32' } };
    expect(decompile('fcallf32', asm, ARMV4T_AGBCC, { prototypes: g2 }).source).toBe(
      'float fcallf32(float a0, float a1) {\n    float v0;\n    v0 = a0 - a1;\n    return g2(v0);\n}\n',
    );
  });

  // A float beside a struct passed by value is the next word after the struct's (aggregate.ts
  // `byValueCallArgs` carries `floats` as `declaredCallArgs` does).
  test('beside a struct passed by value', () => {
    const takeWF: Prototypes = {
      takeWF: {
        params: ['struct W', 'float'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'x', type: 'u32' }] } },
        returnsVoid: true,
      },
    };
    expect(decompile('bvfloat', asm, ARMV4T_AGBCC, { prototypes: takeWF }).source).toBe(
      'void bvfloat(float a0) {\n    takeWF(gWs, a0);\n}\n',
    );
  });

  // THE FUNCTION'S OWN DECLARATION is what the candidate is compiled against: a word it types an
  // integer is no float it was handed (`void fpun(int x){ pf(*(float *)&x); }` is `bl pf` alone),
  // and a return it types an integer takes no float (`int fpunret(void)` returning `rf()`'s bits).
  test('an argument or a return the own declaration types an integer refuses', () => {
    const pf: Prototypes = { pf: { params: ['float'], returnsVoid: true }, rf: { params: [], returns: 'float' } };
    const own = (name: string, self: Prototypes[string]) =>
      decompile(name, asm, ARMV4T_AGBCC, { prototypes: { ...pf, [name]: self } }).source;
    expect(() => own('fpun', { params: ['int'], returnsVoid: true })).toThrow(
      "argument 1 of the call to 'pf' is a `float` its callee declares",
    );
    expect(() => own('fpunret', { params: [], returns: 'int' })).toThrow("'rf' is declared to return float");
    // …and the header's own entry, read beside the table (proto-context.ts `ownContextEntry`)
    expect(() =>
      decompile('fpun', asm, ARMV4T_AGBCC, { prototypes: pf, ownContextProto: { params: ['int'], returnsVoid: true } }),
    ).toThrow("argument 1 of the call to 'pf' is a `float` its callee declares");
    // CONTROL: declared as the float it is, or not declared, it lifts
    expect(own('fpun', { params: ['float'], returnsVoid: true })).toBe('void fpun(float a0) {\n    pf(a0);\n}\n');
    expect(decompile('fpun', asm, ARMV4T_AGBCC, { prototypes: pf }).source).toBe(
      'void fpun(float a0) {\n    pf(a0);\n}\n',
    );
  });
});

// agbcc from -O1 deletes a runtime helper call whose result nothing reads, so a word result still in
// r0 at a guessed call, read by nothing else, is that call's argument (core target.ts
// `deletesDeadLibcalls`, frontend/call-plan.ts).
describe("a helper's result handed to the guessed call after it", () => {
  test.each([
    ['divcall', 'void divcall(s32 a0, s32 a1) {\n    gv(a0 / a1);\n}\n'],
    ['modcall', 'void modcall(u32 a0, u32 a1) {\n    gv(a0 % a1);\n}\n'],
  ])('%s: the operation is passed, not deleted', (name, source) => {
    expect(lift(name)).toBe(source);
  });

  // `if (c) gv(s); else hv();` and `if (c) gv(s); else hv(s);` are the same bytes, so nothing picks
  // one call: every guessed call that reads the result is passed it, whichever the trim takes first
  // (frontend/ssa.ts `readByGuessedCallsAlone`). `gv(s); hv(s);` copies `s` back into r0 for `hv`.
  test.each([
    [
      'divsel',
      'void divsel(s32 a0, s32 a1, s32 a2) {\n    s32 v0;\n    v0 = a0 / a1;\n    if (a2 != 0) {\n        gv(v0);\n    } else {\n        hv(v0);\n    }\n}\n',
    ],
    [
      'divsel2',
      'void divsel2(s32 a0, s32 a1, s32 a2) {\n    s32 v0;\n    v0 = a0 / a1;\n    if (a2 != 0) {\n        gv(v0);\n    } else {\n        hv(v0);\n    }\n}\n',
    ],
    ['divtwo', 'void divtwo(s32 a0, s32 a1) {\n    s32 v0;\n    v0 = a0 / a1;\n    gv(v0);\n    hv(v0);\n}\n'],
  ])('%s: every guessed call reading the result is passed it', (name, source) => {
    expect(lift(name)).toBe(source);
  });

  // `s = a / b; gv(); return s;` and `gv(s); return s;` are the same bytes: a result read elsewhere
  // too stays the trim's leftover.
  test('a result something else reads is not passed', () => {
    expect(lift('divkeep')).toBe(
      's32 divkeep(s32 a0, s32 a1) {\n    s32 v0;\n    v0 = a0 / a1;\n    gv();\n    return v0;\n}\n',
    );
  });

  // At -O0 the dead call stays, so its result in r0 says nothing about the call after it.
  test('not where the compiler keeps a dead helper call', () => {
    const { deletesDeadLibcalls, ...kept } = ARMV4T_AGBCC.compilerBehaviors;
    expect(deletesDeadLibcalls).toBe(true);
    expect(decompile('divcall', asm, { ...ARMV4T_AGBCC, compilerBehaviors: kept }).source).toContain('gv();');
    expect(targetFor('agbcc', ['-O0']).target.compilerBehaviors.deletesDeadLibcalls).toBeUndefined();
    expect(targetFor('agbcc', ['-O1']).target.compilerBehaviors.deletesDeadLibcalls).toBe(true);
  });

  // A float handed to an undeclared callee: C would promote it to a double, so the product is no
  // float any call here takes, and the helper stays gapped.
  test('a float result into an undeclared callee refuses', () => {
    expect(() => lift('fcallu')).toThrow("no model for the runtime helper '__mulsf3'");
  });
});
