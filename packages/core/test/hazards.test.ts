// UNIT tests for the loop-emission hazard checks (structure/hazards.ts) — the soundness
// predicates that decide "emit this loop form" vs "decline loud". Extracted from structure()
// precisely so they can be tested like this: a handful of hand-built values and maps, no CFG,
// no parse, no pipeline. The end-to-end decline behavior stays pinned in structure-guard.test.ts
// (PREUPDATE_READ_HAZARD); these pin the predicate logic itself, case by case.
import { describe, expect, test } from 'vitest';

import { Block, Op, Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import type { Stmt } from '../src/l3/ast';
import { type Gate, without } from '../src/l3/gates';
import type { UseSite } from '../src/structure/analysis';
import {
  PREUPDATE_COND_GATES,
  PREUPDATE_SINK_GATES,
  type PreUpdateCondCandidate,
  SHORT_CIRCUIT_ARMS,
  type SinkCandidate,
  makeLoopHazards,
  sunkCopyOverDroppedUndef,
  updateWriteSet,
} from '../src/structure/hazards';
import { ARITH_TO_BIN } from '../src/structure/structure';

const v = (): Value => mkValue(T.s(32));

interface Fixture {
  defs?: Map<Value, Op>;
  varName?: Map<Value, string>;
  useSitesOf?: Map<Value, UseSite[]>;
  liveIn?: Map<Block, Set<Value>>;
  opBlock?: Map<Op, Block>;
  materialize?: Set<Op>;
  respelledDefs?: Map<Op, unknown>;
}
// `emitPos` as analysis.ts answers it, over the fixture's maps: an op renders at its own index when
// it is a statement — a store, a terminator, a named def, a dead one — and otherwise at the one
// consumer it is inlined into.
const emitPosOver =
  (useSitesOf: Map<Value, UseSite[]>, opBlock: Map<Op, Block>, materialize: Set<Op>) =>
  (op: Op): { blk: Block; idx: number } | null => {
    for (let cur = op; ;) {
      const r = cur.results[0];
      const uses = r === undefined ? [] : (useSitesOf.get(r) ?? []);
      if (
        cur.successors.length > 0 ||
        cur.opcode === 'store' ||
        cur.opcode === 'astore' ||
        materialize.has(cur) ||
        !uses.length
      ) {
        const blk = opBlock.get(cur);
        return blk === undefined ? null : { blk, idx: blk.ops.indexOf(cur) };
      }
      const consumers = new Set(uses.map((u) => u.op));
      if (consumers.size !== 1) {
        return null;
      }
      cur = [...consumers][0];
    }
  };
const make = (f: Fixture = {}) => {
  const useSitesOf = f.useSitesOf ?? new Map();
  const opBlock = f.opBlock ?? new Map();
  const materialize = f.materialize ?? new Set();
  return makeLoopHazards({
    defs: f.defs ?? new Map(),
    varName: f.varName ?? new Map(),
    useSitesOf,
    liveIn: f.liveIn ?? new Map(),
    opBlock,
    materialize,
    respelledDefs: f.respelledDefs ?? new Map(),
    emitPos: emitPosOver(useSitesOf, opBlock, materialize),
  });
};

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

  test('an escaping body-block param with a clobbered name fires', () => {
    const p = v();
    const body: Block = { params: [p], ops: [] };
    const outside: Block = { params: [], ops: [] };
    const h = make({
      varName: new Map([[p, 'v0']]),
      useSitesOf: new Map([[p, [use(outside)]]]),
    });
    expect(h.loopEscapeHazard(new Set([body]), new Map(), new Set(['v0']))).toBe(true);
  });

  // ONE RULE FOR EVERY BODY PARAM. A loop's own carried params used to be exempt outright, and
  // that was a silent miscompile: post-loop the updated name holds the value the test failed on,
  // while the PARAM meant the value at the top of that last iteration. `sub` maps the back-edge
  // arg, not the param, so nothing else in the pipeline reconciles them.
  test('a param the loop carries is judged by the same rule as any other — no exemption', () => {
    const p = v();
    const header: Block = { params: [p], ops: [] };
    const outside: Block = { params: [], ops: [] };
    const inside = (uses: Block[]) =>
      make({ varName: new Map([[p, 'v0']]), useSitesOf: new Map([[p, uses.map(use)]]) });

    // read AFTER the loop, under a name the update writes: stale, and it declines. The exemption
    // this replaced returned false here, and the emitted C stored `i` where the asm stored `i-1`.
    expect(inside([outside]).loopEscapeHazard(new Set([header]), new Map(), new Set(['v0']))).toBe(true);
    // read only inside the body: nothing reads the moved-on name, so it is safe
    expect(inside([header]).loopEscapeHazard(new Set([header]), new Map(), new Set(['v0']))).toBe(false);
    // read after the loop under a name the update does NOT write: nothing moved, so it is safe
    expect(inside([outside]).loopEscapeHazard(new Set([header]), new Map(), new Set(['v9']))).toBe(false);
  });

  // naming is still in progress here, so a param can arrive with no name; `updateWrites` holds names
  test('a param with no adopted name is not a hazard', () => {
    const p = v();
    const body: Block = { params: [p], ops: [] };
    const outside: Block = { params: [], ops: [] };
    const h = make({ varName: new Map(), useSitesOf: new Map([[p, [use(outside)]]]) });
    expect(h.loopEscapeHazard(new Set([body]), new Map(), new Set(['v0']))).toBe(false);
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
    // One-block body, so the header IS the latch — the block the copy is rebuilt inside.
    return { p, q, header, exit, latch: header, body: new Set([header]) };
  };
  const names = (...pairs: [Value, string][]) => new Map(pairs);
  const empty = new Map<Value, string>();

  test('an exit arg that IS a loop variable, into a name of its own, is sinkable', () => {
    const { p, q, header, exit, latch, body } = scaffold();
    const h = make({ varName: names([p, 'v0'], [q, 'v1']), liveIn: new Map([[header, new Set<Value>()]]) });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']))).toEqual(
      new Map([[0, null]]),
    );
  });

  test('an arg the update does NOT clobber has no hazard to repair', () => {
    const { p, q, header, exit, latch, body } = scaffold();
    const h = make({ varName: names([p, 'v0'], [q, 'v1']), liveIn: new Map([[header, new Set<Value>()]]) });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v9']))).toEqual(new Map());
  });

  // The arg's def-tree, rebuilt inside the body. `bodyOp` registers an op the way analysis.ts does,
  // so `definedInBody` sees it where the fixture says it is.
  const bodyOp = (header: Block, op: Op) => {
    header.ops.push(op);
    return op;
  };

  test('an exit arg COMPUTED from the loop variable by pure arithmetic is sinkable', () => {
    const { p, q, header, exit, latch, body } = scaffold();
    const e = v();
    const op = bodyOp(header, mkOp('add', { operands: [p], results: [e] }));
    const h = make({
      defs: new Map([[e, op]]),
      opBlock: new Map([[op, header]]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']))).toEqual(
      new Map([[0, op]]),
    );
  });

  test('ablating arg-safe-to-reevaluate admits an exit arg whose read crosses a store', () => {
    const { p, q, header, exit, latch, body } = scaffold();
    const rd = v();
    const e = v();
    // `q = *p + p` on the exit edge, with a STORE to the loaded cell between the load and the add
    // the copy is rebuilt at. It writes a value the load did not produce, so the rebuilt load runs
    // after it and answers with what it wrote, where the edge read what stood there before it — an
    // ablation that admits this slot emits a WRONG value, not merely a differently-spelled one.
    const rdOp = bodyOp(
      header,
      mkOp('load', { operands: [p], results: [rd], attrs: { off: 0, width: 4, signed: true } }),
    );
    bodyOp(header, mkOp('store', { operands: [p, p], attrs: { off: 0, width: 4 } }));
    const op = bodyOp(header, mkOp('add', { operands: [rd, p], results: [e] }));
    const h = make({
      defs: new Map([
        [rd, rdOp],
        [e, op],
      ]),
      opBlock: new Map([
        [rdOp, header],
        [op, header],
      ]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    const args = [e];
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'arg-safe-to-reevaluate');
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, op]]),
    );
  });

  test('the same read with NOTHING between it and the copy is rebuilt where it already ran', () => {
    // The one-fact edit: drop the store. The load then sits immediately before the add the copy
    // lands at, so re-evaluating it there moves it past nothing and it cannot answer differently —
    // `arg-safe-to-reevaluate` asks about the MOTION, not about the opcode.
    const { p, q, header, exit, latch, body } = scaffold();
    const rd = v();
    const e = v();
    const rdOp = bodyOp(
      header,
      mkOp('load', { operands: [p], results: [rd], attrs: { off: 0, width: 4, signed: true } }),
    );
    const op = bodyOp(header, mkOp('add', { operands: [rd, p], results: [e] }));
    const h = make({
      defs: new Map([
        [rd, rdOp],
        [e, op],
      ]),
      opBlock: new Map([
        [rdOp, header],
        [op, header],
      ]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']))).toEqual(
      new Map([[0, op]]),
    );
  });

  test('a read the LATCH did not compute keeps the blanket refusal', () => {
    // Two-block body, the arg computed in the other one: the copy has no position to be rebuilt at
    // and opens the body instead, which moves the load across whole blocks this predicate does not
    // walk. Refused wherever the ops happen to sit, and the ablation says which gate did it.
    const { p, q, header, exit, latch } = scaffold();
    const rd = v();
    const e = v();
    const rdOp = mkOp('load', { operands: [p], results: [rd], attrs: { off: 0, width: 4, signed: true } });
    const op = mkOp('add', { operands: [rd, p], results: [e] });
    const mid: Block = { params: [], ops: [rdOp, op] };
    const body = new Set([header, mid]);
    const h = make({
      defs: new Map([
        [rd, rdOp],
        [e, op],
      ]),
      opBlock: new Map([
        [rdOp, mid],
        [op, mid],
      ]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'arg-safe-to-reevaluate');
    expect(h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, null]]),
    );
  });

  test('a read from ANOTHER body block is refused even though the arg itself is a latch op', () => {
    // The tree straddles two blocks: the load is in `mid`, the add that computes the arg is in the
    // latch, so the copy HAS a position and the blanket refusal does not apply. Rebuilt there the
    // load moves across whole blocks — everything `mid` and the latch do between it and the add —
    // which the between-scan does not walk and cannot bound. The one-fact control puts the same
    // load in the latch next to its consumer, where it moves past nothing and is admitted.
    const { p, q, header, exit, latch } = scaffold();
    const rd = v();
    const e = v();
    const rdOp = mkOp('load', { operands: [p], results: [rd], attrs: { off: 0, width: 4, signed: true } });
    const mid: Block = { params: [], ops: [rdOp] };
    const op = bodyOp(header, mkOp('add', { operands: [rd, p], results: [e] }));
    const body = new Set([header, mid]);
    const deps = {
      defs: new Map([
        [rd, rdOp],
        [e, op],
      ]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    };
    const split = make({
      ...deps,
      opBlock: new Map([
        [rdOp, mid],
        [op, header],
      ]),
    });
    const args = [e];
    expect(split.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'arg-safe-to-reevaluate');
    expect(split.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, op]]),
    );
    header.ops.unshift(rdOp);
    const together = make({
      ...deps,
      opBlock: new Map([
        [rdOp, header],
        [op, header],
      ]),
    });
    expect(together.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']))).toEqual(
      new Map([[0, op]]),
    );
  });

  test('ablating arg-reads-current-names admits an arg over a body-computed name', () => {
    const { p, q, header, exit, latch, body } = scaffold();
    const mid = v();
    const e = v();
    // `mid` is NAMED and defined in the body, and its def is not one the analysis materialized, so
    // nothing says a statement writing `v2` renders at its index — the gate refuses on the NAME. Here
    // the place would have been safe — the copy lands at `op`, one op after `mid` is computed — so
    // what the ablation admits is a conservative refusal, not a wrong value. The fixture below is
    // the one where the admitted copy really does read the previous iteration. The loop variable is
    // in the tree as well, which is what makes the slot a repair candidate in the first place.
    const midOp = bodyOp(header, mkOp('add', { operands: [p], results: [mid] }));
    const op = bodyOp(header, mkOp('add', { operands: [mid, p], results: [e] }));
    const h = make({
      defs: new Map([
        [mid, midOp],
        [e, op],
      ]),
      opBlock: new Map([
        [midOp, header],
        [op, header],
      ]),
      varName: names([p, 'v0'], [q, 'v1'], [mid, 'v2']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    const args = [e];
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'arg-reads-current-names');
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, op]]),
    );
  });

  test('ablating arg-reads-current-names admits a copy that reads the PREVIOUS iteration', () => {
    // The same stale name with the copy homed at `leading`: the arg is computed in a body block the
    // latch is not, so the copy opens the body — AHEAD of the statement that writes `v2` on this
    // iteration. Ablated, the sink emits `v1 = v2 + v0` there, carrying the value `v2` held one
    // iteration back, which is a wrong value rather than a differently-spelled one.
    const { p, q, header, exit, latch } = scaffold();
    const mid = v();
    const e = v();
    const midOp = mkOp('add', { operands: [p], results: [mid] });
    const op = mkOp('add', { operands: [mid, p], results: [e] });
    const arm: Block = { params: [], ops: [midOp, op] };
    const body = new Set([header, arm]);
    const h = make({
      defs: new Map([
        [mid, midOp],
        [e, op],
      ]),
      opBlock: new Map([
        [midOp, arm],
        [op, arm],
      ]),
      varName: names([p, 'v0'], [q, 'v1'], [mid, 'v2']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    const args = [e];
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'arg-reads-current-names');
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, null]]),
    );
  });

  // A DEF NAMED AHEAD OF THE HOME IS CURRENT THERE. The shape is `preupdate_exit_order`'s once the
  // analysis names its call: `v2 = cb(v0); v1 = *v0 + v2;`, the copy homed at the add, and the
  // statement writing `v2` rendered one index earlier on the same iteration; a read named there is
  // current the same way. Each control changes ONE fact and is refused at `arg-reads-current-names`,
  // which its own ablation then admits.
  const namedAhead = (edit: { after?: boolean; unnamed?: boolean; otherBlock?: boolean; load?: boolean } = {}) => {
    const { p, q, header, exit, latch } = scaffold();
    const mid = v();
    const e = v();
    const midOp = edit.load
      ? mkOp('load', { operands: [p], results: [mid], attrs: { off: 0, width: 4, signed: true } })
      : mkOp('call', { operands: [p], results: [mid], attrs: { target: 'cb' } });
    const op = mkOp('add', { operands: [mid, p], results: [e] });
    const arm: Block = { params: [], ops: [] };
    if (edit.otherBlock) {
      arm.ops.push(midOp);
      header.ops.push(op);
    } else {
      header.ops.push(...(edit.after ? [op, midOp] : [midOp, op]));
    }
    const body = new Set([header, arm]);
    const h = make({
      defs: new Map([
        [mid, midOp],
        [e, op],
      ]),
      opBlock: new Map([
        [midOp, edit.otherBlock ? arm : header],
        [op, header],
      ]),
      materialize: edit.unnamed ? new Set() : new Set([midOp]),
      varName: names([p, 'v0'], [q, 'v1'], [mid, 'v2']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    const run = (gates?: readonly Gate<SinkCandidate>[]) =>
      h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']), gates);
    return { op, run };
  };

  test.each([
    ['a call', {}],
    ['a read', { load: true }],
  ])('%s named ahead of the home is current there', (_, edit) => {
    const { op, run } = namedAhead(edit);
    expect(run()).toEqual(new Map([[0, op]]));
  });

  test.each([
    ['written AFTER the home', { after: true }],
    ['not a def the analysis named', { unnamed: true }],
    ['written in another body block', { otherBlock: true }],
  ])('a body name %s still refuses at arg-reads-current-names', (_, edit) => {
    const { op, run } = namedAhead(edit);
    expect(run()).toEqual(new Map());
    expect(run(without(PREUPDATE_SINK_GATES, 'arg-reads-current-names'))).toEqual(new Map([[0, op]]));
  });

  test('a tree that spells a call of its own is ordered like any other member', () => {
    // The same name ahead of the home, under a tree that inlines a second call: `v2 = cb(v0); v1 =
    // v2 + cb2(v0) + v0;`. The second call is rebuilt at the home with nothing order-sensitive
    // between it and there, and the first renders at its own index, ahead of both — the asm's order.
    const { p, q, header, exit, latch } = scaffold();
    const mid = v();
    const c2 = v();
    const s2 = v();
    const e = v();
    const midOp = bodyOp(header, mkOp('call', { operands: [p], results: [mid], attrs: { target: 'cb' } }));
    const c2Op = bodyOp(header, mkOp('call', { operands: [p], results: [c2], attrs: { target: 'cb2' } }));
    const s2Op = bodyOp(header, mkOp('add', { operands: [mid, c2], results: [s2] }));
    const op = bodyOp(header, mkOp('add', { operands: [s2, p], results: [e] }));
    const h = make({
      defs: new Map([
        [mid, midOp],
        [c2, c2Op],
        [s2, s2Op],
        [e, op],
      ]),
      opBlock: new Map([
        [midOp, header],
        [c2Op, header],
        [s2Op, header],
        [op, header],
      ]),
      materialize: new Set([midOp]),
      varName: names([p, 'v0'], [q, 'v1'], [mid, 'v2']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [e], new Set([header]), latch, empty, new Set(['v0']))).toEqual(
      new Map([[0, op]]),
    );
  });

  // AN OP AHEAD OF A MEMBER THAT RENDERS BEHIND THE HOME. `c = cb(v0); r = *v0 + v0; *v0 = c + 1;`
  // in the asm: the call runs first, and is inlined into the store two statements down. The load
  // rebuilt at the add would run ahead of it — nothing lies BETWEEN the load and the home, and the
  // crossing is only visible where the call renders. Named, the call renders at its own index and
  // the order holds. Two READS commute: a load ahead of a rebuilt load crosses nothing, while the
  // same load ahead of a rebuilt call still does.
  const aheadRendersBehind = (
    callNamed: boolean,
    ahead: 'call' | 'load' = 'call',
    member: 'call' | 'load' = 'load',
  ) => {
    const { p, q, header, exit, latch, body } = scaffold();
    const c = v();
    const rd = v();
    const e = v();
    const s = v();
    const access = (kind: 'call' | 'load', r: Value, off: number) =>
      kind === 'call'
        ? mkOp('call', { operands: [p], results: [r], attrs: { target: 'cb' } })
        : mkOp('load', { operands: [p], results: [r], attrs: { off, width: 4, signed: true } });
    const cOp = bodyOp(header, access(ahead, c, 4));
    const rdOp = bodyOp(header, access(member, rd, 0));
    const op = bodyOp(header, mkOp('add', { operands: [rd, p], results: [e] }));
    const sOp = bodyOp(header, mkOp('add', { operands: [c], results: [s] }));
    const stOp = bodyOp(header, mkOp('store', { operands: [p, s], attrs: { off: 0, width: 4 } }));
    const h = make({
      defs: new Map([
        [c, cOp],
        [rd, rdOp],
        [e, op],
        [s, sOp],
      ]),
      opBlock: new Map([
        [cOp, header],
        [rdOp, header],
        [op, header],
        [sOp, header],
        [stOp, header],
      ]),
      useSitesOf: new Map([
        [c, [{ blk: header, idx: 3, op: sOp }]],
        [s, [{ blk: header, idx: 4, op: stOp }]],
      ]),
      materialize: callNamed ? new Set([cOp]) : new Set(),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    return {
      op,
      run: (gates?: readonly Gate<SinkCandidate>[]) =>
        h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']), gates),
    };
  };

  test('a member is refused when an op ahead of it renders behind the home', () => {
    const { op, run } = aheadRendersBehind(false);
    expect(run()).toEqual(new Map());
    expect(run(without(PREUPDATE_SINK_GATES, 'arg-safe-to-reevaluate'))).toEqual(new Map([[0, op]]));
    const named = aheadRendersBehind(true);
    expect(named.run()).toEqual(new Map([[0, named.op]]));
  });

  test('a read ahead of a rebuilt read crosses nothing, and ahead of a rebuilt call it does', () => {
    const reads = aheadRendersBehind(false, 'load', 'load');
    expect(reads.run()).toEqual(new Map([[0, reads.op]]));
    expect(aheadRendersBehind(false, 'load', 'call').run()).toEqual(new Map());
  });

  test('a latch def ahead of the home under a LOOP VARIABLE name still refuses', () => {
    // The in-place adoption: the def writes the loop variable's own name, which the update also
    // writes — the other conjunct of the gate, which the position does not answer.
    const { p, q, header, exit, latch } = scaffold();
    const mid = v();
    const e = v();
    const midOp = bodyOp(header, mkOp('call', { operands: [p], results: [mid], attrs: { target: 'cb' } }));
    const op = bodyOp(header, mkOp('add', { operands: [mid, p], results: [e] }));
    const h = make({
      defs: new Map([
        [mid, midOp],
        [e, op],
      ]),
      opBlock: new Map([
        [midOp, header],
        [op, header],
      ]),
      materialize: new Set([midOp]),
      varName: names([p, 'v0'], [q, 'v1'], [mid, 'v0']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    const run = (gates?: readonly Gate<SinkCandidate>[]) =>
      h.sinkablePreUpdateSlots(header, exit, [e], new Set([header]), latch, empty, new Set(['v0']), gates);
    expect(run()).toEqual(new Map());
    expect(run(without(PREUPDATE_SINK_GATES, 'arg-reads-current-names'))).toEqual(new Map([[0, op]]));
  });

  test('a latch def ahead of the home under a name ANOTHER loop value answers to still refuses', () => {
    // `other` is live into the loop under `v2`, so the name has two writers and the position of
    // one of them says nothing about which value it holds at the copy.
    const { p, q, header, exit, latch } = scaffold();
    const mid = v();
    const other = v();
    const e = v();
    const midOp = bodyOp(header, mkOp('call', { operands: [p], results: [mid], attrs: { target: 'cb' } }));
    const op = bodyOp(header, mkOp('add', { operands: [mid, p], results: [e] }));
    const h = make({
      defs: new Map([
        [mid, midOp],
        [e, op],
      ]),
      opBlock: new Map([
        [midOp, header],
        [op, header],
      ]),
      materialize: new Set([midOp]),
      varName: names([p, 'v0'], [q, 'v1'], [mid, 'v2'], [other, 'v2']),
      liveIn: new Map([[header, new Set<Value>([other])]]),
    });
    const run = (gates?: readonly Gate<SinkCandidate>[]) =>
      h.sinkablePreUpdateSlots(header, exit, [e], new Set([header]), latch, empty, new Set(['v0']), gates);
    expect(run()).toEqual(new Map());
    expect(run(without(PREUPDATE_SINK_GATES, 'arg-reads-current-names'))).toEqual(new Map([[0, op]]));
  });

  // TWO SLOTS, ONE TREE. The exit edge hands `e = cb(p) + p` to two merge params, so each sunk copy
  // rebuilds it: for a READ that is one extra load, for a CALL it is `cb` run twice per iteration.
  // Nothing here refuses the call: the analysis names a call that rides an edge copy, so it never
  // reaches the sink inlined (loop-preupdate-sink.test.ts), and both kinds sink both slots here.
  const twoSlots = (opcode: 'call' | 'load') => {
    const { p, q, header, exit, latch, body } = scaffold();
    const q2 = v();
    exit.params.push(q2);
    const rd = v();
    const e = v();
    const rdOp = bodyOp(
      header,
      opcode === 'call'
        ? mkOp('call', { operands: [p], results: [rd], attrs: { target: 'cb' } })
        : mkOp('load', { operands: [p], results: [rd], attrs: { off: 0, width: 4, signed: true } }),
    );
    const op = bodyOp(header, mkOp('add', { operands: [rd, p], results: [e] }));
    const h = make({
      defs: new Map([
        [rd, rdOp],
        [e, op],
      ]),
      opBlock: new Map([
        [rdOp, header],
        [op, header],
      ]),
      varName: names([p, 'v0'], [q, 'v1'], [q2, 'v2']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    return { op, run: () => h.sinkablePreUpdateSlots(header, exit, [e, e], body, latch, empty, new Set(['v0'])) };
  };

  test.each(['call', 'load'] as const)('two slots sharing one inlined %s both sink', (opcode) => {
    const { op, run } = twoSlots(opcode);
    expect(run()).toEqual(
      new Map([
        [0, op],
        [1, op],
      ]),
    );
  });

  test('the two arg gates are a PARTITION — ablating one does not disable the other', () => {
    // `add(mid, *p)` with a store in between trips both: a body-computed name AND a memory read the
    // copy's position is on the far side of — the store writes the loop variable rather than the
    // value just loaded, so the far side really does answer differently. Each gate must still
    // refuse it with the other one dropped — otherwise ablating either measures less than its
    // name says, and a walk that reported only the first blocker it found would do exactly that.
    const { p, q, header, exit, latch, body } = scaffold();
    const mid = v();
    const rd = v();
    const e = v();
    const midOp = bodyOp(header, mkOp('add', { operands: [p], results: [mid] }));
    const rdOp = bodyOp(
      header,
      mkOp('load', { operands: [p], results: [rd], attrs: { off: 0, width: 4, signed: true } }),
    );
    bodyOp(header, mkOp('store', { operands: [p, p], attrs: { off: 0, width: 4 } }));
    const op = bodyOp(header, mkOp('add', { operands: [mid, rd], results: [e] }));
    const h = make({
      defs: new Map([
        [mid, midOp],
        [rd, rdOp],
        [e, op],
      ]),
      opBlock: new Map([
        [midOp, header],
        [rdOp, header],
        [op, header],
      ]),
      varName: names([p, 'v0'], [q, 'v1'], [mid, 'v2']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    const args = [e];
    const run = (gates?: readonly Gate<SinkCandidate>[]) =>
      h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']), gates);
    expect(run()).toEqual(new Map());
    expect(run(without(PREUPDATE_SINK_GATES, 'arg-reads-current-names'))).toEqual(new Map());
    expect(run(without(PREUPDATE_SINK_GATES, 'arg-safe-to-reevaluate'))).toEqual(new Map());
  });

  test('a leaf with neither a name nor a definition is refused on its own gate', () => {
    // Nothing to rebuild it from: `exprWith` would spell a gap. Filed under its own id so the
    // contract report does not attribute it to the previous-iteration rule, which is a different
    // fact about a different leaf.
    const { p, q, header, exit, latch, body } = scaffold();
    const orphan = v();
    const e = v();
    const op = bodyOp(header, mkOp('add', { operands: [p, orphan], results: [e] }));
    const h = make({
      defs: new Map([[e, op]]),
      opBlock: new Map([[op, header]]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    const args = [e];
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'arg-has-a-definition');
    expect(h.sinkablePreUpdateSlots(header, exit, args, body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, op]]),
    );
  });

  test('an arg reading a name the loop itself carries under another value is refused', () => {
    // `out` is defined OUTSIDE the loop but shares the loop variable's name, so at the top of the
    // body that name holds this iteration's value rather than the one the edge read.
    const { p, q, header, exit, latch, body } = scaffold();
    const out = v();
    const e = v();
    const op = bodyOp(header, mkOp('add', { operands: [out], results: [e] }));
    const outOp = mkOp('const', { results: [out], attrs: { value: 7 } });
    const pre: Block = { params: [], ops: [outOp] }; // outside the loop, so only the NAME refuses
    const h = make({
      defs: new Map([
        [out, outOp],
        [e, op],
      ]),
      opBlock: new Map([
        [op, header],
        [outOp, pre],
      ]),
      varName: names([p, 'v0'], [q, 'v1'], [out, 'v0']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']))).toEqual(new Map());
  });

  test('ablating dest-not-loop-variable admits a self-assignment', () => {
    const { p, q, header, exit, latch, body } = scaffold();
    // `q` shares the loop variable's name, so the sunk copy would read `v0 = v0`.
    const h = make({ varName: names([p, 'v0'], [q, 'v0']), liveIn: new Map([[header, new Set<Value>()]]) });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'dest-not-loop-variable');
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, null]]),
    );
  });

  test('a BLOCK PARAM inside the body under the destination name counts as busy', () => {
    // THE SHAPE THE UNDEF EDGE-COPY ELISION LEANS ON (structure.ts, undefCarriesNothing). A merge
    // INSIDE the loop that adopted the exit param's name is what would put a sunk copy at the top of
    // the body ahead of an undef edge into that same name — the one relocation `writesBefore` does
    // not model. `definedInBody` answers it through its BLOCK-PARAM branch (the value has no
    // defining op at all), so the sink refuses and the collision has no inhabitant. Pinned here
    // because that branch, not the loop's single-exit rule, is what actually refuses it.
    const { p, q, header, exit, latch } = scaffold();
    const other = v();
    const merge: Block = { params: [other], ops: [] };
    const body = new Set([header, merge]);
    const h = make({
      varName: names([p, 'v0'], [q, 'v1'], [other, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'dest-free-inside-loop');
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, null]]),
    );
  });

  test('ablating dest-free-inside-loop admits a name the loop still reads', () => {
    const { p, q, header, exit, latch, body } = scaffold();
    const other = v();
    const h = make({
      varName: names([p, 'v0'], [q, 'v1'], [other, 'v1']),
      liveIn: new Map([[header, new Set([other])]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'dest-free-inside-loop');
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, null]]),
    );
  });

  test('an UNNAMED value live into the header that renders through the destination name is busy', () => {
    // `k & 3`, hoisted ahead of the loop: it has no name of its own, so it is inlined inside the
    // body and reads `v1` there — a copy into `v1` sunk into the body would change what it reads.
    const { p, q, header, exit, latch, body } = scaffold();
    const k = v();
    const hoisted = v();
    const op = mkOp('and', { operands: [k], results: [hoisted] });
    const pre: Block = { params: [], ops: [op] };
    const h = make({
      defs: new Map([[hoisted, op]]),
      opBlock: new Map([[op, pre]]),
      varName: names([p, 'v0'], [q, 'v1'], [k, 'v1']),
      liveIn: new Map([[header, new Set([hoisted])]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']))).toEqual(new Map());
    const ablated = without(PREUPDATE_SINK_GATES, 'dest-free-inside-loop');
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']), ablated)).toEqual(
      new Map([[0, null]]),
    );
  });

  test('a value under the destination name DEFINED in the body counts as busy too', () => {
    const { p, q, header, exit, latch, body } = scaffold();
    const other = v();
    const op = mkOp('add', { results: [other] });
    header.ops.push(op);
    const h = make({
      defs: new Map([[other, op]]),
      opBlock: new Map([[op, header]]),
      varName: names([p, 'v0'], [q, 'v1'], [other, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p], body, latch, empty, new Set(['v0']))).toEqual(new Map());
  });

  test('two slots wanting ONE name refuse the whole edge (one parallel copy)', () => {
    // Not a per-candidate gate either: no single slot is at fault. Both would write `v1`, and the
    // body cannot run two copies into one name and still carry both values.
    const { p, q, header, exit, latch, body } = scaffold();
    const p2 = v();
    const other = v();
    header.params.push(p2);
    exit.params.push(other);
    const h = make({
      varName: names([p, 'v0'], [p2, 'v9'], [q, 'v1'], [other, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p, p2], body, latch, empty, new Set(['v0', 'v9']))).toEqual(
      new Map(),
    );
  });

  // WHERE the caller rebuilds each admitted copy. The position comes back WITH the permission: it
  // is what `arg-safe-to-reevaluate` judged the tree against, so an emitter that derived its own
  // would be free to place a copy at a point no gate cleared.
  test('an admitted slot carries the position it was cleared at', () => {
    // The arg's def is NOT the latch's first op — a store precedes it — so opening the body and
    // rebuilding at the def are two different program points.
    const { p, q, header, exit, latch, body } = scaffold();
    const e = v();
    bodyOp(header, mkOp('store', { operands: [p, p], attrs: { off: 0, width: 4 } }));
    const op = bodyOp(header, mkOp('shl', { operands: [p], results: [e] }));
    const h = make({
      defs: new Map([[e, op]]),
      opBlock: new Map([[op, header]]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']))).toEqual(
      new Map([[0, op]]),
    );
  });

  test('an arg the latch did not compute carries no position, and its copy opens the body', () => {
    // A pure def in another body block. The value HAS a position in the body, just not in the block
    // whose walk is handed the copies — the third of the three args that come back homed at null.
    const { p, q, header, exit, latch } = scaffold();
    const e = v();
    const op = mkOp('add', { operands: [p], results: [e] });
    const mid: Block = { params: [], ops: [op] };
    const body = new Set([header, mid]);
    const h = make({
      defs: new Map([[e, op]]),
      opBlock: new Map([[op, mid]]),
      varName: names([p, 'v0'], [q, 'v1']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [e], body, latch, empty, new Set(['v0']))).toEqual(
      new Map([[0, null]]),
    );
  });

  test('a slot that STAYS BEHIND reading a sunk name refuses the whole edge (one parallel copy)', () => {
    // Not a per-candidate gate: it is a property of the edge, so it is not in the table.
    const { p, q, header, exit, latch, body } = scaffold();
    const stay = v();
    const e = v();
    const op = mkOp('add', { operands: [q], results: [e] });
    exit.params.push(stay);
    const h = make({
      defs: new Map([[e, op]]),
      varName: names([p, 'v0'], [q, 'v1'], [stay, 'v2']),
      liveIn: new Map([[header, new Set<Value>()]]),
    });
    expect(h.sinkablePreUpdateSlots(header, exit, [p, e], body, latch, empty, new Set(['v0']))).toEqual(new Map());
  });
});

describe('preUpdateCondFold', () => {
  // The agbcc shape the fold exists for: a self-loop carrying `v1`, whose bottom test is
  // `v0 != 0 && v1 <= 9` — the second arm reading `v1` one update AHEAD of the copy at the foot of
  // the body. Everything the predicate weighs is a knob on it: which connective joins the arms,
  // which arm the variable is in, what the update spells, and who reads its result after the loop.
  //
  // Each refusal names the gate that answered, so an ablation measures the rule it names rather
  // than whatever happened to refuse first. All but one are a single knob turned on that shape;
  // `one-pre-update-variable` needs a second loop variable, which the scaffold has no room for, so
  // it builds its own.
  const nine = (): Value => v();
  const scaffold = (
    opts: { leftArm?: boolean; connective?: 'logic_and' | 'logic_or'; underNot?: boolean; callArm?: boolean } = {},
  ) => {
    const p = v(); // the loop variable, named v1
    const u = v(); // its back-edge arg — post-update, so `sub` maps it to the same name
    const other = v(); // the other arm's value, named v0 — or, with `callArm`, an inlined call
    const k = nine();
    const cmp = v();
    const zero = v();
    const ne = v();
    const cond = v();
    const cmpOp = mkOp('icmp_ule', { operands: [p, k], results: [cmp] });
    const neOp = mkOp('icmp_ne', { operands: [other, zero], results: [ne] });
    const arms = opts.leftArm === true ? [cmp, ne] : [ne, cmp];
    const condOp = mkOp(opts.connective ?? 'logic_and', { operands: arms, results: [cond] });
    const header: Block = { params: [p], ops: [] };
    const defs = new Map<Value, Op>([
      [cond, condOp],
      [cmp, cmpOp],
      [ne, neOp],
    ]);
    if (opts.callArm === true) {
      defs.set(other, mkOp('call', { operands: [v()], results: [other] }));
    }
    // `!(…)`: the connective is reached through an op that inverts it, so the arms it hands out
    // answer about the opposite edge of the loop from the one the walk is reading.
    const root = opts.underNot === true ? v() : cond;
    if (root !== cond) {
      defs.set(root, mkOp('icmp_eq', { operands: [cond, v()], results: [root] }));
    }
    return {
      p,
      u,
      cond: root,
      header,
      body: new Set([header]),
      defs,
      varName:
        opts.callArm === true
          ? new Map([[p, 'v1']])
          : new Map([
              [p, 'v1'],
              [other, 'v0'],
            ]),
      cmpOp,
    };
  };
  const step = (value: number): Stmt[] => [
    { k: 'assign', name: 'v1', value: { k: 'bin', op: '+', l: { k: 'var', name: 'v1' }, r: { k: 'const', value } } },
  ];
  const writes = new Set(['v1']);
  const ask = (
    f: ReturnType<typeof scaffold>,
    over: {
      updates?: Stmt[];
      useSitesOf?: Map<Value, UseSite[]>;
      respelledDefs?: Map<Op, unknown>;
      exitArgs?: Value[];
      gates?: readonly Gate<PreUpdateCondCandidate>[];
    } = {},
  ) =>
    make({
      defs: f.defs,
      varName: f.varName,
      useSitesOf: over.useSitesOf ?? new Map(),
      respelledDefs: over.respelledDefs ?? new Map(),
    }).preUpdateCondFold(
      f.cond,
      false,
      f.header,
      [f.u],
      over.exitArgs ?? [],
      f.body,
      new Map([[f.u, 'v1']]),
      over.updates ?? step(1),
      writes,
      over.gates,
    );

  test('the pre-update read in the second arm of an && folds into it', () => {
    expect(ask(scaffold())).toEqual({ name: 'v1', by: 1 });
  });

  test('a decrement folds as `--`', () => {
    const f = scaffold();
    expect(
      ask(f, {
        updates: [
          {
            k: 'assign',
            name: 'v1',
            value: { k: 'bin', op: '-', l: { k: 'var', name: 'v1' }, r: { k: 'const', value: 1 } },
          },
        ],
      }),
    ).toEqual({
      name: 'v1',
      by: -1,
    });
  });

  test('an update that is not a unit step has no operator to fold into', () => {
    expect(ask(scaffold(), { updates: step(2) })).toEqual({ refused: 'update-is-a-unit-step' });
  });

  test('ablating one-pre-update-variable repairs one variable and clobbers the other', () => {
    // `do { … } while (v1 <= 9 && v2 <= 9)`, the back edge carrying `v1 + 1` and `v2 + 1`. Only one
    // name can take the `++`, and a non-null answer switches off the caller's WHOLE condition
    // disjunct — so the other variable's pre-update read is emitted under its post-update name and
    // every hazard reports clean.
    const p1 = v();
    const p2 = v();
    const u1 = v();
    const u2 = v();
    const a = v();
    const b = v();
    const cond = v();
    const defs = new Map<Value, Op>([
      [a, mkOp('icmp_ule', { operands: [p1, v()], results: [a] })],
      [b, mkOp('icmp_ule', { operands: [p2, v()], results: [b] })],
      [cond, mkOp('logic_and', { operands: [a, b], results: [cond] })],
    ]);
    const header: Block = { params: [p1, p2], ops: [] };
    const both = (gates?: readonly Gate<PreUpdateCondCandidate>[]) =>
      make({
        defs,
        varName: new Map([
          [p1, 'v1'],
          [p2, 'v2'],
        ]),
      }).preUpdateCondFold(
        cond,
        false,
        header,
        [u1, u2],
        [],
        new Set([header]),
        new Map([
          [u1, 'v1'],
          [u2, 'v2'],
        ]),
        [
          ...step(1),
          {
            k: 'assign',
            name: 'v2',
            value: { k: 'bin', op: '+', l: { k: 'var', name: 'v2' }, r: { k: 'const', value: 1 } },
          },
        ],
        new Set(['v1', 'v2']),
        gates,
      );
    expect(both()).toEqual({ refused: 'one-pre-update-variable' });
    expect(both(without(PREUPDATE_COND_GATES, 'one-pre-update-variable'))).toEqual({ name: 'v1', by: 1 });
  });

  test('ablating update-is-a-unit-step declines rather than minting a step-less node', () => {
    // The gate is the census entry for the refusal; the `step !== null` at the return is what keeps
    // the node well formed, so the ablation measures the message and not the type.
    expect(
      ask(scaffold(), { updates: step(2), gates: without(PREUPDATE_COND_GATES, 'update-is-a-unit-step') }),
    ).toEqual({ refused: 'update-is-a-unit-step' });
  });

  test('a test with no pre-update read at all is not this predicate’s business', () => {
    const f = scaffold();
    // every leaf post-update: the condition reads the back-edge arg, which `sub` maps
    const post = make({ defs: f.defs, varName: f.varName }).preUpdateCondFold(
      f.u,
      false,
      f.header,
      [f.u],
      [],
      f.body,
      new Map([[f.u, 'v1']]),
      step(1),
      writes,
    );
    expect(post).toEqual({ refused: 'one-pre-update-variable' });
  });

  test('ablating test-is-readable folds through a respelled def', () => {
    // The `v1 <= 9` arm moves FIRST, so the variable is noted before the walk meets the opaque op —
    // and the opaque op is the other arm, whose rendering this walk never sees. It may name `v1`
    // again, which would make the emitted expression C89-undefined.
    const f = scaffold({ leftArm: true });
    const opaque = f.defs.get(f.cond)!.operands[1];
    const respelled = new Map<Op, unknown>([[[...f.defs].find(([val]) => val === opaque)![1], 'a global member read']]);
    expect(ask(f, { respelledDefs: respelled })).toEqual({ refused: 'test-is-readable' });
    expect(ask(f, { respelledDefs: respelled, gates: without(PREUPDATE_COND_GATES, 'test-is-readable') })).toEqual({
      name: 'v1',
      by: 1,
    });
  });

  test('ablating variable-named-once folds a test that reads the variable twice', () => {
    // `v1 != 0 && v1 <= 9`: both arms read the loop variable, and only one of them can carry the
    // `++`. The other read would then see whichever value the compiler chose — C89 leaves it open.
    const f = scaffold();
    const ne = f.defs.get(f.cond)!.operands[0];
    f.defs.set(ne, mkOp('icmp_ne', { operands: [f.p, v()], results: [ne] }));
    expect(ask(f)).toEqual({ refused: 'variable-named-once' });
    expect(ask(f, { gates: without(PREUPDATE_COND_GATES, 'variable-named-once') })).toEqual({ name: 'v1', by: 1 });
  });

  test('ablating connectives-join-at-the-root folds an arm of a negated &&', () => {
    // `!(v0 != 0 && v1 <= 9)`. Each arm function is about its OWN op's truth, so the `&&` says the
    // second arm runs whenever the `&&` is true — which the negation makes the iterations that
    // LEAVE. Folded there, the `++` is skipped on every iteration that re-enters while the back
    // edge still carries `v1 + 1`, and the loop asmlift emits does not terminate where the machine
    // terminates.
    const f = scaffold({ underNot: true });
    expect(ask(f)).toEqual({ refused: 'connectives-join-at-the-root' });
    expect(ask(f, { gates: without(PREUPDATE_COND_GATES, 'connectives-join-at-the-root') })).toEqual({
      name: 'v1',
      by: 1,
    });
  });

  test('the short-circuit arms are total over the ops that render as && and ||', () => {
    // The composition is valid only over ops the walk KNOWS short-circuit; one it does not passes
    // its own reach down unchanged, which for a connective is the permissive answer. Nothing else
    // couples the two tables, and `ARITH_TO_BIN` is where a new connective would be spelled.
    const renders = Object.entries(ARITH_TO_BIN)
      .filter(([, spelling]) => spelling === '&&' || spelling === '||')
      .map(([op]) => op);
    expect(Object.keys(SHORT_CIRCUIT_ARMS).sort()).toEqual(renders.sort());
  });

  test('ablating folded-on-every-continue folds a leaf under the right operand of an ||', () => {
    // `v0 != 0 || v1 <= 9` continues whenever the FIRST arm is true, on an iteration that never
    // evaluated the `++` — while the back edge still carries `v1 + 1`.
    const f = scaffold({ connective: 'logic_or' });
    expect(ask(f)).toEqual({ refused: 'folded-on-every-continue' });
    expect(ask(f, { gates: without(PREUPDATE_COND_GATES, 'folded-on-every-continue') })).toEqual({
      name: 'v1',
      by: 1,
    });
  });

  test('ablating folded-on-the-exit-too folds a leaf an exiting iteration skips', () => {
    // The same `&&` as the accepted case, with the updated value now READ after the loop. The
    // iteration that leaves on a false first arm never evaluates the `++`, so the name it leaves
    // behind is one short of what the back edge would have computed.
    const f = scaffold();
    const outside: Block = { params: [], ops: [] };
    const seen = new Map<Value, UseSite[]>([[f.u, [use(outside)]]]);
    expect(ask(f, { useSitesOf: seen })).toEqual({ refused: 'folded-on-the-exit-too' });
    expect(ask(f, { useSitesOf: seen, gates: without(PREUPDATE_COND_GATES, 'folded-on-the-exit-too') })).toEqual({
      name: 'v1',
      by: 1,
    });
  });

  test('the two walks agree about which tests hold a pre-update read', () => {
    // `preUpdateCondFold` re-implements `readsClobbered`'s walk with a counter and a reach lattice,
    // and is asked only where `readsClobbered` has already answered true — so the two have to agree
    // about `sub`, `varName` and the def map. Nothing in the types couples them. A disagreement is
    // safe in one direction only: the fold finds no pre-update name, `one-pre-update-variable`
    // refuses and the loop declines. That is what this pins, over every knob the scaffold has.
    const knobs = [
      {},
      { leftArm: true },
      { connective: 'logic_or' as const },
      { underNot: true },
      { callArm: true },
      { leftArm: true, callArm: true },
    ];
    for (const opts of knobs) {
      const f = scaffold(opts);
      const sub = new Map([[f.u, 'v1']]);
      const clobbered = make({ defs: f.defs, varName: f.varName }).readsClobbered(f.cond, sub, writes);
      const answer = ask(f);
      const blamed = 'refused' in answer && answer.refused === 'one-pre-update-variable';
      expect({ opts, clobbered, blamed }).toEqual({ opts, clobbered, blamed: !clobbered });
      expect(clobbered).toBe(true);
    }
    // The other direction, so the assertion above is not one-sided: a test whose every leaf is
    // post-update. `readsClobbered` says clean, and the fold finds no name to carry the `++`.
    const f = scaffold();
    const sub = new Map([[f.u, 'v1']]);
    const hz = make({ defs: f.defs, varName: f.varName });
    expect(hz.readsClobbered(f.u, sub, writes)).toBe(false);
    expect(hz.preUpdateCondFold(f.u, false, f.header, [f.u], [], f.body, sub, step(1), writes)).toEqual({
      refused: 'one-pre-update-variable',
    });
  });

  test('the same post-loop read is fine when the leaf sits where every iteration evaluates it', () => {
    // The one-fact control for the gate above: move the arm to the LEFT of the `&&`, which every
    // iteration evaluates whichever way the test answers.
    const f = scaffold({ leftArm: true });
    const outside: Block = { params: [], ops: [] };
    expect(ask(f, { useSitesOf: new Map([[f.u, [use(outside)]]]) })).toEqual({ name: 'v1', by: 1 });
  });
});

describe('testSkipsAnEffect', () => {
  // `v1 <= 9 && work() != 0` and its mirror: the call is INLINED into the test because nothing names
  // it, and agbcc put that `bl` ahead of the branch either way. Where the `&&` renders it in the
  // right operand the emitted loop calls only on the iterations the left one let through.
  const scaffold = (callLeft: boolean, connective: 'logic_and' | 'logic_or' = 'logic_and') => {
    const p = v();
    const call = v();
    const cmp = v();
    const ne = v();
    const cond = v();
    const arms = callLeft ? [ne, cmp] : [cmp, ne];
    return {
      cond,
      defs: new Map<Value, Op>([
        [call, mkOp('call', { operands: [v()], results: [call] })],
        [cmp, mkOp('icmp_ule', { operands: [p, v()], results: [cmp] })],
        [ne, mkOp('icmp_ne', { operands: [call, v()], results: [ne] })],
        [cond, mkOp(connective, { operands: arms, results: [cond] })],
      ]),
    };
  };
  const ask = (f: ReturnType<typeof scaffold>, sub: Map<Value, string> = new Map()) =>
    make({ defs: f.defs }).testSkipsAnEffect(f.cond, sub);

  test('a call in the operand a short circuit may skip is the refusal', () => {
    expect(ask(scaffold(false))).toBe(true);
    expect(ask(scaffold(false, 'logic_or'))).toBe(true);
  });

  test('the same call in the operand every evaluation reaches is clean', () => {
    expect(ask(scaffold(true))).toBe(false);
    expect(ask(scaffold(true, 'logic_or'))).toBe(false);
  });

  test('a pure read is not an effect — C re-guards it where the arm hoist put it', () => {
    // The trailing-pointer `while (r != 0 && *p++ != 0)`: raise/shortcircuit.ts is allowed to lift a
    // LOAD out of the arm it guards precisely because the `&&` guards it again, and this predicate
    // has to agree or that fold's byte-matches all decline.
    const f = scaffold(false);
    const ne = f.defs.get(f.cond)!.operands[1];
    const call = f.defs.get(ne)!.operands[0];
    f.defs.set(call, mkOp('load', { operands: [v()], results: [call] }));
    expect(ask(f)).toBe(false);
  });

  test('a name is a statement, not an inlined effect', () => {
    // The same call, materialized: `v0 = work(a0);` stands in the body and the arm reads `v0`. The
    // walk stops at the name, which is the difference between a skipped call and a skipped read.
    const f = scaffold(false);
    const ne = f.defs.get(f.cond)!.operands[1];
    const call = f.defs.get(ne)!.operands[0];
    expect(make({ defs: f.defs, varName: new Map([[call, 'v0']]) }).testSkipsAnEffect(f.cond, new Map())).toBe(false);
  });

  test('a respelled def is descended, not waved past', () => {
    // The fold refuses a def whose rendering it cannot read; here the opposite answer is the safe
    // one, because the def still names the values its operands stand for — the call among them.
    const f = scaffold(false);
    const ne = f.defs.get(f.cond)!.operands[1];
    const spelled = new Map<Op, unknown>([[f.defs.get(ne)!, 'a bitfield read']]);
    expect(make({ defs: f.defs, respelledDefs: spelled }).testSkipsAnEffect(f.cond, new Map())).toBe(true);
  });

  test('a test too large to walk answers the refusing way', () => {
    // The budget is the only answer given without looking, so it is given as a refusal: the part of
    // the test the walk did not reach is the part a clean answer would be about.
    // Twenty ops, a million visits: the walk does not memoise, so a value both operands read costs
    // it twice at every level.
    const defs = new Map<Value, Op>();
    let cur = v();
    for (let i = 0; i < 20; i++) {
      const up = v();
      defs.set(up, mkOp('icmp_ne', { operands: [cur, cur], results: [up] }));
      cur = up;
    }
    expect(make({ defs }).testSkipsAnEffect(cur, new Map())).toBe(true);
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
    expect(h.loopUpdateHazard(cond, [], none, new Map(), new Set(['v0']), null)).toBe(true);
    expect(h.loopUpdateHazard(cond, [arg], none, new Map(), new Set(['v1']), null)).toBe(true);
    expect(h.loopUpdateHazard(cond, [arg], none, new Map(), new Set(['v9']), null)).toBe(false);
  });
});

describe('sunkCopyOverDroppedUndef', () => {
  // The postcondition on the pair of write RELOCATIONS (hazards.ts). No input inhabits the collision
  // — `dest-free-inside-loop` refuses the sink first (the test above) — so the predicate is pinned
  // here directly, on hand-built records, rather than through a function nothing can produce.
  const blk = (): Block => ({ params: [], ops: [] });

  test('no collision when the two records share no name', () => {
    const pred = blk();
    const header = blk();
    const reaches = () => true;
    expect(sunkCopyOverDroppedUndef([{ name: 'v0', pred }], [{ name: 'v1', home: header }], reaches)).toBe(null);
  });

  test('a sunk copy under the dropped name, in a loop that REACHES the edge, is the collision', () => {
    const pred = blk();
    const header = blk();
    expect(
      sunkCopyOverDroppedUndef(
        [{ name: 'v0', pred }],
        [{ name: 'v0', home: header }],
        (h, p) => h === header && p === pred,
      ),
    ).toBe('v0');
  });

  test('the same name in a loop the edge is NOT inside is not a collision', () => {
    // The name class is function-wide, so a bare name match is not enough: an unrelated loop
    // elsewhere writing `v0` says nothing about an edge this one cannot reach.
    const pred = blk();
    const header = blk();
    expect(sunkCopyOverDroppedUndef([{ name: 'v0', pred }], [{ name: 'v0', home: header }], () => false)).toBe(null);
  });

  test('the header being the edge itself counts — a self-loop writes before its own back edge', () => {
    const header = blk();
    expect(
      sunkCopyOverDroppedUndef([{ name: 'v0', pred: header }], [{ name: 'v0', home: header }], (_h, p) => p !== header),
    ).toBe('v0');
  });

  test('either record empty is vacuously safe', () => {
    const pred = blk();
    expect(sunkCopyOverDroppedUndef([{ name: 'v0', pred }], [], () => true)).toBe(null);
    expect(sunkCopyOverDroppedUndef([], [{ name: 'v0', home: blk() }], () => true)).toBe(null);
  });
});
