import { describe, expect, it } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';

// A statement list long enough that spreading one arm's printed lines into `push` passes more
// arguments than V8 takes (about 120k): the printer threw "Maximum call stack size exceeded" at a
// nesting depth of one, which reads as deep recursion when it is only size.
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
