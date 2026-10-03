// MIPS calls, compiled and recompiled on all three MIPS toolchains (frontend/mips.ts `lowerJal`):
// the callee comes off the object's R_MIPS_26 record, the delay slot runs before the call, argument
// 5 is the word at `16(sp)`, and a value kept in a callee-saved register across the call is the
// value, while the register's save and restore mint nothing. A callee declared void hands nothing
// back, so a function that ends on its call returns nothing. Each lift recompiles byte-exact.
import { decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import { MIPS_GCC, MIPS_IDO, TOOLCHAIN_TARGETS, type TargetDescription } from '@asmlift/core/target';
import {
  compileMipsGcc272Target,
  compileMipsGccTarget,
  compileMipsTarget,
  extractAsmData,
  gcc272Available,
  idoAvailable,
  scoreCMips,
  scoreCMipsGcc,
  scoreObjects,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { dockerGate } from './docker-gate';

interface Case {
  name: string;
  sym: string;
  c: string;
  prototypes: Prototypes;
  spelled: RegExp;
}

const CASES: Case[] = [
  {
    name: 'an argument set up in the delay slot',
    sym: 'incr',
    c: 'int g(int); int incr(int a) { return g(a + 1) + 1; }',
    prototypes: { g: { params: ['s32'], returns: 's32' } },
    spelled: /return g\(a0 \+ 1\) \+ 1;/,
  },
  {
    name: 'a declared fifth argument, stored to 16(sp)',
    sym: 'five',
    c: 'int g5(int, int, int, int, int); int five(int a, int b) { return g5(a, b, 1, 2, a + b); }',
    prototypes: { g5: { params: ['s32', 's32', 's32', 's32', 's32'], returns: 's32' } },
    spelled: /return g5\(a0, a1, 1, 2, a0 \+ a1\);/,
  },
  {
    // GCC keeps `x` in s0, saved and restored around the body; IDO spills it to a frame word.
    name: 'a value kept across a call',
    sym: 'keep',
    c: 'int h(int); int keep(int a) { int x = h(a); return h(x) + x; }',
    prototypes: { h: { params: ['s32'], returns: 's32' } },
    spelled: /^s32 keep\(s32 a0\) \{/,
  },
  {
    name: 'a void callee',
    sym: 'after',
    c: 'void v(int); int after(int a) { v(a); return a + 1; }',
    prototypes: { v: { params: ['s32'], returnsVoid: true } },
    spelled: /v\(a0\);\s+return a0 \+ 1;/,
  },
  {
    name: 'a function ending on a void call',
    sym: 'tail',
    c: 'void v(int); void tail(int x) { v(x + 1); }',
    prototypes: { v: { params: ['s32'], returnsVoid: true } },
    spelled: /^void tail\(s32 a0\) \{\n {4}v\(a0 \+ 1\);\n\}/,
  },
];

const lift = (sym: string, asm: string, obj: string, target: TargetDescription, prototypes: Prototypes) =>
  decompile(sym, asm, target, { asmData: extractAsmData(obj, target, sym), prototypes }).source;

describe('a MIPS call recompiles byte-exact', () => {
  test.runIf(idoAvailable()).each(CASES)('ido7.1: $name', ({ sym, c, prototypes, spelled }) => {
    const flags = TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags;
    const { obj, asm } = compileMipsTarget(c, sym, flags);
    const source = lift(sym, asm, obj, MIPS_IDO, prototypes);
    expect(source).toMatch(spelled);
    expect(scoreCMips(source, sym, obj, flags).score).toBe(0);
  });

  test.runIf(dockerGate('mips-calls-kmc')).each(CASES)(
    'gcc2.7.2kmc: $name',
    ({ sym, c, prototypes, spelled }) => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags;
      const { obj, asm } = compileMipsGccTarget(c, sym, flags);
      const source = lift(sym, asm, obj, MIPS_GCC, prototypes);
      expect(source).toMatch(spelled);
      expect(scoreCMipsGcc(source, sym, obj, flags).score).toBe(0);
    },
    60_000,
  );

  test.runIf(gcc272Available()).each(CASES)(
    'gcc2.7.2: $name',
    ({ sym, c, prototypes, spelled }) => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags;
      const { obj, asm } = compileMipsGcc272Target(c, sym, flags);
      const source = lift(sym, asm, obj, MIPS_GCC, prototypes);
      expect(source).toMatch(spelled);
      expect(scoreObjects(obj, compileMipsGcc272Target(source, sym, flags).obj, sym).score).toBe(0);
    },
    60_000,
  );
});

// A conversion between a 64-bit integer and a double is a runtime call on all three toolchains, and
// the double comes back in $f0. Lifted as an ordinary call it recompiles to the same `jal`.
describe('a 64-bit conversion declines, naming its helper', () => {
  const C = 'double tod(long long a) { return a; }';
  const declines = (asm: string, obj: string, target: TargetDescription, helper: string) =>
    expect(() => lift('tod', asm, obj, target, {})).toThrow(new RegExp(`no model for the runtime helper '${helper}'`));

  test.runIf(idoAvailable())('ido7.1: __ll_to_d', () => {
    const { obj, asm } = compileMipsTarget(C, 'tod', TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags);
    declines(asm, obj, MIPS_IDO, '__ll_to_d');
  });

  test.runIf(dockerGate('mips-calls-kmc'))(
    'gcc2.7.2kmc: __floatdidf',
    () => {
      const { obj, asm } = compileMipsGccTarget(C, 'tod', TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags);
      declines(asm, obj, MIPS_GCC, '__floatdidf');
    },
    60_000,
  );

  test.runIf(gcc272Available())(
    'gcc2.7.2: __floatdidf',
    () => {
      const { obj, asm } = compileMipsGcc272Target(C, 'tod', TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags);
      declines(asm, obj, MIPS_GCC, '__floatdidf');
    },
    60_000,
  );
});

// A float that crosses a call untouched in $f0 or $f12: the caller names no FPU register, and the
// callee's declaration is what shows the float is there.
describe('a callee declared with a float declines, naming it', () => {
  const FLOATS = [
    {
      name: 'a float return',
      c: 'float g(int); float f(int a) { return g(a + 1); }',
      prototypes: { g: { params: ['s32'], returns: 'float' } },
      message: /'g' is declared to return float/,
    },
    {
      name: 'a float parameter',
      c: 'void g(float); void f(float x) { g(x); }',
      prototypes: { g: { params: ['float'], returnsVoid: true } },
      message: /'g' is declared to take float as its parameter 1/,
    },
  ];

  test.runIf(idoAvailable()).each(FLOATS)('ido7.1: $name', ({ c, prototypes, message }) => {
    const { obj, asm } = compileMipsTarget(c, 'f', TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags);
    expect(() => lift('f', asm, obj, MIPS_IDO, prototypes)).toThrow(message);
  });

  test.runIf(dockerGate('mips-calls-kmc')).each(FLOATS)(
    'gcc2.7.2kmc: $name',
    ({ c, prototypes, message }) => {
      const { obj, asm } = compileMipsGccTarget(c, 'f', TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags);
      expect(() => lift('f', asm, obj, MIPS_GCC, prototypes)).toThrow(message);
    },
    60_000,
  );

  test.runIf(gcc272Available()).each(FLOATS)(
    'gcc2.7.2: $name',
    ({ c, prototypes, message }) => {
      const { obj, asm } = compileMipsGcc272Target(c, 'f', TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags);
      expect(() => lift('f', asm, obj, MIPS_GCC, prototypes)).toThrow(message);
    },
    60_000,
  );
});
