// asmlift IR — the access discipline: which ops the recompile must run where, and as often as, the
// asm ran them, and the questions every pass asks about that.
//
// Two kinds of fact meet here. The registry's flags (ir/opcodes.ts `OpSig`: `effects`, `reads`,
// `traps`) are facts about an OPCODE. A PLACEMENT is a fact about one OP, decided once by the pass
// that knew it: `call` is its own opcode; `helper` is the stamp `runtime-helpers.ts` `helperOp` puts
// on a value op the asm computed by calling a runtime routine; `device` is the `volatile` the
// frontend's device-pin pass (frontend/device-pins.ts) puts on a memory access; `declared` is the
// stamp raise/declared-volatile.ts puts on a read of an object the symbol map declares volatile, as
// the lift is made and again when structuring starts. Every question below takes the op, so a pass
// asks one question instead of re-deriving the combination, and `PLACEMENT_ANSWERS` is the one
// place a placement's answers are written.
//
// NAMED RESIDUE. The sites below ask a registry question where a placement could change the answer,
// and keep the registry's answer. DELIBERATE: the placement does not bear on what the site asks.
// GAP: it does, and some input gets a wrong answer.
//
//   `speculationUnsafe` answers no for a plain read — DELIBERATE, argued at the function — and for
//   a trapping divide — GAP: raise/shortcircuit.ts hoists one the structurer may name above its guard.
//   A QUALIFIED read is a `device` or `declared` one.
//   Two qualified reads commuting (`orderSensitive` without `effectful` on either side):
//     pattern/engine.ts `reordersUnsequenced` — DELIBERATE: the structurer's barrier scan names the
//       first of two qualified reads the fold would join in one expression.
//     structure/hazards.ts `movesPast` — DELIBERATE: the analysis names a qualified read another
//       qualified read stands between it and its render, so the scan never weighs two.
//   `effectful` as the barrier a read may not cross, without `isBarrier`'s helper and qualified-read
//   clauses (structure/analysis.ts):
//     structure/analysis.ts `writeBetween`, `standsOnMovableRead`, the multi-render rule — DELIBERATE:
//       each asks about a memory write, and a qualified read writes nothing.
//   The `call` placement alone, in structure/analysis.ts:
//     the `&&`/`||` rule — DELIBERATE: a qualified read in that cone declines (`volatileGuardedRead`),
//       and a helper op has its own clause.
//     `callPos` — DELIBERATE: it asks which values live across the registers a call clobbers.
//     `readCone`, `isHomeableDef`, `copyInterdependentValues` — DELIBERATE: a qualified read is a
//       `load` there, which each already stops at.
//   `effectful` as block purity — structure.ts's exit ownership, preheader claim, header purity,
//   copied `ret` target, `ends` and latch effect roots; structure/hazards.ts `testSkipsAnEffect`;
//   structure/redundant-test.ts `testRereadsOnly` — DELIBERATE: a qualified read renders with its
//   block, once on each path that runs the block, or declines upstream.
//     raise/divpow2.ts's bias arm — GAP: the arm is deleted, and a dead qualified read in it with it.
//   And two accesses the deciders leave unplaced, where a placement would change an answer — GAP:
//     a device store a pinned read of the same cell re-reads in a loop, under the per-object policy
//       (frontend/device-pins.ts's header argues it);
//     a read of a map-declared volatile object through a base that reaches no name, such as a
//       pointer walked along the object in a loop (raise/declared-volatile.ts).
import type { Op } from './core';
import { MEM_BASE_OPS, type OpSig, opSig } from './opcodes';

/** Why an op must run where the asm ran it. */
export type Placement = 'call' | 'helper' | 'device' | 'declared';

/** The attr raise/declared-volatile.ts stamps a `declared` read with. */
export const DECLARED_VOLATILE = 'declaredVolatile';

interface PlacementAnswers {
  /** spelled even when nothing reads the result */
  keptWhenDead: boolean;
  /** never run on a path that did not run it */
  speculationUnsafe: boolean;
  /** each render is one more execution, so it renders once on every path the asm ran it on */
  counted: boolean;
}

const PLACEMENT_ANSWERS: Readonly<Record<Placement, PlacementAnswers>> = {
  // The registry's `effects` flag gives a call the first two answers on its own.
  call: { keptWhenDead: true, speculationUnsafe: true, counted: true },
  // The value the helper computes is pure: nothing observes a divide nobody reads, a fold that
  // moves one under a guard drops the stamp (`forgetHelperPlacement`), and agbcc computes one
  // spelled twice once (`a / n + a / n` is one `bl __divsi3`).
  helper: { keptWhenDead: false, speculationUnsafe: false, counted: false },
  // The access is what is observable, not the value it yields: its spelling is qualified, through
  // a cast for `device` and through the object's declaration for `declared`.
  device: { keptWhenDead: true, speculationUnsafe: true, counted: true },
  declared: { keptWhenDead: true, speculationUnsafe: true, counted: true },
};

/** The placement an op carries, or null for an op that may render wherever its value is used. */
export function placedAt(op: Op): Placement | null {
  if (op.opcode === 'call') {
    return 'call';
  }
  if (MEM_BASE_OPS.has(op.opcode) && op.attrs.volatile === true) {
    return 'device';
  }
  if ((op.opcode === 'load' || op.opcode === 'aload') && op.attrs[DECLARED_VOLATILE] === true) {
    return 'declared';
  }
  // An `opaque` carries `helper` too, naming the call nothing could fold (`refuseUnmodelledHelpers`);
  // it is no value op, and its `effects` flag already places it.
  if (op.opcode !== 'opaque' && typeof op.attrs.helper === 'string') {
    return 'helper';
  }
  return null;
}

const answered = (op: Op, q: keyof PlacementAnswers): boolean => {
  const p = placedAt(op);
  return p !== null && PLACEMENT_ANSWERS[p][q];
};

const sigOf = (op: Op): OpSig | undefined => opSig(op.opcode);

/** Does each render of this op execute it — a call, or a qualified access? Such an op is spelled
 *  once on every path the asm ran it on, at the position it ran: named where a second use, an edge
 *  or another block would render it again or elsewhere. */
export function counted(op: Op): boolean {
  return answered(op, 'counted');
}

/** Has an observable side effect: a memory write, a call, an unmodelled instruction. The question a
 *  block-purity test asks, and the write a memory read may not cross. */
export function effectful(op: Op): boolean {
  return sigOf(op)?.effects === true;
}

/** May a dead result be deleted? Registered, no effect, not control flow, and not an op whose
 *  placement keeps it. */
export function deletableWhenDead(op: Op): boolean {
  const sig = sigOf(op);
  return !!sig && !sig.effects && !sig.terminator && !answered(op, 'keptWhenDead');
}

/** Must the structurer still SPELL this op when nothing consumes its result — an effect, or a
 *  memory read?
 *
 *  The read half points the opposite way from `deletableWhenDead`, and both are right. That one is
 *  the C claim: nothing observes a load nobody reads. This one is the COMPILER claim: an optimizing
 *  compiler deletes every dead read it is allowed to delete, so one still in the target is evidence
 *  the source's access was `volatile`. A yes here only says the op may not be dropped silently;
 *  whether a `volatile` can reach the access is an ADDRESS-level question the caller asks
 *  (structure.ts `volatileQualifiable`), and a read it answers no to is dropped.
 *
 *  Its own function and not `orderSensitive`, though the two agree on every registered opcode: they
 *  ask different questions, and a registry change that splits them is a decision to make at each. */
export function spelledWhenDead(op: Op): boolean {
  const sig = sigOf(op);
  return !!sig && (!!sig.effects || !!sig.reads);
}

/** May this op NOT be speculated — run on a path that did not run it? An effect, or an op whose
 *  placement forbids it.
 *
 *  A plain memory read answers no, and that is the answer worth arguing. The consumer is
 *  raise/shortcircuit.ts, which hoists an arm's body into the block above, and the structurer
 *  inlines an unnamed value back into the `&&`/`||` right-hand side, where C's own short circuit
 *  re-guards it. Answering yes for plain reads refuses every connective whose arm reads memory,
 *  which branch-shortcircuit.test.ts's `refusals` pin. A qualified read is the read the re-guard
 *  argument does not cover — it moves an access, not a value — so its placement answers yes.
 *
 *  The trapping divides answer no as well, and there the re-guard argument does NOT carry: a hoisted
 *  `sdiv` the structurer NAMES becomes an unconditional statement. `reevalUnsafe` answers yes for
 *  them, so the pre-update sink is not exposed to it.
 *
 *  THE EXEMPTION IS NOT TRANSFERABLE. A consumer asking "would gcc have speculated this arm above a
 *  compare", where nothing re-guards anything, must refuse single-load arms (`gcc/jump.c:483`'s
 *  `! may_trap_p`); `raise/narrowlocal.ts` asks `reevalUnsafe`, and asking this instead loses
 *  `synthetic:mergeldcast:agbcc` its byte match. Ask this only where a C-level re-guard at the new
 *  point actually holds. */
export function speculationUnsafe(op: Op): boolean {
  return effectful(op) || answered(op, 'speculationUnsafe');
}

/** Does this op's answer depend on WHERE it runs on one path? An effect (its order against other
 *  effects is observable) or a memory read (it answers whichever stores ran before it). */
export function orderSensitive(op: Op): boolean {
  const sig = sigOf(op);
  return !!sig && (!!sig.effects || !!sig.reads);
}

/** May this op NOT be re-evaluated at another program point — order-sensitive, or trapping? The trap
 *  half separates it from `orderSensitive`: it matters only when the new point can be reached on a
 *  path the old one was not. A collapsed switch re-renders a test block's ops at their uses, each
 *  dominated by the def, so on a subset of the original paths — a narrowing, never a speculation —
 *  and asks `orderSensitive` instead. */
export function reevalUnsafe(op: Op): boolean {
  const sig = sigOf(op);
  return !!sig && (!!sig.effects || !!sig.reads || !!sig.traps);
}

/** Drop the `helper` placement from an op a pass moves out of the block the asm called it in, and
 *  return the op. The stamp is read as WHERE the call ran, so an op moved elsewhere must stop
 *  claiming it and renders as the pure value it computes. raise/shortcircuit.ts hoists a `&&`/`||`
 *  guarded arm's body above the branch, and there C's short circuit re-guards the op at its use:
 *  agbcc's `if (a > 0 && k / n != 0)` runs the `bl __divsi3` under the first compare, and named at
 *  its hoisted def it would divide on the path the `&&` skips. */
export function forgetHelperPlacement(op: Op): Op {
  if (placedAt(op) === 'helper') {
    const { helper: _, ...rest } = op.attrs;
    op.attrs = rest;
  }
  return op;
}

/** `attrs`, plus the placement of `from`, for an op a pass builds to stand for `from`: a memory
 *  access keeps its `volatile` or its `declared` stamp, a value op its `helper`. Every op rebuilder
 *  carries the stamps through here, so a placement decided once is not lost to a rebuild that
 *  forgot to copy it. */
export function carryDiscipline(from: Op, attrs: Op['attrs']): Op['attrs'] {
  switch (placedAt(from)) {
    case 'device':
      return { ...attrs, volatile: true };
    case 'declared':
      return { ...attrs, [DECLARED_VOLATILE]: true };
    case 'helper':
      return { ...attrs, helper: from.attrs.helper };
    default:
      return attrs;
  }
}
