// asmlift — array-access LEGALIZATION (L1 → typed `aload`/`astore`).
//
// A compiler materialises a VARIABLE-index array access `a[i]` as an explicit scaled-address
// computation before the memory op —
//
//   sll  t6, a1, 0x2        %s = shl %i {imm=2}         (index << log2 elemSize)
//   addu t7, a0, t6         %p = add %base, %s          (base + scaled index)
//   lw   v0, 0(t7)          %v = load %p {off=0,width=4,signed}
//
// which lifts to `load(add(base, shl(index, k)))` — an untyped byte-address the backend can
// only spell as the uncompilable `*(base + (index << k))` (base was never typed a pointer, and
// the shift would double-scale). This pass recognises that address shape and rewrites the
// access to a typed `aload`/`astore` carrying `elemSize = 1 << k`, so type recovery types
// `base` as `elem *` and structuring lowers it to the neutral `base[index]` index node.
//
// It is LEGALIZATION, not an idiom rewrite: the match needs the relation
// `1 << shiftImm == accessWidth`, which the patterns-as-data idiom layer's `attrEquals`
// (pattern/engine.ts) cannot state. Only the shift-scaled form is handled — elemSize = 1 << k
// (2 or 4 in practice), where the shifted operand is unambiguously the index. The unscaled
// byte form (`add(base, index)`, elemSize 1) is deferred: without types, base and index are
// indistinguishable there.
import { Fn, Op, Value, defOpMap, mkOp, mkValue, replaceAllUsesWith } from '../ir/core';

// If `addr` is `add(base, shl(index, k))` with `1 << k === width`, return {base, index}.
// The `add` is commutative, so the scaled side may be either operand.
function scaledAddress(addr: Value, width: number, defs: Map<Value, Op>): { base: Value; index: Value } | null {
  const add = defs.get(addr);
  if (!add || add.opcode !== 'add' || add.operands.length !== 2) {
    return null;
  }
  for (const [scaledSide, baseSide] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const shl = defs.get(add.operands[scaledSide]);
    if (!shl || shl.opcode !== 'shl' || shl.operands.length !== 1) {
      continue;
    } // must be `shl x {imm}`
    if (1 << (shl.attrs.imm as number) !== width) {
      continue;
    }
    return { base: add.operands[baseSide], index: shl.operands[0] };
  }
  return null;
}

/** Rewrite variable-index `load`/`store` (scaled-address form) into typed `aload`/`astore`.
 *  Returns the number of accesses legalised. Dead address ops are then DCE'd. */
export function recognizeArrays(fn: Fn): number {
  let count = 0;
  const defs = defOpMap(fn);
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      if (op.opcode === 'load' && (op.attrs.off as number) === 0) {
        const m = scaledAddress(op.operands[0], op.attrs.width as number, defs);
        if (!m) {
          continue;
        }
        const res = mkValue(op.results[0].type);
        b.ops[i] = mkOp('aload', {
          operands: [m.base, m.index],
          results: [res],
          attrs: { elemSize: op.attrs.width as number, signed: op.attrs.signed as boolean },
        });
        replaceAllUsesWith(fn, op.results[0], res);
        count++;
      } else if (op.opcode === 'store' && (op.attrs.off as number) === 0) {
        const m = scaledAddress(op.operands[0], op.attrs.width as number, defs);
        if (!m) {
          continue;
        }
        b.ops[i] = mkOp('astore', {
          operands: [m.base, m.index, op.operands[1]],
          attrs: { elemSize: op.attrs.width as number },
        });
        count++;
      }
    }
  }
  // the now-dead `add`/`shl` address computation is reaped by the DRIVER's dce
  // (pre-recovery.ts declares `dce: true` for this pass)
  return count;
}
