// asmlift IR — the MLIR-lite substrate shared by all levels.
//
//   - a CFG of basic blocks with TYPED BLOCK-ARGUMENTS (functional-form SSA); no phi
//   - exactly one terminator per block; terminators carry successors + block-arg lists
//   - Value identity is OBJECT IDENTITY, owned by the graph — no module-global counter;
//     textual names are assigned at print time by deterministic traversal
//   - passes transform via replaceAllUsesWith, never in-place opcode/type mutation
//
// The two real representations are this `Fn` (typed-SSA) and the structured `SFn` AST; type
// recovery is an in-place pass on `Fn`.
import type { Opcode } from './opcodes';
import type { IrType } from './types';

export type AttrVal = number | boolean | string | number[];

/** An SSA value. Identity is the object itself; the type may be `unknown` at L1. */
export interface Value {
  type: IrType;
}

/** A branch target: which block, and the arguments bound to its block-parameters. */
export interface Successor {
  block: Block;
  args: Value[];
}

export interface Op {
  opcode: string;
  operands: Value[];
  results: Value[];
  attrs: Record<string, AttrVal>;
  successors: Successor[]; // non-empty only for terminators
}

/** A basic block. `params` are its block-arguments. Must end in exactly one terminator. */
export interface Block {
  params: Value[];
  ops: Op[];
}

/** A function. `blocks[0]` is the entry; its params are the function parameters. */
export interface Fn {
  name: string;
  blocks: Block[];
}

export function mkValue(type: IrType): Value {
  return { type };
}

export function mkOp(opcode: Opcode, o: Partial<Op> = {}): Op {
  return {
    opcode,
    operands: o.operands ?? [],
    results: o.results ?? [],
    attrs: o.attrs ?? {},
    successors: o.successors ?? [],
  };
}

/** The successor blocks of `b`, read off its terminator. */
export function successorsOf(b: Block): Block[] {
  const term = b.ops[b.ops.length - 1];
  return term ? term.successors.map((s) => s.block) : [];
}

/** Predecessor map for the whole function's CFG. */
export function predecessors(fn: Fn): Map<Block, Block[]> {
  const preds = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    preds.set(b, []);
  }
  for (const b of fn.blocks) {
    for (const s of successorsOf(b)) {
      preds.get(s)!.push(b);
    }
  }
  return preds;
}

/** Forward dominators (iterative data-flow). dom(b) = {b} ∪ ⋂ dom(preds).
 *
 *  A CFG fact, so it lives beside `predecessors` it is built on rather than with either consumer:
 *  `verify` needs it to check def-dominates-use, `structure/loops.ts` to tell a back-edge from a
 *  forward one, and `raise/latch.ts` to tell a latch from a preheader. */
/** Where a chain of TRANSPARENT forwarding blocks lands — no params, a lone `br`, no block args.
 *
 *  A compiler that cannot reach a target from a conditional branch emits the real branch separately
 *  (agbcc past Thumb's ±256-byte range; the binary-search layout of a `switch`), so two sites
 *  reaching one block arrive as two DISTINCT forwarding blocks. A recogniser keyed on successor
 *  identity needs the destination, not the edge.
 *
 *  An edge carrying block ARGUMENTS is not transparent — skipping it would drop the value it
 *  supplies — so the walk stops there. Read-only: nothing about the graph changes. */
export function forwardingTarget(b: Block): Block {
  const seen = new Set<Block>();
  let cur = b;
  while (cur.params.length === 0 && cur.ops.length === 1 && !seen.has(cur)) {
    seen.add(cur);
    const t = cur.ops[0];
    if (t.opcode !== 'br' || t.successors[0].args.length > 0) {
      break;
    }
    cur = t.successors[0].block;
  }
  return cur;
}

export function dominators(fn: Fn): Map<Block, Set<Block>> {
  const preds = predecessors(fn);
  const all = new Set(fn.blocks);
  const dom = new Map<Block, Set<Block>>();
  fn.blocks.forEach((b, i) => dom.set(b, i === 0 ? new Set([b]) : new Set(all)));
  for (let changed = true; changed;) {
    changed = false;
    for (const b of fn.blocks.slice(1)) {
      let inter: Set<Block> | null = null;
      for (const p of preds.get(b)!) {
        const dp = dom.get(p)!;
        if (inter === null) {
          inter = new Set(dp);
          continue;
        }
        for (const x of inter) {
          if (!dp.has(x)) {
            inter.delete(x);
          }
        } // intersect in place (spec-safe delete-in-iter)
      }
      const next = new Set<Block>(inter ?? []);
      next.add(b);
      const prev = dom.get(b)!;
      if (next.size !== prev.size || [...next].some((x) => !prev.has(x))) {
        dom.set(b, next);
        changed = true;
      }
    }
  }
  return dom;
}

/** Every value defined by an op result → its defining op (block params excluded). */
export function defOpMap(fn: Fn): Map<Value, Op> {
  const m = new Map<Value, Op>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        m.set(r, op);
      }
    }
  }
  return m;
}

/** Replace every use of `oldV` with `newV` (operands + successor args). No in-place op mutation. */
export function replaceAllUsesWith(fn: Fn, oldV: Value, newV: Value): void {
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.operands = op.operands.map((v) => (v === oldV ? newV : v));
      for (const s of op.successors) {
        s.args = s.args.map((v) => (v === oldV ? newV : v));
      }
    }
  }
}
