// asmlift IR — the verifier. Runs after every pass; a bad edit fails HERE, at its source,
// not three stages later as wrong output. Invariants:
//   1. every block ends in exactly one terminator (and it is the last op)
//   2. operands well-formed: opcode registered, correct arity/attrs
//   3. SSA: each value defined once; every use is defined; def dominates use
import { Block, Fn, Value, predecessors } from './core';
import { opSig } from './opcodes';

export class VerifyError extends Error {}

// Opcodes admitting EITHER a 2-operand register form OR a 1-operand + `imm` attr form.
const TWO_OR_IMM = new Set(['sdiv', 'shl', 'shr_u', 'shr_s']);

export function verify(fn: Fn): void {
  if (fn.blocks.length === 0) {
    throw new VerifyError(`fn '${fn.name}' has no blocks`);
  }

  // --- collect definitions; reject double-definition ---
  const defined = new Set<Value>();
  const defBlock = new Map<Value, Block>();
  const defIndex = new Map<Value, number>(); // -1 for block params
  const define = (v: Value, b: Block, idx: number, what: string) => {
    if (defined.has(v)) {
      throw new VerifyError(`value defined twice (${what})`);
    }
    defined.add(v);
    defBlock.set(v, b);
    defIndex.set(v, idx);
  };
  for (const b of fn.blocks) {
    for (const p of b.params) {
      define(p, b, -1, 'block param');
    }
    b.ops.forEach((op, idx) => op.results.forEach((r) => define(r, b, idx, `result of '${op.opcode}'`)));
  }

  // --- per-op structural + arity + level checks ---
  const at = (b: Block, idx: number) => `(fn '${fn.name}', block ^bb${fn.blocks.indexOf(b)}, op ${idx})`;
  for (const b of fn.blocks) {
    if (b.ops.length === 0) {
      throw new VerifyError(`empty block ^bb${fn.blocks.indexOf(b)} in '${fn.name}'`);
    }
    b.ops.forEach((op, idx) =>
      locate(
        () => {
          const sig = opSig(op.opcode);
          if (!sig) {
            throw new VerifyError(`unknown opcode '${op.opcode}'`);
          }
          if (sig.operands !== 'variadic' && op.operands.length !== sig.operands) {
            throw new VerifyError(`'${op.opcode}' expects ${sig.operands} operands, got ${op.operands.length}`);
          }
          if (op.results.length !== sig.results) {
            throw new VerifyError(`'${op.opcode}' expects ${sig.results} results, got ${op.results.length}`);
          }
          // `sdiv` and the shifts are variadic to admit BOTH forms (2-operand register form, or
          // 1-operand + `imm`), so the generic arity check can't guard them. Enforce the real
          // invariant here — otherwise a malformed op (0 operands, or 1 with no `imm`) would slip
          // through and render `/ undefined` / `<< undefined` downstream instead of failing at its
          // source.
          if (
            TWO_OR_IMM.has(op.opcode) &&
            !(op.operands.length === 2 || (op.operands.length === 1 && 'imm' in op.attrs))
          ) {
            throw new VerifyError(
              `'${op.opcode}' must be 2 operands OR 1 operand with an 'imm' attr, got ${op.operands.length} operands`,
            );
          }
          // `ret` is variadic to admit the void form; anything past one returned value is malformed.
          if (op.opcode === 'ret' && op.operands.length > 1) {
            throw new VerifyError(`'ret' takes at most 1 operand, got ${op.operands.length}`);
          }
          const isTerm = !!sig.terminator;
          const isLast = idx === b.ops.length - 1;
          if (isTerm && !isLast) {
            throw new VerifyError(`terminator '${op.opcode}' is not the last op in its block`);
          }
          if (!isTerm && isLast) {
            throw new VerifyError(`block does not end in a terminator (ends with '${op.opcode}')`);
          }
          if (typeof sig.successors === 'number' && op.successors.length !== sig.successors) {
            throw new VerifyError(`'${op.opcode}' expects ${sig.successors} successors, got ${op.successors.length}`);
          }
          // `switch_br` has variadic successors (N cases + 1 default). Enforce its real invariants here (as
          // the generic count check can't): ≥2 successors, a `cases` list index-aligned with the first N,
          // and DISTINCT case values (a duplicate would only surface as a `duplicate case` error at recompile).
          if (op.opcode === 'switch_br') {
            if (op.successors.length < 2) {
              throw new VerifyError(`'switch_br' needs ≥2 successors (cases + default), got ${op.successors.length}`);
            }
            const cases = op.attrs.cases;
            if (!Array.isArray(cases) || cases.length !== op.successors.length - 1) {
              throw new VerifyError(
                `'switch_br' 'cases' must have (successors - 1) = ${op.successors.length - 1} entries`,
              );
            }
            if (new Set(cases as number[]).size !== cases.length) {
              throw new VerifyError(`'switch_br' has duplicate case values`);
            }
          }
          if (!isTerm && op.successors.length) {
            throw new VerifyError(`non-terminator '${op.opcode}' has successors`);
          }
          for (const k of sig.requiredAttrs ?? []) {
            if (!(k in op.attrs)) {
              throw new VerifyError(`'${op.opcode}' missing required attr '${k}'`);
            }
          }
          for (const u of op.operands) {
            if (!defined.has(u)) {
              throw new VerifyError(`use of undefined value in '${op.opcode}'`);
            }
          }
          for (const s of op.successors) {
            if (!fn.blocks.includes(s.block)) {
              throw new VerifyError(`successor of '${op.opcode}' is not a block of this fn`);
            }
            if (s.args.length !== s.block.params.length) {
              throw new VerifyError(
                `successor of '${op.opcode}' passes ${s.args.length} args to a block with ${s.block.params.length} params`,
              );
            }
            for (const u of s.args) {
              if (!defined.has(u)) {
                throw new VerifyError(`use of undefined value in successor args of '${op.opcode}'`);
              }
            }
          }
        },
        () => at(b, idx),
      ),
    );
  }

  // --- dominance (iterative dominators over the CFG) ---
  const entry = fn.blocks[0];
  const preds = predecessors(fn);
  const dom = new Map<Block, Set<Block>>();
  const allBlocks = new Set(fn.blocks);
  for (const b of fn.blocks) {
    dom.set(b, b === entry ? new Set([entry]) : new Set(allBlocks));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of fn.blocks) {
      if (b === entry) {
        continue;
      }
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
      if (!setEq(next, dom.get(b)!)) {
        dom.set(b, next);
        changed = true;
      }
    }
  }
  const dominates = (a: Block, b: Block) => dom.get(b)!.has(a);

  for (const b of fn.blocks) {
    b.ops.forEach((op, idx) =>
      locate(
        () => {
          const checkUse = (u: Value) => {
            const db = defBlock.get(u)!;
            if (db === b) {
              const di = defIndex.get(u)!;
              if (di >= 0 && di >= idx) {
                throw new VerifyError(`use before def in '${op.opcode}'`);
              }
            } else if (!dominates(db, b)) {
              throw new VerifyError(`def does not dominate use in '${op.opcode}'`);
            }
          };
          op.operands.forEach(checkUse);
          op.successors.forEach((s) => s.args.forEach(checkUse));
        },
        () => at(b, idx),
      ),
    );
  }
}

/** Run a check body; a VerifyError it throws is re-thrown with the op's location appended —
 *  "value defined twice" is unactionable without WHICH block/op. */
function locate(body: () => void, where: () => string): void {
  try {
    body();
  } catch (e) {
    if (e instanceof VerifyError) {
      throw new VerifyError(`${e.message} ${where()}`);
    }
    throw e;
  }
}

function setEq(a: Set<Block>, b: Set<Block>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const x of a) {
    if (!b.has(x)) {
      return false;
    }
  }
  return true;
}
