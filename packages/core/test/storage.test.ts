// The L3 storage classifier (l3/storage.ts): `assign` spells a store to a local, a param and a
// bare scalar global identically, so the classification is stated once. What is pinned hardest is
// the SHADOWING asymmetry — the two global sets answer different questions and must not merge.
import { expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { SFn } from '../src/l3/ast';
import { addressableGlobals, calleeWritable, declaredGlobals, nameStorage } from '../src/l3/storage';

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

test('calleeWritable: private names, arrays, and everything else', () => {
  // the one answer to "can a callee or an aliasing store change this name's value with no `assign`"
  // that l3/reindex.ts's invariant addend and l3/unreduce.ts's moved init both read
  const f: SFn = {
    ...fn,
    locals: [...fn.locals, { name: 'k', type: T.s(32) }, { name: 'e', type: T.s(32) }],
    globals: [...fn.globals!, { name: 'gArr', type: T.array(T.u(16), 4) }],
    statics: [
      { name: 'sCount', type: T.s(32) },
      { name: 'sTab', type: T.array(T.u(8), 8) },
    ],
    body: [{ k: 'exprstmt', value: { k: 'call', fn: 'take', args: [{ k: 'addr', name: 'e' }] } }],
  };
  const w = calleeWritable(f);
  expect(w('a0')).toBe(false); // a param whose address is never taken
  expect(w('k')).toBe(false); // a local whose address is never taken
  expect(w('e')).toBe(true); // a local whose address escapes
  expect(w('g')).toBe(false); // the LOCAL shadowing global `g` binds the name
  expect(w('h')).toBe(true); // a scalar global
  expect(w('sCount')).toBe(true); // a non-array static, which no `nameStorage` class names
  expect(w('gArr')).toBe(false); // a global array: its name decays to a link-time address
  expect(w('sTab')).toBe(false); // so does a static array's
  expect(w('nowhere')).toBe(true); // unknown storage is not private storage
});
