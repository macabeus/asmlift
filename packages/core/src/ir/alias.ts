// asmlift — memory DISJOINTNESS: the one place that answers "could this write change what that
// read sees". A pure query over L2 (typed SSA); no structuring or emission state.
//
// It exists because the answer was being given at three different strengths in three places, the
// weakest one governing the most common case (the materialization model's multi-render load rule,
// which barred on ANY write). A read that is barred by a store to an unrelated global is spelled
// as a named local the source never had — the "value home" defect the round-5 dogfood measured as
// its single highest cost. One predicate, one strength, one place to sharpen.
//
// The rule is deliberately NAME-based and deliberately narrow:
//
//   • two DIFFERENT named globals are different objects, so a store through one can never change
//     what a read of the other sees. That is a C guarantee about distinct declared objects, not a
//     heuristic about what the compiler happened to do.
//   • name comparison suffices because the pool promotion picks ONE canonical name per address,
//     so a single cell cannot appear under two names within one function (frontend/thumb.ts).
//   • anything that does not resolve to a name — a materialized base, a variable index, a pointer
//     parameter — is unknown, and unknown BARS. A call or an `opaque` bars unconditionally: it may
//     write anything.
//
// Being conservative here costs at most a match (an extra local the compiler would have folded);
// being wrong here is a silently wrong read. Every relaxation must keep that asymmetry.
import { type Op, type Value } from './core';

/** A byte cell of a named global: the symbol plus the byte offset within it. */
export interface GlobalCell {
  name: string;
  byte: number;
}

/**
 * The named global cell an address value denotes, resolved through defs alone — `gaddr`, or
 * `gaddr + const` in either operand order — plus the access's own `off`. Null when the address
 * does not reduce to a name (a materialized base, a runtime index, a pointer): the caller must
 * then treat it as unknown memory.
 */
export function globalCellOf(defs: Map<Value, Op>, addr: Value, off: number): GlobalCell | null {
  const d = defs.get(addr);
  if (d?.opcode === 'gaddr') {
    return { name: d.attrs.sym as string, byte: off };
  }
  if (d?.opcode === 'add' && d.operands.length === 2) {
    for (const [x, y] of [
      [d.operands[0], d.operands[1]],
      [d.operands[1], d.operands[0]],
    ] as const) {
      const g = defs.get(x);
      const c = defs.get(y);
      if (g?.opcode === 'gaddr' && c?.opcode === 'const') {
        return { name: g.attrs.sym as string, byte: (c.attrs.value as number) + off };
      }
    }
  }
  return null;
}

/**
 * "May op `x` write the global named `sym`?" — the predicate a read of `sym` must clear on every
 * path between its def and each of its render positions (analysis.ts `memWriteBetween`).
 *
 * Calls and opaques always may. A store/astore may unless its base resolves to a DIFFERENT named
 * global. Everything else (pure arithmetic, loads) never writes.
 */
export function mayWriteGlobal(defs: Map<Value, Op>, sym: string): (x: Op) => boolean {
  return (x: Op): boolean => {
    if (x.opcode === 'call' || x.opcode === 'opaque') {
      return true;
    }
    if (x.opcode !== 'store' && x.opcode !== 'astore') {
      return false;
    }
    const t = globalCellOf(defs, x.operands[0], 0);
    return !(t && t.name !== sym);
  };
}
