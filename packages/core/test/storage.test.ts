// The L3 storage classifier (l3/storage.ts): `assign` spells a store to a local, a param and a
// bare scalar global identically, so the classification is stated once. What is pinned hardest is
// the SHADOWING asymmetry — the two global sets answer different questions and must not merge.
import { expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { SFn } from '../src/l3/ast';
import { addressableGlobals, declaredGlobals, nameStorage } from '../src/l3/storage';

const fn: SFn = {
  name: 'f',
  retType: T.void(),
  params: [{ name: 'a0', type: T.s(32) }],
  locals: [{ name: 'g', type: T.ptr(T.u(8)) }],
  globals: [
    { name: 'g', type: T.ptr(T.u(8)) },
    { name: 'h', type: T.ptr(T.u(8)) },
  ],
  body: [],
};

test('a local SHADOWS a same-named global — that is what the name binds to', () => {
  expect(nameStorage(fn).get('g')).toBe('local');
  expect(nameStorage(fn).get('h')).toBe('global');
  expect(nameStorage(fn).get('a0')).toBe('param');
  expect(nameStorage(fn).get('nowhere')).toBeUndefined();
});

test('the two global sets differ exactly on the shadowed name', () => {
  // verbatim spellings keep it (`(u8 *)g` denotes what the access denoted); address spellings
  // drop it (`&g` would name the LOCAL's storage)
  expect([...declaredGlobals(fn)].sort()).toEqual(['g', 'h']);
  expect([...addressableGlobals(fn)].sort()).toEqual(['h']);
});
