import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { polished } from '../src/l3/polish';

/** The C backend through the polish, at an optimizing level. */
const pc = polished(cBackend, { literal: false });

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
    expect(pc.emit(fn)).toBe('void f(s32 a0) {\n    g();\n}\n');
    expect(pc.draft!(fn)).toContain('    return;');
  });

  test('kept at a level that compiles each statement as written: it is a branch to the epilogue there', () => {
    const fn = fnOf([call('g'), ret]);
    expect(polished(cBackend, { literal: true }).emit(fn)).toContain('    return;');
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
    const out = pc.emit(fn);
    expect(out).not.toContain('break;');
    expect(out).toContain('default:');
  });

  test('a switch that is not last, and a non-void function, keep their returns', () => {
    const sw: Stmt = { k: 'switch', scrutinee: v('a0'), cases: [{ values: [1], body: [ret], fallsThrough: false }] };
    expect(pc.emit(fnOf([sw, call('g')]))).toContain('return;');
    const val: Stmt = { k: 'return', value: c(0) };
    expect(pc.emit(fnOf([call('g'), val], T.int(32, true)))).toContain('return 0;');
  });
});
