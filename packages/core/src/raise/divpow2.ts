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
// `/2^k` branchlessly, a diamond of this shape came from hand-written biasing, and rewriting it
// costs a match that used to land. Measured positive on ido7.1 (two flips), agbcc and gcc2.7.2kmc
// (modpow2 stays byte-exact through the rewrite); mwcc_242_81 and gcc2.7.2 have no inhabitant, so
// they are unmeasured rather than clean.
//
// It is deliberately IDENTITY-OR-DECLINE about the shape (the bias constant must be exactly
// `2^k - 1` for the SAME k the shift uses, the guard must test the SAME value the arms divide, and
// the biased arm must be the negative one — the consistency check m2c's `49b5d87` also adds),
// because every one of those is a way for a superficially similar diamond to mean something else.
//
// ir/bits.ts `integerRange` (its `remainderPair`) reads the same SUNK diamond under a remainder,
// `x - (phi >> k << k)`, as one bounded term. It cannot wait for this pass's `sdiv`: the frontends'
// frame audit asks those ranges before runPreRecovery runs; and as a bound, not a rewrite, it holds
// for any bias in [0, 2^k) on any edge, so it does not take this pass's gates.
import { Block, Fn, Op, Value, defOpMap, mkOp, mkValue, predecessors, replaceAllUsesWith } from '../ir/core';
import { effectful } from '../ir/discipline';
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
        if (bp.length !== 1 || bias.ops.some(effectful)) {
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

// ── the signed REMAINDER by a power of two, in IDO's branching form ─────────────────────────
//
// `x % 2^k` truncates toward zero, so a negative x with low bits set takes `2^k` off its masked
// value. IDO masks first and corrects on a two-test branch (modpow2, `a % 16`):
//
//	bgez	a0, .L       ; x >= 0: the mask is the remainder
//	andi	v0, a0, 15   ; (delay slot: runs on both paths)
//	beqz	v0, .L       ; low bits clear: so is it
//	nop
//	addiu	v0, v0, -16  ; else take 2^k off
//     .L:
//
// Two heads and a correction arm reach one merge, so — like the quotient above — it is a shape in
// the control flow, out of the idiom patterns' reach. Lifted as written it is spelled
// `if (x < 0 && (x & 15) != 0) v = (x & 15) + -16; else v = x & 15;`, which IDO compiles to other
// code; `x % 16` compiles back to this diamond. The identity is exact for every signed x — the
// diamond IS C's `%` — and the round trip is self-verifying for the reason the quotient's is.
//
// IDENTITY-OR-DECLINE again: the mask must be exactly `2^k - 1` of the dividend the first test
// compares against zero, the second test must compare THAT mask against zero, the correction must
// be exactly `-2^k` on the mask, and the corrected value must reach the merge only from the arm
// both tests failed into. The two inner blocks are deleted, so neither may do anything else.
// agbcc, gcc and kmc spell the same remainder as a biased floor (`x - (t >> k << k)`), which
// ir/bits.ts `remainderPair` bounds and this does not touch; mwcc's is branch-free.

/** `and x, const(2^k - 1)` → { x, k }, else null. The and is commutative. */
function maskOf(defs: Map<Value, Op>, v: Value): { x: Value; k: number } | null {
  const d = defs.get(v);
  if (!d || d.opcode !== 'and' || d.operands.length !== 2) {
    return null;
  }
  for (const [a, b] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const c = defs.get(d.operands[b]);
    const m = c?.opcode === 'const' ? (c.attrs.value as number) : undefined;
    if (m !== undefined && m > 0 && (m & (m + 1)) === 0) {
      return { x: d.operands[a], k: Math.log2(m + 1) };
    }
  }
  return null;
}

/** `icmp <op> v, const 0` → the compare's opcode, else null. */
function zeroTest(defs: Map<Value, Op>, c: Value, v: Value): string | null {
  const d = defs.get(c);
  if (!d || d.operands.length !== 2 || d.operands[0] !== v) {
    return null;
  }
  const z = defs.get(d.operands[1]);
  return z?.opcode === 'const' && z.attrs.value === 0 ? d.opcode : null;
}

/**
 * Fold IDO's branching signed-remainder-by-2^k diamond into `smod x, 2^k`. Returns true if the IR
 * changed. Leaves the mask, the compares and the correction behind for the driver's DCE.
 */
export function recognizeSremPow2(fn: Fn): boolean {
  let changed = false;
  let progress = true;
  while (progress) {
    progress = false;
    const defs = defOpMap(fn);
    const preds = predecessors(fn);
    const term = (b: Block) => b.ops[b.ops.length - 1];
    // a result of `blocks`' ops read anywhere outside them, which deleting them would orphan
    const escapes = (blocks: Block[]): boolean => {
      const inside = new Set(blocks.flatMap((b) => b.ops.flatMap((op) => op.results)));
      return fn.blocks
        .filter((b) => !blocks.includes(b))
        .some((b) =>
          b.ops.some(
            (op) =>
              op.operands.some((v) => inside.has(v)) || op.successors.some((s) => s.args.some((v) => inside.has(v))),
          ),
        );
    };
    outer: for (const m of fn.blocks) {
      // the merge holds the remainder alone and is reached by exactly the diamond's three edges
      // (the entry block has an invisible edge; see recognizeDivPow2)
      const mp = preds.get(m) ?? [];
      if (m.params.length !== 1 || mp.length !== 3 || new Set(mp).size !== 3 || m === fn.blocks[0]) {
        continue;
      }
      for (const fix of mp) {
        // the CORRECTION arm: `t + -2^k` to the merge, from the second test alone, nothing else
        const ft = term(fix);
        if (ft.opcode !== 'br' || ft.successors[0]?.block !== m || fix === fn.blocks[0] || fix.ops.some(effectful)) {
          continue;
        }
        const n = preds.get(fix) ?? [];
        if (n.length !== 1 || !mp.includes(n[0]) || n[0] === fn.blocks[0]) {
          continue;
        }
        const inner = n[0];
        const it = term(inner);
        const hp = preds.get(inner) ?? [];
        if (it.opcode !== 'cond_br' || hp.length !== 1 || !mp.includes(hp[0]) || inner.ops.some(effectful)) {
          continue;
        }
        const head = hp[0];
        const ht = term(head);
        if (ht.opcode !== 'cond_br' || head === m || head === fix) {
          continue;
        }
        // the corrected value: an add of `-2^k` to the mask
        const u = defs.get(ft.successors[0].args[0]);
        if (u?.opcode !== 'add' || u.operands.length !== 2) {
          continue;
        }
        let t: Value | null = null;
        let mk: { x: Value; k: number } | null = null;
        for (const [a, b] of [
          [0, 1],
          [1, 0],
        ] as const) {
          const c = defs.get(u.operands[b]);
          const mm = maskOf(defs, u.operands[a]);
          if (c?.opcode === 'const' && mm !== null && c.attrs.value === -(2 ** mm.k)) {
            t = u.operands[a];
            mk = mm;
          }
        }
        if (t === null || mk === null || mk.k < 1 || mk.k > 30) {
          continue;
        }
        // the first test: x >= 0 to the merge with the mask, else on to the second
        const [hTaken, hFall] = ht.successors;
        const hFirst = zeroTest(defs, ht.operands[0], mk.x);
        const hm = hFirst === 'icmp_sge' ? hTaken : hFirst === 'icmp_slt' ? hFall : null;
        const hn = hFirst === 'icmp_sge' ? hFall : hFirst === 'icmp_slt' ? hTaken : null;
        if (hm?.block !== m || hn?.block !== inner || hm.args[0] !== t || hn.args.length !== 0) {
          continue;
        }
        // the second test: the mask == 0 to the merge with the mask, else to the correction
        const [iTaken, iFall] = it.successors;
        const iSecond = zeroTest(defs, it.operands[0], t);
        const im = iSecond === 'icmp_eq' ? iTaken : iSecond === 'icmp_ne' ? iFall : null;
        const ifx = iSecond === 'icmp_eq' ? iFall : iSecond === 'icmp_ne' ? iTaken : null;
        if (im?.block !== m || ifx?.block !== fix || im.args[0] !== t || ifx.args.length !== 0) {
          continue;
        }
        if (escapes([inner, fix])) {
          continue;
        }
        // Rewrite: the head computes the remainder and goes straight to the merge.
        const by = mkValue(T.s());
        const r = mkValue(T.s());
        head.ops.splice(
          head.ops.length - 1,
          0,
          mkOp('const', { results: [by], attrs: { value: 2 ** mk.k } }),
          mkOp('smod', { operands: [mk.x, by], results: [r] }),
        );
        head.ops[head.ops.length - 1] = mkOp('br', { successors: [{ block: m, args: [] }] });
        replaceAllUsesWith(fn, m.params[0], r);
        m.params = [];
        fn.blocks = fn.blocks.filter((b) => b !== inner && b !== fix);
        changed = true;
        progress = true;
        break outer;
      }
    }
  }
  return changed;
}
