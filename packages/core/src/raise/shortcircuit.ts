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
// Guards stay conservative: the CONST is exactly 0/1, Vb is a bool op or 0/1 const, the head condition is a
// negatable icmp, and any deviation falls through untouched (a miss, never a miscompile).
import { Block, Fn, Op, Value, defOpMap, mkOp, mkValue, predecessors, replaceAllUsesWith } from '../ir/core';
import type { Opcode } from '../ir/opcodes';
import { EFFECTFUL_OPS } from '../ir/opcodes';
import { T } from '../ir/types';

const NEGATE_ICMP: Record<string, Opcode> = {
  icmp_eq: 'icmp_ne',
  icmp_ne: 'icmp_eq',
  icmp_slt: 'icmp_sge',
  icmp_sge: 'icmp_slt',
  icmp_sgt: 'icmp_sle',
  icmp_sle: 'icmp_sgt',
  icmp_ult: 'icmp_uge',
  icmp_uge: 'icmp_ult',
  icmp_ugt: 'icmp_ule',
  icmp_ule: 'icmp_ugt',
};
const BOOL_OPS = new Set([...Object.keys(NEGATE_ICMP), 'logic_and', 'logic_or']);
// Ops with an observable side effect — unsafe to HOIST out of a short-circuit's conditional arm
// (they would run unconditionally). Derived from the ONE effect table in ir/opcodes.ts.
const SIDE_EFFECT = EFFECTFUL_OPS;

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
        const condDef = defs.get(cond);
        if (!condDef || !NEGATE_ICMP[condDef.opcode]) {
          continue;
        } // head condition must be a negatable icmp

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
        if (bfeed.ops.slice(0, -1).some((op) => SIDE_EFFECT.has(op.opcode))) {
          continue;
        }
        bfeed.ops.slice(0, -1).forEach(before); // hoist B's pure body (defines Vb; harmless if a dead const)
        let condSide = cond;
        if (wantNeg) {
          condSide = mkValue(T.unk(32));
          before(mkOp(NEGATE_ICMP[condDef.opcode], { operands: [...condDef.operands], results: [condSide] }));
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
//     of nested `if`s. The switch is the better recovery and it is the more specific one, so it
//     wins the shape. Cost: a genuine source-level `x == 1 || x == 2` that is NOT part of a wider
//     tree also declines — the same conservative trade loops.ts makes when it refuses to infer a
//     header from `cond_br` shape.
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
//   - ^g's two successors are the same block, or ^g's condition is not a negatable icmp when the
//     orientation needs negating.
//
// Every refusal falls through untouched, leaving the tail-duplicated spelling — a miss, never a
// miscompile. Applied ITERATIVELY, so `a || b || c` folds left-to-right, each round consuming one
// more condition block.
export function recognizeBranchShortCircuit(fn: Fn): boolean {
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
        // A comparison TREE over one scrutinee belongs to switch recovery, not to this fold.
        if (sameScrutineeConstTests(defs, ht.operands[0], gt.operands[0])) {
          continue;
        }
        // ^g's body must be pure, and every value it defines must be consumed only by ^g itself —
        // see the REFUSALS note: an escaping or reused value becomes a statement hoisted out of the
        // short circuit.
        const body = g.ops.slice(0, -1);
        if (body.some((op) => HOIST_UNSAFE.has(op.opcode))) {
          continue;
        }
        if (!definedValuesStayLocal(fn, g)) {
          continue;
        }
        // Which of ^g's edges rejoins ^h's other successor? That is the shared block.
        const sharedEdge =
          gTaken.block === sharedFromH.block ? gTaken : gFall.block === sharedFromH.block ? gFall : null;
        if (!sharedEdge) {
          continue;
        }
        const otherEdge = sharedEdge === gTaken ? gFall : gTaken;
        if (!sameArgs(sharedFromH.args, sharedEdge.args)) {
          continue;
        }
        // The second operand, oriented at the block whose slot it decides: `logic_or` asks "does ^g
        // reach the SHARED block", `logic_and` asks "does ^g reach the OTHER block".
        const wantEdge = gIsFall ? sharedEdge : otherEdge;
        const c2 = gt.operands[0];
        const c2Def = defs.get(c2);
        let second = c2;
        const negated: Op[] = [];
        if (wantEdge !== gTaken) {
          if (!c2Def || !NEGATE_ICMP[c2Def.opcode]) {
            continue;
          }
          second = mkValue(T.unk(32));
          negated.push(mkOp(NEGATE_ICMP[c2Def.opcode], { operands: [...c2Def.operands], results: [second] }));
        }
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
        fn.blocks = fn.blocks.filter((x) => x !== g);
        changed = true;
        progress = true;
        break outer; // defs/preds are stale after the mutation — recompute on the next round
      }
    }
  }
  return changed;
}

// What may NOT move out of a conditional arm into the unconditionally-executed head.
//
// `EFFECTFUL_OPS` is the declared-effects table, and it does not include `opaque` — but
// analysis.ts puts `opaque` in its memory-write set and treats it as a render barrier, so the two
// effect models disagree. This fold takes the STRICTER of the two: an `opaque` is an instruction
// asmlift could not model, and hoisting one out of the arm that guards it is exactly the reordering
// this gate exists to refuse. (Not exploitable today — a live `opaque` declines at
// `assertResolved` either way — so this is closing the model gap, not fixing an observed bug.)
const HOIST_UNSAFE: ReadonlySet<string> = new Set([...SIDE_EFFECT, 'opaque']);

/** Do `c1` and `c2` compare the SAME value against CONSTANTS? That is the signature of a
 *  comparison-tree `switch`, which switch-recover.ts owns — see the REFUSALS note. Equality tests
 *  only: a switch tree dispatches on `==`/`!=`, while a RELATIONAL pair (`x >= lo && x <= hi`, the
 *  range check) is a genuine connective this fold should still take. */
function sameScrutineeConstTests(defs: Map<Value, Op>, c1: Value, c2: Value): boolean {
  const eqTest = (v: Value): { scrutinee: Value } | null => {
    const d = defs.get(v);
    if (!d || (d.opcode !== 'icmp_eq' && d.opcode !== 'icmp_ne')) {
      return null;
    }
    const [x, y] = d.operands;
    const xc = defs.get(x)?.opcode === 'const';
    const yc = defs.get(y)?.opcode === 'const';
    // exactly one side constant — `x == y` between two variables is no switch test
    return xc === yc ? null : { scrutinee: xc ? y : x };
  };
  const a = eqTest(c1);
  const b = eqTest(c2);
  return a !== null && b !== null && a.scrutinee === b.scrutinee;
}

/** True when every value `g` defines is read at most once, and any read is inside `g`.
 *
 *  The VALUE form above needs no such check, and the asymmetry is deliberate rather than drift: its
 *  feeder block ends in `br M` where `M` has 2+ predecessors, so the feeder dominates nothing but
 *  itself and no value it defines can be read anywhere else. Here ^g ends in `cond_br`, and the
 *  `other` successor IS dominated by ^g — so a ^g-defined value genuinely can escape, and only this
 *  check stops it. Do not "unify" the two guards. */
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
