// asmlift — what the jump-table recognizers share: the MIPS and PowerPC idiom matchers below, and,
// for all three frontends, what an elided dispatch leaves in its registers (at the end of this file).
//
// Both frontends recover a dense switch from its dispatch idiom BEFORE the CFG is built, because
// the case count decides the block leaders: the bounds branch becomes a `switch_br`, and the
// dispatch block it guards is pruned unread. Two facts about that pruning are ISA-neutral, and live
// here so a fix to one reaches both:
//
// - THE DISPATCH BLOCK HAS ONE ENTRY. A branch landing inside it skips the bounds check, and the
//   block it enters is the one pruned (`entersBetween`). Nor may one land between the bounds
//   compare and the branch that reads it: that path brings its own compare, and the `switch_br`
//   would bound it by one it never ran (PowerPC's `boundsCompare`; MIPS's `mipsBounds` reads each
//   edge into the block instead, because IDO puts the `sltiu` in their delay slots). The pruning is
//   then CHECKED on the built CFG, not assumed (`refuseReachableDispatch`): a table's case is an
//   edge too, and no table existed while the recognizer looked, so a case landing in its own or
//   another table's dispatch block keeps that block reachable, and its indirect jump would lift as
//   whatever the frontend reads it as (MIPS reads a non-`ra` `jr` as a return).
// - A TABLE BASE FORMED OUTSIDE THAT BLOCK IS NOT PRUNED WITH IT. KMC and gcc 2.7.2 hoist the
//   `lui ; addiu` pair into a loop's preheader, mwcc 2.3.3 hoists `lis ; addi` to the entry, and a
//   register allocator puts the base wherever it likes — a temporary in a leaf, a callee-saved
//   register across a call, an argument register once its argument is dead. The recognizer can only
//   GUESS which pair that is, because it reads instructions, not dataflow. So the pair is lifted
//   like any address — its high half paired with its low half through SSA — and what the low half
//   completes is not a value but a TABLE BASE (`TableBases`): a definition no C expression spells,
//   refused wherever it is read and wherever it reaches a merge, as a pending high half is
//   (frontend/high-half.ts). The dispatch's one claim on it is a PROOF answered by SSA once every
//   block is filled: every path into the bounds block brings that very base in the register the
//   dispatch reads, and no call destroyed it on the way (`SsaBuilder.everyReachingDef`). Keyed by
//   value, not by register — the same reason high-half.ts gives — so a second pair, a rewrite, a
//   path around the pair, a call that clobbers it and a callee-saved restore all answer "no" here,
//   by the SSA's own bookkeeping rather than by a count of the register's mentions.
import { type Block, type Op, type Value, mkOp, mkValue } from '../ir/core';
import { T } from '../ir/types';
import { type FnProto, declaresVoidReturn } from '../proto';
import type { FrontendRefusal } from './errors';
import type { SsaBuilder } from './ssa';

/** Whether any branch lands after the word at `afterAddr`, up to and including the word at
 *  `lastAddr`. Asked of a dispatch block (after its bounds branch, up to its indirect jump), where
 *  such a path skips the bounds check and enters the block a recovered table prunes, and of the
 *  words between a bounds compare and its branch, where it brings a compare of its own. */
export const entersBetween = (
  instrs: ReadonlyArray<{ target?: number }>,
  afterAddr: number,
  lastAddr: number,
): boolean => instrs.some((x) => x.target !== undefined && x.target > afterAddr && x.target <= lastAddr);

/** Refuse a function whose CFG, pruned to what the entry reaches, still holds a block ending in a
 *  recovered dispatch's indirect jump. Recovery replaces that jump with the bounds block's
 *  `switch_br` and lifts nothing of the block it ends, so the block must be unreachable; a branch
 *  or a table case into it says otherwise. `blocks` are the reachable blocks, `recovered` the
 *  addresses of the recovered indirect jumps. */
export function refuseReachableDispatch(
  name: string,
  blocks: ReadonlyArray<{ branch: { addr: number; mnemonic: string } | null }>,
  recovered: ReadonlySet<number>,
  fail: FrontendRefusal,
): void {
  for (const { branch } of blocks) {
    if (branch !== null && recovered.has(branch.addr)) {
      fail(
        `cannot lift '${name}': the recovered jump table's '${branch.mnemonic}' at 0x${branch.addr.toString(16)} ` +
          `is still reachable — a branch or a table case enters its dispatch block past the bounds check`,
      );
    }
  }
}

/** Where a jump table is: the symbol a base's relocations name, and the byte offset into it. */
export interface TableKey {
  sym: string;
  addend: number;
}

const sameKey = (a: TableKey, b: TableKey) => a.sym === b.sym && a.addend === b.addend;

/** The one table base a function's candidate pairs agree on, or null. The recognizer's GUESS for a
 *  base formed outside the dispatch block: several distinct candidates leave it undecided, and the
 *  lift's proof (`TableBases.prove`) is what makes the guess safe to act on. */
export const agreedTable = (candidates: readonly TableKey[]): TableKey | null =>
  candidates.length > 0 && candidates.every((c) => sameKey(c, candidates[0])) ? candidates[0] : null;

/** A recovered dispatch whose table base its own block does not form. */
export interface HoistedDispatch {
  /** the register the dispatch reads the base from */
  reg: string;
  table: TableKey;
}

export interface TableBases {
  /** Whether the low half completing `key` makes a table base: some recovered dispatch reads that
   *  table through a hoisted base. Every other pair is an ordinary address. */
  wants(key: TableKey): boolean;
  /** Record `v` as the address of the table `key`, completed by the instruction at `addr`. */
  record(v: Value, key: TableKey, addr: number): void;
  /** True when `v` is a table base — for a caller that must EXCLUDE one (a guessed call's argument
   *  count must not take a base parked in an argument register for an argument). */
  has(v: Value): boolean;
  /** Reading a register AS A VALUE. A table base is not one, so this refuses. */
  guardRead(name: string, reg: string, v: Value): Value;
  /** The dispatch whose `switch_br` block `b` emits reads `d.reg` as the base of `d.table` at the end
   *  of that block. Checked by `prove`. */
  demand(d: HoistedDispatch, b: number, jumpAddr: number): void;
  /** Every demand holds: each path into its block brings the very table base it reads, undestroyed.
   *  Asked once every block is filled. */
  prove(name: string, ssa: Pick<SsaBuilder, 'everyReachingDef'>): void;
  /** The last line of defence, as for the high halves: a base reaching an operand, a block
   *  parameter or a successor argument has been read as a value through a join, which no
   *  `guardRead` saw. Checked on the finished function. */
  assertNoneEscaped(name: string, blocks: Block[]): void;
}

export function makeTableBases(hoisted: Iterable<HoistedDispatch>, fail: FrontendRefusal): TableBases {
  const wanted = [...hoisted].map((d) => d.table);
  const bases = new Map<Value, TableKey & { addr: number }>();
  const demands: Array<{ d: HoistedDispatch; b: number; jumpAddr: number }> = [];
  const hex = (a: number) => `0x${a.toString(16)}`;
  const refuse = (name: string, v: Value, how: string): never => {
    const t = bases.get(v)!;
    return fail(
      `cannot lift '${name}': the jump table '${t.sym}'+${t.addend}'s base, formed at ${hex(t.addr)}, ${how} — ` +
        `a table's address is the dispatch's alone, and no C expression spells it`,
    );
  };
  return {
    wants: (key) => wanted.some((w) => sameKey(w, key)),
    record: (v, key, addr) => void bases.set(v, { ...key, addr }),
    has: (v) => bases.has(v),
    guardRead(name, reg, v) {
      return bases.has(v) ? refuse(name, v, `is read from ${reg} as a value`) : v;
    },
    demand: (d, b, jumpAddr) => void demands.push({ d, b, jumpAddr }),
    prove(name, ssa) {
      for (const { d, b, jumpAddr } of demands) {
        const isBase = (v: Value) => {
          const t = bases.get(v);
          return t !== undefined && sameKey(t, d.table);
        };
        if (!ssa.everyReachingDef(d.reg, b, isBase)) {
          fail(
            `cannot lift '${name}': the dispatch at ${hex(jumpAddr)} reads the base of jump table '${d.table.sym}'` +
              `+${d.table.addend} from ${d.reg}, and ${d.reg} does not hold that table's address on every path to ` +
              `it — a path around the base, a rewrite, or a call that destroys it`,
          );
        }
      }
    },
    assertNoneEscaped(name, blocks) {
      for (const b of blocks) {
        for (const v of [
          ...b.params,
          ...b.ops.flatMap((op) => [...op.operands, ...op.successors.flatMap((s) => s.args)]),
        ]) {
          if (bases.has(v)) {
            refuse(name, v, 'reaches a use through a merge');
          }
        }
      }
    },
  };
}

// WHAT AN ELIDED DISPATCH LEAVES BEHIND. Every recognizer prunes the dispatch block unread, so the
// registers its idiom writes — the scaled index, the table's base, the entry's address, the loaded
// code address, PowerPC's `ctr` — are written on no path the lift models. The default path never
// ran the idiom, so nothing may be written at the bounds block; the case edges did, so the case
// targets are where it is written: at the ENTRY of each, before its first instruction. A register
// holds what the idiom's LAST write of it left:
//   - the index shift (`lsl`/`sll`/`slwi rI,rS,2`) leaves `rS << 2`, a value C spells. mwcc 2.4.2
//     at -O4 reuses it in the case bodies (`p[i] = 7` in a switch on `i` is `stwx r0,r4,r5` with r5
//     the dispatch's own `slwi`), so it is modelled, not refused. The shift reads the scrutinee as
//     the switch does: every recognizer refuses an idiom that rewrites it before the shift, and the
//     switch reads it where the bounds test did, so the scrutinee at a case's entry is the one the
//     shift read — on a target only the table's case edges enter (EXACT);
//   - every other write leaves an address no C expression spells, so it is a MARKER: an `undef`
//     value that `refuseStaleIdiomReads` declines wherever an operand demands it.
// A target some other edge also enters (the default, a hole naming the default, a loop's back
// edge, a fallthrough from another case: MIXED) cannot tell the paths apart at its entry, so its
// markers stand for what the other paths brought too, and a read of one declines. Its scaled index
// may stand: mwcc 2.4.2 at -O4 keeps it live into such targets — a do-while case re-entered on its
// back edge (`lwzx r0,r4,r3` with r3 the dispatch's `slwi r3,r3,2`), a case falling into the next
// with `slwi r31,r27,2` still in r31. It is the shift of the scrutinee where the `switch_br` read
// it, not where the target reads it (a back edge brings whatever the case left in the scrutinee's
// register), and it stands only where every other path in brings that same scaled index
// (`unsettledScaledIndices`); elsewhere it is a marker. A target two tables enter, and the
// function's entry, whose call edge no `preds` lists, make every register a marker.

/** What an elided dispatch leaves in a register it writes: the scrutinee scaled by four, or an
 *  address no C expression spells. */
export type IdiomLeft = 'scaled' | 'opaque';

/** The registers an elided dispatch's idiom writes, in program order, each with whether it is the
 *  index shift: what each register holds after it, decided by its last writer. */
export function idiomLeaves(writes: ReadonlyArray<{ reg: string; scaled: boolean }>): Map<string, IdiomLeft> {
  const left = new Map<string, IdiomLeft>();
  for (const { reg, scaled } of writes) {
    left.set(reg, scaled ? 'scaled' : 'opaque');
  }
  return left;
}

/** A table whose dispatch block was elided, by block index. */
export interface ElidedDispatch {
  /** the block emitting the `switch_br` */
  at: number;
  /** the bounds-checked scrutinee's register */
  scrutReg: string;
  /** the case targets, one per case */
  cases: readonly number[];
  /** the default target, or null when the out-of-range path is a return of its own */
  defaultBlock: number | null;
  leaves: ReadonlyMap<string, IdiomLeft>;
}

/** A MARKER ({@link staleMarker}): what the idiom left in `reg` that no C expression spells, and
 *  whether the dispatch that left it was kept (its block lifted, holding the code the compiler
 *  placed in it) or elided. A read of one declines ({@link refuseStaleIdiomReads}). */
export interface StaleMarker {
  kind: 'marker';
  reg: string;
  form: 'kept' | 'elided';
  /** Whether the marker stands for the register on EVERY path that brings it ({@link parkedIn}): a
   *  kept dispatch's, and an EXACT target's. A MIXED target's marker also replaced what the other
   *  paths into it brought, so it is read like any value, and its read declines. */
  parks: boolean;
}

/** The scaled index a case target is entered with in `reg` ({@link enterCaseTarget}): no marker
 *  but a value a case may read, recorded for {@link scaledIndexIn} and, on a MIXED target, to be
 *  settled. */
export interface StaleScaledIndex {
  kind: 'scaled';
  reg: string;
  /** the dispatch's block: two tables' scaled indices are different values */
  table: number;
  /** the scrutinee the shift reads, where the dispatch's `switch_br` read it */
  of: Value;
  /** On a MIXED target: the `shl` defining it, the frontend's key for `reg`, and the predecessors
   *  ({@link CaseEntry.others}) every path into whose end must bring the same scaled index. Where
   *  one does not, `refuseStaleIdiomReads` declines a read of it and makes the `shl` a marker. */
  settle?: { op: Op; key: string; others: readonly number[] };
}

/** What an elided or kept dispatch left in a register, by the value standing for it: a marker no
 *  read may reach, or the scaled index a read may reach but a guessed arity may not count. */
export type StaleIdiomRead = StaleMarker | StaleScaledIndex;

/** What a case target's entry holds from an elided dispatch: the scrutinee's register (read for a
 *  `scaled` entry) and each register the idiom wrote. */
export interface CaseEntry {
  scrutReg: string;
  leaves: ReadonlyMap<string, IdiomLeft>;
  /** only the table's case edges enter the target */
  exact: boolean;
  /** the block emitting the table's `switch_br` */
  at: number;
  /** A MIXED target's predecessors other than the table's case edges — `at` itself when the target
   *  is also the default — each of whose paths must bring the scaled index for it to stand there
   *  (`StaleScaledIndex.settle`). Empty on an EXACT target. */
  others: readonly number[];
}

/** Each case target's entry: EXACT (every edge into it is one table's case edge) and MIXED (other
 *  edges enter it too) keep that table's `leaves`, the scaled index settled later on a MIXED one; a
 *  target two tables enter makes every register they wrote a marker. Block 0 does too: the call
 *  that enters a function is an edge no `preds` lists. */
export function caseEntries(
  tables: readonly ElidedDispatch[],
  preds: ReadonlyArray<readonly number[]>,
): Map<number, CaseEntry> {
  const owners = new Map<number, ElidedDispatch[]>();
  for (const t of tables) {
    for (const c of new Set(t.cases)) {
      owners.set(c, [...(owners.get(c) ?? []), t]);
    }
  }
  const out = new Map<number, CaseEntry>();
  for (const [b, ts] of owners) {
    const [t] = ts;
    const own = ts.length === 1 && b !== 0;
    const exact = own && b !== t.defaultBlock && preds[b].every((p) => p === t.at);
    out.set(
      b,
      own
        ? {
            scrutReg: t.scrutReg,
            leaves: t.leaves,
            exact,
            at: t.at,
            others: exact ? [] : [...new Set(preds[b])].filter((p) => p !== t.at || b === t.defaultBlock),
          }
        : {
            scrutReg: t.scrutReg,
            leaves: new Map(ts.flatMap((u) => [...u.leaves.keys()]).map((r) => [r, 'opaque' as const])),
            exact,
            at: t.at,
            others: [],
          },
    );
  }
  return out;
}

/** Write what an elided dispatch left at the entry of case target `entry`'s block, before its first
 *  instruction: `scrutinee` reads the switch's scrutinee there (before any of these writes, which may
 *  overwrite its register), `dispatchScrutinee` at the end of the dispatch's block `entry.at` (null
 *  while that block is unfilled, where a MIXED target's scaled index is a marker instead), `write`
 *  defines a register in the block. Each marker is recorded in `stale` against the register it
 *  stands in, for {@link refuseStaleIdiomReads}, and the scaled index as its own kind, for
 *  {@link scaledIndexIn} and, on a MIXED target, to be settled. */
export function enterCaseTarget(
  entry: CaseEntry,
  ops: Op[],
  io: {
    key: (reg: string) => string;
    scrutinee: (reg: string) => Value;
    dispatchScrutinee: (reg: string) => Value | null;
    write: (reg: string, v: Value) => void;
  },
  stale: Map<Value, StaleIdiomRead>,
): void {
  // On an EXACT target the two reads are one value: its only predecessor is the dispatch's block.
  const of = [...entry.leaves.values()].includes('scaled')
    ? entry.exact
      ? io.scrutinee(entry.scrutReg)
      : io.dispatchScrutinee(entry.scrutReg)
    : null;
  const shl = of === null ? null : mkOp('shl', { operands: [of], results: [mkValue(T.unk(32))], attrs: { imm: 2 } });
  if (shl !== null) {
    ops.push(shl);
  }
  for (const [r, left] of entry.leaves) {
    if (left === 'scaled' && shl !== null) {
      const [scaled] = shl.results;
      io.write(r, scaled);
      const settle = entry.exact ? {} : { settle: { op: shl, key: io.key(r), others: entry.others } };
      stale.set(scaled, { kind: 'scaled', reg: r, table: entry.at, of: of!, ...settle });
      continue;
    }
    io.write(r, staleMarker(ops, io.key(r), { reg: r, form: 'elided', parks: entry.exact }, stale));
  }
}

/** A marker for what the unlifted idiom left in `read.reg`, keyed `key` in the SSA. */
export function staleMarker(
  ops: Op[],
  key: string,
  read: Omit<StaleMarker, 'kind'>,
  stale: Map<Value, StaleIdiomRead>,
): Value {
  const op = mkOp('undef', { results: [mkValue(T.unk(32))], attrs: { key } });
  ops.push(op);
  stale.set(op.results[0], { kind: 'marker', ...read });
  return op.results[0];
}

/** Whether `v`, read from `reg`, is the marker the idiom left in that very register on every path
 *  that brings it — where the compiler parked the dispatch's own value, which no call is handed and
 *  no return hands back. A guessed arity stops below it (`CallSite.parked`). A return reaching only
 *  it returns nothing where the frontend already asks whether a value reaches the return register
 *  (PowerPC's r3, MIPS's v0, each written by the idiom on mwcc and gcc). Thumb asks no such thing — a
 *  return with nothing written in r0 hands back the caller's r0 — so its return reads the marker, and
 *  the read declines unless the function is declared void. A copy into another register is
 *  something the case did with it, and a MIXED target's marker stands in for what another path
 *  brought too (`StaleIdiomRead.parks`): both are read like any value. `key` is the frontend's
 *  register spelling. */
export const parkedIn =
  (stale: ReadonlyMap<Value, StaleIdiomRead>, key: (reg: string) => string = (r) => r) =>
  (v: Value, reg: string): boolean => {
    const s = stale.get(v);
    return s?.kind === 'marker' && s.parks && key(s.reg) === key(reg);
  };

/** Whether `v`, read from `reg`, is the scrutinee scaled by four that an elided dispatch left in that
 *  very register (`enterCaseTarget`). A case reads it freely (`p[i]`), but a guessed arity may not
 *  count it: mwcc 2.4.2 keeps the dispatch's `slwi r4,r3,2` live into its `p[i]` cases, and an
 *  undeclared `g(2)` there is `li r3,2; bl g`, the bytes `g(2, i * 4)` compiles to too. */
export const scaledIndexIn =
  (stale: ReadonlyMap<Value, StaleIdiomRead>, key: (reg: string) => string = (r) => r) =>
  (v: Value, reg: string): boolean => {
    const s = stale.get(v);
    return s?.kind === 'scaled' && key(s.reg) === key(reg);
  };

/** A DISPATCH'S STALE IDIOM REGISTERS MAY NOT BE READ. The dispatch idiom is not lifted, so a marker
 *  ({@link staleMarker}) stands for the table's address, an entry's address or the case's own code
 *  address, none of which a C expression spells. Run on the filled SSA, before `finish` collapses a
 *  join of an undefined value into its other argument: a marker some operand demands, directly or
 *  through the joins that carry it, declines. A `ret` operand demands nothing under a declared
 *  `void` return, which drops it (pipeline.ts `dropVoidReturnOperands`). A MIXED target's scaled
 *  index is settled first ({@link unsettledScaledIndices}): one that does not stand is a marker,
 *  read or not. `fail` is the frontend's own refusal. */
export function refuseStaleIdiomReads(
  name: string,
  irBlocks: readonly Block[],
  stale: ReadonlyMap<Value, StaleIdiomRead>,
  ssa: Pick<SsaBuilder, 'everyReachingDef'>,
  own: FnProto | undefined,
  fail: FrontendRefusal,
): void {
  if (stale.size === 0) {
    return;
  }
  const incoming = new Map<Value, Value[]>();
  for (const blk of irBlocks) {
    for (const op of blk.ops) {
      for (const s of op.successors) {
        s.args.forEach((a, i) => {
          const p = s.block.params[i];
          incoming.set(p, [...(incoming.get(p) ?? []), a]);
        });
      }
    }
  }
  const unsettled = unsettledScaledIndices(irBlocks, stale, incoming, ssa);
  const demanded = new Set<Value>();
  const work: Value[] = [];
  const demand = (v: Value) => {
    if (!demanded.has(v)) {
      demanded.add(v);
      work.push(v);
    }
  };
  const voidReturn = declaresVoidReturn(own);
  for (const blk of irBlocks) {
    for (const op of blk.ops) {
      if (!(op.opcode === 'ret' && voidReturn)) {
        op.operands.forEach(demand);
      }
    }
  }
  while (work.length > 0) {
    (incoming.get(work.pop()!) ?? []).forEach(demand);
  }
  const read = [...stale].flatMap(([v, s]) =>
    demanded.has(v) && (s.kind === 'marker' || unsettled.has(v))
      ? [s.kind === 'marker' ? s : { reg: s.reg, form: 'elided' as const }]
      : [],
  )[0];
  if (read !== undefined) {
    const { reg, form } = read;
    const why =
      "which the unlifted dispatch idiom wrote — the lift would read the value from before the dispatch, not the table's " +
      'index, address or target';
    // one literal per form: the decline classifier (apps/web declines.ts) keys on the text up to `reads`
    fail(
      form === 'kept'
        ? `cannot lift '${name}': a case of the kept jump table reads ${reg}, ${why}`
        : `cannot lift '${name}': a case of the elided jump table reads ${reg}, ${why}`,
    );
  }
  // Read by nothing, so no C spells it; a marker keeps the SSA honest, as the shift's scrutinee need
  // not reach a target some other path enters.
  for (const v of unsettled) {
    const s = stale.get(v) as StaleScaledIndex;
    Object.assign(s.settle!.op, { opcode: 'undef', operands: [], attrs: { key: s.settle!.key } });
  }
}

/** The scaled indices written at MIXED targets that do not stand. One stands where every path into
 *  the end of each of its target's other predecessors brings, in its register, a scaled index of the
 *  same table shifted from the same scrutinee — directly or through joins all of whose inputs do —
 *  with no call destroying it (`SsaBuilder.everyReachingDef`). Those paths include ones through
 *  other MIXED targets, so it is a greatest fixpoint: every guess stands until a path refutes it, and
 *  a refuted one refutes whatever leaned on it. What stands is then exactly what the register holds
 *  on every path into the target: the table's case edges bring the shift the target computes, and
 *  each other edge brings a value computing that same shift. The scrutinee is compared through
 *  joins all of whose other inputs are it, which the trivial-phi pass has yet to fold. */
function unsettledScaledIndices(
  irBlocks: readonly Block[],
  stale: ReadonlyMap<Value, StaleIdiomRead>,
  incoming: ReadonlyMap<Value, readonly Value[]>,
  ssa: Pick<SsaBuilder, 'everyReachingDef'>,
): Set<Value> {
  const pending = [...stale].flatMap(([v, s]) => (s.kind === 'scaled' && s.settle !== undefined ? [{ v, s }] : []));
  const refuted = new Set<Value>();
  if (pending.length === 0) {
    return refuted;
  }
  // the entry block's parameters are the caller's values, whatever its back edges bring
  const entryParams = new Set(irBlocks[0].params);
  const joined = (v: Value) => (entryParams.has(v) ? undefined : incoming.get(v));
  const resolve = (v: Value, seen: Set<Value>): Value => {
    const ins = joined(v);
    if (ins === undefined || seen.has(v)) {
      return v;
    }
    seen.add(v);
    const others = new Set(ins.map((i) => resolve(i, seen)).filter((u) => u !== v));
    return others.size === 1 ? [...others][0] : v;
  };
  const brings = (s: StaleScaledIndex) => {
    const of = resolve(s.of, new Set());
    const seen = new Set<Value>();
    const ok = (u: Value): boolean => {
      const t = stale.get(u);
      if (t?.kind === 'scaled' && t.table === s.table && !refuted.has(u) && resolve(t.of, new Set()) === of) {
        return true;
      }
      const ins = joined(u);
      if (ins === undefined) {
        return false;
      }
      if (seen.has(u)) {
        return true; // a cycle of joins adds no input the first visit did not judge
      }
      seen.add(u);
      return ins.every(ok);
    };
    return ok;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const { v, s } of pending) {
      if (!refuted.has(v) && !s.settle!.others.every((p) => ssa.everyReachingDef(s.settle!.key, p, brings(s)))) {
        refuted.add(v);
        changed = true;
      }
    }
  }
  return refuted;
}
