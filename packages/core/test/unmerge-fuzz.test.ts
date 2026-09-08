// Differential fuzz for l3/unmerge.ts, in the shape of narrowlocal-fuzz.test.ts's oracle: the pass
// DUPLICATES statements and DELETES declarations, and no gate the benchmark runs can see it get
// that wrong — a candidate with an undeclared identifier is normally dropped at the compiler, but
// in the real tier it is compiled inside the project's vendored TU, where an orphaned name that
// collides with a context symbol compiles and SCORES. Interpret the tree before and after; require
// the same observable trace.
//
// PURE READS ARE DELIBERATELY NOT TRACED, and the next person to touch this file will hit it too.
// Substituting two definitions into one statement's operands REORDERS their loads, and C fixes no
// operand order — which is precisely why the pass refuses an effectful or a volatile definition
// value. A first cut that traced reads reported ~40 "divergences" that were all read-order-only,
// with identical memory and identical writes. The correct oracle is WRITES, CALLS and final
// memory.
//
// WHAT THE TWO ARMS BUY, measured by ablating each gate against them (re-run rather than read):
// deleting the TOTALITY check breaks 89 trees with `ASSIGNS UNDECLARED`; deleting the FRESH
// RE-READ breaks none HERE, and breaks `unmerge.test.ts`'s own stale-count test — which is what
// makes that one test load-bearing, and is said there.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { unmergeJoins } from '../src/l3/unmerge';
import { mulberry32 } from './helpers';

const c = (value: number): Expr => ({ k: 'const', value });
const v = (name: string): Expr => ({ k: 'var', name });
const mem = (idx: Expr): Expr => ({ k: 'index', base: v('gMem'), idx, width: 4, signed: true });
const asg = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const st = (idx: Expr, value: Expr): Stmt => ({ k: 'store', lval: mem(idx), value });
const call = (fn: string): Expr => ({ k: 'call', fn, args: [] });

interface World {
  m: number[];
  trace: string[];
}
const run = (fn: SFn, seedMem: number[]): World => {
  const w: World = { m: [...seedMem], trace: [] };
  const env = new Map<string, number>();
  for (const l of fn.locals) {
    env.set(l.name, 0);
  }
  let calls = 0;
  const ev = (e: Expr): number => {
    switch (e.k) {
      case 'const':
        return e.value | 0;
      case 'var': {
        if (!env.has(e.name)) {
          throw new Error(`READS UNDECLARED ${e.name}`);
        }
        return env.get(e.name)!;
      }
      case 'index': {
        const i = ((ev(e.idx) % 16) + 16) % 16;
        return w.m[i] | 0;
      }
      case 'bin':
        return e.op === '+' ? (ev(e.l) + ev(e.r)) | 0 : (ev(e.l) ^ ev(e.r)) | 0;
      case 'call': {
        calls++;
        w.trace.push(`c:${e.fn}`);
        return (calls * 7) | 0;
      }
      default:
        throw new Error(`expr ${e.k}`);
    }
  };
  const exec = (s: Stmt): void => {
    switch (s.k) {
      case 'assign': {
        if (!env.has(s.name)) {
          throw new Error(`ASSIGNS UNDECLARED ${s.name}`);
        }
        env.set(s.name, ev(s.value));
        return;
      }
      case 'store': {
        const l = s.lval as Extract<Expr, { k: 'index' }>;
        const i = ((ev(l.idx) % 16) + 16) % 16;
        const x = ev(s.value);
        w.m[i] = x;
        w.trace.push(`w${i}=${x}`);
        return;
      }
      case 'exprstmt':
        ev(s.value);
        return;
      case 'if': {
        (ev(s.cond) ? s.then : s.else).forEach(exec);
        return;
      }
      default:
        throw new Error(`stmt ${s.k}`);
    }
  };
  fn.body.forEach(exec);
  return w;
};

const NAMES = ['t0', 't1', 'q'];
const CONDS = ['k0', 'k1', 'k2', 'k3'];

/** A random tree in the family this pass judges: a ladder of 2..5 arms whose terminal arms define
 *  the merge temps, a join statement after it, and optional prefixes/nested sites around them. */
function gen(seed: number): SFn {
  const rnd = mulberry32(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
  const val = (d = 0): Expr => {
    const r = rnd();
    if (d > 1 || r < 0.35) {
      return c(Math.floor(rnd() * 8));
    }
    if (r < 0.55) {
      return v(pick(NAMES));
    }
    if (r < 0.75) {
      return mem(val(d + 1));
    }
    if (r < 0.97) {
      return { k: 'bin', op: '+', l: val(d + 1), r: val(d + 1) };
    }
    return call(`F${Math.floor(rnd() * 3)}`);
  };
  const noise = (): Stmt[] => {
    const out: Stmt[] = [];
    const n = rnd() < 0.55 ? 0 : 1;
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.4) {
        out.push(asg(pick(NAMES), val()));
      } else if (r < 0.7) {
        out.push(st(val(), val()));
      } else {
        out.push({ k: 'exprstmt', value: call(`F${Math.floor(rnd() * 3)}`) });
      }
    }
    return out;
  };
  const terminal = (): Stmt[] => {
    const defs: Stmt[] = [asg('t0', val()), asg('t1', val())];
    if (rnd() < 0.5) {
      defs.reverse();
    }
    if (rnd() < 0.3) {
      defs.splice(1, 0, asg('q', val()));
    }
    return [...noise(), ...defs];
  };
  const ladder = (n: number): Stmt => {
    const cond = v(pick(CONDS));
    if (n <= 2) {
      return { k: 'if', cond, then: terminal(), else: terminal() };
    }
    const rest = rnd() < 0.25 ? [...noise(), ladder(n - 1)] : [ladder(n - 1)];
    return rnd() < 0.5
      ? { k: 'if', cond, then: terminal(), else: rest }
      : { k: 'if', cond, then: rest, else: terminal() };
  };
  const join: Stmt = rnd() < 0.6 ? st(v('t0'), v('t1')) : asg('q', { k: 'bin', op: '+', l: v('t0'), r: v('t1') });
  const body: Stmt[] = [...(rnd() < 0.3 ? noise() : []), ladder(2 + Math.floor(rnd() * 4)), join, st(c(15), v('q'))];
  return {
    name: 'f',
    params: [],
    locals: [...NAMES, ...CONDS].map((name) => ({ name, type: T.s(32) })),
    globals: [],
    retType: T.void(),
    body,
  };
}

describe('unmerge differential fuzz — the oracle this lever shipped without', () => {
  test('every tree the ladder ACCEPTS computes what the merged spelling computed', () => {
    let fired = 0;
    const bad: string[] = [];
    for (let seed = 1; seed <= 60000; seed++) {
      const before = gen(seed);
      let after: SFn | null;
      try {
        after = unmergeJoins(before);
      } catch (e) {
        bad.push(`seed ${seed}: THREW ${(e as Error).message}`);
        continue;
      }
      if (after === null) {
        continue;
      }
      fired++;
      for (let world = 0; world < 3; world++) {
        const seedMem = Array.from({ length: 16 }, (_, i) => (i * 31 + seed * 7 + world * 5) % 13);
        // the four ladder conditions are locals seeded to 0 by `run`; vary them through memory by
        // assigning them at the top of both trees identically
        const pre: Stmt[] = CONDS.map((n, i) => asg(n, c((seed >> (i + world)) & 1)));
        const a = { ...before, body: [...pre, ...before.body] };
        const b = { ...after, body: [...pre, ...after.body], locals: before.locals };
        let ra: World, rb: World;
        try {
          ra = run(a, seedMem);
        } catch (e) {
          bad.push(`seed ${seed}: BEFORE threw ${(e as Error).message}`);
          break;
        }
        try {
          rb = run({ ...b, locals: after.locals }, seedMem);
        } catch (e) {
          bad.push(`seed ${seed}/${world}: AFTER threw ${(e as Error).message}`);
          break;
        }
        if (JSON.stringify(ra) !== JSON.stringify(rb)) {
          bad.push(
            `seed ${seed}/${world}: TRACE DIVERGED\n  before ${JSON.stringify(ra)}\n  after  ${JSON.stringify(rb)}`,
          );
          break;
        }
      }
    }
    // A FIRE-COUNT FLOOR, the same guard narrowlocal-fuzz.test.ts carries: a generator that
    // drifted into producing only-declined trees would go green while judging nothing.
    expect(fired).toBeGreaterThan(1000);
    expect(bad.slice(0, 6)).toEqual([]);
    // 60000 seeds is ~0.9s alone, and this suite forks 211 files in parallel, where the sibling
    // measured the same shape of loop at 3.4x its solo cost — past vitest's 5s default, which
    // fails as a TIMEOUT rather than as a divergence. narrowlocal-fuzz.test.ts carries the same
    // budget for the same reason. The seed count itself is NOT the lever to turn down: at 15000
    // this arm fires 845 times, under its own 1000 floor (measured).
  }, 90_000);
});

// ARM 2 — the shape the FRESH RE-READ exists for: an INNER join site whose own join is an
// assignment to the OUTER merge name, so the inner rewrite duplicates a definition the outer
// site's (already-sampled) mention count still calls one.
function gen2(seed: number): SFn {
  const rnd = mulberry32(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
  const val = (d = 0): Expr => {
    const r = rnd();
    if (d > 1 || r < 0.45) {
      return c(Math.floor(rnd() * 8));
    }
    if (r < 0.6) {
      return v(pick(['s0', 't0']));
    }
    if (r < 0.85) {
      return mem(val(d + 1));
    }
    return { k: 'bin', op: '+', l: val(d + 1), r: val(d + 1) };
  };
  // a terminal arm is either a plain definition of `t0`, or an INNER un-merge site whose join
  // defines `t0` — the duplicating one
  const terminal = (): Stmt[] =>
    rnd() < 0.45
      ? [asg('t0', val())]
      : [
          { k: 'if', cond: v(pick(CONDS)), then: [asg('s0', val())], else: [asg('s0', val())] },
          asg('t0', mem(v('s0'))),
        ];
  const ladder = (n: number): Stmt => {
    const cond = v(pick(CONDS));
    if (n <= 2) {
      return { k: 'if', cond, then: terminal(), else: terminal() };
    }
    const rest = [ladder(n - 1)];
    return rnd() < 0.5
      ? { k: 'if', cond, then: terminal(), else: rest }
      : { k: 'if', cond, then: rest, else: terminal() };
  };
  const body: Stmt[] = [ladder(2 + Math.floor(rnd() * 4)), st(c(3), v('t0')), st(c(15), c(1))];
  return {
    name: 'f',
    params: [],
    locals: [...['s0', 't0'], ...CONDS].map((name) => ({ name, type: T.s(32) })),
    globals: [],
    retType: T.void(),
    body,
  };
}

describe('unmerge fuzz — nested sites, where the sampled mention count goes stale', () => {
  test('an inner site that DUPLICATES a definition never lets the outer one delete a live local', () => {
    let fired = 0;
    const bad: string[] = [];
    for (let seed = 1; seed <= 60000; seed++) {
      const before = gen2(seed);
      const after = unmergeJoins(before);
      if (after === null) {
        continue;
      }
      fired++;
      for (let world = 0; world < 4; world++) {
        const seedMem = Array.from({ length: 16 }, (_, i) => (i * 31 + seed * 7 + world * 5) % 13);
        const pre: Stmt[] = CONDS.map((n, i) => asg(n, c((seed >> (i + world)) & 1)));
        const a = { ...before, body: [...pre, ...before.body] };
        const b = { ...after, body: [...pre, ...after.body] };
        try {
          const ra = run(a, seedMem);
          const rb = run(b, seedMem);
          if (JSON.stringify(ra) !== JSON.stringify(rb)) {
            bad.push(`seed ${seed}/${world}: DIVERGED ${JSON.stringify(ra)} vs ${JSON.stringify(rb)}`);
          }
        } catch (e) {
          bad.push(`seed ${seed}/${world}: ${(e as Error).message}`);
          break;
        }
      }
    }
    expect(fired).toBeGreaterThan(1000);
    expect(bad.slice(0, 4)).toEqual([]);
    // ~1.7s alone, the slower of the two arms — see the budget note above.
  }, 90_000);
});
