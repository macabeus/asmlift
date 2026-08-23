// UNIT tests for the structuring boundary contract (contracts.ts assertLocalsWritten): a local the
// emitted body reads must be assigned somewhere in it.
//
// Hand-built AST, the way resolved-contract.ts pins its rule — the coverage is the point,
// independent of which pass can produce the shape today. A materialized value renders as ONE
// `v = …` statement at its def's position; drop that position and the reads stand over whatever
// the register allocator left, in C that compiles and scores.
//
// Two locals are legitimately unwritten and both declare it: `uninit` (the local stands on an
// `undef` — the missing assignment IS the recovery) and `frame` (the machine's own slot, whose
// store the readability passes may drop).
import { expect, test } from 'vitest';

import { ContractError, assertLocalsWritten } from '../src/contracts';
import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';

const READ: Stmt = { k: 'return', value: { k: 'var', name: 'v0' } };
const fnWith = (local: SFn['locals'][number], body: Stmt[] = [READ]): SFn => ({
  name: 'f',
  params: [],
  locals: [local],
  retType: T.int(32, true),
  body,
});
const plain = { name: 'v0', type: T.int(32, true) } as const;

test('a local written before its read passes — the control the refusals are measured against', () => {
  expect(() =>
    assertLocalsWritten(fnWith(plain, [{ k: 'assign', name: 'v0', value: { k: 'const', value: 1 } }, READ])),
  ).not.toThrow();
});

test('a local read and assigned NOWHERE is refused', () => {
  expect(() => assertLocalsWritten(fnWith(plain))).toThrow(ContractError);
});

test('the write may sit anywhere — presence, not reaching definitions', () => {
  // One arm assigns and the other does not: unassigned on a path is the shape `uninit` locals are
  // for, and asking the path question here would refuse every one of them a second time.
  const armed: Stmt = {
    k: 'if',
    cond: { k: 'const', value: 1 },
    then: [{ k: 'assign', name: 'v0', value: { k: 'const', value: 1 } }],
    else: [],
  };
  expect(() => assertLocalsWritten(fnWith(plain, [armed, READ]))).not.toThrow();
});

test('`&v` counts as a write — the callee behind it may fill the object', () => {
  const escape: Stmt = { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'v0' }] } };
  expect(() => assertLocalsWritten(fnWith(plain, [escape, READ]))).not.toThrow();
});

test('an `uninit` local reads unwritten by construction, and a `frame` local may', () => {
  expect(() => assertLocalsWritten(fnWith({ ...plain, uninit: true }))).not.toThrow();
  expect(() => assertLocalsWritten(fnWith({ ...plain, frame: { loads: 1, stores: 0 } }))).not.toThrow();
});
