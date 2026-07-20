// C++ — the THIRD LANGUAGE backend, end-to-end on real CodeWarrior codegen.
// Each case: reference C++ (`.cp`) → mwcceppc → PowerPC object (scoring target, keyed by the MANGLED
// symbol) + objdump disasm (asmlift input) → decompile with the C++ backend → recompile the emitted
// C++ with the SAME mwcceppc → REAL objdiff score. Byte-exact (0) means asmlift reproduced
// CodeWarrior's exact Gekko codegen FROM idiomatic, de-mangled C++ it generated itself.
//
// What this proves that the C and Pascal backends could not: the LANGUAGE SEAM generalizes past C
// (the backend-side mirror of what PowerPC proved for the frontend seam). The emitted text carries
// genuine C++ surface — scope resolution `Vec::dot`, an implicit `this` (member fields spelled bare),
// `->` member access on pointer params, and a mangled SYMBOL generated from the recovered signature
// (@asmlift/core src/mangle.ts) — while the BODY is spelled by the shared C-family printer, because a CodeWarrior
// member function's body is byte-identical to the same C with `this` explicit.
//
// Docker-gated (same image/toolchain as ppc-mwcc.test.ts). The class layout + method signature are a
// recovery INPUT here (a decomp project has them in headers, exactly as it has C prototypes).
import { type CppFnSpec, cppBackend, cppSymbol } from '@asmlift/core/backend/cpp';
import { decompile } from '@asmlift/core/pipeline';
import { PPC_MWCC } from '@asmlift/core/target';
import { compilePpcCppTarget, scoreCPpc, scoreCppPpc } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';

const HAVE = ppcDockerGate('ppc-cpp');

const INT = { base: 'int', ptr: 0 },
  VOID = { base: 'void', ptr: 0 },
  VECP = { base: 'Vec', ptr: 1 };
const VEC = {
  fields: [
    { name: 'x', type: INT },
    { name: 'y', type: INT },
  ],
};

const CASES: { cpp: string; spec: CppFnSpec; expect: string; note: string }[] = [
  {
    note: 'member read: Vec::dot(Vec*) — scope ::, implicit this (bare x/y), -> on a pointer param',
    cpp: 'struct Vec{int x;int y;int dot(Vec*o);}; int Vec::dot(Vec*o){ return x*o->x + y*o->y; }',
    spec: { method: 'dot', cls: 'Vec', retType: INT, params: [{ name: 'o', type: VECP }], classes: { Vec: VEC } },
    expect:
      'struct Vec { int x; int y; int dot(Vec * o); };\nint Vec::dot(Vec * o) {\n    return x * o->x + y * o->y;\n}\n',
  },
  {
    note: 'no-arg member: Vec::len2() — Fv mangling, this-only field access',
    cpp: 'struct Vec{int x;int y;int len2();}; int Vec::len2(){ return x*x + y*y; }',
    spec: { method: 'len2', cls: 'Vec', retType: INT, params: [], classes: { Vec: VEC } },
    expect: 'struct Vec { int x; int y; int len2(); };\nint Vec::len2() {\n    return x * x + y * y;\n}\n',
  },
  {
    note: 'member WRITE: Vec::scale(int) — void method, `this->field = …` (spelled bare)',
    cpp: 'struct Vec{int x;int y;void scale(int k);}; void Vec::scale(int k){ x = x*k; y = y*k; }',
    spec: { method: 'scale', cls: 'Vec', retType: VOID, params: [{ name: 'k', type: INT }], classes: { Vec: VEC } },
    expect:
      'struct Vec { int x; int y; void scale(int k); };\nvoid Vec::scale(int k) {\n    x = x * k;\n    y = y * k;\n    return;\n}\n',
  },
  {
    note: 'free function with member access: dot(Vec*,Vec*) — no scope, both params use ->',
    cpp: 'struct Vec{int x;int y;}; int dot(Vec*a,Vec*b){ return a->x*b->x + a->y*b->y; }',
    spec: {
      method: 'dot',
      retType: INT,
      params: [
        { name: 'a', type: VECP },
        { name: 'b', type: VECP },
      ],
      classes: { Vec: VEC },
    },
    expect: 'struct Vec { int x; int y; };\nint dot(Vec * a, Vec * b) {\n    return a->x * b->x + a->y * b->y;\n}\n',
  },
];

describe('C++ backend: compile → disasm → decompile (idiomatic C++) → recompile → objdiff', () => {
  for (const { cpp, spec, expect: golden, note } of CASES) {
    const sym = cppSymbol(spec);
    test.runIf(HAVE)(`${sym} — ${note}`, () => {
      const { obj, asm } = compilePpcCppTarget(cpp, sym);
      const r = decompile(sym, asm, PPC_MWCC, {
        backend: cppBackend(spec),
        prototypes: { [sym]: { returnsVoid: spec.retType.base === 'void' } },
      });
      expect(r.source).toBe(golden);
      const s = scoreCppPpc(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C++ for ${sym}:\n${r.source}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});

// OFFLINE coverage (no Docker): committed REAL mwcceppc disassembly of `Vec::dot`, lifted →
// C++-backend-emitted → pinned byte-for-byte. Guarantees the C++ GENERATOR is reproducible in CI
// where the toolchain is absent (the CORPUS discipline), exercising the frontend member-call decode
// and the whole C++ emit path deterministically. Scoring stays in the Docker-gated suite above.
describe('C++ backend — offline (committed disasm, no toolchain)', () => {
  // The word-index member-access mapping only holds for WORD accesses into all-4-byte layouts.
  // A SUB-WORD access never reaches it (the hook's `width === 4` gate): it falls through to the
  // shared C spelling, whose width legalization emits the honest reinterpret cast — byte-correct,
  // un-idiomatic, never the WRONG member (`getB` reads `b` at 4(r3) width 2 → word-idx 2 would
  // mis-map to `c`). A WORD access into a MIXED layout still FAILS LOUD (byte-offset field
  // resolution is follow-on work).
  test('a sub-word access emits the honest cast, never a mis-mapped member; a word access into a mixed layout fails loud', () => {
    const SUBWORD: CppFnSpec = {
      method: 'getB',
      cls: 'S',
      retType: INT,
      params: [],
      classes: {
        S: {
          fields: [
            { name: 'a', type: INT },
            { name: 'b', type: { base: 'short', ptr: 0 } },
            { name: 'c', type: { base: 'short', ptr: 0 } },
          ],
        },
      },
    };
    const asm = '00000000 <getB__1SFv>:\n   0:\tlha     r3,4(r3)\n   4:\tblr\n';
    const res = decompile('getB__1SFv', asm, PPC_MWCC, { backend: cppBackend(SUBWORD) });
    expect(res.source).toContain('((s16 *)this)[2]'); // bytes 4–5 = `b`, honestly spelled
    expect(res.source).not.toMatch(/return c;/); // the mis-mapped member, never
    const wordAsm = '00000000 <getA__1SFv>:\n   0:\tlwz     r3,4(r3)\n   4:\tblr\n';
    const WORD: CppFnSpec = { ...SUBWORD, method: 'getA' };
    expect(() => decompile('getA__1SFv', wordAsm, PPC_MWCC, { backend: cppBackend(WORD) })).toThrow(
      /sub-word\/mixed field layout/,
    );
  });

  test('Vec::dot lifts + emits idiomatic C++ from real committed CodeWarrior disasm', () => {
    const asm =
      '00000000 <dot__3VecFP3Vec>:\n' +
      '   0:\tlwz     r6,0(r3)\n   4:\tlwz     r5,0(r4)\n   8:\tlwz     r3,4(r3)\n   c:\tlwz     r0,4(r4)\n' +
      '  10:\tmullw   r4,r6,r5\n  14:\tmullw   r0,r3,r0\n  18:\tadd     r3,r4,r0\n  1c:\tblr\n';
    const spec: CppFnSpec = {
      method: 'dot',
      cls: 'Vec',
      retType: INT,
      params: [{ name: 'o', type: VECP }],
      classes: { Vec: VEC },
    };
    const r = decompile('dot__3VecFP3Vec', asm, PPC_MWCC, { backend: cppBackend(spec) });
    expect(r.source).toBe(
      'struct Vec { int x; int y; int dot(Vec * o); };\nint Vec::dot(Vec * o) {\n    return x * o->x + y * o->y;\n}\n',
    );
  });
});

// The MANGLED-C SPIKE, pinned as a test. asmlift's EXISTING C backend — given the mangled
// symbol as the function name and `this` as an explicit `s32 *` param — already reaches the C++
// target byte-for-byte, with ZERO C++-specific machinery: the body IS C-shaped, so mangled-C is a
// valid stepping stone (and proves the frontend+harness reach). The full C++ backend above is what
// turns that byte-match into a HUMAN-readable, de-mangled `Vec::dot` — the source-fidelity goal.
describe('C++ mangled-C spike: the plain-C backend reaches a C++ target as mangled-C', () => {
  test.runIf(HAVE)('dot__3VecFP3Vec matches the C++ target from plain C (pointer indexing)', () => {
    const sym = 'dot__3VecFP3Vec';
    const { obj, asm } = compilePpcCppTarget(
      'struct Vec{int x;int y;int dot(Vec*o);}; int Vec::dot(Vec*o){ return x*o->x + y*o->y; }',
      sym,
    );
    const r = decompile(sym, asm, PPC_MWCC); // DEFAULT C backend — mangled-C
    expect(r.source).toBe(`s32 ${sym}(s32 * a0, s32 * a1) {\n    return *a0 * *a1 + a0[1] * a1[1];\n}\n`);
    const s = scoreCPpc(r.source, sym, obj); // compiled as plain C, scored vs the C++ target
    expect(s.score).toBe(0);
    expect(s.match).toBe(true);
  });
});
