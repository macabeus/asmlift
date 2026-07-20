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
