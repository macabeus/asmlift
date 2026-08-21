// The `/volatile` lever (l3/volatileptr.ts): a pointer local assigned a numeric address is
// re-declared as pointing to volatile data. The gate conditions are what these tests pin:
// nonzero numeric addresses only (0 is NULL), a symbol feed vetoes — bare `&gSym`, an interior
// address, or a copy of a vetoed local alike — and no qualifying local means DECLINE, never a
// duplicate candidate.
import { expect, test } from 'vitest';

import { T } from '../src/ir/types';
import { type SFn, type Stmt } from '../src/l3/ast';
import { volatilePtrLocals, volatileSubsetCandidates } from '../src/l3/volatileptr';

const fn = (locals: SFn['locals'], body: Stmt[]): SFn => ({
  name: 'f',
  params: [],
  locals,
  retType: T.void(),
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
  expect(out?.locals.find((l) => l.name === 'p')?.pointeeVolatile).toBe(true);
  // the integer local is untouched even though it is const-assigned
  expect(out?.locals.find((l) => l.name === 'n')?.pointeeVolatile).toBeUndefined();
  // read-only: the input tree is not mutated
  expect(s.locals.find((l) => l.name === 'p')?.pointeeVolatile).toBeUndefined();
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
  expect(volatilePtrLocals(s)?.locals[0].pointeeVolatile).toBe(true);
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

test('NULL and zero sentinels never qualify — 0 is not an address', () => {
  const s = fn(
    [{ name: 'p', type: T.ptr(T.u(16)) }],
    [{ k: 'assign', name: 'p', value: { k: 'cast', to: T.ptr(T.u(16)), e: { k: 'const', value: 0 } } }],
  );
  expect(volatilePtrLocals(s)).toBeNull();
});

test('an addr assignment anywhere VETOES a local that also sees a numeric address', () => {
  const s = fn(
    [{ name: 'p', type: T.ptr(T.u(16)) }],
    [
      { k: 'assign', name: 'p', value: { k: 'const', value: 0x3000010 } },
      {
        k: 'if',
        cond: { k: 'var', name: 'p' },
        then: [{ k: 'assign', name: 'p', value: { k: 'addr', name: 'gBuf' } }],
        else: [],
      },
    ],
  );
  expect(volatilePtrLocals(s)).toBeNull();
});

test('an interior global address — addr under arithmetic — vetoes, not only a bare addr', () => {
  const s = fn(
    [{ name: 'p', type: T.ptr(T.u(16)) }],
    [
      { k: 'assign', name: 'p', value: { k: 'const', value: 0x3000010 } },
      {
        k: 'assign',
        name: 'p',
        value: {
          k: 'cast',
          to: T.ptr(T.u(16)),
          e: {
            k: 'bin',
            op: '+',
            l: { k: 'cast', to: T.u(32), e: { k: 'addr', name: 'gBuf' } },
            r: { k: 'const', value: 8 },
          },
        },
      },
    ],
  );
  expect(volatilePtrLocals(s)).toBeNull();
});

test('the veto propagates through local copies to a fixpoint', () => {
  const s = fn(
    [
      { name: 'q', type: T.ptr(T.u(16)) },
      { name: 'p', type: T.ptr(T.u(16)) },
    ],
    [
      { k: 'assign', name: 'q', value: { k: 'addr', name: 'gBuf' } },
      { k: 'assign', name: 'p', value: { k: 'var', name: 'q' } },
      { k: 'assign', name: 'p', value: { k: 'const', value: 0x3000010 } },
    ],
  );
  expect(volatilePtrLocals(s)).toBeNull();
});

test('`only` narrows the lever: a qualifying local outside the set is not marked, and an empty yield declines', () => {
  const s = fn(
    [
      { name: 'p', type: T.ptr(T.u(16)) },
      { name: 'q', type: T.ptr(T.u(16)) },
    ],
    [
      { k: 'assign', name: 'p', value: { k: 'const', value: 0x4000000 } },
      { k: 'assign', name: 'q', value: { k: 'const', value: 0x4000010 } },
    ],
  );
  const out = volatilePtrLocals(s, new Set(['q']));
  expect(out?.locals.find((l) => l.name === 'q')?.pointeeVolatile).toBe(true);
  expect(out?.locals.find((l) => l.name === 'p')?.pointeeVolatile).toBeUndefined();
  expect(volatilePtrLocals(s, new Set(['nosuch']))).toBeNull();
});

// ── the per-local SUBSET candidates ─────────────────────────────────────────────────────────
const twoPtrs: SFn['locals'] = [
  { name: 'p0', type: T.ptr(T.u(16)) },
  { name: 'p1', type: T.ptr(T.s(32)) },
];
const init = (name: string, addr: number): Stmt => ({
  k: 'assign',
  name,
  value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'const', value: addr } },
});

test('two qualifying locals yield the two proper subsets, labeled by member', () => {
  const cands = volatileSubsetCandidates(fn(twoPtrs, [init('p0', 0x3001048), init('p1', 0x40000d4)]));
  expect(cands.map((c) => c.merged).sort()).toEqual(['p0', 'p1']);
  const p1only = cands.find((c) => c.merged === 'p1')!.sfn;
  expect(p1only.locals.find((l) => l.name === 'p1')!.pointeeVolatile).toBe(true);
  expect(p1only.locals.find((l) => l.name === 'p0')!.pointeeVolatile).toBeUndefined();
});

test('one qualifying local yields no subsets — the plain lever already is that candidate', () => {
  expect(volatileSubsetCandidates(fn(twoPtrs, [init('p1', 0x40000d4)]))).toEqual([]);
});

test('above three qualifiers the arm caps out empty', () => {
  const four: SFn['locals'] = [0, 1, 2, 3].map((i) => ({ name: `p${i}`, type: T.ptr(T.s(32)) }));
  const inits = [0, 1, 2, 3].map((i) => init(`p${i}`, 0x4000000 + i * 4));
  expect(volatileSubsetCandidates(fn(four, inits))).toEqual([]);
});
