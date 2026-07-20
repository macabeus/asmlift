// The playground's C++ spec derivation, exercised through the REAL pipeline (offline —
// committed disasm, no toolchain), both auto-derived paths and the user-spec path.
import { cppBackend } from '@asmlift/core/backend/cpp';
import { T } from '@asmlift/core/ir/types';
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_IDO, PPC_MWCC } from '@asmlift/core/target';
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
  const spec = deriveSpec(sym, pass1.sfn);
  expect(spec.method).toBe('dot');
  expect(spec.cls).toBe('Vec');
  expect(spec.params).toEqual([{ name: 'a', type: { base: 'Vec', ptr: 1 } }]);
  expect(spec.classes?.Vec.fields.map((f) => f.name)).toEqual(['field_0', 'field_1']);

  const r = decompile(sym, VEC_DOT_ASM, PPC_MWCC, { backend: cppBackend(spec), onGap: 'annotate' });
  expect(r.diagnostics).toEqual([]);
  expect(r.source).toBe(
    'struct Vec { int field_0; int field_1; int dot(Vec * a); };\n' +
      'int Vec::dot(Vec * a) {\n    return field_0 * a->field_0 + field_1 * a->field_1;\n}\n',
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
  const r = decompile('dot__3VecFP3Vec', VEC_DOT_ASM, PPC_MWCC, { backend: cppBackend(spec), onGap: 'annotate' });
  expect(r.source).toBe(
    'struct Vec { int x; int y; int dot(Vec * o); };\nint Vec::dot(Vec * o) {\n    return x * o->x + y * o->y;\n}\n',
  );
});

test('unmangled symbol: free-function spec from the lifted params', () => {
  const asm = readFileSync(join(import.meta.dirname, '../../../packages/core/test/corpus/ido-add1.asm'), 'utf8');
  const pass1 = decompile('add1', asm, MIPS_IDO, { onGap: 'annotate' });
  const spec = deriveSpec('add1', pass1.sfn);
  expect(spec).toEqual({
    method: 'add1',
    retType: { base: 'int', ptr: 0 },
    params: [{ name: 'a0', type: { base: 'int', ptr: 0 } }],
  });
  const r = decompile('add1', asm, MIPS_IDO, { backend: cppBackend(spec), onGap: 'annotate' });
  expect(r.source).toBe('int add1(int a0) {\n    return a0 + 1;\n}\n');
});

test('a sub-word receiver DECLINES auto-derivation instead of mis-mapping fields', () => {
  // `struct Vec { short x; short y; }` member read: lha at 0 and 2 — the all-int synthesis
  // would map field_1 to byte offset 4 (silently wrong C++).
  const asm =
    '00000000 <sum__3VecFv>:\n   0:\tlha     r4,0(r3)\n   4:\tlha     r0,2(r3)\n' +
    '   8:\tadd     r3,r4,r0\n   c:\tblr\n';
  const pass1 = decompile('sum__3VecFv', asm, PPC_MWCC, { onGap: 'annotate' });
  expect(() => deriveSpec('sum__3VecFv', pass1.sfn)).toThrow(/sub-word width/);
});

test('a demangle false-positive (plain C symbol shaped x__F<codes>) falls back to free-fn', () => {
  // `buf__Fill` demangles to buf(int, long, long) — but the lifted fn has ONE param, so the
  // arity cross-check rejects the fabricated signature.
  const asm = '00000000 <buf__Fill>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a0,1\n';
  const pass1 = decompile('buf__Fill', asm, MIPS_IDO, { onGap: 'annotate' });
  const spec = deriveSpec('buf__Fill', pass1.sfn);
  expect(spec.method).toBe('buf__Fill'); // kept as mangled-C, not renamed to "buf"
  expect(spec.cls).toBeUndefined();
  expect(spec.params).toHaveLength(1);
  const r = decompile('buf__Fill', asm, MIPS_IDO, { backend: cppBackend(spec), onGap: 'annotate' });
  expect(r.source).toBe('int buf__Fill(int a0) {\n    return a0 + 1;\n}\n');
});

test('demangle length-prefix overrun yields free-fn, never invalid C++', () => {
  const asm = '00000000 <map__Fill16>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a0,1\n';
  const pass1 = decompile('map__Fill16', asm, MIPS_IDO, { onGap: 'annotate' });
  const spec = deriveSpec('map__Fill16', pass1.sfn);
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
