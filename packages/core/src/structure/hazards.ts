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
// WHAT MAKES A SUNK COPY LEGAL. The exit edge's value is not moved, it is REBUILT: the copy lands
// at the top of the body and spells the arg's def-tree again there. Two things have to hold — the
// tree gives the same answer there, and every name it reads still denotes the same value — and the
// arg gates in `PREUPDATE_SINK_GATES` are those two plus the degenerate leaf that is neither.
//
// The tree must give the same answer at the new point. Two ways it might not, and `REEVAL_UNSAFE_OPS`
// is the registry view that names both. ORDER: the copy opens the body, so a load in the tree would
// move ahead of every store the body makes, and an effect would move against the others.
// SPECULATION: the def dominates the latch, and the loop is single-latch at both call sites, but an
// early-`return` arm still lets an iteration leave BEFORE the latch — so a tree the top of the body
// evaluates is one that iteration never evaluated, and a trapping divide would fault where the
// original returned.
//
// One gate covers both because `REEVAL_UNSAFE_OPS` answers both, and the candidate carries no arm
// information to tell them apart. KNOWN COST: a loop with NO early-return arm speculates nothing,
// so a divide in its exit-arg tree is refused for a hazard it cannot have. Threading "this loop can
// leave before its latch" into the candidate is what would recover it; no benchmark row asks yet.
//
// And every name the rebuilt expression reads must still denote the same value there. A loop
// variable does: the update sits at the bottom, so at the top of the body its name holds exactly
// the value the edge read. A name the body itself defines does NOT — at the top of the body it
// still holds the previous iteration.
//
// KNOWN GAP: `body` is the natural-loop body, which EXCLUDES the blocks an early-return arm owns
// even though their statements are emitted inside the loop. A name assigned only in such an arm is
// invisible to both predicates below. Harmless while an arm leaves the function — nothing after it
// reads the name — and an arm that merely breaks would need it.
//
// Every check is PURE: it reads the analysis maps and decides, nothing mutates.
//
// The factory takes its dependencies EXPLICITLY (`LoopHazardDeps`), the switch-recover pattern.
// The maps are captured as LIVE REFERENCES, deliberately: `varName` is still being populated by
// the naming pipeline when the factory is created, and each hazard check reads whatever names
// exist at CALL time (emission runs after naming completes). Snapshotting them would break this.
import { Block, Op, Value } from '../ir/core';
import { NEGATED_ICMP, REEVAL_UNSAFE_OPS } from '../ir/opcodes';
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
  /** defs that emit as named temps at their own position (analysis.ts) — `loopWriteSet` reads it
   *  to see the in-place write an adopted materialized def performs. LIVE, like `varName`. */
  materialize: Set<Op>;
  /** Ops whose LOWERING discards their operand tree and spells something else — today the
   *  bitfield-extract fold, which renders a global member read in place of a shift pair. A walk
   *  over the operands cannot see what such an op will render, so predicates that reason about
   *  the rendered expression have to treat it as opaque. LIVE, like `varName`. */
  respelledDefs: ReadonlyMap<Op, unknown>;
}

export interface LoopHazards {
  readsClobbered(v: Value, sub: Map<Value, string>, updateWrites: Set<string>): boolean;
  loopEscapeHazard(
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region?: Set<Block> | null,
  ): boolean;
  loopUpdateHazard(
    condV: Value,
    exitArgs: Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region: Set<Block> | null,
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
  loopWriteSet(updates: Stmt[], bodyBlocks: Iterable<Block>, header: Block): Set<string>;
}

/** The names a loop update assigns (its non-identity copies) — the write set every loop-emission
 *  hazard check tests against. Dependency-free, so a plain function, not a factory member. */
export const updateWriteSet = (updates: Stmt[]): Set<string> =>
  new Set(updates.filter((st): st is Extract<Stmt, { k: 'assign' }> => st.k === 'assign').map((st) => st.name));

/** Why an exit arg cannot be REBUILT at the top of the loop body — see the note above
 *  `PREUPDATE_SINK_GATES`. The walk collects EVERY one it finds, not the first: with one blocker
 *  per gate, stopping early would let ablating one gate disable another on any tree where the
 *  other's blocker happens to be found first, and the ablation would then be measuring less than
 *  its name says. */
export type ArgBlocker = 'order-sensitive' | 'stale-name' | 'no-definition';

/** One exit slot weighed for sinking. `destName` is the name the sunk copy would write. */
export interface SinkCandidate {
  /** everything that stops the arg's def-tree from being rebuilt at the top of the body */
  argBlockers: ReadonlySet<ArgBlocker>;
  destName: string | undefined;
  /** the names of the loop's own variables */
  headerNames: ReadonlySet<string | undefined>;
  /** the names the emitted update assigns */
  updateWrites: ReadonlySet<string>;
  /** some other value under `destName` is read inside the loop */
  destBusyInLoop: boolean;
}

/** When a pre-update exit copy may move into the loop body. The set-level
 *  rules — two slots wanting one name, a slot that stays behind reading a sunk name — are not in
 *  the table because they are properties of the whole edge rather than of a candidate; they live in
 *  `sinkablePreUpdateSlots` with the same refusal discipline. */
export const PREUPDATE_SINK_GATES: readonly Gate<SinkCandidate>[] = [
  {
    id: 'arg-safe-to-reevaluate',
    why: 'an effect, a memory read or a trap gives a different answer where the rebuilt copy lands',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating arg-safe-to-reevaluate admits an exit arg that reads memory',
    rejects: (c) => c.argBlockers.has('order-sensitive'),
  },
  {
    id: 'arg-reads-current-names',
    why: 'a value computed in the body still holds the PREVIOUS iteration at the top of it, where the copy lands',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating arg-reads-current-names admits an arg over a body-computed name',
    rejects: (c) => c.argBlockers.has('stale-name'),
  },
  {
    id: 'arg-has-a-definition',
    why: 'a leaf with neither a name nor a def renders as a gap, which the contract catches loudly',
    sound: false,
    rejects: (c) => c.argBlockers.has('no-definition'),
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
  const { defs, varName, useSitesOf, liveIn, opBlock, materialize, respelledDefs } = deps;

  // The names one loop iteration writes under its VARIABLES' names: the update copies, plus a
  // loop-variable name a materialized body def writes IN PLACE. Adoption (seedLoopParams) makes
  // that def's update copy an identity — elided, so `updateWriteSet(updates)` alone no longer
  // carries the name — but the write still happens mid-body via sideEffects, and a
  // pre-update-read check keyed on the write set is blind to it without this. Non-param
  // materialized names stay out: a fresh temp is assigned once per iteration, so an
  // out-of-position read of it is the current value, not a stale one (its zero-trip hazard is
  // the kept-guard site's separate check).
  const loopWriteSet = (updates: Stmt[], bodyBlocks: Iterable<Block>, header: Block): Set<string> => {
    const writes = updateWriteSet(updates);
    const paramNames = new Set(header.params.map((p) => varName.get(p)));
    for (const bb of bodyBlocks) {
      for (const op of bb.ops) {
        const r = op.results[0];
        const nm = r !== undefined && materialize.has(op) ? varName.get(r) : undefined;
        if (nm !== undefined && paramNames.has(nm)) {
          writes.add(nm);
        }
      }
    }
    return writes;
  };

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
  ): boolean => {
    // Body-block PARAMS escape too: a param whose adopted name the update writes reads post-loop as
    // the clobbered value. ONE rule covers every one of them, and the loop's own carried params —
    // which this used to exempt outright — are not special.
    //
    // THE EXEMPTION WAS DELETED, NOT NARROWED, and it could not have been narrowed: the only
    // condition under it is `escaped && the update writes the name`, so any exemption implying
    // NOT that is already the answer the rule gives, and any exemption admitting it is the
    // unconditional one back again. There is no third predicate, which is why `loopParams` is
    // gone from this file rather than tightened inside it.
    //
    // The unconditional exemption was a SILENT MISCOMPILE. Its rationale — "a post-loop read of
    // the updated name is exactly the intended final value" — holds for the BACK-EDGE ARG, which
    // `sub` maps, and not for the PARAM, which is one update behind. Both loop emitters that used
    // to pass a nonempty exemption set put the update at the BOTTOM of the body (the self-loop
    // `while` and the do-while), so exiting means the update already ran: post-loop the name holds
    // the value the test failed on, while the param meant the value at the top of that last
    // iteration. agbcc spells the difference out — `add r3,r1,#0 … add r1,r3,#1 … str r3` keeps a
    // second register precisely so the store gets `i-1`, and the emitted C stored `i`. It
    // compiled, it scored, and nothing in the tree noticed.
    //
    // Measured in BOTH directions before it shipped: over 121 generated loop shapes across two
    // seeds, each reference and each lift COMPILED NATIVELY AND EXECUTED over an identical buffer
    // with the buffer hash as the verdict, all 76 semantically-wrong lifts became declines and all
    // 14 correct ones kept lifting with an identical hash — no correct lift lost, none left
    // silently wrong. And THIS CLAUSE — not the predicate around it — has ZERO REACH on everything
    // the repo owns, which is instrumented rather than argued and is worth stating per disjunct,
    // because they share one decline message. Over all 732 `.s` in the klonoa checkout (426 lift /
    // 306 decline, both gap modes; 469 of them under `asm/`, 257 / 212) `loopUpdateHazard` fires 4
    // times on the CONDITION and once on an escaped op RESULT, and 0 times here. Over the 2737
    // candidates the 205 agbcc synthetic rows enumerate: 1 condition, 2 exit args, 1 op result, 0
    // here — `synthetic:preupdate_escape` included, which declines on its op result. sa3's 16 are
    // TU-level asm and lift none. So the 121-shape rig is THIS clause's whole evidence base and a
    // corpus sweep cannot renew it, while the surrounding predicate is exercised by five rows.
    //
    // AND IT IS A DECLINE ONLY BECAUSE OF HOW THE VALUE IS SPELLED. `sinkablePreUpdateSlots`
    // below REPAIRS the same hazard — it re-emits the copy inside the body ahead of the update —
    // whenever the pre-update value crosses the exit as an edge ARG. The identical program with
    // the value read from the header PARAM instead reaches here, and there is no exit slot to
    // sink. Reproduced side by side in test/loop-preupdate-escape.ts: `cond_br %5, ^bb1(%4),
    // ^bb2(%2)` lifts to `do { v1 = v0; v0 = v0 + 1; } while (v0 < a1); a0[1] = v1;` — the agbcc
    // listing above — where `^bb2()` reading `%2` declines. Routing the param spelling into the
    // sink (normalising the escape into an exit slot, or widening the sink's candidates to body
    // params read post-loop) is the consolidation, and it is a structure.ts change with a fan
    // effect on every row, not an edit to this predicate.
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
        // `varName.get` is absent for a param no name was adopted for; `updateWrites` holds
        // names, so an absent one is correctly not among them.
        const n = varName.get(pv);
        if (n !== undefined && updateWrites.has(n) && escaped(pv)) {
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
  ): boolean =>
    readsClobbered(condV, sub, updateWrites) ||
    exitArgs.some((a) => readsClobbered(a, sub, updateWrites)) ||
    loopEscapeHazard(body, sub, updateWrites, region);

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
  //
  // The third parallel-copy question — one sunk slot's REBUILT expression reading another sunk
  // slot's destination — needs no rule, and the copies are emitted sequentially because of it.
  // Every leaf such an expression could read is already refused by a per-candidate gate: a header
  // param makes the other slot fail `dest-not-loop-variable`; a body-defined value is
  // `stale-name`; and a value defined outside the loop but read on the exit edge is live-in at the
  // header (analysis.ts counts a successor arg as a use at the predecessor's end), which makes the
  // other slot fail `dest-free-inside-loop`.
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
    // An op with no `opBlock` entry counts as INSIDE: the map is total over the function, and the
    // safe direction for an absent one is the answer that refuses.
    const definedInBody = (v: Value): boolean => {
      const d = defs.get(v);
      if (!d) {
        return [...body].some((bb) => bb.params.includes(v));
      }
      const b = opBlock.get(d);
      return b === undefined || body.has(b);
    };
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
        if (liveIn.get(header)!.has(v) || definedInBody(v)) {
          return true;
        }
      }
      return false;
    };
    // Is `v` defined by the loop body itself — an op in one of its blocks, or a block param?
    // Everything that stops `a` from being REBUILT at the top of the body. Walks the def-tree
    // where `exprWith(null)` will when the copy is spelled — stopping at a NAMED value, which
    // renders as its name, and at a value with no reaching def, which renders as a gap.
    //
    // The walk OVER-approximates what renders, which is the safe direction: `lowerDef` recurses
    // only through `e(d.operands[...])`, so every value it reaches is one this visited. Two things
    // would break that. A lowering reaching for a value OUTSIDE its op's operands — none does
    // today, and it is the change to watch for. And a lowering that DISCARDS the operand tree and
    // spells something else: `respelledDefs` is that case, refused outright below rather than
    // walked, because what it renders is a memory read this walk would never have seen.
    //
    // `undef` and `laddr` render a name from their own side maps rather than `varName`, and both
    // are position-independent — an `undef` is never assigned, a `laddr` is an address.
    const blockersOf = (a: Value): ReadonlySet<ArgBlocker> => {
      const seen = new Set<Value>();
      const found = new Set<ArgBlocker>();
      const walk = (x: Value): void => {
        if (seen.has(x)) {
          return;
        }
        seen.add(x);
        if (header.params.includes(x)) {
          return; // a loop variable: at the top of the body its name holds exactly this
        }
        const n = varName.get(x);
        if (n !== undefined) {
          if (definedInBody(x) || headerNames.has(n) || busyInLoop(n, x)) {
            found.add('stale-name');
          }
          return;
        }
        const d = defs.get(x);
        if (!d) {
          found.add('no-definition');
          return;
        }
        if (REEVAL_UNSAFE_OPS.has(d.opcode) || respelledDefs.has(d)) {
          found.add('order-sensitive');
        }
        d.operands.forEach(walk);
      };
      walk(a);
      return found;
    };
    const dest = new Map<number, string>();
    exitArgs.forEach((a, j) => {
      if (!readsClobbered(a, sub, updateWrites)) {
        return; // no hazard on this slot — nothing to repair
      }
      const destName = varName.get(exit.params[j]);
      const c: SinkCandidate = {
        argBlockers: blockersOf(a),
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

  return { readsClobbered, loopEscapeHazard, loopUpdateHazard, sinkablePreUpdateSlots, sameAtEntry, loopWriteSet };
}

/** THE WRITE RELOCATION THE UNDEF EDGE-COPY ELISION CANNOT SEE, as a postcondition on a whole
 *  function. `undefCarriesNothing` (structure.ts) drops the copy into `name` on the edge out of
 *  `pred` after proving no value in `name`'s class has a definition able to run before that edge.
 *  It reads each such definition's home off `paramBlock`/`opBlock`, and a SUNK pre-update exit copy
 *  is written somewhere else than its home says: its destination is the loop EXIT's param, so the
 *  model homes it after the loop, while `preUpdateCopies` really writes it at the top of the body,
 *  on every iteration, ahead of any edge inside that body.
 *
 *  Nothing today puts the two together — a merge inside the body that adopted the exit param's name
 *  is a block param `definedInBody` sees, so `dest-free-inside-loop` refuses the sink before it
 *  starts. But that gate carries its own KNOWN GAP (the natural-loop body excludes an early-return
 *  arm's blocks, so a name assigned only there is invisible to it), which makes the pair a
 *  conjecture rather than a proof. Checked here so that a widening of either — a broader sink, or a
 *  naming pass that lets a body merge adopt an exit param's name — DECLINES instead of silently
 *  substituting a defined value for the undefined one the machine leaves in place.
 *
 *  `reaches` is the caller's reachability (structure.ts's `reachFrom`), passed in so this stays a
 *  pure function of the two records. Returns the colliding name, or null. */
export function sunkCopyOverDroppedUndef(
  drops: ReadonlyArray<{ name: string; pred: Block }>,
  sunkCopies: ReadonlyArray<{ name: string; home: Block }>,
  reaches: (home: Block, pred: Block) => boolean,
): string | null {
  for (const d of drops) {
    for (const s of sunkCopies) {
      if (s.name === d.name && (s.home === d.pred || reaches(s.home, d.pred))) {
        return d.name;
      }
    }
  }
  return null;
}
