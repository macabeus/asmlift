// asmlift structurer — the checks a loop emitter runs BEFORE it commits to a loop form, so it can
// decline loud instead of miscompiling. Two questions live here:
//
//   • may this loop's updates be emitted before its condition/exit/post-loop reads, or would some
//     read then see a clobbered (post-update) value that the original IR read PRE-update — and
//     which of those reads can be REPAIRED by moving the copy into the body (`sinkable…`);
//   • is a value the emitted form DROPS redundant — `sameAtEntry`, which reads an expression on
//     the loop's entry state so a guard about to be fused away can be checked against the test
//     that replaces it.
//
// Every check is PURE: it reads the analysis maps and decides, nothing mutates.
//
// The factory takes its dependencies EXPLICITLY (`LoopHazardDeps`), the switch-recover pattern.
// The maps are captured as LIVE REFERENCES, deliberately: `varName` is still being populated by
// the naming pipeline when the factory is created, and each hazard check reads whatever names
// exist at CALL time (emission runs after naming completes). Snapshotting them would break this.
import { Block, Op, Value } from '../ir/core';
import { NEGATED_ICMP } from '../ir/opcodes';
import { Stmt } from '../l3/ast';
import { type Gate, firstRejection } from '../l3/gates';
import type { UseSite } from './analysis';

export interface LoopHazardDeps {
  /** value → defining op (defOpMap) */
  defs: Map<Value, Op>;
  /** value → adopted variable name — LIVE: populated by the naming pipeline, read at call time */
  varName: Map<Value, string>;
  /** every positioned use of a value (analysis.ts) */
  useSitesOf: Map<Value, UseSite[]>;
  /** values read at-or-after each block's entry (analysis.ts) */
  liveIn: Map<Block, Set<Value>>;
  /** op → the block holding it (analysis.ts) */
  opBlock: Map<Op, Block>;
}

export interface LoopHazards {
  readsClobbered(v: Value, sub: Map<Value, string>, updateWrites: Set<string>): boolean;
  loopEscapeHazard(
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region?: Set<Block> | null,
    loopParams?: Set<Value>,
  ): boolean;
  loopUpdateHazard(
    condV: Value,
    exitArgs: Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region: Set<Block> | null,
    loopParams: Set<Value>,
  ): boolean;
  sinkablePreUpdateSlots(
    header: Block,
    exit: Block,
    exitArgs: readonly Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    gates?: readonly Gate<SinkCandidate>[],
  ): Set<number>;
  sameAtEntry(a: Value, b: Value, entry: Map<Value, Value>, negated?: boolean): boolean;
}

/** The names a loop update assigns (its non-identity copies) — the write set every loop-emission
 *  hazard check tests against. Dependency-free, so a plain function, not a factory member. */
export const updateWriteSet = (updates: Stmt[]): Set<string> =>
  new Set(updates.filter((st): st is Extract<Stmt, { k: 'assign' }> => st.k === 'assign').map((st) => st.name));

/** One exit slot weighed for sinking. `destName` is the name the sunk copy would write. */
export interface SinkCandidate {
  /** the exit arg is one of the loop's own variables, not something computed from them */
  argIsLoopVariable: boolean;
  destName: string | undefined;
  /** the names of the loop's own variables */
  headerNames: ReadonlySet<string | undefined>;
  /** the names the emitted update assigns */
  updateWrites: ReadonlySet<string>;
  /** some other value under `destName` is read inside the loop */
  destBusyInLoop: boolean;
}

/** When a pre-update exit copy may move into the loop body. Every gate here is SOUND: drop one and
 *  the emitted loop computes a different answer, not merely a worse-scoring one. The set-level
 *  rules — two slots wanting one name, a slot that stays behind reading a sunk name — are not in
 *  the table because they are properties of the whole edge rather than of a candidate; they live in
 *  `sinkablePreUpdateSlots` with the same refusal discipline. */
export const PREUPDATE_SINK_GATES: readonly Gate<SinkCandidate>[] = [
  {
    id: 'arg-is-loop-variable',
    why: 'an expression moved into the body is recomputed, and an effectful one runs a different number of times',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating arg-is-loop-variable admits a computed exit arg',
    rejects: (c) => !c.argIsLoopVariable,
  },
  {
    // The update assigns exactly the loop variables' names, so these two tests are one set today;
    // both are spelled so the rule does not rest on that coincidence.
    id: 'dest-not-loop-variable',
    why: 'a copy into a name the loop itself assigns is overwritten by the update, or is a self-assignment',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating dest-not-loop-variable admits a self-assignment',
    rejects: (c) => c.destName === undefined || c.headerNames.has(c.destName) || c.updateWrites.has(c.destName),
  },
  {
    id: 'dest-free-inside-loop',
    why: 'the name already denotes a value the loop reads, which a write at the top of the body clobbers',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating dest-free-inside-loop admits a name the loop still reads',
    rejects: (c) => c.destBusyInLoop,
  },
];

export function makeLoopHazards(deps: LoopHazardDeps): LoopHazards {
  const { defs, varName, useSitesOf, liveIn, opBlock } = deps;

  // Does rendering `v` under `sub` read a variable that a pending loop update (`updateWrites`, the
  // names it assigns) overwrites, via a path OTHER than a `sub`-mapped back-edge arg? Such a read is a
  // PRE-update value the update clobbers → a read-after-write hazard when the update is emitted first.
  // Walks the def-tree exactly like `exprWith`, stopping at `sub` values (intended post-update → safe)
  // and named values (a var: hazard iff its name is a write-target). Pure (no mutation), so it is safe
  // to call before emitting.
  const readsClobbered = (v: Value, sub: Map<Value, string>, updateWrites: Set<string>): boolean => {
    const seen = new Set<Value>();
    const walk = (x: Value): boolean => {
      if (seen.has(x)) {
        return false;
      }
      seen.add(x);
      if (sub.has(x)) {
        return false;
      } // sub-mapped → post-update, safe
      if (varName.has(x)) {
        return updateWrites.has(varName.get(x)!);
      } // a named var: hazard iff clobbered
      const d = defs.get(x);
      return d ? d.operands.some(walk) : false; // inline (mirrors exprWith's recursion)
    };
    return walk(v);
  };

  // A value computed INSIDE a loop and used after it renders post-loop under `sub`, where each
  // updated loop variable already holds its FINAL value. That is only correct when every
  // loop-variable read goes through a sub-mapped back-edge arg (the intended post-update read); a
  // direct read of an updated variable meant the LAST-ITERATION PRE-update value, which the
  // post-loop name no longer holds. Scans every value defined in `body` for a use outside it (or,
  // when `region` is given, inside that specific post-loop region) whose rendering readsClobbered
  // flags. Same hazard test the early-exit path applies to its condition and edge args.
  const loopEscapeHazard = (
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region: Set<Block> | null = null,
    loopParams: Set<Value> = new Set(),
  ): boolean => {
    // Body-block PARAMS escape too: a non-loop-carried param whose adopted name the update writes
    // reads post-loop as the clobbered value. canTakeName prevents that adoption, so this firing
    // means a naming bug — decline loud, never emit. The loop's own carried params (`loopParams`)
    // are exempt: their post-loop read of the updated name is exactly the intended final value.
    const escaped = (v: Value): boolean => {
      for (const s of useSitesOf.get(v) ?? []) {
        if (region ? region.has(s.blk) : !body.has(s.blk)) {
          return true;
        }
      }
      return false;
    };
    for (const bb of body) {
      for (const pv of bb.params) {
        if (loopParams.has(pv)) {
          continue;
        }
        if (escaped(pv) && updateWrites.has(varName.get(pv)!)) {
          return true;
        }
      }
      for (const op of bb.ops) {
        for (const r of op.results) {
          if (escaped(r) && readsClobbered(r, sub, updateWrites)) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // The loop-emission hazard check, in ONE place (shared by the guard-fused, early-exit, and
  // do-while sites): the loop condition, the exit-edge args, and every escaped body value must
  // read loop variables ONLY through sub-mapped back-edge args (post-update); any direct read of
  // an updated name is a pre-update value the emitted C no longer holds. Callers keep their
  // distinct decline behavior.
  const loopUpdateHazard = (
    condV: Value,
    exitArgs: Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region: Set<Block> | null,
    loopParams: Set<Value>,
  ): boolean =>
    readsClobbered(condV, sub, updateWrites) ||
    exitArgs.some((a) => readsClobbered(a, sub, updateWrites)) ||
    loopEscapeHazard(body, sub, updateWrites, region, loopParams);

  // Which pre-update exit copies can be REPAIRED instead of declined. The exiting edge hands a
  // loop variable's top-of-iteration value to a merge param, and post-loop that name has moved on
  // one iteration; emitting the copy inside the body, AHEAD of the update, restores it — the
  // trailing-pointer idiom (`for (fast = slow = head; ...; fast = fast->next) slow = fast;`).
  // Returns the exit slots that may move; the caller emits them at the top of the body and drops
  // them from the post-loop copies.
  //
  // The idiom reaches here at all because the compiler DID keep a second register for the trailing
  // value and SSA construction folded the copy away, leaving the exit edge as the only place the
  // value is still named. Where the compiler kept two loop-carried registers instead, the value is
  // a back-edge arg and the un-rotation substitution already reads it — no repair needed.
  //
  // `PREUPDATE_SINK_GATES` holds the per-candidate refusals, ablatable one at a time. Two rules are
  // properties of the EDGE rather than of a candidate and stay here: the exit edge is a PARALLEL
  // copy, so splitting it across two program points must not let two slots claim one name, nor let
  // a slot that stays behind read a name the body now writes first.
  const sinkablePreUpdateSlots = (
    header: Block,
    exit: Block,
    exitArgs: readonly Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    gates: readonly Gate<SinkCandidate>[] = PREUPDATE_SINK_GATES,
  ): Set<number> => {
    const none = new Set<number>();
    const headerNames = new Set(header.params.map((p) => varName.get(p)));
    // Does any value OTHER than `self` under `name` live inside the loop? A value defined outside
    // it and read anywhere in the body must be live-in at the header, the loop's only entry, so
    // that check plus the body's own defs and params covers every way the name is still in use.
    // The loop's OWN variables are left to `dest-not-loop-variable` — a header param is also a
    // body param, so the two gates partition the names instead of overlapping.
    const busyInLoop = (name: string, self: Value): boolean => {
      for (const [v, n] of varName) {
        if (n !== name || v === self || header.params.includes(v)) {
          continue;
        }
        const d = defs.get(v);
        if (liveIn.get(header)!.has(v) || (d && body.has(opBlock.get(d)!))) {
          return true;
        }
        for (const bb of body) {
          if (bb.params.includes(v)) {
            return true;
          }
        }
      }
      return false;
    };
    const dest = new Map<number, string>();
    exitArgs.forEach((a, j) => {
      if (!readsClobbered(a, sub, updateWrites)) {
        return; // no hazard on this slot — nothing to repair
      }
      const destName = varName.get(exit.params[j]);
      const c: SinkCandidate = {
        argIsLoopVariable: header.params.includes(a),
        destName,
        headerNames,
        updateWrites,
        destBusyInLoop: destName !== undefined && busyInLoop(destName, exit.params[j]),
      };
      if (firstRejection(gates, c) === null) {
        dest.set(j, destName!);
      }
    });
    const names = new Set(dest.values());
    if (dest.size === 0 || names.size !== dest.size) {
      return none;
    }
    return exitArgs.some((a, j) => !dest.has(j) && readsClobbered(a, sub, names)) ? none : new Set(dest.keys());
  };

  // `x + 0` / `x - 0` / `x | 0` are `x`. Substituting a loop variable by its init constant turns
  // ordinary index arithmetic into exactly these, and a guard that spells the same value without
  // the arithmetic would otherwise compare unequal.
  const fold = (v: Value): Value => {
    const d = defs.get(v);
    if (!d || d.operands.length !== 2 || !['add', 'sub', 'or'].includes(d.opcode)) {
      return v;
    }
    const z = defs.get(d.operands[1]);
    return z?.opcode === 'const' && z.attrs?.value === 0 ? fold(d.operands[0]) : v;
  };

  // Does `a`, read on a loop's ENTRY values, denote the same thing as `b`? `entry` maps each header
  // param and back-edge arg to the arg the forward edge passes, so substituting through it models
  // the FIRST iteration — the state a guard in front of the loop tested. `negated` compares against
  // b's logical opposite instead, for the usual case where a guard spells the loop's own test the
  // other way round (`beq` to the exit vs `bne` to the header).
  //
  // Structural, not semantic: distinct ops with the same opcode, attributes and operands compare
  // equal (two `const 0`s do), anything else does not. A false negative costs a loud decline, which
  // is the direction to be wrong in. Memoised like `readsClobbered`'s `seen`: a value its own
  // consumer reads twice would otherwise double the work at every level.
  const sameAtEntry = (a: Value, b: Value, entry: Map<Value, Value>, negated = false): boolean => {
    const memo = new Map<Value, Map<Value, boolean>>();
    const sameOp = (da: Op, db: Op, opcodeOk: boolean): boolean =>
      opcodeOk &&
      da.operands.length === db.operands.length &&
      JSON.stringify(da.attrs ?? null) === JSON.stringify(db.attrs ?? null) &&
      da.operands.every((o, i) => same(o, db.operands[i]));
    const same = (x0: Value, y0: Value): boolean => {
      const x = fold(entry.get(x0) ?? x0);
      const y = fold(y0);
      if (x === y) {
        return true;
      }
      let row = memo.get(x);
      if (!row) {
        memo.set(x, (row = new Map()));
      }
      const hit = row.get(y);
      if (hit !== undefined) {
        return hit;
      }
      const da = defs.get(x);
      const db = defs.get(y);
      const r = !!da && !!db && sameOp(da, db, da.opcode === db.opcode);
      row.set(y, r);
      return r;
    };
    if (!negated) {
      return same(a, b);
    }
    const da = defs.get(fold(entry.get(a) ?? a));
    const db = defs.get(fold(b));
    return !!da && !!db && sameOp(da, db, NEGATED_ICMP[da.opcode] === db.opcode);
  };

  return { readsClobbered, loopEscapeHazard, loopUpdateHazard, sinkablePreUpdateSlots, sameAtEntry };
}
