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
// "THE PREVIOUS ARM OF THE SAME DISPATCH" IS A CLAIM ABOUT A DISPATCH, so this file models one
// (`scrutOf` / `armsOf` below) rather than proxying it. Two weaker spellings were tried and both
// are wrong, each in one direction, measured on generated corpora against `origin/main`:
//
//   - "`q` and `p` are each the target of SOME conditional branch" reads the join of an `if` with
//     no `else` as a fall-in: `if (a) { if (b) { c += 2; } return c; } return 0;` gives a body
//     block and a join that are THE TWO SUCCESSORS OF ONE `cond_br`, which is a decision, not an
//     arm running on. Over 79 generated switch-FREE shapes that proxy changed 35 of them and lost
//     18 byte-matches while gaining 17 — noise from a predicate firing where no dispatch exists.
//   - "…and they are not siblings of the SAME `cond_br`" fixes those 18 and costs 20 others (50 of
//     79 against `origin/main`'s 52): it still says nothing about WHICH dispatch.
//
// Modelling the dispatch instead — two arms of two DIFFERENT tests on the SAME scrutinee — makes
// the subtraction byte-for-byte INERT on all 79 (`origin/main`'s exact scores), because a function
// with no comparison-tree dispatch now has no fall-in to subtract, which is the truth. It is also
// what keeps the shape this pass EXISTS for: `if (a) { … return 0; } if (b) { … return 0; }`
// converges two computing arms on a shared exit, but they are arms of tests on DIFFERENT values,
// so neither is subtracted and the chain is still seen. Subtracting any adjacent computing pred
// instead costs five real-tier sites their sinking (`kleod:EntityItemDrop`,
// `marioparty3:HuPrcChildUnlink`, `pokeemerald:ModifyStatByNature`,
// `pokeemerald:SetMauvilleOldManLanguage`, `pokeemerald:DoForcedMovement`) plus
// `synthetic:armshare:agbcc` — measured, by counting firings over both corpora.
//
// The two other clauses (`FALL_IN_GATES`): `q` must arrive by an UNCONDITIONAL branch, and it must
// have a BODY. `isBodyless` is the shared spelling of the second — a bodyless arm is the record
// gcc leaves of a decision that RAN OUT (`emit_case_nodes` mints a `b .Ldefault` per exhausted
// subtree) and it arrives rather than falls in; dropping it costs `synthetic:llshr:gcc2.7.2kmc`
// its sinking, and the parameter half of `isBodyless` is what keeps an EMPTY case arm (one op, but
// it binds the accumulator) on the fall-in side.
//
// AND THE MERGE MUST BELONG TO THAT DISPATCH (`ownedBy`). A fall-through switch can SHARE its
// return with control flow outside itself — a guard's `goto` onto the same `return` — and there
// refusing to sink is exactly wrong: the merge is left standing, Regime-A switch recovery declines
// on it, and if-recovery duplicates the tails anyway. The pred shape alone cannot see the
// difference (both shapes present one fell-into arm with two preds); the SCRUTINEE can, because
// the guard tests a different value. Measured: 140 generated `if (…) goto L; switch (…) {…} L:`
// shapes, 0 byte-matches at `origin/main` and 0 with the pred-shape proxy, 19 with this clause.
//
// REGIME SCOPE — the model is `cond_br`-seeded, so it is INERT ON A JUMP TABLE. A `switch_br`
// dispatch's arms are invisible to `armsOf`, `fellInto` never fires there, and the pass behaves
// exactly as it did before any of this (`synthetic:sw_jtfall`/`sw_jtfalldesc` are the corpus
// inhabitants: retsink fires on them with an EMPTY `armsOf`). That is deliberate rather than
// overlooked — seeding `switch_br` too would change those matching rows with no row asking for it
// — and it is the SECOND definition of "this arm falls into that one" in the tree, the first being
// `switch-recover.ts analyzeArmExit`, which covers both regimes and is not reachable from `raise/`.
// Anyone building the Regime-B hoist inherits this hole and should route both through one
// recognizer instead of widening the seed here.
//
// This does NOT recover the boolean-VALUE form `return a && b` — that is shortcircuit.ts's job
// (the `logic_and`/`logic_or` connective plus agbcc's `(-b|b)>>31` = `b!=0` normalisation).
import { Block, Fn, Value, defOpMap, isBodyless, mkOp, predecessors } from '../ir/core';
import { NEGATED_ICMP } from '../ir/opcodes';
import { simplifyTrivialPhis } from '../ir/simplify';
import { type Gate, firstRejection } from '../l3/gates';

/** The fused short-circuit connectives (raise/shortcircuit.ts). A `cond_br` on one of these is the
 *  post-fusion record of the ≥2 conditions that used to reach a shared arm. */
const CONNECTIVES = new Set(['logic_and', 'logic_or']);

/** "`q` is the previous arm of the same dispatch, RUNNING ON into `target`" — the one arrival
 *  `arrivals` subtracts. `dispatches` is already the answer to the hard half (see `siblingArms` and
 *  `ownedBy` in `sinkReturns`); the table is here so each clause can be dropped and the pass re-run
 *  on real input, which is how this round had to price them (three patched source trees) before it
 *  had one. Every clause is `sound: false` — they trade BYTES, never correctness: admitting one
 *  wrongly spells a correct function the compiler does not re-emit, and refusing one wrongly does
 *  the same in the other direction. */
export interface FallInCandidate {
  /** the predecessor under test */
  readonly q: Block;
  /** the block it would have fallen into */
  readonly target: Block;
  /** the scrutinees whose dispatch has `q` and `target` as arms of two DIFFERENT tests AND owns
   *  the return merge — empty when there is no such dispatch */
  readonly dispatches: readonly Value[];
}

export const FALL_IN_GATES: readonly Gate<FallInCandidate>[] = [
  {
    // A DEFINITION rather than a tuning knob, and the one entry here no test and no corpus row
    // has been shown to move: a `cond_br` pred did not run on into this block, it chose it, so
    // calling that a fall-in would be wrong about the CFG whatever it did to the bytes.
    id: 'arrives-by-decision',
    why: 'a `cond_br` pred CHOSE this block; that is a decision arriving, never a fall-in',
    sound: false,
    rejects: (c) => {
      const t = c.q.ops[c.q.ops.length - 1];
      return t?.opcode !== 'br' || t.successors.length !== 1 || t.successors[0].block !== c.target;
    },
  },
  {
    // Paid for by a CORPUS row, not by a unit test: dropping it costs `synthetic:llshr:gcc2.7.2kmc`
    // its sinking (round one's firing census). Ablating it moves none of this file's fixtures.
    id: 'bodyless-arm',
    why: "gcc's `b .Ldefault` for an exhausted subtree is a decision that RAN OUT, not an arm",
    sound: false,
    rejects: (c) => isBodyless(c.q),
  },
  {
    id: 'one-dispatch-owning-the-merge',
    why: 'both arms of ONE dispatch on one scrutinee, and that dispatch owns the return merge',
    sound: false,
    guardedBy: 'ablating the dispatch gate reads an `if` join, and a guarded switch, as fall-ins',
    rejects: (c) => c.dispatches.length === 0,
  },
];

/** Tail-duplicate a return-only merge block into its unconditional-branch predecessors, but ONLY in the
 *  short-circuit shape (some branch-pred is shared, or the arms are selected by a fused connective).
 *  Returns whether anything changed. A "return-only" block is exactly one `ret` whose operands are all
 *  its own block-params, so each predecessor already carries the returned value as a successor arg. */
export function sinkReturns(fn: Fn, gates: readonly Gate<FallInCandidate>[] = FALL_IN_GATES): boolean {
  let changed = false;
  const preds = predecessors(fn);
  const defs = defOpMap(fn);
  // THE DISPATCH MODEL. A TEST BLOCK ends in a `cond_br` on an integer comparison of exactly one
  // non-constant value against constants — `scrutOf` records that value, the SCRUTINEE. Two test
  // blocks belong to the same dispatch when they test the same scrutinee, which is `recognizeSwitch`'s
  // own PRE1 ("every test is on the SAME Value") read at the raise level, without its dominance,
  // purity or interval preconditions: those decide whether a `switch` can be SPELLED, and this pass
  // only needs to know that a decision tree is there. `NEGATED_ICMP` is the shared spelling of the
  // icmp family (ir/opcodes.ts), so an eleventh comparison joins this model for free.
  //
  // Constant folding is deliberately NOT reproduced here (`switch-recover.ts evalConst` folds
  // agbcc's synthesized immediates). A test whose constant side this cannot see contributes two
  // non-constant operands and is skipped, which loses a subtraction rather than inventing one.
  const scrutOf = new Map<Block, Value>();
  /** Arms, indexed by the block reached and the scrutinee whose test sent it there — the test
   *  blocks are the value, because a fall-in requires the two arms to come from DIFFERENT tests. */
  const armsOf = new Map<Block, Map<Value, Set<Block>>>();
  for (const b of fn.blocks) {
    const t = b.ops[b.ops.length - 1];
    if (t?.opcode !== 'cond_br') {
      continue;
    }
    const cmp = defs.get(t.operands[0]);
    if (!cmp || !(cmp.opcode in NEGATED_ICMP)) {
      continue;
    }
    const vars = cmp.operands.filter((o) => defs.get(o)?.opcode !== 'const');
    if (vars.length !== 1) {
      continue;
    }
    const scrut = vars[0];
    scrutOf.set(b, scrut);
    for (const e of t.successors) {
      let byScrut = armsOf.get(e.block);
      if (!byScrut) {
        byScrut = new Map();
        armsOf.set(e.block, byScrut);
      }
      const tests = byScrut.get(scrut) ?? new Set<Block>();
      tests.add(b);
      byScrut.set(scrut, tests);
    }
  }
  /** Is this block part of the dispatch on `s` — either one of its tests, or an arm of one? */
  const inDispatch = (b: Block, s: Value) => scrutOf.get(b) === s || !!armsOf.get(b)?.has(s);
  /** The scrutinees for which `q` and `target` are arms of two DIFFERENT tests: the dispatches in
   *  which one could be the previous arm of the other. Two successors of ONE `cond_br` — the body
   *  and the join of an `if` with no `else` — share no such scrutinee, which is the whole point. */
  const siblingArms = (q: Block, target: Block): Value[] => {
    const aq = armsOf.get(q);
    const at = armsOf.get(target);
    if (!aq || !at) {
      return [];
    }
    const out: Value[] = [];
    for (const [s, testsQ] of aq) {
      const testsT = at.get(s);
      if (testsT && [...testsQ].some((c) => [...testsT].some((d) => c !== d))) {
        out.push(s);
      }
    }
    return out;
  };
  // Terminators are read with `?.` throughout: `ir/verify.ts` rejects an empty block and
  // `pipeline.ts` verifies before calling this, but `sinkReturns` is exported and its tests build
  // blocks by hand, where a refusal is a better answer than a TypeError.
  const isBrTo = (p: Block, m: Block) => {
    const t = p.ops[p.ops.length - 1];
    return t?.opcode === 'br' && t.successors.length === 1 && t.successors[0].block === m;
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
    // Does the dispatch on `s` OWN this merge? Every predecessor of `m` must be part of it — one of
    // its tests, or an arm of one. A `goto` from outside the switch onto the same `return` fails
    // this on the scrutinee it tests, and then nothing is subtracted and the merge is sunk, which
    // is what recovers those 19 shapes. `ps`, not `brPreds`: in the shape that motivates this the
    // outside arrival is a `cond_br` (the guard's `bgt`), which never appears in `brPreds`.
    const ownedBy = (s: Value) => ps.every((p) => inDispatch(p, s));
    // `q` FELL INTO `p`: it is the previous arm of the same dispatch, running on. The clauses are
    // `FALL_IN_GATES` above, the argument for each is in this file's header, and `arrivals` counts
    // every OTHER predecessor. Layout adjacency — `q` sitting immediately above `p`, which is what
    // "fell through" means in the assembly — was measured too and changes NOTHING over 991 corpus
    // functions, so it is not a clause: it would be an unpaid premise about `fn.blocks` still
    // being address order.
    const fellInto = (q: Block, target: Block) =>
      firstRejection(gates, { q, target, dispatches: siblingArms(q, target).filter(ownedBy) }) === null;
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
