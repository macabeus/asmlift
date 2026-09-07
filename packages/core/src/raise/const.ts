// asmlift — 32-bit constant materialisation (F-CONST; L1 recognition, ISA-neutral).
//
// A RISC target builds a 32-bit literal in two halves: a high-half load (MIPS `lui`, PPC `lis`) then a
// low-half `ori`/`addiu`. The frontends lift that pair faithfully as `or(const(hi<<16), const(lo))` /
// `add(const(hi<<16), const(lo))` — a live binary op over two `const` ops — because neither frontend can
// see across the two instructions. This pass folds such a const/const `or`/`add` into a single `const`,
// which is the form that (a) type-recovers as one 32-bit literal and (b) recompiles to the exact
// `lui;ori` / `lis;ori` pair. Without it a magic-division reciprocal or an address literal is never a
// single value the later passes can reason about.
//
// IT REFUSES A SHAPE THAT IS NOT THAT PAIR, and the refusal is the pass's clientele written down: the
// pair is two consts materialised inside ONE block, so an operand a terminator also hands to a
// successor's block-parameter is a REGISTER the compiler held live across a branch, not a literal
// being built. See the refusal at its site below for what folding one costs.
//
// This cannot be a data-`RewritePattern`: the fold's result is COMPUTED from the two operands' values,
// which the pattern engine's numeric-exact `attrEquals` cannot express. So it lives here as an always-on
// recognizer, run before type recovery. Value-preserving and local; a single left-to-right pass suffices
// (SSA guarantees each const is defined before the op that consumes it, and a folded result feeds
// forward for any chained materialisation).
import { Fn, Op, Value, defOpMap, mkOp } from '../ir/core';

// The binary opcodes whose const/const form is a constant. `>> 0` normalises to a signed 32-bit result
// (hardware wraparound): `|` already yields int32, `+` may exceed it and is truncated to match `addu`/`add`.
const FOLD: Record<string, (a: number, b: number) => number> = {
  or: (a, b) => (a | b) >> 0,
  add: (a, b) => (a + b) >> 0,
};

/** The opcodes whose FIRST operand is a memory BASE (`opcodes.ts`: `load base`, `store base, value`,
 *  `aload base, index`, `astore base, index, value`). Used only to recognise an address literal. */
const MEM_BASE_OPS = new Set(['load', 'store', 'aload', 'astore']);

/** Fold each const/const `or`/`add` into one `const`, in place. Returns whether anything changed. The
 *  now-dead source consts are left for DCE (they may still have other uses; liveness is not our concern). */
export function recognizeConsts(fn: Fn): boolean {
  let changed = false;
  const defs = defOpMap(fn);
  // The two facts the CLIENTELE REFUSAL below reads, both collected in one walk.
  //   `edgeCarried` — every value a terminator hands to a successor's block-parameter. In
  //     functional-form SSA that is exactly "a register the compiler held live across a branch":
  //     the machine had this value in a register at the branch and the join reads it back.
  //   `memBases`    — every value used as a memory base, i.e. the values that ARE addresses.
  const edgeCarried = new Set<Value>();
  const memBases = new Set<Value>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const sc of op.successors) {
        for (const v of sc.args) {
          edgeCarried.add(v);
        }
      }
      if (MEM_BASE_OPS.has(op.opcode) && op.operands.length > 0) {
        memBases.add(op.operands[0]);
      }
    }
  }
  const constOf = (op: Op | undefined): number | null =>
    op && op.opcode === 'const' ? (op.attrs.value as number) : null;
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      const fold = FOLD[op.opcode];
      if (!fold || op.operands.length !== 2 || op.results.length !== 1) {
        continue;
      }
      const a = constOf(defs.get(op.operands[0]));
      const c = constOf(defs.get(op.operands[1]));
      if (a === null || c === null) {
        continue;
      }
      // ── THE REFUSAL: this shape is not a literal being materialised ───────────────────────────
      // The pass's clientele (see the header) is a literal a RISC target builds in two instructions,
      // both of them inside ONE block, out of two consts neither of which existed before. An operand
      // that is ALSO carried on a successor edge is a different thing entirely: a register the
      // compiler held across a branch, whose value on this path happens to be a constant. agbcc's
      // `s = 0; ... if (c) s += 1;` lifts as `add(%s = const 0, const 1)` in the taken arm, where
      // `%s` is also the value bb0 hands the join. Folding it to `const 1` deletes the accumulator's
      // last reference, so every later level sees an arm that materialises a literal and spells it
      // as one (`v = 1;` with an `else v = 0;`) instead of the `s += 1` the target records — and the
      // enumeration gate for the shipped `/merge-home` axis, which is what would have spelled the
      // hoisted init, reads FALSE because the merge feed it looks for is gone.
      //
      // The mapping is a FUNCTION, not a choice, so this is a default and not an axis: a register
      // carried across a branch is not a literal being materialised, whichever compiler produced it.
      //
      // EXCEPT when the result is a memory BASE. `0x03001C00 + 1206` is an address literal even when
      // one arm carries the base register, and an address literal is precisely what the pass exists
      // for. Measured over the whole corpus this carve-out changes nothing (806 lifted rows, 0 folds
      // decided by it) — it is here as a statement of the pass's scope, pinned by `const-fold.test.ts`,
      // not as a fix for an observed row.
      if ((edgeCarried.has(op.operands[0]) || edgeCarried.has(op.operands[1])) && !memBases.has(op.results[0])) {
        continue;
      }
      // Reuse the SAME result Value → every existing use already points at it (no RAUW needed).
      const folded = mkOp('const', { results: [op.results[0]], attrs: { value: fold(a, c) } });
      b.ops.splice(i, 1, folded);
      defs.set(op.results[0], folded); // keep the def map current so a chained fold sees this const
      changed = true;
    }
  }
  return changed;
}
