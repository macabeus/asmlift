// The poll-shape products (l3/pollguard.ts): /pollguard regrows an EMPTY bottom-tested loop's
// guard, and /pollread folds a materialized poll's re-read back into its while condition. Both
// spellings of each pair evaluate their condition — and read their cell — the same number of
// times, so only bytes differ and the differ referees.
import { expect, test } from 'vitest';

import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { pollGuards, pollReads } from '../src/l3/pollguard';

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

// ── /pollread (same file): a materialized poll re-reads in its own condition ────────────────
const c = (value: number): Expr => ({ k: 'const', value });
const bin = (op: '&' | '!=', l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const deref2 = (base: Expr): Expr => ({ k: 'index', base, idx: c(2), width: 4, signed: true });
const assign = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const POLLV: Stmt[] = [
  assign('v4', deref2(v('p1'))),
  {
    k: 'while',
    cond: bin('!=', bin('&', v('v4'), c(0x80000000)), c(0)),
    body: [assign('v4', deref2(v('p1')))],
  },
];
const fnP = (body: Stmt[]): SFn => ({
  name: 'f',
  params: [],
  locals: [
    { name: 'v4', type: s32 },
    { name: 'p1', type: { kind: 'ptr', to: s32 }, pointeeVolatile: true },
  ],
  retType: s32,
  body,
});

test('a materialized poll re-spells with the read in its condition, temp and decl dropped', () => {
  const r = pollReads(fnP([...POLLV]));
  expect(r).not.toBeNull();
  expect(r!.body).toEqual([{ k: 'while', cond: bin('!=', bin('&', deref2(v('p1')), c(0x80000000)), c(0)), body: [] }]);
  expect(r!.locals.map((l) => l.name)).toEqual(['p1']);
});

test('refused: the variable is read after the loop (its last value is live)', () => {
  const r = pollReads(fnP([...POLLV, { k: 'return', value: v('v4') }]));
  expect(r).toBeNull();
});

test('refused: the condition reads the variable twice (per-iteration reads would double)', () => {
  const twice: Stmt[] = [
    assign('v4', deref2(v('p1'))),
    {
      k: 'while',
      cond: bin('!=', bin('&', v('v4'), v('v4')), c(0)),
      body: [assign('v4', deref2(v('p1')))],
    },
  ];
  expect(pollReads(fnP(twice))).toBeNull();
});

test('refused: the body re-read differs from the pre-read', () => {
  const diff: Stmt[] = [
    assign('v4', deref2(v('p1'))),
    {
      k: 'while',
      cond: bin('!=', bin('&', v('v4'), c(0x80000000)), c(0)),
      body: [assign('v4', c(0))],
    },
  ];
  expect(pollReads(fnP(diff))).toBeNull();
});

test('refused: a name the function does not own — a global poll would delete observable stores', () => {
  const g: Stmt[] = [
    assign('gState', deref2(v('p1'))),
    {
      k: 'while',
      cond: bin('!=', bin('&', v('gState'), c(1)), c(0)),
      body: [assign('gState', deref2(v('p1')))],
    },
  ];
  expect(pollReads(fnP(g))).toBeNull();
});

test('refused: an address-taken temp — &v4 elsewhere counts as an occurrence', () => {
  const taken: Stmt[] = [
    ...POLLV,
    { k: 'exprstmt', value: { k: 'call', fn: 'DmaSet', args: [{ k: 'addr', name: 'v4' }] } },
  ];
  expect(pollReads(fnP(taken))).toBeNull();
});

test('refused: an effectful condition beside the polled variable', () => {
  const eff: Stmt[] = [
    assign('v4', deref2(v('p1'))),
    {
      k: 'while',
      cond: bin('!=', { k: 'call', fn: 'f', args: [] }, v('v4')),
      body: [assign('v4', deref2(v('p1')))],
    },
  ];
  expect(pollReads(fnP(eff))).toBeNull();
});

test('refused: the condition holds &v4, not a read — an addr cannot be substituted', () => {
  const viaAddr: Stmt[] = [
    assign('v4', deref2(v('p1'))),
    {
      k: 'while',
      cond: bin('!=', { k: 'addr', name: 'v4' }, c(0)),
      body: [assign('v4', deref2(v('p1')))],
    },
  ];
  expect(pollReads(fnP(viaAddr))).toBeNull();
});

test('refused: a volatile-rooted deref beside the variable — the fold would unsequence two observable reads', () => {
  const twoVol: Stmt[] = [
    assign('v4', deref2(v('p1'))),
    {
      k: 'while',
      cond: bin('!=', bin('&', v('v4'), { k: 'index', base: v('p2'), idx: c(0), width: 4, signed: true }), c(0)),
      body: [assign('v4', deref2(v('p1')))],
    },
  ];
  const f: SFn = {
    name: 'f',
    params: [],
    locals: [
      { name: 'v4', type: s32 },
      { name: 'p1', type: { kind: 'ptr', to: s32 }, pointeeVolatile: true },
      { name: 'p2', type: { kind: 'ptr', to: s32 }, pointeeVolatile: true },
    ],
    retType: s32,
    body: twoVol,
  };
  expect(pollReads(f)).toBeNull();
});

test('refused: a param temp — the declaration to drop is not a local', () => {
  const f: SFn = {
    name: 'f',
    params: [{ name: 'a0', type: s32 }],
    locals: [{ name: 'p1', type: { kind: 'ptr', to: s32 }, pointeeVolatile: true }],
    retType: s32,
    body: [
      assign('a0', deref2(v('p1'))),
      {
        k: 'while',
        cond: bin('!=', bin('&', v('a0'), c(1)), c(0)),
        body: [assign('a0', deref2(v('p1')))],
      },
    ],
  };
  expect(pollReads(f)).toBeNull();
});
