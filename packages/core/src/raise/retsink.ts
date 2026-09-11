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
// GATE — the SHORT-CIRCUIT shape, plus the one single-condition shape a merge variable cannot spell.
// A single-condition select (`c ? x : y`, and the branchless-compare idioms `clamp0`/`le0`/…) also
// converges two arms on a return merge, and where its arms are COMPUTED the compiler emits the
// MERGE-VARIABLE form, which is what byte-matches — sinking it would REGRESS those. The
// distinguishing signal is structural: a short-circuit chain converges on a SHARED arm — the common
// early-exit reached from ≥2 CONDITIONS — whereas a simple diamond's arms are each reached from one.
// So sink when some branch-predecessor of the merge is ARRIVED at from two places.
//
// A CONSTANT-ARM DIAMOND IS THE EXCEPTION (`SELECT_GATES`), and it is a compiler fact rather than a
// preference. Given `v = K1 … v = K2 … return v`, agbcc never emits that diamond back: a constant is
// unconditionally cheap to materialise, so one arm is HOISTED above the compare and the other
// becomes a conditional skip — `movs r0,#5; cmp r1,#0; bne .L; movs r0,#3; .L: bx lr`, four blocks
// collapsed to two, with no unconditional branch to the merge at all. For the {0,1} pair it goes
// further and folds branchlessly (`negs r0,r0; lsrs r0,r0,#31`), erasing the comparison too.
// Measured on agbcc -O2 -mthumb over {0,1}, {1,0}, {5,3}, two 32-bit pool constants and a three-way
// sign ladder: in every one the merge-variable spelling loses the diamond and the early-return
// spelling keeps it. So where the TARGET holds that diamond, a merge variable is the spelling of
// some other function, and sinking is the only candidate that can match
// (`kleod:IsSelectButtonPressed:agbcc`).
//
// It stops at constants. Whether agbcc hoists a COMPUTED arm is agbcc's own cost question — a one-op
// arm is hoisted (`v = a + b` / `v = b - a` becomes a `subs` above the compare), a three-op arm is
// not — and this pass does not model that threshold. A computed arm is refused, which is what keeps
// `maxi`/`mini`/`absdiff` on the merge-variable side, where they match.
//
// THE QUANTITY IS ARRIVALS, NOT PREDECESSORS. A FALL-THROUGH switch arm is the difference:
// `case 2: r++; case 1: r++;` gives case 1's body two predecessors — the dispatch's `beq`, and
// case 2's body running on — for a reason that has nothing to do with a chain of conditions.
// Sinking there tail-duplicates the switch's SHARED RETURN into all five of its paths, which agbcc
// then constant-folds per arm (`synthetic:sw_fall:agbcc`, 5 of its 11 objdiff points).
//
// So one arrival is SUBTRACTED, and only one kind: the previous arm of the same dispatch RUNNING
// ON into this one (`fellInto`). It is subtracted for what it IS, not for what it computed —
// "this pred computed something and ran on" is a proxy for the same intuition, and it refuses the
// shape this pass exists for, where the two arms of `if (a) { … return 0; } if (b) { … return 0; }`
// both compute and both jump to the shared exit (`retsink.test.ts`'s `TWO_ARMS`; five real-tier
// sites have it, `kleod:EntityItemDrop:agbcc` among them).
//
// "THE PREVIOUS ARM OF THE SAME DISPATCH" IS A CLAIM ABOUT A DISPATCH, so this file models one
// (`scrutOf`/`armsOf` below): two arms of two DIFFERENT tests on the SAME scrutinee. A proxy that
// does not name a dispatch is wrong in both directions, and both readings are pinned as fixtures —
// "each is the target of SOME conditional branch" reads the join of an `if` with no `else` as a
// fall-in (`IF_NO_ELSE`), and adding "…and not siblings of the same `cond_br`" still says nothing
// about WHICH dispatch, so `if (a) … if (b) …` on two different values loses its sinking. A
// function with no comparison-tree dispatch has no fall-in to subtract, which is the truth about it.
//
// The two other clauses (`FALL_IN_GATES`): `q` must arrive by an UNCONDITIONAL branch, and it must
// have a BODY. `isBodyless` (ir/core.ts) is the shared spelling of the second — a bodyless arm is
// the record gcc leaves of a decision that RAN OUT (`emit_case_nodes` mints a `b .Ldefault` per
// exhausted subtree), and it arrives rather than falls in; dropping it costs
// `synthetic:llshr:gcc2.7.2kmc` its sinking. Its parameter half is what keeps an EMPTY case arm
// (one op, but it binds the accumulator) on the fall-in side.
//
// AND THE MERGE MUST BELONG TO THAT DISPATCH (`ownedBy`). A fall-through switch can SHARE its
// return with control flow outside itself — a guard's `goto` onto the same `return` — and there
// refusing to sink is exactly wrong: the merge is left standing, Regime-A switch recovery declines
// on it, and if-recovery duplicates the tails anyway. The pred shape alone cannot tell the two
// apart (both present one fell-into arm with two preds); the SCRUTINEE can, because the guard tests
// a different value. `synthetic:sw_fallguard` is the row: MATCH, and diff:6 with the clause dropped.
//
// REGIME SCOPE — the model is `cond_br`-seeded, so it is INERT ON A JUMP TABLE. A `switch_br`
// dispatch's arms are invisible to `armsOf` and `fellInto` never fires there, so on
// `synthetic:sw_jtfall`/`sw_jtfalldesc` the pass behaves as it does where there is no dispatch at
// all. Deliberate: seeding `switch_br` too would move matching rows with no row asking for it. It
// is the second definition of "this arm falls into that one" in the tree — `switch-recover.ts`'s
// `analyzeArmExit` covers both regimes and is not reachable from `raise/` — so whoever builds the
// Regime-B hoist should route both through one recognizer rather than widen the seed here.
//
// This does NOT recover the boolean-VALUE form `return a && b` — that is shortcircuit.ts's job
// (the `logic_and`/`logic_or` connective plus agbcc's `(-b|b)>>31` = `b!=0` normalisation).
import { Block, Fn, Op, Value, defOpMap, isBodyless, mkOp, predecessors, terminator } from '../ir/core';
import { NEGATED_ICMP } from '../ir/opcodes';
import { simplifyTrivialPhis } from '../ir/simplify';
import { type Gate, firstRejection } from '../l3/gates';

/** The fused short-circuit connectives (raise/shortcircuit.ts). A `cond_br` on one of these is the
 *  post-fusion record of the ≥2 conditions that used to reach a shared arm. */
const CONNECTIVES = new Set(['logic_and', 'logic_or']);

/** "`q` is the previous arm of the same dispatch, RUNNING ON into `target`" — the one arrival
 *  `arrivals` subtracts. `dispatches` is already the answer to the hard half (`siblingArms` and
 *  `ownedBy` in `sinkReturns`); the table is a value so each clause can be dropped and the pass
 *  re-run on real input. Every clause is `sound: false` — they trade BYTES, never correctness:
 *  admitting one wrongly spells a correct function the compiler does not re-emit, and refusing one
 *  wrongly does the same in the other direction. */
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
    // A DEFINITION rather than a tuning knob, and the one entry here nothing has been shown to
    // move: a `cond_br` pred did not run on into this block, it chose it, so calling that a
    // fall-in would be wrong about the CFG whatever it did to the bytes.
    id: 'arrives-by-decision',
    why: 'a `cond_br` pred CHOSE this block; that is a decision arriving, never a fall-in',
    sound: false,
    rejects: (c) => {
      const t = terminator(c.q);
      return t?.opcode !== 'br' || t.successors.length !== 1 || t.successors[0].block !== c.target;
    },
  },
  {
    // Paid for by a CORPUS row, not by a unit test: dropping it costs `synthetic:llshr:gcc2.7.2kmc`
    // its sinking, and moves none of this file's fixtures.
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

/** A return merge offered to the CONSTANT-ARM admission of the header. Like `FallInCandidate` the
 *  table is a value, so each clause can be dropped and the pass re-run on real input. */
export interface SelectCandidate {
  /** the unconditional-branch predecessors of the merge */
  readonly brPreds: readonly Block[];
  /** every predecessor of the merge, `brPreds` included */
  readonly preds: readonly Block[];
  /** the block both arms are reached from, when exactly one block reaches both by a `cond_br`
   *  whose two successors ARE the arms — null when the shape is anything else */
  readonly head: Block | null;
  /** the ops defining the values the arms carry in, one per arm per returned operand; `undefined`
   *  where the value has no defining op (a block parameter, or a live-in) */
  readonly carried: readonly (Op | undefined)[];
}

export const SELECT_GATES: readonly Gate<SelectCandidate>[] = [
  {
    // The diamond itself: two distinct arms, each reached only from one head, and that head's
    // `cond_br` choosing between exactly the two of them. A switch's shared return has neither —
    // the arms run on into one another and the dispatch's tests reach it directly — so this
    // admission never overlaps the fall-in machinery above.
    id: 'two-arms-one-head',
    why: 'both arms chosen by ONE `cond_br` and reached from nowhere else — the diamond itself',
    sound: false,
    rejects: (c) => c.head === null,
  },
  {
    // `carried` is read off the two arms, so an arrival that is not an arm carries a value nothing
    // here has judged. A guard branching onto the same `return` hands the merge whatever it was
    // holding — not a constant — and the hoist argument is about ALL of a merge variable's
    // assignments, not two of the three.
    id: 'no-arrival-but-the-arms',
    why: 'a third in-edge carries a value the constant test never saw',
    sound: false,
    rejects: (c) => c.preds.length !== c.brPreds.length,
  },
  {
    // The claim is about a merge VARIABLE, and a void return has none: there is no value for agbcc
    // to hoist above the compare, so nothing says it would not re-emit this shape.
    id: 'a-value-is-returned',
    why: 'a void return carries no merge variable, so the hoist the admission rests on cannot apply',
    sound: false,
    rejects: (c) => c.carried.length === 0,
  },
  {
    id: 'constant-arms',
    why: 'only a constant is unconditionally cheap enough that agbcc hoists it above the compare',
    sound: false,
    rejects: (c) => !c.carried.every((o) => o?.opcode === 'const'),
  },
];

/** The two questions the fall-in clauses ask of the function's comparison-tree dispatches. */
interface DispatchModel {
  /** Is this block part of the dispatch on `s` — either one of its tests, or an arm of one? */
  inDispatch(b: Block, s: Value): boolean;
  /** The scrutinees for which `q` and `target` are arms of two DIFFERENT tests: the dispatches in
   *  which one could be the previous arm of the other. Two successors of ONE `cond_br` — the body
   *  and the join of an `if` with no `else` — share no such scrutinee, which is the whole point. */
  siblingArms(q: Block, target: Block): Value[];
}

/** THE DISPATCH MODEL. A TEST BLOCK ends in a `cond_br` on an integer comparison of exactly one
 *  non-constant value against constants — the SCRUTINEE. Two test blocks belong to the same
 *  dispatch when they test the same scrutinee: `recognizeSwitch`'s own PRE1 ("every test is on the
 *  SAME Value") read at the raise level, without its dominance, purity or interval preconditions —
 *  those decide whether a `switch` can be SPELLED, and this pass only needs to know a decision tree
 *  is there. `NEGATED_ICMP` (ir/opcodes.ts) is the shared spelling of the icmp family, so an
 *  eleventh comparison joins this model for free.
 *
 *  Constant folding is deliberately NOT reproduced (`switch-recover.ts evalConst` folds agbcc's
 *  synthesized immediates): a test whose constant side this cannot see contributes two
 *  non-constant operands and is skipped, which loses a subtraction rather than inventing one.
 *
 *  Built ONCE, before `sinkReturns`' merge loop, and read-only thereafter — nothing in the loop
 *  writes either table, so the merge that is rewritten first sees the same dispatches as the last. */
function dispatchModel(fn: Fn, defs: Map<Value, Op>): DispatchModel {
  const scrutOf = new Map<Block, Value>();
  /** Arms, indexed by the block reached and the scrutinee whose test sent it there — the test
   *  blocks are the value, because a fall-in requires the two arms to come from DIFFERENT tests. */
  const armsOf = new Map<Block, Map<Value, Set<Block>>>();
  for (const b of fn.blocks) {
    const t = terminator(b);
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
  return {
    inDispatch: (b, s) => scrutOf.get(b) === s || !!armsOf.get(b)?.has(s),
    siblingArms: (q, target) => {
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
    },
  };
}

/** Tail-duplicate a return-only merge block into its unconditional-branch predecessors, in the three
 *  shapes the header argues for: a short-circuit chain visible in the CFG, one fused into a
 *  connective, and a two-armed diamond whose arms carry constants. Returns whether anything changed.
 *  A "return-only" block is exactly one `ret` whose operands are all its own block-params, so each
 *  predecessor already carries the returned value as a successor arg. */
export function sinkReturns(
  fn: Fn,
  gates: readonly Gate<FallInCandidate>[] = FALL_IN_GATES,
  selectGates: readonly Gate<SelectCandidate>[] = SELECT_GATES,
): boolean {
  let changed = false;
  const preds = predecessors(fn);
  const defs = defOpMap(fn);
  const { inDispatch, siblingArms } = dispatchModel(fn, defs);
  // WHICH READS NEED `terminator`'s UNDEFINED CASE, which is not "every read of a terminator". The
  // scan over `fn.blocks` can meet a block with no ops at all, and that is the one read the guard
  // is for: `ir/verify.ts` rejects an empty block and `pipeline.ts` verifies before calling this,
  // but `sinkReturns` is exported and its tests build blocks by hand, where a refusal is a better
  // answer than a TypeError. A read over a PREDECESSOR needs none and does not have one —
  // `predecessors` is built from `successorsOf`, which is empty for a block with no terminator, so
  // a bodyless block never appears in anyone's predecessor list. Once a block is known to end in a
  // `br`, the rewrite below indexes its terminator directly.
  const isBrTo = (p: Block, m: Block) => {
    const t = terminator(p);
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
    //       previous arm running on (`fellInto` below).
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
    // this on the scrutinee it tests, so nothing is subtracted and the merge is sunk. `ps`, not
    // `brPreds`: that outside arrival is a `cond_br` (the guard's `bgt`), which never appears in
    // `brPreds`.
    const ownedBy = (s: Value) => ps.every((p) => inDispatch(p, s));
    // `q` FELL INTO `p`: it is the previous arm of the same dispatch, running on. The clauses are
    // `FALL_IN_GATES` above, argued in this file's header; `arrivals` counts every OTHER
    // predecessor. Layout adjacency — `q` sitting immediately above `p`, which is what "fell
    // through" means in the assembly — is NOT a clause: it moves no corpus row, and it would be an
    // unpaid premise about `fn.blocks` still being address order.
    const fellInto = (q: Block, target: Block) =>
      firstRejection(gates, { q, target, dispatches: siblingArms(q, target).filter(ownedBy) }) === null;
    const arrivals = (p: Block) => (preds.get(p) ?? []).filter((q) => !fellInto(q, p)).length;
    // (c) CONSTANT-ARM DIAMOND — the header's compiler fact. `head` is the diamond read backwards:
    // each arm's only predecessor is the same block, and that block's `cond_br` chooses between the
    // two of them. `carried` is what each arm hands the merge, one entry per arm per returned
    // operand, so a pair whose values come in by different edges is judged together.
    const armsMeetAt = (): Block | null => {
      const [x, y] = brPreds;
      if (brPreds.length !== 2 || x === y) {
        return null;
      }
      const [px, py] = [preds.get(x) ?? [], preds.get(y) ?? []];
      if (px.length !== 1 || py.length !== 1 || px[0] !== py[0]) {
        return null;
      }
      const t = terminator(px[0]);
      const succs = t?.opcode === 'cond_br' ? t.successors.map((e) => e.block) : [];
      return succs.length === 2 && succs.includes(x) && succs.includes(y) ? px[0] : null;
    };
    const constantSelect =
      firstRejection(selectGates, {
        brPreds,
        preds: ps,
        head: armsMeetAt(),
        carried: brPreds.flatMap((p) => {
          const args = p.ops[p.ops.length - 1].successors[0].args;
          return ret.operands.map((o) => defs.get(args[m.params.indexOf(o)]));
        }),
      }) === null;
    if (!brPreds.some((p) => arrivals(p) >= 2) && !fusedDiamond && !constantSelect) {
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
