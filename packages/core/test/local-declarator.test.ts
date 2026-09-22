// A local declaration is a C DECLARATOR, not a type followed by a name: an array puts its
// extents after the name and a pointer binds its `*` to the declarator. `cType` spells a type
// where no declarator is involved (a cast, a return type) and marks its array arm ill-formed as
// a prefix — the local list is the one printing position that can reach that arm, because an
// array-typed local is the storage-extent recovery and an array-typed PARAMETER has no C syntax.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import { type SFn } from '../src/l3/ast';

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
