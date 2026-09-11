// A NARROWING EXTENSION FUSED WITH THE LEFT SHIFT THAT SCALES IT.
//
// agbcc lowers `(u8)x` to a shift pair, `lsl #24; lsr #24` (the CAST_PATTERNS idiom,
// pattern/engine.ts). Scale the narrowed value and gcc's combiner merges the right half of the pair
// with the scale, so `(u8)x << 3` is TWO instructions, not three:
//
//     lsl  r0, r0, #0x18        %1 = shl %x {imm=24}
//     lsr  r0, r0, #0x15        %2 = shr_u %1 {imm=21}      == zext8(x) << 3
//
// Exactly: `(x << L) >>u R` for `0 < R < L` keeps x's low `32 - L` bits and lands them at bit
// `L - R`, which is `zext(x, 32 - L) << (L - R)`; `>>s` is the same with `sext`. Unfolded, the pair
// prints as `x << 24 >> 21`, which reproduces the same two instructions — so the fold is not a byte
// fix by itself. What it buys is the two facts the raw pair hides from every pass below:
//
//   • THE WIDTH. A declared `u8 idx` is extended in the prologue, and that extension is what
//     raise/paramwidth.ts reads to type the parameter. When the extension is fused, the prologue
//     holds a bare `shl` instead: paramwidth sees no extension of this parameter, AND its prologue
//     scan stops at that `shl`, so every LATER parameter's extension reads as body code too. Typed
//     `u32`, the function recompiles with both shifts at the use and the whole schedule moves.
//   • THE SCALE. `shl(ext(x), k)` is the element-scaled index raise/arrays.ts and
//     raise/struct-arrays.ts legalize; `shr_u(shl(x, 24), 21)` is an opaque byte offset to both.
//
// WHERE THE EXTENSION GOES is the one real decision here, and it is read off the machine, not
// chosen. The two halves of the pair are not scheduled together. Compiled with this benchmark's
// agbcc, the same body over a narrow and a wide parameter:
//
//     void pa(u8 a, u8 b)  { gA |= 4; gB = (u32)&gT + a * 4;      gC = b; }
//         lsl r0,#24 / lsl r1,#24 / lsr r1,#24 / …body… / lsr r0,#22 / add …
//     void pb(u32 a, u8 b) { gA |= 4; gB = (u32)&gT + (u8)a * 4;  gC = b; }
//         lsl r1,#24 / lsr r1,#24 / …body… / lsl r0,#24 / lsr r0,#22 / add …
//
// The declaration's extension starts in the prologue and only its SECOND half is merged into the
// use; a cast in the body is lowered at the use, both halves together. So the extension is placed
// where its `shl` stood and the scale where the right shift stood: a prologue `lsl` yields a
// prologue extension, which paramwidth's own gates then judge — including `not-prologue`, which is
// what keeps `pb` wide. Placing both at the right shift instead throws `pa`'s prologue evidence
// away, so `pa` reads as `pb` and stays wide — measured on the benchmark's sa3 rows, which declare
// `u8 bg` exactly so: `sa2__sub_8007858` 39/60 anchored against 44/61 at the right shift, and
// `sa2__sub_8007958` 64/87 against 66/88.
//
// The SIGNED form does not carry that evidence on agbcc: `void pd(s16 a, …) { … a * 2 … }` and its
// wide twin `(s16)a * 2` compile to the SAME object, both halves at the use. That is paramwidth's
// existing ambiguity (its header's `pc` pair), not a new one — the placement rule is the same
// either way, and where the pair sits the judgement is paramwidth's.
//
// REFUSES — the pair is left as it is — when:
//   • `R >= L`. `R == L` is the plain cast, which CAST_PATTERNS already folded; `R > L` keeps
//     `32 - R` bits of `x << L` and scales nothing — a bitfield EXTRACT, structure/bitfields.ts's
//     shape — so the two readings are disjoint by the shift amounts alone;
//   • `32 - L` is not a C cast width (8 or 16) — `lsl #28; lsr #26` is `(x & 15) << 2`, which no
//     cast spells;
//   • either shift is the two-register form (no `imm`) or `R` is 0;
//   • the target is not one CAST_PATTERNS applies to. Same predicate, because the fused pair is
//     that cast's lowering with a scale merged in: where `(u8)x` is not a shift pair (IDO and GCC
//     `andi`), `(u8)x << k` is not one either, and a `sll; srl` there is some other arithmetic.
//
// One extension per (shift, signedness): two scales read off one `shl` share it, and the `shl`
// dies only when every reader was folded. A `shl` that keeps another reader leaves the parameter
// with two readers, which paramwidth's `raw-reader` refuses — the width stays unclaimed rather
// than guessed.
import { type Block, type Fn, type Op, type Value, defOpMap, mkOp, mkValue, replaceAllUsesWith } from '../ir/core';
import { CAST_WIDTHS } from '../ir/opcodes';
import { CAST_PATTERNS, patternApplies } from '../pattern/engine';
import type { TargetDescription } from '../target';

/** `shr_{u,s}(shl(src, L), R)` read as `ext(src, 32 - L) << (L - R)`. */
export interface ScaledExtension {
  /** the value being narrowed — the `shl`'s operand */
  src: Value;
  /** the cast width, `32 - L` */
  width: number;
  /** `shr_s` (sign-extend) rather than `shr_u` */
  signed: boolean;
  /** the scale's shift amount, `L - R` */
  shift: number;
  /** the `shl` — where the extension begins */
  inner: Op;
}

/** The fused pair rooted at `op`, or null for any shape the header's refusal list names. The ONE
 *  reading of it: the fold below and raise/globalshape.ts's stride reader both ask here. */
export function scaledExtensionOf(op: Op | undefined, defs: Map<Value, Op>): ScaledExtension | null {
  if (!op || (op.opcode !== 'shr_u' && op.opcode !== 'shr_s') || op.operands.length !== 1) {
    return null;
  }
  const inner = defs.get(op.operands[0]);
  const r = op.attrs.imm;
  const l = inner?.attrs.imm;
  if (inner?.opcode !== 'shl' || inner.operands.length !== 1 || typeof r !== 'number' || typeof l !== 'number') {
    return null;
  }
  if (!CAST_WIDTHS.has(32 - l) || r <= 0 || r >= l) {
    return null;
  }
  return { src: inner.operands[0], width: 32 - l, signed: op.opcode === 'shr_s', shift: l - r, inner };
}

/** Does `target` lower a narrowing cast to a shift pair — the gate the fold shares with the cast
 *  idiom itself. */
export const foldsShiftPairCasts = (target: TargetDescription): boolean =>
  CAST_PATTERNS.every((p) => patternApplies(p, target));

/** Rewrite every fused pair to `shl(ext(src), shift)`, the extension spliced in at the `shl`'s
 *  position and the scale at the right shift's. Returns the number of pairs folded; the `shl`s
 *  left without a reader are the pass driver's DCE. */
export function foldScaledExtensions(fn: Fn): number {
  const defs = defOpMap(fn);
  const blockOf = new Map<Op, Block>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      blockOf.set(op, b);
    }
  }
  const exts = new Map<Op, Map<boolean, Op>>();
  let folded = 0;
  for (const b of fn.blocks) {
    for (const op of [...b.ops]) {
      const m = scaledExtensionOf(op, defs);
      if (m === null) {
        continue;
      }
      const bySign = exts.get(m.inner) ?? exts.set(m.inner, new Map()).get(m.inner)!;
      let ext = bySign.get(m.signed);
      if (ext === undefined) {
        ext = mkOp(m.signed ? 'sext' : 'zext', {
          operands: [m.src],
          results: [mkValue(m.inner.results[0].type)],
          attrs: { width: m.width },
        });
        const home = blockOf.get(m.inner)!;
        home.ops.splice(home.ops.indexOf(m.inner), 0, ext);
        bySign.set(m.signed, ext);
      }
      const scaled = mkOp('shl', {
        operands: [ext.results[0]],
        results: [mkValue(op.results[0].type)],
        attrs: { imm: m.shift },
      });
      b.ops.splice(b.ops.indexOf(op), 1, scaled);
      replaceAllUsesWith(fn, op.results[0], scaled.results[0]);
      folded++;
    }
  }
  return folded;
}
