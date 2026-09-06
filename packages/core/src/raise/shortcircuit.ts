// asmlift — short-circuit connective recovery (F-CFG; successor-aware, agbcc-class).
//
// A `&&`/`||` reaches the IR in two shapes, and this module recovers BOTH into the SAME pair of
// opcodes (`logic_and`/`logic_or`) the backend already prints as `&&`/`||`:
//
//   - the VALUE form (`return a && b`) — a diamond whose merge phi is the boolean. That is
//     `recognizeShortCircuit`, described below.
//   - the CONTROL-FLOW form (`if (a || b) X else Y`) — no value at all, just two `cond_br` blocks
//     that share a target. That is `recognizeBranchShortCircuit`, at the bottom of this file.
//
// They are one concept and stay in one file, but they are separate passes because their inputs do
// not overlap: the value form needs the second block to end in `br` carrying a phi argument, the
// branch form needs it to end in `cond_br`.
//
// `return a && b` compiles (agbcc) to a value-producing diamond: `if (a==0) result=0; else result=(b!=0)`,
// where the merge block returns the phi. The structurer lowers that as `if (a==0){v0=0}else{v0=(-b|b)>>31}
// return v0` — which misses, because (1) the merge is a variable, not the `&&` expression, and (2) the
// second operand is agbcc's branchless `(-b|b)>>31` bool-normalisation, not a clean `b != 0`. This module
// recovers the `logic_and`/`logic_or` value so the backend prints `a != 0 && b != 0`, which recompiles to
// the exact diamond. Two passes:
//
//   1. recognizeBoolNormalize — fold `(-x | x) >> 31` (logical) into `x != 0` (icmp_ne). This is agbcc's
//      branchless "is-nonzero", and it is what the short-circuit second operand looks like.
//   2. recognizeShortCircuit — collapse a SIMPLE boolean diamond into one connective. The head H ends
//      `cond_br(cond)[…]`; one edge goes straight to the merge M carrying a boolean CONSTANT 0/1; the other
//      goes to a single-predecessor block B that computes a boolean Vb and `br M(Vb)`. Then the phi is
//      `cond ? const : Vb` (or the mirror), which is a `&&`/`||` of `cond` (or its negation) and `Vb`:
//        head-edge = taken, const 0 → !cond && Vb       head-edge = fall, const 0 →  cond && Vb
//        head-edge = taken, const 1 →  cond || Vb       head-edge = fall, const 1 → !cond || Vb
//      B's (pure) ops are hoisted into H, the phi is replaced by the connective, and H `br M`.
//
// The feeder Vb may be a boolean OP (→ `logic_and`/`logic_or`) or itself a CONSTANT 0/1 (then the diamond
// is just `cond ? 0 : 1` = the condition or its negation, no connective). Because the fold is applied
// ITERATIVELY (a merge with >2 predecessors collapses one diamond at a time, each reducing the pred
// count), a `&&`-CHAIN like `a > 0 && b > 0 && …` — a shared const-0 exit reached from every condition —
// folds bottom-up: the innermost diamond becomes a bare condition, which the next diamond consumes as its
// Vb, and so on. SCOPE: the shared-arm must be reachable as a single-predecessor `br` feeder; the `||`
// form where the const-1 "true" block has TWO predecessors (`return a || b`) is not folded.
// Guards stay conservative: the CONST is exactly 0/1, Vb is a bool op or 0/1 const, and the head condition
// is NEGATABLE whenever the orientation inverts it — an icmp by opcode swap or a `logic_and`/`logic_or` by
// De Morgan, both via `negateCondOps`, which the control-flow form below shares. Any deviation falls
// through untouched (a miss, never a miscompile).
import {
  Block,
  Fn,
  Op,
  Successor,
  Value,
  defOpMap,
  foldWriteOrder,
  forwardingTarget,
  mkOp,
  mkValue,
  predecessors,
  replaceAllUsesWith,
} from '../ir/core';
import { HOIST_UNSAFE_OPS, NEGATED_ICMP } from '../ir/opcodes';
import { T } from '../ir/types';

const BOOL_OPS = new Set([...Object.keys(NEGATED_ICMP), 'logic_and', 'logic_or']);

/** Fold `(-x | x) >> 31` (logical shift) → `x != 0`, in place. agbcc's branchless is-nonzero idiom. */
// NOT exported: it must run before the diamond fold, an ordering only recognizeShortCircuit's
// internal call preserves.
function recognizeBoolNormalize(fn: Fn): boolean {
  let changed = false;
  const defs = defOpMap(fn);
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      if (op.opcode !== 'shr_u' || op.attrs.imm !== 31 || op.operands.length !== 1) {
        continue;
      }
      const orOp = defs.get(op.operands[0]);
      if (!orOp || orOp.opcode !== 'or') {
        continue;
      }
      const [p, q] = orOp.operands; // one operand of the `or` must be `neg` of the other
      const negP = defs.get(p),
        negQ = defs.get(q);
      const x =
        negP?.opcode === 'neg' && negP.operands[0] === q
          ? q
          : negQ?.opcode === 'neg' && negQ.operands[0] === p
            ? p
            : null;
      if (!x) {
        continue;
      }
      const zero = mkValue(T.unk(32));
      const c0 = mkOp('const', { results: [zero], attrs: { value: 0 } });
      const ne = mkOp('icmp_ne', { operands: [x, zero], results: [op.results[0]] }); // reuse the result Value
      b.ops.splice(i, 1, c0, ne);
      defs.set(op.results[0], ne);
      i++; // skip past the inserted icmp_ne
      changed = true;
    }
  }
  return changed;
}

/** Collapse a simple boolean short-circuit diamond into one `logic_and`/`logic_or`, in place. */
export function recognizeShortCircuit(fn: Fn): boolean {
  let changed = recognizeBoolNormalize(fn);
  const term = (b: Block) => b.ops[b.ops.length - 1];
  const constOf = (defs: Map<Value, Op>, v: Value): number | null => {
    const d = defs.get(v);
    return d && d.opcode === 'const' ? (d.attrs.value as number) : null;
  };
  const isBool = (defs: Map<Value, Op>, v: Value): boolean => {
    const d = defs.get(v);
    return !!d && BOOL_OPS.has(d.opcode);
  };

  let progress = true;
  while (progress) {
    progress = false;
    const defs = defOpMap(fn);
    const preds = predecessors(fn);
    outer: for (const m of fn.blocks) {
      if (m.params.length !== 1) {
        continue;
      }
      if ((preds.get(m) ?? []).length < 2) {
        continue;
      }
      // Find a diamond among M's predecessors: a `br` feeder B whose SOLE predecessor H is a cond_br
      // whose two successors are exactly {M, B}. (Per-feeder search — M may have >2 preds in a chain.)
      for (const bfeed of preds.get(m)!) {
        const bt = term(bfeed);
        if (bt.opcode !== 'br' || bt.successors[0]?.block !== m) {
          continue;
        }
        const bp = preds.get(bfeed) ?? [];
        if (bp.length !== 1) {
          continue;
        }
        // The ENTRY block is never a feeder, for the same reason it is never ^g in the branch form
        // below: `predecessors()` walks successor edges only, so an entry block that is also a loop
        // header shows one predecessor while actually running BEFORE it on the first iteration.
        // Hoisting its body then reorders it and deleting it moves `fn.blocks[0]`. Silent — verify,
        // assertResolved and assertDerefsTyped all pass. PRE-EXISTING (this fold predates the branch
        // form and `main` miscompiles the same MIPS input); fixed here because the branch form's
        // note used to assert this one was safe.
        if (bfeed === fn.blocks[0]) {
          continue;
        }
        const h = bp[0];
        const ht = term(h);
        if (ht.opcode !== 'cond_br') {
          continue;
        }
        const [s0, s1] = ht.successors; // [taken, fall]
        const mIsTaken = s0.block === m && s1.block === bfeed;
        const mIsFall = s1.block === m && s0.block === bfeed;
        if (!mIsTaken && !mIsFall) {
          continue;
        } // H's successors must be exactly {M, B}
        const c = constOf(defs, (mIsTaken ? s0 : s1).args[0]); // the H→M edge carries the short-circuit const
        if (c !== 0 && c !== 1) {
          continue;
        }
        const vb = bt.successors[0].args[0]; // the value B carries to M — a bool op or a 0/1 const
        const vbConst = constOf(defs, vb);
        if (vbConst === null && !isBool(defs, vb)) {
          continue;
        } // else `cond ? const : Vb` isn't a connective
        // A const/const diamond is only a (negated) condition, not a constant: `cond?0:1`/`cond?1:0`.
        if (vbConst !== null && !((c === 0 && vbConst === 1) || (c === 1 && vbConst === 0))) {
          continue;
        }
        // Reduce a const/const diamond ONLY in CHAIN context (M has >2 preds — it feeds an outer connective).
        // A STANDALONE boolean-producing diamond (`return a > b`, M has 2 preds) is left as a merge variable:
        // folding it to a bare comparison can LOSE the spelling the compiler emitted (verified: `ult5`
        // regresses), and the branch-sense candidate already spells the merge both ways.
        if (vbConst !== null && preds.get(m)!.length <= 2) {
          continue;
        }
        const cond = ht.operands[0];
        // The head condition must be a C BOOLEAN computed here — a negatable comparison or a
        // `logic_and`/`logic_or`, which is exactly `BOOL_OPS` and exactly the set `negateCondOps`
        // accepts at top level, so a fused connective head still folds. Mere def-existence is NOT
        // the test — `call` declares `results: 1` (ir/opcodes.ts), so `defOpMap` maps a call result
        // like any other — because the const/const reduction below hands `cond` ITSELF on as the
        // merge value (`res = condSide`), replacing a phi that was `cond ? 1 : 0`. A non-boolean
        // head there is a silent WRONG VALUE, not a missed fold: `and(6, 3)` emitted where the
        // program yields 1. The branch form carries no such obligation — its result only ever feeds
        // a `cond_br`, which reads truthiness — which is why this gate lives here and not in the
        // shared helper, whose own result is boolean by construction and so covers the negated case.
        //
        // Instrumented over the 782 benchmark rows under BOTH lift configurations, it refuses
        // NOTHING — every head reaching it is a negatable icmp — while the pass folds 6 value-form
        // diamonds per configuration, 3 of them through the const/const reduction. An invariant's
        // guard, not a filter any row depends on.
        if (!isBool(defs, cond)) {
          continue;
        }

        // The `cond`-side operand is negated iff `cond` guards the short-circuit (taken+0 / fall+1).
        const wantNeg = (c === 0 && mIsTaken) || (c === 1 && mIsFall);
        const before = (op: Op) => h.ops.splice(h.ops.length - 1, 0, op); // insert just before H's terminator
        // B's body is hoisted UNCONDITIONALLY into H (H always executes), so it MUST be side-effect free:
        // a `store`/`astore`/`call` in B's arm would then run even when the short-circuit does NOT take B
        // (e.g. `a && ((*p = x) != 0)` would store even when `a` is false) — a silent miscompile. Pure
        // value ops (arith, loads, icmp) are safe: the structurer inlines them back into the `&&`/`||` RHS
        // expression, where C's own short-circuit re-guards them. Any side effect ⇒ DECLINE the fold — the
        // merge-variable spelling the fall-through leaves is correct (the side effect stays in B's block),
        // just possibly non-matching.
        if (bfeed.ops.slice(0, -1).some((op) => HOIST_UNSAFE_OPS.has(op.opcode))) {
          continue;
        }
        // NEGATABLE only when the orientation actually inverts the head — asked here rather than up
        // with the other head checks, so a fused `logic_and`/`logic_or` head (what the branch form
        // below leaves behind, and what an earlier round of THIS pass leaves behind in a chain) is
        // not refused when nothing needs inverting. `negateCondOps` is the branch form's helper too,
        // so both siblings refuse the same three shapes. Its dominance precondition holds here for a
        // different reason than there: `cond` is ^h's OWN terminator operand, so its whole cone
        // dominates the point `before` splices into.
        //
        // Minted below every other refusal and above the first mutation: a site refused for any
        // other reason pays nothing, and a refusal below the hoist would leave ^h half-rewritten.
        const negation = wantNeg ? negateCondOps(defs, cond, NEGATE_BUDGET) : null;
        if (wantNeg && !negation) {
          continue;
        }
        bfeed.ops.slice(0, -1).forEach(before); // hoist B's pure body (defines Vb; harmless if a dead const)
        foldWriteOrder(fn.writeOrder, bfeed, h); // …and its writes now follow H's (ir/core.ts)
        let condSide = cond;
        if (negation) {
          negation.ops.forEach((op) => before(op));
          condSide = negation.result;
        }
        // Vb const → the phi reduces to the (possibly negated) condition; Vb bool → a && / || connective.
        let res = condSide;
        if (vbConst === null) {
          res = mkValue(T.unk(32));
          before(mkOp(c === 0 ? 'logic_and' : 'logic_or', { operands: [condSide, vb], results: [res] }));
        }
        // If M still has OTHER predecessors after this collapse (a longer chain), keep the phi and feed the
        // recovered value as its incoming arg from H — a later iteration folds the rest. Only when this was
        // the last pair (M drops to a single predecessor) do we retire the phi and rewrite its uses.
        if (preds.get(m)!.length > 2) {
          h.ops[h.ops.length - 1] = mkOp('br', { successors: [{ block: m, args: [res] }] });
        } else {
          h.ops[h.ops.length - 1] = mkOp('br', { successors: [{ block: m, args: [] }] });
          replaceAllUsesWith(fn, m.params[0], res); // the phi becomes the recovered boolean value
          m.params = [];
        }
        fn.blocks = fn.blocks.filter((x) => x !== bfeed);
        changed = true;
        progress = true;
        break outer; // defs/preds are stale after mutation — recompute on the next iteration
      }
    }
  }
  return changed;
}

// ── the CONTROL-FLOW form ───────────────────────────────────────────────────────────────────────
//
// `if (a || b) X else Y` produces no value: it is two `cond_br` blocks that SHARE a target.
//
//     ^h:  cond_br c1, ^X, ^g          <- `a`
//     ^g:  … ; cond_br c2, ^Y, ^X      <- `b`   (sole predecessor ^h)
//
// Nothing in the tower recognizes that today, so the structurer reaches ^X from two arms and
// TAIL-DUPLICATES it — `if (a) X else { if (b') Y else X }`. The duplicate is correct C but it is
// not the C the compiler compiled, and the duplicated tail costs every byte it contains.
//
// The fold rewrites ^h's terminator to one `cond_br` over a connective and drops ^g. Which
// connective, and which successor slot, follows from WHICH of ^h's edges leads to ^g:
//
//   ^g is ^h's FALL   → ^g runs iff !c1, so the SHARED block is taken iff `c1 || cShared`
//                       ⇒ cond_br(logic_or(c1, cShared))[shared, other]
//   ^g is ^h's TAKEN  → ^g runs iff  c1, so the OTHER  block is taken iff `c1 && cOther`
//                       ⇒ cond_br(logic_and(c1, cOther))[other, shared]
//
// where `cShared`/`cOther` is ^g's own condition ORIENTED at that block — ^g's `cond_br` operand
// when it already branches there, otherwise its negation (so ^g's condition must be a negatable
// icmp, exactly as in the value form). Both spellings keep ^h's original successor ORDER for the
// edge that did not change, so the branch sense the frontend read out of the asm is preserved.
//
// REFUSALS (each one a real way this could be wrong, not a hypothetical):
//
//   - ^g is the ENTRY block. `predecessors()` walks successor edges only — it does not model the
//     implicit edge into `fn.blocks[0]` — so an entry block that is ALSO a loop header (its one
//     real predecessor being its own latch) passes the sole-predecessor test below while the whole
//     soundness argument fails for it: on the first iteration ^g runs BEFORE ^h, so hoisting ^g's
//     body into ^h reorders it, and deleting ^g moves the entry to another block entirely. That
//     turns an entry-guarded `while` into a `do…while` whose body runs once unconditionally —
//     silent wrong code, caught by no contract (verify, assertResolved and assertDerefsTyped all
//     pass). MIPS and PPC reach this: only thumb.ts inserts a synthetic preheader that would give
//     the header a second predecessor. `retsink.ts` guards the same way (`fn.blocks[0] !== m`).
//   - ^g has a predecessor other than ^h — folding would delete a block still reachable elsewhere.
//   - ^g has block params — ^h's edge binds them, and dropping the edge drops the binding.
//   - ^h and ^g both test the SAME value against CONSTANTS — that is a comparison-tree `switch`,
//     not a hand-written `||`. switch-recover.ts requires every test's `cond_br` operand to be an
//     `icmp` (its `isCmpOpcode` gate), and a `logic_or` is not one, so folding first PERMANENTLY
//     disqualifies the recovery and a clean `switch (x) { case 1: case 2: … }` degrades to a chain
//     of nested `if`s. The two spellings are mutually exclusive within one raise and BOTH are
//     legitimate C, and which of them the asm rules out depends on the shape: `x == 0 || x == 2`
//     and `switch (x) { case 0: case 2: }` are ONE object only where the switch has a single case
//     group plus `default:` (agbcc 12 instructions each, one md5; IDO 64 bytes each, one md5), and
//     part as soon as there is a second group to balance a dispatch against (agbcc 20 against 16,
//     IDO 80 bytes and different bytes). So this is a DEFAULT rather than a decision: the switch
//     is the more specific recovery and wins the shape here, while
//     `foldTreeOwned` spells the connective instead and the differ referees (rank.ts's
//     `/connective`). ONLY THIS CLAUSE. Its notion of "same scrutinee" is switch-recover.ts's own
//     PRE1 — a NECESSARY condition for recovery, never a sufficient one, so what it refuses is
//     "a switch could not be ruled out here" and it is a proxy too, just a far tighter one than
//     the relayed clause. Priced over the set it REFUSES rather than the set it admits: it fires on
//     6 rows, protects 2 (`pokeemerald:IsStringLengthAtLeast`,
//     `pokeemerald:TrySetCantSelectMoveBattleScript`), and on the other 4 the published winner
//     folds THROUGH it — `kleod:CheckWorldCompletion`'s refused site is `v5 == 3 || v5 == 5` on an
//     ordinary inner-loop counter with no dispatch region near it. It is the axis, not the clause,
//     that keeps those 4. A structural discriminator is L1-visible and would be strictly better —
//     is the shared block the entry of a region with dispatch-shaped in-edges, is the scrutinee
//     defined by the enclosing loop header — and is UNBUILT.
//     The relayed clause below is a different statement (see its own note: a blunt proxy that
//     fires on an ordinary loop counter), it has NO inhabitant anywhere in the benchmark's 923
//     rows, and a candidate born there would carry a `/connective` label for a fold that answers
//     no connective-vs-tree question. It stays absolute.
//   - the shared block was reached through a RELAY, and either test's scrutinee is compared against
//     constants more than once in the function. This one is ABSOLUTE — `foldTreeOwned` does not
//     widen it. Same reason as the bullet above, widened because the reach is: a relay is what
//     agbcc puts on a tree's default edge, so resolving one walks this fold into a dispatch chain,
//     where the sibling that gives the tree away may be neither test in
//     hand — the split node is RELATIONAL and only its children are equalities, which is precisely
//     what the pairwise test cannot see. Without it `sub_807BD88` and `sub_808491C` each lose a
//     `switch` (sa3).
//
//     It is BLUNT, and that is why it is held to the relayed case. The count does not distinguish a
//     dispatch chain from any variable tested against constants at two sites: on `sub_8080AD4` it
//     fires on `v2 > 2` and `v2 != 2` — one ordinary loop counter — and refusing there costs the
//     function its whole decompilation, because the only fold it has is the `do…while` exit. Its
//     notion of "same scrutinee" is SSA-value identity, which is switch-recover.ts's own PRE1, so it
//     cannot refuse a tree that recovery could not have taken either — but it is a proxy for "am I
//     inside a dispatch chain", not a test of it. A direct edge onto a relational split node still
//     escapes: `sub_807F334` folds `x > 1 && x == 2` and loses a `switch` on main and here alike.
//   - BOTH of ^g's edges rejoin the shared block, with NEITHER of them landing on it directly. Then
//     there is no "other" arm and nothing decides which side the connective guards. Only resolution
//     creates this — an edge that arrives directly is preferred exactly so the MIPS divide-guard
//     idiom, whose emptied trap block forwards to the same place, keeps folding as it always has
//     (`af:adds:ido7.1` and the `divv`/`gcd`/`modv` rows).
//   - ^g holds a side effect — its ops move into ^h, which runs UNCONDITIONALLY. A store in `b`
//     would then execute even when `a` already decided the branch. (`a || (*p = 1)`.)
//   - a value defined in ^g is used outside ^g, or used more than once. Then the structurer
//     MATERIALIZES it into a local, which renders as a statement BEFORE the `if` — turning `b`'s
//     conditional computation into an unconditional one. Single-use-and-local is precisely the
//     shape analysis.ts inlines into the connective's right operand, where C's own short-circuit
//     re-guards it. This is what keeps a load in `b` from being hoisted across the guard in `a`.
//   - the two edges into the shared block carry DIFFERENT args. Only one edge survives the fold,
//     so it can only carry one argument list; picking either would silently drop the other path's
//     phi input.
//   - ^g's two successors are the same block, or ^g's condition cannot be NEGATED when the
//     orientation needs negating. `negateCondOps` decides that, over two shapes: a negatable
//     `icmp_*` (the swapped opcode) and a `logic_and`/`logic_or` (De Morgan — the dual connective
//     over recursively negated operands). The connective case is what lets a chain fold past its
//     FIRST level: this pass is iterative, so by the time it tries an outer diamond the inner one is
//     already fused and ^g's condition is a connective, which `NEGATED_ICMP` — a table over
//     comparison opcodes — has no entry for. Refuse it and `a || !(b || c)` stops after one level at
//     all 13 sites this fires on (`synthetic:llcmp:agbcc`, `:gcc2.7.2kmc`, and 11 real agbcc
//     functions in klonoa+sa3); on the two benchmark rows the structurer then tail-duplicates the
//     shared return into both arms. The helper's own refusals — no def, a non-negatable leaf
//     ANYWHERE in the cone (no partial De Morgan), a cone over the node budget — are on the helper.
//
//     De Morgan DUPLICATES leaf comparisons, so a duplicated leaf could gain a second consumer that
//     analysis.ts renders as a statement BEFORE the `if` — the hazard the single-icmp negation
//     always carried. Measured over those 11 BRANCH-form sites: NO site gains a local (one,
//     `sub_80B7CD0`, loses one, 8 → 7) and every site that already decompiled gets SHORTER. Two
//     (`sub_80930B8`, `sub_80932E0`) go from DECLINED to a full decompilation — folding a loop-exit
//     connective removes the back-edge loop recovery was refusing — so they get LONGER (1 → 112 and
//     1 → 55 lines) and are the only sites whose local count rises at all, 0 → 22 and 0 → 7. A
//     decompilation appearing, not a leaf escaping.
//
//     That number is SCOPED to this fold and does not carry to the value form, which shares the
//     helper but no use-count condition: `definedValuesStayLocal` (bottom of this file)
//     independently forbids a ^g-defined value with a second consumer HERE, while the value form
//     relies on the original cone dying to the pass list's own `dce: true`. There is nothing to
//     transfer the number to yet either — instrumenting the value form over the 782 benchmark rows
//     under both lift configurations counts 6 folds per configuration, every head a single icmp.
//
//     The `/connective` LIFT AXIS is a separate question from the default lift, and is unwidened:
//     `onTreeOwned` below is what tells rank.ts the axis exists for a row, and this check sits ABOVE
//     it. Over all 999 benchmark rows under BOTH configurations rank.ts lifts with (`foldTreeOwned`
//     false and true), against the same rows with the connective case ablated: the recovered IR
//     moves on the same 2 rows under each, `onTreeOwned` fires on the same rows either way, and
//     nothing new throws.
//
// Every refusal falls through untouched, leaving the tail-duplicated spelling — a miss, never a
// miscompile. Applied ITERATIVELY, so `a || b || c` folds left-to-right, each round consuming one
// more condition block.
//
// WHICH SPELLING, and why the fold alone does not decide it. `if (a && b) X else Y` and its dual
// `if (!a || !b) Y else X` are the same program and NOT the same bytes — agbcc lays the arms out in
// source order, so which was written is recorded in the branch senses. This rewrite keeps ^h's
// unchanged successor slot, so the connective comes out in the orientation those senses spell, and
// which of the two that is depends on the branch RANGE below, not on the source. Reaching the
// other is `negateCond`'s job (l3/ast.ts distributes `!(a && b)`), and rank.ts's `/flip-join` axis
// is what asks for it on a RECONVERGING if — the default spells the layout reading and the axis
// spells its dual, so both orientations are compiled and the differ picks (synthetic:ifand_near
// matches at the default, synthetic:ifor_near on the axis).
//
// What neither reaches is the MIXED spelling. `negateJoinedBranchSense` is a per-FUNCTION boolean,
// so the axis negates every joined `if` at once — and of the 28 real rows carrying the
// `short-circuit` tag, 16 hold two or more TWO-ARMED ifs (counted by `else`, which is what the
// axis's own `thenS.length && elseS.length` gate needs) and 12 hold two or more conditions
// carrying a connective. An earlier version of this comment said 22, which is the count of `if (`
// of ANY kind — one-armed ifs included, and both sense booleans exclude those by construction.
// A per-SITE negation is the open lever; a gate on whether to ENUMERATE the axis does not reach
// it, and removes a spelling the differ would referee.
//
// The De Morgan negation below forecloses a third spelling, at a measured price: it DISTRIBUTES, so
// the leaves come out negated (`a || (!b && !c)`) and `a || !(b || c)` has no
// candidate — the IR has no `logic_not` to build one from (ir/opcodes.ts). Compiled both ways on
// the `a || (b && c)` guard shape at agbcc's default flags, the two source spellings assemble to
// the same bytes (12/12 rows, score 0), so the foreclosure costs nothing here. A shape that ever
// separated them would be a new axis, not a bug in this fold.
//
// WHICH slot ^g lands in is decided by the asm's branch POLARITY, and on Thumb the branch RANGE
// decides the polarity — so the same source `&&` reaches this pass two different ways:
//
//   short branch   `beq shared`         ^g is ^h's FALL  → logic_or  → arms swapped (the miss)
//   long branch    `bne ^g / b shared`  ^g is ^h's TAKEN → logic_and → source orientation
//
// agbcc inverts a conditional it cannot reach, so past ±256 bytes it emits the second form, and the
// trampoline it leaves on the `b` sits on the edge into the SHARED block — which `forwardingTarget`
// (ir/core.ts) looks through. Only that edge needs it: the INVERTED branch is the one that still
// reaches, so `bne ^g` always arrives at ^g directly and no relay can sit between them. The
// `logic_and` half is the one that lands on the source's own orientation; it is the `logic_or` half
// that has no dual candidate (synthetic:ifand_near:agbcc).
//
// `gIsFall` IS NOT THE CARRIER FOR A PER-SITE SENSE, and that was measured rather than argued. It
// reads the branch RANGE, exactly as the table above says — so in any function small enough for
// every branch to be short it is the SAME at every site, including sites whose sources wrote
// opposite connectives. Instrumented at the fold and run through the bench: a two-site row whose
// first site wrote `&&` and whose second wrote its dual reads `gIsFall=true` at BOTH
// (`synthetic:joinsense`), and a four-site ladder row with two sites inverted in the source reads
// `true` at all four (`synthetic:mixsense`). The positive control reads the other way —
// `synthetic:ifand_far`, the long-branch row, gives `false` against
// `synthetic:ifand_near`'s `true`. So carrying this boolean to L3
// as a node stamp (the `#144` `Expr.baseOrdered` shape) would hand every site of such a function
// one answer and reach exactly the two configurations `negateJoinedBranchSense` already reaches.
//
// Every refusal falls through untouched — a miss, never a miscompile.
/** Per-call options for `recognizeBranchShortCircuit` — the tree-ownership refusal's two ends. */
export interface BranchShortCircuitOptions {
  /** Take the fold at a site the PAIRWISE comparison-tree refusal owns, spelling the connective
   *  where the default leaves the tree for switch-recover.ts. rank.ts's `/connective` axis; see the
   *  REFUSALS note. It widens the SHAPE the fold accepts and nothing about what the fold may move —
   *  every other refusal still applies, the RELAYED clause included.
   *
   *  A NEW REFUSAL CONDITION, stated because it is one: this is per-FUNCTION and the question is
   *  per-SITE. Every tree-owned site in a function flips together, so a function with two of them
   *  wanting OPPOSITE spellings has no candidate that spells the mix, and nothing reports the gap.
   *  A per-FUNCTION predicate cannot decide a per-SITE question — the same shape the joined-if
   *  default hit — and here it costs completeness rather than correctness. The alternative is a
   *  fork per site: `kleod:CheckWorldCompletion` refuses at 10 and goes 96 → 192 candidates as one
   *  boolean, where a per-site fork would be 1024×. That is why the boolean, not an oversight. */
  foldTreeOwned?: boolean;
  /** Called at each site the pairwise tree-ownership refusal is the ONE thing stopping the fold —
   *  how rank.ts learns the axis has an inhabitant here without re-running the matcher. Asked LAST,
   *  after `sameArgs` and the negatability check, so a report means a `/connective` candidate that
   *  differs from its sibling: reporting a refusal merely REACHED would double the row's whole
   *  candidate cross for a lift that produces duplicates the dedup collapses. (Its sibling gate
   *  `hasSetupArgsNarrowing` asks the same question the same way — does the lever CHANGE anything.)
   *  The pass re-scans after every rewrite, so one site can report more than once; read it as a
   *  boolean. */
  onTreeOwned?: () => void;
}

export function recognizeBranchShortCircuit(fn: Fn, opts: BranchShortCircuitOptions = {}): boolean {
  let changed = false;
  const term = (b: Block) => b.ops[b.ops.length - 1];
  let progress = true;
  while (progress) {
    progress = false;
    const defs = defOpMap(fn);
    const preds = predecessors(fn);
    outer: for (const h of fn.blocks) {
      const ht = term(h);
      if (ht.opcode !== 'cond_br') {
        continue;
      }
      const [taken, fall] = ht.successors;
      // Try ^g = the fall edge, then ^g = the taken edge. `gIsFall` picks the connective.
      for (const gIsFall of [true, false]) {
        const gEdge = gIsFall ? fall : taken;
        const sharedFromH = gIsFall ? taken : fall;
        const g = gEdge.block;
        if (g === h || g === sharedFromH.block || g.params.length > 0) {
          continue;
        }
        // The ENTRY block is never ^g — see the REFUSALS note. `predecessors()` cannot see the
        // implicit entry edge, so this is the only thing standing between an entry-block loop
        // header and a silently reordered function body.
        if (g === fn.blocks[0]) {
          continue;
        }
        if ((preds.get(g) ?? []).length !== 1) {
          continue;
        }
        const gt = term(g);
        if (gt.opcode !== 'cond_br') {
          continue;
        }
        const [gTaken, gFall] = gt.successors;
        if (gTaken.block === gFall.block) {
          continue;
        }
        // ^g's body must be pure, and every value it defines must be consumed only by ^g itself —
        // see the REFUSALS note: an escaping or reused value becomes a statement hoisted out of the
        // short circuit.
        // HOIST_UNSAFE_OPS includes `opaque`: an instruction asmlift could not model, and moving it
        // out of the arm that guards it is the reordering this refuses. Loud either way today — a
        // decline under `onGap: 'strict'`, an ASMLIFT_ERROR marker under `annotate`.
        const body = g.ops.slice(0, -1);
        if (body.some((op) => HOIST_UNSAFE_OPS.has(op.opcode))) {
          continue;
        }
        if (!definedValuesStayLocal(fn, g)) {
          continue;
        }
        // Which of ^g's edges rejoins ^h's other successor? That is the shared block. A DIRECT edge
        // wins, so resolution only ever adds reach — it never re-picks an edge this fold already had.
        const sharedTarget = forwardingTarget(sharedFromH.block);
        const rejoins = (e: Successor): boolean => forwardingTarget(e.block) === sharedTarget;
        const direct = gTaken.block === sharedFromH.block ? gTaken : gFall.block === sharedFromH.block ? gFall : null;
        // With neither edge direct, both may resolve onto the shared block — and then there is no
        // "other" arm left and nothing decides which side the connective guards.
        if (direct === null && rejoins(gTaken) && rejoins(gFall)) {
          continue;
        }
        const sharedEdge = direct ?? (rejoins(gTaken) ? gTaken : rejoins(gFall) ? gFall : null);
        if (!sharedEdge) {
          continue;
        }
        // A comparison TREE over one scrutinee belongs to switch recovery, not to this fold. A relay
        // is what agbcc puts on a tree's default edge, so a shared block reached through one is
        // searched function-wide; a direct edge keeps the pairwise test. See the REFUSALS note —
        // the wider test is blunt, and that is why it is not asked everywhere.
        const throughRelay = sharedEdge.block !== sharedFromH.block;
        if (
          throughRelay &&
          (inComparisonTree(fn, defs, ht.operands[0]) || inComparisonTree(fn, defs, gt.operands[0]))
        ) {
          continue; // the relayed clause is absolute — `foldTreeOwned` does not widen it
        }
        const treeOwned = !throughRelay && sameScrutineeConstTests(defs, ht.operands[0], gt.operands[0]);
        const otherEdge = sharedEdge === gTaken ? gFall : gTaken;
        if (!sameArgs(sharedFromH.args, sharedEdge.args)) {
          continue;
        }
        // The second operand, oriented at the block whose slot it decides: `logic_or` asks "does ^g
        // reach the SHARED block", `logic_and` asks "does ^g reach the OTHER block".
        const wantEdge = gIsFall ? sharedEdge : otherEdge;
        const c2 = gt.operands[0];
        // ^g's condition may itself be a CONNECTIVE — the fold is iterative, so an inner diamond is
        // already fused by the time the outer one is tried, and negating one is De Morgan rather
        // than an opcode swap. `negateCondOps` does both, and returns null on anything else.
        const negation = wantEdge !== gTaken ? negateCondOps(defs, c2, NEGATE_BUDGET) : null;
        if (wantEdge !== gTaken && !negation) {
          continue;
        }
        // LAST refusal, so `onTreeOwned` reports a site where tree ownership is the ONE thing in the
        // way — which is why the negatability check stays above it even though it MINTS the negated
        // cone (up to NEGATE_BUDGET ops) and discards it whenever this gate refuses. That discard is
        // free rather than merely cheap: `mkValue` is `{ type }` with no identity counter
        // (ir/core.ts) and nothing is spliced until below, so a site refused here leaves the CFG
        // byte-identical. See the option's doc for why the position is the gate's meaning.
        if (treeOwned) {
          opts.onTreeOwned?.();
          if (!opts.foldTreeOwned) {
            continue;
          }
        }
        const second = negation ? negation.result : c2;
        const negated: Op[] = negation ? negation.ops : [];
        const res = mkValue(T.unk(32));
        const connective = mkOp(gIsFall ? 'logic_or' : 'logic_and', {
          operands: [ht.operands[0], second],
          results: [res],
        });
        // ^g's body moves ahead of ^h's terminator; ^h keeps the successor SLOT that did not change
        // (taken=shared for `||`, taken=other for `&&`), so the frontend's branch sense survives.
        h.ops.splice(h.ops.length - 1, 1, ...body, ...negated, connective, {
          ...mkOp('cond_br', { operands: [res] }),
          successors: gIsFall
            ? [
                { block: sharedEdge.block, args: [...sharedEdge.args] },
                { block: otherEdge.block, args: [...otherEdge.args] },
              ]
            : [
                { block: otherEdge.block, args: [...otherEdge.args] },
                { block: sharedEdge.block, args: [...sharedEdge.args] },
              ],
        });
        foldWriteOrder(fn.writeOrder, g, h); // ^g's writes now follow ^h's own (ir/core.ts)
        fn.blocks = fn.blocks.filter((x) => x !== g);
        // ^h's old shared edge is gone, so the relay it pointed at may have become unreachable —
        // and once that link goes, so may the next, all the way down the chain. `dominators`
        // (ir/core.ts) gives a block with no in-edges only ITSELF, which empties the intersection at
        // everything it still branches to, so a half-dropped chain declines two passes later with a
        // def-does-not-dominate-use out of `verify`.
        //
        // REACHABILITY, not predecessor count: in-edges from blocks that are themselves unreachable
        // leave a block just as orphaned, and the thumb frontend does hand over unreachable blocks
        // (see raise/gvn.ts). Only relays are dropped — the chain ends at the first block that does
        // real work, and that one stays whatever its in-edges look like.
        for (let link = sharedFromH.block; link.ops.length === 1 && link.ops[0].opcode === 'br';) {
          const dead = link;
          if (dead === fn.blocks[0] || reachableBlocks(fn).has(dead)) {
            break;
          }
          link = dead.ops[0].successors[0].block;
          fn.blocks = fn.blocks.filter((x) => x !== dead);
        }
        changed = true;
        progress = true;
        break outer; // defs/preds are stale after the mutation — recompute on the next round
      }
    }
  }
  return changed;
}

/** How many ops `negateCondOps` may KEEP for one negation. De Morgan rebuilds the cone PER PATH and
 *  shares nothing — deliberately, see the helper's note — so a fold's cost is linear in the cone's
 *  nodes and this is the cheap stop on it.
 *
 *  What 8 decides, said as the shape rather than as headroom, because "8" reads like more room than
 *  it is. A negation mints one op per cone node and a binary expansion has leaves = internal + 1, so
 *  a minted count is always ODD: 1, 3, 5, 7, 9. At 8 a FOUR-clause inner conjunct (7 ops) folds and
 *  a FIVE-clause one (9 ops) does not; 7 and 8 are therefore one gate, and so is 9 over everything
 *  measured here, the deepest cone in the 2,047 lifted klonoa+sa3 functions minting 5 (17
 *  connective negations, 0 refused). Clause COUNT is not the axis either: a FLAT `a || b || c || …`
 *  chain pays nothing at all, because ^g's condition is never a connective in that shape.
 *
 *  The bound is on ops KEPT, and the frontier is a NODE COUNT — not a shape. Measured EXHAUSTIVELY
 *  against this helper rather than sampled: a cone is accepted iff its node count is `<= budget`,
 *  over all 82,500 binary cone shapes up to 23 nodes at budget 8, and over all 23,714 up to 21 nodes
 *  at every budget from 1 to 10. Shape decides only WHICH guard refuses and how many ops had been
 *  minted when it did, neither of them visible to a caller — at budget 8 a 15-node cone is caught by
 *  the ENTRY guard at 9 (left chain) or 8 (balanced cone) or by the POST-check at 15 (right chain).
 *  Because `go` pushes a parent only after its children, a refused walk transiently mints more than
 *  the budget before unwinding — `2 * budget - 1` at the worst shape, that right chain, at every
 *  budget measured. Bounded, and nothing escapes it.
 *
 *  A refusal here is SILENT, unlike the `onTreeOwned` gate above which exists so a sweep need not
 *  re-instrument. So raising this constant is not free advice: finding a corpus site that wants it
 *  means patching a hook back into this file. No callback is added because no consumer has asked for
 *  one; the tests below pin both sides of the frontier instead. */
const NEGATE_BUDGET = 8;

/** The ops computing `!v`, or `null` when `v` cannot be negated.
 *
 *  Two cases, and no third:
 *    - an `icmp_*` in `NEGATED_ICMP` → the swapped-opcode comparison over the SAME operands.
 *    - a `logic_and`/`logic_or` → the DUAL connective over its two recursively negated operands.
 *      De Morgan: `!(a || b)` is `!a && !b`. This is the only reason the helper is recursive, and
 *      it is what lets a chain fold past its first level (`a || !(b || c)`).
 *
 *  REFUSALS — each returns `null`, which the caller turns into its existing `continue`, so the CFG
 *  is left exactly as it was and the structurer emits today's tail-duplicated spelling. A bytes
 *  miss, never a wrong answer:
 *    - the value has no def in this function, which means a block param — a call RESULT has one,
 *      `call` declaring `results: 1` (ir/opcodes.ts), and is refused by the next bullet instead;
 *    - the def is neither a negatable icmp nor a connective (a call, any arithmetic) — there is no
 *      sound inverse to build, and `!x` as `x == 0` is a DIFFERENT spelling, not this fold's
 *      business;
 *    - ANY leaf anywhere in the cone is non-negatable ⇒ the WHOLE negation is refused. Half a
 *      De Morgan is not a conservative approximation of one;
 *    - the cone exceeds `NEGATE_BUDGET` minted ops.
 *
 *  Ops are MINTED, never mutated: the originals stay where the caller hoisted them and die to the
 *  pass list's own `dce: true` (raise/pre-recovery.ts). Only `icmp_*`/`logic_and`/`logic_or` are
 *  ever rebuilt, all of them pure, so no effect can be duplicated or reordered by construction.
 *
 *  Nothing is SHARED between paths, and that is the point rather than a limitation. Memoizing `go`
 *  in a `Map<Value, Value>` is three lines and would make the budget unnecessary — and it would
 *  create exactly the hazard this fold exists to remove: a shared negated sub-condition has two
 *  consumers, and analysis.ts renders a value with two consumers as a statement BEFORE the `if`.
 *  Nothing collapses the duplicates later either — `numberPureValues` runs as `addrnum`, far ahead
 *  of both folds. So the per-path rebuild is the mechanism and NEGATE_BUDGET is its price.
 *
 *  What it GUARANTEES about its result, which one caller leans on: every op it mints is an `icmp_*`
 *  or a `logic_and`/`logic_or`, so the returned value is always a C boolean. The value form hands an
 *  un-negated head straight on as the merge VALUE, which is why that caller checks booleanness for
 *  itself before deciding whether to call here at all (see its head gate); the branch form needs no
 *  such check, because its result only ever feeds a `cond_br`.
 *
 *  PRECONDITION, earned by the caller and not checked here: every value in the cone must dominate
 *  the point the caller splices `ops` into — the minted comparisons reuse the ORIGINAL leaf
 *  operands. The branch fold gets it free from ^g's single-predecessor gate: with ^h ^g's only
 *  predecessor, every def in the cone either sits in ^g's body (spliced in ahead of these ops) or
 *  dominates ^h. A caller without that invariant emits a def that does not dominate its use — loud
 *  at `verify`, but this helper does not look.
 *
 *  It stays in this file rather than joining `NEGATED_ICMP` in ir/opcodes.ts: that table is a fact
 *  about opcodes, this MINTS ops, and both consumers are the two folds above — the value form and
 *  the branch form, which is the whole reason it is a helper and not inline. */
function negateCondOps(defs: Map<Value, Op>, v: Value, budget: number): { ops: Op[]; result: Value } | null {
  const ops: Op[] = [];
  const go = (x: Value): Value | null => {
    if (ops.length >= budget) {
      return null;
    }
    const d = defs.get(x);
    if (!d) {
      return null;
    }
    const out = mkValue(T.unk(32));
    if (NEGATED_ICMP[d.opcode]) {
      ops.push(mkOp(NEGATED_ICMP[d.opcode], { operands: [...d.operands], results: [out] }));
      return out;
    }
    if (d.opcode === 'logic_and' || d.opcode === 'logic_or') {
      const a = go(d.operands[0]);
      if (a === null) {
        return null;
      }
      const b = go(d.operands[1]);
      if (b === null) {
        return null;
      }
      // Operands are pushed BEFORE the connective, so the op list is already in dominating order.
      ops.push(mkOp(d.opcode === 'logic_and' ? 'logic_or' : 'logic_and', { operands: [a, b], results: [out] }));
      return out;
    }
    return null;
  };
  const result = go(v);
  return result === null || ops.length > budget ? null : { ops, result };
}

/** Blocks reachable from the entry, following successor edges. */
function reachableBlocks(fn: Fn): Set<Block> {
  const seen = new Set<Block>([fn.blocks[0]]);
  const queue = [fn.blocks[0]];
  for (let i = 0; i < queue.length; i++) {
    for (const succ of queue[i].ops[queue[i].ops.length - 1]?.successors ?? []) {
      if (!seen.has(succ.block)) {
        seen.add(succ.block);
        queue.push(succ.block);
      }
    }
  }
  return seen;
}

/** Do `c1` and `c2` compare the SAME value against CONSTANTS? The signature of a comparison-tree
 *  `switch`, which switch-recover.ts owns — see the REFUSALS note. Equality tests only: a switch
 *  dispatches on `==`/`!=`, while a RELATIONAL pair (`x >= lo && x <= hi`, the range check) is a
 *  genuine connective this fold should still take. */
function sameScrutineeConstTests(defs: Map<Value, Op>, c1: Value, c2: Value): boolean {
  const s1 = constTestScrutinee(defs, c1);
  const isEq = (v: Value): boolean => {
    const op = defs.get(v)?.opcode;
    return op === 'icmp_eq' || op === 'icmp_ne';
  };
  return s1 !== null && s1 === constTestScrutinee(defs, c2) && isEq(c1) && isEq(c2);
}

/** Is `c`'s scrutinee compared against constants by MORE THAN ONE `cond_br` in the function?
 *
 *  The function-wide question, for the case where the shared block was reached through a relay. A
 *  tree's split node is RELATIONAL and its children are equalities (`if (x > 10) { if (x == 20) }`),
 *  so the two tests in hand need not look alike, and the one that would give the tree away may be
 *  neither of them. Counting every constant test on the scrutinee catches the split either way. */
function inComparisonTree(fn: Fn, defs: Map<Value, Op>, c: Value): boolean {
  const scrutinee = constTestScrutinee(defs, c);
  if (scrutinee === null) {
    return false;
  }
  let seen = 0;
  for (const b of fn.blocks) {
    const t = b.ops[b.ops.length - 1];
    if (t?.opcode === 'cond_br' && constTestScrutinee(defs, t.operands[0]) === scrutinee && ++seen > 1) {
      return true;
    }
  }
  return false;
}

/** The value an `icmp_* <value>, <const>` tests, or null when `c` is not one. */
function constTestScrutinee(defs: Map<Value, Op>, c: Value): Value | null {
  const d = defs.get(c);
  if (!d || NEGATED_ICMP[d.opcode] === undefined) {
    return null;
  }
  const [x, y] = d.operands;
  const xc = defs.get(x)?.opcode === 'const';
  const yc = defs.get(y)?.opcode === 'const';
  // exactly one side constant — `x == y` between two variables is no switch test
  return xc === yc ? null : xc ? y : x;
}

/** True when every value `g` defines is read at most once, and any read is inside `g`.
 *
 *  The VALUE form above needs no such check, and the asymmetry is real rather than drift: its feeder
 *  ends in `br M`, so the feeder has no successor of its own to dominate and every value it defines
 *  is either read in the feeder or carried to `M` as the phi argument the fold consumes. Here ^g
 *  ends in `cond_br` and its `other` successor IS ^g-dominated, so a ^g-defined value genuinely can
 *  escape, and only this check stops it.
 *
 *  An earlier version of this note justified the asymmetry by "the feeder dominates nothing but
 *  itself because M has 2+ predecessors", and told the reader not to unify the guards. That was
 *  WRONG — the entry block dominates every block whatever M's predecessor count — and it was wrong
 *  about the one guard the two folds genuinely DO share, the `fn.blocks[0]` refusal, which the value
 *  form was missing entirely. Both now have it. When changing either fold, check the other. */
function definedValuesStayLocal(fn: Fn, g: Block): boolean {
  const defined = new Set<Value>(g.ops.flatMap((op) => op.results));
  if (defined.size === 0) {
    return true;
  }
  const uses = new Map<Value, number>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const v of [...op.operands, ...op.successors.flatMap((s) => s.args)]) {
        if (!defined.has(v)) {
          continue;
        }
        if (b !== g) {
          return false; // escapes ^g — the structurer would render it before the `if`
        }
        uses.set(v, (uses.get(v) ?? 0) + 1);
      }
    }
  }
  // ZERO uses is fine — a dead op renders nothing at all, so it cannot escape the short circuit.
  // TWO or more is not: analysis.ts materializes a multi-consumer value into a local, which is a
  // statement, and a statement lands before the `if`.
  return [...defined].every((v) => (uses.get(v) ?? 0) <= 1);
}

/** Two successor argument lists that a fold may collapse into one: same values, same order. */
function sameArgs(a: Value[], b: Value[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
