// Test-only builders the suites share. Not a `.test.ts`, so vitest's `include` never collects it
// and `offline-list.test.ts`'s `suites()` never counts it as a suite.
//
// What belongs here is a helper that was already spelled IDENTICALLY in several files — an
// expression constructor, a substring tally, the seeded PRNG. What does NOT belong here is a
// SEED: three fuzz sweeps sharing one would sample the same programs and stop being three
// independent sweeps, so every seed stays at its call site.
//
// The SSA generator and the tree interpreter below are the same three functions two differential
// fuzzes need — `namecoalesce-fuzz` for the `/merge-names` axis and `carrier-name-fuzz` for the
// naming walk's own admission table. They ask different questions of the same oracle: generate a
// function, structure it two ways, interpret both, and compare what they observed.
import { type Block, type Fn, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';

/** `{ k: 'var' }` — the leaf every tree-building test needs most. */
export const v = (name: string): Expr => ({ k: 'var', name });

/** `{ k: 'const' }`, the other leaf. */
export const c = (value: number): Expr => ({ k: 'const', value });

/** A signed 32-bit scalar, as the `locals`/`params` records spell it. */
export const s32 = { kind: 'int', width: 32, signed: true } as const;

/** How many times `needle` occurs in `s` — the emitted-source tally the value-home suites count
 *  spellings with. */
export const count = (s: string, needle: string): number => s.split(needle).length - 1;

/** Deterministic PRNG (mulberry32). The repo treats nondeterminism as hostile, so a fuzz sweep
 *  seeds this rather than reaching for `Math.random`, and a failing seed is a reproduction on its
 *  own.
 *
 *  ONE SPELLING serves every sweep, the `| 0` variant included: `(x + k) | 0` and
 *  `(x + k) >>> 0` differ only in how the 32-bit pattern is signed, and every operator downstream
 *  (`Math.imul`, `>>>`, `|`, `^`) reads the pattern rather than the sign. Checked draw for draw,
 *  10,000 draws on six seeds including `contract-invariant.test.ts`'s 0xa5c1f70d: no
 *  disagreement. */
export function mulberry32(seed: number): () => number {
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
export function generateSsaFn(seed: number, withLoop: boolean): Fn {
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
  return { name: `fz${seed}`, blocks, writeOrder: undefined, slotHomes: undefined };
}

/** A local that no path assigned. It POISONS: an expression over one is as indeterminate as it is,
 *  so it must not re-enter the defined world as a number and over-report a difference. */
const UNDEF = null;
type Val = number | typeof UNDEF;

/** One observable: a call with the values it received, or the function's result. */
export interface Event {
  fn: string;
  args: Val[];
}

/** Every observable the emitted tree produces, in execution order. Conditions are evaluated for
 *  REAL — a naming defect that changes one changes the PATH, which is a difference worth catching
 *  (it changed a loop's trip count once). Parameters are seeded, or every value is UNDEF and the
 *  comparison below has nothing to compare. */
export function traceOf(sfn: SFn, seed: number): Event[] {
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
  // `return` LEAVES THE FUNCTION, and a `break` leaves only its own loop. Collapsing the three
  // into "stop this statement list" — the shape this started as — keeps interpreting past a
  // return, so two trees that differ only in whether an `else` arm exists observe different
  // events after it and the comparison reports a clobber that no execution has. The `while` and
  // `for` forms let a `continue` fall through to the update, which is what C does.
  const exec = (list: Stmt[]): 'none' | 'break' | 'continue' | 'return' => {
    for (const s of list) {
      if (++steps > 4000) throw new Error('step cap');
      switch (s.k) {
        case 'assign':
          env.set(s.name, evalExpr(s.value));
          break;
        case 'exprstmt':
          evalExpr(s.value);
          break;
        case 'if': {
          const sig = truthy(s.cond) ? exec(s.then) : exec(s.else ?? []);
          if (sig !== 'none') return sig;
          break;
        }
        case 'while':
          while (truthy(s.cond)) {
            if (++steps > 4000) throw new Error('step cap');
            const sig = exec(s.body);
            if (sig === 'return') return sig;
            if (sig === 'break') break;
          }
          break;
        case 'dowhile':
          do {
            if (++steps > 4000) throw new Error('step cap');
            const sig = exec(s.body);
            if (sig === 'return') return sig;
            if (sig === 'break') break;
          } while (truthy(s.cond));
          break;
        case 'for':
          exec([s.init]);
          while (truthy(s.cond)) {
            if (++steps > 4000) throw new Error('step cap');
            const sig = exec(s.body);
            if (sig === 'return') return sig;
            if (sig === 'break') break;
            exec([s.inc]);
          }
          break;
        case 'return':
          trace.push({ fn: 'ret', args: s.value === undefined ? [] : [evalExpr(s.value)] });
          return 'return';
        case 'break':
          return 'break';
        case 'continue':
          return 'continue';
        default:
          throw new Error(`the generator does not emit ${s.k}`);
      }
    }
    return 'none';
  };
  exec(sfn.body);
  return trace;
}

// A position where EITHER side is UNDEF constrains nothing: the original read a local no path had
// assigned, so both spellings are ill-defined there rather than one being wrong. Everything else —
// a different callee, a different argument, a different trace LENGTH (which is what a changed trip
// count looks like) — is a clobber.
export const tracesDiffer = (r: { off: Event[]; on: Event[] }): boolean => {
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
