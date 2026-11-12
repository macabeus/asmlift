import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { BinOp, Expr, SFn, Stmt } from '../src/l3/ast';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const g = (x: Expr): Expr => ({ k: 'call', fn: 'g', args: [x] });
const call = (fn: string): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn, args: [] } });

const fnOf = (body: Stmt[]): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: T.int(32, true) }],
  locals: [],
  retType: T.int(32, true),
  body,
});

describe('polish: a call tested for truth drops its `!= 0`', () => {
  test('an if test, a loop test and the operands of && and !', () => {
    const out = cBackend.emit(
      fnOf([
        { k: 'if', cond: bin('!=', g(v('a0')), c(0)), then: [call('h')], else: [] },
        { k: 'while', cond: bin('&&', bin('!=', v('a0'), c(0)), bin('!=', g(v('a0')), c(0))), body: [call('h')] },
        { k: 'if', cond: { k: 'un', op: '!', e: bin('!=', g(c(1)), c(0)) }, then: [call('h')], else: [] },
        { k: 'return', value: bin('!=', g(v('a0')), c(0)) },
      ]),
    );
    expect(out).toContain('    if (g(a0)) h();');
    expect(out).toContain('    while (a0 != 0 && g(a0)) {');
    expect(out).toContain('    if (!g(1)) h();');
    // a VALUE keeps its compare: it is 0 or 1
    expect(out).toContain('    return g(a0) != 0;');
  });

  test('a compare with anything but the literal 0 stays', () => {
    const out = cBackend.emit(
      fnOf([
        { k: 'if', cond: bin('!=', g(v('a0')), c(1)), then: [call('h')], else: [] },
        { k: 'return', value: c(0) },
      ]),
    );
    expect(out).toContain('if (g(a0) != 1)');
  });
});
