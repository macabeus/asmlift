// asmlift — boolean-value short-circuit recovery (F-CFG; successor-aware, agbcc-class).
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
