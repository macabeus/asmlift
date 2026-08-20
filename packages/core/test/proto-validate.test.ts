// validatePrototypes — the guard on a HAND-WRITTEN prototype table (`--proto` JSON, the
// `decomp.yaml` key). `protoArity` falls back to the arg-register heuristic on a malformed
// `params`, which is right for an omitted one and silent for a mistyped one, so the table has to
// be refused before it gets there.
import { describe, expect, test } from 'vitest';

import { protoArity, validatePrototypes } from '../src/proto';

describe('accepts every form the type allows', () => {
  test.each([
    ['a bare arity', { f: { params: 2 } }],
    ['a typed list', { f: { params: ['u8', 's32'] } }],
    ['zero parameters', { f: { params: 0 } }],
    ['returnsVoid alone', { f: { returnsVoid: true } }],
    ['both', { f: { params: ['u8'], returnsVoid: false } }],
    ['an empty proto — the frontend then guesses, which is a choice not a mistake', { f: {} }],
    ['an empty table', {}],
  ])('%s', (_label, table) => {
    expect(validatePrototypes(table)).toEqual([]);
  });
});

describe('refuses what would otherwise decompile at a guessed arity', () => {
  test('a stringly-typed count — the case protoArity silently drops', () => {
    expect(protoArity({ params: '2' } as never)).toBeUndefined(); // silent today
    expect(validatePrototypes({ f: { params: '2' } })).toEqual([
      'f: "params" must be a non-negative integer or a list of type strings',
    ]);
  });

  test('a misspelled key, which would simply do nothing', () => {
    expect(validatePrototypes({ f: { returnVoid: true } })).toEqual([
      'f: unknown key "returnVoid" (expected "params" or "returnsVoid")',
    ]);
  });

  test.each([
    ['a negative arity', { f: { params: -1 } }],
    ['a fractional arity', { f: { params: 1.5 } }],
    ['a list holding a non-string', { f: { params: ['u8', 4] } }],
    ['a non-boolean returnsVoid', { f: { returnsVoid: 'yes' } }],
    ['a proto that is not an object', { f: 2 }],
    ['a proto that is an array', { f: [] }],
  ])('%s', (_label, table) => {
    expect(validatePrototypes(table).length).toBeGreaterThan(0);
  });

  test.each([
    ['null', null],
    ['an array', [{ f: { params: 1 } }]],
    ['a scalar', 'f=2'],
  ])('the table itself being %s', (_label, table) => {
    expect(validatePrototypes(table)).toEqual(['must be an object mapping a symbol name to its prototype']);
  });

  test('every broken entry is named, not just the first', () => {
    const problems = validatePrototypes({ a: { params: '1' }, b: { returnsVoid: 1 }, c: { params: 3 } });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('a:');
    expect(problems[1]).toContain('b:');
  });
});
