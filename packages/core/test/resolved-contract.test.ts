// UNIT tests for the structuring boundary contract (contracts.ts assertResolved): no name the
// emitted AST carries may be unresolved.
//
// Hand-built AST, the same way effects-contract.ts pins its rule — the point is the coverage
// itself, independent of whether today's structurer can produce the shape. A name reaches the AST
// by TWO routes and the contract has to see both: as a `var` EXPRESSION, and as an `assign`
// DESTINATION, which is a bare string field that no expression walk visits.
//
// Two spellings per route. `"?"` is the structurer's designed sentinel for a value it could not
// resolve. `undefined` is a broken invariant instead: `Expr` declares `name: string`, so the only
// way to reach one is a `varName.get(v)!` whose value was never adopted — and it prints as the
// token `undefined`, uncompilable in exactly the way `"?"` is.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { ContractError, assertResolved } from '../src/contracts';
import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';

const sfnWith = (body: Stmt[]): SFn => ({ name: 'f', params: [], locals: [], retType: T.void(), body });
const copy = (dest: string | undefined, from: string | undefined): SFn =>
  sfnWith([{ k: 'assign', name: dest as string, value: { k: 'var', name: from as string } }]);

test('a resolved copy passes — the control both refusals are measured against', () => {
  expect(() => assertResolved(copy('v0', 'v1'))).not.toThrow();
});

test('an unresolved name is refused in the VALUE, both spellings', () => {
  expect(() => assertResolved(copy('v0', '?'))).toThrow(ContractError);
  expect(() => assertResolved(copy('v0', undefined))).toThrow(ContractError);
});

// The destination is not an Expr, so `stmtExprs` never yields it: a walk over expressions alone
// passes this and the backend prints `undefined = v1;`.
test('an unresolved name is refused in the DESTINATION too', () => {
  expect(() => assertResolved(copy('?', 'v1'))).toThrow(ContractError);
  expect(() => assertResolved(copy(undefined, 'v1'))).toThrow(ContractError);
});

// What the contract is for: every refusal above is a line the backend would otherwise emit.
test('each refused shape is one the backend would have emitted', () => {
  expect(cBackend.emit(copy('v0', undefined))).toContain('v0 = undefined;');
  expect(cBackend.emit(copy(undefined, 'v1'))).toContain('undefined = v1;');
});

// Nesting: the contract walks into statement children, so a copy buried in a loop body is refused
// on the same terms as one at the top level.
test('a nested statement is walked, not just the top level', () => {
  const inLoop: Stmt = {
    k: 'dowhile',
    cond: { k: 'var', name: 'v0' },
    body: [{ k: 'assign', name: undefined as unknown as string, value: { k: 'var', name: 'v1' } }],
  };
  expect(() => assertResolved(sfnWith([inLoop]))).toThrow(ContractError);
});
