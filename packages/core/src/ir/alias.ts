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
//
// A SECOND PREMISE LIVES HERE, on different evidence and for a different clientele:
// `disjointConstSlots` — the same base VALUE, both accesses at a constant offset and width, and
// byte ranges that do not overlap. Where the name rule above is about two declared OBJECTS, this
// one is about two byte ranges of whatever single object one base denotes, so it needs no name and
// asserts nothing about which object that is: `p->field_0` and `p->field_4` are different cells
// whether `p` points at a global, a local or a parameter. Narrow in the same direction — a
// different base value or a runtime index BARS — and it COMPOSES with the name rule rather than
// widening it: a caller asks whichever question its evidence can answer, and a bar from either
// stands.
//
// ONE OTHER PLACE ANSWERS THE SAME QUESTION, on a different premise, and it is not reachable from
// here: `l3/unreduce.ts`'s `moved-read-aliasable` gate, which asks whether moving a read down to
// the point that re-reads it lets the writes it crosses change what it sees. It runs on L3, where there are no `Value`s
// and no `defs` map to resolve, and the addresses it is about are RAW CONSTANTS — precisely the
// case in which `globalCellOf` returns null and everything here bars. What it uses instead is the
// TARGET's declared device-register range (`capabilities.deviceRegisters`): a write to a hardware
// register is not a write to any object a C program declares, so no STORE THE C PERFORMS over that
// span can change an ordinary read. That is a fact about the board rather than about C, which is
// why it is a target capability and not a rule in this file. The asymmetry above is kept in both:
// everything the range does not place BARS.
//
// AND IT IS NOT THE WHOLE ANSWER, which this comment used to claim it was. The sentence above
// covers the CPU's stores and stops there — a DMA controller reads a control word and then WRITES
// ORDINARY MEMORY on the program's behalf, so a span whose every write is a "device register"
// write can still rewrite the cell a moved read reads. Executed with the transfer modelled, the
// admitted candidate turned a clean destination walk into wild writes. The second half of the
// claim is therefore a second datum, `capabilities.deviceMemoryWriters`, and what it does not
// settle is settled by the DIFFER instead (`Candidate.matchOnly`) rather than by a wider licence.
// The lesson generalises past this file: a premise about the board is still a premise, and one
// stated as an aside in a comment gets copied rather than checked — this one reached four files
// before anything executed it.
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
 * The NUMERIC address an access denotes, resolved through defs alone — a literal base, or the sum
 * of two literals — plus the access's own `off`. Null when the address
 * does not reduce to a literal: a `gaddr` (ask {@link globalCellOf} instead), a parameter, a
 * materialized base, anything carrying a runtime term.
 *
 * The caller that has one asks a question about the BOARD — "is this cell a hardware register" —
 * so a null here must be read as "unknown", never as "ordinary memory".
 */
export function constAddressOf(defs: Map<Value, Op>, addr: Value, off: number): number | null {
  const d = defs.get(addr);
  if (d?.opcode === 'const') {
    return (d.attrs.value as number) + off;
  }
  if (d?.opcode === 'add' && d.operands.length === 2) {
    const a = defs.get(d.operands[0]);
    const b = defs.get(d.operands[1]);
    if (a?.opcode === 'const' && b?.opcode === 'const') {
      return (a.attrs.value as number) + (b.attrs.value as number) + off;
    }
  }
  return null;
}

/**
 * Are these two accesses through ONE base provably different byte cells — same base value, both at
 * a constant offset and width, ranges non-overlapping? The everyday struct interleave
 * `… = p->field_0; p->field_4 = …`, where the store cannot change what the load sees even though
 * neither side resolves to a named global.
 *
 * False on anything less certain, which is what the callers need: a different base value, or an
 * access with no constant slot to compare. `off`/`width` are contract-required on `load`/`store`
 * (ir/opcodes.ts), so the casts are defensive; the comparisons are the ones the fused call site in
 * structure/analysis.ts made, NaN behaviour included.
 */
export function disjointConstSlots(load: Op, store: Op): boolean {
  if (store.operands[0] !== load.operands[0]) {
    return false;
  }
  const lo = load.attrs.off as number,
    lw = load.attrs.width as number;
  const so = store.attrs.off as number,
    sw = store.attrs.width as number;
  return so + sw <= lo || lo + lw <= so;
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
