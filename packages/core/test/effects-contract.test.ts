// UNIT tests for the L2→L3 effect contract (contracts.ts assertEffectsPreserved): every call the
// asm makes is emitted, and none is emitted more times than the asm makes it ON ONE PATH.
//
// Hand-built IR + hand-built AST, the same way hazards.test.ts pins its predicates — the point is
// the rule itself, independent of whether today's structurer can produce the shape. The false-
// POSITIVE side matters as much as the true-positive one: structuring legitimately duplicates a
// region into exclusive arms, and a contract that declined those would cost matches.
import { describe, expect, test } from 'vitest';

import { assertEffectsPreserved } from '../src/contracts';
import { type Block, type Fn, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';

/** an IR fn whose (reachable) entry block calls each name in `calls`, plus an optional
 *  UNREACHABLE block calling `unreachable` */
const irWith = (calls: string[], unreachable: string[] = []): Fn => {
  const entry: Block = {
    params: [],
    ops: [...calls.map((t) => mkOp('call', { results: [mkValue(T.s(32))], attrs: { target: t } })), mkOp('ret', {})],
  };
  const dead: Block = {
    params: [],
    ops: [...unreachable.map((t) => mkOp('call', { results: [mkValue(T.s(32))], attrs: { target: t } })), mkOp('ret')],
  };
  return { name: 'F', blocks: unreachable.length ? [entry, dead] : [entry], writeOrder: undefined };
};

const sfnWith = (body: Stmt[]): SFn => ({ name: 'F', params: [], locals: [], retType: T.void(), body });
const callExpr = (fn: string): Expr => ({ k: 'call', fn, args: [] });
const callStmt = (fn: string): Stmt => ({ k: 'exprstmt', value: callExpr(fn) });
const check = (calls: string[], body: Stmt[], unreachable: string[] = []) =>
  assertEffectsPreserved(irWith(calls, unreachable), sfnWith(body));

describe('assertEffectsPreserved — a dropped call', () => {
  test('a call with no counterpart in the tree fails at the structuring boundary', () => {
    expect(() => check(['f'], [])).toThrow(/dropped the call to 'f'/);
  });

  test('a call nested anywhere in the tree counts as emitted', () => {
    expect(() =>
      check(['f'], [{ k: 'if', cond: { k: 'const', value: 1 }, then: [callStmt('f')], else: [] }]),
    ).not.toThrow();
  });

  test('an UNREACHABLE block’s call is not required — structuring never emits it', () => {
    expect(() => check(['f'], [callStmt('f')], ['g'])).not.toThrow();
  });

  test('a function the asm never calls is not the contract’s business', () => {
    expect(() => check([], [callStmt('printf')])).not.toThrow();
  });
});

describe('assertEffectsPreserved — a call re-run on one path', () => {
  test('two renders in sequence of a single call fail', () => {
    expect(() => check(['f'], [callStmt('f'), callStmt('f')])).toThrow(/emitted 2 calls to 'f' on one path/);
  });

  test('a call inlined into two operands of one statement fails', () => {
    const both: Stmt = {
      k: 'exprstmt',
      value: { k: 'bin', op: '+', l: callExpr('f'), r: callExpr('f') },
    };
    expect(() => check(['f'], [both])).toThrow(/emitted 2 calls to 'f' on one path/);
  });

  test('TWO calls in the asm license two renders', () => {
    expect(() => check(['f', 'f'], [callStmt('f'), callStmt('f')])).not.toThrow();
  });
});

describe('assertEffectsPreserved — duplication that is legitimate', () => {
  test('the same call in both arms of an if is one execution per path', () => {
    const dup: Stmt = { k: 'if', cond: { k: 'const', value: 1 }, then: [callStmt('f')], else: [callStmt('f')] };
    expect(() => check(['f'], [dup])).not.toThrow();
  });

  test('exclusive switch arms sharing a body — the shape structuring duplicates', () => {
    const sw: Stmt = {
      k: 'switch',
      scrutinee: { k: 'var', name: 'x' },
      cases: [
        { values: [0], body: [callStmt('f')], fallsThrough: false },
        { values: [1], body: [callStmt('f')], fallsThrough: false },
      ],
      default: [callStmt('f')],
    };
    expect(() => check(['f'], [sw])).not.toThrow();
  });

  test('a loop body is counted ONCE — a trip count is not a syntactic occurrence', () => {
    const loop: Stmt = { k: 'while', cond: { k: 'const', value: 1 }, body: [callStmt('f')] };
    expect(() => check(['f'], [loop])).not.toThrow();
  });
});

describe('assertEffectsPreserved — fall-through chains', () => {
  // The switch round's CRITICAL: an arm that falls through RUNS the next arm's body too, so the
  // two counts add on that path even though each arm spells the call once.
  const chained = (fallsThrough: boolean): Stmt => ({
    k: 'switch',
    scrutinee: { k: 'var', name: 'x' },
    cases: [
      { values: [0], body: [callStmt('f')], fallsThrough },
      { values: [1], body: [callStmt('f')], fallsThrough: false },
    ],
  });

  test('a fall-through arm adds the next arm’s calls to its own path', () => {
    expect(() => check(['f'], [chained(true)])).toThrow(/emitted 2 calls to 'f' on one path/);
  });

  test('the same two arms with a break between them are exclusive', () => {
    expect(() => check(['f'], [chained(false)])).not.toThrow();
  });

  test('the LAST arm falls through into the default', () => {
    const sw: Stmt = {
      k: 'switch',
      scrutinee: { k: 'var', name: 'x' },
      cases: [{ values: [0], body: [callStmt('f')], fallsThrough: true }],
      default: [callStmt('f')],
    };
    expect(() => check(['f'], [sw])).toThrow(/emitted 2 calls to 'f' on one path/);
  });
});
