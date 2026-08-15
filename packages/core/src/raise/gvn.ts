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
// destroys it into a local and every later access reads it. The source it came from had no such
// variable — it just named the global at each use, and let the compiler decide where to put the
// address. In emitted C, that is the whole difference:
//
//     before:  v5 = (u16 *)&gBgTilemapBufs;   …   v5[594] = v5[659];
//     after:   gBgTilemapBufs[0][594] = gBgTilemapBufs[0][659];
//
// RUNS FIRST in PRE_RECOVERY_PASSES: collapsing addresses removes block params every later
// recognizer would otherwise have to reason around, and it can only shrink the value graph.
//
// SOUNDNESS. `gaddr` takes no operands and reads no memory: its result is a function of its `attrs`
// alone, so two with equal attrs are equal in every execution, on every path, always. Replacing all
// of them with ONE definition is exact.
//
// THE ADMISSION RULE IS `gaddr`, NOT "operand-free and pure" — and the difference is the whole
// safety argument, so do not relax it to the general-sounding version. `const` is ALSO operand-free
// and pure, and numbering consts function-wide would be actively harmful: structure/analysis.ts
// materializes a multi-use `const` that is live across a call into a named local, and its own
// comment records that this exact widening ("the small-constant regression") already cost matches
// once. The gate is a MATCHING policy, not a property of the opcode — which is why it is not a flag
// on the opcode table, where `const` would satisfy it.
//
// PLACEMENT. One fresh definition per class is created in the ENTRY block, which dominates every
// REACHABLE block — so no reachable use can precede it (unreachable blocks are excluded from the
// scan for exactly that reason; see `reachable` below) (the originals are deleted rather than moved — a fresh Value
// keeps the rewrite uniform, including for a duplicate that was already in the entry block). That is safe here precisely because the op is free: `gaddr` lowers to
// nothing on its own — the structurer inlines a pure non-`const` value at each use site (see
// analysis.ts, whose materialize-into-a-local rule covers `const`, `call` and the memory reads, NOT
// address ops), so the address is re-spelled at each access exactly as the original source did.
// Hoisting therefore does not create the long live range that hoisting a LOADED value would.
//
// SCOPE, deliberately narrow: `code: true` symbols (a promoted function pointer, spelled `(u32)Name`
// rather than `&Name`) are numbered separately from data ones, because the attr is part of what the
// value renders as.
//
// THE WIN IS CONTINGENT ON THE SYMBOL MAP, which is worth knowing before relying on it. With a map
// supplying an array's rank the accesses render as `gSym[0][i]`, a `var` base that
// `l3/basecse.ts`'s `isHoistableBase` cannot see, so nothing re-creates the local this pass
// deleted. WITHOUT a map (verified by running the row map-less) the same accesses spell as
// `addr`, basecse sees the reuse, and it hoists a function-top `p0 = (u16 *)&gBgTilemapBufs` —
// the same local, one level up. Three modules now answer "is this
// address a local?" with independent policies (here: never; basecse: when reused 2+ times;
// l3/scopebase.ts: at the innermost scope), and reconciling them is recorded debt.
import { Block, Fn, Op, Value, mkOp, replaceAllUsesWith } from '../ir/core';

/** Ops whose result depends on `attrs` alone — no operands, no memory, no control flow. */
const NUMBERABLE = new Set(['gaddr', 'laddr']); // laddr: same argument — operand-free, pure, attr-keyed

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
  // REACHABLE blocks only. The entry dominates everything REACHABLE — it does not dominate an
  // unreachable block, and verify()'s dominator fixpoint models that faithfully (a block with no
  // predecessors converges to dom = {itself}). Numbering a group with a member in such a block
  // deletes its local definition and leaves the use reading one the entry holds, which fails
  // `def does not dominate use` — turning a fully-decompiled function into an ASMLIFT_ERROR stub.
  // Loud, not silent, but a real loss: the thumb frontend deliberately KEEPS unreachable blocks
  // ("Other unreachable blocks are LEFT ALONE"), so this shape is supported, not malformed.
  const reachable = new Set<Block>();
  const walk = (b: Block): void => {
    if (reachable.has(b)) {
      return;
    }
    reachable.add(b);
    for (const op of b.ops) {
      for (const s of op.successors) {
        walk(s.block);
      }
    }
  };
  if (fn.blocks[0]) {
    walk(fn.blocks[0]);
  }
  const groups = new Map<string, { op: Op; block: number }[]>();
  fn.blocks.forEach((b, bi) => {
    if (!reachable.has(b)) {
      return;
    }
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
