/** THE OUTGOING STACK-ARGUMENT ANALYSIS, over digested slot events rather than instructions.
 *
 *  NOTHING HERE DECODES. The frontend hands over, per basic block, the sequence of whole-word
 *  frame-slot accesses and calls it found, each call already carrying the block its callee's
 *  DECLARATION asks for; every mnemonic, addressing mode and prototype question is answered before
 *  the input is built. That split is what makes the fixpoint below testable on its own — it is the
 *  part most likely to be wrong, and a table of events is a fixture, where a table of Thumb is a
 *  second decoder.
 *
 *  The call token `C` is opaque: the analysis only ever uses it as a map key, so the frontend can
 *  key by its own instruction object and a test by a string.
 */

/** One event the analysis reads, in block order. A load and a store are the only frame accesses
 *  that matter — a sub-word or register-offset access is not a slot, and one anywhere turns the
 *  whole word-slot model off at the same gate this analysis's `blocker` feeds, so no access that
 *  could alias a licensed word is ever silently missing from the events. */
export type StackArgsEvent<C> = StackArgsSlot | StackArgsCall<C>;

/** A whole-word access to a reserved frame slot at `off`, which must lie inside `[0, localArea)`. */
export interface StackArgsSlot {
  readonly kind: 'store' | 'load';
  readonly off: number;
}

/** A call, and what its callee's DECLARATION says it takes on the stack. `declared` is the block
 *  `[0, 4*(n - argRegs))` as an ascending offset list, or null when nothing declares this call —
 *  an indirect call, a callee with no prototype, or one whose arity fits in registers. A null
 *  declaration can only ever lead to a refusal: the code alone cannot say where a block ENDS. */
export interface StackArgsCall<C> {
  readonly kind: 'call';
  /** The frontend's own handle for this call — the key of `OutgoingArgs.blocks`. */
  readonly call: C;
  /** The callee's name, for the refusal messages. `?` where the frontend has none. */
  readonly callee: string;
  readonly declared: readonly number[] | null;
}

/** One basic block's events. Where control goes afterwards is read out of `preds`, so a block is
 *  nothing but its slot-level events. */
export interface StackArgsBlock<C> {
  readonly events: readonly StackArgsEvent<C>[];
}

export interface StackArgsInput<C> {
  /** Every block, live or not, indexed as `preds` and `live` index them. */
  readonly blocks: readonly StackArgsBlock<C>[];
  readonly preds: readonly (readonly number[])[];
  /** The entry-reachable blocks. Dead blocks are still passed so a call in one is still SEEN —
   *  it stages nothing, so it refuses, which is the verdict that does not depend on deciding
   *  whether the block runs. */
  readonly live: ReadonlySet<number>;
  /** The frame this function reserved for itself, in bytes. 0 disables every slot. */
  readonly localArea: number;
  /** How many arguments the ABI passes in registers — where the stack block starts counting. */
  readonly argRegs: number;
  /** The frontend's verdict that the whole frame is one addressable object handed to a callee. */
  readonly capturedWholeFrame: boolean;
}

/** What this function's calls do with the BOTTOM of its frame — the outgoing stack-argument area
 *  agbcc's ACCUMULATE_OUTGOING_ARGS reserves there for arguments 5+ of the calls it makes. */
export interface OutgoingArgs<C> {
  /** Why no call here may be consumed, or null. The frontend returns it as its slot-model blocker,
   *  so a function whose area cannot be licensed declines at its first `[sp,#k]` access instead of
   *  lifting. */
  blocker: string | null;
  /** Per call, the frame offsets that call's stack arguments occupy — ascending and contiguous
   *  from zero. A call absent from the map passes everything in registers. */
  blocks: ReadonlyMap<C, readonly number[]>;
  /** The largest licensed block's extent. `[0, area)` is storage this function owns and does NOT
   *  declare, so it is where `LiveInModel.declaredLocals` starts. */
  area: number;
}

const isCallEvent = <C>(ev: StackArgsEvent<C>): ev is StackArgsCall<C> => ev.kind === 'call';

// THE OUTGOING STACK-ARGUMENT AREA, AND WHO MAY CONSUME IT.
//
// agbcc's ACCUMULATE_OUTGOING_ARGS reserves the BOTTOM of the frame for arguments 5+ of the calls
// this function makes: `add sp,sp,#-8` … `str r2,[sp]` / `str r3,[sp,#4]` … `bl callee`. Those
// offsets are inside the frame and nothing this function does ever reloads them. "Inside my
// frame" does not mean "private": the area belongs to the CALLEE, which may even assign to a
// stack parameter. Model those words as locals and they are dead defs that DCE deletes — the
// arguments vanish from the call with no diagnostic. Ground truth: sa3's
// CreateEntity_Platform_0_0 (platform.c:734) forwards SIX arguments and came out as
// `CreateEntity_Platform(0, 0, a0, (u16)a1)`.
//
// TWO INDEPENDENT WITNESSES MUST AGREE, and that agreement is the whole licence:
//   * the DECLARATION says how many words a call takes. AAPCS lays arguments 5..n at [sp,#0]
//     upward, one word each, so the block is `[0, 4*(n - |argRegs|))`, contiguous from zero.
//   * the CODE says which words are staged for it — the offsets stored and not yet reloaded when
//     the `bl` executes.
// Equal ⇒ consume. Anything else ⇒ decline, naming what was seen.
//
// WHY NEITHER WITNESS IS ENOUGH ALONE. A declared parameter list is a LOWER bound on the words a
// call pushes:
//
//   * a parameter may occupy more than one word (`double`, `long long`, a struct by value),
//   * a variadic callee's list is a prefix — `sprintf` truthfully declares two and is handed six,
//   * a large struct return adds a hidden pointer argument that appears in no parameter list.
//
// None of those is recorded by `FnProto` or `SymbolSignature`, so an ARITY-ONLY acceptance had
// all three holes: supplying a TRUE fact (`{ sprintf: { params: 2 } }`) turned a correct decline
// into `return sprintf(a0, a1)` with both stack arguments deleted. Under the rule here the four
// words `sprintf` is really handed are four offsets reaching the call that its declaration does
// not account for, the witnesses disagree, and the answer is the decline again. And the CODE
// alone cannot say where a block ENDS — a store never reloaded is an argument's signature, but
// so is a dead local, which is why reading the code alone could only ever refuse (conditions (a)
// and (b) below, kept for every call no declaration covers).
//
// THE TWO SIDES ARE CHECKED AGAINST DIFFERENT SETS, and the asymmetry is the point.
//   * NOTHING EXTRA is checked against the MAY set (stored and unreloaded on SOME path): the
//     weakest thing that could still be a word this call takes must be inside the block.
//   * NOTHING MISSING is checked against the MUST set (on EVERY path): a slot the callee reads
//     must have been written on every path that reaches the call, or the argument is whatever
//     the frame happened to hold. m2c renders that case as `ErrorExpr("Unable to find stack arg
//     0x0 in block")`; here it is a decline, and for the same reason — it is a GAP, and a gap
//     must never render as a plausible value.
//
// WHAT "NOTHING EXTRA" COSTS, because the reach is narrower than the disappearance of the old
// decline suggests. A genuine SPILL that is live across a licensed call sits in the may set and is
// not in the declared block, so the call refuses — and that is agbcc's commonest frame with an
// outgoing area. Tolerating it means arguing that a pending word which is RELOADED later is a
// local rather than argument n+1, which needs a gate and a row that gate protects; none exists.
// The cost is in attribution, not correctness: the decline such a function gets names a STORE
// ("[sp,#k] also reaches the call unread") rather than the capability, so a gap histogram groups
// this class under that message and not under anything about stack arguments.
// The must set is an intersection over predecessors, which is exactly what a TAIL-MERGED call
// site needs: agbcc does tail-merge (`Task_BonusFlower_Spawn`, sa3 bonus_game_enemies, stores
// argument 5 in both predecessors with the `bl` in the join), and a one-armed store — the same
// shape with one predecessor not storing — is missing on a path and refuses.
//
// PATH-SENSITIVE, because the weaker forms have been wrong twice in the other direction:
// scanning per block let a LABEL decide accept versus refuse; scanning the flat listing let
// BLOCK ORDER decide, because a load in one arm of a branch cleared a store that reaches the
// call through the other arm — swap the arms, same CFG and same semantics, and the verdict
// flipped.
//
// A LICENSED CALL CONSUMES ITS BLOCK, which is what lets a function make several calls: the
// callee reads those words, so they stop being pending after it, exactly as a reload would end
// them. The deletion is driven by the DECLARATION alone, never by the licence, so the fixpoint
// cannot depend on its own outcome.
export function analyzeOutgoingArgs<C>({
  blocks: asmBlocks,
  preds,
  live,
  localArea,
  argRegs,
  capturedWholeFrame,
}: StackArgsInput<C>): OutgoingArgs<C> {
  const refuse = (blocker: string): OutgoingArgs<C> => ({ blocker, blocks: new Map(), area: 0 });
  // EVERY block, not the entry-reachable ones: a call in dead code stages nothing, so the
  // dataflow below never finds its block and it refuses — which is the verdict it had before
  // consumption existed. An unreachable `bl` is not evidence about the frame either way, and
  // the loud answer is the one that does not depend on deciding which. The message a reader gets
  // is the dataflow fact ("[sp,#0] is not stored on every path to the call"), not "this block is
  // dead", and deliberately so: which blocks run is the question being refused, not an answer.
  const calls = asmBlocks.flatMap((ab) => ab.events.filter(isCallEvent));
  // ONLY FOR A FUNCTION THAT CALLS. With no call there is no outgoing area to mistake a local
  // for, and a never-reloaded store is then an ordinary dead local — which PR #30 modelled and
  // which must keep working.
  if (calls.length === 0) {
    return { blocker: null, blocks: new Map(), area: 0 };
  }
  const say = (offs: readonly number[]) => offs.map((o) => `[sp,#${o}]`).join(', ');
  const arityOf = (offs: readonly number[]) => argRegs + offs.length;

  // THE ONE-WORD CAPTURED FRAME. `capturedWholeFrame` says the whole frame is an
  // object whose address a callee holds; a declared fifth argument says [sp,#0] is a DIFFERENT
  // callee's argument slot. Two contradictory claims about the same word, and nothing here can
  // decide which to believe, so the honest answer is the decline it has always been.
  if (capturedWholeFrame) {
    for (const ev of calls) {
      const offs = ev.declared;
      if (offs !== null) {
        return refuse(
          `callee \`${ev.callee}\` is declared with ${arityOf(offs)} arguments, so [sp,#0] is its outgoing stack argument — ` +
            'but this one-word frame is an object whose address is passed to a callee, and the two name the same word',
        );
      }
    }
    // Conditions (a) and (b) hunt for an argument block; every block starts at [sp,#0]; and a
    // one-word frame that is entirely an addressable local has no room for one. So here they can
    // only fire as FALSE ALARMS — which is what they did, declining the three address-taken
    // synthetic rows on a store never reloaded for the ordinary reason, that the CALLEE reads it
    // through the pointer.
    return { blocker: null, blocks: new Map(), area: 0 };
  }

  const everySlot: number[] = [];
  for (let o = 0; o + 4 <= localArea; o += 4) {
    everySlot.push(o);
  }

  // The forward dataflow, three sets per block. `may`/`must` are the pending stores (stored and
  // not yet reloaded) on SOME / EVERY path; `stored` is every offset written on some path, which
  // a reload does NOT remove — the callee would still read what the store put there, and it is
  // what the contiguity filter asks. `must` is a meet-over-all-paths intersection, so it starts
  // at every slot and shrinks (the entry block starts EMPTY: control arrives there from outside
  // the function, storing nothing, whatever back edge also targets it).
  //
  // AND YES, `must` DUPLICATES THE SSA BUILDER'S REACHING-DEF QUERY, which is the same
  // meet-over-all-paths question and already answers it for the `ldr` arm. The duplication is
  // FORCED, not an oversight: the frontend must know `slotsOk` — whose answer is this analysis's
  // `blocker` — BEFORE it fills a single block, and the SSA builder has no defs until the fill
  // runs. Folding this into an `ssa.hasReachingDef` call makes the frontend ask a question whose
  // answer depends on the question, so the next reader who spots the redundancy should stop here.
  const mayOut = asmBlocks.map(() => new Set<number>());
  const mustOut = asmBlocks.map(() => new Set(everySlot));
  const storedOut = asmBlocks.map(() => new Set<number>());
  const mayAt = new Map<StackArgsCall<C>, Set<number>>();
  const mustAt = new Map<StackArgsCall<C>, Set<number>>();
  const storedAt = new Map<StackArgsCall<C>, Set<number>>();
  for (let changed = true; changed;) {
    changed = false;
    for (let b = 0; b < asmBlocks.length; b++) {
      if (!live.has(b)) {
        continue;
      }
      const livePreds = preds[b].filter((q) => live.has(q));
      const may = new Set<number>();
      const stored = new Set<number>();
      for (const q of livePreds) {
        for (const off of mayOut[q]) {
          may.add(off);
        }
        for (const off of storedOut[q]) {
          stored.add(off);
        }
      }
      const must = new Set(
        b === 0 || livePreds.length === 0 ? [] : everySlot.filter((o) => livePreds.every((q) => mustOut[q].has(o))),
      );
      for (const ev of asmBlocks[b].events) {
        if (isCallEvent(ev)) {
          mayAt.set(ev, new Set(may));
          mustAt.set(ev, new Set(must));
          storedAt.set(ev, new Set(stored));
          for (const o of ev.declared ?? []) {
            may.delete(o);
            must.delete(o);
          }
        } else if (ev.kind === 'store') {
          may.add(ev.off);
          must.add(ev.off);
          stored.add(ev.off);
        } else {
          may.delete(ev.off);
          must.delete(ev.off);
        }
      }
      const grow = (out: Array<Set<number>>, cur: Set<number>): void => {
        if (cur.size !== out[b].size || [...cur].some((o) => !out[b].has(o))) {
          out[b] = cur;
          changed = true;
        }
      };
      grow(mayOut, may);
      grow(mustOut, must);
      grow(storedOut, stored);
    }
  }

  // CONTIGUITY. An argument block is contiguous from zero, so a store at [sp,#4] can be argument
  // 6 of a call only if argument 5 at [sp,#0] is supplied on a path to that same call. A pending
  // store whose lower slots are nowhere supplied is provably not an argument block, and refusing
  // it is a false alarm — the exact false alarm that blocked the commonest real shape, a value
  // spilled at [sp,#4] and kept live across calls (kleod's ProcessInputAndUpdateEntities stores
  // its `sp4` local and calls m4aSongNumStart 80 lines later, with offset 0 never stored in the
  // whole function). The calibration: a conforming caller stores EVERY argument slot of a call it
  // makes, so "slot 0 unsupplied" rules out "slot 4 is an argument". Hand-written asm could skip
  // storing an argument the callee never reads; agbcc cannot (no interprocedural dead-argument
  // elimination). That is the producer assumption both code-reading conditions make.
  const prefixStored = (k: number, st: ReadonlySet<number>): boolean => {
    for (let j = 0; j < k; j += 4) {
      if (!st.has(j)) {
        return false;
      }
    }
    return true;
  };
  const asc = (s: Iterable<number>) => [...s].sort((x, y) => x - y);

  // THE LICENCE, call by call. Every declared block must match what the code staged for it,
  // exactly — and every refusal after this one then runs knowing which words are spoken for.
  const blocks = new Map<C, readonly number[]>();
  let area = 0;
  for (const ev of calls) {
    const offs = ev.declared;
    if (offs === null) {
      continue;
    }
    const may = mayAt.get(ev) ?? new Set<number>();
    const must = mustAt.get(ev) ?? new Set<number>();
    const missing = offs.filter((o) => !must.has(o));
    const extra = asc(may).filter((o) => !offs.includes(o));
    if (missing.length > 0 || extra.length > 0) {
      return refuse(
        `callee \`${ev.callee}\` is declared with ${arityOf(offs)} arguments, so its outgoing stack-argument block is ${say(offs)} — but ` +
          (missing.length > 0
            ? `${say(missing)} is not stored on every path to the call`
            : `${say(extra)} also reaches the call unread, so the declaration does not account for every word staged here`),
      );
    }
    blocks.set(ev.call, offs);
    area = Math.max(area, 4 * offs.length);
  }

  const licensed = new Set<number>();
  for (const offs of blocks.values()) {
    for (const o of offs) {
      licensed.add(o);
    }
  }
  // The two whole-function facts the next two refusals read: every offset live code stores, and
  // every offset live code loads back. A reload in dead code is not evidence that anything reads
  // the slot back, so it does not count.
  const reloaded = new Set<number>();
  const storedAnywhere = new Set<number>();
  for (const b of live) {
    for (const ev of asmBlocks[b].events) {
      if (ev.kind !== 'call') {
        (ev.kind === 'store' ? storedAnywhere : reloaded).add(ev.off);
      }
    }
  }
  // A LICENSED WORD THIS FUNCTION ALSO LOADS. The area belongs to the CALLEE — which may assign
  // to a stack parameter — so after the `bl` the word holds whatever the callee left, and an
  // `ldr` off that offset reads a GAP. The dataflow above cannot catch it: the call consumes the
  // offset, so the load meets an empty pending set and clears nothing. Left alone, the ordinary
  // `ldr` arm answers it from the staging store's reaching def and renders the value the CALLER
  // passed in — a plausible identifier standing in for an unknown, which is the `unksp0` failure
  // mode this whole analysis exists to avoid. It is the same contradiction
  // `capturedWholeFrame` refuses: one word carrying two incompatible claims, with
  // nothing here able to decide between them. A load BEFORE the staging store is the same verdict
  // for the same reason — under ACCUMULATE_OUTGOING_ARGS the locals sit ABOVE the area, so a
  // caller-side load of an argument offset contradicts the layout the licence rests on.
  for (const off of asc(licensed)) {
    if (reloaded.has(off)) {
      return refuse(
        `[sp,#${off}] is an outgoing stack-argument slot of one of this function's calls, but this function also LOADS it — ` +
          'the callee owns that word across the call, so nothing here can say what the load reads',
      );
    }
  }
  // (a) — a store never reloaded ANYWHERE, with its lower slots supplied, is an argument's
  // signature: an outgoing argument is read by the CALLEE, never by the caller. Its real theorem
  // is the layout one (the area sits at the BOTTOM of localArea, disjoint from the locals, so no
  // local load can land on an argument offset), which is why it is a whole-function question.
  // A LICENSED offset is excluded: its never being reloaded is explained by the call that takes it.
  for (const off of asc(storedAnywhere)) {
    if (!licensed.has(off) && !reloaded.has(off) && prefixStored(off, storedAnywhere)) {
      return refuse(
        `the store to [sp,#${off}] is never reloaded and its lower slots are supplied — it may be an outgoing stack argument of one of this function's calls`,
      );
    }
  }
  // (b) — no slot store may reach a `bl` unread ALONG A PATH. For a call the licence covered,
  // the equality above already answered this; what is left are the calls no declaration sizes,
  // where a plausible argument block reaching one unread is an argument this analysis cannot
  // size, and the answer is the decline.
  //
  // THE OFFSET THIS NAMES IS THE LOWEST PENDING ONE, because `may` is reported through `asc`. The
  // verdict does not depend on it — any one of them refuses — but the message is what a gap
  // histogram keys on, and scanning a Set in insertion order named whichever offset the code stored
  // FIRST instead (pokeemerald's `PickLotteryCornerTicket` stores [sp,#4] before [sp,#0]).
  for (const ev of calls) {
    if (ev.declared !== null) {
      continue;
    }
    const may = mayAt.get(ev) ?? new Set<number>();
    const stored = storedAt.get(ev) ?? new Set<number>();
    for (const k of asc(may)) {
      if (prefixStored(k, stored)) {
        return refuse(
          `the store to [sp,#${k}] reaches \`bl ${ev.callee}\` unread with its lower slots supplied — it may be that call's outgoing stack argument`,
        );
      }
    }
  }
  // NOTHING LEFT OVER. The exclusion above is per OFFSET, so it would also excuse a store to a
  // licensed offset that no call ever reads — a write into the argument area that is still pending
  // where the function ENDS. That is not an argument and not a local anyone reloads, so nothing
  // here can say what it is: decline rather than let it drop as a dead def.
  //
  // "WHERE THE FUNCTION ENDS" IS A LIVE BLOCK WITH NO LIVE SUCCESSOR, read off `preds`, not a
  // terminator the caller classified. Under Thumb the two coincide — a computed PC write has no
  // static successor and the frontend throws on one long before here — but asking the CFG costs
  // nothing and removes a fact the caller could get wrong.
  //
  // WHAT IT STILL DOES NOT REACH, stated because the escape is real: a store into the licensed area
  // on a path that never ends. Every block of an infinite loop has a live successor, so the word
  // stays pending forever and nothing here refuses it. Measured rather than assumed — a `str` into
  // the area after a licensed `bl`, falling into `.L1: b .L1`, passes this analysis and then
  // declines at L2: "unrecovered back-edge into block #1 (loop-recovery declined this shape)". So
  // the loud answer is preserved by a DIFFERENT family's refusal, not by this one. Closing it needs
  // a backward "can this word still be consumed?" pass, which no row in the corpus asks for.
  const hasLiveSucc = asmBlocks.map(() => false);
  for (let b = 0; b < asmBlocks.length; b++) {
    if (live.has(b)) {
      for (const q of preds[b]) {
        hasLiveSucc[q] = true;
      }
    }
  }
  for (let b = 0; b < asmBlocks.length; b++) {
    if (!live.has(b) || hasLiveSucc[b]) {
      continue;
    }
    for (const off of asc(mayOut[b])) {
      if (licensed.has(off)) {
        return refuse(
          `the store to [sp,#${off}] is inside the outgoing stack-argument area but is still staged where this function ends — no call it makes accounts for it`,
        );
      }
    }
  }
  return { blocker: null, blocks, area };
}
