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
// SHARED arm — the common early-exit reached from ≥2 CONDITIONS — whereas a simple diamond's arms are
// each reached from one. So sink only when some branch-predecessor of the merge is ARRIVED at from
// two places; every simple select stays a merge var.
//
// READ THE QUANTITY AS ARRIVALS, NOT AS PREDECESSORS. The gate long said "≥2 preds", which is a
// wider set, and a FALL-THROUGH switch arm is in the difference: `case 2: r++; case 1: r++;` gives
// case 1's body two predecessors — the dispatch's `beq`, and case 2's body running on — for a
// reason that has nothing to do with a chain of conditions. Sinking there tail-duplicates a
// switch's SHARED RETURN into all five of its paths, which agbcc then constant-folds per arm
// (`synthetic:sw_fall:agbcc`: measured 5 of its 11 differing rows).
//
// So one predecessor is SUBTRACTED, and only one kind: the previous arm RUNNING ON into this one
// (`fellInto` below). It is subtracted for what it IS, not for what it computed — "this pred
// computed something" is a proxy for the same intuition and it does not hold: the two arms of
// `if (a) { … return 0; } if (b) { … return 0; }` both compute and both jump to the shared exit,
// and that is the chain this pass exists for (measured: reading the proxy halved the pass's reach,
// 20 firings → 9 over the synthetic corpus and 14 → 8 over the real one, and cost
// `kleod:EntityItemDrop:agbcc` a `switch` it recovers).
//
// This does NOT recover the boolean-VALUE form `return a && b` — that is shortcircuit.ts's job
// (the `logic_and`/`logic_or` connective plus agbcc's `(-b|b)>>31` = `b!=0` normalisation).
import { Block, Fn, defOpMap, isBodyless, mkOp, predecessors } from '../ir/core';
import { simplifyTrivialPhis } from '../ir/simplify';

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
  /** Every block some CONDITIONAL branch can reach: the arms of the function's decisions. A block
   *  in this set was jumped to BECAUSE a test went one way, which is what makes it a candidate
   *  sibling of another such block. */
  const armTarget = new Set<Block>();
  for (const b of fn.blocks) {
    const t = b.ops[b.ops.length - 1];
    if (t?.opcode === 'cond_br') {
      for (const e of t.successors) {
        armTarget.add(e.block);
      }
    }
  }
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
    //   (a) UNFUSED: at least one branch-pred is ARRIVED AT from ≥2 places — the common early-exit
    //       reached from every condition of the chain. Everything that reaches it counts EXCEPT the
    //       previous arm running on; that subtraction is stated at `fellInto` below, and it is the
    //       whole of this gate's content.
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
    // `q` FELL INTO `p`: it is the previous arm of the same dispatch, running on. Three clauses,
    // each measured against the rows it keeps (`arrivals` counts every OTHER predecessor):
    //
    //   - `q` leaves by an UNCONDITIONAL branch to `p`. A `cond_br` pred chose `p`; that is a
    //     decision arriving, never a fall-in.
    //   - BOTH are arms — targets of some conditional branch. This is the clause that separates a
    //     fall-in from the shape the pass exists for: `if (a) { … return 0; } if (b) { … return 0; }`
    //     converges two computing arms on a shared exit that NO conditional branch targets, so
    //     neither is subtracted and the chain is still seen. Dropping this clause and subtracting
    //     any adjacent computing pred costs five real-tier sites their sinking
    //     (`kleod:EntityItemDrop`, `marioparty3:HuPrcChildUnlink`, `pokeemerald:ModifyStatByNature`,
    //     `pokeemerald:SetMauvilleOldManLanguage`, `pokeemerald:DoForcedMovement`) plus
    //     `synthetic:armshare:agbcc` — measured, by counting firings over both corpora.
    //   - `q` has a BODY (`isBodyless` is the shared spelling of the negation). A bodyless arm is
    //     the record gcc leaves of a decision that RAN OUT — `emit_case_nodes` mints a `b .Ldefault`
    //     per exhausted subtree — and it arrives rather than falls in. Dropping this clause costs
    //     `synthetic:llshr:gcc2.7.2kmc` its sinking. The parameter half of `isBodyless` is what
    //     keeps an EMPTY case arm (one op, but it binds the accumulator) on the fall-in side.
    //
    // Layout adjacency — `q` sitting immediately above `p`, which is what "fell through" means in
    // the assembly — was measured as well and changes NOTHING over 991 corpus functions, so it is
    // not a clause here: it would be an unpaid premise about `fn.blocks` still being address order.
    //
    // Terminators are read with `?.`: `ir/verify.ts` rejects an empty block and `pipeline.ts`
    // verifies before calling this, but `sinkReturns` is exported and its tests build blocks by
    // hand, where a refusal is a better answer than a TypeError.
    const fellInto = (q: Block, target: Block) => {
      const t = q.ops[q.ops.length - 1];
      return (
        t?.opcode === 'br' &&
        t.successors.length === 1 &&
        t.successors[0].block === target &&
        armTarget.has(q) &&
        armTarget.has(target) &&
        !isBodyless(q)
      );
    };
    const arrivals = (p: Block) => (preds.get(p) ?? []).filter((q) => !fellInto(q, p)).length;
    if (!brPreds.some((p) => arrivals(p) >= 2) && !fusedDiamond) {
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
  // Sinking RETIRES in-edges. A merge also reached by a `cond_br` keeps that one — a conditional
  // branch cannot carry a `ret` — and so survives with a SINGLE predecessor, where its parameter is
  // no longer a join but an alias of that edge's argument. Left standing, the structurer destroys
  // the alias into a local of its own (`v0 = 0; return v0;`) and Regime-A switch recovery reads the
  // block as a second, distinct default candidate. The cleanup is `ir/simplify.ts`'s own; it simply
  // has no other caller downstream of here.
  if (changed) {
    simplifyTrivialPhis(fn);
  }
  return changed;
}
