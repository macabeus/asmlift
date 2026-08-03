// Common-tail merge (l3/tailmerge.ts): a statement ending EVERY arm of an `if` moves below it.
//
// SSA destruction writes the same merge variable at the end of each arm; the source wrote it once.
// Both arms execute it LAST on their own path, so moving it below the `if` needs no liveness or
// dominance analysis — which is why the BELOW direction is the one that is unconditionally sound,
// and (measured) also the one that matches.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { eliminateDeadStores } from '../src/l3/dce';
import { mergeCommonTails } from '../src/l3/tailmerge';

const asg = (name: string, v: number): Stmt => ({ k: 'assign', name, value: { k: 'const', value: v } });
const call = (fn: string): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn, args: [] } });
const iff = (then: Stmt[], els: Stmt[]): Stmt => ({ k: 'if', cond: { k: 'const', value: 1 }, then, else: els });
const fn = (body: Stmt[]): SFn => ({
  name: 'f',
  params: [],
  locals: [{ name: 'v', type: T.s(32) }],
  retType: T.void(),
  body,
});
const kinds = (b: Stmt[]): string[] => b.map((s) => s.k + (s.k === 'assign' ? ':' + s.name : ''));

describe('what merges', () => {
  test('an assignment ending BOTH arms moves below the if', () => {
    const out = mergeCommonTails(fn([iff([asg('v4', 1)], [call('side'), asg('v4', 1)])]));
    expect(kinds(out.body)).toEqual(['if', 'assign:v4']);
    const s = out.body[0] as Extract<Stmt, { k: 'if' }>;
    expect(s.then).toHaveLength(0); // the emptied arm — dce's peephole flips it downstream
    expect(kinds(s.else)).toEqual(['exprstmt']);
  });

  test('SEVERAL common trailing statements all move, in order', () => {
    const out = mergeCommonTails(fn([iff([asg('a', 1), asg('b', 2)], [call('side'), asg('a', 1), asg('b', 2)])]));
    expect(kinds(out.body)).toEqual(['if', 'assign:a', 'assign:b']);
  });

  test('it stops at the first DIFFERENCE, walking from the end', () => {
    const out = mergeCommonTails(fn([iff([asg('a', 1), asg('b', 2)], [asg('a', 9), asg('b', 2)])]));
    expect(kinds(out.body)).toEqual(['if', 'assign:b']);
    expect(kinds((out.body[0] as Extract<Stmt, { k: 'if' }>).then)).toEqual(['assign:a']);
  });

  test('a side-effecting statement merges too — both paths ran it last either way', () => {
    const out = mergeCommonTails(fn([iff([call('side')], [asg('a', 1), call('side')])]));
    expect(kinds(out.body)).toEqual(['if', 'exprstmt']);
  });

  test('nested ifs merge innermost-first', () => {
    const inner = iff([asg('a', 1)], [call('side'), asg('a', 1)]);
    const out = mergeCommonTails(fn([iff([inner], [inner])]));
    // the inner merge runs, then the outer sees two identical trailing `assign:a`
    expect(kinds(out.body)).toEqual(['if', 'assign:a']);
  });
});

describe('what does not', () => {
  test('DIFFERENT values do not merge', () => {
    const out = mergeCommonTails(fn([iff([asg('a', 1)], [asg('a', 2)])]));
    expect(kinds(out.body)).toEqual(['if']);
  });

  test('a different NAME does not merge', () => {
    const out = mergeCommonTails(fn([iff([asg('a', 1)], [asg('b', 1)])]));
    expect(kinds(out.body)).toEqual(['if']);
  });

  test('an empty arm blocks it — there is no common tail to take', () => {
    const out = mergeCommonTails(fn([iff([], [asg('a', 1)])]));
    expect(kinds(out.body)).toEqual(['if']);
  });

  test('CONTROL FLOW is never moved out of an arm', () => {
    // moving a `return` below the `if` changes what the arm can still reach
    const ret: Stmt = { k: 'return', value: { k: 'const', value: 0 } };
    const out = mergeCommonTails(fn([iff([ret], [call('side'), ret])]));
    expect(kinds(out.body)).toEqual(['if']);
    const brk: Stmt = { k: 'break' };
    const out2 = mergeCommonTails(
      fn([{ k: 'while', cond: { k: 'const', value: 1 }, body: [iff([brk], [call('s'), brk])] }]),
    );
    const body = (out2.body[0] as Extract<Stmt, { k: 'while' }>).body;
    expect(kinds(body)).toEqual(['if']);
  });

  test('a nested IF ending both arms is not compared — that needs a full Stmt congruence', () => {
    const nested = iff([asg('z', 1)], [asg('z', 2)]);
    const out = mergeCommonTails(fn([iff([nested], [call('side'), nested])]));
    expect(kinds(out.body)).toEqual(['if']);
  });

  test('SWITCH case bodies are left alone — fall-through has no end of its own', () => {
    const sw: Stmt = {
      k: 'switch',
      scrutinee: { k: 'var', name: 'x' },
      cases: [
        { values: [1], body: [asg('a', 1)], fallsThrough: false },
        { values: [2], body: [asg('a', 1)], fallsThrough: false },
      ],
    };
    const out = mergeCommonTails(fn([sw]));
    expect(kinds(out.body)).toEqual(['switch']);
    const s = out.body[0] as Extract<Stmt, { k: 'switch' }>;
    expect(kinds(s.cases[0].body)).toEqual(['assign:a']);
  });

  test('a store merges only when BOTH the lvalue and the value agree', () => {
    const st = (idx: number, v: number): Stmt => ({
      k: 'store',
      lval: {
        k: 'index',
        base: { k: 'var', name: 'p' },
        idx: { k: 'const', value: idx },
        width: 2,
        signed: false,
      } as Expr,
      value: { k: 'const', value: v },
    });
    expect(kinds(mergeCommonTails(fn([iff([st(1, 7)], [call('s'), st(1, 7)])])).body)).toEqual(['if', 'store']);
    expect(kinds(mergeCommonTails(fn([iff([st(1, 7)], [call('s'), st(2, 7)])])).body)).toEqual(['if']);
  });
});

describe('the wiring, not just the function', () => {
  test('the merge and the empty-then flip compose in PIPELINE order', () => {
    // The payoff depends on `eliminateDeadStores` flipping the arm this pass empties, and nothing
    // pins that order — `structureChecked` composes them positionally, so reordering would silently
    // lose the flip. This asserts the composed shape the two produce together.
    const src = eliminateDeadStores(
      mergeCommonTails(
        fn([
          {
            k: 'if',
            cond: { k: 'bin', op: '<', l: { k: 'var', name: 'n' }, r: { k: 'const', value: 5 } },
            then: [asg('v', 1)],
            else: [call('side'), asg('v', 1)],
          },
          { k: 'return', value: { k: 'var', name: 'v' } },
        ]),
      ),
    );
    // the merge empties the then-arm; dce's peephole then negates and swaps
    expect(kinds(src.body)).toEqual(['if', 'assign:v', 'return']);
    const s = src.body[0] as Extract<Stmt, { k: 'if' }>;
    expect(s.else).toHaveLength(0);
    expect(kinds(s.then)).toEqual(['exprstmt']);
    expect(s.cond).toMatchObject({ k: 'bin', op: '>=' });
  });

  test('both arms peeling empty is handled, not guarded against', () => {
    const src = eliminateDeadStores(
      mergeCommonTails(fn([iff([asg('v', 1)], [asg('v', 1)]), { k: 'return', value: { k: 'var', name: 'v' } }])),
    );
    // both arms peel empty; the `if` then collapses entirely — its condition is pure, so dce drops it
    expect(kinds(src.body)).toEqual(['assign:v', 'return']);
  });
});

describe('edge shapes', () => {
  test('both arms emptying deletes the branch — pinned, because it removes a compare from the C', () => {
    const src = eliminateDeadStores(
      mergeCommonTails(fn([iff([asg('v', 2)], [asg('v', 2)]), { k: 'return', value: { k: 'var', name: 'v' } }])),
    );
    expect(kinds(src.body)).toEqual(['assign:v', 'return']);
  });

  test('a tail preceded by a RETURN in the same arm still merges correctly', () => {
    // the early return makes the tail unreachable on that path — before and after alike
    const ret: Stmt = { k: 'return', value: { k: 'const', value: 0 } };
    const out = mergeCommonTails(fn([iff([ret, asg('v', 1)], [call('side'), asg('v', 1)])]));
    expect(kinds(out.body)).toEqual(['if', 'assign:v']);
    expect(kinds((out.body[0] as Extract<Stmt, { k: 'if' }>).then)).toEqual(['return']);
  });

  test('it recurses into a switch DEFAULT, and the peel stays inside its case', () => {
    const sw: Stmt = {
      k: 'switch',
      scrutinee: { k: 'var', name: 'x' },
      cases: [{ values: [1], body: [iff([asg('v', 1)], [call('s'), asg('v', 1)])], fallsThrough: false }],
      default: [iff([asg('w', 1)], [call('s'), asg('w', 1)])],
    };
    const out = mergeCommonTails(fn([sw]));
    const s = out.body[0] as Extract<Stmt, { k: 'switch' }>;
    expect(kinds(s.cases[0].body)).toEqual(['if', 'assign:v']);
    expect(kinds(s.default!)).toEqual(['if', 'assign:w']);
  });
});
