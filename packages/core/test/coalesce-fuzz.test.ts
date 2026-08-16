// The differential fuzz behind coalesce.ts's loop gate — the one gate in that file whose
// justification is SOUNDNESS rather than codegen quality, and which until now rested on a harness
// that was run once and never committed.
//
// The claim: excluding a local mentioned inside a loop is what makes preorder statement order a
// sufficient approximation of liveness, so `x.last < y.first` really does mean the ranges are
// disjoint. Two arms check it, and BOTH are needed — the second is what stops the first from being
// a test that passes because nothing happens.
//
//   A. every candidate the pass emits preserves every defined read (no clobber);
//   B. the same programs with the loop flag suppressed DO clobber, so the generator reaches the
//      shapes the gate exists for.
//
// Arm B suppresses the flag by INPUT rather than by a test-only switch in the pass, so the real
// predicate and the real rename run in both arms — see the rewrite below.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { coalesceCandidates } from '../src/l3/coalesce';

// ── the schedule ───────────────────────────────────────────────────────────────────────────────
// Control flow comes from a pre-drawn list, not from the values: each `if` takes its arm and each
// loop its trip count from the next draw. Conditions are still EVALUATED (their reads are observed)
// and their value discarded. That makes the two trees run the same path by construction — so the
// traces align index for index and every difference is a value difference — and it makes the
// comparison quantify over schedules the values might never produce, including zero-trip loops.
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

  // UNDEF POISONS. An expression over an uninitialized local is as indeterminate as the local
  // itself, so it must not re-enter the defined world as a concrete number — that is what makes the
  // carve-out below match the documented case instead of over-reporting. It is not hypothetical:
  // modelling `b = b + 1` on an undefined `b` as a defined value made this harness call one legal
  // merge a clobber.
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

// ── the generator ──────────────────────────────────────────────────────────────────────────────
// Small on purpose. It emits only what the gate reasons about: constant-fed locals (so merges are
// legal at all), reads, and the three positions where a later-indexed statement can run before an
// earlier one — a loop body, and a `for`'s init and inc.
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
  // A local is chosen with a DRIFT towards the end of the program, so ranges are often disjoint.
  // Uniform choice makes almost every pair overlap in preorder, so the pass emits almost nothing and
  // the sweep runs thousands of programs to test a handful of merges.
  let emitted = 0;
  const local = (): string =>
    rnd() < 0.8 ? LOCALS[Math.min(LOCALS.length - 1, Math.floor(emitted / 5))] : pick(LOCALS);
  const read = (n: string): Expr => ({ k: 'var', name: n });
  const obs = (): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn: 'obs', args: [read(local())] } });
  // mostly constant-fed, since `constFed` would otherwise reject the pair before the loop gate is
  // ever consulted and the whole fuzz would go vacuous
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
      } else if (r < 0.85) {
        out.push({ k: 'if', cond: cond(), then: block(depth - 1), else: block(depth - 1) });
      } else if (r < 0.93) {
        out.push({ k: 'while', cond: cond(), body: block(depth - 1) });
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

// ── arm B's ablation, as an input rewrite ──────────────────────────────────────────────────────
// A loop becomes an `if` carrying the same condition, body and child order, tagged so it can be
// turned back after the pass has run. `stmtChildren` and `stmtExprs` then agree node for node with
// the loop's, so `spans` produces an identical map except for `inLoop` — the gate ablated, and
// nothing else. `for`'s children are `[init, inc, ...body]`, so the `if` lists them in that order.
const MARK = { while: '__was_while__', for: '__was_for__' } as const;
const tag = (fn: string, cond: Expr): Expr => ({ k: 'call', fn, args: [cond] });

function loopsAsIfs(body: Stmt[]): Stmt[] {
  return body.map((s): Stmt => {
    switch (s.k) {
      case 'while':
        return { k: 'if', cond: tag(MARK.while, s.cond), then: loopsAsIfs(s.body), else: [] };
      case 'for':
        return { k: 'if', cond: tag(MARK.for, s.cond), then: loopsAsIfs([s.init, s.inc, ...s.body]), else: [] };
      case 'if':
        return { ...s, then: loopsAsIfs(s.then), else: loopsAsIfs(s.else) };
      default:
        return s;
    }
  });
}

function ifsAsLoops(body: Stmt[]): Stmt[] {
  return body.map((s): Stmt => {
    if (s.k !== 'if') {
      return s;
    }
    const then = ifsAsLoops(s.then);
    if (s.cond.k === 'call' && s.cond.fn === MARK.while) {
      return { k: 'while', cond: s.cond.args[0], body: then };
    }
    if (s.cond.k === 'call' && s.cond.fn === MARK.for) {
      return { k: 'for', init: then[0], cond: s.cond.args[0], inc: then[1], body: then.slice(2) };
    }
    return { ...s, then, else: ifsAsLoops(s.else) };
  });
}

const withoutLoopGate = (sfn: SFn): { merged: string; sfn: SFn }[] =>
  coalesceCandidates({ ...sfn, body: loopsAsIfs(sfn.body) }).map((c) => ({
    ...c,
    sfn: { ...c.sfn, body: ifsAsLoops(c.sfn.body) },
  }));

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

describe('the loop gate, differentially', () => {
  const kept = sweep(coalesceCandidates);
  const ablated = sweep(withoutLoopGate);

  test('the sweep reaches mergeable programs at all', () => {
    // Without this, "no clobbers" would also be the result of emitting nothing. 2000 programs
    // currently offer 176 merges; the floor is well under that so ordinary generator tuning does
    // not have to move it.
    expect(kept.candidates).toBeGreaterThan(80);
  });

  test('no candidate the pass emits changes a DEFINED read', () => {
    expect(kept.clobbered).toEqual([]);
  });

  test('suppressing the loop flag DOES clobber — the gate is load-bearing', () => {
    // The gate's whole justification, and the only thing that stops the test above from passing
    // for the wrong reason. If this goes green, either the generator stopped reaching loops or the
    // pass stopped consulting `inLoop`.
    expect(ablated.clobbered.length).toBeGreaterThan(0);
  });

  test('the accepted-not-fixed case is real, and is what the carve-out covers', () => {
    // A survivor written on only SOME paths absorbs the other's value where the original read an
    // uninitialized local. coalesce.ts documents this as accepted; the count says it is not
    // hypothetical (8 of 176 today), so the carve-out above is load-bearing rather than an unused
    // escape hatch that a later reader could delete as dead.
    expect(kept.undefinedOnly).toBeGreaterThan(0);
  });
});
