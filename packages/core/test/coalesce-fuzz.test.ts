// The differential fuzz behind COALESCE_GATES — see coalesce.ts for what the gates claim.
//
// Arm A: no candidate the pass emits changes a defined read. Arm B drops each gate the table calls
// SOUND and requires that it DOES — without which arm A is also what "emitted nothing" looks like.
// Arm B is written over the table, not over a named gate, so a rule added later is held to the same
// bar without anyone remembering to.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { COALESCE_GATES, type MergePair, coalesceCandidates, coalesceUnder } from '../src/l3/coalesce';
import { type Gate, gateTableDefects, without } from '../src/l3/gates';

// Control flow comes from a pre-drawn list, not from the values, so both trees take the same path by
// construction: traces align index for index and every difference is a value difference. Conditions
// are still evaluated — their reads are observed — and their value discarded.
type Schedule = () => number;
const schedule = (draws: number[]): Schedule => {
  let at = 0;
  return () => draws[at++ % draws.length];
};

/** A local that was never assigned on this path. The ORIGINAL reading one is the documented
 *  ACCEPTED-NOT-FIXED case (both spellings are ill-defined), so such a read constrains nothing. */
const UNDEF = null;
type Val = number | typeof UNDEF;

/** Every value a variable read observed, in execution order. */
function run(sfn: SFn, sched: Schedule): Val[] {
  const env = new Map<string, Val>();
  const reads: Val[] = [];

  // UNDEF POISONS: an expression over an uninitialized local is as indeterminate as the local, so it
  // must not re-enter the defined world as a number. Without this the harness over-reports.
  const evalExpr = (e: Expr): Val => {
    switch (e.k) {
      case 'var': {
        const v = env.get(e.name) ?? UNDEF;
        reads.push(v);
        return v;
      }
      case 'const':
        return e.value;
      case 'bin': {
        const l = evalExpr(e.l);
        const r = evalExpr(e.r);
        return l === UNDEF || r === UNDEF ? UNDEF : (l + r) | 0;
      }
      case 'call':
        e.args.forEach(evalExpr);
        return 0;
      default:
        throw new Error(`the generator does not emit ${e.k}`);
    }
  };

  const exec = (list: Stmt[]): void => {
    for (const s of list) {
      switch (s.k) {
        case 'assign':
          env.set(s.name, evalExpr(s.value));
          break;
        case 'exprstmt':
          evalExpr(s.value);
          break;
        case 'if':
          evalExpr(s.cond);
          exec(sched() % 2 === 0 ? s.then : s.else);
          break;
        case 'while': {
          // test-at-top: the condition runs once more than the body
          const n = sched() % 3;
          evalExpr(s.cond);
          for (let i = 0; i < n; i++) {
            exec(s.body);
            evalExpr(s.cond);
          }
          break;
        }
        case 'dowhile': {
          // body-first: the body runs once before the condition is ever evaluated
          const n = 1 + (sched() % 3);
          for (let i = 0; i < n; i++) {
            exec(s.body);
            evalExpr(s.cond);
          }
          break;
        }
        case 'for': {
          const n = sched() % 3;
          exec([s.init]);
          evalExpr(s.cond);
          for (let i = 0; i < n; i++) {
            exec(s.body);
            exec([s.inc]);
            evalExpr(s.cond);
          }
          break;
        }
        default:
          throw new Error(`the generator does not emit ${s.k}`);
      }
    }
  };

  exec(sfn.body);
  return reads;
}

/** How `cand` differs from `orig` on one schedule. `undefined-only` is coalesce.ts's documented
 *  ACCEPTED-NOT-FIXED case; `clobber` is the one the loop gate exists to prevent. */
function compare(orig: SFn, cand: SFn, draws: number[]): 'same' | 'undefined-only' | 'clobber' {
  const a = run(orig, schedule(draws));
  const b = run(cand, schedule(draws));
  // a length difference is a clobber of its own: the rename dropped or duplicated a read
  if (a.length !== b.length || a.some((v, i) => v !== UNDEF && v !== b[i])) {
    return 'clobber';
  }
  return a.some((v, i) => v !== b[i]) ? 'undefined-only' : 'same';
}

// The generator emits only what the gate reasons about: constant-fed locals, reads, and the
// positions a back edge re-runs — a loop body (test-at-top, body-first, and `for`), a loop's own
// condition, and a `for`'s inc. A `for`'s INIT is deliberately not one of them: it runs once,
// ahead of the condition, which is why the span model places it outside its own loop.
//
// KNOWN GAP: `switch` fall-through, `break` and `continue` are not emitted, and a `for`'s init and
// inc are always plain assigns, so the differential covers neither pairs split across the first
// three nor a loop standing in an init/inc. Nothing else covers the first three; the init case is
// pinned directly by coalesce.test.ts ('a loop in a `for`s INIT encloses its own …').
const LOCALS = ['a', 'b', 'c'];

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed: number): SFn {
  const rnd = mulberry32(seed);
  const pick = <X>(xs: X[]): X => xs[Math.floor(rnd() * xs.length)];
  // Locals are chosen with a DRIFT towards the end of the program, so ranges are often disjoint.
  // Under uniform choice almost every pair overlaps in preorder and the sweep runs thousands of
  // programs to test a handful of merges.
  let emitted = 0;
  const local = (): string =>
    rnd() < 0.8 ? LOCALS[Math.min(LOCALS.length - 1, Math.floor(emitted / 5))] : pick(LOCALS);
  const read = (n: string): Expr => ({ k: 'var', name: n });
  const obs = (): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn: 'obs', args: [read(local())] } });
  // mostly constant-fed, or `constFed` rejects the pair before the loop gate is ever consulted
  const value = (): Expr =>
    rnd() < 0.85
      ? { k: 'const', value: Math.floor(rnd() * 100) }
      : { k: 'bin', op: '+', l: read(local()), r: { k: 'const', value: 1 } };
  const assign = (): Stmt => ({ k: 'assign', name: local(), value: value() });
  const cond = (): Expr => (rnd() < 0.5 ? read(local()) : { k: 'const', value: 1 });

  const block = (depth: number): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0, n = 2 + Math.floor(rnd() * 4); i < n; i++) {
      const r = rnd();
      emitted++;
      if (r < 0.4) {
        out.push(assign());
      } else if (r < 0.75 || depth === 0) {
        out.push(obs());
      } else if (r < 0.82) {
        out.push({ k: 'if', cond: cond(), then: block(depth - 1), else: block(depth - 1) });
      } else if (r < 0.89) {
        // test-at-top keeps its share: the ZERO-TRIP path is what the accepted-not-fixed
        // carve-out rests on, and a do-while never has one
        out.push({ k: 'while', cond: cond(), body: block(depth - 1) });
      } else if (r < 0.94) {
        out.push({ k: 'dowhile', cond: cond(), body: block(depth - 1) });
      } else {
        out.push({ k: 'for', init: assign(), cond: cond(), inc: assign(), body: block(depth - 1) });
      }
    }
    return out;
  };

  return {
    name: 'f',
    params: [],
    locals: LOCALS.map((n) => ({ name: n, type: T.s(32) })),
    retType: T.void(),
    body: block(2),
  };
}

// ── the two arms ───────────────────────────────────────────────────────────────────────────────
const PROGRAMS = 2000;
const SCHEDULES = [
  [0, 1, 2, 1, 0, 2, 2, 0, 1],
  [2, 2, 2, 2, 2, 2],
  [1, 0, 1, 0, 1, 0],
];

function sweep(candidatesOf: (sfn: SFn) => { merged: string; sfn: SFn }[]) {
  let candidates = 0;
  const clobbered: string[] = [];
  let undefinedOnly = 0;
  for (let seed = 1; seed <= PROGRAMS; seed++) {
    const sfn = generate(seed);
    for (const c of candidatesOf(sfn)) {
      candidates++;
      const worst = SCHEDULES.map((draws) => compare(sfn, c.sfn, draws));
      if (worst.includes('clobber')) {
        clobbered.push(`seed ${seed}, merge ${c.merged}`);
      } else if (worst.includes('undefined-only')) {
        undefinedOnly++;
      }
    }
  }
  return { candidates, clobbered, undefinedOnly };
}

const under = (gates: readonly Gate<MergePair>[]) => (sfn: SFn) => coalesceUnder(gates, sfn).candidates;

describe('the gates, differentially', () => {
  const kept = sweep(coalesceCandidates);

  test('the sweep reaches mergeable programs at all', () => {
    // A floor well under what the generator currently offers, so tuning it does not have to move.
    expect(kept.candidates).toBeGreaterThan(80);
  });

  test('no candidate the pass emits changes a DEFINED read', () => {
    expect(kept.clobbered).toEqual([]);
  });

  test('the accepted-not-fixed case is real, and is what the carve-out covers', () => {
    // coalesce.ts accepts this class; asserting it stays reachable stops the carve-out that excuses
    // it from quietly becoming dead code.
    expect(kept.undefinedOnly).toBeGreaterThan(0);
  });
});

// THE GATE CONTRACT. Every rule the table calls SOUND has to earn the word, and the acceptance
// criterion is the one four audit rounds applied by hand: drop the gate and something must break.
// Written against the TABLE rather than against a named gate, so a rule added later is held to it
// without anyone remembering to — which is the whole reason the gates became data.
describe('COALESCE_GATES', () => {
  test('the table is well-formed, and nothing calls itself sound without naming a guard', () => {
    expect(gateTableDefects(COALESCE_GATES)).toEqual([]);
  });

  // `volatile` is sound on a dimension this oracle cannot see: volatility is about the ACCESS
  // SEQUENCE being observable, not about which value a read returns, and the evaluator compares
  // values. Its guard is the direct pin in coalesce.test.ts ('a volatile pair never merges').
  const valueInvisible = new Set(['volatile']);
  test.each(COALESCE_GATES.filter((g) => g.sound && !valueInvisible.has(g.id)).map((g) => [g.id] as const))(
    'the SOUND gate `%s` is load-bearing — dropping it clobbers a defined read',
    (id) => {
      // The ablation is a VALUE: the real predicate runs on the real input, with no test-only branch
      // in the shipped path and no input rewritten to dodge it. `without` throws on an unknown id,
      // so a typo here fails loudly instead of silently testing the unablated pass.
      expect(sweep(under(without(COALESCE_GATES, id))).clobbered.length).toBeGreaterThan(0);
    },
  );

  test('every gate actually refuses something — a rule nothing reaches guards nothing', () => {
    // Reachability, not correctness: a gate the corpus never exercises is one no test could be
    // failing on purpose, which is how a dead rule outlives the reason it was written.
    const reached = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      for (const id of coalesceUnder(COALESCE_GATES, generate(seed)).refusals.keys()) {
        reached.add(id);
      }
    }
    // `param` and `type` need shapes the generator does not emit (it declares three same-typed
    // locals and no params), and `volatile` needs a qualified local it never declares;
    // coalesce.test.ts pins all three directly.
    const byUnitTest = new Set(['param', 'type', 'volatile']);
    expect(COALESCE_GATES.filter((g) => !reached.has(g.id) && !byUnitTest.has(g.id)).map((g) => g.id)).toEqual([]);
  });
});
