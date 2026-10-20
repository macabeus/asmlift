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
  /** A whole-word load -> every value a store this function made may have left there, one per
   *  path in (`storeForwards`), met like a block param's in-edges. The machine
   *  reads that word back unless the address is I/O, so only a reader that fails closed passes it:
   *  the structurer's `neg_s`, to whom a store and a reload of INT_MIN is INT_MIN as surely as a
   *  compiler that forwards the store makes it. Without it every load varies. */
  forwarded?: ReadonlyMap<Op, readonly Value[]>;
  /** A read every path into which passes a write this function made that may land on its cell
   *  (`overwrittenReads`). Unless `forwarded` names what that write left, it reads a constant this
   *  evaluator cannot compute: the memory the function wrote, through an address it cannot match
   *  to the read's, may be every word that read sees. Passed only beside `forwarded`. */
  overwritten?: ReadonlySet<Op>;
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
  // An operand not yet seen comes BEFORE one that varies. Once it settles it may be the word an
  // annihilator above needs (`q & x` with q a param that settles to 0), and an answer of VAR now
  // would drop a param that reads it for good: the solver below would then reach whichever
  // fixpoint the param order made, and the imprecise one answers `mayAlwaysHold` false.
  if (all.some((x) => x.k === 'top')) {
    return TOP;
  }
  if (all.some((x) => x.k === 'var')) {
    return VAR;
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
 *  varies. A param's new state is met with its old one, so it only ever drops, and drops at most
 *  three times; with `opWord` monotone (an unseen operand is TOP before a varying one is VAR)
 *  that meet changes nothing, and the fixpoint is the same in every param order.
 *
 *  A forwarded load is solved the same way, its forwarded stores as its in-edges: memory carried
 *  round a loop is a param the frontend did not name, and a loop that stores a reload back
 *  (`ldr r2, [r3]; …; str r2, [r3]`) passes it itself, which must keep the word it entered with. */
function solveParams(ctx: WordCtx): Map<Value, Word> {
  const state = new Map<Value, Word>();
  const incoming = new Map<Value, readonly (Value | undefined)[]>(ctx.incoming ?? []);
  for (const [load, vals] of ctx.forwarded ?? []) {
    if (load.results.length === 1) {
      incoming.set(load.results[0], vals);
    }
  }
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
      w = meet(state.get(p)!, w);
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
  // In progress reads VAR: SSA has no cycle but through a param, and a forwarded load is one
  // (`solveParams`), so nothing reaches this mark but malformed IR.
  memo.set(v, VAR);
  const w = d === undefined ? VAR : ctx.overwritten?.has(d) ? KONST : opWord(d, (x) => evalWord(ctx, params, memo, x));
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

/** Whether a value MAY hold `w` on every execution — it is that constant, a constant this
 *  evaluator cannot compute, or a value the solver never settled (a param no executed edge
 *  feeds). The fail-closed reading of `constWord`, for a caller to whom a constant it cannot name
 *  is as bad as the one it is looking for. A value that varies, or that is `w` on some paths only,
 *  answers false. */
export function mayAlwaysHold(ctx: WordCtx, v: Value, w: number): boolean {
  const x = wordOf(ctx, v);
  return x.k === 'konst' || x.k === 'top' || (x.k === 'word' && x.w === (w | 0));
}

/** Where an access lands, normalised: a ROOT (one SSA value, one symbol, or the absolute address
 *  space) and a byte offset from it. `add`/`sub` of a constant move along the root, so a base held
 *  in another register (`add r2, r3, #4`), an addend in the pool word (`.word gX+4`) and the same
 *  offset carried by the access all name one cell. Two keys on one root overlap exactly when their
 *  byte ranges do; keys on two roots are two pointers nothing here can tell apart. */
interface Cell {
  root: Value | string;
  byte: number;
  width: number;
}

/** Two cells may be the same memory: on one root when their bytes overlap, and always on two. */
const overlaps = (x: Cell, y: Cell): boolean =>
  x.root !== y.root || (x.byte < y.byte + y.width && y.byte < x.byte + x.width);

function cellOf(defs: ReadonlyMap<Value, Op>, addr: Value, off: number, width: number): Cell {
  let root: Value | string = addr;
  let byte = off;
  for (let hops = 0; hops < 64 && typeof root !== 'string'; hops++) {
    const d = defs.get(root);
    if (d === undefined) {
      break;
    }
    if (d.opcode === 'gaddr') {
      root = `sym:${d.attrs.sym as string}`;
      break;
    }
    if (d.opcode === 'const' && typeof d.attrs.value === 'number') {
      root = 'abs';
      byte += d.attrs.value;
      break;
    }
    const imm = typeof d.attrs.imm === 'number' ? d.attrs.imm : null;
    if ((d.opcode === 'add' || d.opcode === 'sub') && d.operands.length === 1 && imm !== null) {
      root = d.operands[0];
      byte += d.opcode === 'add' ? imm : -imm;
      continue;
    }
    if ((d.opcode === 'add' || d.opcode === 'sub') && d.operands.length === 2) {
      const k = (v: Value): number | null => {
        const c = defs.get(v);
        return c?.opcode === 'const' && typeof c.attrs.value === 'number' ? c.attrs.value : null;
      };
      const [a, b] = d.operands;
      if (k(b) !== null) {
        root = a;
        byte += d.opcode === 'add' ? k(b)! : -k(b)!;
        continue;
      }
      if (d.opcode === 'add' && k(a) !== null) {
        root = b;
        byte += k(a)!;
        continue;
      }
    }
    break;
  }
  return { root, byte: byte | 0, width };
}

/** Whole-word load -> every value it may read, for `WordCtx.forwarded`: a forward MUST-analysis of
 *  the words this function's own stores leave in memory. Each block starts from the meet of what
 *  its predecessors leave — a cell survives a join only if every in-edge knows it, and then carries
 *  each in-edge's stored value — and a predecessor not yet reached (a loop's back edge, on the
 *  first pass) is optimistic and adds nothing, so a store before a loop that nothing in the loop
 *  overwrites reaches a reload in its header. A store sets its cell and forgets every cell it may
 *  overlap (any cell on another root, which may be the same memory); any other op with effects (a
 *  call, an indexed store) forgets everything. A load is forwarded when every path into it knows
 *  its cell, as a whole word; the entry block, and a block nothing reaches, know nothing. */
export function storeForwards(blocks: readonly Block[]): Map<Op, Value[]> {
  const defs = new Map<Value, Op>();
  const preds = new Map<Block, Block[]>();
  for (const b of blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        defs.set(r, op);
      }
      for (const s of op.successors) {
        preds.set(s.block, [...(preds.get(s.block) ?? []), b]);
      }
    }
  }
  type Mem = Map<string, { cell: Cell; vals: Value[] }>;
  const ids = new Map<Value, number>();
  const keyOf = (c: Cell): string =>
    `${typeof c.root === 'string' ? c.root : `v${ids.get(c.root) ?? ids.set(c.root, ids.size).get(c.root)!}`}@${c.byte}:${c.width}`;
  const cells = new Map<Op, Cell>();
  for (const b of blocks) {
    for (const op of b.ops) {
      if ((op.opcode === 'load' || op.opcode === 'store') && typeof op.attrs.width === 'number') {
        cells.set(op, cellOf(defs, op.operands[0], (op.attrs.off as number | undefined) ?? 0, op.attrs.width));
      }
    }
  }
  const out = new Map<Op, Value[]>();
  // One pass over a block: from its entry state, record each whole-word load's forward (when
  // `record`) and return its exit state.
  const run = (b: Block, mem: Mem, record: boolean): Mem => {
    const m: Mem = new Map(mem);
    for (const op of b.ops) {
      const cell = cells.get(op);
      if (op.opcode === 'load') {
        const known = cell === undefined || cell.width !== 4 ? undefined : m.get(keyOf(cell));
        if (record && known !== undefined) {
          out.set(op, known.vals);
        }
        continue;
      }
      if (op.opcode === 'store' && cell !== undefined) {
        for (const [k, e] of m) {
          if (overlaps(e.cell, cell)) {
            m.delete(k);
          }
        }
        m.set(keyOf(cell), { cell, vals: [op.operands[1]] });
        continue;
      }
      const sig = (OPCODES as Record<string, OpSig | undefined>)[op.opcode];
      if ((sig === undefined || sig.effects) && !sig?.terminator) {
        m.clear();
      }
    }
    return m;
  };
  const meetMem = (a: Mem, b: Mem): Mem => {
    const m: Mem = new Map();
    for (const [k, x] of a) {
      const y = b.get(k);
      if (y !== undefined) {
        m.set(k, { cell: x.cell, vals: [...new Set([...x.vals, ...y.vals])] });
      }
    }
    return m;
  };
  const sameMem = (a: Mem, b: Mem): boolean =>
    a.size === b.size &&
    [...a].every(([k, x]) => {
      const y = b.get(k);
      return y !== undefined && y.vals.length === x.vals.length && x.vals.every((v) => y.vals.includes(v));
    });
  // Exit states; a block absent from it is not reached yet (TOP). Cells only ever leave a state
  // and values only ever join one, both finite, so this settles.
  const exit = new Map<Block, Mem>();
  const entryOf = (b: Block): Mem | undefined => {
    const from = preds.get(b) ?? [];
    if (b === blocks[0] || from.length === 0) {
      return new Map();
    }
    let m: Mem | undefined;
    for (const p of from) {
      const e = exit.get(p);
      if (e !== undefined) {
        m = m === undefined ? e : meetMem(m, e);
      }
    }
    return m;
  };
  for (let moved = true, round = 0; moved; round++) {
    if (round > 4 * blocks.length + 64) {
      throw new Error('storeForwards: memory states did not settle');
    }
    moved = false;
    for (const b of blocks) {
      const at = entryOf(b);
      if (at === undefined) {
        continue;
      }
      const e = run(b, at, false);
      const old = exit.get(b);
      if (old === undefined || !sameMem(old, e)) {
        exit.set(b, e);
        moved = true;
      }
    }
  }
  for (const b of blocks) {
    const at = entryOf(b);
    if (at !== undefined) {
      run(b, at, true);
    }
  }
  return out;
}

/** Every read (`load`, `aload`) that each path from the function's entry reaches only past a write
 *  that may land on its cell, for `WordCtx.overwritten`: a store to an overlapping cell or to
 *  another root (which may be the same memory), and any other op with effects. What such a read
 *  sees is what this function wrote, on every path, and when `storeForwards` cannot say which word
 *  that was — a register-indexed address, two spellings of one sum, narrow stores that compose a
 *  word, a write through another pointer — the read must not pass for one that varies. A read with
 *  one write-free path in sees the caller's memory on it, which varies; so does a read in a block
 *  nothing reaches. An `aload`'s cell is never known, so every write may land on it. */
export function overwrittenReads(blocks: readonly Block[]): Set<Op> {
  const defs = new Map<Value, Op>();
  const preds = new Map<Block, number>();
  for (const b of blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        defs.set(r, op);
      }
      for (const s of op.successors) {
        preds.set(s.block, (preds.get(s.block) ?? 0) + 1);
      }
    }
  }
  const cellAt = (op: Op): Cell | undefined =>
    (op.opcode === 'load' || op.opcode === 'store') && typeof op.attrs.width === 'number'
      ? cellOf(defs, op.operands[0], (op.attrs.off as number | undefined) ?? 0, op.attrs.width)
      : undefined;
  const writesOver = (op: Op, cell: Cell | undefined): boolean => {
    if (op.opcode === 'load' || op.opcode === 'aload') {
      return false;
    }
    if (op.opcode === 'store') {
      const at = cellAt(op);
      return at === undefined || cell === undefined || overlaps(at, cell);
    }
    const sig = (OPCODES as Record<string, OpSig | undefined>)[op.opcode];
    return (sig === undefined || sig.effects === true) && !sig?.terminator;
  };
  const roots = blocks.filter((b, i) => i === 0 || !preds.has(b));
  const out = new Set<Op>();
  for (const b of blocks) {
    b.ops.forEach((op, i) => {
      if (op.opcode !== 'load' && op.opcode !== 'aload') {
        return;
      }
      const cell = cellAt(op);
      // The blocks whose entry a write-free path reaches.
      const clean = new Set<Block>(roots);
      const work = [...roots];
      while (work.length > 0) {
        const x = work.pop()!;
        if (x.ops.some((o) => writesOver(o, cell))) {
          continue;
        }
        for (const o of x.ops) {
          for (const s of o.successors) {
            if (!clean.has(s.block)) {
              clean.add(s.block);
              work.push(s.block);
            }
          }
        }
      }
      if (!clean.has(b) || b.ops.slice(0, i).some((o) => writesOver(o, cell))) {
        out.add(op);
      }
    });
  }
  return out;
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
