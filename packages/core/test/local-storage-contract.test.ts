// UNIT tests for the respell-variation boundary contract `assertLocalStorageStaysInteger`
// (contracts.ts): a variation must not re-type an access to a local object's bytes as anything
// but an integer. The frame audit licenses a runtime index wider than a byte only while every
// access is one integer type (frontend/frame-objects.ts `indexedWidth`); a pointer is an alias set
// of its own in agbcc, which reads it stale past an integer store to the same bytes.
import { describe, expect, test } from 'vitest';

import { ContractError, assertFrameUnionsViewed, assertLocalStorageStaysInteger } from '../src/contracts';
import { type IrType, T } from '../src/ir/types';
import { type Expr, type SFn } from '../src/l3/ast';

const elem = (field: IrType): Extract<IrType, { kind: 'struct' }> => ({
  kind: 'struct',
  name: 'Elem0',
  fields: [
    { off: 0, type: T.s(32), name: 'field_0' },
    { off: 4, type: field, name: 'field_4' },
  ],
  size: 8,
});

/** `v = ((struct Elem0 *)<over>)[a1].field_4;` beside `((s32 *)sp0)[a1] = 0;`, with `p0 = (s32 *)sp0` */
const tree = (field: IrType, over: Expr): SFn => {
  const st = elem(field);
  return {
    name: 'f',
    params: [{ name: 'a1', type: T.s(32) }],
    locals: [
      { name: 'v', type: T.s(32) },
      { name: 'p0', type: T.ptr(T.s(32)) },
      { name: 'sp0', type: T.array(T.u(8), 16) },
    ],
    retType: T.void(),
    body: [
      { k: 'assign', name: 'p0', value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'var', name: 'sp0' } } },
      {
        k: 'store',
        lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: { k: 'var', name: 'a1' }, width: 4, signed: true },
        value: { k: 'const', value: 0 },
      },
      {
        k: 'assign',
        name: 'v',
        value: {
          k: 'field',
          name: 'field_4',
          base: {
            k: 'index',
            base: { k: 'cast', to: T.ptr(st), e: over },
            idx: { k: 'var', name: 'a1' },
            width: 8,
            signed: true,
          },
        },
      },
    ],
    structs: [{ name: st.name, fields: st.fields, size: st.size }],
  };
};

const sp0: Expr = { k: 'var', name: 'sp0' };
const p0: Expr = { k: 'var', name: 'p0' };

describe('what assertLocalStorageStaysInteger refuses', () => {
  test('an element-struct field over the bytes re-typed a pointer', () => {
    expect(() => assertLocalStorageStaysInteger(tree(T.s(32), sp0), tree(T.ptr(T.void()), sp0))).toThrow(ContractError);
    expect(() => assertLocalStorageStaysInteger(tree(T.s(32), sp0), tree(T.ptr(T.void()), sp0))).toThrow(/void\*/);
  });

  test('the same, reached through a local the bytes’ address was copied into', () => {
    expect(() => assertLocalStorageStaysInteger(tree(T.s(32), p0), tree(T.ptr(T.void()), p0))).toThrow(ContractError);
  });
});

describe('what assertLocalStorageStaysInteger leaves alone', () => {
  test('an integer re-typing, and the identity', () => {
    expect(() => assertLocalStorageStaysInteger(tree(T.s(32), sp0), tree(T.u(32), sp0))).not.toThrow();
    expect(() => assertLocalStorageStaysInteger(tree(T.s(32), sp0), tree(T.s(32), sp0))).not.toThrow();
  });

  test('a pointer field over memory that is not the frame', () => {
    const rom: Expr = { k: 'const', value: 0x08001000 };
    expect(() => assertLocalStorageStaysInteger(tree(T.s(32), rom), tree(T.ptr(T.void()), rom))).not.toThrow();
  });

  // a DIFFERENTIAL: a type the tree it derives from already read the bytes at is the source's own
  test('a pointer the tree it derives from already read the bytes at', () => {
    expect(() => assertLocalStorageStaysInteger(tree(T.ptr(T.void()), sp0), tree(T.ptr(T.void()), sp0))).not.toThrow();
  });
});

// A FRAME UNION (frontend/frame-objects.ts `unionViews`) is alias-safe only while every access is a
// member access: `assertFrameUnionsViewed`, which rank.ts runs on every respelled tree beside
// `assertLocalStorageStaysInteger`. Compiled, agbcc returns a stale `mov r0, #0x1` for `*u.half = 1; u.word[0] = x;
// return *u.half;` and for the cast twin, and reloads for `u.half[0]`.
describe('a frame union is accessed only through its views', () => {
  const U: IrType = {
    kind: 'union',
    members: [
      { off: 0, type: T.array(T.s(32), 1), name: 'word' },
      { off: 0, type: T.array(T.u(16), 2), name: 'half' },
    ],
    size: 4,
  };
  const half = (sub: boolean): Expr => ({
    k: 'index',
    base: { k: 'field', base: { k: 'var', name: 'sp0' }, name: 'half', dot: true },
    idx: { k: 'const', value: 0 },
    width: 2,
    signed: false,
    ...(sub ? { subscript: true as const } : {}),
  });
  const withRead = (read: Expr, extra: SFn['body'] = [], locals: SFn['locals'] = []): SFn => ({
    name: 'f',
    params: [{ name: 'a0', type: T.s(32) }],
    locals: [{ name: 'sp0', type: U }, ...locals],
    retType: T.s(32),
    body: [
      {
        k: 'exprstmt',
        value: { k: 'call', fn: 'fill', args: [{ k: 'addr', name: 'sp0' }] },
      },
      ...extra,
      { k: 'return', value: read },
    ],
  });
  const viewed = withRead(half(true));

  test('a subscripted view, and the address handed on as a value, pass', () => {
    expect(() => assertFrameUnionsViewed(viewed)).not.toThrow();
  });

  test('element 0 dereferenced through the view`s decay is refused', () => {
    expect(() => assertFrameUnionsViewed(withRead(half(false)))).toThrow(/dereferences a view of a frame union/);
  });

  test('an access through a pointer to its bytes is refused, directly or through a local', () => {
    const cast: Expr = {
      k: 'index',
      base: { k: 'cast', to: T.ptr(T.u(16)), e: { k: 'addr', name: 'sp0' } },
      idx: { k: 'const', value: 0 },
      width: 2,
      signed: false,
    };
    expect(() => assertFrameUnionsViewed(withRead(cast))).toThrow(ContractError);
    const p: Expr = {
      k: 'index',
      base: { k: 'var', name: 'p0' },
      idx: { k: 'const', value: 1 },
      width: 2,
      signed: false,
    };
    const held = withRead(
      p,
      [{ k: 'assign', name: 'p0', value: { k: 'cast', to: T.ptr(T.u(16)), e: { k: 'addr', name: 'sp0' } } }],
      [{ name: 'p0', type: T.ptr(T.u(16)) }],
    );
    expect(() => assertFrameUnionsViewed(held)).toThrow(/through a pointer to its bytes/);
  });
});
