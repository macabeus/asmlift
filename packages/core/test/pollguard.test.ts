// The /pollguard shape product (l3/pollguard.ts): an EMPTY bottom-tested loop regrows its own
// guard — the two forms compile to the same instructions, differing only in the allocation
// ripple of the guard's extra source-level read; the differ referees.
import { expect, test } from 'vitest';

import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { pollGuards } from '../src/l3/pollguard';

const s32 = { kind: 'int', width: 32, signed: true } as const;
const v = (name: string): Expr => ({ k: 'var', name });
const fn = (body: Stmt[]): SFn => ({ name: 'f', params: [{ name: 'a0', type: s32 }], locals: [], retType: s32, body });

test('an empty do-while regrows its guard', () => {
  const dw: Stmt = { k: 'dowhile', cond: v('a0'), body: [] };
  const r = pollGuards(fn([dw]));
  expect(r).not.toBeNull();
  expect(r!.body[0]).toEqual({ k: 'if', cond: v('a0'), then: [dw], else: [] });
});

test('a non-empty do-while keeps its shape', () => {
  const dw: Stmt = { k: 'dowhile', cond: v('a0'), body: [{ k: 'assign', name: 'x', value: v('a0') }] };
  expect(pollGuards(fn([dw]))).toBeNull();
});

test('nested inside a loop, the wrap still lands in place', () => {
  const dw: Stmt = { k: 'dowhile', cond: v('a0'), body: [] };
  const outer: Stmt = { k: 'while', cond: v('a0'), body: [dw] };
  const r = pollGuards(fn([outer]));
  const w = r!.body[0] as Extract<Stmt, { k: 'while' }>;
  expect(w.body[0].k).toBe('if');
});
