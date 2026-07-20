// asmlift — 32-bit constant materialisation (F-CONST; L1 recognition, ISA-neutral).
//
// A RISC target builds a 32-bit literal in two halves: a high-half load (MIPS `lui`, PPC `lis`) then a
// low-half `ori`/`addiu`. The frontends lift that pair faithfully as `or(const(hi<<16), const(lo))` /
// `add(const(hi<<16), const(lo))` — a live binary op over two `const` ops — because neither frontend can
// see across the two instructions. This pass folds any such const/const `or`/`add` into a single `const`,
// which is the form that (a) type-recovers as one 32-bit literal and (b) recompiles to the exact
// `lui;ori` / `lis;ori` pair. Without it a magic-division reciprocal or an address literal is never a
// single value the later passes can reason about.
//
// This cannot be a data-`RewritePattern`: the fold's result is COMPUTED from the two operands' values,
// which the pattern engine's numeric-exact `attrEquals` cannot express. So it lives here as an always-on
// recognizer, run before type recovery. Value-preserving and local; a single left-to-right pass suffices
// (SSA guarantees each const is defined before the op that consumes it, and a folded result feeds
// forward for any chained materialisation).
import { Fn, Op, defOpMap, mkOp } from '../ir/core';

// The binary opcodes whose const/const form is a constant. `>> 0` normalises to a signed 32-bit result
// (hardware wraparound): `|` already yields int32, `+` may exceed it and is truncated to match `addu`/`add`.
const FOLD: Record<string, (a: number, b: number) => number> = {
  or: (a, b) => (a | b) >> 0,
  add: (a, b) => (a + b) >> 0,
};

/** Fold each const/const `or`/`add` into one `const`, in place. Returns whether anything changed. The
 *  now-dead source consts are left for DCE (they may still have other uses; liveness is not our concern). */
export function recognizeConsts(fn: Fn): boolean {
  let changed = false;
  const defs = defOpMap(fn);
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
      // Reuse the SAME result Value → every existing use already points at it (no RAUW needed).
      const folded = mkOp('const', { results: [op.results[0]], attrs: { value: fold(a, c) } });
      b.ops.splice(i, 1, folded);
      defs.set(op.results[0], folded); // keep the def map current so a chained fold sees this const
      changed = true;
    }
  }
  return changed;
}
