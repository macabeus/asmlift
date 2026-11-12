import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { BinOp, Expr, SFn, Stmt } from '../src/l3/ast';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const at = (base: Expr, idx: Expr): Expr => ({ k: 'index', base, idx, width: 1, signed: false });

const fnOf = (body: Stmt[], locals: SFn['locals'] = [{ name: 'v0', type: T.int(32, true) }]): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: T.ptr(T.int(8, false)) },
    { name: 'a1', type: T.int(32, true) },
  ],
  locals,
  retType: T.void(),
  polish: true,
  body,
});

describe('polish: x++ and x += e for a statement that reads back what it writes', () => {
  test('a local stepped by one, as a statement and as a for update', () => {
    const fn = fnOf([
      { k: 'assign', name: 'v0', value: bin('+', v('v0'), c(1)) },
      { k: 'assign', name: 'a1', value: bin('-', v('a1'), c(1)) },
      {
        k: 'for',
        init: { k: 'assign', name: 'v0', value: c(0) },
        cond: bin('<', v('v0'), v('a1')),
        inc: { k: 'assign', name: 'v0', value: bin('+', v('v0'), c(1)) },
        body: [{ k: 'exprstmt', value: { k: 'call', fn: 'g', args: [] } }],
      },
    ]);
    const out = cBackend.emit(fn);
    expect(out).toContain('    v0++;');
    expect(out).toContain('    a1--;');
    expect(out).toContain('for (v0 = 0; v0 < a1; v0++) {');
    expect(cBackend.draft!(fn)).toContain('    v0 = v0 + 1;');
  });

  test('a compound add and subtract, to a local and through a plain address', () => {
    const out = cBackend.emit(
      fnOf([
        { k: 'assign', name: 'v0', value: bin('+', v('v0'), c(3)) },
        { k: 'store', lval: at(v('a0'), v('a1')), value: bin('-', at(v('a0'), v('a1')), c(5)) },
      ]),
    );
    expect(out).toContain('    v0 += 3;');
    expect(out).toContain('    a0[a1] -= 5;');
  });

  test('a prefix-shaped target parenthesizes under ++: `(*p)++`, never `*p++`', () => {
    const deref: Expr = { k: 'index', base: v('a0'), idx: c(0), width: 1, signed: false };
    const out = cBackend.emit(
      fnOf([
        { k: 'store', lval: deref, value: bin('+', deref, c(1)) },
        { k: 'store', lval: deref, value: bin('+', deref, c(4)) },
      ]),
    );
    expect(out).toContain('    (*a0)++;');
    expect(out).toContain('    *a0 += 4;');
  });

  test('a value that is not a literal keeps the plain spelling: IDO orders the add differently', () => {
    const out = cBackend.emit(
      fnOf([
        { k: 'assign', name: 'v0', value: bin('+', v('v0'), bin('*', v('a1'), c(3))) },
        { k: 'assign', name: 'v0', value: bin('-', v('v0'), v('a1')) },
      ]),
    );
    expect(out).toContain('    v0 = v0 + a1 * 3;');
    expect(out).toContain('    v0 = v0 - a1;');
  });

  test('refused: a global, a volatile local, a target that loads, a value with a call', () => {
    const out = cBackend.emit(
      fnOf(
        [
          { k: 'assign', name: 'gCount', value: bin('+', v('gCount'), c(1)) },
          { k: 'assign', name: 'v1', value: bin('+', v('v1'), c(1)) },
          {
            k: 'store',
            lval: at(at(v('a0'), c(0)), c(1)),
            value: bin('+', at(at(v('a0'), c(0)), c(1)), c(1)),
          },
          { k: 'assign', name: 'v0', value: bin('+', v('v0'), { k: 'call', fn: 'g', args: [] }) },
        ],
        [
          { name: 'v0', type: T.int(32, true) },
          { name: 'v1', type: T.int(32, true), volatile: true },
        ],
      ),
    );
    expect(out).toContain('    gCount = gCount + 1;');
    // (renumbered by first mention: the volatile `v1` is met first and prints as `v0`)
    expect(out).toContain('    volatile s32 v0;');
    expect(out).toContain('    v0 = v0 + 1;');
    expect(out).toContain('    v1 = v1 + g();');
    expect(out).not.toContain('+=');
    expect(out).not.toContain('++');
  });
});
