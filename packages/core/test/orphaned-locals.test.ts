// UNIT tests for the lever boundary contract (contracts.ts assertNoOrphanedLocals): a local a pass
// DELETED from the declaration list is named nowhere in the tree it produced.
//
// The mirror of assertLocalsWritten, and the three contracts beside it do not see this one. A pass
// that CONSUMES a local — l3/unmerge.ts substituting a merge temp into the arms, l3/coalesce.ts
// folding two names into one, l3/inlinebase.ts deleting a const-address pointer — drops the name
// on the strength of an in-lever count that nothing mentions it any more. When that count is wrong
// the candidate is not a loud lever error: it is C with an undeclared identifier, which in the
// REAL tier compiles inside the project's vendored translation unit, where an orphaned name that
// collides with a context symbol compiles and SCORES.
//
// The first block is the argument for the contract existing at all: it asserts that the other
// three let the shape straight through.
import { describe, expect, test } from 'vitest';

import {
  ContractError,
  assertDerefsTyped,
  assertLocalsWritten,
  assertNoOrphanedLocals,
  assertResolved,
} from '../src/contracts';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { unmergeJoins } from '../src/l3/unmerge';

const local = (name: string) => ({ name, type: T.s(32) });
const fn = (names: string[], body: Stmt[]): SFn => ({
  name: 'f',
  params: [],
  locals: names.map(local),
  globals: [],
  retType: T.void(),
  body,
});
const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const asg = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const deref = (p: Expr): Expr => ({ k: 'index', base: p, idx: c(0), width: 4, signed: true });

// `v16` is assigned and read, and declared nowhere: exactly what a consuming pass leaves behind
// when its mention count was short by one.
const orphaned = fn(['p'], [asg('p', c(0)), asg('v16', c(1)), { k: 'store', lval: deref(v('p')), value: v('v16') }]);
const before = fn(['p', 'v16'], orphaned.body);

describe('the three contracts beside it do not see an orphaned declaration', () => {
  const noThrow = (f: (s: SFn) => void) => expect(() => f(orphaned)).not.toThrow();

  test('assertResolved passes — the name is neither `?` nor undefined', () => noThrow(assertResolved));
  test('assertDerefsTyped passes — the tree is well-typed', () => noThrow(assertDerefsTyped));
  test('assertLocalsWritten passes — it asks the OPPOSITE question (read but never written)', () =>
    noThrow(assertLocalsWritten));
});

describe('what assertNoOrphanedLocals refuses', () => {
  test('a dropped local the body still assigns and reads', () => {
    expect(() => assertNoOrphanedLocals(before, orphaned)).toThrow(ContractError);
    expect(() => assertNoOrphanedLocals(before, orphaned)).toThrow(/still names/);
  });

  test('…named only from inside a NESTED statement — the walk is total, not top-level', () => {
    const after = fn(['p'], [{ k: 'if', cond: c(1), then: [asg('v16', c(1))], else: [] }, asg('p', c(0))]);
    expect(() => assertNoOrphanedLocals(fn(['p', 'v16'], after.body), after)).toThrow(ContractError);
  });

  test('…named only by its ADDRESS — `&v` names the object as surely as a read', () => {
    const after = fn(['p'], [asg('p', { k: 'addr', name: 'v16' })]);
    expect(() => assertNoOrphanedLocals(fn(['p', 'v16'], after.body), after)).toThrow(ContractError);
  });
});

describe('what it must NOT refuse — the false positives that would drop correct candidates', () => {
  test('a local genuinely consumed: dropped AND unmentioned', () => {
    const after = fn(['p'], [{ k: 'store', lval: deref(v('p')), value: c(1) }]);
    expect(() => assertNoOrphanedLocals(fn(['p', 'v16'], after.body), after)).not.toThrow();
  });

  test('a bare GLOBAL write, which structure.ts spells as an `assign` declared nowhere in the tree', () => {
    // The reason the contract is a DIFFERENTIAL and not "every name the tree mentions is declared":
    // `gBlendValue = 5;` is correct output, and `SFn.globals` is the symbol-map-shaped subset, not
    // the population of every global a body may name. A totality check here would refuse this.
    const t = fn(['p'], [asg('gBlendValue', c(5)), asg('p', c(0))]);
    expect(() => assertNoOrphanedLocals(t, t)).not.toThrow();
  });

  test('a pass that drops NOTHING is not judged', () => {
    expect(() => assertNoOrphanedLocals(orphaned, orphaned)).not.toThrow();
  });
});

describe('the pass that motivated it satisfies it', () => {
  test('un-merging a two-armed `if` leaves no orphan', () => {
    const src = fn(
      ['p', 'x'],
      [
        {
          k: 'if',
          cond: v('cond'),
          then: [asg('p', v('a')), asg('x', c(1))],
          else: [asg('p', v('b')), asg('x', c(2))],
        },
        { k: 'store', lval: deref(v('p')), value: v('x') },
      ],
    );
    const out = unmergeJoins(src);
    expect(out).not.toBeNull();
    expect(out!.locals).toEqual([]);
    expect(() => assertNoOrphanedLocals(src, out!)).not.toThrow();
  });
});
