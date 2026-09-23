// validatePrototypes — the guard on a hand-written prototype table (the CLI's `--proto` JSON).
// What each refusal is FOR: `declaredArgWidths` reads a malformed `params` as an omitted one and
// falls back to the arg-register heuristic, so anything accepted here decompiles at a guessed arity.
import { describe, expect, test } from 'vitest';

import { declaredArgWidths, validatePrototypes } from '../src/proto';

describe('accepts every form the type allows', () => {
  test.each([
    ['a bare arity', { f: { params: 2 } }],
    ['a typed list', { f: { params: ['u8', 's32'] } }],
    ['zero parameters', { f: { params: 0 } }],
    ['returnsVoid alone', { f: { returnsVoid: true } }],
    ['both', { f: { params: ['u8'], returnsVoid: false } }],
    ['a declared return width', { f: { params: [], returns: 'long long' } }],
    ['a return spelling nothing can size — silence, which the frontend already handles', { f: { returns: 'Fixed64' } }],
    ['the two return keys agreeing', { f: { returnsVoid: true, returns: 'void' } }],
    ['an empty proto — the frontend then guesses, which is a choice not a mistake', { f: {} }],
    ['an empty table', {}],
  ])('%s', (_label, table) => {
    expect(validatePrototypes(table)).toEqual([]);
  });
});

describe('refuses what would otherwise decompile at a guessed arity', () => {
  test('a stringly-typed count — the case declaredArgWidths silently drops', () => {
    expect(declaredArgWidths({ params: '2' } as never)).toBeUndefined();
    expect(validatePrototypes({ f: { params: '2' } })).toEqual([
      'f: "params" must be a non-negative integer or a list of type strings',
    ]);
  });

  test('a misspelled key, which would simply do nothing', () => {
    expect(validatePrototypes({ f: { returnVoid: true } })).toEqual([
      'f: unknown key "returnVoid" (expected "params", "returnsVoid" or "returns")',
    ]);
  });

  test.each([
    ['a negative arity', { f: { params: -1 } }],
    ['a fractional arity', { f: { params: 1.5 } }],
    ['a list holding a non-string', { f: { params: ['u8', 4] } }],
    ['a non-boolean returnsVoid', { f: { returnsVoid: 'yes' } }],
    ['a non-string returns', { f: { returns: 64 } }],
    ['a proto that is not an object', { f: 2 }],
    ['a proto that is an array', { f: [] }],
  ])('%s', (_label, table) => {
    expect(validatePrototypes(table).length).toBeGreaterThan(0);
  });

  // THE TWO RETURN KEYS ARE ONE FACT SPELLED TWICE, and a table that says both means one of them.
  // Neither reading is safe to pick: honouring `returnsVoid` drops a pair the other key says comes
  // back, and honouring `returns` licenses the out-parameter frame the `void` was ruling out. BOTH
  // directions, because both keys are now READ — an explicit `returnsVoid: false` beside
  // `returns: "void"` is the same disagreement written the other way round.
  test('the two return keys contradicting each other, the other way round', () => {
    expect(validatePrototypes({ f: { returnsVoid: false, returns: 'void' } })).toEqual([
      'f: "returnsVoid" is false but "returns" says "void"',
    ]);
    // …and an omitted `returnsVoid` is not a contradiction with anything. The wide arm carries a
    // `params` because a wide `returns` with no parameter list has its own problem, below.
    expect(validatePrototypes({ f: { returns: 'void' } })).toEqual([]);
    expect(validatePrototypes({ f: { params: [], returnsVoid: false, returns: 'long long' } })).toEqual([]);
  });

  test('the two return keys contradicting each other', () => {
    expect(validatePrototypes({ f: { params: [], returnsVoid: true, returns: 'long long' } })).toEqual([
      'f: "returnsVoid" is true but "returns" says "long long"',
    ]);
  });

  // A `returns` WIDER THAN A REGISTER IS THE ONE THE REST OF THE ENTRY HAS TO CARRY, and before
  // this check every one of these was accepted and then did nothing: the frontend reads the pair
  // only where the callee's own prototype can be PRINTED into the candidate, so the user met
  // `frontend/ssa.ts` reporting a destroyed register — a sentence that is true about the bytes and
  // says nothing about the prototype in the same run. A blanket refusal has to name the gate that
  // bounds it, and the gate is `spellableProto`.
  describe('a wide `returns` the rest of the entry cannot carry is named, not ignored', () => {
    test.each([
      ['no parameter list at all', { llsrc: { returns: 'long long' } }],
      ['a bare argument-register count', { llsrc: { params: 2, returns: 'long long' } }],
      ['a spelling no candidate prelude declares', { llsrc: { params: [], returns: 'int64_t' } }],
      ['an unspellable PARAMETER beside it', { llsrc: { params: ['Fixed64'], returns: 'long long' } }],
    ])('%s', (_label, table) => {
      expect(validatePrototypes(table)).toEqual([expect.stringContaining('is wider than a register')]);
    });

    // …and the complete form is silent, which is what makes the check a claim about completeness
    // rather than about the key. A register-WIDTH return is silent whatever the rest says: it is
    // not inert there (`returnsWithoutHiddenPointer` reads it), so refusing it would be a refusal
    // this could not justify.
    test.each([
      ['a complete wide prototype', { llsrc: { params: [], returns: 'long long' } }],
      ['a complete wide prototype with parameters', { llsrc: { params: ['u32'], returns: 's64' } }],
      ['a register-width return with no parameter list', { llsrc: { returns: 'u32' } }],
      ['a return spelled void with no parameter list', { llsrc: { returns: 'void' } }],
      ['a return this cannot size at all', { llsrc: { returns: 'Fixed64' } }],
    ])('%s is accepted', (_label, table) => {
      expect(validatePrototypes(table)).toEqual([]);
    });
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
