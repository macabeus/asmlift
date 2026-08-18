// UNIT tests for the loop-emission hazard checks (structure/hazards.ts) — the soundness
// predicates that decide "emit this loop form" vs "decline loud". Extracted from structure()
// precisely so they can be tested like this: a handful of hand-built values and maps, no CFG,
// no parse, no pipeline. The end-to-end decline behavior stays pinned in structure-guard.test.ts
// (PREUPDATE_READ_HAZARD); these pin the predicate logic itself, case by case.
import { describe, expect, test } from 'vitest';

import { Block, Op, Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { without } from '../src/l3/gates';
import type { UseSite } from '../src/structure/analysis';
import { PREUPDATE_SINK_GATES, makeLoopHazards, updateWriteSet } from '../src/structure/hazards';

const v = (): Value => mkValue(T.s(32));

interface Fixture {
  defs?: Map<Value, Op>;
  varName?: Map<Value, string>;
  useSitesOf?: Map<Value, UseSite[]>;
  liveIn?: Map<Block, Set<Value>>;
  opBlock?: Map<Op, Block>;
}
const make = (f: Fixture = {}) =>
  makeLoopHazards({
    defs: f.defs ?? new Map(),
    varName: f.varName ?? new Map(),
    useSitesOf: f.useSitesOf ?? new Map(),
    liveIn: f.liveIn ?? new Map(),
    opBlock: f.opBlock ?? new Map(),
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

describe('sinkablePreUpdateSlots', () => {
  // A self-loop carrying one variable (`p`, named v0, updated every iteration) whose exit edge
  // ALSO hands its pre-update value to a merge param (`q`, named v1) — the trailing-variable
  // shape. The per-candidate refusals ABLATE one gate from the real table and re-run the real
  // predicate, so a gate that has stopped doing anything cannot go unnoticed; the two edge-level
  // rules are not in the table and are exercised directly.
  const scaffold = () => {
    const p = v();
    const q = v();
    const header: Block = { params: [p], ops: [] };
    const exit: Block = { params: [q], ops: [] };
    return { p, q, header, exit, body: new Set([header]) };
  };
  const names = (...pairs: [Value, string][]) => new Map(pairs);
  const empty = new Map<Value, string>();

  test('an exit arg that IS a loop variable, into a name of its own, is sinkable', () => {
    const { p, q, header, exit, body } = scaffold();
    const h = make({ varName: names([p, 'v0'], [q, 'v1']), liveIn: new Map([[header, new Set<Value>()]]) });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, empty, new Set(['v0']))).toEqual(new Set([0]));
  });

  test('an arg the update does NOT clobber has no hazard to repair', () => {
    const { p, q, header, exit, body } = scaffold();
    const h = make({ varName: names([p, 'v0'], [q, 'v1']), liveIn: new Map([[header, new Set<Value>()]]) });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, empty, new Set(['v9']))).toEqual(new Set());
  });

  test('ablating arg-is-loop-variable admits a computed exit arg', () => {
    const { p, q, header, exit, body } = scaffold();
    const e = v();
    const op = mkOp('add', { operands: [p], results: [e] });
    const h = make({
      defs: new Map([[e, op]]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    const args = [e];
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, empty, new Set(['v0']))).toEqual(new Set());
    const ablated = without(PREUPDATE_SINK_GATES, 'arg-is-loop-variable');
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, empty, new Set(['v0']), ablated)).toEqual(new Set([0]));
  });

  test('ablating dest-not-loop-variable admits a self-assignment', () => {
    const { p, q, header, exit, body } = scaffold();
    // `q` shares the loop variable's name, so the sunk copy would read `v0 = v0`.
    const h = make({ varName: names([p, 'v0'], [q, 'v0']), liveIn: new Map([[header, new Set<Value>()]]) });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, empty, new Set(['v0']))).toEqual(new Set());
    const ablated = without(PREUPDATE_SINK_GATES, 'dest-not-loop-variable');
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, empty, new Set(['v0']), ablated)).toEqual(new Set([0]));
  });

  test('ablating dest-free-inside-loop admits a name the loop still reads', () => {
    const { p, q, header, exit, body } = scaffold();
    const other = v();
    const h = make({
      varName: names([p, 'v0'], [q, 'v1'], [other, 'v1']),
      liveIn: new Map([[header, new Set([other])]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, empty, new Set(['v0']))).toEqual(new Set());
    const ablated = without(PREUPDATE_SINK_GATES, 'dest-free-inside-loop');
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, empty, new Set(['v0']), ablated)).toEqual(new Set([0]));
  });

  test('a value under the destination name DEFINED in the body counts as busy too', () => {
    const { p, q, header, exit, body } = scaffold();
    const other = v();
    const op = mkOp('add', { results: [other] });
    header.ops.push(op);
    const h = make({
      defs: new Map([[other, op]]),
      opBlock: new Map([[op, header]]),
      varName: names([p, 'v0'], [q, 'v1'], [other, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, empty, new Set(['v0']))).toEqual(new Set());
  });

  test('two slots wanting ONE name refuse the whole edge (one parallel copy)', () => {
    // Not a per-candidate gate either: no single slot is at fault. Both would write `v1`, and the
    // body cannot run two copies into one name and still carry both values.
    const { p, q, header, exit, body } = scaffold();
    const p2 = v();
    const other = v();
    header.params.push(p2);
    exit.params.push(other);
    const h = make({
      varName: names([p, 'v0'], [p2, 'v9'], [q, 'v1'], [other, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p, p2], body, empty, new Set(['v0', 'v9']))).toEqual(new Set());
  });

  test('a slot that STAYS BEHIND reading a sunk name refuses the whole edge (one parallel copy)', () => {
    // Not a per-candidate gate: it is a property of the edge, so it is not in the table.
    const { p, q, header, exit, body } = scaffold();
    const stay = v();
    const e = v();
    const op = mkOp('add', { operands: [q], results: [e] });
    exit.params.push(stay);
    const h = make({
      defs: new Map([[e, op]]),
      varName: names([p, 'v0'], [q, 'v1'], [stay, 'v2']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p, e], body, empty, new Set(['v0']))).toEqual(new Set());
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
