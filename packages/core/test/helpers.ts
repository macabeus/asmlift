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
// function, structure it two ways, interpret both, and compare what they observed. `irTraceOf` is
// the oracle for the question neither can ask — whether EVERY spelling is wrong the same way.
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
 *  definitions dominate uses by construction and `verify` passes without a repair pass.
 *
 *  `depth` is how many loops deep it goes. 0 and 1 randomize the CFG itself — the forward chain
 *  plus a skip edge, and any block past the header may be a latch. 2 fixes the SHAPE (entry, outer
 *  header, inner header, inner latch, outer latch, tail) and randomizes only the ops and the edge
 *  arguments: a skip edge that lands inside a loop body from outside makes the region irreducible,
 *  and what depth 2 exists to reach is the value that is carried by BOTH loops — the accumulator a
 *  nested `for` writes, whose home is outside the inner loop it is nevertheless updated in. */
export function generateSsaFn(seed: number, depth: 0 | 1 | 2, readsOuter = false): Fn {
  const rnd = mulberry32(seed);
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];
  const nBlocks = depth === 2 ? 6 + Math.floor(rnd() * 2) : 4 + Math.floor(rnd() * 3);
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
  const loopHeader = depth === 1 ? 1 + Math.floor(rnd() * (nBlocks - 2)) : -1;
  // depth 2: ^bb1 outer header, ^bb2 inner header, ^bb3 inner latch, ^bb4 outer latch
  const innerHeader = depth === 2 ? 2 : -1;
  // `readsOuter` (depth 2 only): the blocks inside the outer loop may also read what the OUTER
  // header defined — its params and ops, which dominate them — so a value carried by the outer loop
  // can still be live after the inner one ran. Not the tail, and not the inner header's values: a
  // read of a loop header's param past its own loop is a shape the do-while emitter declines. Off by
  // default, and then `avail` and the stream are exactly what they were — the fuzz arms state their
  // measurements per SEED (`carrier-name-fuzz`'s 1472 and 1062), which a moved stream repoints
  // silently. The IR witnesses in `loop-escape-witnesses.ts` are frozen precisely so they do not.
  const outerDefs: Value[] = [];
  for (let i = 0; i < nBlocks; i++) {
    const b = blocks[i];
    const insideOuter = readsOuter && depth === 2 && i > 1 && i <= innerHeader + 2;
    const avail = [...entryVals, ...(insideOuter ? outerDefs : []), ...b.params];
    for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
      const r = mkValue(T.s(32));
      b.ops.push(
        rnd() < 0.35
          ? mkOp('call', { operands: [pick(avail)], results: [r], attrs: { target: `f${k % 3}` } })
          : mkOp(pick(['add', 'sub']), { operands: [pick(avail), pick(avail)], results: [r] }),
      );
      avail.push(r);
    }
    if (readsOuter && i === 1) {
      outerDefs.push(...b.params, ...b.ops.flatMap((o) => o.results));
    }
    const argsFor = (t: Block): Value[] => t.params.map(() => pick(avail));
    if (i === nBlocks - 1) {
      b.ops.push(mkOp('ret', { operands: [pick(avail)] }));
      continue;
    }
    const fwd = blocks[i + 1];
    if (depth === 2) {
      // the fixed nested skeleton: a straight chain, with a guarded back edge at each latch
      const back = i === innerHeader + 1 ? blocks[innerHeader] : i === innerHeader + 2 ? blocks[1] : undefined;
      if (back === undefined) {
        b.ops.push(mkOp('br', { successors: [{ block: fwd, args: argsFor(fwd) }] }));
        continue;
      }
      const cc = mkValue(T.u(32));
      b.ops.push(mkOp('icmp_slt', { operands: [pick(avail), pick(avail)], results: [cc] }));
      b.ops.push(
        mkOp('cond_br', {
          operands: [cc],
          successors: [
            { block: back, args: argsFor(back) },
            { block: fwd, args: argsFor(fwd) },
          ],
        }),
      );
      continue;
    }
    // a back edge to `loopHeader` needs a guard, or the loop never exits
    const isLatch = depth === 1 && i > loopHeader && rnd() < 0.6;
    const c = mkValue(T.u(32));
    b.ops.push(mkOp('icmp_slt', { operands: [pick(avail), pick(avail)], results: [c] }));
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

/** Where a global `name` lives, for both interpreters: a store's address is an observable, so the
 *  IR's `gaddr` and the tree's `&name` have to agree on it. Word-aligned and far apart, so no
 *  constant offset a fixture uses carries one symbol onto another. */
export const symAddr = (name: string): number =>
  (([...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) & 0xfff, 7) + 1) * 0x10000) | 0;

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
        if (e.op === '&&' || e.op === '||') {
          // short-circuit: the right side runs only when the left does not decide it
          if (l === UNDEF) {
            return UNDEF;
          }
          if ((l !== 0) === (e.op === '||')) {
            return e.op === '||' ? 1 : 0;
          }
          const rr = evalExpr(e.r);
          return rr === UNDEF ? UNDEF : rr !== 0 ? 1 : 0;
        }
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
      case 'un': {
        const x = evalExpr(e.e);
        if (x === UNDEF) {
          return UNDEF;
        }
        return e.op === '!' ? (x === 0 ? 1 : 0) : e.op === '~' ? ~x : -x | 0;
      }
      case 'cast':
        return evalExpr(e.e);
      case 'addr':
        return symAddr(e.name);
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
        case 'store': {
          // A store is observed as (address, value); only the `base[idx]` lvalue is modelled.
          if (s.lval.k !== 'index') {
            throw new Error(`unmodelled store lvalue ${s.lval.k}`);
          }
          const base = evalExpr(s.lval.base);
          const idx = evalExpr(s.lval.idx);
          const at = base === UNDEF || idx === UNDEF ? UNDEF : (base + idx * s.lval.width) | 0;
          trace.push({ fn: 'store', args: [at, evalExpr(s.value)] });
          break;
        }
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

/** The same observables as {@link traceOf}, read off the IR itself rather than a structured tree —
 *  the oracle for a defect the structurer's OWN admit-nothing spelling also has. `traceOf` against
 *  that reference compares one naming with another, so an EMISSION defect both share is invisible
 *  to it: an inner loop's back-edge value re-derived at the enclosing loop's latch was wrong in
 *  every spelling at once, and only this caught it. Same seeding, same deterministic call model,
 *  same 32-bit wrap. The generator's vocabulary only; anything else throws, as does a run past the
 *  step cap. */
export function irTraceOf(fn: Fn, seed: number): Event[] {
  const trace: Event[] = [];
  const env = new Map<Value, number>();
  fn.blocks[0].params.forEach((p, i) => env.set(p, ((seed >> (i * 3)) % 11) - 5));
  let calls = 0;
  let steps = 0;
  const read = (x: Value): number => {
    const n = env.get(x);
    if (n === undefined) {
      throw new Error('read of an undefined value');
    }
    return n;
  };
  let b: Block = fn.blocks[0];
  for (;;) {
    let next: { block: Block; args: Value[] } | undefined;
    for (const op of b.ops) {
      if (++steps > 20000) {
        throw new Error('step cap');
      }
      const o = op.operands.map(read);
      const r = op.results[0];
      switch (op.opcode) {
        case 'const':
          env.set(r, op.attrs.value as number);
          break;
        case 'add':
          env.set(r, (o[0] + o[1]) | 0);
          break;
        case 'sub':
          env.set(r, (o[0] - o[1]) | 0);
          break;
        case 'icmp_slt':
          env.set(r, o[0] < o[1] ? 1 : 0);
          break;
        // the comparisons a real Thumb lift of a fixture's `cmp` produces
        case 'icmp_sge':
          env.set(r, o[0] >= o[1] ? 1 : 0);
          break;
        case 'icmp_eq':
          env.set(r, o[0] === o[1] ? 1 : 0);
          break;
        // raise's short-circuit recovery folds a condition tree into these; both operands are
        // already computed values, so there is nothing to short-circuit
        case 'logic_and':
          env.set(r, o[0] !== 0 && o[1] !== 0 ? 1 : 0);
          break;
        case 'logic_or':
          env.set(r, o[0] !== 0 || o[1] !== 0 ? 1 : 0);
          break;
        case 'call':
          trace.push({ fn: op.attrs.target as string, args: o });
          calls++;
          env.set(r, o.reduce((x, y) => x + y, calls) | 0);
          break;
        case 'gaddr':
          env.set(r, symAddr(op.attrs.sym as string));
          break;
        case 'store':
          trace.push({ fn: 'store', args: [(o[0] + ((op.attrs.off as number | undefined) ?? 0)) | 0, o[1]] });
          break;
        case 'ret':
          trace.push({ fn: 'ret', args: o });
          return trace;
        case 'br':
          next = op.successors[0];
          break;
        case 'cond_br':
          next = o[0] !== 0 ? op.successors[0] : op.successors[1];
          break;
        default:
          throw new Error(`the generator does not emit ${op.opcode}`);
      }
    }
    const vals = next!.args.map(read);
    next!.block.params.forEach((p, i) => env.set(p, vals[i]));
    b = next!.block;
  }
}

/** Hand the worker's event loop a turn, mid-sweep.
 *
 *  A fuzz arm here is tens of thousands of seeds of straight-line synchronous work — the
 *  `narrowlocal` file alone runs ~23 s of it solo, and its own sweeps measured 3.4x that under
 *  this suite's parallel forks. vitest's worker talks to the runner over birpc with a FIXED 60 s
 *  timeout (`DEFAULT_TIMEOUT` in vitest's rpc chunk; no config exposes it), so a file that never
 *  yields lets `onTaskUpdate`'s reply sit unread in the poll queue while the timer that gives up
 *  on it matures. Node runs the timers phase BEFORE the poll phase, so the timeout then fires
 *  even though the reply had already arrived — the run dies on
 *  `[vitest-worker]: Timeout calling "onTaskUpdate"` with every test passing.
 *
 *  `setImmediate` rather than a zero `setTimeout`: the check phase runs after poll, so the reply
 *  is read on the way in. */
export const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** How many seeds a sweep may run between breaths. Small enough that no stretch approaches the
 *  60 s RPC timeout even at the 3.4x fork-contention factor these sweeps measured; large enough
 *  that the yields themselves cost nothing measurable. */
export const BREATHE_EVERY = 512;
