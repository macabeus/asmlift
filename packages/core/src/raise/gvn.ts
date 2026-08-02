// asmlift — value numbering for OPERAND-FREE PURE definitions (today: `gaddr`).
//
// A compiler materializes a global's address wherever it needs one. Two arms of an `if` that both
// touch `gTable` each get their own pool load, so the frontend lifts two DISTINCT SSA values that
// denote the same address, and a merge of those arms gets a block param over them:
//
//     ^bb6:  %29 = gaddr {sym="gBgTilemapBufs"}   br ^bb9(%29)
//     ^bb8:  %43 = gaddr {sym="gBgTilemapBufs"}   br ^bb9(%43)
//     ^bb9(%45: u16*):  … %45[594] …
//
// Nothing downstream can see that `%29` and `%43` are equal, so `%45` is a real phi: the structurer
// destroys it into a local (`v5 = (u16 *)&gBgTilemapBufs;` in every arm) and every later access
// reads that local. The source it came from had no such variable — it just named the global at each
// use, and let the compiler decide where to put the address. The invented local is the difference.
//
// SOUNDNESS. `gaddr` takes no operands and reads no memory: its result is a function of its `attrs`
// alone, so two with equal attrs are equal in every execution, on every path, always. Replacing all
// of them with ONE definition is exact — this is the narrowest possible value numbering, and it is
// why the pass is restricted to operand-free ops rather than generalized to pure arithmetic (which
// would need a real congruence closure and dominance reasoning about its operands).
//
// PLACEMENT. The single survivor is moved to the ENTRY block, which dominates everything, so no use
// can precede its definition. That is safe here precisely because the op is free: `gaddr` lowers to
// nothing on its own — the structurer inlines a pure non-`const` value at each use site (see
// analysis.ts, whose materialize-into-a-local rule covers `const`, `call` and the memory reads, NOT
// address ops), so the address is re-spelled at each access exactly as the original source did.
// Hoisting therefore does not create the long live range that hoisting a LOADED value would.
//
// SCOPE, deliberately narrow: `code: true` symbols (a promoted function pointer, spelled `(u32)Name`
// rather than `&Name`) are numbered separately from data ones, because the attr is part of what the
// value renders as.
import { Fn, Op, Value, mkOp, replaceAllUsesWith } from '../ir/core';

/** Ops whose result depends on `attrs` alone — no operands, no memory, no control flow. */
const NUMBERABLE = new Set(['gaddr']);

/** The value-number key: the opcode plus every attribute, in a stable order. */
function keyOf(op: Op): string {
  const attrs = Object.keys(op.attrs)
    .sort()
    .map((k) => `${k}=${String(op.attrs[k])}`)
    .join(',');
  return `${op.opcode}(${attrs})`;
}

/**
 * Collapse operand-free pure definitions that share a key down to one apiece, defined in the entry
 * block. Returns the number of definitions removed (0 when nothing changed).
 */
export function numberPureValues(fn: Fn): number {
  const groups = new Map<string, { op: Op; block: number }[]>();
  fn.blocks.forEach((b, bi) => {
    for (const op of b.ops) {
      if (NUMBERABLE.has(op.opcode) && op.results.length === 1) {
        const k = keyOf(op);
        groups.set(k, [...(groups.get(k) ?? []), { op, block: bi }]);
      }
    }
  });

  const entry = fn.blocks[0];
  let removed = 0;
  const hoisted: Op[] = [];
  for (const dups of groups.values()) {
    if (dups.length < 2) {
      continue; // nothing to number — a single definition already dominates its own uses
    }
    // One fresh definition for the class. A fresh Value (rather than reusing the first duplicate's)
    // keeps the rewrite uniform: every original result is replaced, including the one in the entry
    // block, so no path is left reading a definition this pass has moved.
    const survivor = dups[0].op;
    const value: Value = { type: survivor.results[0].type };
    hoisted.push(
      mkOp(survivor.opcode as Parameters<typeof mkOp>[0], { results: [value], attrs: { ...survivor.attrs } }),
    );
    for (const d of dups) {
      replaceAllUsesWith(fn, d.op.results[0], value);
      removed++;
    }
  }
  if (hoisted.length === 0) {
    return 0;
  }
  // Drop every numbered definition, then seed the survivors at the entry block's head. Done as a
  // filter over each block's op list rather than by index, because the replacement above may have
  // rewritten successor args and left the op lists otherwise untouched.
  const dead = new Set<Op>([...groups.values()].filter((d) => d.length >= 2).flatMap((d) => d.map((x) => x.op)));
  for (const b of fn.blocks) {
    b.ops = b.ops.filter((op) => !dead.has(op));
  }
  entry.ops.unshift(...hoisted);
  return removed;
}

/**
 * Drop block params whose every incoming edge carries the SAME value — the phi is then a pure alias
 * of it and exists only because the frontend built one per merge.
 *
 * The natural partner of the numbering above, and useless without it: two `gaddr`s of one symbol
 * only become "the same value" once they ARE one value. Left in place, such a param is a real phi to
 * the structurer, which destroys it into a local and assigns it in every arm — inventing the
 * variable the original source did not have.
 *
 * DOMINANCE is free: if every predecessor's edge passes `v`, then `v` is defined before each of
 * those terminators, and every path into the block goes through one of them — so `v` dominates the
 * block and every use the param had.
 *
 * A back-edge arg that is the PARAM ITSELF is ignored when deciding, the standard self-referential
 * case: `p = phi(v, p)` is still just `v`. Iterated to a fixpoint, because removing one param can
 * make the next redundant.
 */
export function dropRedundantParams(fn: Fn): number {
  let dropped = 0;
  for (;;) {
    let changed = false;
    for (const b of fn.blocks) {
      if (b === fn.blocks[0] || b.params.length === 0) {
        continue; // entry params are the function's own parameters, not a merge
      }
      for (let i = b.params.length - 1; i >= 0; i--) {
        const p = b.params[i];
        const incoming: Value[] = [];
        for (const pr of fn.blocks) {
          for (const s of pr.ops[pr.ops.length - 1]?.successors ?? []) {
            if (s.block === b) {
              incoming.push(s.args[i]);
            }
          }
        }
        const distinct = [...new Set(incoming.filter((v) => v !== p))];
        if (incoming.length === 0 || distinct.length !== 1) {
          continue;
        }
        replaceAllUsesWith(fn, p, distinct[0]);
        b.params.splice(i, 1);
        for (const pr of fn.blocks) {
          for (const s of pr.ops[pr.ops.length - 1]?.successors ?? []) {
            if (s.block === b) {
              s.args.splice(i, 1);
            }
          }
        }
        dropped++;
        changed = true;
      }
    }
    if (!changed) {
      return dropped;
    }
  }
}
