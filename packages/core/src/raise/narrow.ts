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
import { Fn, Op, Value } from '../ir/core';
import { CAST_WIDTHS, Opcode } from '../ir/opcodes';

/** WHICH BITS a narrowing op keeps, as a key two ops can be compared on. The two spellings live in
 *  different bit-domains — `zext {width:w}` keeps the LOW `w` bits, `shr_u {imm:k}` keeps bits
 *  `[k,32)` and moves them down — so a shared integer key would pair a `zext` with a `shr_s` of the
 *  same operand and rewrite `x >> 16` into `(s16)(u16)x`: a different value, silently. `width` is
 *  the C cast the pair collapses to. */
const domainOf = (op: Op, low: Opcode, high: Opcode): { key: string; width: number } | null => {
  if (op.opcode === low && CAST_WIDTHS.has(op.attrs.width as number)) {
    return { key: `low${op.attrs.width}`, width: op.attrs.width as number };
  }
  if (op.opcode === high && typeof op.attrs.imm === 'number' && CAST_WIDTHS.has(32 - (op.attrs.imm as number))) {
    return { key: `high${op.attrs.imm}`, width: 32 - (op.attrs.imm as number) };
  }
  return null;
};

/** Re-root a sign extension on the co-existing zero extension of the same bits. Returns the number
 *  of rewrites. */
export function rerootNarrowReads(fn: Fn): number {
  // LOOP-CARRIED edge arguments only. The rewrite is sound for ANY co-existing pair — it only
  // re-associates two extensions of the same bits — so this gate is about what it BUYS, not about
  // what is safe. It buys a name: an argument whose own operand chain reads the parameter it feeds
  // is that parameter's next value, i.e. a loop variable, which the structurer materializes and
  // renders `(s16)i`. Anywhere else the re-root only puts `(s16)(u16)x` where `(s16)x` stood —
  // byte-identical through agbcc, so noise for nothing.
  const defs = new Map<Value, Op>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const res of op.results) {
        defs.set(res, op);
      }
    }
  }
  const feedsBack = (from: Value, param: Value): boolean => {
    const seen = new Set<Value>();
    for (const stack = [from]; stack.length;) {
      const v = stack.pop()!;
      if (v === param) {
        return true;
      }
      if (seen.has(v)) {
        continue;
      }
      seen.add(v);
      for (const o of defs.get(v)?.operands ?? []) {
        stack.push(o);
      }
    }
    return false;
  };
  const carried = new Set<Value>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors ?? []) {
        s.args.forEach((a, i) => {
          const param = s.block.params[i];
          if (param !== undefined && feedsBack(a, param)) {
            carried.add(a);
          }
        });
      }
    }
  }
  let rewritten = 0;
  for (const b of fn.blocks) {
    // Same block, zero extension FIRST: the rewrite makes the sign extension read it, so anywhere
    // else this could be a use before a def. That is the shape the idiom emits — one increment,
    // both extensions of it, in the block that computes it.
    const unsigned = new Map<Value, Map<string, Value>>();
    for (const op of b.ops) {
      const u = domainOf(op, 'zext', 'shr_u');
      if (u !== null && carried.has(op.results[0])) {
        const byDomain = unsigned.get(op.operands[0]) ?? new Map<string, Value>();
        byDomain.set(u.key, op.results[0]);
        unsigned.set(op.operands[0], byDomain);
        continue;
      }
      const sgn = domainOf(op, 'sext', 'shr_s');
      if (sgn === null) {
        continue;
      }
      const zx = unsigned.get(op.operands[0])?.get(sgn.key);
      if (zx === undefined) {
        continue;
      }
      // Both spellings collapse to the one op the backend prints as a cast, so the `shr_s` form
      // drops its `imm` with the rest of its attrs. Rewritten IN PLACE, against the engine's usual
      // discipline (pattern/engine.ts), because the result `Value` identity has to survive: every
      // existing use of the sign extension must keep reading it.
      //
      // SLOT HOMES (ir/core.ts `SlotHomes`) do not move here, and this is the one of the three
      // direct operand writers where that had to be checked rather than assumed. This substitutes
      // a new READ operand, it does not retire a value: the extension's source keeps its use in
      // the `zext` that `zx` is the result of, so a home stamped on it is still carried by a value
      // the graph reaches. Nothing is replaced function-wide, so `replaceAllUsesWith`'s
      // propagation is not owed one here.
      op.opcode = 'sext';
      op.operands = [zx];
      op.attrs = { width: sgn.width };
      rewritten++;
    }
  }
  return rewritten;
}
