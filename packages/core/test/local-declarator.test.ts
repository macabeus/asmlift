// A declaration is a C DECLARATOR, not a type followed by a name: an array puts its extents
// after the name and a pointer binds its `*` to the declarator. `cType` spells a type where no
// declarator is involved (a cast, a return type) and marks its array arm ill-formed as a prefix.
// Every declaration position in the C backend — the local list, the struct fields and the
// parameter list — goes through `cDeclare`, so one function cannot spell its pointers two ways.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import { type Expr, type SFn } from '../src/l3/ast';

const emit = (locals: SFn['locals']): string =>
  cBackend.emit({ name: 'f', params: [{ name: 'a0', type: T.ptr(T.u(8)) }], locals, retType: T.void(), body: [] });

test('an array local declares its extent after the name', () => {
  expect(emit([{ name: 'sp0', type: T.array(T.u(8), 16) }])).toContain('    u8 sp0[16];');
});

test('a nested array local spells every extent after the name, in declaration order', () => {
  expect(emit([{ name: 'sp0', type: T.array(T.array(T.u(8), 8), 6) }])).toContain('    u8 sp0[6][8];');
});

test('a pointer local binds its star to the declarator', () => {
  expect(emit([{ name: 'p', type: T.ptr(T.u(16)) }])).toContain('    u16 *p;');
});

test('a scalar local is unchanged by the declarator rules', () => {
  expect(emit([{ name: 'v0', type: T.s(32) }])).toContain('    s32 v0;');
});

test('either volatility fact still renders at the prefix, where C reads it', () => {
  // on the object for a scalar, on the POINTEE for a pointer declarator — the same split the
  // SFn.locals doc draws, and the reason the qualifier is not routed through the declarator.
  expect(emit([{ name: 'v0', type: T.s(32), volatile: true }])).toContain('    volatile s32 v0;');
  expect(emit([{ name: 'p', type: T.ptr(T.u(16)), pointeeVolatile: true }])).toContain('    volatile u16 *p;');
});

test('a struct local declares as the plain prefix form', () => {
  expect(emit([{ name: 'sp0', type: T.struct('Blob', []) }])).toContain('    struct Blob sp0;');
});

test('a pointer PARAMETER binds its star the same way a local does', () => {
  // the two positions in one signature: routing only the locals through the declarator would
  // spell one function's pointers two ways (`u16 * a0` over `u16 *p`)
  const out = cBackend.emit({
    name: 'f',
    params: [
      { name: 'a0', type: T.ptr(T.u(16)) },
      { name: 'a1', type: T.s(32) },
    ],
    locals: [{ name: 'p', type: T.ptr(T.u(16)) }],
    retType: T.void(),
    body: [],
  });
  expect(out).toContain('void f(u16 *a0, s32 a1)');
  expect(out).toContain('    u16 *p;');
});

test('a parameter list with no parameters is still `void`', () => {
  expect(cBackend.emit({ name: 'f', params: [], locals: [], retType: T.void(), body: [] })).toContain('f(void)');
});

// AND THE DECLARATION DECIDES HOW AN ADDRESS IS SPELLED. `&` on an array yields a pointer to the
// WHOLE array — `u8 (*)[16]`, which every typed pointer parameter rejects — where the bare name is
// the element pointer the machine produced. That is C declarator grammar rather than anything
// about the address, so the printer reads it off the name's declared type and the L3 node carries
// nothing about it. It covers a GLOBAL of array shape for the same reason it covers a local.
const callWith = (arg: Expr): SFn['body'] => [{ k: 'exprstmt', value: { k: 'call', fn: 'fill', args: [arg] } }];

test('an array local`s address is its bare name', () => {
  const out = cBackend.emit({
    name: 'f',
    params: [],
    locals: [{ name: 'sp0', type: T.array(T.u(8), 16) }],
    retType: T.void(),
    body: callWith({ k: 'addr', name: 'sp0' }),
  });
  expect(out).toContain('fill(sp0);');
});

test('a scalar local`s address keeps the `&`, and so does a name nothing declares', () => {
  const out = cBackend.emit({
    name: 'f',
    params: [],
    locals: [{ name: 'sp0', type: T.s(32) }],
    retType: T.void(),
    body: [...callWith({ k: 'addr', name: 'sp0' }), ...callWith({ k: 'addr', name: 'gUndeclared' })],
  });
  expect(out).toContain('fill(&sp0);');
  expect(out).toContain('fill(&gUndeclared);');
});

test('an array GLOBAL of known shape decays exactly as a local does', () => {
  const out = cBackend.emit({
    name: 'f',
    params: [],
    locals: [],
    globals: [{ name: 'gQueue', type: T.array(T.u(8), 64) }],
    retType: T.void(),
    body: callWith({ k: 'addr', name: 'gQueue' }),
  });
  expect(out).toContain('fill(gQueue);');
});
