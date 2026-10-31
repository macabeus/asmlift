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
import { type Block, type Op, type Value, immediateDominators } from './core';
import { NEGATED_ICMP, OPCODES, type OpSig, SWAPPED_ICMP } from './opcodes';

/** A materialized def emits its own named temp, so its value is a VARIABLE at every use — never a
 *  literal this analysis may fold through. Callers that have no materialization model pass none. */
export interface BitsCtx {
  defs: ReadonlyMap<Value, Op>;
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
  /** The function's own parameters. Given beside `incoming`, `mayAlwaysHold` also bounds a block
   *  param by the ranges its in-edges pass (`stridedRange`); without it no param is bounded. */
  entry?: ReadonlySet<Value>;
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
 *  answers false — and so does one that cannot hold `w` at all by what its ops leave
 *  (`stridedRange`'s bounds, which read widths and arithmetic, never memory): a halfword reload of
 *  memory this function overwrote is a constant this cannot compute, but never INT_MIN, and nor is
 *  a param both of whose arms pass such a reload. */
export function mayAlwaysHold(ctx: WordCtx, v: Value, w: number): boolean {
  const rc = rangeCtxOf(ctx);
  for (const wordFirst of [false, true]) {
    const r = integerRange(rc, v, wordFirst);
    if (r !== undefined && !rangeMayBe(r, w)) {
      return false;
    }
  }
  const x = wordOf(ctx, v);
  return x.k === 'konst' || x.k === 'top' || (x.k === 'word' && x.w === (w | 0));
}

/** The range question's reading of a word context. A block param is read through its in-edges
 *  only when the caller names the function's own params (`entry`), which arrive from a caller and
 *  hold anything even where a back edge passes them a bounded value. */
function rangeCtxOf(ctx: WordCtx): RangeCtx {
  const entry = ctx.entry;
  return {
    defs: ctx.defs,
    constOf: (x) => {
      const d = ctx.defs.get(x);
      return d?.opcode === 'const' && typeof d.attrs.value === 'number' ? d.attrs.value : undefined;
    },
    incoming:
      entry === undefined || ctx.incoming === undefined
        ? new Map()
        : new Map([...ctx.incoming].map(([p, args]) => [p, args.map((arg) => ({ arg }))])),
    entry: entry ?? new Set(),
  };
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

/** The blocks a path from the entry (`blocks[0]`) reaches. A block nothing reaches, and every
 *  edge out of one, is no path in: a dead block falling into a read must not pass for a way in
 *  that wrote nothing. */
function reachable(blocks: readonly Block[]): Set<Block> {
  const seen = new Set<Block>(blocks.slice(0, 1));
  const work = blocks.slice(0, 1);
  while (work.length > 0) {
    for (const o of work.pop()!.ops) {
      for (const s of o.successors) {
        if (!seen.has(s.block)) {
          seen.add(s.block);
          work.push(s.block);
        }
      }
    }
  }
  return seen;
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
 *  its cell, as a whole word; the entry block knows nothing, and a block the entry does not reach
 *  forwards nothing and is no path into the blocks it jumps to. */
export function storeForwards(blocks: readonly Block[]): Map<Op, Value[]> {
  const defs = new Map<Value, Op>();
  const preds = new Map<Block, Block[]>();
  const live = reachable(blocks);
  for (const b of blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        defs.set(r, op);
      }
      for (const s of op.successors) {
        if (live.has(b)) {
          preds.set(s.block, [...(preds.get(s.block) ?? []), b]);
        }
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
    if (!live.has(b)) {
      return undefined; // dead: it records nothing and adds nothing to a block it falls into
    }
    const from = preds.get(b) ?? [];
    if (b === blocks[0]) {
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
 *  one write-free path in from the entry sees the caller's memory on it, which varies; a block the
 *  entry does not reach is no such path. An `aload`'s cell is never known, so every write may land
 *  on it. */
export function overwrittenReads(blocks: readonly Block[]): Set<Op> {
  const defs = new Map<Value, Op>();
  for (const b of blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        defs.set(r, op);
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
  const roots = blocks.slice(0, 1);
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
  return new Map([...incomingEdges(blocks)].map(([p, es]) => [p, es.map((e) => e.arg)]));
}

/** A comparison an edge proves: `lhs <opcode> rhs` holds whenever control takes it. */
export interface EdgeTest {
  readonly opcode: string;
  readonly lhs: Value;
  readonly rhs: Value;
}

/** One in-edge of a block param: the value it passes, and what the branches on the way prove. */
export interface InEdge {
  readonly arg: Value | undefined;
  readonly holds?: readonly EdgeTest[];
}

/** An edge: its branch `op` in block `from`, to successor `si`. */
interface EdgeOut {
  readonly from: Block;
  readonly op: Op;
  readonly si: number;
}

/** The most compares one edge or one block carries, the nearest first; an older one is dropped. */
const EDGE_TESTS = 8;

/** What the branches above a point prove there: for each block, the compares that hold whenever
 *  control is in it, and for each edge, the compares that hold whenever it is taken. A `cond_br` on
 *  an `icmp_*` proves the compare on its first successor and the negation (`NEGATED_ICMP`) on its
 *  second; an edge out of a `cond_br` whose two successors are one block proves nothing — the same
 *  edge is taken either way — and nor does any other branch. A block holds what the one edge into
 *  each block that DOMINATES it proves (itself included; a block entered by more than one edge, or
 *  the entry, proves nothing of its way in), so a test at the top of a loop body still holds past
 *  an if/else that joins below it, and agbcc's far latch `bhi .LCB; b .Lhead @long jump` carries
 *  the test it made in one block to the jump back from the next. An edge holds its own compare and
 *  what its source block holds. Sound because a compare's operands are values: each was defined in
 *  a block that dominates the test, and control that passes a dominating edge and reaches the point
 *  without passing it again cannot have redefined one (that block would be reachable around the
 *  edge), so the instance each test read is the one the point reads. */
export interface EdgeFacts {
  /** block param -> its in-edges, each with what holds whenever it is taken */
  readonly incoming: Map<Value, InEdge[]>;
  /** the compares that hold in a block, the nearest first */
  holdsAt(b: Block): readonly EdgeTest[];
}

/** `EdgeFacts` over a function's blocks, `blocks[0]` the entry. */
export function edgeFacts(blocks: readonly Block[]): EdgeFacts {
  const defs = new Map<Value, Op>();
  /** a block -> the one edge into it, or null where there are more, or the caller enters it */
  const only = new Map<Block, EdgeOut | null>();
  if (blocks[0] !== undefined) {
    only.set(blocks[0], null);
  }
  for (const b of blocks) {
    for (const op of b.ops) {
      op.results.forEach((r) => defs.set(r, op));
      op.successors.forEach((s, si) => only.set(s.block, only.has(s.block) ? null : { from: b, op, si }));
    }
  }
  const idom = immediateDominators({ blocks });
  const tested = (op: Op, si: number): EdgeTest | undefined => {
    const c = op.opcode === 'cond_br' ? defs.get(op.operands[0]) : undefined;
    return c !== undefined &&
      c.operands.length === 2 &&
      NEGATED_ICMP[c.opcode] !== undefined &&
      op.successors.length === 2 &&
      op.successors[0].block !== op.successors[1].block
      ? { opcode: si === 0 ? c.opcode : NEGATED_ICMP[c.opcode], lhs: c.operands[0], rhs: c.operands[1] }
      : undefined;
  };
  const at = new Map<Block, readonly EdgeTest[]>();
  const holdsAt = (b: Block): readonly EdgeTest[] => {
    const had = at.get(b);
    if (had !== undefined) {
      return had;
    }
    const out: EdgeTest[] = [];
    for (let x: Block | undefined = b; x !== undefined && out.length < EDGE_TESTS; x = idom.get(x)) {
      const e = only.get(x);
      const t = e === null || e === undefined ? undefined : tested(e.op, e.si);
      if (t !== undefined) {
        out.push(t);
      }
    }
    at.set(b, out);
    return out;
  };
  const incoming = new Map<Value, InEdge[]>();
  for (const b of blocks) {
    for (const op of b.ops) {
      op.successors.forEach((s, si) => {
        if (s.block.params.length === 0) {
          return;
        }
        const own = tested(op, si);
        const holds = [...(own === undefined ? [] : [own]), ...holdsAt(b)].slice(0, EDGE_TESTS);
        s.block.params.forEach((p, i) => {
          if (!incoming.has(p)) {
            incoming.set(p, []);
          }
          incoming.get(p)!.push(holds.length === 0 ? { arg: s.args[i] } : { arg: s.args[i], holds });
        });
      });
    }
  }
  return { incoming, holdsAt };
}

/** Block param -> its in-edges, each with the comparisons that hold whenever it is taken
 *  (`edgeFacts`). */
export function incomingEdges(blocks: readonly Block[]): Map<Value, InEdge[]> {
  return edgeFacts(blocks).incoming;
}

/** An UPPER BOUND on the significant bits of a value, or 32 when nothing bounds it. Every answer
 *  below 32 comes from an instruction or from a caller's declaration-backed `bound`:
 *    · a zero-fill shift right by n leaves n fewer bits than its operand has (32 - n of a word);
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
    return Math.max(0, provableBits(ctx, d.operands[0]) - (d.attrs.imm as number));
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

// LINEAR FORMS AND STRIDED RANGES — "which words may this value be", for a caller that asks
// whether a computed address can land on one register (frontend/frame-objects.ts: a store after a
// DMA arming that may hit the channel's control halfword, a word store that hands an address to a
// channel's source register). One decomposition answers both, so they cannot disagree on a store.

/** What a linear form may read: each value's def and the constant a value is. */
export interface LinearCtx {
  readonly defs: ReadonlyMap<Value, Op>;
  constOf(v: Value): number | undefined;
}

/** `v` as a sum of runtime values times constants, plus a constant (the `1` key): agbcc's `ch *
 *  12` is `((ch << 1) + ch) << 2`, which is 12 times `ch` only once the two `ch` terms are added.
 *  Every rule is a ring operation, so the form equals the machine's word modulo 2^32 whatever
 *  wraps on the way. A value this cannot read further is its own term. A coefficient is a JS
 *  number, exact only up to 2^53: one past that rounds, and a later `sub` could cancel the rounded
 *  coefficient to 0 and drop a term the word still holds, so a form whose coefficient leaves the
 *  safe integers is no form (undefined). A value in `opaque` is read no further: it is a term. */
export function linearTerms(
  ctx: LinearCtx,
  v: Value,
  depth = 0,
  opaque?: { has(v: Value): boolean },
): Map<Value | 1, number> | undefined {
  const c = ctx.constOf(v);
  if (c !== undefined) {
    return new Map([[1, c]]);
  }
  const d = opaque?.has(v) === true ? undefined : ctx.defs.get(v);
  if (d === undefined || depth > 8) {
    return new Map([[v, 1]]);
  }
  const scaled = (x: Value, by: number) => {
    const l = linearTerms(ctx, x, depth + 1, opaque);
    const out = l && new Map([...l].map(([t, k]) => [t, k * by] as const));
    return out && [...out.values()].every(Number.isSafeInteger) ? out : undefined;
  };
  const k = d.operands.length === 1 ? (d.attrs.imm as number | undefined) : ctx.constOf(d.operands[1]);
  if (d.opcode === 'shl' && k !== undefined && k >= 0 && k < 31) {
    return scaled(d.operands[0], 2 ** k);
  }
  if (d.opcode === 'mul' && d.operands.length === 2 && k !== undefined) {
    return scaled(d.operands[0], k);
  }
  // the wrapping `0 - x`, a ring operation too: agbcc's `mov rN, #2; neg rN, rN` is the constant -2
  if (d.opcode === 'neg' && d.operands.length === 1) {
    return scaled(d.operands[0], -1);
  }
  if ((d.opcode === 'add' || d.opcode === 'sub') && d.operands.length === 2) {
    const x = linearTerms(ctx, d.operands[0], depth + 1, opaque);
    const y = scaled(d.operands[1], d.opcode === 'add' ? 1 : -1);
    if (x === undefined || y === undefined) {
      return undefined;
    }
    y.forEach((n, t) => x.set(t, (x.get(t) ?? 0) + n));
    return [...x.values()].every(Number.isSafeInteger) ? x : undefined;
  }
  return new Map([[v, 1]]);
}

/** A number every value of `v` is a multiple of, or 0 when this cannot name one. */
export function linearFactor(ctx: LinearCtx, v: Value): number {
  const l = linearTerms(ctx, v);
  return l === undefined ? 0 : [...l.values()].reduce(gcdOf, 0);
}

/** Every word a value may hold is `lo + stride * n` for some `n >= 0`, and lies in `[lo, hi]`, an
 *  unsigned closed interval. `stride` is 0 exactly when `lo === hi`. (Inside this module the same
 *  shape also carries an integer range before its move into one word, which may start below 0.) */
export interface StridedRange {
  readonly lo: number;
  readonly hi: number;
  readonly stride: number;
}

/** What a strided range may read beyond a linear form. */
export interface RangeCtx extends LinearCtx {
  /** block param -> its in-edges, each with what its branch proves where that is known
   *  (`incomingEdges`) */
  readonly incoming: ReadonlyMap<Value, readonly InEdge[]>;
  /** the function's own parameters, which arrive from a caller and hold anything */
  readonly entry: ReadonlySet<Value>;
  /** the one word a term the form cannot read is known to be — a name a symbol map places */
  pointOf?(v: Value): number | undefined;
  /** the compares that hold in a block (`edgeFacts`), for a question asked at one */
  holdsAt?(b: Block): readonly EdgeTest[];
}

const WORD = 2 ** 32;
/** The most terms one `stridedRange` question bounds before it answers nothing. */
const RANGE_BUDGET = 256;

/** Every word `v` may hold, or undefined when this cannot bound it. The form is `linearTerms`; a
 *  term is bounded by the word a caller places it at (`pointOf`), by `provableBits` (a zero-fill
 *  shift right, an unsigned narrow load, a non-negative mask) or a `zext`'s width, by the range a
 *  narrow read or `sext` leaves (`narrowLeaf`: signed ones included), by what a shift or a mask
 *  leaves of its operand's range (`shiftMaskRange`), or, a block param, by the union of what its
 *  in-edges pass, each read under what its branch proves, or by a range every in-edge provably
 *  keeps it in (`integerRange`'s induction, for a loop counter whose latch bounds one side).
 *  Anything else — a function parameter, a whole word loaded from memory, a name nothing places, a
 *  param whose range depends on itself through a loop that no branch bounds — bounds nothing, and
 *  nothing is the answer. The form equals the word modulo 2^32, so the words are the sum's integer
 *  range moved into one word, when it fits one; a sum whose range crosses a multiple of 2^32 holds
 *  words on both sides of zero, which no interval names (a lone signed narrow value among them:
 *  `(s8)i` is [-128, 127]). Exact is not the point: an answer must hold every word the machine can
 *  compute there, and a wider one only proves less. Asked `at` a block (where `v` is read, or any
 *  block its definition dominates), what the branches above it prove there (`holdsAt`) bounds the
 *  terms they test too: `if (i < 8) a[i]` reads `i` in [0, 7] though `i` is a parameter. */
export function stridedRange(ctx: RangeCtx, v: Value, at?: Block): StridedRange | undefined {
  const holds = at === undefined ? undefined : ctx.holdsAt?.(at);
  const r = integerRange(ctx, v, false, holds);
  const one = r === undefined ? undefined : intoWord(r);
  if (one !== undefined || r === undefined) {
    return one;
  }
  const moved = integerRange(ctx, v, true, holds);
  return moved === undefined ? undefined : intoWord(moved);
}

/** An integer range moved into one unsigned word, or undefined when it crosses a multiple of
 *  2^32. Every integer in the answer is congruent modulo 2^32 to the one it moved. */
function intoWord(r: StridedRange): StridedRange | undefined {
  const base = Math.floor(r.lo / WORD) * WORD;
  return r.hi - base >= WORD ? undefined : { lo: r.lo - base, hi: r.hi - base, stride: r.stride };
}

/** Whether an integer range holds an integer congruent to `w` modulo 2^32 — a word the machine
 *  may compute there. Fails open (true) past a range too wide to walk. */
function rangeMayBe(r: StridedRange, w: number): boolean {
  let x = r.lo + mod(mod(w) - r.lo);
  for (let n = 0; x <= r.hi; x += WORD, n++) {
    if (n > 64 || (r.stride === 0 ? x === r.lo : (x - r.lo) % r.stride === 0)) {
      return true;
    }
  }
  return false;
}

/** The range a narrow read or a `sext` leaves whatever it reads, where `provableBits` names none:
 *  a sign-extending `load`, a `sext` (its `width` in bits), and a flat array's `aload` (whose
 *  `elemSize` is the element it reads; a struct-array `aload`'s, with a `fieldOff`, is the stride,
 *  not the field, and bounds nothing). An integer range: a signed one straddles zero. */
function narrowLeaf(d: Op): StridedRange | undefined {
  const bits =
    d.opcode === 'sext'
      ? d.attrs.width
      : d.opcode === 'load' && d.attrs.signed === true && typeof d.attrs.width === 'number'
        ? d.attrs.width * 8
        : d.opcode === 'aload' && d.attrs.fieldOff === undefined && typeof d.attrs.elemSize === 'number'
          ? d.attrs.elemSize * 8
          : undefined;
  if (typeof bits !== 'number' || !(bits > 0 && bits < 32)) {
    return undefined;
  }
  return d.opcode === 'sext' || d.attrs.signed === true
    ? { lo: -(2 ** (bits - 1)), hi: 2 ** (bits - 1) - 1, stride: 1 }
    : { lo: 0, hi: 2 ** bits - 1, stride: 1 };
}

/** The words a `zext`, an `and` with a constant or a zero-fill shift right by a constant leaves,
 *  from the words its operand may hold (`wordsOf`, undefined where nothing bounds them): a `zext`
 *  or a mask of `2^n - 1` keeps every word that already fits it, `x & m` is no greater than `x` or
 *  `m`, and `x >>> s` is each word divided by `2^s`, rounded down. A shift left is a product,
 *  which `linearTerms` reads, so agbcc's `(u8)k * 2`, `lsl #24; lsr #23`, is `k`'s range doubled
 *  where that fits a word. Undefined where it names nothing, and the width bound
 *  (`provableBits`) is all there is. */
function shiftMaskRange(
  ctx: LinearCtx,
  d: Op,
  wordsOf: (x: Value) => StridedRange | undefined,
): StridedRange | undefined {
  const amount =
    d.operands.length === 1
      ? typeof d.attrs.imm === 'number'
        ? d.attrs.imm
        : undefined
      : d.operands.length === 2
        ? ctx.constOf(d.operands[1])
        : undefined;
  if (d.opcode === 'zext' && typeof d.attrs.width === 'number' && d.attrs.width > 0 && d.attrs.width < 32) {
    const w = wordsOf(d.operands[0]);
    return w !== undefined && w.hi < 2 ** d.attrs.width ? w : undefined;
  }
  if (d.opcode === 'and') {
    const [x, c] =
      amount !== undefined
        ? [d.operands[0], amount]
        : d.operands.length === 2
          ? [d.operands[1], ctx.constOf(d.operands[0])]
          : [undefined, undefined];
    if (x === undefined || c === undefined) {
      return undefined;
    }
    const m = mod(c);
    const w = wordsOf(x);
    if (w !== undefined && w.hi <= m && Number.isInteger(Math.log2(m + 1))) {
      return w;
    }
    const hi = Math.min(m, w?.hi ?? m);
    return { lo: 0, hi, stride: hi === 0 ? 0 : 1 };
  }
  if (d.opcode === 'shr_u' && amount !== undefined && amount > 0 && amount < 32) {
    const w = wordsOf(d.operands[0]);
    if (w === undefined) {
      return undefined;
    }
    const by = 2 ** amount;
    const [lo, hi] = [Math.floor(w.lo / by), Math.floor(w.hi / by)];
    return { lo, hi, stride: lo === hi ? 0 : w.stride % by === 0 ? w.stride / by : 1 };
  }
  return undefined;
}

/** `stridedRange` before the move into one word: integers, every one of which is congruent modulo
 *  2^32 to a word `v` may hold, and which cover them all. A block param is the union of what its
 *  in-edges pass, read one of two ways, each a sound cover on its own: as the integers they are
 *  (`wordFirst` false: a constant -1 beside a halfword reload is [-1, 65535], which no word
 *  interval names but which excludes INT_MIN), or each moved into one word first where it fits one
 *  (`wordFirst` true: a -1 beside a 0 is {0, 2^32 - 1}, one word interval where [-1, 0] is none).
 *  The two never mix in one union. Where the integer union fits one word, both readings name the
 *  same words (every edge then shares one multiple of 2^32), so `stridedRange` asks the integer
 *  reading first and the moved one only where that crosses a multiple; `mayAlwaysHold` asks both,
 *  and a word either excludes cannot be held. Where an in-edge names what its branch proves,
 *  that edge's argument is read under it (`edgeRange`): a loop's latch `k + 1 <= 7` bounds the
 *  `k + 1` its back edge passes, which no reading of `k` alone could, `k` depending on itself. */
function integerRange(
  ctx: RangeCtx,
  v: Value,
  wordFirst: boolean,
  holds?: readonly EdgeTest[],
): StridedRange | undefined {
  const open = new Set<Value>();
  let left = RANGE_BUDGET;
  /** params met again while their own in-edges were being read */
  const cyclic = new Set<Value>();
  /** the induction hypotheses under test: each param holds only this range */
  const assumed = new Map<Value, StridedRange>();
  const bits: BitsCtx = {
    defs: ctx.defs,
    bound: (d) => (d.opcode === 'zext' ? (d.attrs.width as number) : null),
  };
  /** `facts`: what the in-edge being read proves, by the value it bounds; each is read as a term.
   *  `null` (here and from `rangeOf`) is NEVER: a fact no value of its term can meet, so the edge
   *  that proves it is never taken and passes nothing. */
  const termRange = (t: Value, facts: Facts): StridedRange | undefined | null => {
    const fact = facts.get(t);
    if (fact !== undefined) {
      const own = rangeOf(t, new Map([...facts].filter(([x]) => x !== t)));
      return own === null ? null : meetBound(own, fact);
    }
    const at = ctx.pointOf?.(t);
    if (at !== undefined) {
      return { lo: mod(at), hi: mod(at), stride: 0 };
    }
    const d = ctx.defs.get(t);
    if (d !== undefined) {
      const leaf = narrowLeaf(d);
      if (leaf !== undefined) {
        return leaf;
      }
      // what a shift or a mask leaves of its operand's range: agbcc's `(u8)k` of a counter that
      // stays in [0, 7] is [0, 7], not the [0, 255] the width alone leaves
      const moved = shiftMaskRange(ctx, d, (x) => {
        const r = --left < 0 ? undefined : rangeOf(x, facts);
        return r === undefined || r === null ? undefined : intoWord(r);
      });
      const n = provableBits(bits, t);
      const width = n < 32 ? { lo: 0, hi: 2 ** n - 1, stride: n === 0 ? 0 : 1 } : undefined;
      return moved !== undefined && (width === undefined || moved.hi - moved.lo <= width.hi - width.lo) ? moved : width;
    }
    const hypothesis = assumed.get(t);
    if (hypothesis !== undefined) {
      return hypothesis;
    }
    const ins = ctx.entry.has(t) ? undefined : ctx.incoming.get(t);
    if (open.has(t)) {
      cyclic.add(t);
      return undefined;
    }
    if (ins === undefined || ins.length === 0 || --left < 0) {
      return undefined;
    }
    open.add(t);
    try {
      // each in-edge as it reads, and apart those that read without the param: an induction's start;
      // an edge that is never taken (`null`) passes nothing, and the param is what the others pass
      let readsItself = false;
      const seeds: (StridedRange | undefined)[] = [];
      const direct = ins.flatMap((e) => {
        const { range } = edgeRange(e);
        const self = cyclic.delete(t);
        readsItself ||= self;
        seeds.push(self || range === null ? undefined : range);
        return range === null ? [] : [range];
      });
      let out = direct.every((r) => r !== undefined)
        ? hullOf(direct.map((r) => (wordFirst ? (intoWord(r) ?? r) : r)))
        : undefined;
      // a param read through itself may still hold a range every in-edge keeps it in
      const proven = readsItself ? inductive(t, ins, seeds) : undefined;
      if (proven !== undefined && (out === undefined || proven.hi - proven.lo < out.hi - out.lo)) {
        out = wordFirst ? (intoWord(proven) ?? proven) : proven;
      }
      return out;
    } finally {
      open.delete(t);
    }
  };
  /** A range `r` for a param that reads itself, proven by induction: every in-edge, read with the
   *  param anywhere in `r` and under what its branch proves, passes a value inside `r`, so no run
   *  of the loop can leave it. A signed latch bounds its counter on one side only (`k + 1 <= 7`
   *  holds of every negative k), and only the counter's start bounds the other. The hypothesis
   *  starts at the in-edges that read without the param, takes in what they pass, and once the
   *  bounds the branches name; every sum is exact and a bound read outside its window holds alone,
   *  so a counter that can wrap, an update on some paths only or an unbounded start never settles
   *  and proves nothing. */
  const inductive = (
    t: Value,
    ins: readonly InEdge[],
    seeds: readonly (StridedRange | undefined)[],
  ): StridedRange | undefined => {
    let r = hullOf(seeds.filter((x): x is StridedRange => x !== undefined));
    for (let round = 0; r !== undefined && round < INDUCTION_ROUNDS; round++) {
      const passed: StridedRange[] = [];
      const named: StridedRange[] = [];
      assumed.set(t, r);
      try {
        for (const e of ins) {
          const { range, facts } = edgeRange(e);
          if (range === null) {
            continue; // never taken while the param is in `r`: it passes nothing
          }
          if (range === undefined) {
            return undefined;
          }
          passed.push(range);
          // only a bound on a value computed from the param can be where it settles: an edge also
          // carries what the tests above it prove of a loaded global or a dispatch value
          facts.forEach((b, x) => {
            if (computedFrom(x, t)) {
              named.push(...boundSides(b));
            }
          });
        }
      } finally {
        assumed.delete(t);
      }
      const next = hullOf([r, ...passed])!;
      if (next.lo === r.lo && next.hi === r.hi && next.stride === r.stride) {
        return r;
      }
      r = round === 0 ? hullOf([next, ...named]) : next;
    }
    return undefined;
  };
  /** Whether `x` is computed from the param `t` by arithmetic: through the operands of what defines
   *  it, and through what a block param's in-edges pass (a join of `k + 1` and `k + 2` is computed
   *  from `k`), but never through memory, whose word a load reads whatever address it took. */
  const computedFrom = (x: Value, t: Value): boolean => {
    const seen = new Set<Value>();
    const work = [x];
    while (work.length > 0 && seen.size < RANGE_BUDGET) {
      const y = work.pop()!;
      if (y === t) {
        return true;
      }
      if (seen.has(y)) {
        continue;
      }
      seen.add(y);
      const d = ctx.defs.get(y);
      if (d !== undefined) {
        if (!READS_MEMORY.has(d.opcode)) {
          work.push(...d.operands);
        }
      } else {
        ctx.incoming.get(y)?.forEach((e) => e.arg !== undefined && work.push(e.arg));
      }
    }
    return false;
  };
  /** What one in-edge passes, read under what its branch proves (`facts`, returned beside it).
   *  Every value the argument reads is the instance the branch tested, so a bound on it holds
   *  wherever the argument reads it; a param read on the way is read under its own in-edges'
   *  facts, never these. */
  const edgeRange = (e: InEdge): { readonly range: StridedRange | undefined | null; readonly facts: Facts } => {
    const facts = e.holds === undefined ? NO_FACTS : factsOf(e.holds);
    return { range: e.arg === undefined ? undefined : rangeOf(e.arg, facts), facts };
  };
  /** The bound each compare puts on each side, from the other side's range (read with no facts);
   *  of two bounds on one value, each holds, and the narrower is kept. */
  const factsOf = (hs: readonly EdgeTest[]): Facts => {
    const out = new Map<Value, EdgeBound>();
    for (const h of hs) {
      if (h.lhs === h.rhs) {
        continue;
      }
      for (const [x, y, opcode] of [
        [h.lhs, h.rhs, h.opcode],
        [h.rhs, h.lhs, SWAPPED_ICMP[h.opcode]],
      ] as const) {
        if (opcode === undefined || ctx.constOf(x) !== undefined) {
          continue;
        }
        const other = rangeOf(y, NO_FACTS);
        const b = other === undefined || other === null ? undefined : testBound(opcode, other);
        const had = out.get(x);
        if (b !== undefined && (had === undefined || b.r.hi - b.r.lo < had.r.hi - had.r.lo)) {
          out.set(x, b);
        }
      }
    }
    return out;
  };
  const rangeOf = (x: Value, facts: Facts): StridedRange | undefined | null => {
    const form = linearTerms(ctx, x, 0, facts);
    if (form === undefined) {
      return undefined;
    }
    let lo = 0;
    let hi = 0;
    let stride = 0;
    for (const [t, c] of form) {
      if (c === 0) {
        continue;
      }
      const r = t === 1 ? { lo: 1, hi: 1, stride: 0 } : termRange(t, facts);
      if (r === undefined || r === null) {
        return r;
      }
      const parts = [c * r.lo, c * r.hi, c * r.stride];
      lo += c > 0 ? parts[0] : parts[1];
      hi += c > 0 ? parts[1] : parts[0];
      // every product and partial sum stays exact, or a rounded one could cancel to a false range
      if (![...parts, lo, hi].every(Number.isSafeInteger)) {
        return undefined;
      }
      stride = gcdOf(stride, parts[2]);
    }
    return Number.isSafeInteger(lo) && Number.isSafeInteger(hi) ? { lo, hi, stride } : undefined;
  };
  // asked at a block, `v` is read under what holds there, as an in-edge's argument is under what
  // its edge proves; a point no value can reach (`null`) is answered as nothing proven
  return rangeOf(v, holds === undefined || holds.length === 0 ? NO_FACTS : factsOf(holds)) ?? undefined;
}

/** The integers every range in a list holds, and the stride all of them sit on. */
function hullOf(rs: readonly StridedRange[]): StridedRange | undefined {
  let out: StridedRange | undefined;
  for (const r of rs) {
    out =
      out === undefined
        ? r
        : {
            lo: Math.min(out.lo, r.lo),
            hi: Math.max(out.hi, r.hi),
            stride: gcdOf(gcdOf(out.stride, r.stride), r.lo - out.lo),
          };
  }
  return out;
}

/** What a branch proves of a value: the integers of one window it may be, unsigned words (`u`,
 *  from `icmp_u*` and `icmp_eq`) or the signed ones (`s`, from `icmp_s*`). */
interface EdgeBound {
  readonly r: StridedRange;
  readonly window: 'u' | 's';
}

/** What an in-edge's branch proves, by the value each bound is on. */
type Facts = ReadonlyMap<Value, EdgeBound>;
const NO_FACTS: Facts = new Map();

const S_MIN = -(2 ** 31);
const S_MAX = 2 ** 31 - 1;

/** The ops whose result is a word read from memory or handed back by a callee (the registry's
 *  `reads` and `effects`), not computed from their operands: `integerRange`'s `computedFrom` reads
 *  no further. */
const READS_MEMORY: ReadonlySet<string> = new Set(
  Object.entries(OPCODES as Record<string, OpSig>)
    .filter(([, sig]) => sig.reads === true || sig.effects === true)
    .map(([op]) => op),
);

/** The rounds an induction hypothesis may grow before it proves nothing. */
const INDUCTION_ROUNDS = 4;

/** The sides of a branch's bound that are not its window's edge, each as a one-value range. */
function boundSides(b: EdgeBound): StridedRange[] {
  const [floor, ceil] = b.window === 'u' ? [0, WORD - 1] : [S_MIN, S_MAX];
  return [b.r.lo === floor ? undefined : b.r.lo, b.r.hi === ceil ? undefined : b.r.hi]
    .filter((x): x is number => x !== undefined)
    .map((x) => ({ lo: x, hi: x, stride: 0 }));
}

/** An integer range as signed words, or undefined when it holds words on both sides of the sign. */
function intoSigned(r: StridedRange): StridedRange | undefined {
  if (r.lo >= S_MIN && r.hi <= S_MAX) {
    return r;
  }
  const w = intoWord(r);
  if (w === undefined || w.hi <= S_MAX) {
    return w;
  }
  return w.lo > S_MAX ? { lo: w.lo - WORD, hi: w.hi - WORD, stride: w.stride } : undefined;
}

/** What `x <opcode> y` proves of `x`, `y` being somewhere in `other`; undefined for `icmp_ne`, and
 *  for a compare no `x` can pass (an edge that is never taken bounds nothing here). */
function testBound(opcode: string, other: StridedRange): EdgeBound | undefined {
  const span = (lo: number, hi: number, window: 'u' | 's'): EdgeBound | undefined =>
    lo > hi ? undefined : { r: { lo, hi, stride: lo === hi ? 0 : 1 }, window };
  const w = intoWord(other);
  const s = intoSigned(other);
  switch (opcode) {
    case 'icmp_eq':
      return w === undefined ? undefined : { r: w, window: 'u' };
    case 'icmp_ult':
      return w && span(0, w.hi - 1, 'u');
    case 'icmp_ule':
      return w && span(0, w.hi, 'u');
    case 'icmp_ugt':
      return w && span(w.lo + 1, WORD - 1, 'u');
    case 'icmp_uge':
      return w && span(w.lo, WORD - 1, 'u');
    case 'icmp_slt':
      return s && span(S_MIN, s.hi - 1, 's');
    case 'icmp_sle':
      return s && span(S_MIN, s.hi, 's');
    case 'icmp_sgt':
      return s && span(s.lo + 1, S_MAX, 's');
    case 'icmp_sge':
      return s && span(s.lo, S_MAX, 's');
    default:
      return undefined;
  }
}

/** A value's range where a branch also bounds it: the two met in the branch's window, or, where
 *  the range has words on both sides of that window's edge, the narrower of the two (each covers
 *  every word on its own). A meet that holds nothing is `null`: no word the value may hold takes
 *  the branch, so the edge is never taken — `if (k < 0) k += 7` on a counter from 0. */
function meetBound(r: StridedRange | undefined, b: EdgeBound): StridedRange | null {
  if (r === undefined) {
    return b.r;
  }
  const m = b.window === 'u' ? intoWord(r) : intoSigned(r);
  if (m === undefined) {
    return r.hi - r.lo <= b.r.hi - b.r.lo ? r : b.r;
  }
  const lo = Math.max(m.lo, b.r.lo);
  const hi = Math.min(m.hi, b.r.hi);
  if (m.stride === 0) {
    return lo <= hi ? m : null;
  }
  const first = m.lo + Math.ceil((lo - m.lo) / m.stride) * m.stride;
  const last = m.lo + Math.floor((hi - m.lo) / m.stride) * m.stride;
  return first > last ? null : { lo: first, hi: last, stride: first === last ? 0 : m.stride };
}

const mod = (w: number): number => ((w % WORD) + WORD) % WORD;

function gcdOf(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcdOf(b, a % b);
}
