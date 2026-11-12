import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const call = (fn: string): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn, args: [] } });
const ret: Stmt = { k: 'return' };

const fnOf = (body: Stmt[], retType = T.void()): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: T.int(32, true) }],
  locals: [],
  retType,
  body,
});

describe('polish: the tail of a void function', () => {
  test('the trailing return is dropped', () => {
    const fn = fnOf([call('g'), ret]);
    expect(cBackend.emit(fn)).toBe('void f(s32 a0) {\n    g();\n}\n');
    expect(cBackend.draft!(fn)).toContain('    return;');
  });

  test('a final switch keeps its returns: `break` there is other code on mwcc and IDO', () => {
    const fn = fnOf([
      {
        k: 'switch',
        scrutinee: v('a0'),
        cases: [
          { values: [1], body: [call('g'), ret], fallsThrough: false },
          { values: [2], body: [call('h'), ret], fallsThrough: false },
        ],
        default: [ret],
      },
    ]);
    const out = cBackend.emit(fn);
    expect(out).not.toContain('break;');
    expect(out).toContain('default:');
  });

  test('a switch that is not last, and a non-void function, keep their returns', () => {
    const sw: Stmt = { k: 'switch', scrutinee: v('a0'), cases: [{ values: [1], body: [ret], fallsThrough: false }] };
    expect(cBackend.emit(fnOf([sw, call('g')]))).toContain('return;');
    const val: Stmt = { k: 'return', value: c(0) };
    expect(cBackend.emit(fnOf([call('g'), val], T.int(32, true)))).toContain('return 0;');
  });
});
