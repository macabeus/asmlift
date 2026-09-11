// The irTraceOf differential behind the SHARED DEFAULT TAIL — structure()'s `followEarlyReturns`,
// rank.ts's `/shared-tail` twin.
//
// The follow turns fall-through into early `return;`s, moving effects between control-flow paths.
// That is the change that can be byte-closer and semantically wrong at once, and no naming fuzz
// can see it — each compares one spelling with another. So the oracle is the IR itself: the run of
// the lifted function (`irTraceOf`) against the run of each structured tree (`traceOf`).
//
// The generator builds the family's shapes on purpose — a decision tree whose leaves branch into a
// shared store tail, directly or through a pure forwarder or a join both sides may reach, or keep a
// `ret` of their own — because a random CFG almost never shares a tail, and a fuzz that never
// fires the path proves nothing. The firing counts are asserted, not just printed.
import { expect, test, vi } from 'vitest';

import { type Block, type Fn, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { StructureError, structure } from '../src/structure/structure';
import { BREATHE_EVERY, breathe, irTraceOf, mulberry32, traceOf } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

const s32 = T.s(32);

/** A function of the shared-tail family, seeded. Every value is defined in the block that uses it
 *  or in the entry, so definitions dominate uses by construction. */
function generateSharedTailFn(seed: number): Fn {
  const rnd = mulberry32(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
  const params = [mkValue(s32), mkValue(s32), mkValue(s32)];
  const blocks: Block[] = [{ params, ops: [] }];
  const block = (arity = 0): Block => {
    const b: Block = { params: Array.from({ length: arity }, () => mkValue(s32)), ops: [] };
    blocks.push(b);
    return b;
  };
  const konst = (b: Block, value: number): Value => {
    const r = mkValue(s32);
    b.ops.push(mkOp('const', { results: [r], attrs: { value } }));
    return r;
  };
  const call = (b: Block, arg: Value) =>
    b.ops.push(mkOp('call', { operands: [arg], results: [mkValue(s32)], attrs: { target: pick(['f0', 'f1']) } }));
  const br = (b: Block, to: Block, args: Value[]) => b.ops.push(mkOp('br', { successors: [{ block: to, args }] }));
  const gq = mkValue(T.ptr(s32));
  blocks[0].ops.push(mkOp('gaddr', { results: [gq], attrs: { sym: 'gQ' } }));
  const store = (b: Block, value: Value, off: number) =>
    b.ops.push(mkOp('store', { operands: [gq, value], attrs: { off, width: 4 } }));

  // The shared store tail, an optional pure forwarder into it, and up to two joins either side of
  // the top `if` may fall into.
  const tail = block(1);
  store(tail, tail.params[0], 4);
  if (rnd() < 0.3) {
    store(tail, pick(params), 8);
  }
  tail.ops.push(mkOp('ret'));
  const fwd = rnd() < 0.4 ? block(1) : undefined;
  if (fwd) {
    br(fwd, tail, [fwd.params[0]]);
  }
  const into = (b: Block, value: Value) => br(b, fwd && rnd() < 0.5 ? fwd : tail, [value]);
  const joins: Block[] = [];
  for (let i = 0, n = Math.floor(rnd() * 3); i < n; i++) {
    const j = block();
    if (rnd() < 0.4) {
      call(j, pick(params));
    }
    if (rnd() < 0.8) {
      into(j, konst(j, pick([1, 2, 3])));
    } else {
      store(j, konst(j, pick([1, 2, 3])), 4);
      j.ops.push(mkOp('ret'));
    }
    joins.push(j);
  }
  const leaf = (b: Block) => {
    const r = rnd();
    if (joins.length > 0 && r < 0.4) {
      br(b, pick(joins), []);
    } else if (r < 0.75) {
      into(b, konst(b, pick([1, 2, 3])));
    } else if (r < 0.9) {
      store(b, konst(b, pick([1, 2, 3])), 4); // an arm the compiler left returning
      b.ops.push(mkOp('ret'));
    } else {
      b.ops.push(mkOp('ret'));
    }
  };
  const grow = (b: Block, depth: number) => {
    if (rnd() < 0.3) {
      call(b, pick(params));
    }
    if (depth < 3 && (depth === 0 || rnd() < 0.55)) {
      const c = mkValue(T.u(32));
      b.ops.push(mkOp('icmp_slt', { operands: [pick(params), konst(b, pick([-2, 0, 2]))], results: [c] }));
      const [t, e] = [block(), block()];
      // now and then one side reaches the tail by the conditional edge itself
      const direct = rnd() < 0.08;
      b.ops.push(
        mkOp('cond_br', {
          operands: [c],
          successors: [direct ? { block: tail, args: [konst(b, 5)] } : { block: t, args: [] }, { block: e, args: [] }],
        }),
      );
      if (!direct) {
        grow(t, depth + 1);
      }
      grow(e, depth + 1);
    } else if (rnd() < 0.15) {
      // a counted loop before the leaf — `gcsetail`'s own, which the rules must not need
      const head = block(1);
      const exit = block();
      br(b, head, [konst(b, 0)]);
      call(head, head.params[0]);
      const next = mkValue(s32);
      head.ops.push(mkOp('add', { operands: [head.params[0], konst(head, 1)], results: [next] }));
      const c = mkValue(T.u(32));
      head.ops.push(mkOp('icmp_slt', { operands: [next, konst(head, 3)], results: [c] }));
      head.ops.push(
        mkOp('cond_br', {
          operands: [c],
          successors: [
            { block: head, args: [next] },
            { block: exit, args: [] },
          ],
        }),
      );
      leaf(exit);
    } else {
      leaf(b);
    }
  };
  grow(blocks[0], 0);
  // Drop what no path reaches (an unused tail, forwarder or join, and a `grow` block cut by a
  // direct edge).
  const reach = new Set<Block>();
  const stack = [blocks[0]];
  while (stack.length) {
    const b = stack.pop()!;
    if (!reach.has(b)) {
      reach.add(b);
      stack.push(...b.ops[b.ops.length - 1].successors.map((s) => s.block));
    }
  }
  return { name: `st${seed}`, blocks: blocks.filter((b) => reach.has(b)), writeOrder: undefined, slotHomes: undefined };
}

/** Parameter seeds for the two interpreters: each spreads the three parameters over -5..5, so the
 *  `< -2 / 0 / 2` tests take both sides. */
const RUNS = [0, 9, 83, 511, 4095, 1234, 3001];

test('the follow changes no observable, on the shapes it was built for', async () => {
  const SEEDS = 20000;
  let followed = 0;
  let declined = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    if (seed % BREATHE_EVERY === 0) {
      await breathe();
    }
    const lifted = generateSharedTailFn(seed);
    verify(lifted);
    const want = RUNS.map((r) => irTraceOf(lifted, r));
    const run = (fn: Fn): number => {
      let fired = 0;
      let tree;
      try {
        tree = structure(fn, { returnsVoid: true, followEarlyReturns: true }, { onEarlyReturnFollow: () => fired++ });
      } catch (e) {
        if (!(e instanceof StructureError)) {
          throw e;
        }
        declined++;
        return 0;
      }
      RUNS.forEach((r, i) => expect(traceOf(tree, r), `seed ${seed}, run ${r}`).toEqual(want[i]));
      return fired;
    };
    followed += run(lifted) > 0 ? 1 : 0;
  }
  // At authoring: followed 9466, declined 0 — the floor below.
  console.log(`[shared-tail-fuzz] seeds=${SEEDS} followed=${followed} declined=${declined}`);
  expect(followed).toBeGreaterThan(8000);
});
