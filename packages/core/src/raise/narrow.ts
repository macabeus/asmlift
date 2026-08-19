// A NARROW LOOP VARIABLE, kept zero-extended and read sign-extended.
//
// agbcc holds an `s16`/`s8` local in its ZERO-extended form and sign-extends it at each signed use,
// so `for (s16 i = 0; i <= 5; i++)` leaves two extensions of the same increment side by side — one
// for the back edge, one for the loop test:
//
//     %21 = zext %20 {16}      what `i` holds next iteration
//     %22 = sext %20 {16}      the loop test
//
// `sext(zext(v,w),w) === sext(v,w)` — the zext keeps the low `w` bits and the sext reads only
// those — so `%22` IS `sext %21`: a function of the value the loop variable will hold. Spelled
// through `%20` it reaches the variable's PRE-update value, and the structurer's pre-update guard
// refuses that (rightly — rendered as the loop variable it would be one iteration off). Re-rooted
// on `%21` it is `(s16)i`, which is what the source wrote.
//
// The same fact has a second spelling, which the cast idiom cannot fold because the value under the
// shifts is not a bare `shl`: agbcc keeps `i << 16` live when the body wants `i` scaled, and adds
// the increment in the shifted domain.
//
//     %133 = shr_u %132 {16}   what `i` holds next iteration
//     %134 = shr_s %132 {16}   the loop test
//
// A signed and an unsigned right shift of the same value by the same amount differ only in the bits
// the shift brings in, so `%134` is `sext(%133, 32 - 16)` — the same rewrite, and the reason this
// pass matches the pair rather than either extension on its own.
import { Fn, Value } from '../ir/core';

/** Widths `zext`/`sext` carry: a C type the backend can print as a cast. */
const CAST_WIDTHS = new Set([8, 16]);

/** Re-root a sign extension on the co-existing zero extension of the same bits. Returns the number
 *  of rewrites. */
export function rerootNarrowReads(fn: Fn): number {
  // Every value passed along an edge, so the gate below can ask whether the zero extension is one.
  // The rewrite is sound for ANY co-existing pair — it only re-associates two extensions of the
  // same bits — but an edge argument is where a value is guaranteed to be MATERIALIZED under a
  // name, which is what makes the result `(s16)i` rather than `(s16)(u16)x` in place of `(s16)x`.
  const edgeArgs = new Set<Value>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors ?? []) {
        for (const a of s.args) {
          edgeArgs.add(a);
        }
      }
    }
  }
  let rewritten = 0;
  for (const b of fn.blocks) {
    // Same block, zero extension FIRST: the rewrite makes the sign extension read it, so anywhere
    // else this could be a use before a def. That is the shape the idiom emits — one increment,
    // both extensions of it, in the block that computes it.
    const unsigned = new Map<Value, Map<number, Value>>();
    for (const op of b.ops) {
      const narrow =
        op.opcode === 'zext'
          ? (op.attrs.width as number)
          : op.opcode === 'shr_u' && typeof op.attrs.imm === 'number'
            ? 32 - (op.attrs.imm as number)
            : null;
      if (narrow !== null && CAST_WIDTHS.has(narrow) && edgeArgs.has(op.results[0])) {
        const byKey = unsigned.get(op.operands[0]) ?? new Map();
        byKey.set(narrow, op.results[0]);
        unsigned.set(op.operands[0], byKey);
        continue;
      }
      const signed =
        op.opcode === 'sext'
          ? (op.attrs.width as number)
          : op.opcode === 'shr_s' && typeof op.attrs.imm === 'number'
            ? 32 - (op.attrs.imm as number)
            : null;
      if (signed === null) {
        continue;
      }
      const zx = unsigned.get(op.operands[0])?.get(signed);
      if (zx === undefined) {
        continue;
      }
      // Both spellings become the one op the backend prints as a cast, so the `shr_s` form drops
      // its `imm` with the rest of its attrs.
      op.opcode = 'sext';
      op.operands = [zx];
      op.attrs = { width: signed };
      rewritten++;
    }
  }
  return rewritten;
}
