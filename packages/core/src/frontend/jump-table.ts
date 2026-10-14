// asmlift — what the MIPS and PowerPC jump-table recognizers share.
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
import type { Block, Value } from '../ir/core';
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
