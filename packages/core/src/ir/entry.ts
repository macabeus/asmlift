// asmlift — does a test placed ahead of a loop compute the loop's own test on the loop's entry values?
//
// Two passes ask exactly that, at two levels, and both read the answer from this one predicate:
//   • structure's GUARD FUSION (`structure.ts`, through `hazards.ts`): the `if` a rotated loop is
//     wrapped in is deleted when it is the loop's test at the first iteration, and the loop re-tests;
//   • raise's RE-ROLL (`raise/reroll.ts`): a loop test the compiler peeled into the loop's entry is
//     deleted when it is the latch's test at the values the entry hands the loop.
//
// The reading is STRUCTURAL, never semantic: two values are the same when they are one value, or
// when their defining ops have one opcode, one set of attributes and operands that are the same in
// turn. A false negative costs a loud decline, the direction to be wrong in. `entry` models the
// first iteration: on the loop side (`a`), a value it maps is read as the value it maps to, and
// below that substitution the walk is in the entry's world, where the map no longer applies — a
// loop-invariant back-edge argument read inside the entry's own expression is itself there, not the
// param it feeds.
//
// `normalize` adds the equalities the re-roll needs and guard fusion does not take: an `add` or
// `or` of a constant 0 on EITHER side, commutative operands in either order, and a load off
// `base + c` as the same load off `base` at its offset plus `c` (`str[0]` against `str[i]` at
// `i = 0`). Each is an identity of the integer operators, so turning it on for guard fusion is a
// spelling decision, not a soundness one.
import { Op, Value } from './core';
import { spelledWhenDead } from './discipline';
import { NEGATED_ICMP } from './opcodes';

export interface EntryReading {
  /** the value each loop-side value holds on the loop's first iteration */
  readonly entry: ReadonlyMap<Value, Value>;
  /** values whose defining op may be read through; everything else compares by identity. Default:
   *  every value. An operand-free op that reads no memory (a constant, a symbol address) is always
   *  read through: it is its attributes wherever it sits. */
  readonly through?: (v: Value) => boolean;
  /** the identities above, beyond `x + 0` / `x - 0` / `x | 0` with the zero on the right */
  readonly normalize?: boolean;
}

/** Opcodes whose two operands may be read in either order, under `normalize`. */
const COMMUTES = new Set(['add', 'mul', 'and', 'or', 'xor', 'icmp_eq', 'icmp_ne']);

/** Is `a` (loop side), read on the loop's entry values, the same value as `b`? With `negated`, is it
 *  `b`'s logical opposite — the usual case where a guard spells the loop's test the other way round. */
export function sameAtEntry(
  defs: ReadonlyMap<Value, Op>,
  a: Value,
  b: Value,
  reading: EntryReading,
  negated = false,
): boolean {
  const { entry, through = () => true, normalize = false } = reading;
  const readable = (v: Value): boolean => {
    const d = defs.get(v);
    return d !== undefined && (through(v) || (d.operands.length === 0 && !spelledWhenDead(d)));
  };
  const constOf = (v: Value): number | null => {
    const d = defs.get(v);
    return d?.opcode === 'const' && typeof d.attrs?.value === 'number' ? d.attrs.value : null;
  };
  /** A constant `v` reads as: under `normalize`, as its entry substitution reads. */
  const constAt = (v: Value, atEntry: boolean): number | null => constOf(normalize ? view(v, atEntry).x : v);
  /** `x0` as the comparison reads it: through the entry map while on the loop side (`!atEntry`), and
   *  with `x + 0` / `x - 0` / `x | 0` read as `x` — substituting a loop variable by its init constant
   *  turns ordinary index arithmetic into exactly these. */
  function view(x0: Value, atEntry0: boolean): { x: Value; atEntry: boolean } {
    let x = x0;
    let atEntry = atEntry0;
    for (;;) {
      const mapped = atEntry ? undefined : entry.get(x);
      if (mapped !== undefined) {
        x = mapped;
        atEntry = true;
        continue;
      }
      const d = readable(x) ? defs.get(x) : undefined;
      if (!d || d.operands.length !== 2 || !['add', 'sub', 'or'].includes(d.opcode)) {
        return { x, atEntry };
      }
      if (constAt(d.operands[1], atEntry) === 0) {
        x = d.operands[0];
      } else if (normalize && d.opcode !== 'sub' && constAt(d.operands[0], atEntry) === 0) {
        x = d.operands[1];
      } else {
        return { x, atEntry };
      }
    }
  }
  /** A load's address as a base and a constant offset, the `+ c` of an `add` folded in. */
  const address = (d: Op, atEntry0: boolean): { base: Value; off: number; atEntry: boolean } => {
    const off = Number(d.attrs.off ?? 0);
    const { x: base, atEntry } = view(d.operands[0], atEntry0);
    const ad = readable(base) ? defs.get(base) : undefined;
    if (ad?.opcode === 'add' && ad.operands.length === 2) {
      for (const k of [0, 1]) {
        const c = constAt(ad.operands[k], atEntry);
        if (c !== null) {
          return { base: ad.operands[1 - k], off: off + c, atEntry };
        }
      }
    }
    return { base, off, atEntry };
  };
  const attrsOf = (d: Op, drop: string | null) =>
    JSON.stringify(Object.fromEntries(Object.entries(d.attrs ?? {}).filter(([k]) => k !== drop)));
  // memoised per (x, y, side): a value its own consumer reads twice would otherwise double the work
  // at every level
  const memo = new Map<string, boolean>();
  const ids = new Map<Value, number>();
  const id = (v: Value) => ids.get(v) ?? (ids.set(v, ids.size), ids.size - 1);
  /** `da` (read with `atEntry`) and `db` (the entry's own) compute the same value. */
  const sameOp = (da: Op, db: Op, opcodeOk: boolean, atEntry: boolean): boolean => {
    if (!opcodeOk || da.operands.length !== db.operands.length) {
      return false;
    }
    if (normalize && da.opcode === 'load' && db.opcode === 'load') {
      const x = address(da, atEntry);
      const y = address(db, true);
      return x.off === y.off && attrsOf(da, 'off') === attrsOf(db, 'off') && same(x.base, x.atEntry, y.base);
    }
    if (attrsOf(da, null) !== attrsOf(db, null)) {
      return false;
    }
    if (da.operands.every((o, i) => same(o, atEntry, db.operands[i]))) {
      return true;
    }
    return (
      normalize &&
      COMMUTES.has(da.opcode) &&
      da.operands.length === 2 &&
      same(da.operands[0], atEntry, db.operands[1]) &&
      same(da.operands[1], atEntry, db.operands[0])
    );
  };
  function same(x0: Value, atEntry0: boolean, y0: Value): boolean {
    const { x, atEntry } = view(x0, atEntry0);
    const { x: y } = view(y0, true);
    if (x === y) {
      return true;
    }
    const key = `${id(x)},${id(y)},${atEntry ? 1 : 0}`;
    const hit = memo.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const da = readable(x) ? defs.get(x) : undefined;
    const db = readable(y) ? defs.get(y) : undefined;
    const r = !!da && !!db && sameOp(da, db, da.opcode === db.opcode, atEntry);
    memo.set(key, r);
    return r;
  }
  if (!negated) {
    return same(a, false, b);
  }
  const { x, atEntry } = view(a, false);
  const { x: y } = view(b, true);
  const da = readable(x) ? defs.get(x) : undefined;
  const db = readable(y) ? defs.get(y) : undefined;
  return !!da && !!db && sameOp(da, db, NEGATED_ICMP[da.opcode] === db.opcode, atEntry);
}
