// The `/ptr-field` variation (l3/ptrfield.ts): a recovered word field is re-declared `void *` and cast
// back at each read. What these tests pin is that the two places a struct type lives — inline in
// each `(struct S *)` cast and again in `SFn.structs`, which is what a backend prints — stay in
// step, and that every field the ACCESS EVIDENCE does not support a pointer for declines.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { type IrType, T } from '../src/ir/types';
import { type Expr, type SFn, type Stmt } from '../src/l3/ast';
import { pointerFields } from '../src/l3/ptrfield';

/** raise/structs.ts's own recovery on synthetic:dmaptrsrc: a 4-byte pad, then a word field */
const elem = (fieldType: IrType = T.s(32), name = 'field_4'): Extract<IrType, { kind: 'struct' }> => ({
  kind: 'struct',
  name: 'Elem0',
  fields: [
    { off: 0, type: T.array(T.u(8), 4), name: '_pad0' },
    { off: 4, type: fieldType, name },
  ],
  size: 8,
});

/** `((struct Elem0 *)50345008)[a1].field_4` */
const access = (st: Extract<IrType, { kind: 'struct' }>, name = 'field_4'): Expr => ({
  k: 'field',
  name,
  base: {
    k: 'index',
    base: { k: 'cast', to: T.ptr(st), e: { k: 'const', value: 50345008 } },
    idx: { k: 'var', name: 'a1' },
    width: 8,
    signed: true,
  },
});

const fn = (st: Extract<IrType, { kind: 'struct' }>, body: Stmt[]): SFn => ({
  name: 'f',
  params: [{ name: 'a1', type: T.s(32) }],
  locals: [{ name: 'v', type: T.s(32) }],
  retType: T.void(),
  body,
  structs: [{ name: st.name, fields: st.fields, size: st.size }],
});

test('a word field read in arithmetic is re-declared a pointer and cast back at the read', () => {
  const st = elem();
  const s = fn(st, [{ k: 'assign', name: 'v', value: access(st) }]);
  const out = pointerFields(s);
  const src = cBackend.emit(out!);
  // the DECLARATION and the expression's own inline type agree
  expect(src).toContain('struct Elem0 { u8 _pad0[4]; void *field_4; };');
  expect(src).toContain('v = (s32)((struct Elem0 *)50345008)[a1].field_4;');
  // read-only: the input tree is not mutated
  expect(cBackend.emit(s)).toContain('struct Elem0 { u8 _pad0[4]; s32 field_4; };');
});

test('a halfword field declines', () => {
  const st = elem(T.u(16), 'field_4');
  expect(pointerFields(fn(st, [{ k: 'assign', name: 'v', value: access(st) }]))).toBeNull();
});

test('a field the tree stores through declines', () => {
  const st = elem();
  const s = fn(st, [{ k: 'store', lval: access(st), value: { k: 'const', value: 0 } }]);
  expect(pointerFields(s)).toBeNull();
});

test('a field standing as an access base declines', () => {
  const st = elem();
  const s = fn(st, [
    {
      k: 'assign',
      name: 'v',
      value: { k: 'index', base: access(st), idx: { k: 'const', value: 0 }, width: 4, signed: true },
    },
  ]);
  expect(pointerFields(s)).toBeNull();
});

test('a pad the function never touches is left alone', () => {
  // only `field_4` is read, so `_pad0` is never a candidate — and it is not a word anyway
  const st = elem();
  const out = pointerFields(fn(st, [{ k: 'assign', name: 'v', value: access(st) }]));
  expect(out!.structs![0].fields[0].type).toEqual(T.array(T.u(8), 4));
});

test('a tree with no recovered struct declines', () => {
  const s: SFn = {
    name: 'f',
    params: [],
    locals: [{ name: 'v', type: T.s(32) }],
    retType: T.void(),
    body: [{ k: 'assign', name: 'v', value: { k: 'const', value: 0 } }],
  };
  expect(pointerFields(s)).toBeNull();
});

test('two structs carrying the same field name are decided apart', () => {
  const ok = elem();
  const written: Extract<IrType, { kind: 'struct' }> = { ...elem(), name: 'Elem1' };
  const s: SFn = {
    name: 'f',
    params: [{ name: 'a1', type: T.s(32) }],
    locals: [{ name: 'v', type: T.s(32) }],
    retType: T.void(),
    structs: [
      { name: ok.name, fields: ok.fields, size: ok.size },
      { name: written.name, fields: written.fields, size: written.size },
    ],
    body: [
      { k: 'assign', name: 'v', value: access(ok) },
      { k: 'store', lval: access(written), value: { k: 'const', value: 0 } },
    ],
  };
  const out = pointerFields(s)!;
  expect(out.structs!.find((x) => x.name === 'Elem0')!.fields[1].type).toEqual(T.ptr(T.void()));
  expect(out.structs!.find((x) => x.name === 'Elem1')!.fields[1].type).toEqual(T.s(32));
});

test('a read nested inside a loop is cast back exactly once', () => {
  const st = elem();
  const s = fn(st, [
    {
      k: 'while',
      cond: { k: 'const', value: 1 },
      body: [
        {
          k: 'if',
          cond: { k: 'const', value: 1 },
          then: [{ k: 'assign', name: 'v', value: access(st) }],
          else: [],
        },
      ],
    },
  ]);
  const src = cBackend.emit(pointerFields(s)!);
  expect(src).toContain('v = (s32)((struct Elem0 *)50345008)[a1].field_4;');
  expect(src).not.toContain('(s32)(s32)');
});

// A FIELD SELECTED OUT OF A LOCAL ARRAY's bytes is one the frame audit typed: it licenses a wider
// runtime index into `u8 sp0[n]` only while every access of one width is one integer type, and a
// pointer is an alias set of its own in agbcc — a read of it is reused past an `int` store to the
// same bytes (frame-base-copy.test.ts, the element-struct fan test). Reached directly, or through
// a local the bytes' address was copied into.
test('a field selected out of a local array declines', () => {
  const st = elem();
  const overBytes = (base: Expr, extra: Stmt[] = [], locals: SFn['locals'] = []): SFn => ({
    ...fn(st, [
      ...extra,
      {
        k: 'assign',
        name: 'v',
        value: {
          k: 'field',
          name: 'field_4',
          base: {
            k: 'index',
            base: { k: 'cast', to: T.ptr(st), e: base },
            idx: { k: 'var', name: 'a1' },
            width: 8,
            signed: true,
          },
        },
      },
    ]),
    locals: [{ name: 'v', type: T.s(32) }, { name: 'sp0', type: T.array(T.u(8), 16) }, ...locals],
  });
  expect(pointerFields(overBytes({ k: 'var', name: 'sp0' }))).toBeNull();
  expect(
    pointerFields(
      overBytes(
        { k: 'var', name: 'p0' },
        [{ k: 'assign', name: 'p0', value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'var', name: 'sp0' } } }],
        [{ name: 'p0', type: T.ptr(T.s(32)) }],
      ),
    ),
  ).toBeNull();
  // …while a pointer local that never held the bytes' address stays admitted
  expect(
    pointerFields(
      overBytes(
        { k: 'var', name: 'p0' },
        [{ k: 'assign', name: 'p0', value: { k: 'var', name: 'a1' } }],
        [{ name: 'p0', type: T.ptr(T.s(32)) }],
      ),
    ),
  ).not.toBeNull();
});
