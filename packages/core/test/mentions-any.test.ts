// UNIT tests for l3/mentions.ts `mentionsAnyLocal` — the predicate a pass that DELETES a
// declaration has to answer, and the one place l3/unmerge.ts's soundness stops depending on a
// mention count sampled before any rewriting.
//
// The property under test is TOTALITY OVER THE NODE VOCABULARY. A name can hide in positions a
// naive walk misses: an `assign`'s TARGET carries no expression at all, a `for`'s init and inc are
// statements rather than children of the body, and a `switch`'s scrutinee, cases and `default` are
// three separate lists. A miss here is not a lost candidate — it is a deleted declaration with the
// name still standing in the emitted C.
import { describe, expect, test } from 'vitest';

import type { Expr, Stmt } from '../src/l3/ast';
import { mentionsAnyLocal } from '../src/l3/mentions';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const asg = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const names = new Set(['t']);
const finds = (s: Stmt) => expect(mentionsAnyLocal([s], names)).toBe(true);

describe('every position a name can hide in', () => {
  test('an assignment TARGET — no expression walk reaches it', () => finds(asg('t', c(0))));
  test('a plain read', () => finds(asg('q', v('t'))));
  test('an ADDRESS', () => finds(asg('q', { k: 'addr', name: 't' })));
  test('nested inside an `if` arm', () => finds({ k: 'if', cond: c(1), then: [], else: [asg('q', v('t'))] }));
  test("a `for`'s INIT", () => finds({ k: 'for', init: asg('t', c(0)), cond: c(1), inc: asg('q', c(0)), body: [] }));
  test("a `for`'s INC", () => finds({ k: 'for', init: asg('q', c(0)), cond: c(1), inc: asg('t', c(0)), body: [] }));
  test("a `switch`'s SCRUTINEE", () => finds({ k: 'switch', scrutinee: v('t'), cases: [], default: [] }));
  test("a `switch`'s CASE body", () =>
    finds({
      k: 'switch',
      scrutinee: c(0),
      cases: [{ values: [1], fallsThrough: false, body: [asg('q', v('t'))] }],
      default: [],
    }));
  test("a `switch`'s DEFAULT arm", () =>
    finds({ k: 'switch', scrutinee: c(0), cases: [], default: [asg('q', v('t'))] }));
  test('a LEADING subscript of a multidimensional global index', () =>
    finds(
      asg('q', { k: 'index', base: { k: 'addr', name: 'gRows' }, idx: c(7), lead: [v('t')], width: 2, signed: false }),
    ));
});

describe('and what it must not claim', () => {
  test('a tree naming nothing in the set', () => expect(mentionsAnyLocal([asg('q', v('r'))], names)).toBe(false));
  test('an empty statement list', () => expect(mentionsAnyLocal([], names)).toBe(false));
  test('an empty name set', () => expect(mentionsAnyLocal([asg('t', c(0))], new Set())).toBe(false));
});

// And ONE PASS over the tree, which is a contract and not a micro-optimisation: `walkExprs` itself
// descends `stmtChildren`, so a per-statement expression walk nested inside a recursion that also
// descends is quadratic in the depth — 11 / 37 / 79 / 137 / 301 name tests where these read
// 5 / 9 / 13 / 17 / 25. This helper is shared, and the reader of a shared predicate cannot see
// that from the call site. The nesting exponent is what is pinned, not the constant.
describe('and it visits each position once', () => {
  const nest = (d: number): Stmt[] => {
    let inner: Stmt[] = [asg('z', c(1))];
    for (let i = 0; i < d; i++) {
      inner = [{ k: 'if', cond: v('c' + i), then: inner, else: [] }];
    }
    return inner;
  };
  const probes = (d: number): number => {
    let n = 0;
    const counting = {
      has: () => {
        n++;
        return false;
      },
    } as unknown as ReadonlySet<string>;
    mentionsAnyLocal(nest(d), counting);
    return n;
  };
  test('a right-nested `if` chain costs one name test per position, at every depth', () =>
    expect([4, 8, 12, 16, 24].map(probes)).toEqual([5, 9, 13, 17, 25]));
});
