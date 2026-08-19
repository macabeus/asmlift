// asmlift — signed division by a power of two, in its BRANCHING form.
//
// `x / 2^k` must round toward zero, but an arithmetic right shift rounds toward minus infinity, so a
// compiler biases the dividend by `2^k - 1` when it is negative. Two lowerings exist, and asmlift
// already folded one of them: the branchless `(x + (x >>u 31)) >> 1` that agbcc and GCC emit for
// `/2` is the SDIV_POW2_2 idiom pattern (pattern/engine.ts). The other is a BRANCH — what IDO emits,
// and what GCC emits for larger k:
//
//	bgez	a0, .L2          ; skip the bias when x >= 0
//	addiu	at, a0, 1        ; bias = 2^k - 1
//     .L2:	sra	v0, at, 1        ; >> k
//
// That is a CFG diamond, not an instruction window, so the patterns-as-data idiom layer cannot state
// it — its match DAG is over the def-graph inside a block. It earns a pre-recovery pass for the same
// reason raise/shortcircuit.ts is one: the thing being recognised is a shape in the CONTROL FLOW.
// (m2c reached the same conclusion from the other side — its `49b5d87` adds a third and fourth
// instruction-window pattern for the GCC spellings, and the commit notes GCC reorders the final
// `sra` and defeats the window. Matching the value graph instead is immune to that.)
//
// Both spellings of the merge appear in the corpus and both are recognised here:
//
//   SUNK    the shift is after the merge — phi(x, x + 2^k-1) feeding `shr_s(phi, k)`
//   SPLIT   the shift is duplicated into both arms — phi(shr_s(x, k), shr_s(x + 2^k-1, k)),
//           which is what a delay-slot fill produces (the `sra` runs on both paths)
//
// The identity is arithmetic — for signed x, `(x < 0 ? x + 2^k-1 : x) >> k` is exactly `x / 2^k`
// under C's truncating division — but by this project's taxonomy that is NOT on its own a licence
// to run ungated: the compiler-pinned idiom patterns are gated precisely because they trade one
// spelling for another and are byte-safe only where measured, and this pass does trade a spelling.
// What carries it is raise/magicdiv.ts's argument, which applies here unchanged: the round-trip is
// SELF-VERIFYING. asmlift emits a plain `x / 2^k` and the target compiler regenerates ITS own
// lowering; a wrong divisor recompiles to different bytes and shows up as a nonmatch, never as a
// false match. The residual exposure is a lost match, not a miscompile — on a compiler that lowers
// `/2^k` branchlessly, a diamond of this shape came from hand-written biasing, and respelling it
// costs a match that used to land. Measured positive on ido7.1 (two flips), agbcc and gcc2.7.2kmc
// (modpow2 stays byte-exact through the respelling); mwcc_242_81 and gcc2.7.2 have no inhabitant, so
// they are unmeasured rather than clean.
//
// It is deliberately IDENTITY-OR-DECLINE about the shape (the bias constant must be exactly
// `2^k - 1` for the SAME k the shift uses, the guard must test the SAME value the arms divide, and
// the biased arm must be the negative one — the consistency check m2c's `49b5d87` also adds),
// because every one of those is a way for a superficially similar diamond to mean something else.
import { Block, Fn, Op, Value, defOpMap, mkOp, mkValue, predecessors, replaceAllUsesWith } from '../ir/core';
import { EFFECTFUL_OPS } from '../ir/opcodes';
import { T } from '../ir/types';

/** `shr_s v {imm=k}` → k, else null. */
function shiftAmount(defs: Map<Value, Op>, v: Value): { k: number; src: Value; op: Op } | null {
  const d = defs.get(v);
  if (!d || d.opcode !== 'shr_s' || d.operands.length !== 1 || typeof d.attrs.imm !== 'number') {
    return null;
  }
  return { k: d.attrs.imm, src: d.operands[0], op: d };
}

/** `add v, const(2^k - 1)` → the addend's base, else null. The add is commutative. */
function biasedBy(defs: Map<Value, Op>, v: Value, k: number): Value | null {
  const d = defs.get(v);
  if (!d || d.opcode !== 'add' || d.operands.length !== 2) {
    return null;
  }
  for (const [a, b] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const c = defs.get(d.operands[b]);
    if (c && c.opcode === 'const' && c.attrs.value === 2 ** k - 1) {
      return d.operands[a];
    }
  }
  return null;
}

/**
 * Fold the branching signed-division-by-2^k diamond into `sdiv x {imm=2^k}`. Returns true if the IR
 * changed. Leaves the now-dead bias/shift ops behind for the driver's DCE.
 */
export function recognizeDivPow2(fn: Fn): boolean {
  let changed = false;
  let progress = true;
  while (progress) {
    progress = false;
    const defs = defOpMap(fn);
    const preds = predecessors(fn);
    const term = (b: Block) => b.ops[b.ops.length - 1];

    outer: for (const m of fn.blocks) {
      // The merge carries exactly the quotient (or the value about to be shifted into it), and is
      // reached only by the two arms of this diamond — a third predecessor means the phi is a join
      // of something larger and retiring it would drop that edge's value.
      //
      // NEITHER end of the diamond may be the ENTRY block. `predecessors()` walks successor edges
      // only, so an entry that is also a loop header shows two predecessors while really being a
      // three-way join — the implicit entry edge is invisible, and the head does not dominate it.
      // The bias-arm case blows up loudly in the verifier; the MERGE case is silent, because its
      // params are the FUNCTION'S OWN PARAMETERS and `m.params = []` below would quietly delete one,
      // handing back a signature with an argument missing. raise/shortcircuit.ts documents the same
      // trap for its feeder; only half of that guard was copied here at first.
      if (m.params.length !== 1 || (preds.get(m) ?? []).length !== 2 || m === fn.blocks[0]) {
        continue;
      }
      const p = m.params[0];
      for (const bias of preds.get(m)!) {
        // The BIAS arm: sole predecessor is the head, and it does nothing but bias (and possibly
        // shift). The whole block is DELETED, not hoisted, so anything else in it would be silently
        // dropped — a store, a call or an opaque there would simply stop happening (an opaque
        // whether or not its result is read: liveness says nothing about what the instruction did).
        const bt = term(bias);
        if (bt.opcode !== 'br' || bt.successors[0]?.block !== m || bias === fn.blocks[0]) {
          continue;
        }
        const bp = preds.get(bias) ?? [];
        if (bp.length !== 1 || bias.ops.some((op) => EFFECTFUL_OPS.has(op.opcode))) {
          continue;
        }
        const h = bp[0];
        const ht = term(h);
        if (ht.opcode !== 'cond_br') {
          continue;
        }
        const [taken, fall] = ht.successors;
        const direct = taken.block === m ? taken : fall.block === m ? fall : null;
        if (!direct || (taken.block !== bias && fall.block !== bias)) {
          continue; // the head's two successors must be exactly {merge, bias arm}
        }
        const biasedIsTaken = taken.block === bias;

        // Read the two incoming values and split into the SUNK and SPLIT spellings. `k` and the
        // dividend come from whichever arm shape matches; both arms must agree on both.
        const vDirect = direct.args[0];
        const vBias = bt.successors[0].args[0];
        if (vDirect === undefined || vBias === undefined) {
          continue;
        }
        // SPLIT is TRIED, not assumed, and a failed attempt falls through to SUNK. The direct arm
        // being a `shr_s` does not make this the split form — the dividend may simply BE a shifted
        // value (`(a >> 2) / 4`), and treating that as split-with-a-broken-bias-arm used to abandon
        // a perfectly good sunk diamond.
        let split: { k: number; x: Value } | null = null;
        const splitDirect = shiftAmount(defs, vDirect);
        if (splitDirect) {
          const splitBias = shiftAmount(defs, vBias);
          if (
            splitBias &&
            splitBias.k === splitDirect.k &&
            biasedBy(defs, splitBias.src, splitDirect.k) === splitDirect.src
          ) {
            split = { k: splitDirect.k, x: splitDirect.src };
          }
        }
        let k: number, x: Value, sunkShift: Op | null;
        if (split) {
          // SPLIT: both arms shift. The direct arm shifts the dividend, the bias arm the biased one.
          k = split.k;
          x = split.x;
          sunkShift = null;
        } else {
          // SUNK: the merge value is the (maybe biased) dividend, shifted once after the join. The
          // phi must feed exactly that shift and NOTHING else — the fold stops computing the
          // unshifted biased value, so any second consumer would silently read the quotient in its
          // place. A use is an operand OR a successor argument (block args are uses too, and live in
          // `successors[].args`, which is why `replaceAllUsesWith` rewrites both) — counting only
          // operands let a phi that was also passed along an edge through this guard, and the arm's
          // value then came out as the quotient: `(y >> 2) + y` folded to `(x / 4) + (x / 4)`.
          const uses = fn.blocks
            .flatMap((b) => b.ops)
            .filter((op) => op.operands.includes(p) || op.successors.some((su) => su.args.includes(p)));
          if (uses.length !== 1 || !uses[0].operands.includes(p)) {
            continue;
          }
          const sunk = shiftAmount(defs, uses[0].results[0]);
          // The shift must be IN the merge block: the cleanup below removes it from there, so a
          // shift found elsewhere would be searched for and not cleaned, leaving the two out of step.
          if (!sunk || sunk.src !== p || !m.ops.includes(sunk.op)) {
            continue;
          }
          k = sunk.k;
          x = vDirect;
          if (biasedBy(defs, vBias, k) !== x) {
            continue;
          }
          sunkShift = sunk.op;
        }
        if (k < 1 || k > 30) {
          continue; // 2^k must be a representable positive divisor
        }

        // The guard must test THE DIVIDEND against zero, and route the biased value to the NEGATIVE
        // side. `x >= 0` takes the direct arm; `x < 0` takes the bias arm. Anything else — a compare
        // against another value, a different operand, the arms the other way round — is a diamond
        // that merely looks like this one.
        const cond = defs.get(ht.operands[0]);
        if (!cond || cond.operands.length !== 2 || cond.operands[0] !== x) {
          continue;
        }
        const zero = defs.get(cond.operands[1]);
        if (!zero || zero.opcode !== 'const' || zero.attrs.value !== 0) {
          continue;
        }
        const takenIsNegative = cond.opcode === 'icmp_slt';
        if (!takenIsNegative && cond.opcode !== 'icmp_sge') {
          continue;
        }
        if (takenIsNegative !== biasedIsTaken) {
          continue; // the bias is on the wrong side — this is not a round-toward-zero correction
        }

        // Rewrite: the head computes the quotient outright and falls straight to the merge; the bias
        // arm and the phi go away. The dead bias/shift ops are left for the driver's DCE.
        const q = mkValue(T.s());
        h.ops.splice(h.ops.length - 1, 0, mkOp('sdiv', { operands: [x], results: [q], attrs: { imm: 2 ** k } }));
        h.ops[h.ops.length - 1] = mkOp('br', { successors: [{ block: m, args: [] }] });
        if (sunkShift) {
          replaceAllUsesWith(fn, sunkShift.results[0], q);
          m.ops = m.ops.filter((op) => op !== sunkShift);
        }
        replaceAllUsesWith(fn, p, q);
        m.params = [];
        fn.blocks = fn.blocks.filter((b) => b !== bias);
        changed = true;
        progress = true;
        break outer; // defs/preds are stale after the mutation
      }
    }
  }
  return changed;
}
