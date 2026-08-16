// asmlift — return-sinking (F-CFG-class structural pass; successor-aware, ISA-neutral).
//
// A short-circuit `if (a && b) return X; return Y;` (and the `||` / value-returning variants) compiles to
// a diamond whose arms converge on a single RETURN block: `br ^merge(X)` / `br ^merge(Y)` into
// `^merge(v): ret v`. The structurer lowers that merge as a shared VARIABLE — `v0 = X … v0 = Y … return v0`
// — which is byte-exact-CORRECT but recompiles DIFFERENTLY from the source: agbcc/gcc, given the natural
// `if (a==0) return Y; if (b==0) return Y; return X;` (early returns), re-share the return block and match;
// given the merge-variable spelling they materialise the merge differently and MISS (verified on `ifand`).
// The fix is a classic transform: TAIL-DUPLICATE a return-only merge block into each predecessor that
// reaches it by an unconditional branch — replace `br ^merge(v)` with `ret v` and drop the now-unreachable
// merge. The structurer then emits early returns in each arm (it already duplicates a shared arm block),
// which recompiles to the compiler's shared-return form. Purely structural: no new IR/AST vocabulary.
//
// GATE — only the SHORT-CIRCUIT shape, never a simple value-select. A single-condition select
// (`c ? x : y`, and the branchless-compare idioms `clamp0`/`le0`/…) also converges two arms on a return
// merge, but there the compiler emits the MERGE-VARIABLE form, which is what byte-matches — sinking it
// would REGRESS those. The distinguishing signal is structural: a short-circuit chain converges on a
// SHARED arm (the common early-exit reached from ≥2 conditions, so it has ≥2 predecessors), whereas a
// simple diamond's arms each have exactly one predecessor. So sink only when some branch-predecessor of
// the merge is itself shared (≥2 preds); every simple select stays a merge var.
//
// This does NOT recover the boolean-VALUE form `return a && b` — that is shortcircuit.ts's job
// (the `logic_and`/`logic_or` connective plus agbcc's `(-b|b)>>31` = `b!=0` normalisation).
import { Block, Fn, defOpMap, mkOp, predecessors } from '../ir/core';

/** The fused short-circuit connectives (raise/shortcircuit.ts). A `cond_br` on one of these is the
 *  post-fusion record of the ≥2 conditions that used to reach a shared arm. */
const CONNECTIVES = new Set(['logic_and', 'logic_or']);

/** Tail-duplicate a return-only merge block into its unconditional-branch predecessors, but ONLY in the
 *  short-circuit shape (some branch-pred is shared, or the arms are selected by a fused connective).
 *  Returns whether anything changed. A "return-only" block is exactly one `ret` whose operands are all
 *  its own block-params, so each predecessor already carries the returned value as a successor arg. */
export function sinkReturns(fn: Fn): boolean {
  let changed = false;
  const preds = predecessors(fn);
  const defs = defOpMap(fn);
  const isBrTo = (p: Block, m: Block) => {
    const t = p.ops[p.ops.length - 1];
    return t.opcode === 'br' && t.successors.length === 1 && t.successors[0].block === m;
  };
  for (const m of [...fn.blocks]) {
    if (m.ops.length !== 1) {
      continue;
    }
    const ret = m.ops[0];
    if (ret.opcode !== 'ret') {
      continue;
    }
    // Every returned value must be a param of this block (so it comes in on the edge). A `ret` of a
    // value computed elsewhere, or of a non-param, can't be reconstructed from the predecessor's args.
    if (!ret.operands.every((o) => m.params.includes(o))) {
      continue;
    }
    const ps = preds.get(m) ?? [];
    const brPreds = ps.filter((p) => isBrTo(p, m));
    if (brPreds.length === 0) {
      continue;
    }
    // SHORT-CIRCUIT GATE, in two shapes — the chain must be visible in the CFG or in the value domain.
    //
    //   (a) UNFUSED: at least one branch-pred is a shared block (≥2 preds of its own) — the common
    //       early-exit reached from every condition of the chain.
    //   (b) FUSED: `branch-shortcircuit` (raise/shortcircuit.ts) rewrites the head's condition into a
    //       `logic_and`/`logic_or` and collapses the second condition block into it. That leaves both
    //       arms single-pred, so (a) cannot see the chain any more — but the CONNECTIVE is now the
    //       record of the ≥2 conditions the shared arm used to be. That pass runs in pre-recovery,
    //       i.e. BEFORE this one, so on `ifand`/`and3` shape (b) is the only one that ever fires.
    //
    //       The connective ALONE is not enough, and the extra requirement is BOTH arms being real
    //       blocks (≥2 `br` preds). `return a || b` (synthetic:lor:agbcc) also ends up as a
    //       `cond_br` on a `logic_or`, but it is a value-merge: one edge runs from the head STRAIGHT
    //       into the merge, so the merge has a single `br` pred. Sinking it replaces the merge
    //       variable that byte-matches: dropping the `brPreds.length >= 2` half of this gate costs
    //       that row its match. A two-armed diamond is what
    //       distinguishes `if (a && b) return X; return Y;` from every value-merge.
    //
    // A simple single-condition select is excluded by both arms of the gate for the same reason:
    // `clamp0`/`sel` reach their merge on the `cond_br` edge itself, so they too have exactly one
    // `br` pred, and their condition is a bare icmp rather than a connective.
    const selectedByConnective = (p: Block) =>
      (preds.get(p) ?? []).some((q) => {
        const t = q.ops[q.ops.length - 1];
        return t.opcode === 'cond_br' && CONNECTIVES.has(defs.get(t.operands[0])?.opcode ?? '');
      });
    const fusedDiamond = brPreds.length >= 2 && brPreds.some(selectedByConnective);
    if (!brPreds.some((p) => (preds.get(p)?.length ?? 0) >= 2) && !fusedDiamond) {
      continue;
    }
    for (const p of brPreds) {
      const args = p.ops[p.ops.length - 1].successors[0].args;
      const sunk = ret.operands.map((o) => args[m.params.indexOf(o)]);
      p.ops[p.ops.length - 1] = mkOp('ret', { operands: sunk });
      changed = true;
    }
    // If no predecessor still branches to m (all were unconditional), it is unreachable — drop it.
    if (brPreds.length === ps.length && fn.blocks[0] !== m) {
      fn.blocks = fn.blocks.filter((b) => b !== m);
    }
  }
  return changed;
}
