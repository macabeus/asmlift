// The irTraceOf differential behind the SHARED DEFAULT TAIL — `raise/tailsink.ts` and structure()'s
// `followEarlyReturns`, the two terms of rank.ts's `/shared-tail` twin.
//
// Both move effects between control-flow paths: the sink copies a store tail into the arms, and
// the follow turns fall-through into early `return;`s. That is the change that can be byte-closer
// and semantically wrong at once, and no naming fuzz can see it — each compares one spelling with
// another. So the oracle is the IR itself: the run of the lifted function (`irTraceOf`) against
// the run of the IR after the sink, and against the run of each structured tree (`traceOf`), both
// `structure()`'s and `structureChecked`'s after its committed L3 rewrites.
//
// The generator builds the family's shapes on purpose — a decision tree whose leaves branch into a
// shared store tail, directly or through a chain of pure forwarders or a join both sides may
// reach, or keep a `ret` of their own — because a random CFG almost never shares a tail, and a
// fuzz that never fires the path proves nothing. The firing counts are asserted, not just printed.
//
// A second arm runs the same functions through `raiseRecovered` first, because that is the fn
// rank.ts hands the sink and raise reshapes it: a tail reached only through a forwarder reads the
// forwarder's parameter. Hand-built IR never reaches that shape, and a sink that substitutes the
// tail's own parameters alone throws in `verify` on a real Thumb lift while this first arm stays
// green.
import { expect, test, vi } from 'vitest';

import { type Block, type Fn, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { raiseRecovered, structureChecked } from '../src/pipeline';
import { sinkStoreTails } from '../src/raise/tailsink';
import { StructureError, hasDivergentSharedRet, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';
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

  // The shared store tail, a chain of up to two pure forwarders into it, and up to two joins either
  // side of the top `if` may fall into.
  const tail = block(1);
  store(tail, tail.params[0], 4);
  if (rnd() < 0.3) {
    store(tail, pick(params), 8);
  }
  tail.ops.push(mkOp('ret'));
  const entries = [tail];
  for (let i = 0, n = rnd() < 0.4 ? (rnd() < 0.5 ? 1 : 2) : 0; i < n; i++) {
    const f = block(1);
    br(f, entries[entries.length - 1], [f.params[0]]);
    entries.push(f);
  }
  const into = (b: Block, value: Value) => br(b, pick(entries), [value]);
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
  return {
    name: `st${seed}`,
    blocks: blocks.filter((b) => reach.has(b)),
    writeOrder: undefined,
    slotHomes: undefined,
    paramEvidence: undefined,
    localObjects: undefined,
    asmLayout: undefined,
  };
}

/** THE FOLLOW AS RANK.TS ASKS IT: its `/shared-ret` and `/shared-tail` passes keep the return-tail
 *  copies (`copyReturnTails`), so the follow is the reading that gives a divergent `if` its tail. */
const FOLLOW = { returnsVoid: true, followEarlyReturns: true, copyReturnTails: true } as const;

/** The DEFAULT structuring, which reads the join past early returns, held to the same oracle:
 *  1 where it took the join somewhere (`onJoinPastReturns`) and agreed with `want` on every run. */
function joinedRuns(fn: Fn, want: ReturnType<typeof irTraceOf>[], label: string): number {
  let took = 0;
  let tree;
  try {
    tree = structure(fn, { returnsVoid: true }, { onJoinPastReturns: () => took++ });
  } catch (e) {
    if (!(e instanceof StructureError)) {
      throw e;
    }
    return 0;
  }
  RUNS.forEach((r, i) => expect(traceOf(tree, r), `${label} joined, run ${r}`).toEqual(want[i]));
  const checked = structureChecked(fn, { returnsVoid: true });
  RUNS.forEach((r, i) => expect(traceOf(checked, r), `${label} joined checked, run ${r}`).toEqual(want[i]));
  return took > 0 ? 1 : 0;
}

/** Parameter seeds for the two interpreters: each spreads the three parameters over -5..5, so the
 *  `< -2 / 0 / 2` tests take both sides. */
const RUNS = [0, 9, 83, 511, 4095, 1234, 3001];

/** THE SEEDS. Each arm sweeps a FIXED range — seeds 1..20000 and 1..6000 — so every run judges the
 *  same functions and a failure reproduces. The range is cut into tests of {@link CHUNK} seeds:
 *  run whole, the first arm took 104.8 s of its 120 s budget alone on a quiet laptop (2026-11-04)
 *  and timed out beside a neighbour's bench (126-128 s, 2 runs in 2, beside 8 busy-loop
 *  neighbours at load ~10). A chunk takes ~5 s alone and 11.8 s at that load, a tenth of its
 *  budget. Nothing is dropped: the floors below count every chunk, and assert that every seed ran.
 *
 *  `ASMLIFT_SHARED_TAIL_SEEDS` overrides the range for a repro — a list such as `4711` or
 *  `7,12,100-140` — and both arms then run exactly those seeds, in one test each, without the
 *  floors (which price the full ranges). A seed that fails says so, and names that variable. */
const CHUNK = 1000;
const SEEDS_ENV = 'ASMLIFT_SHARED_TAIL_SEEDS';
const OVERRIDE = ((spec: string | undefined): number[] | undefined => {
  if (spec === undefined || spec.trim() === '') {
    return undefined;
  }
  return spec.split(',').flatMap((part) => {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!m) {
      throw new Error(`${SEEDS_ENV}: '${part}' is neither a seed nor a range a-b`);
    }
    const [lo, hi] = [Number(m[1]), Number(m[2] ?? m[1])];
    return Array.from({ length: hi - lo + 1 }, (_, n) => lo + n);
  });
})(process.env[SEEDS_ENV]);

/** The tests one arm runs: its range in chunks, or the override whole. */
const chunksOf = (last: number): { title: string; seeds: number[] }[] =>
  OVERRIDE
    ? [{ title: `${SEEDS_ENV}=${process.env[SEEDS_ENV]}`, seeds: OVERRIDE }]
    : Array.from({ length: Math.ceil(last / CHUNK) }, (_, c) => {
        const lo = c * CHUNK + 1;
        const hi = Math.min(last, (c + 1) * CHUNK);
        return { title: `seeds ${lo}..${hi}`, seeds: Array.from({ length: hi - lo + 1 }, (_, n) => lo + n) };
      });

/** Run `body` on every seed, breathing between stretches, and name the seed in whatever it throws —
 *  an assertion names its seed already, a throw out of `verify` or `structure` did not. */
async function sweep(seeds: readonly number[], body: (seed: number) => void): Promise<void> {
  for (let n = 0; n < seeds.length; n++) {
    if (n > 0 && n % BREATHE_EVERY === 0) {
      await breathe();
    }
    try {
      body(seeds[n]);
    } catch (e) {
      if (e instanceof Error) {
        e.message = `seed ${seeds[n]} (rerun it alone: ${SEEDS_ENV}=${seeds[n]}): ${e.message}`;
      }
      throw e;
    }
  }
}

const PLAIN_SEEDS = 20000;
const plain = { seeds: 0, sunk: 0, followed: 0, sunkAndFollowed: 0, declined: 0, joined: 0 };

for (const { title, seeds } of chunksOf(PLAIN_SEEDS)) {
  test(`the sink and the follow change no observable, on the shapes they were built for: ${title}`, async () => {
    await sweep(seeds, (seed) => {
      const lifted = generateSharedTailFn(seed);
      verify(lifted);
      const want = RUNS.map((r) => irTraceOf(lifted, r));
      const run = (fn: Fn): number => {
        let fired = 0;
        let tree;
        try {
          tree = structure(fn, FOLLOW, { onEarlyReturnFollow: () => fired++ });
        } catch (e) {
          if (!(e instanceof StructureError)) {
            throw e;
          }
          plain.declined++;
          return 0;
        }
        RUNS.forEach((r, i) => expect(traceOf(tree, r), `seed ${seed}, run ${r}`).toEqual(want[i]));
        // and after the committed L3 rewrites (tail-merge, dead stores, base locals) and contracts
        const checked = structureChecked(fn, FOLLOW);
        RUNS.forEach((r, i) => expect(traceOf(checked, r), `seed ${seed} checked, run ${r}`).toEqual(want[i]));
        return fired;
      };
      // The follow alone, on the lifted function.
      plain.followed += run(lifted) > 0 ? 1 : 0;
      // The default, which reads the join past early returns these shapes are full of.
      plain.joined += joinedRuns(lifted, want, `seed ${seed}`);
      // The sink, then the follow.
      const fn = generateSharedTailFn(seed);
      if (sinkStoreTails(fn)) {
        plain.sunk++;
        verify(fn);
        RUNS.forEach((r, i) => expect(irTraceOf(fn, r), `seed ${seed} sunk, run ${r}`).toEqual(want[i]));
        plain.sunkAndFollowed += run(fn) > 0 ? 1 : 0;
      }
      plain.seeds++;
    });
  });
}

test.runIf(!OVERRIDE)('the sink-and-follow sweep is not vacuous', () => {
  // At 20000 seeds it sinks 15866 functions, follows 9391 and does both on 3662, declining none,
  // and the default takes the join past early returns on 10981; the floors sit well under all four, so a generator tweak cannot turn this green by quietly
  // generating nothing the transform touches. `seeds` counts the seeds that ran to the end, so a
  // chunk that failed or was filtered out fails this too.
  console.log(
    `[shared-tail-fuzz] seeds=${plain.seeds} sunk=${plain.sunk} followed=${plain.followed} sunk+followed=${plain.sunkAndFollowed} declined=${plain.declined} joined=${plain.joined}`,
  );
  expect(plain.seeds).toBe(PLAIN_SEEDS);
  expect(plain.joined).toBeGreaterThan(9000);
  expect(plain.sunk).toBeGreaterThan(1500);
  expect(plain.followed).toBeGreaterThan(8000);
  expect(plain.sunkAndFollowed).toBeGreaterThan(1500);
});

/** A store tail — stores, then a void `ret` — that reads a block parameter of some OTHER non-entry
 *  block: the shape only raise produces, by stripping the parameter of a tail whose one predecessor
 *  is a forwarder, so that the tail reads the forwarder's. */
const readsForeignParam = (fn: Fn): boolean =>
  fn.blocks.some(
    (b) =>
      b.ops.length >= 2 &&
      b.ops[b.ops.length - 1].opcode === 'ret' &&
      b.ops.slice(0, -1).every((o) => o.opcode === 'store') &&
      b.ops.some((o) => o.operands.some((v) => fn.blocks.some((x, i) => i > 0 && x !== b && x.params.includes(v)))),
  );

const RAISED_SEEDS = 6000;
const raised = {
  seeds: 0,
  foreign: 0,
  sunk: 0,
  foreignSunk: 0,
  followed: 0,
  sunkAndFollowed: 0,
  declined: 0,
  joined: 0,
};

for (const { title, seeds } of chunksOf(RAISED_SEEDS)) {
  test(`the same, on the fn the raise spine hands rank.ts: ${title}`, async () => {
    // rank.ts sinks the RAISED fn, and raise reshapes what the generator built: a tail whose one
    // predecessor is a forwarder loses its parameter and reads the forwarder's. Hand-built IR never
    // reaches that, so this arm runs the generator's functions through `raiseRecovered` first, and
    // takes the raised fn's own run as the oracle. The follow is asked where rank.ts asks it.
    await sweep(seeds, (seed) => {
      const fn = generateSharedTailFn(seed);
      raiseRecovered(
        fn,
        ARMV4T_AGBCC,
        {},
        { params: 3, returnsVoid: true },
        { shortCircuit: { foldTreeOwned: false } },
      );
      const want = RUNS.map((r) => irTraceOf(fn, r));
      const run = (label: string): number => {
        let fired = 0;
        let tree;
        try {
          tree = structure(fn, FOLLOW, { onEarlyReturnFollow: () => fired++ });
        } catch (e) {
          if (!(e instanceof StructureError)) {
            throw e;
          }
          raised.declined++;
          return 0;
        }
        RUNS.forEach((r, i) => expect(traceOf(tree, r), `seed ${seed} ${label}, run ${r}`).toEqual(want[i]));
        const checked = structureChecked(fn, FOLLOW);
        RUNS.forEach((r, i) => expect(traceOf(checked, r), `seed ${seed} ${label} checked, run ${r}`).toEqual(want[i]));
        return fired;
      };
      if (hasDivergentSharedRet(fn)) {
        raised.followed += run('raised') > 0 ? 1 : 0;
      }
      raised.joined += joinedRuns(fn, want, `seed ${seed} raised`);
      const isForeign = readsForeignParam(fn);
      raised.foreign += isForeign ? 1 : 0;
      if (sinkStoreTails(fn)) {
        raised.sunk++;
        raised.foreignSunk += isForeign ? 1 : 0;
        verify(fn);
        RUNS.forEach((r, i) => expect(irTraceOf(fn, r), `seed ${seed} raised+sunk, run ${r}`).toEqual(want[i]));
        if (hasDivergentSharedRet(fn)) {
          raised.sunkAndFollowed += run('raised+sunk') > 0 ? 1 : 0;
        }
      }
      raised.seeds++;
    });
  });
}

test.runIf(!OVERRIDE)('the raised sweep is not vacuous', () => {
  // The shape this arm exists for really occurs: 318 of the raised functions carry a foreign-
  // parameter tail and all 318 are sunk (sunk 4779, followed 2780, both 1100, declined 0; the default
  // joins past early returns on 3253), which is
  // what the first floor holds. With the copy substituting the tail's own parameters alone, seed 1
  // already throws in `verify`.
  console.log(
    `[shared-tail-fuzz raised] seeds=${raised.seeds} foreignParamTail=${raised.foreign} sunk=${raised.sunk} sunkForeign=${raised.foreignSunk} followed=${raised.followed} sunk+followed=${raised.sunkAndFollowed} declined=${raised.declined} joined=${raised.joined}`,
  );
  expect(raised.seeds).toBe(RAISED_SEEDS);
  expect(raised.joined).toBeGreaterThan(2500);
  expect(raised.foreignSunk).toBeGreaterThan(150);
  expect(raised.sunk).toBeGreaterThan(2000);
  expect(raised.followed).toBeGreaterThan(1200);
  expect(raised.sunkAndFollowed).toBeGreaterThan(500);
});
