// The differential fuzz behind NARROW_LOCAL_GATES — the oracle this pass shipped without.
//
// `raise/narrowlocal.ts` is a DEFAULT that changes what the emitted C computes, and no gate the
// benchmark runs can see it get that wrong: a carrier typed narrower than its readers observe
// still compiles, still scores, and simply computes something else. Both criticals the first
// review found moved zero benchmark rows. So the oracle is the program's own behaviour — structure
// the same IR twice, once with the pass and once without, interpret both emitted trees, and
// require the same observable trace.
//
// THE INTERPRETER HONOURS DECLARED WIDTHS, which is the whole reason this file is not a copy of
// namecoalesce-fuzz.test.ts: that one models a `cast` as the identity, which is exactly blind to
// the property this pass changes. Here an assignment through an `s16` local truncates, and so does
// a cast — so a carrier narrowed against a reader that observes the dropped bits shows up as a
// different number rather than as a different spelling.
//
// Arm A: no narrowing the pass makes changes what the function does. Arm B drops each gate the
// table calls SOUND and requires that one of them DOES — written over the table, so a rule added
// later is held to the same bar without anyone remembering to. Two gates are exempt with their
// reasons stated at `OUT_OF_REACH`.
import { describe, expect, test } from 'vitest';

import { type Block, type Fn, type Value, mkOp, mkValue } from '../src/ir/core';
import { type IrType, T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { type Expr, type SFn, type Stmt } from '../src/l3/ast';
import { without } from '../src/l3/gates';
import { NARROW_LOCAL_GATES, narrowBlockLocals } from '../src/raise/narrowlocal';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random SSA function whose block parameters are often EXTENDED at their reads — the shape this
 *  pass judges. Definitions dominate uses by construction (entry values plus the reading block's
 *  own), so `verify` passes with no repair. */
function generate(seed: number, withLoop: boolean): Fn {
  const rnd = mulberry32(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
  const nBlocks = 4 + Math.floor(rnd() * 3);
  const a0 = mkValue(T.unk());
  const a1 = mkValue(T.unk());
  const blocks: Block[] = [{ params: [a0, a1], ops: [] }];
  for (let i = 1; i < nBlocks; i++) {
    blocks.push({ params: Array.from({ length: Math.floor(rnd() * 3) }, () => mkValue(T.unk())), ops: [] });
  }
  const entryVals: Value[] = [a0, a1];
  for (let i = 0; i < 2; i++) {
    const r = mkValue(T.unk());
    blocks[0].ops.push(mkOp('const', { results: [r], attrs: { value: Math.floor(rnd() * 300) - 100 } }));
    entryVals.push(r);
  }
  const loopHeader = withLoop ? 1 + Math.floor(rnd() * (nBlocks - 2)) : -1;
  for (let i = 0; i < nBlocks; i++) {
    const b = blocks[i];
    const avail = [...entryVals, ...b.params];
    // A parameter's FIRST reader decides whether this pass sees a width at all, so lead with one:
    // an extension of it, sometimes doubled (`zext` then `sext` — the write-back sunk to a join).
    for (const p of b.params) {
      if (i === 0 || rnd() >= 0.75) {
        continue;
      }
      const w = rnd() < 0.5 ? 8 : 16;
      const e = mkValue(T.unk());
      b.ops.push(mkOp(rnd() < 0.5 ? 'sext' : 'zext', { operands: [p], results: [e], attrs: { width: w } }));
      avail.push(e);
      if (rnd() < 0.3) {
        const e2 = mkValue(T.unk());
        b.ops.push(mkOp('sext', { operands: [e], results: [e2], attrs: { width: w } }));
        avail.push(e2);
      }
    }
    for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
      const r = mkValue(T.unk());
      const roll = rnd();
      b.ops.push(
        roll < 0.25
          ? mkOp('call', { operands: [pick(avail)], results: [r], attrs: { target: `f${k % 3}` } })
          : roll < 0.45
            ? mkOp(rnd() < 0.5 ? 'sext' : 'zext', {
                operands: [pick(avail)],
                results: [r],
                attrs: { width: rnd() < 0.5 ? 8 : 16 },
              })
            : mkOp(pick(['add', 'sub']), { operands: [pick(avail), pick(avail)], results: [r] }),
      );
      avail.push(r);
    }
    const argsFor = (t: Block): Value[] => t.params.map(() => pick(avail));
    if (i === nBlocks - 1) {
      b.ops.push(mkOp('ret', { operands: [pick(avail)] }));
      continue;
    }
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
  return { name: `nl${seed}`, blocks };
}

const UNDEF = null;
type Val = number | typeof UNDEF;

interface Event {
  fn: string;
  args: Val[];
}

/** The C semantics this pass rests on: a value STORED into a declaration of `t` keeps only `t`'s
 *  bits, and is read back at that signedness. Modelling this — rather than treating a cast as the
 *  identity — is what makes a wrongly narrowed carrier a different NUMBER instead of a different
 *  spelling. */
const coerce = (v: Val, t: IrType | undefined): Val => {
  if (v === UNDEF || t === undefined || t.kind !== 'int' || t.width >= 32 || t.width === 0) {
    return v;
  }
  const masked = v & ((1 << t.width) - 1);
  return t.signed && masked & (1 << (t.width - 1)) ? masked - (1 << t.width) : masked;
};

/** Every observable the emitted tree produces, in execution order. */
function run(sfn: SFn, seed: number): Event[] {
  const trace: Event[] = [];
  const env = new Map<string, Val>();
  const declared = new Map<string, IrType>();
  sfn.params.forEach((p, i) => {
    declared.set(p.name, p.type);
    env.set(p.name, coerce(((seed >> (i * 3)) % 4001) - 2000, p.type));
  });
  sfn.locals.forEach((l) => declared.set(l.name, l.type));
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
        calls++;
        return args.some((a) => a === UNDEF) ? UNDEF : args.reduce((x: number, y) => x + (y as number), calls) | 0;
      }
      case 'un':
        return evalExpr(e.e) === UNDEF ? UNDEF : -(evalExpr(e.e) as number) | 0;
      case 'cast':
        return coerce(evalExpr(e.e), e.to);
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
          env.set(s.name, coerce(evalExpr(s.value), declared.get(s.name)));
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

const SEEDS = 15000;

/** Both spellings of one seed, plus whether the pass actually fired — a seed it left alone
 *  constrains nothing and must not be counted as evidence. */
function spellings(
  seed: number,
  withLoop: boolean,
  gates: readonly (typeof NARROW_LOCAL_GATES)[number][] = NARROW_LOCAL_GATES,
): { off: Event[]; on: Event[]; fired: number } | null {
  let base: Fn;
  let narrowed: Fn;
  let fired: number;
  try {
    base = generate(seed, withLoop);
    narrowed = generate(seed, withLoop);
    verify(base);
    fired = narrowBlockLocals(narrowed, gates);
    verify(narrowed);
    recoverTypes(base);
    recoverTypes(narrowed);
  } catch {
    return null;
  }
  if (fired === 0) {
    return null;
  }
  let off: SFn;
  let on: SFn;
  try {
    off = structure(base, {});
    on = structure(narrowed, {});
  } catch {
    return null;
  }
  try {
    return { off: run(off, seed), on: run(on, seed), fired };
  } catch {
    return null;
  }
}

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
  test('no narrowing the pass makes changes what the function does', () => {
    const bad: number[] = [];
    let judged = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = spellings(seed, withLoop);
      if (!r) continue;
      judged++;
      if (differs(r)) bad.push(seed);
    }
    // the sweep is not vacuous: the pass really fires and both trees interpret. At 15000 seeds
    // that is 373 acyclic and 262 loop-bearing functions; the floor sits well under both, so a
    // generator tweak cannot turn this green by quietly narrowing nothing.
    expect(judged).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });
});

// The two sound rules this oracle cannot reach, and why — an exemption is a visible act with a
// reason, never a dropped assertion.
//
//   `reader-is-extension` and `cast-width` are ONE argument in two entries: a non-extension reader
//   states `width = 0` and the other refuses it, so ablating either alone is inert BY
//   CONSTRUCTION. Their joint ablation is the guard, and it is a fixture in narrow-local.test.ts
//   (`the width pair is jointly load-bearing and neither half alone`) rather than a fuzz arm,
//   because what it produces — a `u0` declaration and a spliced-out operand — is not a different
//   trace but an un-interpretable tree.
//
//   `entry-param` is sound in ANOTHER table: dropping it does not merely re-decide a parameter, it
//   takes the decision from raise/paramwidth.ts, whose `proto-width` reads a caller's prototype
//   this generator has none of. Its guard is the fixture of the same name.
//
//   `param-typed` needs a block parameter the struct/array recognizers already typed, and every
//   value this generator makes is `unk32` — the same shape of exemption namecoalesce-fuzz makes
//   for `type`. Its guard is the fixture of the same name.
const OUT_OF_REACH = new Set(['reader-is-extension', 'cast-width', 'entry-param', 'param-typed']);

test('every SOUND gate is load-bearing: dropping it changes what some function does', () => {
  const inert: string[] = [];
  for (const g of NARROW_LOCAL_GATES.filter((x) => x.sound && !OUT_OF_REACH.has(x.id))) {
    let found = false;
    for (const withLoop of [false, true]) {
      for (let seed = 1; seed <= SEEDS && !found; seed++) {
        const r = spellings(seed, withLoop, without(NARROW_LOCAL_GATES, g.id) as never);
        if (r && differs(r)) found = true;
      }
      if (found) break;
    }
    if (!found) inert.push(g.id);
  }
  expect(inert).toEqual([]);
  expect([...OUT_OF_REACH].filter((id) => !NARROW_LOCAL_GATES.some((g) => g.id === id && g.sound))).toEqual([]);
});
