// The /parkfirst lever (l3/parkfirst.ts): incoming-argument parks move to the head of the entry
// straight-line prefix. The park's `mov` lifts to pure SSA aliasing — no op, no position — so
// the default order is emission's, and this lever emits the park-first sibling for the differ.
import { expect, test } from 'vitest';

import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { parkParamsFirst } from '../src/l3/parkfirst';

const s32 = { kind: 'int', width: 32, signed: true } as const;
const assign = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const v = (name: string) => ({ k: 'var' as const, name });
const deref = (base: string, idx: number) => ({
  k: 'index' as const,
  base: v(base),
  idx: { k: 'const' as const, value: idx },
  width: 1,
  signed: false,
});
const fn = (body: Stmt[]): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: s32 },
    { name: 'a1', type: s32 },
  ],
  locals: [],
  retType: s32,
  body,
});

test('a param copy moves above a memory-read assign (the hipress counter park)', () => {
  const r = parkParamsFirst(fn([assign('v0', deref('a0', 1)), assign('v8', v('a1')), assign('v1', deref('a0', 2))]));
  expect(r).not.toBeNull();
  expect(r!.body.map((s) => (s as { name: string }).name)).toEqual(['v8', 'v0', 'v1']);
});

test('refused: a crossed statement writes the param the park reads', () => {
  const r = parkParamsFirst(fn([assign('a1', deref('a0', 1)), assign('v8', v('a1'))]));
  expect(r).toBeNull();
});

test('declined: an RHS reading a non-param is not a park', () => {
  const r = parkParamsFirst(fn([assign('v0', deref('a0', 1)), assign('v8', v('v0'))]));
  expect(r).toBeNull();
});

test('declined when the parks already lead the prefix (no duplicate candidate)', () => {
  const r = parkParamsFirst(fn([assign('v8', v('a1')), assign('v0', deref('a0', 1))]));
  expect(r).toBeNull();
});

test('the prefix ends at the first non-assign: a park after it stays put', () => {
  const ifStmt: Stmt = { k: 'if', cond: v('a0'), then: [], else: [] };
  const r = parkParamsFirst(fn([assign('v0', deref('a0', 1)), ifStmt, assign('v8', v('a1'))]));
  expect(r).toBeNull();
});
