// UNIT tests for the loop-emission hazard checks (structure/hazards.ts) — the soundness
// predicates that decide "emit this loop form" vs "decline loud". Extracted from structure()
// precisely so they can be tested like this: a handful of hand-built values and maps, no CFG,
// no parse, no pipeline. The end-to-end decline behavior stays pinned in structure-guard.test.ts
// (PREUPDATE_READ_HAZARD); these pin the predicate logic itself, case by case.
import { describe, expect, test } from 'vitest';

import { Block, Op, Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import type { UseSite } from '../src/structure/analysis';
import { makeLoopHazards, updateWriteSet } from '../src/structure/hazards';

const v = (): Value => mkValue(T.s(32));

interface Fixture {
  defs?: Map<Value, Op>;
  varName?: Map<Value, string>;
  useSitesOf?: Map<Value, UseSite[]>;
}
const make = (f: Fixture = {}) =>
  makeLoopHazards({
    defs: f.defs ?? new Map(),
    varName: f.varName ?? new Map(),
    useSitesOf: f.useSitesOf ?? new Map(),
  });

const use = (blk: Block): UseSite => ({ blk, idx: 0, op: mkOp('add') });

describe('updateWriteSet', () => {
  test('collects assign targets and ignores every other statement kind', () => {
    const s = updateWriteSet([
      { k: 'assign', name: 'v0', value: { k: 'const', value: 1 } },
      { k: 'assign', name: 'v1', value: { k: 'const', value: 2 } },
      { k: 'exprstmt', value: { k: 'const', value: 3 } },
    ]);
    expect(s).toEqual(new Set(['v0', 'v1']));
  });
});

describe('readsClobbered', () => {
  test('a named value is a hazard iff its name is a write target', () => {
    const x = v();
    const h = make({ varName: new Map([[x, 'v0']]) });
    expect(h.readsClobbered(x, new Map(), new Set(['v0']))).toBe(true);
    expect(h.readsClobbered(x, new Map(), new Set(['v1']))).toBe(false);
  });

  test('a sub-mapped value is SAFE even when its target name is written (post-update read)', () => {
    const x = v();
    const h = make({ varName: new Map([[x, 'v0']]) });
    expect(h.readsClobbered(x, new Map([[x, 'v0']]), new Set(['v0']))).toBe(false);
  });

  test('the walk follows unnamed def operands to a clobbered leaf (transitive read)', () => {
    // t = add(x, 1) where x is named v0: rendering t inlines the add, READING v0.
    const x = v();
    const one = v();
    const t = v();
    const defs = new Map<Value, Op>([
      [t, mkOp('add', { operands: [x, one], results: [t] })],
      [one, mkOp('const', { results: [one], attrs: { value: 1 } })],
    ]);
    const h = make({ defs, varName: new Map([[x, 'v0']]) });
    expect(h.readsClobbered(t, new Map(), new Set(['v0']))).toBe(true);
    expect(h.readsClobbered(t, new Map(), new Set(['v9']))).toBe(false);
  });

  test('a value with neither name, sub, nor def is not a hazard (nothing to read)', () => {
    expect(make().readsClobbered(v(), new Map(), new Set(['v0']))).toBe(false);
  });
});

describe('loopEscapeHazard', () => {
  // One body block defining `r = add(x)` where x is named v0; one outside block using r.
  const scaffold = () => {
    const x = v();
    const r = v();
    const op = mkOp('add', { operands: [x], results: [r] });
    const body: Block = { params: [], ops: [op] };
    const outside: Block = { params: [], ops: [] };
    return { x, r, body, outside };
  };

  test('a body value used OUTSIDE the body whose rendering reads a clobbered name fires', () => {
    const { x, r, body, outside } = scaffold();
    const h = make({
      defs: new Map([[r, body.ops[0]]]),
      varName: new Map([[x, 'v0']]),
      useSitesOf: new Map([[r, [use(outside)]]]),
    });
    expect(h.loopEscapeHazard(new Set([body]), new Map(), new Set(['v0']))).toBe(true);
  });

  test('the same value used only INSIDE the body is safe (no escape)', () => {
    const { x, r, body } = scaffold();
    const h = make({
      defs: new Map([[r, body.ops[0]]]),
      varName: new Map([[x, 'v0']]),
      useSitesOf: new Map([[r, [use(body)]]]),
    });
    expect(h.loopEscapeHazard(new Set([body]), new Map(), new Set(['v0']))).toBe(false);
  });

  test('with a region, only uses INSIDE that region count as escapes', () => {
    const { x, r, body, outside } = scaffold();
    const elsewhere: Block = { params: [], ops: [] };
    const h = make({
      defs: new Map([[r, body.ops[0]]]),
      varName: new Map([[x, 'v0']]),
      useSitesOf: new Map([[r, [use(elsewhere)]]]),
    });
    // the use is outside the body but NOT in the post-loop region under scrutiny
    expect(h.loopEscapeHazard(new Set([body]), new Map(), new Set(['v0']), new Set([outside]))).toBe(false);
    expect(h.loopEscapeHazard(new Set([body]), new Map(), new Set(['v0']), new Set([elsewhere]))).toBe(true);
  });

  test('an escaping body-block param with a clobbered name fires; a loop-carried param is exempt', () => {
    const p = v();
    const body: Block = { params: [p], ops: [] };
    const outside: Block = { params: [], ops: [] };
    const h = make({
      varName: new Map([[p, 'v0']]),
      useSitesOf: new Map([[p, [use(outside)]]]),
    });
    expect(h.loopEscapeHazard(new Set([body]), new Map(), new Set(['v0']))).toBe(true);
    expect(h.loopEscapeHazard(new Set([body]), new Map(), new Set(['v0']), null, new Set([p]))).toBe(false);
  });
});

describe('loopUpdateHazard (the composition)', () => {
  test('fires on a clobbered condition, a clobbered exit arg, or an escape — clean otherwise', () => {
    const cond = v();
    const arg = v();
    const h = make({
      varName: new Map([
        [cond, 'v0'],
        [arg, 'v1'],
      ]),
    });
    const none: Set<Block> = new Set();
    expect(h.loopUpdateHazard(cond, [], none, new Map(), new Set(['v0']), null, new Set())).toBe(true);
    expect(h.loopUpdateHazard(cond, [arg], none, new Map(), new Set(['v1']), null, new Set())).toBe(true);
    expect(h.loopUpdateHazard(cond, [arg], none, new Map(), new Set(['v9']), null, new Set())).toBe(false);
  });
});
