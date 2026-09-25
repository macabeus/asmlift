// A hardware floating-point value as an IR type: what the kind is, what it is not, and how each
// backend spells it. `docs/floating-point.md` says which frontends mint one.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { MIPS_FP_REG } from '../src/frontend/splat';
import { mkOp, mkValue } from '../src/ir/core';
import { isDceSafe } from '../src/ir/opcodes';
import { parse } from '../src/ir/parse';
import { T, intWidth, parseType, typeEquals, typeToString } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import type { Expr } from '../src/l3/ast';
import { exprCType, renderedIntSignedness } from '../src/l3/typing';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import {
  ARMV4T_AGBCC,
  C_TYPEDEFS,
  MIPS_GCC,
  MIPS_IDO,
  PPC_MWCC,
  TOOLCHAIN_TARGETS,
  structureOptionsFor,
} from '../src/target';

/** Parse, verify, recover and print one function, the way `decompile` runs the tower's ends. */
const emitC = (text: string): string => {
  const fn = parse(text);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, structureOptionsFor(MIPS_IDO, false)));
};

describe('a float is its own kind, not an integer width', () => {
  test('both widths round-trip through the IR text', () => {
    expect(typeToString(T.f32())).toBe('f32');
    expect(typeToString(T.f64())).toBe('f64');
    expect(parseType('f32')).toEqual(T.f32());
    expect(parseType('f64')).toEqual(T.f64());
  });

  // THE PREDICATE BOTH WIDTH READERS SHARE (ir/types.ts `intWidth`). The verifier reads a null as
  // "not in the integer width rule", the 64-bit helper recogniser as "refuse to fold": both are
  // right for a float, and a float that answered a width would enter integer arithmetic in both.
  test('it carries no integer width', () => {
    expect(intWidth(T.f32())).toBeNull();
    expect(intWidth(T.f64())).toBeNull();
  });

  test('the two widths are different types, and neither is the integer of its width', () => {
    expect(typeEquals(T.f32(), T.f32())).toBe(true);
    expect(typeEquals(T.f32(), T.f64())).toBe(false);
    expect(typeEquals(T.f32(), T.s(32))).toBe(false);
    expect(typeEquals(T.f64(), T.s(64))).toBe(false);
  });

  // Recovery types only `unknown`s, so a value the frontend minted as a float leaves it one: the s32
  // default must never reach it.
  test('type recovery leaves a float alone', () => {
    const a = mkValue(T.f32());
    const fn = {
      name: 'f',
      blocks: [{ params: [a], ops: [mkOp('ret', { operands: [a] })] }],
      writeOrder: undefined,
      slotHomes: undefined,
      paramEvidence: undefined,
    };
    recoverTypes(fn);
    expect(a.type).toEqual(T.f32());
  });
});

describe('what the backends can spell', () => {
  const sfn = (t: ReturnType<typeof T.f32>) => ({
    name: 'f',
    params: [{ name: 'a0', type: t }],
    locals: [],
    retType: t,
    body: [{ k: 'return' as const, value: { k: 'var' as const, name: 'a0' } }],
  });

  // The C89 keywords, which no translation unit has to declare — so the prelude stays integer-only
  // and a project context that already typedefs `f32` cannot collide with it.
  test('C spells the keyword, and the prelude declares no float typedef', () => {
    expect(cBackend.emit(sfn(T.f32()))).toContain('float f(float a0)');
    expect(cBackend.emit(sfn(T.f64()))).toContain('double f(double a0)');
    expect(C_TYPEDEFS).not.toMatch(/float|double/);
  });

  test('the Pascal backend refuses a float rather than spelling it as an integer', () => {
    expect(() => pascalBackend.emit(sfn(T.f32()))).toThrow(/no faithful spelling for a float-typed value/);
  });
});

describe('the float opcodes compute on floats, and nothing else does', () => {
  test.each(['fadd', 'fsub', 'fmul', 'fdiv'])('%s over two floats of one width verifies', (op) => {
    expect(() =>
      verify(parse(`fn f {\n^bb0(%0: f32, %1: f32):\n  %2: f32 = ${op} %0, %1\n  ret %2\n}\n`)),
    ).not.toThrow();
  });

  test('a float op over an integer is rejected', () => {
    expect(() => verify(parse('fn f {\n^bb0(%0: f32, %1: s32):\n  %2: f32 = fadd %0, %1\n  ret %2\n}\n'))).toThrow(
      /'fadd' computes on floats of one width, got f32, s32, f32/,
    );
  });

  // At L1 every INTEGER value is `unknown`; a float op must never meet one, because the frontend
  // mints every value of the FPU's file as a float.
  test('a float op over an unrecovered value is rejected too', () => {
    expect(() => verify(parse('fn f {\n^bb0(%0: unk32):\n  %1: f32 = fneg %0\n  ret %1\n}\n'))).toThrow(
      /'fneg' computes on floats of one width/,
    );
  });

  test('a float op mixing single and double is rejected', () => {
    expect(() => verify(parse('fn f {\n^bb0(%0: f32, %1: f64):\n  %2: f64 = fmul %0, %1\n  ret %2\n}\n'))).toThrow(
      /'fmul' computes on floats of one width/,
    );
  });

  test('an integer op over a float is rejected', () => {
    expect(() => verify(parse('fn f {\n^bb0(%0: f32, %1: f32):\n  %2: s32 = add %0, %1\n  ret %2\n}\n'))).toThrow(
      /a float value reaches 'add', which does not compute on floats/,
    );
  });

  test('a float crosses an edge only into a float parameter', () => {
    const text = (param: string) => `fn f {\n^bb0(%0: f32):\n  br ^bb1(%0)\n^bb1(%1: ${param}):\n  ret %1\n}\n`;
    expect(() => verify(parse(text('f32')))).not.toThrow();
    expect(() => verify(parse(text('s32')))).toThrow(/passes a f32 to a s32 block parameter/);
  });

  test('a dead float op is reaped like any pure op', () => {
    for (const op of ['fadd', 'fsub', 'fmul', 'fdiv', 'fneg']) {
      expect(isDceSafe(op)).toBe(true);
    }
  });
});

describe('their C spelling', () => {
  test('each op prints its own C token, with C precedence and no operand pin', () => {
    const src = emitC(
      'fn f {\n^bb0(%0: f32, %1: f32, %2: f32):\n  %3: f32 = fsub %1, %2\n  %4: f32 = fsub %0, %3\n' +
        '  %5: f32 = fadd %0, %1\n  %6: f32 = fmul %5, %4\n  %7: f32 = fneg %6\n  %8: f32 = fdiv %7, %2\n  ret %8\n}\n',
    );
    expect(src).toContain('float f(float a0, float a1, float a2)');
    expect(src).toContain('return -((a0 + a1) * (a0 - (a1 - a2))) / a2;');
    // `/` is the SIGNED integer divide's token too, and that one pins its operands with `(s32)`.
    expect(src).not.toContain('(s32)');
  });

  // A LOOP-CARRIED float is a block parameter, and the structurer declares it by its IR type.
  test('a float carried around a loop is declared a float', () => {
    const src = emitC(
      'fn g {\n^bb0(%0: s32, %1: f32):\n  br ^bb1(%0, %1)\n^bb1(%2: s32, %3: f32):\n  %4: f32 = fmul %3, %1\n' +
        '  %5: s32 = const {value = 1}\n  %6: s32 = sub %2, %5\n  %7: s32 = const {value = 0}\n' +
        '  %8: s32 = icmp_ne %6, %7\n  cond_br %8, ^bb1(%6, %4), ^bb2()\n^bb2():\n  ret %4\n}\n',
    );
    expect(src).toContain('float g(s32 a0, float a1)');
    expect(src).toContain('float v0;');
    expect(src).toContain('v0 = v0 * a1;');
  });

  test('the Pascal backend refuses a float operator and a float negation', () => {
    const fn = (value: Expr) => ({
      name: 'f',
      params: [{ name: 'a0', type: T.s(32) }],
      locals: [],
      retType: T.s(32),
      body: [{ k: 'return' as const, value }],
    });
    const a: Expr = { k: 'var', name: 'a0' };
    expect(() => pascalBackend.emit(fn({ k: 'bin', op: 'f+', l: a, r: a }))).toThrow(/operator 'f\+'/);
    expect(() => pascalBackend.emit(fn({ k: 'un', op: 'f-', e: a }))).toThrow(/float negation/);
  });
});

describe('what a rendered float expression is', () => {
  const env = (name: string) => (name === 'x' ? T.f32() : T.s(32));
  const x: Expr = { k: 'var', name: 'x' };

  test('its C type is the float, never the integer an integer operator would yield', () => {
    expect(exprCType({ k: 'bin', op: 'f*', l: x, r: x }, env)).toEqual(T.f32());
    expect(exprCType({ k: 'un', op: 'f-', e: x }, env)).toEqual(T.f32());
  });

  test('it has no integer signedness to pin', () => {
    expect(renderedIntSignedness({ k: 'bin', op: 'f/', l: x, r: x }, env)).toBeUndefined();
    expect(renderedIntSignedness({ k: 'un', op: 'f-', e: x }, env)).toBeUndefined();
  });
});

describe('the floating-point homes a target declares', () => {
  const descriptions = [...new Set(Object.values(TOOLCHAIN_TARGETS).map((t) => t.description))];

  // A float home on a target with no FPU would be a register file nothing can read; an FPU with no
  // homes is a frontend that refuses every float argument, which is the safe direction but a
  // description that stopped saying what it measured.
  test('a target declares homes exactly when it has a floating-point unit', () => {
    for (const d of descriptions) {
      expect(d.fpu !== undefined, `${d.compiler}`).toBe(d.capabilities.hwFloat);
    }
    expect(ARMV4T_AGBCC.fpu).toBeUndefined();
  });

  test('the homes are in the FPU file, and never an integer argument register', () => {
    for (const d of descriptions.filter((x) => x.fpu)) {
      const fpu = d.fpu!;
      const file = d.id === 'mips' ? MIPS_FP_REG : /^f\d+$/;
      for (const r of [...fpu.argRegs, fpu.returnReg]) {
        expect(r, `${d.compiler}`).toMatch(file);
        expect(d.argRegs).not.toContain(r);
      }
    }
  });

  // o32 hands float argument k its register only while it also has integer slot k to shadow.
  test("a 'leading' ABI has no more float argument registers than integer ones", () => {
    for (const d of descriptions.filter((x) => x.fpu?.slots === 'leading')) {
      expect(d.fpu!.argRegs.length).toBeLessThanOrEqual(d.argRegs.length);
    }
    expect(MIPS_IDO.fpu).toEqual({ argRegs: ['$f12', '$f14'], returnReg: '$f0', slots: 'leading' });
    expect(MIPS_GCC.fpu).toEqual(MIPS_IDO.fpu);
    expect(PPC_MWCC.fpu?.slots).toBe('separate');
    expect(PPC_MWCC.fpu?.returnReg).toBe('f1');
  });
});
