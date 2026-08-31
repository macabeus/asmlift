// The differential fuzz behind NAME_COALESCE_GATES — the evidence the pass rests on.
//
// The benchmark cannot see this pass's failure mode. A byte score rewards a MATCH, and a candidate
// that merged two variables it should not have still compiles, still scores, and simply computes
// something else — every defect this file has caught moved zero benchmark rows. So the oracle has
// to be the program's own behaviour: structure the same IR twice — once with the axis, once
// without — interpret both emitted trees, and require the same observable trace.
//
// Arm A: no merge the pass makes changes what the function does. Arm B drops each gate the table
// calls SOUND and requires that one of them DOES — without which arm A is also what "merged
// nothing" looks like. Arm B is written over the table, so a rule added later is held to the same
// bar without anyone remembering to.
//
// The generator emits LOOPS by default. Every defect this has caught has been a loop or a
// mid-block shape, and a fuzz that cannot reach them would be a green test for the thing it exists
// to check.
import { describe, expect, test, vi } from 'vitest';

import { Block, Fn, Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { type Expr, type SFn, type Stmt } from '../src/l3/ast';
import { without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { NAME_COALESCE_GATES } from '../src/structure/namecoalesce';
import { structure } from '../src/structure/structure';

// CORPUS-SIZED WORK IN A PARALLEL WORKER POOL: the 5 s default is a LOAD sensitivity here, not a
// budget. Solo these tests run in 0.9-1.7 s; inside a full `pnpm test:offline` at loadavg ~26 this
// file and two siblings went red with `Error: Test timed out in 5000ms` and nothing else, which
// reads like a soundness failure and is not — re-run alone, 11 tests green in under 2 s. A real
// hang is still loud, just 60 s later. (Not caused by the candidate-object cache: nothing under
// packages/core imports it, and the test fence's positive control passed in the same red run.)
vi.setConfig({ testTimeout: 60_000 });

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random SSA function. Every value comes from the entry block or from the block using it, so
 *  definitions dominate uses by construction and `verify` passes without a repair pass. */
export function generate(seed: number, withLoop: boolean): Fn {
  const rnd = mulberry32(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
  const nBlocks = 4 + Math.floor(rnd() * 3);
  const a0 = mkValue(T.s(32));
  const a1 = mkValue(T.s(32));
  const blocks: Block[] = [{ params: [a0, a1], ops: [] }];
  for (let i = 1; i < nBlocks; i++) {
    const nParams = Math.floor(rnd() * 3);
    blocks.push({ params: Array.from({ length: nParams }, () => mkValue(T.s(32))), ops: [] });
  }
  const entryVals: Value[] = [a0, a1];
  // A few entry-block definitions every block may read — the source of the cross-block live ranges
  // the interference rule is about.
  for (let i = 0; i < 2; i++) {
    const r = mkValue(T.s(32));
    blocks[0].ops.push(
      rnd() < 0.5
        ? mkOp('call', { operands: [pick(entryVals)], results: [r], attrs: { target: `f${i}` } })
        : mkOp('sub', { operands: [pick(entryVals), pick(entryVals)], results: [r] }),
    );
    entryVals.push(r);
  }
  const loopHeader = withLoop ? 1 + Math.floor(rnd() * (nBlocks - 2)) : -1;
  for (let i = 0; i < nBlocks; i++) {
    const b = blocks[i];
    const avail = [...entryVals, ...b.params];
    for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
      const r = mkValue(T.s(32));
      b.ops.push(
        rnd() < 0.35
          ? mkOp('call', { operands: [pick(avail)], results: [r], attrs: { target: `f${k % 3}` } })
          : mkOp(pick(['add', 'sub']), { operands: [pick(avail), pick(avail)], results: [r] }),
      );
      avail.push(r);
    }
    const argsFor = (t: Block): Value[] => t.params.map(() => pick(avail));
    if (i === nBlocks - 1) {
      b.ops.push(mkOp('ret', { operands: [pick(avail)] }));
      continue;
    }
    // a back edge to `loopHeader` needs a guard, or the loop never exits
    const isLatch = withLoop && i > loopHeader && rnd() < 0.6;
    const c = mkValue(T.u(32));
    b.ops.push(mkOp('icmp_slt', { operands: [pick(avail), pick(avail)], results: [c] }));
    const fwd = blocks[i + 1];
    const other = blocks[Math.min(nBlocks - 1, i + 1 + Math.floor(rnd() * 2))];
    b.ops.push(
      mkOp('cond_br', {
        operands: [c],
        successors: isLatch
          ? [
              { block: blocks[loopHeader], args: argsFor(blocks[loopHeader]) },
              { block: fwd, args: argsFor(fwd) },
            ]
          : [
              { block: fwd, args: argsFor(fwd) },
              { block: other, args: argsFor(other) },
            ],
      }),
    );
  }
  return { name: `fz${seed}`, blocks };
}

/** A local that no path assigned. It POISONS: an expression over one is as indeterminate as it is,
 *  so it must not re-enter the defined world as a number and over-report a difference. */
const UNDEF = null;
type Val = number | typeof UNDEF;

/** One observable: a call with the values it received, or the function's result. */
interface Event {
  fn: string;
  args: Val[];
}

/** Every observable the emitted tree produces, in execution order. Conditions are evaluated for
 *  REAL — a naming defect that changes one changes the PATH, which is a difference worth catching
 *  (it changed a loop's trip count once). Parameters are seeded, or every value is UNDEF and the
 *  comparison below has nothing to compare. */
export function run(sfn: SFn, seed: number): Event[] {
  const trace: Event[] = [];
  const env = new Map<string, Val>();
  sfn.params.forEach((p, i) => env.set(p.name, ((seed >> (i * 3)) % 11) - 5));
  let calls = 0;
  let steps = 0;
  const evalExpr = (e: Expr): Val => {
    switch (e.k) {
      case 'var':
        return env.get(e.name) ?? UNDEF;
      case 'const':
        return e.value;
      case 'bin': {
        const l = evalExpr(e.l);
        const r = evalExpr(e.r);
        if (l === UNDEF || r === UNDEF) return UNDEF;
        switch (e.op) {
          case '+':
            return (l + r) | 0;
          case '-':
            return (l - r) | 0;
          case '<':
            return l < r ? 1 : 0;
          case '>':
            return l > r ? 1 : 0;
          case '<=':
            return l <= r ? 1 : 0;
          case '>=':
            return l >= r ? 1 : 0;
          case '==':
            return l === r ? 1 : 0;
          case '!=':
            return l !== r ? 1 : 0;
          default:
            throw new Error(`unmodelled operator ${e.op}`);
        }
      }
      case 'call': {
        const args = e.args.map(evalExpr);
        trace.push({ fn: e.fn, args });
        // a DETERMINISTIC result that depends on the arguments, so a wrong argument propagates
        // into everything downstream instead of being absorbed
        calls++;
        return args.some((a) => a === UNDEF) ? UNDEF : args.reduce((x: number, y) => x + (y as number), calls) | 0;
      }
      case 'un':
        return evalExpr(e.e) === UNDEF ? UNDEF : -(evalExpr(e.e) as number) | 0;
      case 'cast':
        return evalExpr(e.e);
      default:
        throw new Error(`the generator does not emit ${e.k}`);
    }
  };
  const truthy = (e: Expr): boolean => {
    const v = evalExpr(e);
    return v !== UNDEF && v !== 0;
  };
  const exec = (list: Stmt[]): void => {
    for (const s of list) {
      if (++steps > 4000) throw new Error('step cap');
      switch (s.k) {
        case 'assign':
          env.set(s.name, evalExpr(s.value));
          break;
        case 'exprstmt':
          evalExpr(s.value);
          break;
        case 'if':
          if (truthy(s.cond)) exec(s.then);
          else exec(s.else ?? []);
          break;
        case 'while':
          while (truthy(s.cond)) {
            if (++steps > 4000) throw new Error('step cap');
            exec(s.body);
          }
          break;
        case 'dowhile':
          do {
            if (++steps > 4000) throw new Error('step cap');
            exec(s.body);
          } while (truthy(s.cond));
          break;
        case 'for':
          exec([s.init]);
          while (truthy(s.cond)) {
            if (++steps > 4000) throw new Error('step cap');
            exec(s.body);
            exec([s.inc]);
          }
          break;
        case 'return':
          trace.push({ fn: 'ret', args: s.value === undefined ? [] : [evalExpr(s.value)] });
          return;
        case 'break':
        case 'continue':
          return;
        default:
          throw new Error(`the generator does not emit ${s.k}`);
      }
    }
  };
  exec(sfn.body);
  return trace;
}

const SEEDS = 4000;

/** Both spellings of one seed, or null when the shape is not one this can judge. */
function spellings(seed: number, withLoop: boolean, drop?: string): { off: Event[]; on: Event[] } | null {
  let fn: Fn;
  try {
    fn = generate(seed, withLoop);
    verify(fn);
    recoverTypes(fn);
  } catch {
    return null;
  }
  const hooks = drop ? { nameCoalesceGates: without(NAME_COALESCE_GATES, drop) } : {};
  let off: SFn;
  let on: SFn;
  try {
    off = structure(fn, {});
    on = structure(fn, { coalesceMergeNames: true }, hooks);
  } catch {
    // a decline is not a difference — and with the axis on it can only be the primary's own,
    // which `structure` re-checks first
    return null;
  }
  try {
    return { off: run(off, seed), on: run(on, seed) };
  } catch {
    return null; // step cap, or a construct the interpreter does not model
  }
}

// A position where EITHER side is UNDEF constrains nothing: the original read a local no path had
// assigned, so both spellings are ill-defined there rather than one being wrong. Everything else —
// a different callee, a different argument, a different trace LENGTH (which is what a changed trip
// count looks like) — is a clobber.
const differs = (r: { off: Event[]; on: Event[] }): boolean => {
  if (r.off.length !== r.on.length) {
    return true;
  }
  return r.off.some((e, i) => {
    const f = r.on[i];
    if (e.fn !== f.fn || e.args.length !== f.args.length) {
      return true;
    }
    return e.args.some((a, k) => a !== UNDEF && f.args[k] !== UNDEF && a !== f.args[k]);
  });
};

describe.each([
  ['acyclic', false],
  ['loop-bearing', true],
])('%s', (_name, withLoop) => {
  test('no merge the pass makes changes what the function does', () => {
    const bad: number[] = [];
    let judged = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = spellings(seed, withLoop);
      if (!r) continue;
      judged++;
      if (differs(r)) bad.push(seed);
    }
    expect(judged).toBeGreaterThan(SEEDS / 10); // the sweep is not vacuous
    expect(bad).toEqual([]);
  });
});

// The one sound rule this generator cannot reach, and why. `type` needs two names whose
// DECLARATIONS disagree, which takes a value pool of more than one width AND a mismatch that
// survives type recovery — every value here is `s32`. Its evidence is the deps-level pair in
// namecoalesce.test.ts instead, which drives the pass at its own boundary. Naming it HERE rather
// than dropping the assertion is the point: exempting a gate is a visible act with a reason
// attached, so a rule added later is still held to the bar unless someone argues it out.
const OUT_OF_REACH = new Set(['type']);

test('every SOUND gate is load-bearing: dropping it changes what some function does', () => {
  // Written over the TABLE, not over named gates: a rule added later is held to this without
  // anyone remembering to. A gate whose ablation changes nothing is either subsumed or decorative,
  // and either way it must not claim `sound`.
  const inert: string[] = [];
  for (const g of NAME_COALESCE_GATES.filter((x) => x.sound && !OUT_OF_REACH.has(x.id))) {
    let found = false;
    for (const withLoop of [false, true]) {
      for (let seed = 1; seed <= SEEDS && !found; seed++) {
        const r = spellings(seed, withLoop, g.id);
        if (r && differs(r)) found = true;
      }
      if (found) break;
    }
    if (!found) inert.push(g.id);
  }
  expect(inert).toEqual([]);
  // and the exemption list stays honest: every name on it is a gate that still exists and is sound
  expect([...OUT_OF_REACH].filter((id) => !NAME_COALESCE_GATES.some((g) => g.id === id && g.sound))).toEqual([]);
});
