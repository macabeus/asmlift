import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { sinkInitsToFirstUse } from '../src/l3/sinkinit';

const U8P = T.ptr(T.int(8, false));
const c = (value: number): Expr => ({ k: 'const', value });
const init = (name: string, addr: number): Stmt => ({ k: 'assign', name, value: { k: 'cast', to: U8P, e: c(addr) } });
const read = (name: string, i: number): Stmt => ({
  k: 'store',
  lval: { k: 'index', base: { k: 'var', name: 'a0' }, idx: c(i), width: 4, signed: true },
  value: { k: 'index', base: { k: 'var', name }, idx: c(i), width: 1, signed: false },
});
const plain = (): Stmt => ({
  k: 'store',
  lval: { k: 'index', base: { k: 'var', name: 'a0' }, idx: c(0), width: 4, signed: true },
  value: c(1),
});
const fn = (body: Stmt[], locals: SFn['locals'] = [{ name: 'p0', type: U8P }]): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: T.ptr(T.s(32)) }],
  locals,
  retType: T.void(),
  body,
});

describe('sinking a leading base init to its first use', () => {
  test('an init whose first use is two statements down moves to sit immediately above it', () => {
    const out = sinkInitsToFirstUse(fn([init('p0', 0x3001100), plain(), plain(), read('p0', 2)]));
    expect(out?.body.map((s) => s.k)).toEqual(['store', 'store', 'assign', 'store']);
    expect(out?.body[2]).toEqual(init('p0', 0x3001100));
  });

  test('an init already sitting above its first use declines: nothing to move', () => {
    expect(sinkInitsToFirstUse(fn([init('p0', 0x3001100), read('p0', 0), plain()]))).toBeNull();
  });

  test('a `volatile` local ends the run: its write order is observable', () => {
    const body = [init('p0', 0x3001100), plain(), read('p0', 1)];
    expect(sinkInitsToFirstUse(fn(body, [{ name: 'p0', type: U8P, volatile: true }]))).toBeNull();
  });

  test('a local the function writes again is refused: the sink would cross that write', () => {
    const body: Stmt[] = [
      init('p0', 0x3001100),
      plain(),
      { k: 'assign', name: 'p0', value: { k: 'cast', to: U8P, e: c(0x3001200) } },
      read('p0', 2),
    ];
    expect(sinkInitsToFirstUse(fn(body))).toBeNull();
  });

  test('an `&p` escape counts as the first use, so the init stops above it', () => {
    const escape: Stmt = { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'p0' }] } };
    const out = sinkInitsToFirstUse(fn([init('p0', 0x3001100), plain(), escape, read('p0', 3)]));
    expect(out?.body.map((s) => s.k)).toEqual(['store', 'assign', 'exprstmt', 'store']);
  });

  test('a first use nested inside an `if` sinks only to the `if`, never into the arm', () => {
    const arm: Stmt = { k: 'if', cond: c(1), then: [read('p0', 1)], else: [] };
    const out = sinkInitsToFirstUse(fn([init('p0', 0x3001100), plain(), arm]));
    expect(out?.body.map((s) => s.k)).toEqual(['store', 'assign', 'if']);
  });

  test('two inits each land at their own first use, in body order', () => {
    const out = sinkInitsToFirstUse(
      fn(
        [init('p0', 0x3001100), init('p1', 0x4000000), plain(), read('p1', 2), read('p0', 3)],
        [
          { name: 'p0', type: U8P },
          { name: 'p1', type: U8P },
        ],
      ),
    );
    expect(out?.body.map((s) => (s.k === 'assign' ? s.name : s.k))).toEqual(['store', 'p1', 'store', 'p0', 'store']);
  });

  test('nothing mentions the init: it stays at the head rather than sinking to the end', () => {
    expect(sinkInitsToFirstUse(fn([init('p0', 0x3001100), plain()]))).toBeNull();
  });

  test('no leading init at all: the lever declines', () => {
    expect(sinkInitsToFirstUse(fn([plain(), init('p0', 0x3001100), read('p0', 1)]))).toBeNull();
  });
});
