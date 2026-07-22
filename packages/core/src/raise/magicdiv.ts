// asmlift — magic-number constant-division recovery (L1 recognition; gcc2.7.2kmc + mwcc_242_81).
//
// A compiler replaces `x / C` for a non-power-of-2 constant `C` with a HIGH-WORD MULTIPLY by a
// precomputed "magic" reciprocal `M`, a shift `s`, and a sign correction. The frontend lifts the
// high-word multiply to a transient `mulh`/`mulhu` op (mips `mfhi` after `mult`/`multu`; ppc
// `mulhw`/`mulhwu`); this pass matches the DAG hanging off it, RECONSTRUCTS `C`, PROVES it with the
// forward Hacker's-Delight generator, and rewrites the tree to `sdiv`/`udiv(x, const C)` — the same
// op the hardware-divide and softdiv paths emit, which the structurer prints as `x / C` and the
// compiler re-lowers to the identical magic sequence.
//
// Soundness: the round-trip is SELF-VERIFYING — asmlift emits a plain `x / C` and the target
// compiler regenerates ITS magic; a wrong `C` recompiles to different bytes → nonmatch, never a
// false match. The forward-verify below is therefore a MATCH-RATE filter (don't emit a nonsense
// divide from a `mulh` chain that isn't a division) rather than the trust barrier. An unrecognised /
// unverifiable shape leaves the `mulh` in place → it loud-fails at the structurer boundary (the
// transient op has no C spelling). The guard is a COMPUTATION, which the patterns-as-data layer
// cannot state, so this lives as a bespoke always-on pass run before type recovery.
import { Fn, Op, Value, defOpMap, mkOp, mkValue } from '../ir/core';
import { T } from '../ir/types';

/** Forward signed magic generator (Hacker's Delight §10-3). Given divisor `d` (2 ≤ d), returns the
 *  32-bit magic multiplier `M` and shift `s` a compiler would pick. All intermediates stay < 2^33, so
 *  plain Number arithmetic is exact (no 32-bit-overflow products are taken). */
function magicS(d: number): { M: number; s: number } {
  const two31 = 0x80000000;
  const ad = Math.abs(d);
  const t = two31 + (d < 0 ? 1 : 0);
  const anc = t - 1 - (t % ad);
  let p = 31;
  let q1 = Math.floor(two31 / anc),
    r1 = two31 - q1 * anc;
  let q2 = Math.floor(two31 / ad),
    r2 = two31 - q2 * ad;
  let delta: number;
  do {
    p++;
    q1 = 2 * q1;
    r1 = 2 * r1;
    if (r1 >= anc) {
      q1++;
      r1 -= anc;
    }
    q2 = 2 * q2;
    r2 = 2 * r2;
    if (r2 >= ad) {
      q2++;
      r2 -= ad;
    }
    delta = ad - r2;
  } while (q1 < delta || (q1 === delta && r1 === 0));
  let M = q2 + 1;
  if (d < 0) {
    M = -M;
  }
  return { M: M >>> 0, s: p - 32 };
}

/** Forward UNSIGNED magic generator (Hacker's Delight §10-8). Returns the multiplier `M`, shift `s`,
 *  and the `add` indicator (true ⇒ the "add-correction" variant that needs an extra `+x` term —
 *  matched by matchUnsignedAddCorrection, not the simple `mulhu>>s` shape). */
function magicU(d: number): { M: number; s: number; add: boolean } {
  const u = (x: number) => x >>> 0;
  let p = 31;
  const nc = u(u(-1) - u(u(-d) % d));
  let q1 = Math.floor(0x80000000 / nc),
    r1 = u(0x80000000 - q1 * nc);
  let q2 = Math.floor(0x7fffffff / d),
    r2 = u(0x7fffffff - q2 * d);
  let add = false,
    delta: number;
  do {
    p++;
    if (r1 >= nc - r1) {
      q1 = u(2 * q1 + 1);
      r1 = u(2 * r1 - nc);
    } else {
      q1 = u(2 * q1);
      r1 = u(2 * r1);
    }
    if (r2 + 1 >= d - r2) {
      if (q2 >= 0x7fffffff) {
        add = true;
      }
      q2 = u(2 * q2 + 1);
      r2 = u(2 * r2 + 1 - d);
    } else {
      if (q2 >= 0x80000000) {
        add = true;
      }
      q2 = u(2 * q2);
      r2 = u(2 * r2 + 1);
    }
    delta = d - 1 - r2;
  } while (p < 64 && (q1 < delta || (q1 === delta && r1 === 0)));
  return { M: u(q2 + 1), s: p - 32, add };
}

// Realistic constant divisors are small; bound the inverse search generously (covers fixed-point
// scales) but finitely. The search is only reached once a `mulh`/`mulhu` anchor with a const magic is
// found (rare — non-division functions have no high-word multiply), so cost is negligible.
const DIVISOR_MAX = 0x40000;

/** Invert a magic: find the divisor `C` whose FORWARD magic is exactly the observed `(M, s)` —
 *  a proof by exact reproduction. `kind` picks the catalog: signed (magicS), simple unsigned
 *  (magicU, no add-correction), or add-correction unsigned (magicU with `add`). Returns null if
 *  no divisor in range reproduces the pair. */
function recoverDivisor(M: number, s: number, kind: 'signed' | 'unsigned' | 'unsigned-add'): number | null {
  const mu = M >>> 0;
  for (let d = 2; d <= DIVISOR_MAX; d++) {
    if (kind === 'signed') {
      const m = magicS(d);
      if (m.M === mu && m.s === s) {
        return d;
      }
    } else {
      const m = magicU(d);
      if (m.M === mu && m.s === s && m.add === (kind === 'unsigned-add')) {
        return d;
      }
    }
  }
  return null;
}

// ── DAG helpers ───────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  defOf: Map<Value, Op>;
  usesOf: Map<Value, Op[]>;
}

function buildCtx(fn: Fn): Ctx {
  const usesOf = new Map<Value, Op[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const o of op.operands) {
        const arr = usesOf.get(o);
        if (arr) {
          arr.push(op);
        } else {
          usesOf.set(o, [op]);
        }
      }
    }
  }
  return { defOf: defOpMap(fn), usesOf };
}

const constVal = (ctx: Ctx, v: Value): number | null => {
  const d = ctx.defOf.get(v);
  return d && d.opcode === 'const' ? (d.attrs.value as number) : null;
};

/** Bind a high-word multiply's operands: M = the const operand, x = the other. Exactly one of
 *  the two must be a constant. */
function bindMulOperands(ctx: Ctx, mul: Op): { x: Value; M: number } | null {
  const [a, b] = mul.operands;
  const ca = constVal(ctx, a),
    cb = constVal(ctx, b);
  if (ca !== null && cb === null) {
    return { M: ca, x: b };
  }
  if (cb !== null && ca === null) {
    return { M: cb, x: a };
  }
  return null;
}

/** A single unique use of `v` matching `pred`, or null (ambiguous / absent both yield null). */
function uniqueUse(ctx: Ctx, v: Value, pred: (op: Op) => boolean): Op | null {
  const hits = (ctx.usesOf.get(v) ?? []).filter(pred);
  return hits.length === 1 ? hits[0] : null;
}

/** An immediate-form shift `op(base){imm}` result → the shift amount, else null. */
function immShiftAmt(op: Op, opcode: string): number | null {
  return op.opcode === opcode && op.operands.length === 1 && typeof op.attrs.imm === 'number'
    ? (op.attrs.imm as number)
    : null;
}

/** The block+index of `op`, or null. */
function locate(fn: Fn, op: Op): { block: number; idx: number } | null {
  for (let b = 0; b < fn.blocks.length; b++) {
    const i = fn.blocks[b].ops.indexOf(op);
    if (i >= 0) {
      return { block: b, idx: i };
    }
  }
  return null;
}

// ── The recogniser ──────────────────────────────────────────────────────────────────────────────

/** Rewrite each recognised magic-division tree to `sdiv`/`udiv(x, const C)`, in place. Returns whether
 *  anything changed. Runs BEFORE type recovery so the new op's operands get signedness typing. */
export function recognizeMagicDivision(fn: Fn): boolean {
  const ctx = buildCtx(fn);
  let changed = false;

  for (const b of fn.blocks) {
    for (const op of [...b.ops]) {
      let rec: Match | null = null;
      if (op.opcode === 'mulh') {
        rec = matchSignedMagic(ctx, op);
      } // signed magic division
      else if (op.opcode === 'mulhu')
      // unsigned: simple, else add-correction
      {
        rec = matchUnsignedSimpleMagic(ctx, op) ?? matchUnsignedAddCorrection(ctx, op);
      } else {
        continue;
      }
      if (!rec) {
        continue;
      } // uncatalogued / unverifiable → leave the high-mul → loud-fail
      const loc = locate(fn, rec.root);
      if (!loc) {
        continue;
      }
      const block = fn.blocks[loc.block];
      const cRes = mkValue(T.unk(32));
      const cOp = mkOp('const', { results: [cRes], attrs: { value: rec.C } });
      // Reuse the root's result Value so every downstream use auto-points at the divide; DCE reaps the
      // now-dead mulh/add/shift/correction ops.
      const divOp = mkOp(rec.signed ? 'sdiv' : 'udiv', { operands: [rec.x, cRes], results: [rec.root.results[0]] });
      block.ops.splice(loc.idx, 1, cOp, divOp);
      changed = true;
    }
  }
  return changed;
}

interface Match {
  x: Value;
  C: number;
  root: Op;
  signed: boolean;
}

/** Match the signed magic-division DAG rooted at a `mulh`, in either the MIPS (`- (x>>31)`) or PPC
 *  (`+ (t>>u31)`) sign-correction form, and reconstruct+verify the divisor. */
function matchSignedMagic(ctx: Ctx, mul: Op): Match | null {
  // Bind M (the const operand) and x (the other).
  const bound = bindMulOperands(ctx, mul);
  if (!bound) {
    return null;
  }
  const { x, M } = bound;
  const r = mul.results[0];

  // base = mulh result, or `add(mulh, x)` when the magic needed the +x "33rd bit" correction (M high).
  let base = r;
  const addX = uniqueUse(
    ctx,
    r,
    (o) =>
      o.opcode === 'add' &&
      ((o.operands[0] === r && o.operands[1] === x) || (o.operands[1] === r && o.operands[0] === x)),
  );
  if (addX) {
    base = addX.results[0];
  }
  // The +x correction is REQUIRED exactly when M's top bit is set (M reads as negative in the
  // signed mulh, so the product under-counts by x) and FORBIDDEN otherwise. recoverDivisor
  // verifies only (M, s), which is identical for both shapes — an untied match would rewrite a
  // spurious-+x or missing-+x tree to a divide computing a DIFFERENT value than the matched asm.
  if (M >>> 0 >= 0x80000000 !== (addX !== null)) {
    return null;
  }

  // shifted = shr_s(base, s)  (arithmetic right shift by the magic shift)
  const shOp = uniqueUse(ctx, base, (o) => immShiftAmt(o, 'shr_s') !== null);
  if (!shOp) {
    return null;
  }
  const s = immShiftAmt(shOp, 'shr_s')!;
  const shifted = shOp.results[0];

  // Sign correction → root. MIPS: sub(shifted, shr_s(x,31)); PPC: add(shifted, shr_u(shifted,31)).
  let root: Op | null = null;
  const subUse = uniqueUse(ctx, shifted, (o) => o.opcode === 'sub' && o.operands[0] === shifted);
  if (subUse) {
    const w = ctx.defOf.get(subUse.operands[1]);
    if (w && immShiftAmt(w, 'shr_s') === 31 && w.operands[0] === x) {
      root = subUse;
    } // - (x>>31)
  }
  if (!root) {
    const addUse = uniqueUse(
      ctx,
      shifted,
      (o) => o.opcode === 'add' && (o.operands[0] === shifted || o.operands[1] === shifted),
    );
    if (addUse) {
      const other = addUse.operands[0] === shifted ? addUse.operands[1] : addUse.operands[0];
      const w = ctx.defOf.get(other);
      if (w && immShiftAmt(w, 'shr_u') === 31 && w.operands[0] === shifted) {
        root = addUse;
      } // + (t>>u31)
    }
  }
  if (!root) {
    return null;
  }

  const C = recoverDivisor(M, s, 'signed');
  if (C === null) {
    return null;
  } // no divisor reproduces (M,s) exactly → not a division we trust
  return { x, C, root, signed: true };
}

/** Match the SIMPLE unsigned magic-division DAG `shr_u(mulhu(x, M), s)` (no correction) and
 *  reconstruct+verify the divisor. The add-correction variant (`t + ((x−t)>>1)`) is not matched
 *  here — its `mulhu` result feeds a `sub`, not a direct `shr_u`, so this matcher naturally declines it. */
function matchUnsignedSimpleMagic(ctx: Ctx, mul: Op): Match | null {
  const bound = bindMulOperands(ctx, mul);
  if (!bound) {
    return null;
  }
  const { x, M } = bound;
  const r = mul.results[0];

  // shifted = shr_u(mulhu, s) — the quotient. The simple form has NO sign/round correction: the shift
  // result IS the returned value, so it is the root.
  const shOp = uniqueUse(ctx, r, (o) => immShiftAmt(o, 'shr_u') !== null);
  if (!shOp) {
    return null;
  }
  const s = immShiftAmt(shOp, 'shr_u')!;

  const C = recoverDivisor(M, s, 'unsigned');
  if (C === null) {
    return null;
  }
  return { x, C, root: shOp, signed: false };
}

/** Match the ADD-CORRECTION unsigned magic DAG (used when the magic reciprocal didn't fit in 32 bits):
 *    t = mulhu(x, M);  d1 = x − t;  d2 = d1 >>u 1;  d3 = t + d2;  root = d3 >>u (s−1)
 *  and reconstruct+verify the divisor (`magicU(C).add === true`, `magicU(C).s === s`). */
function matchUnsignedAddCorrection(ctx: Ctx, mul: Op): Match | null {
  const bound = bindMulOperands(ctx, mul);
  if (!bound) {
    return null;
  }
  const { x, M } = bound;
  const t = mul.results[0];

  // d1 = sub(x, t)  [x − t]
  const d1 = uniqueUse(ctx, t, (o) => o.opcode === 'sub' && o.operands[0] === x && o.operands[1] === t);
  if (!d1) {
    return null;
  }
  // d2 = shr_u(d1, 1)
  const d2 = uniqueUse(ctx, d1.results[0], (o) => immShiftAmt(o, 'shr_u') === 1);
  if (!d2) {
    return null;
  }
  // d3 = add(t, d2)  (either operand order)
  const d3 = uniqueUse(
    ctx,
    d2.results[0],
    (o) => o.opcode === 'add' && (o.operands[0] === d2.results[0] || o.operands[1] === d2.results[0]),
  );
  if (!d3) {
    return null;
  }
  const otherAdd = d3.operands[0] === d2.results[0] ? d3.operands[1] : d3.operands[0];
  if (otherAdd !== t) {
    return null;
  } // the add must combine `t` and `d2`
  // root = shr_u(d3, s−1)
  const rootOp = uniqueUse(ctx, d3.results[0], (o) => immShiftAmt(o, 'shr_u') !== null);
  if (!rootOp) {
    return null;
  }
  const s2 = immShiftAmt(rootOp, 'shr_u')!;

  const C = recoverDivisor(M, s2 + 1, 'unsigned-add'); // the final shift is s−1, so the magic shift is s2+1
  if (C === null) {
    return null;
  }
  return { x, C, root: rootOp, signed: false };
}
