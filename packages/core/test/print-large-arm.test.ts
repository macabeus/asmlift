import { describe, expect, it } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';

// A statement list long enough that spreading one arm's printed lines into `push` passes more
// arguments than V8 takes (about 120k), and throws "Maximum call stack size exceeded" at a nesting
// depth of one, which reads as deep recursion when it is only size.
describe('C printer over a very long arm', () => {
  it('prints a 200,000-statement `if` arm without exceeding the argument limit', () => {
    const n = 200_000;
    const arm: Stmt[] = Array.from({ length: n }, (_, i) => ({
      k: 'assign',
      name: 'x',
      value: { k: 'const', value: i },
    }));
    const fn: SFn = {
      name: 'big',
      params: [],
      locals: [{ name: 'x', type: T.s() }],
      retType: { kind: 'void' },
      body: [
        { k: 'if', cond: { k: 'var', name: 'x' }, then: arm, else: [] },
        { k: 'while', cond: { k: 'var', name: 'x' }, body: arm },
      ],
    } as unknown as SFn;
    const lines = cBackend.emit(fn).split('\n');
    expect(lines.filter((l) => l.trim().startsWith('x = ')).length).toBe(2 * n);
    expect(lines.filter((l) => l.includes('x = 199999;')).length).toBe(2);
  });
});

// The same limit in the sibling printer, over every statement list it appends: IDO Pascal's `if`
// arms, `case` arms, `otherwise` clause and the function body.
describe('Pascal printer over a very long arm', () => {
  it('prints a 200,000-statement arm in every statement list without exceeding the argument limit', () => {
    const n = 200_000;
    const arm: Stmt[] = Array.from({ length: n }, (_, i) => ({
      k: 'assign',
      name: 'x',
      value: { k: 'const', value: i },
    }));
    const x = { k: 'var', name: 'x' };
    const fn: SFn = {
      name: 'big',
      params: [],
      locals: [{ name: 'x', type: T.s() }],
      retType: { kind: 'void' },
      body: [
        { k: 'if', cond: x, then: arm, else: arm },
        { k: 'switch', scrutinee: x, cases: [{ values: [1], body: arm }], default: arm },
        ...arm,
      ],
    } as unknown as SFn;
    const lines = pascalBackend.emit(fn).split('\n');
    expect(lines.filter((l) => l.trim().startsWith('x := ')).length).toBe(5 * n);
    expect(lines.filter((l) => l.includes('x := 199999;')).length).toBe(5);
  });
});
