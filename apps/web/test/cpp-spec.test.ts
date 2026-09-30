// The playground's C++ spec derivation, exercised through the REAL pipeline (offline —
// committed disasm, no toolchain), both auto-derived paths and the user-spec path.
import { cppBackend } from '@asmlift/core/backend/cpp';
import { T } from '@asmlift/core/ir/types';
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC } from '@asmlift/core/target';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { deriveSpec, irToCpp, parseSpec } from '../src/pages/playground/cpp-spec';

const VEC_DOT_ASM =
  '00000000 <dot__3VecFP3Vec>:\n' +
  '   0:\tlwz     r6,0(r3)\n   4:\tlwz     r5,0(r4)\n   8:\tlwz     r3,4(r3)\n   c:\tlwz     r0,4(r4)\n' +
  '  10:\tmullw   r4,r6,r5\n  14:\tmullw   r0,r3,r0\n  18:\tadd     r3,r4,r0\n  1c:\tblr\n';

test('mangled symbol, no user spec: demangle + synthesized word-field layout', () => {
  const sym = 'dot__3VecFP3Vec';
  const pass1 = decompile(sym, VEC_DOT_ASM, PPC_MWCC, { onGap: 'annotate' });
  const spec = deriveSpec(sym, pass1.sfn, PPC_MWCC.fpu?.slots);
  expect(spec.method).toBe('dot');
  expect(spec.cls).toBe('Vec');
  expect(spec.params).toEqual([{ name: 'a', type: { base: 'Vec', ptr: 1 } }]);
  expect(spec.classes?.Vec.fields.map((f) => f.name)).toEqual(['field_0', 'field_1']);

  const r = decompile(sym, VEC_DOT_ASM, PPC_MWCC, {
    backend: cppBackend(spec, PPC_MWCC.fpu?.slots),
    onGap: 'annotate',
  });
  expect(r.diagnostics).toEqual([]);
  expect(r.source).toBe(
    'struct Vec { int field_0; int field_1; int dot(Vec *a); };\n' +
      'int Vec::dot(Vec *a) {\n    return field_0 * a->field_0 + field_1 * a->field_1;\n}\n',
  );
});

test('user spec (the examples.ts Vec::dot JSON) reproduces the pinned ppc-cpp golden', () => {
  const spec = parseSpec(
    JSON.stringify({
      method: 'dot',
      cls: 'Vec',
      retType: { base: 'int', ptr: 0 },
      params: [{ name: 'o', type: { base: 'Vec', ptr: 1 } }],
      classes: {
        Vec: {
          fields: [
            { name: 'x', type: { base: 'int', ptr: 0 } },
            { name: 'y', type: { base: 'int', ptr: 0 } },
          ],
        },
      },
    }),
  );
  const r = decompile('dot__3VecFP3Vec', VEC_DOT_ASM, PPC_MWCC, {
    backend: cppBackend(spec, PPC_MWCC.fpu?.slots),
    onGap: 'annotate',
  });
  expect(r.source).toBe(
    'struct Vec { int x; int y; int dot(Vec *o); };\nint Vec::dot(Vec *o) {\n    return x * o->x + y * o->y;\n}\n',
  );
});

test('unmangled symbol: free-function spec from the lifted params', () => {
  const asm = readFileSync(join(import.meta.dirname, '../../../packages/core/test/corpus/ido-add1.asm'), 'utf8');
  const pass1 = decompile('add1', asm, MIPS_IDO, { onGap: 'annotate' });
  const spec = deriveSpec('add1', pass1.sfn, MIPS_IDO.fpu?.slots);
  expect(spec).toEqual({
    method: 'add1',
    retType: { base: 'int', ptr: 0 },
    params: [{ name: 'a0', type: { base: 'int', ptr: 0 } }],
  });
  const r = decompile('add1', asm, MIPS_IDO, { backend: cppBackend(spec, MIPS_IDO.fpu?.slots), onGap: 'annotate' });
  expect(r.source).toBe('int add1(int a0) {\n    return a0 + 1;\n}\n');
});

test('a sub-word receiver DECLINES auto-derivation instead of mis-mapping fields', () => {
  // `struct Vec { short x; short y; }` member read: lha at 0 and 2 — the all-int synthesis
  // would map field_1 to byte offset 4 (silently wrong C++).
  const asm =
    '00000000 <sum__3VecFv>:\n   0:\tlha     r4,0(r3)\n   4:\tlha     r0,2(r3)\n' +
    '   8:\tadd     r3,r4,r0\n   c:\tblr\n';
  const pass1 = decompile('sum__3VecFv', asm, PPC_MWCC, { onGap: 'annotate' });
  expect(() => deriveSpec('sum__3VecFv', pass1.sfn, PPC_MWCC.fpu?.slots)).toThrow(/sub-word width/);
});

test('a demangle false-positive (plain C symbol shaped x__F<codes>) falls back to free-fn', () => {
  // `buf__Fill` demangles to buf(int, long, long) — but the lifted fn has ONE param, so the
  // arity cross-check rejects the fabricated signature.
  const asm = '00000000 <buf__Fill>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a0,1\n';
  const pass1 = decompile('buf__Fill', asm, MIPS_IDO, { onGap: 'annotate' });
  const spec = deriveSpec('buf__Fill', pass1.sfn, MIPS_IDO.fpu?.slots);
  expect(spec.method).toBe('buf__Fill'); // kept as mangled-C, not renamed to "buf"
  expect(spec.cls).toBeUndefined();
  expect(spec.params).toHaveLength(1);
  const r = decompile('buf__Fill', asm, MIPS_IDO, {
    backend: cppBackend(spec, MIPS_IDO.fpu?.slots),
    onGap: 'annotate',
  });
  expect(r.source).toBe('int buf__Fill(int a0) {\n    return a0 + 1;\n}\n');
});

test('demangle length-prefix overrun yields free-fn, never invalid C++', () => {
  const asm = '00000000 <map__Fill16>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a0,1\n';
  const pass1 = decompile('map__Fill16', asm, MIPS_IDO, { onGap: 'annotate' });
  const spec = deriveSpec('map__Fill16', pass1.sfn, MIPS_IDO.fpu?.slots);
  expect(spec.method).toBe('map__Fill16');
  expect(spec.params.every((p) => p.type.base.length > 0)).toBe(true);
});

test('irToCpp maps widths, signedness, pointers, void', () => {
  expect(irToCpp(T.s(32))).toEqual({ base: 'int', ptr: 0 });
  expect(irToCpp(T.u(32))).toEqual({ base: 'unsigned int', ptr: 0 });
  expect(irToCpp(T.int(16, true))).toEqual({ base: 'short', ptr: 0 });
  expect(irToCpp(T.int(8, false))).toEqual({ base: 'unsigned char', ptr: 0 });
  expect(irToCpp(T.ptr(T.s(32)))).toEqual({ base: 'int', ptr: 1 });
  expect(irToCpp(T.s(64))).toEqual({ base: 'long long', ptr: 0 }); // no silent 64→int narrowing
  expect(irToCpp({ kind: 'void' })).toEqual({ base: 'void', ptr: 0 });
});

test('parseSpec rejects malformed specs with readable messages', () => {
  expect(() => parseSpec('{nope')).toThrow(/not valid JSON/);
  expect(() => parseSpec('{"retType":{"base":"int","ptr":0},"params":[]}')).toThrow(/"method"/);
  expect(() => parseSpec('{"method":"f","retType":"int","params":[]}')).toThrow(/retType/);
  expect(() => parseSpec('{"method":"f","retType":{"base":"int","ptr":0},"params":[{"name":1}]}')).toThrow(/params/);
  expect(() =>
    parseSpec('{"method":"f","retType":{"base":"int","ptr":0},"params":[],"classes":{"V":{"fields":[{}]}}}'),
  ).toThrow(/class "V"/);
});

// A FLOAT, in both auto-derived paths. The C-symbol path spells the lifted types, and a float is not
// the `int` default; the demangled path binds by register FILE, because the PowerPC lift puts every
// float after the integers (`float g(float x, int n)` lifts as `(s32 a0, float a1)`).
const FADD_MWCC = '00000000 <fadd>:\n   0:\tfadds\tf1,f1,f2\n   4:\tblr\n';
const FADD_IDO = '00000000 <fadd>:\n   0:\tjr\tra\n   4:\tadd.s\t$f0,$f12,$f14\n';
const G_FFI = '00000000 <g__Ffi>:\n   0:\tcmpwi\tr3,0\n   4:\tbnelr\n   8:\tfneg\tf1,f1\n   c:\tblr\n';
const cpp = (sym: string, asm: string, target: typeof PPC_MWCC) => {
  const spec = deriveSpec(sym, decompile(sym, asm, target, { onGap: 'annotate' }).sfn, target.fpu?.slots);
  return decompile(sym, asm, target, { backend: cppBackend(spec, target.fpu?.slots), onGap: 'annotate' }).source;
};

test.each([
  ['mwcc', FADD_MWCC, PPC_MWCC],
  ['ido', FADD_IDO, MIPS_IDO],
])('a float free function is declared float, not int (%s)', (_tc, asm, target) => {
  expect(irToCpp(T.f32())).toEqual({ base: 'float', ptr: 0 });
  expect(cpp('fadd', asm, target)).toBe('float fadd(float a0, float a1) {\n    return a0 + a1;\n}\n');
});

test('a demangled signature binds its float to the lifted float, whatever the ABI sort did', () => {
  expect(cpp('g__Ffi', G_FFI, PPC_MWCC)).toBe(
    'float g(float a, int b) {\n    if (b == 0) {\n        return -a;\n    } else {\n        return a;\n    }\n}\n',
  );
});

// A demangle with fewer floats than the lift is a false positive, like an arity mismatch.
test('a demangled float count the lift does not have falls back to the free function', () => {
  const spec = deriveSpec(
    'g__Fii',
    decompile('g__Fii', G_FFI.replace('g__Ffi', 'g__Fii'), PPC_MWCC).sfn,
    PPC_MWCC.fpu?.slots,
  );
  expect(spec.method).toBe('g__Fii');
  expect(spec.params.map((p) => p.type.base)).toEqual(['int', 'float']);
});

test('a user spec that disagrees with the lift on the float parameters is refused', () => {
  const spec = parseSpec(
    JSON.stringify({
      method: 'g',
      retType: { base: 'float', ptr: 0 },
      params: [
        { name: 'x', type: { base: 'int', ptr: 0 } },
        { name: 'n', type: { base: 'int', ptr: 0 } },
      ],
    }),
  );
  expect(() => decompile('g__Ffi', G_FFI, PPC_MWCC, { backend: cppBackend(spec, PPC_MWCC.fpu?.slots) })).toThrow(
    /the spec's floating-point parameters do not match the lifted function's/,
  );
});

// THE BINDING FOLLOWS THE TARGET'S SLOT MODEL. Under the PowerPC EABI a float the body never reads
// leaves no hole, so a spec may name more floats than the lift has: `int m(int n, float x)` for
// `addi r3,r3,1` lifts as `(s32 a0)`, and `n` is that `a0`. Under o32 an unread LEADING float is
// minted as an integer hole, so binding by file would hand `int k(float x, int n)`'s `n` the hole
// `a0`; binding by position hands it `a1`, the register the body reads.
const specOf = (method: string, params: [string, string][], ret = 'int') =>
  parseSpec(
    JSON.stringify({
      method,
      retType: { base: ret, ptr: 0 },
      params: params.map(([name, base]) => ({ name, type: { base, ptr: 0 } })),
    }),
  );

// THE PRECISION IS PART OF THE TYPE. mwcc compiles `double addf(float a, float b){ return (double)a +
// (double)b; }` to a bare `fadd f1,f1,f2`: the object records a double add and nothing of the
// parameters' precision, so the lift's parameters are doubles. A spec that binds them to `float a,
// float b` prints `a + b`, a single-precision add that recompiles to `fadds`.
const ADDF_MWCC = '00000000 <addf__Fff>:\n   0:\tfadd\tf1,f1,f2\n   4:\tblr\n';

test('a double is declared double, in the free function and in the demangled fallback', () => {
  expect(irToCpp(T.f64())).toEqual({ base: 'double', ptr: 0 });
  expect(cpp('dadd', ADDF_MWCC.replace('addf__Fff', 'dadd'), PPC_MWCC)).toBe(
    'double dadd(double a0, double a1) {\n    return a0 + a1;\n}\n',
  );
  expect(cpp('addf__Fff', ADDF_MWCC, PPC_MWCC)).toBe(
    'double addf__Fff(double a0, double a1) {\n    return a0 + a1;\n}\n',
  );
});

test.each([
  ['float parameters for a double add', ADDF_MWCC, 'double', 'float'],
  ['double parameters for a single add', ADDF_MWCC.replace('fadd\t', 'fadds\t'), 'float', 'double'],
])('a user spec with %s is refused', (_label, asm, ret, param) => {
  const spec = specOf(
    'addf',
    [
      ['a', param],
      ['b', param],
    ],
    ret,
  );
  expect(() => decompile('addf__Fff', asm, PPC_MWCC, { backend: cppBackend(spec, PPC_MWCC.fpu?.slots) })).toThrow(
    /the spec's floating-point parameters do not match the lifted function's/,
  );
});

// …AND WHERE THE CODE STATES NO PRECISION, THE SPEC'S IS THE ONE PRINTED. `fneg` and `fmr` are one
// instruction for a float and a double, so `double dneg(double a){ return -a; }` is `fneg f1,f1; blr`
// and so is its float twin (both compiled at mwcc_242_81's canonical flags). The lift's float states
// no width, and a double spec binds it.
const DNEG_MWCC = '00000000 <dneg__Fd>:\n   0:\tfneg\tf1,f1\n   4:\tblr\n';
const DSND_MWCC = '00000000 <dsnd__Fdd>:\n   0:\tfmr\tf1,f2\n   4:\tblr\n';

test.each([
  ['a negation', 'dneg__Fd', DNEG_MWCC, specOf('dneg', [['p0', 'double']], 'double'), 'return -p0;'],
  [
    'a copy',
    'dsnd__Fdd',
    DSND_MWCC,
    specOf(
      'dsnd',
      [
        ['a', 'double'],
        ['b', 'double'],
      ],
      'double',
    ),
    'return b;',
  ],
  ['a negation, as a float', 'dneg__Fd', DNEG_MWCC, specOf('dneg', [['p0', 'float']], 'float'), 'return -p0;'],
])('a user spec binds %s of no stated precision', (_label, sym, asm, spec, body) => {
  expect(decompile(sym, asm, PPC_MWCC, { backend: cppBackend(spec, PPC_MWCC.fpu?.slots) }).source).toContain(body);
});

// The demangled path declares the result at the widest float the signature binds: `float dneg(double
// a)` compiles to `fneg f1,f1; frsp f1,f1`, one instruction more than the target.
test('a demangled signature of doubles over a precision-free body is all double', () => {
  expect(cpp('dneg__Fd', DNEG_MWCC, PPC_MWCC)).toBe('double dneg(double a) {\n    return -a;\n}\n');
  expect(cpp('dsnd__Fdd', DSND_MWCC, PPC_MWCC)).toBe('double dsnd(double a, double b) {\n    return b;\n}\n');
});

// …AND A SLOT THE BODY NEVER READS STATES NONE EITHER. The lift types every float register at the
// function's precision, including a slot minted only to hold a later float argument's place, so the
// `a` of these is a single in a single-precision function and a double in a double one. All three compiled at
// mwcc_242_81's canonical flags.
const F1_MWCC = '00000000 <f1__Fdf>:\n   0:\tfadds\tf1,f2,f2\n   4:\tblr\n';
const F3_MWCC = '00000000 <f3__Fdff>:\n   0:\tfmuls\tf1,f2,f3\n   4:\tblr\n';
const H2_MWCC = '00000000 <h2__Ffdd>:\n   0:\tfadd\tf1,f2,f3\n   4:\tblr\n';

test.each([
  [
    'float f1(double a, float b)',
    'f1__Fdf',
    F1_MWCC,
    specOf(
      'f1',
      [
        ['a', 'double'],
        ['b', 'float'],
      ],
      'float',
    ),
    'float f1(double a, float b) {\n    return b + b;\n}\n',
  ],
  [
    'float f3(double a, float b, float c)',
    'f3__Fdff',
    F3_MWCC,
    specOf(
      'f3',
      [
        ['a', 'double'],
        ['b', 'float'],
        ['c', 'float'],
      ],
      'float',
    ),
    'float f3(double a, float b, float c) {\n    return b * c;\n}\n',
  ],
  [
    'double h2(float a, double b, double c)',
    'h2__Ffdd',
    H2_MWCC,
    specOf(
      'h2',
      [
        ['a', 'float'],
        ['b', 'double'],
        ['c', 'double'],
      ],
      'double',
    ),
    'double h2(float a, double b, double c) {\n    return b + c;\n}\n',
  ],
])('an unread float slot binds a spec float of the other precision: %s', (_label, sym, asm, spec, source) => {
  expect(decompile(sym, asm, PPC_MWCC, { backend: cppBackend(spec, PPC_MWCC.fpu?.slots) }).source).toBe(source);
  expect(cpp(sym, asm, PPC_MWCC)).toBe(source);
});

// …BUT ON o32 THE HOLE'S WIDTH PLACED THE INTEGERS AFTER IT. A single takes one integer slot and a
// double two, counted at the function's precision, so the single-precision `m2` lays its unread
// `double a` out as one slot and its `p` arrives in `a3` where the lift's position says `q`. Both
// compiled at gcc2.7.2kmc's canonical flags.
const M2_KMC =
  '00000000 <m2__FdfPiPi>:\n   0:\tsw\tzero,0(a3)\n   4:\tjr\tra\n   8:\tadd.s\t$f0,$f14,$f14\n   c:\tnop\n';
const M3_KMC = '00000000 <m3__Fdf>:\n   0:\tjr\tra\n   4:\tadd.s\t$f0,$f14,$f14\n';

test('o32: an unread float hole of the other width refuses a spec with an integer after it', () => {
  const spec = parseSpec(
    JSON.stringify({
      method: 'm2',
      retType: { base: 'float', ptr: 0 },
      params: [
        { name: 'a', type: { base: 'double', ptr: 0 } },
        { name: 'b', type: { base: 'float', ptr: 0 } },
        { name: 'p', type: { base: 'int', ptr: 1 } },
        { name: 'q', type: { base: 'int', ptr: 1 } },
      ],
    }),
  );
  expect(() => decompile('m2__FdfPiPi', M2_KMC, MIPS_GCC, { backend: cppBackend(spec, MIPS_GCC.fpu?.slots) })).toThrow(
    /floating-point parameters do not match/,
  );
  expect(cpp('m2__FdfPiPi', M2_KMC, MIPS_GCC)).toBe(
    'float m2__FdfPiPi(float a0, float a1, int a2, int *a3) {\n    *a3 = 0;\n    return a1 + a1;\n}\n',
  );
});

// A DOUBLE THE BODY NEVER READS IS TWO INTEGER HOLES when no FPU register is read at all, so a spec
// `double` bound by position to the first of them names every later parameter one slot early.
// Compiled at gcc2.7.2kmc's canonical flags: `n1` stores through `a2` (its `q`) and `n2` returns
// `a2` (its `c`). A `float` over one such hole is one slot, and still binds.
const N1_KMC = '00000000 <n1__FdPiPi>:\n   0:\tjr\tra\n   4:\tsw\tzero,0(a2)\n';
const N2_KMC = '00000000 <n2__Fdii>:\n   0:\tjr\tra\n   4:\tmove\tv0,a2\n';
const K_KMC = '00000000 <k__Ffi>:\n   0:\tjr\tra\n   4:\tmove\tv0,a1\n';

test.each([
  ['n1__FdPiPi', N1_KMC, 1, 'void n1__FdPiPi(int a0, int a1, int *a2) {\n    *a2 = 0;\n}\n'],
  ['n2__Fdii', N2_KMC, 0, 'int n2__Fdii(int a0, int a1, int a2) {\n    return a2;\n}\n'],
])('o32: a spec double over a lifted integer hole with a parameter after it refuses (%s)', (sym, asm, ptr, free) => {
  const spec = parseSpec(
    JSON.stringify({
      method: sym.slice(0, 2),
      retType: { base: 'int', ptr: 0 },
      params: [
        { name: 'd', type: { base: 'double', ptr: 0 } },
        { name: 'b', type: { base: 'int', ptr } },
        { name: 'c', type: { base: 'int', ptr } },
      ],
    }),
  );
  expect(() => decompile(sym, asm, MIPS_GCC, { backend: cppBackend(spec, MIPS_GCC.fpu?.slots) })).toThrow(
    /floating-point parameters do not match/,
  );
  expect(cpp(sym, asm, MIPS_GCC)).toBe(free);
});

// …EXCEPT A TRAILING DOUBLE NOTHING READS. IDO 7.1 at its canonical flags homes it (`sw a2,8(sp); sw
// a3,12(sp)`), so the lift keeps both slots as parameters the body never reads, and no spec
// parameter follows the double to be named one slot early.
const O1_IDO = '00000000 <o1__Fid>:\n   0:\tsw\ta2,8(sp)\n   4:\tsw\ta3,12(sp)\n   8:\tjr\tra\n   c:\tmove\tv0,a0\n';

test('o32: a trailing spec double over integer holes the body never reads binds', () => {
  const spec = specOf('o1', [
    ['a', 'int'],
    ['d', 'double'],
  ]);
  expect(decompile('o1__Fid', O1_IDO, MIPS_IDO, { backend: cppBackend(spec, MIPS_IDO.fpu?.slots) }).source).toBe(
    'int o1(int a, double d) {\n    return a;\n}\n',
  );
});

// A READ HALF IS NOT THE DOUBLE. agbcc passes a double in two integer registers, and `int u1(int a,
// double d)` returning the first word of `d` through a union compiles to `add r0,r1,#0`: the lift
// reads one 32-bit slot, and a spec `double` over it would print that word as the whole value.
const U1_AGBCC = 'u1__Fid:\n\tadd\tr0, r1, #0\n\tbx\tlr\n';

test('agbcc: a spec double over a 32-bit slot the body reads refuses, and the auto path falls back', () => {
  const spec = specOf('u1', [
    ['a', 'int'],
    ['d', 'double'],
  ]);
  expect(() =>
    decompile('u1__Fid', U1_AGBCC, ARMV4T_AGBCC, { backend: cppBackend(spec, ARMV4T_AGBCC.fpu?.slots) }),
  ).toThrow(/floating-point parameters do not match/);
  expect(cpp('u1__Fid', U1_AGBCC, ARMV4T_AGBCC)).toBe('int u1__Fid(int a0, int a1) {\n    return a1;\n}\n');
});

test('o32: a spec float over a lifted integer hole takes its one slot', () => {
  expect(cpp('k__Ffi', K_KMC, MIPS_GCC)).toBe('int k(float a, int b) {\n    return b;\n}\n');
});

test('o32: an unread float hole with no integer after it binds either width', () => {
  const source = 'float m3(double a, float b) {\n    return b + b;\n}\n';
  const spec = specOf(
    'm3',
    [
      ['a', 'double'],
      ['b', 'float'],
    ],
    'float',
  );
  expect(decompile('m3__Fdf', M3_KMC, MIPS_GCC, { backend: cppBackend(spec, MIPS_GCC.fpu?.slots) }).source).toBe(
    source,
  );
  expect(cpp('m3__Fdf', M3_KMC, MIPS_GCC)).toBe(source);
});

test.each([
  [
    'EABI: a trailing unread float',
    'm',
    '00000000 <m>:\n   0:\taddi\tr3,r3,1\n   4:\tblr\n',
    PPC_MWCC,
    specOf('m', [
      ['n', 'int'],
      ['x', 'float'],
    ]),
    'return n + 1;',
  ],
  [
    'EABI: a leading unread float',
    'k',
    '00000000 <k>:\n   0:\taddi\tr3,r3,1\n   4:\tblr\n',
    PPC_MWCC,
    specOf('k', [
      ['x', 'float'],
      ['n', 'int'],
    ]),
    'return n + 1;',
  ],
  [
    'o32: a leading unread float',
    'k',
    '00000000 <k>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a1,1\n',
    MIPS_IDO,
    specOf('k', [
      ['x', 'float'],
      ['n', 'int'],
    ]),
    'return n + 1;',
  ],
])('%s binds the integer the body reads', (_label, sym, asm, target, spec, body) => {
  expect(decompile(sym, asm, target, { backend: cppBackend(spec, target.fpu?.slots) }).source).toContain(body);
});
