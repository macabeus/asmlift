// The `/volatile` lever (l3/volatileptr.ts): a pointer local assigned a numeric address is
// re-declared as pointing to volatile data. The gate conditions are what these tests pin: only
// numeric addresses (a symbol-fed pointer keeps the map's declaration truth), and no qualifying
// local means DECLINE — never a duplicate candidate.
import { expect, test } from 'vitest';

import { T } from '../src/ir/types';
import { type SFn, type Stmt } from '../src/l3/ast';
import { volatilePtrLocals } from '../src/l3/volatileptr';

const fn = (locals: SFn['locals'], body: Stmt[]): SFn => ({
  name: 'f',
  params: [],
  locals,
  retType: T.void_,
  body,
});

test('a pointer local assigned a numeric address becomes pointer-to-volatile', () => {
  const s = fn(
    [
      { name: 'p', type: T.ptr(T.u(16)) },
      { name: 'n', type: T.s(32) },
    ],
    [
      { k: 'assign', name: 'p', value: { k: 'cast', to: T.ptr(T.u(16)), e: { k: 'const', value: 0x3000010 } } },
      { k: 'assign', name: 'n', value: { k: 'const', value: 0 } },
    ],
  );
  const out = volatilePtrLocals(s);
  expect(out?.locals.find((l) => l.name === 'p')?.volatile).toBe(true);
  // the integer local is untouched even though it is const-assigned
  expect(out?.locals.find((l) => l.name === 'n')?.volatile).toBeUndefined();
  // read-only: the input tree is not mutated
  expect(s.locals.find((l) => l.name === 'p')?.volatile).toBeUndefined();
});

test('an assignment nested in a loop arm still qualifies', () => {
  const s = fn(
    [{ name: 'p', type: T.ptr(T.u(8)) }],
    [
      {
        k: 'dowhile',
        cond: { k: 'const', value: 1 },
        body: [{ k: 'assign', name: 'p', value: { k: 'const', value: 0x4000000 } }],
      },
    ],
  );
  expect(volatilePtrLocals(s)?.locals[0].volatile).toBe(true);
});

test('a symbol-fed pointer local is excluded — the map owns that declaration', () => {
  const s = fn(
    [{ name: 'p', type: T.ptr(T.u(16)) }],
    [{ k: 'assign', name: 'p', value: { k: 'addr', name: 'gBgInfo' } }],
  );
  expect(volatilePtrLocals(s)).toBeNull();
});

test('no qualifying local declines rather than duplicating the primary', () => {
  const s = fn([{ name: 'n', type: T.s(32) }], [{ k: 'assign', name: 'n', value: { k: 'const', value: 3 } }]);
  expect(volatilePtrLocals(s)).toBeNull();
});
