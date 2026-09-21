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
// WHAT MAKES A SUNK COPY LEGAL. The exit edge's value is not moved, it is REBUILT: the copy spells
// the arg's def-tree again inside the body, at the point that tree was already computed at
// (`preUpdateCopyHome`) — or, for an arg the LATCH did not compute, opening it. Two things
// have to hold — the tree gives the same answer there, and every name it reads still denotes the
// same value — and the arg gates in `PREUPDATE_SINK_GATES` are those two plus the degenerate leaf
// that is neither.
//
// The tree must give the same answer at the new point. Two ways it might not, and
// `REEVAL_UNSAFE_OPS` is the registry view that names both. ORDER: a load re-evaluated after a
// store the original preceded answers with what the store wrote, and an effect re-evaluated past
// another is out of order. SPECULATION: a tree evaluated where the original never was — the def
// dominates the latch, and the loop is single-latch at both call sites, but an early-`return` arm
// lets an iteration leave BEFORE it, and a trapping divide would fault where the original returned.
//
// WHICH OF THE TWO APPLIES IS A FACT ABOUT THE POSITION, so `arg-safe-to-reevaluate` asks per slot
// rather than refusing the opcode. At the def's own position nothing is speculated at all: every op
// under the arg dominates that point, so the copy runs only on iterations that evaluated the whole
// tree — the question reduces to ORDER, and to ORDER only against the ops lying strictly between
// each one and the copy (`movesPast`). Opening the body instead, both hazards are live for the
// whole body, and the blanket refusal is the answer.
//
// And every name the rebuilt expression reads must still denote the same value there. A loop
// variable does: the update sits at the bottom, so anywhere ahead of it the name holds exactly the
// value the edge read. A name the body itself defines does NOT, wherever the copy lands ahead of
// the assignment that writes it — and `arg-reads-current-names` refuses every such name rather than
// asking where.
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
import { EFFECTFUL_OPS, NEGATED_ICMP, ORDER_SENSITIVE_OPS, REEVAL_UNSAFE_OPS } from '../ir/opcodes';
import { Expr, Stmt } from '../l3/ast';
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
    condRepaired?: boolean,
  ): boolean;
  preUpdateCondFold(
    condV: Value,
    negated: boolean,
    header: Block,
    backArgs: readonly Value[],
    exitArgs: readonly Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updates: Stmt[],
    updateWrites: Set<string>,
    gates?: readonly Gate<PreUpdateCondCandidate>[],
  ): PreUpdateCondFold;
  sinkablePreUpdateSlots(
    header: Block,
    exit: Block,
    exitArgs: readonly Value[],
    body: Set<Block>,
    latch: Block,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    gates?: readonly Gate<SinkCandidate>[],
  ): Map<number, Op | null>;
  sameAtEntry(a: Value, b: Value, entry: Map<Value, Value>, negated?: boolean): boolean;
  loopWriteSet(updates: Stmt[], bodyBlocks: Iterable<Block>, header: Block): Set<string>;
}

/** The names a loop update assigns (its non-identity copies) — the write set every loop-emission
 *  hazard check tests against. Dependency-free, so a plain function, not a factory member. */
export const updateWriteSet = (updates: Stmt[]): Set<string> =>
  new Set(updates.filter((st): st is Extract<Stmt, { k: 'assign' }> => st.k === 'assign').map((st) => st.name));

/** Why an exit arg cannot be REBUILT inside the loop body — see the note above
 *  `PREUPDATE_SINK_GATES`. The walk collects EVERY one it finds, not the first: with one blocker
 *  per gate, stopping early would let ablating one gate disable another on any tree where the
 *  other's blocker happens to be found first, and the ablation would then be measuring less than
 *  its name says. */
export type ArgBlocker = 'order-sensitive' | 'stale-name' | 'no-definition';

/** One exit slot weighed for sinking. `destName` is the name the sunk copy would write. */
export interface SinkCandidate {
  /** everything that stops the arg's def-tree from being rebuilt inside the body */
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
    guardedBy: 'hazards.test.ts: ablating arg-safe-to-reevaluate admits an exit arg whose read crosses a store',
    rejects: (c) => c.argBlockers.has('order-sensitive'),
  },
  {
    id: 'arg-reads-current-names',
    why: 'a value computed in the body may still hold the PREVIOUS iteration where the copy lands, wherever that is',
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
    why: 'the name already denotes a value the loop reads, which a write inside the body clobbers',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating dest-free-inside-loop admits a name the loop still reads',
    rejects: (c) => c.destBusyInLoop,
  },
];

/** The `++` a bottom test's pre-update read folds into, or the id of the gate that refused it. The
 *  id is what the decline names, so the three reasons this table holds do not reach a reader as one
 *  message. */
export type PreUpdateCondFold = { name: string; by: 1 | -1 } | { refused: string };

/** Why a bottom test's pre-update read of a loop variable cannot be spelled `n++` — see the note
 *  above `PREUPDATE_COND_GATES`. */
export interface PreUpdateCondCandidate {
  /** the step the update spells: `n = n + 1` is 1, `n = n - 1` is -1, anything else null */
  step: 1 | -1 | null;
  /** loop variables the test reads at their pre-update value */
  preUpdateNames: number;
  /** how often the rendered test names THIS variable, its own `++` included */
  mentions: number;
  /** an op in the test renders something its operand tree does not show (a respelled def) */
  unreadable: boolean;
  /** a short-circuit op is reached through an op that is not one, so its arms' reach is unknown */
  nestedConnective: boolean;
  /** an op with an observable effect renders where a short circuit ahead of it may skip it */
  skippedEffect: boolean;
  /** the folded leaf is evaluated on every iteration that takes the back edge */
  onContinue: boolean;
  /** …and on the iteration that leaves the loop */
  onExit: boolean;
  /** the value the update computes is read somewhere other than the back edge */
  updateObserved: boolean;
}

/** When a loop update may be folded into the bottom test that reads the variable BEFORE it —
 *  `do { … } while (v0 != 0 && v1++ <= 9)` in place of an update copy at the foot of the body and a
 *  test one iteration off.
 *
 *  THE FOLD IS ABOUT WHEN THE UPDATE RUNS, and C answers that with the short-circuit operators on
 *  the path from the test's root down to the leaf. Two obligations come out of that, and they are
 *  the two gates a reader should look for first. The back edge carries `n + 1`, so every iteration
 *  that re-enters the loop must have evaluated the `++`: that is `folded-on-every-continue`, and it
 *  is what turns away a leaf under the RIGHT operand of an `||`, where a true left operand
 *  re-enters the loop having skipped it. And after the loop the variable's name is read as the
 *  value the back edge computed (`latchSub`), which the exiting iteration only leaves there if it
 *  evaluated the `++` too — `folded-on-the-exit-too`, asked only where something reads it.
 *
 *  Neither obligation is a claim about where the machine put its own update. Where the two disagree
 *  the emitted C is still correct and the candidate merely does not match, which is the direction to
 *  be wrong in — and on the agbcc shape the fold exists for they agree, because the short-circuit
 *  fold (raise/shortcircuit.ts) is what merged the test's blocks into one in the first place.
 *
 *  A THIRD OBLIGATION IS NOT ABOUT THE COUNTER AT ALL. The fold is the only thing that puts these
 *  loops into a short-circuit spelling, and everything else in the test rides along: an operand the
 *  machine evaluated before its branch renders in an arm the emitted `&&`/`||` may skip. Where that
 *  operand has an EFFECT the emitted loop runs it fewer times than the machine did — a call in the
 *  right arm of an `||` is skipped on every iteration the left arm answers true, and the loop then
 *  returns a different value, not merely a different call count. That is `effects-on-every-iteration`.
 *
 *  It reads the effect flag and no block position, because for an effectful op the two say the same
 *  thing: `HOIST_UNSAFE_OPS` (ir/opcodes.ts) IS `EFFECTFUL_OPS`, so raise/shortcircuit.ts never
 *  lifts one out of the arm it guards, and a genuinely short-circuited effect therefore never
 *  reaches a connective here. A memory read is exempt there and stays exempt here — C's own short
 *  circuit re-guards it at the new point, which is the whole argument that exemption rests on.
 *
 *  `variable-named-once` is C89's own rule rather than this pass's: an object modified between two
 *  sequence points may not be read again there, and `contracts.ts`'s `assertPostIncrUnshared` is the
 *  loud backstop for a later pass bringing a second read in.
 *
 *  NOT THE WHOLE LIST OF REFUSALS on this decision. The gates judge the DEF TREE; `spellUpdateInCond`
 *  (structure.ts) asks the mention count again of what the lowering actually rendered, and throws
 *  its own `StructureError`.
 *
 *  `one-pre-update-variable` is sound for a reason that lives in the CALLER: a fold sets
 *  `condRepaired`, which switches off the whole condition disjunct of `loopUpdateHazard` rather than
 *  the folded name's share of it. A second pre-update variable would then be emitted under its
 *  post-update name with every hazard reporting clean. */
export const PREUPDATE_COND_GATES: readonly Gate<PreUpdateCondCandidate>[] = [
  {
    id: 'test-is-readable',
    why: 'an op that renders something its operand tree does not show hides whether the test names the variable again',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating test-is-readable folds through a respelled def',
    rejects: (c) => c.unreadable,
  },
  {
    id: 'one-pre-update-variable',
    why: 'two variables read ahead of their updates would need both updates folded into one expression',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating one-pre-update-variable repairs one variable and clobbers the other',
    rejects: (c) => c.preUpdateNames !== 1,
  },
  {
    id: 'update-is-a-unit-step',
    why: 'C has no read-then-update operator but ++ and --, so no other update has a spelling inside the test',
    sound: false,
    rejects: (c) => c.step === null,
  },
  {
    id: 'variable-named-once',
    why: 'C89 leaves undefined which value a second read of an object updated in the same expression sees',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating variable-named-once folds a test that reads the variable twice',
    rejects: (c) => c.mentions !== 1,
  },
  {
    id: 'connectives-join-at-the-root',
    why: 'a short-circuit reached through some other op decides its arms against that op, not against the test',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating connectives-join-at-the-root folds an arm of a negated &&',
    rejects: (c) => c.nestedConnective,
  },
  {
    id: 'effects-on-every-iteration',
    why: 'an effect an arm may skip ran ahead of the machine\u2019s branch, so the loop would run it fewer times',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating effects-on-every-iteration folds a test whose arm holds a call',
    rejects: (c) => c.skippedEffect,
  },
  {
    id: 'folded-on-every-continue',
    why: 'a short-circuit ahead of the leaf would skip the update on an iteration that re-enters the loop',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating folded-on-every-continue folds a leaf under the right operand of an ||',
    rejects: (c) => !c.onContinue,
  },
  {
    id: 'folded-on-the-exit-too',
    why: 'the value after the loop is read, so the update has to run on the iteration that leaves as well',
    sound: true,
    guardedBy: 'hazards.test.ts: ablating folded-on-the-exit-too folds a leaf an exiting iteration skips',
    rejects: (c) => c.updateObserved && !c.onExit,
  },
];

/** Whether a position inside the bottom test is evaluated on the iterations where the whole test
 *  answers TRUE, and on the ones where it answers FALSE. Stated about the test's own value rather
 *  than about the loop's edges because the polarity is the caller's (`negated`). */
interface Reach {
  onTrue: boolean;
  onFalse: boolean;
}

const ALWAYS: Reach = { onTrue: true, onFalse: true };

/** The reach each operand of a SHORT-CIRCUIT op inherits. These two are the whole set: they are the
 *  ops `ARITH_TO_BIN` (structure.ts) renders as `&&`/`||` — a test holds the two lists together,
 *  since a connective missing from here is read as an ordinary op and its arms inherit a reach they
 *  do not have — and `Expr` has no conditional form besides them, no ternary, so every other op
 *  evaluates all of its operands whenever it is itself evaluated and they inherit its reach
 *  unchanged.
 *
 *  In `a && b`, `b` runs only where `a` was true: a TRUE whole implies it ran, a FALSE whole does
 *  not. `a || b` is the dual.
 *
 *  BOTH ARMS ARE STATED ABOUT THE OP'S OWN TRUTH, while `Reach` is stated about the WHOLE test's,
 *  so composing them down a chain is only valid where the two are the same value — a spine of
 *  connectives from the root. One `icmp_eq %and, 0` between them inverts the polarity and the arm
 *  answers backwards, which is `connectives-join-at-the-root`'s refusal: a connective reached
 *  through any other op is not read at all. */
export const SHORT_CIRCUIT_ARMS: Readonly<Record<string, (i: number, r: Reach) => Reach>> = {
  logic_and: (i, r) => (i === 0 ? r : { onTrue: r.onTrue, onFalse: false }),
  logic_or: (i, r) => (i === 0 ? r : { onTrue: false, onFalse: r.onFalse }),
};

/** How many values the reach walk may visit. It does not memoise — a value two consumers read
 *  renders twice, and the count is the fact being measured — so a shared def tree costs it once per
 *  path. Exhausting the budget answers `unreadable`, the same refusal an op the walk cannot see
 *  through gets. */
const WALK_BUDGET = 4096;

/** The `± 1` an update spells, or null for every other update — `n = n + 1`, `n = 1 + n` and
 *  `n = n - 1` are the forms with a `++`/`--`. A cast anywhere in the value is null: the cast would
 *  have to be spelled around the update, which the operator cannot do. */
function unitStep(value: Expr, name: string): 1 | -1 | null {
  if (value.k !== 'bin' || (value.op !== '+' && value.op !== '-')) {
    return null;
  }
  const isVar = (e: Expr): boolean => e.k === 'var' && e.name === name;
  const one = (e: Expr): number | null => (e.k === 'const' && Math.abs(e.value) === 1 ? e.value : null);
  const k = isVar(value.l) ? one(value.r) : value.op === '+' && isVar(value.r) ? one(value.l) : null;
  return k === null ? null : ((value.op === '-' ? -k : k) as 1 | -1);
}

// `x + 0` / `x - 0` / `x | 0` are `x`. Substituting a loop variable by its init constant turns
// ordinary index arithmetic into exactly these, and a guard that spells the same value without
// the arithmetic would otherwise compare unequal.
function fold(defs: Map<Value, Op>, v: Value): Value {
  const d = defs.get(v);
  if (!d || d.operands.length !== 2 || !['add', 'sub', 'or'].includes(d.opcode)) {
    return v;
  }
  const z = defs.get(d.operands[1]);
  return z?.opcode === 'const' && z.attrs?.value === 0 ? fold(defs, d.operands[0]) : v;
}

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
function sameAtEntry(defs: Map<Value, Op>, a: Value, b: Value, entry: Map<Value, Value>, negated = false): boolean {
  const memo = new Map<Value, Map<Value, boolean>>();
  const sameOp = (da: Op, db: Op, opcodeOk: boolean): boolean =>
    opcodeOk &&
    da.operands.length === db.operands.length &&
    JSON.stringify(da.attrs ?? null) === JSON.stringify(db.attrs ?? null) &&
    da.operands.every((o, i) => same(o, db.operands[i]));
  const same = (x0: Value, y0: Value): boolean => {
    const x = fold(defs, entry.get(x0) ?? x0);
    const y = fold(defs, y0);
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
  const da = defs.get(fold(defs, entry.get(a) ?? a));
  const db = defs.get(fold(defs, b));
  return !!da && !!db && sameOp(da, db, NEGATED_ICMP[da.opcode] === db.opcode);
}

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
    // Body-block PARAMS escape too, and ONE rule covers all of them: escaped, under a name the
    // update writes. The loop's own carried params used to be exempt outright and are not special
    // — DELETED, not narrowed, and unnarrowable, because the only condition under the exemption
    // was the rule's own. Anything implying NOT that is already what the rule returns; anything
    // admitting it is the unconditional exemption back again. There being no third predicate is
    // why `loopParams` left this file instead of being tightened inside it.
    //
    // Unconditional, it was a SILENT MISCOMPILE. "A post-loop read of the updated name is exactly
    // the intended final value" holds for the BACK-EDGE ARG, which `sub` maps, and not for the
    // PARAM, which is one update behind — and both emitters that passed a nonempty exemption set
    // put the update at the BOTTOM of the body. The emitted C stored `i` where agbcc keeps a
    // second register to store `i-1`; it compiled, it scored, and nothing in the tree noticed.
    //
    // ITS EVIDENCE IS A RIG, NOT THE CORPUS, which matters because the three disjuncts of
    // `loopUpdateHazard` share one decline message. 121 generated loop shapes, each reference and
    // each lift compiled natively and EXECUTED over an identical buffer: 76 wrong lifts became
    // declines, 14 correct ones kept lifting with an identical hash. This clause then fires 0
    // times over the klonoa checkout's 732 `.s` and over the 2737 candidates the 205 agbcc
    // synthetic rows enumerate, where the predicate AROUND it fires 5 and 4 — on the condition, an
    // exit arg, or an escaped op result (`synthetic:preupdate_escape` is the last of those). Those
    // counts, and the rig, were taken at #113.
    //
    // AND IT DECLINES ONLY BECAUSE OF HOW THE VALUE IS SPELLED. `sinkablePreUpdateSlots` below
    // REPAIRS this hazard, re-emitting the copy inside the body ahead of the update, whenever the
    // pre-update value crosses the exit as an edge ARG; read from the header PARAM instead it
    // arrives here, with no exit slot to sink. Both spellings, and the agbcc listing, are in
    // test/loop-preupdate-escape.test.ts. Routing the param one into the sink is a structure.ts
    // change with a fan effect on every row, not an edit to this predicate.
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
        const n = varName.get(pv); // absent while naming is still in progress: not a written name

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
    // The bottom test's own read is spelled `n++` instead of declining (`preUpdateCondFold`), so
    // the caller has already answered this disjunct. The other two are untouched by that fold: the
    // update still runs, so an exit slot and an escaped body value still read the post-update name.
    condRepaired = false,
  ): boolean =>
    (!condRepaired && readsClobbered(condV, sub, updateWrites)) ||
    exitArgs.some((a) => readsClobbered(a, sub, updateWrites)) ||
    loopEscapeHazard(body, sub, updateWrites, region);

  // WHICH SPELLING A PRE-UPDATE READ IN THE BOTTOM TEST HAS. Returns the update to fold and the
  // step to fold it as, or the id of the gate that refused — `PREUPDATE_COND_GATES` above carries
  // the refusals and the argument. A fold implies the condition's hazard is REPAIRED, and nothing
  // else: the exit slots
  // and the escaped body values are `loopUpdateHazard`'s other two disjuncts and are unaffected by
  // the fold, which is why they are asked for separately and why `one-pre-update-variable` keeps
  // this to the single-variable case.
  //
  // The walk is `readsClobbered`'s, with three things added that the boolean does not need: it COUNTS
  // occurrences instead of stopping at the first (C89's sequence-point rule is about the count), it
  // tracks, per name, whether the leaf's position is reached when the whole test is TRUE and when
  // it is FALSE (`SHORT_CIRCUIT_ARMS`), and it notes any EFFECT sitting at a position one of those
  // two answers misses. A name reached twice takes the INTERSECTION of the two
  // positions' reach, which `variable-named-once` then refuses anyway — kept so the field means the
  // same thing whichever gate is ablated.
  //
  // NOT MEMOISED, unlike `readsClobbered`'s `seen`: a value read twice renders twice, and that is
  // the fact being counted. `WALK_BUDGET` bounds the DAG blow-up that costs, and exhausting it is
  // `unreadable` — the same answer a def whose lowering the walk cannot see gets.
  const preUpdateCondFold = (
    condV: Value,
    negated: boolean,
    header: Block,
    backArgs: readonly Value[],
    exitArgs: readonly Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updates: Stmt[],
    updateWrites: Set<string>,
    gates: readonly Gate<PreUpdateCondCandidate>[] = PREUPDATE_COND_GATES,
  ): PreUpdateCondFold => {
    let budget = WALK_BUDGET;
    let unreadable = false;
    let nestedConnective = false;
    let skippedEffect = false;
    const mentions = new Map<string, number>();
    const pre = new Map<string, Reach>();
    const note = (name: string, r: Reach): void => {
      mentions.set(name, (mentions.get(name) ?? 0) + 1);
      if (!updateWrites.has(name)) {
        return;
      }
      const was = pre.get(name);
      pre.set(name, was === undefined ? r : { onTrue: was.onTrue && r.onTrue, onFalse: was.onFalse && r.onFalse });
    };
    // `spine` says the path from the root here ran through connectives only, which is the condition
    // under which `r` is about this op's own truth as well as the whole test's.
    const walk = (x: Value, r: Reach, spine: boolean): void => {
      if (budget-- <= 0) {
        unreadable = true;
        return;
      }
      const post = sub.get(x);
      if (post !== undefined) {
        mentions.set(post, (mentions.get(post) ?? 0) + 1); // a post-update read: no hazard, still a mention
        return;
      }
      const own = varName.get(x);
      if (own !== undefined) {
        note(own, r);
        return;
      }
      const d = defs.get(x);
      if (d === undefined) {
        return;
      }
      if (respelledDefs.has(d)) {
        unreadable = true;
        return;
      }
      if (EFFECTFUL_OPS.has(d.opcode) && !(r.onTrue && r.onFalse)) {
        skippedEffect = true;
      }
      const arm = SHORT_CIRCUIT_ARMS[d.opcode];
      if (arm !== undefined && !spine) {
        nestedConnective = true;
      }
      d.operands.forEach((o, i) => walk(o, arm === undefined ? r : arm(i, r), arm !== undefined));
    };
    walk(condV, ALWAYS, true);
    const [name] = [...pre.keys()];
    const reach = name === undefined ? ALWAYS : pre.get(name)!;
    const assigns = updates.filter((st): st is Extract<Stmt, { k: 'assign' }> => st.k === 'assign' && st.name === name);
    const u = backArgs[header.params.findIndex((p) => varName.get(p) === name)];
    const c: PreUpdateCondCandidate = {
      step: assigns.length === 1 ? unitStep(assigns[0].value, name) : null,
      preUpdateNames: pre.size,
      mentions: mentions.get(name) ?? 0,
      unreadable,
      nestedConnective,
      skippedEffect,
      onContinue: negated ? reach.onFalse : reach.onTrue,
      onExit: negated ? reach.onTrue : reach.onFalse,
      updateObserved:
        u === undefined || exitArgs.includes(u) || (useSitesOf.get(u) ?? []).some((s) => !body.has(s.blk)),
    };
    const refusal = firstRejection(gates, c);
    if (refusal !== null) {
      return { refused: refusal };
    }
    // Asked again at the return, not `c.step!`: ablating `update-is-a-unit-step` is a question about
    // the CENSUS, and the node's shape is not negotiable — a `{ by: null }` renders as `n--` over a
    // body the emitter has already dropped the real update from. So the ablation gets that gate's
    // refusal back rather than a malformed fold.
    if (c.step === null) {
      return { refused: 'update-is-a-unit-step' };
    }
    return { name, by: c.step };
  };

  // WHERE A SUNK COPY IS REBUILT. The copy is not carried into the body, it is SPELLED AGAIN
  // there, so the point it belongs at is the one its value was computed at: the arg's own defining
  // op, when that op is one of `latch`'s — the block whose statements both loop emitters render
  // inline, ahead of the update. Null for every other arg, and the copy opens the body instead.
  // THREE args get that answer, not two: one with no position in the body at all (a block param, or
  // a def outside the loop), and one the body DID compute, in a body block that is not the latch.
  // The last is the narrow case and the one a wider sink would widen — the value has a position, it
  // is just not in the block whose `sideEffects` walk is handed the copies.
  //
  // READING AN OP'S INDEX AS THE SOURCE'S STATEMENT ORDER IS A COMPILER CLAIM, and the project
  // names the direction next door: target.ts's `readsStayWhereWritten` declares from compiled pairs
  // that a compiler EMITS a read in the block the source spelled it in, and states outright that
  // the converse — the asm's block is where the source read — is false and may not be defaulted.
  // This is that inference one level down, inside a block, and it consults no target: on a
  // scheduling compiler an op's index is the scheduler's order, not the source's.
  //
  // It owes no declaration because it buys a SPELLING, not an answer. `sideEffects` renders the
  // whole block in that same index order, so a copy placed among those statements agrees with every
  // one of them whatever the compiler did; and the motion that would change an ANSWER is the one
  // `movesPast` measures, in the order it renders. Where the asm's order is not the source's, the
  // failure is a candidate that does not match. Nothing off agbcc reaches it today — 0 sunk copies
  // over the whole `--tier synthetic --toolchain ido7.1` run (163 rows), and the four non-agbcc
  // `loop-preupdate` rows are all mwcc.
  const preUpdateCopyHome = (a: Value, latch: Block): Op | null => {
    const d = defs.get(a);
    return d !== undefined && opBlock.get(d) === latch ? d : null;
  };

  // Which pre-update exit copies can be REPAIRED instead of declined. The exiting edge hands a
  // loop variable's top-of-iteration value to a merge param, and post-loop that name has moved on
  // one iteration; emitting the copy inside the body, AHEAD of the update, restores it — the
  // trailing-pointer idiom (`for (fast = slow = head; ...; fast = fast->next) slow = fast;`).
  // Returns the exit slots that may move, each mapped to the point the caller rebuilds it at — an
  // op of the latch, or null for the copies that open the body — and the caller drops each one from
  // the post-loop copies.
  //
  // The idiom reaches here at all because the compiler DID keep a second register for the trailing
  // value and SSA construction folded the copy away, leaving the exit edge as the only place the
  // value is still named. Where the compiler kept two loop-carried registers instead, the value is
  // a back-edge arg and the un-rotation substitution already reads it — no repair needed.
  //
  // Each admitted slot comes back WITH THE POSITION IT WAS JUDGED AT, because permission and
  // placement are one answer: `arg-safe-to-reevaluate` clears the tree against that position and no
  // other, so an emitter free to re-derive its own would be free to place a copy where nothing
  // cleared it — silently, since the statement is still emitted and still reads names that resolve.
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
    latch: Block,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    gates: readonly Gate<SinkCandidate>[] = PREUPDATE_SINK_GATES,
  ): Map<number, Op | null> => {
    const none = new Map<number, Op | null>();
    const headerNames = new Set(header.params.map((p) => varName.get(p)));
    // Is `v` defined by the loop body itself — an op in one of its blocks, or a block param?
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
    // Everything that stops `a` from being REBUILT inside the body. Walks the def-tree
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
    //
    // Does re-evaluating `d` at the copy's position answer differently? `home` is that position
    // (`preUpdateCopyHome`), so the only ops that can tell are the ones STRICTLY BETWEEN the two —
    // and only when both are the latch's, because a def in any other block is separated from the
    // copy by whole blocks this does not walk. `ORDER_SENSITIVE_OPS` is the between-set for all
    // three ways `d` can care: a read wants no store crossed, an effect no other effect or read,
    // and a trap none of those performed ahead of the fault.
    //
    // NOT A RESTATEMENT OF WHAT `materialize` ALREADY BOUNDS, which is the reading to guard against.
    // That pass NAMES an order-sensitive value whose consumer is not adjacent to it, and a named
    // leaf is refused by `arg-reads-current-names` before this scan runs — so on a ONE-op tree the
    // two bounds do coincide. They part as soon as the tree has two ops: `r = *q + cb(q)` compiles
    // to `call, load, add`, where the load IS adjacent to its consumer and the CALL is what this
    // turns away. That is the `preupdate_exit_order` row, and the only refusal this arm has.
    //
    // `latch.ops` INDEX ORDER IS EXECUTION ORDER — what `slice` reads. The one ISA fact that bends
    // it cannot reach here: a MIPS branch-likely NULLIFIES its delay slot, so placement gives that
    // slot its own block on the taken edge rather than a later index in the latch, and `i < 0`
    // then refuses it as a def this block does not hold.
    //
    // `i < 0` carries a second refusal: a def in ANOTHER block, separated from the copy's position
    // in the latch by whole blocks nothing here walks. Its witness is hazards.test.ts's `a read from
    // ANOTHER body block is refused even though the arg itself is a latch op`.
    //
    // THE BETWEEN-SET DOES NOT EXEMPT THE TREE BEING REBUILT, where `pattern/engine.ts`'s
    // index-order scan does exempt its own cone — a cone member is inlined into the very expression
    // that moves, so it is no barrier to it. Two order-sensitive ops under one arg move together
    // and keep their internal order, so the reading here is the narrower one. Left narrow on
    // purpose: the exemption is a claim about a tree moving as a unit and no row offers a witness,
    // while the whole between-scan refuses exactly one corpus row as it stands.
    //
    // PER SLOT, and two slots sharing one order-sensitive def spell it TWICE — one `ldr` feeding
    // two exit args becomes two reads in the emitted C. Legal by this same scan: either nothing
    // order-sensitive lies between the two homes, or the second slot is refused and the edge stands
    // down whole. It costs a spelling; only a `volatile` qualifier would make the extra access
    // observable, and that qualifier is minted by a variation the differ referees (l3/volatileptr.ts),
    // never by the default candidate.
    const movesPast = (d: Op, home: Op): boolean => {
      const i = latch.ops.indexOf(d);
      const p = latch.ops.indexOf(home);
      return i < 0 || i > p || latch.ops.slice(i + 1, p).some((o) => ORDER_SENSITIVE_OPS.has(o.opcode));
    };
    const blockersOf = (a: Value, home: Op | null): ReadonlySet<ArgBlocker> => {
      const seen = new Set<Value>();
      const found = new Set<ArgBlocker>();
      const walk = (x: Value): void => {
        if (seen.has(x)) {
          return;
        }
        seen.add(x);
        if (header.params.includes(x)) {
          return; // a loop variable: ahead of the update its name holds exactly this
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
        // A respelled def is opaque — what it renders is a memory read this walk never sees — so it
        // is refused at every position rather than measured.
        if (respelledDefs.has(d) || (REEVAL_UNSAFE_OPS.has(d.opcode) && (home === null || movesPast(d, home)))) {
          found.add('order-sensitive');
        }
        d.operands.forEach(walk);
      };
      walk(a);
      return found;
    };
    const cleared = new Map<number, { name: string; home: Op | null }>();
    exitArgs.forEach((a, j) => {
      if (!readsClobbered(a, sub, updateWrites)) {
        return; // no hazard on this slot — nothing to repair
      }
      const destName = varName.get(exit.params[j]);
      const home = preUpdateCopyHome(a, latch);
      const c: SinkCandidate = {
        argBlockers: blockersOf(a, home),
        destName,
        headerNames,
        updateWrites,
        destBusyInLoop: destName !== undefined && busyInLoop(destName, exit.params[j]),
      };
      if (firstRejection(gates, c) === null) {
        cleared.set(j, { name: destName!, home });
      }
    });
    const names = new Set([...cleared.values()].map((c) => c.name));
    if (cleared.size === 0 || names.size !== cleared.size) {
      return none;
    }
    return exitArgs.some((a, j) => !cleared.has(j) && readsClobbered(a, sub, names))
      ? none
      : new Map([...cleared].map(([j, c]) => [j, c.home]));
  };

  return {
    readsClobbered,
    loopEscapeHazard,
    loopUpdateHazard,
    preUpdateCondFold,
    sinkablePreUpdateSlots,
    sameAtEntry: (a, b, entry, negated = false) => sameAtEntry(defs, a, b, entry, negated),
    loopWriteSet,
  };
}

/** THE WRITE RELOCATION THE UNDEF EDGE-COPY ELISION CANNOT SEE, as a postcondition on a whole
 *  function. `undefCarriesNothing` (structure.ts) drops the copy into `name` on the edge out of
 *  `pred` after proving no value in `name`'s class has a definition able to run before that edge.
 *  It reads each such definition's home off `paramBlock`/`opBlock`, and a SUNK pre-update exit copy
 *  is written somewhere else than its home says: its destination is the loop EXIT's param, so the
 *  model homes it after the loop, while `preUpdateCopies` really writes it INSIDE the body, on
 *  every iteration, ahead of the update and of any edge the header dominates.
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
