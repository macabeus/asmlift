// The un-merge lever (l3/unmerge.ts): a join statement pushed back into the arms agbcc
// cross-jumped it out of — the dual of tailmerge.test.ts's pass, and a lever where that one is
// unconditional.
//
// The refusals are the whole argument, because the rewrite DUPLICATES a statement and DELETES the
// definitions feeding it: each one is a place where the copy would read a different value than the
// merged spelling did, and nothing downstream would notice.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { unmergeJoins } from '../src/l3/unmerge';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const asg = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const deref = (p: Expr): Expr => ({ k: 'index', base: p, idx: c(0), width: 2, signed: false });
const store = (p: Expr, value: Expr): Stmt => ({ k: 'store', lval: deref(p), value });
const call = (fn: string): Expr => ({ k: 'call', fn, args: [] });
const iff = (then: Stmt[], els: Stmt[]): Stmt => ({ k: 'if', cond: v('cond'), then, else: els });

const fn = (body: Stmt[], names = ['p', 'x']): SFn => ({
  name: 'f',
  params: [],
  locals: names.map((name) => ({ name, type: T.s(32) })),
  globals: [],
  retType: T.void(),
  body,
});

/** the canonical shape: both arms define the address and the value, the join stores through them */
const merged = (extraThen: Stmt[] = [], extraElse: Stmt[] = []): Stmt[] => [
  iff([...extraThen, asg('p', v('a')), asg('x', c(1))], [...extraElse, asg('p', v('b')), asg('x', c(2))]),
  store(v('p'), v('x')),
];

const armsOf = (s: SFn): [Stmt[], Stmt[]] => {
  const i = s.body[0] as Extract<Stmt, { k: 'if' }>;
  return [i.then, i.else];
};

describe('what un-merges', () => {
  test("the join statement is duplicated into both arms with each arm's own definitions", () => {
    const out = unmergeJoins(fn(merged()));
    expect(out).not.toBeNull();
    expect(out!.body).toHaveLength(1); // the join statement is gone from the outer list
    const [then, els] = armsOf(out!);
    expect(then).toEqual([store(v('a'), c(1))]);
    expect(els).toEqual([store(v('b'), c(2))]);
  });

  test('the merge temps are DROPPED from the declaration list', () => {
    expect(unmergeJoins(fn(merged()))!.locals).toEqual([]);
  });

  test('statements BEFORE the definitions stay in their own arm, in order', () => {
    const [then, els] = armsOf(unmergeJoins(fn(merged([store(v('g'), c(7))], [store(v('h'), c(8))])))!);
    expect(then).toEqual([store(v('g'), c(7)), store(v('a'), c(1))]);
    expect(els).toEqual([store(v('h'), c(8)), store(v('b'), c(2))]);
  });

  test('it fires inside a loop body, not only at the top level', () => {
    const out = unmergeJoins(fn([{ k: 'dowhile', cond: v('cond'), body: merged() }]));
    expect(out).not.toBeNull();
    const body = (out!.body[0] as Extract<Stmt, { k: 'dowhile' }>).body;
    expect(body).toHaveLength(1);
  });

  test('an unrelated assignment BETWEEN the definitions is kept, and the copy lands after it', () => {
    // the shape the corpus actually has: the structurer interleaves another merge variable's
    // write between the address and the value
    const body = [
      iff([asg('p', v('a')), asg('q', c(5)), asg('x', c(1))], [asg('p', v('b')), asg('q', c(6)), asg('x', c(2))]),
      store(v('p'), v('x')),
    ];
    const out = unmergeJoins(fn(body, ['p', 'x', 'q']));
    expect(out).not.toBeNull();
    expect(armsOf(out!)[0]).toEqual([asg('q', c(5)), store(v('a'), c(1))]);
    expect(out!.locals.map((l) => l.name)).toEqual(['q']); // only the substituted temps are dropped
  });

  test('a join reading ONE merge temp un-merges too — the rule is not about pairs', () => {
    const out = unmergeJoins(fn([iff([asg('x', c(1))], [asg('x', c(2))]), store(v('g'), v('x'))], ['x']));
    expect(out).not.toBeNull();
    expect(armsOf(out!)[0]).toEqual([store(v('g'), c(1))]);
  });
});

describe('what refuses — each one would read a different value', () => {
  const declines = (body: Stmt[], names?: string[]) => expect(unmergeJoins(fn(body, names))).toBeNull();

  test('an EMPTY arm: nothing there defines the join`s operands', () => {
    declines([iff([asg('p', v('a')), asg('x', c(1))], []), store(v('p'), v('x'))]);
  });

  test('a join statement that is CONTROL FLOW is never duplicated into an arm', () => {
    declines([iff([asg('x', c(1))], [asg('x', c(2))]), { k: 'return', value: v('x') }], ['x']);
  });

  test('a join reading no local at all — there is no merge to undo', () => {
    declines([iff([asg('x', c(1))], [asg('x', c(2))]), store(v('g'), c(0))], ['x']);
  });

  test('a merge temp READ AGAIN after the join keeps its name', () => {
    declines([iff([asg('x', c(1))], [asg('x', c(2))]), store(v('g'), v('x')), store(v('h'), v('x'))], ['x']);
  });

  test('a merge temp assigned in only ONE arm (or three times) refuses', () => {
    declines([iff([asg('x', c(1))], [store(v('g'), c(0))]), store(v('h'), v('x'))], ['x']);
    declines([iff([asg('x', c(1)), asg('x', c(3))], [asg('x', c(2))]), store(v('h'), v('x'))], ['x']);
  });

  test('a definition that is NOT in the arm`s trailing run refuses', () => {
    // `g[0] = 0` sits between the definition and the join, and it may write what `a` reads
    declines([
      iff([asg('p', v('a')), asg('x', c(1)), store(v('g'), c(0))], [asg('p', v('b')), asg('x', c(2))]),
      store(v('p'), v('x')),
    ]);
  });

  test('an intervening assignment that CLOBBERS what a definition reads refuses', () => {
    // `p = a` is evaluated where the copy lands, and `a = 9` runs before that point
    declines(
      [
        iff([asg('p', v('a')), asg('a', c(9)), asg('x', c(1))], [asg('p', v('b')), asg('a', c(9)), asg('x', c(2))]),
        store(v('p'), v('x')),
      ],
      ['p', 'x', 'a'],
    );
  });

  test('a join reading a local the arms WRITE but this cannot substitute refuses', () => {
    // `q` is assigned three times, so it is no merge temp — and its value at the arm's end is not
    // the value the join read
    declines(
      [iff([asg('q', c(1)), asg('x', c(1))], [asg('q', c(2)), asg('q', c(3)), asg('x', c(2))]), store(v('q'), v('x'))],
      ['x', 'q'],
    );
  });

  test('a definition whose value reads ANOTHER merge temp refuses — the order is not fixed', () => {
    declines([iff([asg('p', v('a')), asg('x', v('p'))], [asg('p', v('b')), asg('x', v('p'))]), store(v('p'), v('x'))]);
  });

  test('a definition carrying an EFFECT refuses — C fixes no order between one statement`s operands', () => {
    declines([
      iff([asg('p', v('a')), asg('x', call('side'))], [asg('p', v('b')), asg('x', call('side'))]),
      store(v('p'), v('x')),
    ]);
  });

  test('a tree with no eligible site DECLINES rather than returning a copy of itself', () => {
    expect(unmergeJoins(fn([store(v('g'), c(0))], []))).toBeNull();
  });
});
