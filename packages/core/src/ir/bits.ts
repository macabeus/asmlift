// KNOWN BITS over SSA values — an L2 fact about `Fn`, answered from declarations and instructions
// alone.
//
// This is not a spelling rule and it says nothing about C. It answers "how many significant bits
// can this value have", which is what every rule that needs to know whether a narrower container
// LOSES something must ask: the mask-and-insert fold's truncation bound (structure.ts), and the
// same question raise/narrowlocal.ts states for itself as "every value arriving on an in-edge is
// itself an extension of at most this width, or a constant".
//
// It is a function over `Fn` rather than a closure inside a rendering pass so that a test can ask
// it directly: reachable only through emitted C, a wrong answer for one opcode reads as a silent
// wrong address in a row nobody is looking at.
import type { Block, Op, Value } from './core';
import { OPCODES, type OpSig } from './opcodes';

/** A materialized def emits its own named temp, so its value is a VARIABLE at every use — never a
 *  literal this analysis may fold through. Callers that have no materialization model pass none. */
export interface BitsCtx {
  defs: Map<Value, Op>;
  materialize?: ReadonlySet<Op>;
  /** A bound a CALLER already knows for a def — the escape hatch for facts this layer cannot see,
   *  such as a bitfield read a rendering pass has recognized and can price from the declaration.
   *  Returning null defers to the rules below. A caller's answer must be a bound on the VALUE, not
   *  on the container it came out of: a SIGNED narrow read carries all 32 bits however few the
   *  declaration allots it. */
  bound?: (d: Op) => number | null;
}

/** A def's value as a compile-time CONSTANT, or null. A thumb `bic` lifts as `and` with `neg`/
 *  `not` of a constant, so those two spellings fold; anything else is not a literal. */
export function constMask(ctx: BitsCtx, v: Value): number | null {
  const d = ctx.defs.get(v);
  if (!d || ctx.materialize?.has(d)) {
    return null;
  }
  if (d.opcode === 'const') {
    return (d.attrs.value as number) | 0;
  }
  if ((d.opcode === 'neg' || d.opcode === 'not') && d.operands.length === 1) {
    const a = constMask(ctx, d.operands[0]);
    return a === null ? null : (d.opcode === 'neg' ? -a : ~a) | 0;
  }
  return null;
}

/** What the word evaluator below may read. */
export interface WordCtx {
  defs: ReadonlyMap<Value, Op>;
  /** Block param -> the value each in-edge passes for it (undefined: an edge that passes none). A
   *  param absent from it (an entry param, or every param when the caller gives none) holds no
   *  known word. */
  incoming?: ReadonlyMap<Value, readonly (Value | undefined)[]>;
  /** A value the caller says is no constant, whatever computes it: switch recovery's named
   *  variables, whose every use reads the variable rather than the expression that set it. */
  opaque?: (v: Value) => boolean;
}

/** A value's word, over a lattice: not yet seen (`top`, a loop-carried param before its back
 *  edge), one known word, a CONSTANT this evaluator cannot compute (`konst`: a pure op of words
 *  it has no rule for, or a register shift by 32 or more, which each ISA reads differently), or a
 *  value that varies (`var`). */
type Word = { k: 'top' } | { k: 'word'; w: number } | { k: 'konst' } | { k: 'var' };
const TOP: Word = { k: 'top' };
const KONST: Word = { k: 'konst' };
const VAR: Word = { k: 'var' };
const word = (w: number): Word => ({ k: 'word', w: w | 0 });
const sameWord = (a: Word, b: Word): boolean => a.k === b.k && (a.k !== 'word' || a.w === (b as { w: number }).w);
const meet = (a: Word, b: Word): Word =>
  a.k === 'top'
    ? b
    : b.k === 'top'
      ? a
      : a.k === 'var' || b.k === 'var'
        ? VAR
        : a.k === 'word' && b.k === 'word'
          ? a.w === b.w
            ? a
            : VAR
          : KONST;

const BINARY: Readonly<Record<string, (a: number, c: number) => number>> = {
  add: (a, c) => a + c,
  sub: (a, c) => a - c,
  mul: (a, c) => Math.imul(a, c),
  and: (a, c) => a & c,
  or: (a, c) => a | c,
  xor: (a, c) => a ^ c,
};
const SHIFT: Readonly<Record<string, (a: number, c: number) => number>> = {
  shl: (a, c) => a << c,
  shr_u: (a, c) => a >>> c,
  shr_s: (a, c) => a >> c,
};

/** One op's word, given its operands'. The annihilators come first because they hold whatever
 *  the other operand is: `x & 0`, `x | -1`, `x * 0`, `x - x`, `x ^ x`. */
function opWord(d: Op, of: (v: Value) => Word): Word {
  if (d.opcode === 'const') {
    const value = d.attrs.value;
    return typeof value === 'number'
      ? word(value)
      : typeof value === 'bigint'
        ? word(Number(BigInt.asIntN(32, value)))
        : KONST;
  }
  const sig = (OPCODES as Record<string, OpSig | undefined>)[d.opcode];
  if (!sig || sig.effects || sig.reads || sig.terminator || d.results.length !== 1 || d.operands.length === 0) {
    return VAR; // a load, a call, an address (`gaddr`: the linker's, not a word a compiler folds)
  }
  const imm = typeof d.attrs.imm === 'number' ? word(d.attrs.imm as number) : null;
  const ws = d.operands.map(of);
  const [a, c] = d.operands.length === 1 && imm !== null ? [ws[0], imm] : ws;
  const is = (x: Word | undefined, n: number) => x?.k === 'word' && x.w === n;
  if (
    (d.opcode === 'and' && (is(a, 0) || is(c, 0))) ||
    (d.opcode === 'mul' && (is(a, 0) || is(c, 0))) ||
    ((d.opcode === 'sub' || d.opcode === 'xor') && d.operands.length === 2 && d.operands[0] === d.operands[1])
  ) {
    return word(0);
  }
  if (d.opcode === 'or' && (is(a, -1) || is(c, -1))) {
    return word(-1);
  }
  const all = d.operands.length === 1 && imm !== null ? [a, c] : ws;
  if (all.some((x) => x.k === 'var')) {
    return VAR;
  }
  if (all.some((x) => x.k === 'top')) {
    return TOP;
  }
  if (all.some((x) => x.k !== 'word')) {
    return KONST;
  }
  const n = all.map((x) => (x as { w: number }).w);
  if ((d.opcode === 'neg' || d.opcode === 'not') && n.length === 1) {
    return word(d.opcode === 'neg' ? -n[0] : ~n[0]);
  }
  // The mathematical negation is the wrapping one at every word but INT_MIN, whose negation
  // (+2^31) is a constant and no word.
  if (d.opcode === 'neg_s' && n.length === 1) {
    return n[0] === -0x80000000 ? KONST : word(-n[0]);
  }
  if (n.length === 2 && d.opcode in BINARY) {
    return word(BINARY[d.opcode](n[0], n[1]));
  }
  if (n.length === 2 && d.opcode in SHIFT) {
    return n[1] >= 0 && n[1] < 32 ? word(SHIFT[d.opcode](n[0], n[1])) : KONST;
  }
  return KONST;
}

/** Solve every block param `ctx.incoming` names, optimistically: each starts unseen and drops to
 *  the meet of what its in-edges pass, until nothing moves — so a loop-carried param that only
 *  ever passes itself back keeps the word it entered with, and a counter (`0`, then `i + 1`)
 *  varies. Each param drops at most three times. */
function solveParams(ctx: WordCtx): Map<Value, Word> {
  const state = new Map<Value, Word>();
  const incoming = ctx.incoming ?? new Map<Value, readonly (Value | undefined)[]>();
  for (const p of incoming.keys()) {
    state.set(p, TOP);
  }
  for (let round = 0; ; round++) {
    if (round > 3 * state.size + 1) {
      throw new Error('constWord: block params did not settle');
    }
    const memo = new Map<Value, Word>();
    let moved = false;
    for (const [p, args] of incoming) {
      let w: Word = TOP;
      for (const x of args) {
        w = meet(w, x === undefined ? VAR : x === p ? TOP : evalWord(ctx, state, memo, x));
      }
      if (!sameWord(w, state.get(p)!)) {
        state.set(p, w);
        moved = true;
      }
    }
    if (!moved) {
      return state;
    }
  }
}

function evalWord(ctx: WordCtx, params: ReadonlyMap<Value, Word>, memo: Map<Value, Word>, v: Value): Word {
  if (ctx.opaque?.(v)) {
    return VAR;
  }
  const p = params.get(v);
  if (p !== undefined) {
    return p;
  }
  const seen = memo.get(v);
  if (seen !== undefined) {
    return seen;
  }
  const d = ctx.defs.get(v);
  const w = d === undefined ? VAR : opWord(d, (x) => evalWord(ctx, params, memo, x));
  memo.set(v, w);
  return w;
}

const solved = new WeakMap<WordCtx, Map<Value, Word>>();
function wordOf(ctx: WordCtx, v: Value): Word {
  let params = solved.get(ctx);
  if (params === undefined) {
    params = solveParams(ctx);
    solved.set(ctx, params);
  }
  return evalWord(ctx, params, new Map(), v);
}

/** THE WORD A VALUE ALWAYS HOLDS — what the machine computes, when every input to it is a constant
 *  (a pool word, a `mov` and a shift of it, any integer arithmetic over those, an operand an
 *  annihilator makes irrelevant, a block param every in-edge passes the same word), or null.
 *  Unlike `constMask` it reads THROUGH a materialized def: it answers what the machine holds, not
 *  whether a spelling may fold it. Its readers: the structurer's `neg_s`, switch recovery's case
 *  constants, the float helpers' literal words. An opcode it has no rule for is no word, so a new
 *  op whose value is not the plain machine word fails closed here; `neg_s` has its own rule. */
export function constWord(ctx: WordCtx, v: Value): number | null {
  const w = wordOf(ctx, v);
  return w.k === 'word' ? w.w : null;
}

/** Whether a value MAY hold `w` on every execution — it is that constant, or a constant this
 *  evaluator cannot compute. The fail-closed reading of `constWord`, for a caller to whom a
 *  constant it cannot name is as bad as the one it is looking for. A value that varies, or that is
 *  `w` on some paths only, answers false. */
export function mayAlwaysHold(ctx: WordCtx, v: Value, w: number): boolean {
  const x = wordOf(ctx, v);
  return x.k === 'konst' || (x.k === 'word' && x.w === (w | 0));
}

/** Block param -> the values its in-edges pass, for `WordCtx.incoming`. */
export function incomingArgs(blocks: readonly Block[]): Map<Value, (Value | undefined)[]> {
  const out = new Map<Value, (Value | undefined)[]>();
  for (const b of blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        s.block.params.forEach((p, i) => {
          if (!out.has(p)) {
            out.set(p, []);
          }
          out.get(p)!.push(s.args[i]);
        });
      }
    }
  }
  return out;
}

/** An UPPER BOUND on the significant bits of a value, or 32 when nothing bounds it. Every answer
 *  below 32 comes from an instruction or from a caller's declaration-backed `bound`:
 *    · a zero-fill shift right by n leaves 32 - n;
 *    · a load leaves its width in bits — UNLESS it sign-extends, which leaves all 32;
 *    · an `and` with a non-negative constant leaves that constant's top set bit.
 *  A SIGNED anything is 32: sign extension sets the high bits, and a bound that ignores it turns a
 *  correct refusal into a plausible wrong answer. */
export function provableBits(ctx: BitsCtx, v: Value): number {
  const d = ctx.defs.get(v);
  if (!d) {
    return 32;
  }
  const given = ctx.bound?.(d);
  if (given !== null && given !== undefined) {
    return given;
  }
  if (d.opcode === 'shr_u' && d.operands.length === 1 && typeof d.attrs.imm === 'number') {
    return 32 - (d.attrs.imm as number);
  }
  if (d.opcode === 'load') {
    return d.attrs.signed === true ? 32 : (d.attrs.width as number) * 8;
  }
  const m =
    d.opcode === 'const'
      ? constMask(ctx, v)
      : d.opcode === 'and'
        ? (d.operands.map((o) => constMask(ctx, o)).find((x) => x !== null) ??
          (typeof d.attrs.imm === 'number' ? (d.attrs.imm as number) | 0 : null))
        : null;
  return m !== null && m >= 0 ? 32 - Math.clz32(m) : 32;
}
