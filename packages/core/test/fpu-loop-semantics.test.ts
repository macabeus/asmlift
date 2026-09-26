// A float loop's updates, run: every candidate a mwcc float loop lifts to computes what the source
// computes. The shape is mwcc's unrolled `bdnz` body, where each update reads a register the one
// before it has just rewritten — a candidate that reads the rewritten name for the old value is
// ordinary-looking C with a different answer, and no byte score sees it, so this file RUNS each
// candidate's tree against the source on the same inputs.
//
// Toolchain-free: the listing below is committed, and the tree is interpreted here in single
// precision (`Math.fround` after every float operator, which is exact for + - * / of floats).
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { IrType } from '../src/ir/types';
import type { Expr, LanguageBackend, SFn, Stmt } from '../src/l3/ast';
import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { PPC_MWCC } from '../src/target';
import { mulberry32 } from './helpers';

// Compiled with the synthetic tier's mwcc_242_81 flags (`-proc gekko -O4,p -fp hard -lang=c`) from
//   float g_fib(float a, float b, int n){ int i; for (i = 0; i < n; i++) { float t = a + b; a = b; b = t; } return b - a; }
//   float g_rot(float a, float b, float c, int n){ while (n-- > 0) { float t = a; a = b; b = c; c = t - c; } return a / c; }
// and disassembled `--no-show-raw-insn`. Both unroll by eight under a `bdnz`, with a remainder loop.
const LISTING = `000000e4 <g_fib>:
  e4:\tcmpwi   r3,0
  e8:\tli      r5,0
  ec:\tble     158 <g_fib+0x74>
  f0:\tcmpwi   r3,8
  f4:\taddi    r4,r3,-8
  f8:\tble     138 <g_fib+0x54>
  fc:\taddi    r0,r4,7
 100:\tsrwi    r0,r0,3
 104:\tmtctr   r0
 108:\tcmpwi   r4,0
 10c:\tble     138 <g_fib+0x54>
 110:\tfadds   f1,f1,f2
 114:\taddi    r5,r5,8
 118:\tfadds   f0,f2,f1
 11c:\tfadds   f1,f1,f0
 120:\tfadds   f0,f0,f1
 124:\tfadds   f1,f1,f0
 128:\tfadds   f0,f0,f1
 12c:\tfadds   f1,f1,f0
 130:\tfadds   f2,f0,f1
 134:\tbdnz    110 <g_fib+0x2c>
 138:\tsubf    r0,r5,r3
 13c:\tmtctr   r0
 140:\tcmpw    r5,r3
 144:\tbge     158 <g_fib+0x74>
 148:\tfadds   f0,f1,f2
 14c:\tfmr     f1,f2
 150:\tfmr     f2,f0
 154:\tbdnz    148 <g_fib+0x64>
 158:\tfsubs   f1,f2,f1
 15c:\tblr

00000024 <g_rot>:
  24:\tcmpwi   r3,0
  28:\tble     dc <g_rot+0xb8>
  2c:\tsrwi.   r0,r3,3
  30:\tmtctr   r0
  34:\tbeq     c4 <g_rot+0xa0>
  38:\tfmr     f0,f1
  3c:\tfmr     f1,f2
  40:\tfmr     f2,f3
  44:\tfsubs   f3,f0,f3
  48:\tfmr     f0,f1
  4c:\tfmr     f1,f2
  50:\tfmr     f2,f3
  54:\tfsubs   f3,f0,f3
  58:\tfmr     f0,f1
  5c:\tfmr     f1,f2
  60:\tfmr     f2,f3
  64:\tfsubs   f3,f0,f3
  68:\tfmr     f0,f1
  6c:\tfmr     f1,f2
  70:\tfmr     f2,f3
  74:\tfsubs   f3,f0,f3
  78:\tfmr     f0,f1
  7c:\tfmr     f1,f2
  80:\tfmr     f2,f3
  84:\tfsubs   f3,f0,f3
  88:\tfmr     f0,f1
  8c:\tfmr     f1,f2
  90:\tfmr     f2,f3
  94:\tfsubs   f3,f0,f3
  98:\tfmr     f0,f1
  9c:\tfmr     f1,f2
  a0:\tfmr     f2,f3
  a4:\tfsubs   f3,f0,f3
  a8:\tfmr     f0,f1
  ac:\tfmr     f1,f2
  b0:\tfmr     f2,f3
  b4:\tfsubs   f3,f0,f3
  b8:\tbdnz    38 <g_rot+0x14>
  bc:\tandi.   r3,r3,7
  c0:\tbeq     dc <g_rot+0xb8>
  c4:\tmtctr   r3
  c8:\tfmr     f0,f1
  cc:\tfmr     f1,f2
  d0:\tfmr     f2,f3
  d4:\tfsubs   f3,f0,f3
  d8:\tbdnz    c8 <g_rot+0xa4>
  dc:\tfdivs   f1,f1,f3
  e0:\tblr`;

const f = Math.fround;
const REFERENCE: Record<string, (x: number[], n: number) => number> = {
  g_fib: ([a0, b0], n) => {
    let [a, b] = [a0, b0];
    for (let i = 0; i < n; i++) {
      const t = f(a + b);
      a = b;
      b = t;
    }
    return f(b - a);
  },
  g_rot: ([a0, b0, c0], n) => {
    let [a, b, c] = [a0, b0, c0];
    while (n-- > 0) {
      const t = a;
      a = b;
      b = c;
      c = f(t - c);
    }
    return f(a / c);
  },
};

/** The C type an expression evaluates at: a float, or a 32-bit integer of one signedness. */
type Ty = 'f' | 's' | 'u';
const tyOf = (t: IrType): Ty => (t.kind === 'float' ? 'f' : t.kind === 'int' && !t.signed ? 'u' : 's');
const asTy = (v: number, t: Ty): number => (t === 'f' ? f(v) : t === 'u' ? v >>> 0 : v | 0);

/** Run `sfn` on `args`. Throws on any node it does not model, so a shape it cannot judge is loud. */
function run(sfn: SFn, args: number[]): number {
  const types = new Map<string, Ty>([...sfn.params, ...sfn.locals].map((d) => [d.name, tyOf(d.type)]));
  const env = new Map<string, number>(sfn.params.map((p, i) => [p.name, asTy(args[i], tyOf(p.type))]));
  let steps = 0;
  const ev = (e: Expr): { v: number; t: Ty } => {
    switch (e.k) {
      case 'var': {
        const v = env.get(e.name);
        if (v === undefined) {
          throw new Error(`read of unassigned ${e.name}`);
        }
        return { v, t: types.get(e.name)! };
      }
      case 'const':
        return { v: e.value | 0, t: 's' };
      case 'cast': {
        const x = ev(e.e);
        const t = tyOf(e.to);
        return { v: x.t === 'f' && t !== 'f' ? asTy(Math.trunc(x.v), t) : asTy(x.v, t), t };
      }
      case 'un': {
        const x = ev(e.e);
        if (e.op === 'f-') {
          return { v: f(-x.v), t: 'f' };
        }
        if (e.op === '-') {
          return { v: asTy(-x.v, x.t), t: x.t };
        }
        if (e.op === '~') {
          return { v: asTy(~x.v, x.t), t: x.t };
        }
        return { v: x.v === 0 ? 1 : 0, t: 's' };
      }
      case 'bin': {
        const l = ev(e.l);
        if (e.op === '&&' || e.op === '||') {
          const short = (l.v !== 0) === (e.op === '||');
          return { v: short ? (e.op === '||' ? 1 : 0) : ev(e.r).v !== 0 ? 1 : 0, t: 's' };
        }
        const r = ev(e.r);
        const t: Ty = l.t === 'f' || r.t === 'f' ? 'f' : l.t === 'u' || r.t === 'u' ? 'u' : 's';
        const a = asTy(l.v, t);
        const b = asTy(r.v, t);
        switch (e.op) {
          case 'f+':
            return { v: f(l.v + r.v), t: 'f' };
          case 'f-':
            return { v: f(l.v - r.v), t: 'f' };
          case 'f*':
            return { v: f(l.v * r.v), t: 'f' };
          case 'f/':
            return { v: f(l.v / r.v), t: 'f' };
          case '+':
            return { v: asTy(a + b, t), t };
          case '-':
            return { v: asTy(a - b, t), t };
          case '*':
            return { v: asTy(Math.imul(a, b), t), t };
          case '&':
            return { v: asTy(a & b, t), t };
          case '|':
            return { v: asTy(a | b, t), t };
          case '^':
            return { v: asTy(a ^ b, t), t };
          case '<<':
            return { v: asTy(a << (b & 31), l.t), t: l.t };
          case '>>>':
            return { v: asTy(l.v, 'u') >>> (b & 31), t: 'u' };
          case '>>':
            return { v: l.t === 'u' ? asTy(l.v, 'u') >>> (b & 31) : (l.v | 0) >> (b & 31), t: l.t };
          case '<':
            return { v: a < b ? 1 : 0, t: 's' };
          case '>':
            return { v: a > b ? 1 : 0, t: 's' };
          case '<=':
            return { v: a <= b ? 1 : 0, t: 's' };
          case '>=':
            return { v: a >= b ? 1 : 0, t: 's' };
          case '==':
            return { v: a === b ? 1 : 0, t: 's' };
          case '!=':
            return { v: a !== b ? 1 : 0, t: 's' };
          default:
            throw new Error(`unmodelled operator ${e.op}`);
        }
      }
      default:
        throw new Error(`unmodelled expression ${e.k}`);
    }
  };
  const truthy = (e: Expr): boolean => ev(e).v !== 0;
  const exec = (list: Stmt[]): { ret: number } | 'break' | 'continue' | null => {
    for (const s of list) {
      if (++steps > 100_000) {
        throw new Error('step cap');
      }
      switch (s.k) {
        case 'assign': {
          const t = types.get(s.name);
          if (t === undefined) {
            throw new Error(`assignment to undeclared ${s.name}`);
          }
          env.set(s.name, asTy(ev(s.value).v, t));
          break;
        }
        case 'if': {
          const sig = exec(truthy(s.cond) ? s.then : (s.else ?? []));
          if (sig !== null) {
            return sig;
          }
          break;
        }
        case 'while':
          while (truthy(s.cond)) {
            const sig = exec(s.body);
            if (sig === 'break') {
              break;
            }
            if (sig !== null && sig !== 'continue') {
              return sig;
            }
          }
          break;
        case 'dowhile':
          do {
            const sig = exec(s.body);
            if (sig === 'break') {
              break;
            }
            if (sig !== null && sig !== 'continue') {
              return sig;
            }
          } while (truthy(s.cond));
          break;
        case 'return':
          if (s.value === undefined) {
            throw new Error('a float function returned nothing');
          }
          return { ret: asTy(ev(s.value).v, tyOf(sfn.retType)) };
        case 'break':
          return 'break';
        case 'continue':
          return 'continue';
        default:
          throw new Error(`unmodelled statement ${s.k}`);
      }
    }
    return null;
  };
  const out = exec(sfn.body);
  if (out === null || typeof out === 'string') {
    throw new Error('fell off the end of a float function');
  }
  return out.ret;
}

/** Every distinct candidate, as the tree it was emitted from: a backend that records what it is
 *  handed is the only place the enumeration's trees are visible. */
function candidateTrees(sym: string): SFn[] {
  const trees = new Map<string, SFn>();
  const recording: LanguageBackend = {
    ...cBackend,
    emit: (sfn) => {
      const src = cBackend.emit(sfn);
      trees.set(src, sfn);
      return src;
    },
  };
  const cands = enumerateCandidates(sym, LISTING, PPC_MWCC, { backend: recording });
  const out = cands.map((c) => trees.get(c.source));
  expect(
    out.every((t) => t !== undefined),
    'every candidate is a tree the backend was handed',
  ).toBe(true);
  return [decompile(sym, LISTING, PPC_MWCC).sfn, ...(out as SFn[])];
}

const POOL = [
  0,
  -0,
  1,
  -1,
  1.5,
  -2.75,
  3.1,
  1e30,
  -1e30,
  1e-38,
  1e-45,
  0.1,
  7,
  65536.5,
  -0.3333,
  Infinity,
  -Infinity,
  NaN,
];
const INPUTS = 1500;

describe('a mwcc float loop computes what its source computes, on every candidate', () => {
  test.each([
    ['g_fib', 2],
    ['g_rot', 3],
  ] as const)('%s', (sym, floats) => {
    const rnd = mulberry32(262);
    const pick = (): number => (rnd() < 0.8 ? f(POOL[Math.floor(rnd() * POOL.length)]) : f((rnd() - 0.5) * 2000));
    const trees = candidateTrees(sym);
    expect(trees.length).toBeGreaterThan(1);
    for (const sfn of trees) {
      // the order the lift binds them in: the integer count first, then the floats (EABI 'separate')
      expect(sfn.params.map((p) => tyOf(p.type))).toEqual([
        expect.stringMatching(/^[su]$/),
        ...Array(floats).fill('f'),
      ]);
      let wrong = 0;
      for (let i = 0; i < INPUTS; i++) {
        const x = Array.from({ length: floats }, pick);
        const n = Math.floor(rnd() * 24) - 3;
        const want = REFERENCE[sym](x, n);
        const got = run(sfn, [n, ...x]);
        if (!Object.is(want, got) && !(Number.isNaN(want) && Number.isNaN(got))) {
          wrong++;
        }
      }
      expect(wrong, cBackend.emit(sfn)).toBe(0);
    }
  });
});
