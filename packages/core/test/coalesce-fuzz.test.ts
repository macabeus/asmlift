// The differential fuzz for coalesce.ts's loop gate — see that file for what the gate claims.
//
// Arm A: no candidate the pass emits changes a defined read. Arm B: the same programs with the loop
// flag suppressed DO — without which arm A is also what "emitted nothing" looks like.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { coalesceCandidates } from '../src/l3/coalesce';

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

// The generator emits only what the gate reasons about: constant-fed locals, reads, and the three
// positions where a later-indexed statement can run before an earlier one — a loop body, and a
// `for`'s init and inc.
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

// Arm B's ablation, as an input rewrite: a loop becomes an `if` over the same children, tagged so it
// can be turned back after the pass has run. `stmtChildren`/`stmtExprs` then agree node for node with
// the loop's, so `spans` produces an identical map except for `inLoop` — that gate ablated and
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
    // A floor well under what the generator currently offers, so tuning it does not have to move.
    expect(kept.candidates).toBeGreaterThan(80);
  });

  test('no candidate the pass emits changes a DEFINED read', () => {
    expect(kept.clobbered).toEqual([]);
  });

  test('suppressing the loop flag DOES clobber — the gate is load-bearing', () => {
    // Green here means the generator stopped reaching loops, or the pass stopped consulting `inLoop`.
    expect(ablated.clobbered.length).toBeGreaterThan(0);
  });

  test('the accepted-not-fixed case is real, and is what the carve-out covers', () => {
    // coalesce.ts accepts this class; asserting it stays reachable stops the carve-out that excuses
    // it from quietly becoming dead code.
    expect(kept.undefinedOnly).toBeGreaterThan(0);
  });
});
