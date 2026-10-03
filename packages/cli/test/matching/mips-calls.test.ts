// MIPS calls, compiled and recompiled on all three MIPS toolchains (frontend/mips.ts `lowerJal`):
// the callee comes off the object's R_MIPS_26 record, the delay slot runs before the call, argument
// 5 is the word at `16(sp)`, and a value kept in a callee-saved register across the call is the
// value, while the register's save and restore mint nothing. Each lift recompiles byte-exact.
//
// The void case reads nothing after its call: the lift writes the call's value to v0 whatever the
// callee's declaration says, so a function that ends on a void call returns it and does not compile.
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
