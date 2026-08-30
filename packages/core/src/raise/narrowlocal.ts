// A NARROW DECLARED LOCAL, extended once at every read.
//
// agbcc has no sub-word register, so an `s16`/`u8` LOCAL lives in a full register and every read of
// it re-extends. Where the local is a loop's counter that extension is not cosmetic, because it
// decides WHICH LOOP the compiler emits:
//
//   `gcc/thumb.h:344` PROMOTE_MODE forces `UNSIGNEDP = 1` on every sub-word mode, so a narrow
//   counter's write-back is an LSHIFTRT; `gcc/loop.c` `basic_induction_var` follows SIGN_EXTEND
//   (`:5876`) and ASHIFTRT (`:5880`) and lets LSHIFTRT fall through to `default: return 0`
//   (`:5902`) — the comment at `:5756-5762` says the ZERO_EXTEND exclusion is deliberate. With no
//   basic induction variable there is no strength reduction, so the narrow counter SURVIVES into
//   the emitted loop as a real index where a wide one becomes a pointer walk. Compiled both ways
//   with this benchmark's own agbcc, same declared `s32` local, same range, same body, only the
//   write-back's RTL shape differing:
//
//     i = ((i + 1) << 16) >> 16;   ASHIFTRT   add r1,r1,#0x2 / add r2,r2,#0x2   index ELIMINATED
//     i = (s32)(u16)(i + 1);       LSHIFTRT   lsl r0,r2,#0x1 / add r1,r0,r4     index SURVIVES
//
// So the width of a carrier is a fact about the emitted code, and it is recovered here rather than
// enumerated for the same reason `paramwidth` recovers its own: an extension states a width and a
// signedness outright. What it does NOT always state is that the source DECLARED them — see
// `edge-extends` below, where two spellings survive and this file picks one.
//
// SOUNDNESS HAS TWO HALVES, AND THE CARRIER'S OWN READERS ARE ONLY THE FIRST. Typing the carrier
// narrow makes the C TRUNCATE at every incoming edge — `s16 v` assigned a wide expression keeps its
// low 16 bits.
//
//   HALF ONE, THE CARRIER. The truncation is unobservable through the carrier exactly when every
//   reader of the carrier already reads only those bits, i.e. when the carrier's one and only
//   reader is an extension of that width: `ext(trunc_w(x), w) == ext(x, w)` for every `x`. A second
//   reader of the raw carrier, or the carrier forwarded on a branch into another block's parameter,
//   would observe the bits the declaration drops — both refuse.
//
//   HALF TWO, THE INCOMING ARGUMENTS, and it is NOT implied by half one. The C names the edge
//   values with the carrier's variable: `structure.ts`'s `backArgName` hands a loop header's name
//   to the back-edge argument, so every OTHER reader of that argument reads it through the narrow
//   declaration too. Half one says nothing about them. The counterexample is a 9-instruction loop
//   whose header carrier has exactly one reader (its own `sext16`) and whose back-edge value
//   `adds r1, r2, #1` is UNTRUNCATED and also read by the `cmp` at 32 bits: narrowed, the recovered
//   C is `s16 v; do { *a0 = v; v = v + 1; } while (v < 32768);`, and this benchmark's own agbcc
//   compiles it to `b .L3` with `warning: comparison is always true due to limited range of data
//   type` — an infinite loop out of assembly that terminates. So `edge-reader` requires every value
//   arriving on an in-edge to be observed NOWHERE except through an extension of exactly this
//   carrier's width and signedness, which is the same truncation the declaration performs.
//
// AND ONE HALF THAT IS EVIDENCE, NOT SOUNDNESS — `edge-extends`, WHERE THE TRUNCATION IS. Both
// spellings compute the same numbers, so nothing here is a correctness argument; what decides it is
// which shape agbcc leaves in the asm. PROMOTE_MODE's write-back truncation is a `zext`, and where
// it LANDS is the whole rule. In a loop it lands on the back edge, so the carrier's in-edge value
// is itself an extension. Across a plain merge gcc SINKS the common truncation past the join, where
// it stops being an in-edge fact and becomes the carrier's own reader — so an in-edge test alone
// reads a real narrow local as a cast. All four spellings compiled with this benchmark's own agbcc,
// each round-tripped through decompile() and scored against its own object:
//
//   SOURCE                              CARRIER'S READER   REFUSED   ADMITTED
//   s16 v; … *out = v;                  zext16 -> sext16       6     0 MATCH
//   s32 v; … *out = (s16)v;             sext16             0 MATCH       6
//   u16 v; … *out = v;                  zext16                 4     0 MATCH
//   s32 v; … *out = (u16)v;             zext16             0 MATCH       4
//
// Rows one and two are DECIDABLE by the carrier's own readers: a `zext_w` read by a `sext_w` is the
// write-back truncation followed by the declaration's own sign extension, and no cast on a wide
// local writes that pair. Rows three and four are the same IR in this pass's READER vocabulary —
// same single extension, same raw in-edges, opposite answers — and for a long time this file
// refused both and called the difference "the branch shape agbcc chose", i.e. the score's business.
//
// THE BRANCH SHAPE IS EVIDENCE THIS PASS CAN READ, and it decides rows three and four. Compiled
// with this benchmark's own agbcc, `u16 v` leaves a DIAMOND of 14 instructions and `s32 v` +
// `(u16)v` a HOISTED join of 12:
//
//   u16 v;  if (c) v = a+b; else v = a-b;  *out = v;      cmp / beq / adds / b / lsl+lsr / str
//   s32 v;  if (c) v = a+b; else v = a-b;  *out = (u16)v; subs / cmp / beq / adds / lsl+lsr / str
//                                                         ^^^^ the else arm ABOVE the compare
//
// `gcc/jump.c:443-445` is the transform: "Simplify `if (...) x = a; else x = b;` by converting it
// to `x = b; if (...) x = a;` if B is sufficiently simple". ITS GUARD IS THE CONJUNCTION AT
// `:471-502`, not the `:895-907` block that reads similarly and is the conditional-move /
// store-flag transform beside it. `:474`/`:480` want each arm to be a `single_set` with the
// condjump immediately before the first (`:490-491`), and `:482-483` want the moving arm free of
// side effects and non-trapping — and `gcc/thumb.h:344` PROMOTE_MODE expands a narrow-DECLARED assignment into the
// arithmetic PLUS its `ashift`/`lshiftrt` truncation pair, five insns in the `.jump` dump, so the
// hoist is refused for exactly the spelling that declares the local. A join gcc could have hoisted
// and did not is therefore positive evidence FOR a declaration. `mergeDiamond` reads it off the CFG
// this pass already walks.
//
// THE GUARD IS ABOUT THE ARM, SO READING ONLY THE JOIN READS HALF OF IT — `armsHoistable` is the
// other half and it is most of the rule's reach. A diamond over arms too big for ONE SET, or over
// an arm holding a load, a call or a store, survives whatever the local's width and carries no
// information at all; narrowing there would be a spelling guess wearing the evidence's clothes.
// THREE SHAPES COST A REAL MATCH THAT WAY AND TWO ARE NOW ROWS: `mergeldcast` (both arms one
// load — one SET by op count, never speculatable, `gcc/jump.c:483`) and `mergepool` (an arm whose
// immediate needs a literal-pool load, so one C assignment is two insns), each MATCH at base and
// 6 / 1 under an arm test that read only the op count. The third is the empty forwarding arm a
// frontend label-cut invents, which has no insn to be a `single_set` at all and no row because the
// function carrying it declines. The predicate is therefore EXACTLY one value-producing op per arm
// (constants counted), no op that may not be speculated, and the arms sharing one `cond_br` head —
// see `mergeArms` and `armIsOneSet`. Over-refusal is free: it returns the carrier to the
// wide-local-plus-cast spelling this pass emitted before the rule existed.
//
// PHRASED AS POSITIVE EVIDENCE, DELIBERATELY. `!mergeDiamond` and not `hoistedJoin`: the negation
// of a hoist is not evidence of a declaration, so a rule that refused only what is provably hoisted
// would newly admit every one-predecessor, three-armed and irreducible join on nothing at all.
//
// ITS PRICE IS MEASURED OVER THE SET IT REFUSES, never over the set it admits — a gate priced on
// its own accepts cannot show a cost. Over 2288 per-function sa3 sources (1742 lift, 546 decline at
// the frontend) the table is IDENTICAL with the conjunct and without it:
//
//   entry-param 1228 · reader-is-extension 2114 · param-typed 33 · raw-reader 13 · forwarded 7 ·
//   edge-reader 28 · edge-extends 40 (zext 30 / sext 10) · ACCEPT 60 (sext 51 / zext 9)
//   flipped carriers: 0        of the 40 refusals: diamond 28, diamond AND arms hoistable 0
//
// AND THAT IS THE HONEST HEADLINE: over every corpus anything here has measured, this rule's ONLY
// inhabitant is the row that motivated it. Say it plainly rather than let a census number imply
// breadth. An earlier, looser pair re-decided ONE sa3 carrier and the audit showed that one was a
// misclassification — an empty forwarding block the frontend cut at a label, in a function that
// loud-fails anyway (`sub_80B6198`, `ASMLIFT_ERROR` in both configurations). With the head test it
// is refused, and the count is 0 rather than 1-that-was-wrong.
//
// Over the benchmark's own 930 base rows, decompiled twice — the conjunct as shipped and cleared —
// exactly ONE row's emitted SOURCE BYTES change and it is `synthetic:mergeu16:agbcc`
// (`45b1755f7fc7 -> c528e2a30ab2`, gapCountChanged 0 over all 930). That a score-level `bench diff`
// can see one of the rows this decides is the whole reason the `merge*` rows in
// apps/benchmark/dataset/synthetic.ts exist — four cells of the 2x2 plus `mergeldcast` and
// `mergepool` for the arm clause — and the reason the behavioural oracle for the rule is the
// ablated arm of narrowlocal-fuzz.test.ts rather than any score.
//
// WHAT PRICING THE SA3 POPULATION BY SCORE WOULD TAKE, measured rather than assumed: the sa3
// functions a looser form of this rule flipped all fail to produce a scorable candidate outside the
// project — every one references external symbols, and grafting sa3's own generated `ctx.c` in still
// leaves per-function gaps (a callee used as a value, an arity mismatch), because that context is
// generated per translation unit. So a score for that population needs a per-function context
// harness this repo does not have — which is why the arm clause is priced by AUTHORED rows
// (`mergeldcast`, `mergepool`) instead, where it costs 6 and 1.
//
// NO LOOP GATE, deliberately, AND THAT SENTENCE IS ABOUT THE SOUND RULES ONLY. The extension is
// what states the width, and it states it whether or not the block is a loop header — the loop is
// where the width is worth something, not where it becomes true. The join clause is different and
// it does not get the same licence: a rotated loop header IS a two-armed merge, `gcc/jump.c` never
// considers a back edge, and nothing about a declaration follows from that diamond surviving. It is
// refused, but by the shape test in `mergeArms` (the two arms do not share a `cond_br` head) rather
// than by a loop predicate — which matters, because a per-FUNCTION loop question cannot decide a
// per-SITE one.
//
// TARGET-GATED IN ONE CONJUNCT AND NOWHERE ELSE, and the split is the point. The sound rules above
// are claims about C — an extension states a width; a second reader of the raw carrier observes the
// bits a declaration drops — and hold for every compiler, so this pass is not agbcc-gated. The join
// clause of `edge-extends` is not one of those: "gcc 2.x's `jump_optimize` would have collapsed
// this diamond and did not" names one compiler's optimizer, and it is that compiler fact READ
// BACKWARDS. `docs/level-tower.md` legislates exactly this case — a per-compiler default belongs in
// `TargetDescription.compilerBehaviors` and owes an explicit refusal for every pass that moves the
// thing it is placing. Both debts are paid: `NarrowLocalOptions.hoistsSingleSetArm` carries the
// fact (absent ⇒ the clause never admits), and `mergeShapes` snapshots the CFG before this pass's
// own rewrites — the passes AHEAD of it in pre-recovery.ts (divpow2 DELETES a block, both
// short-circuit folds rewrite edges) are answered by the head test, which refuses any join whose
// two arms do not share one `cond_br` predecessor.
import { type Block, type Fn, type Op, type Value, replaceAllUsesWith } from '../ir/core';
import { CAST_WIDTHS, REEVAL_UNSAFE_OPS } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';

/** THE ONE PER-COMPILER FACT THIS PASS READS, threaded rather than defaulted.
 *
 *  Everything else here is a claim about C: an extension states a width, and a second reader of the
 *  raw carrier observes bits a narrow declaration drops — true of every compiler. The join clause of
 *  `edge-extends` is NOT of that kind, and the file used to say it was. Its claim is "gcc 2.x's
 *  `jump_optimize` would have collapsed this diamond and did not", which names one compiler's
 *  optimizer, and `docs/level-tower.md` is explicit that such a fact is `TargetDescription.
 *  compilerBehaviors` data rather than an ungated default — the more so because it is a compiler
 *  fact READ BACKWARDS (the verified direction is narrow-declaration ⇒ PROMOTE_MODE expands the arm
 *  ⇒ no hoist ⇒ diamond; this infers the declaration from the diamond).
 *
 *  ABSENT ⇒ the target claims nothing and the join clause never admits, which is exactly the
 *  behaviour this pass had before the clause existed. Measured over the benchmark's 930 rows the
 *  clause reaches no non-agbcc row either way, so the gating moves nothing today; it is here so the
 *  first MIPS or PPC row it does reach has to be measured before it counts. */
export interface NarrowLocalOptions {
  /** the compiler collapses `if (…) x = a; else x = b;` into `x = b; if (…) x = a;` when both arms
   *  are one speculatable SET (`gcc/jump.c:471-502`). Absent ⇒ false. */
  hoistsSingleSetArm?: boolean;
}

/** What the gates below judge: one block parameter and the extension that reads it. */
export interface NarrowLocalCandidate {
  /** the block parameter the extension reads */
  param: Value;
  /** the extension's `width` attribute, or 0 when the sole reader is not an extension */
  width: number;
  /** the parameter belongs to the ENTRY block */
  isEntryParam: boolean;
  /** reads of the RAW parameter by op OPERANDS anywhere in the function. Branch arguments are NOT
   *  counted here — they are `forwarded`'s — which is where this differs from the identically
   *  named field in raise/paramwidth.ts, whose `useCount` sums both. */
  operandReads: number;
  /** the sole reader is a `sext`/`zext` */
  readerIsExtension: boolean;
  /** occurrences of the RAW parameter as a branch argument */
  forwarded: number;
  /** every value arriving on an in-edge is observed only through this carrier's own truncation */
  edgeArgsObservedNarrow: boolean;
  /** every value arriving on an in-edge is itself an extension of at most this width, or a constant */
  edgeArgsExtend: boolean;
  /** the sole reader is a `zext {w}` whose own sole reader is a `sext {w}` — PROMOTE_MODE's
   *  write-back truncation sunk past a join, then the declaration's own sign extension */
  writeBackTruncation: boolean;
  /** the carrier's block is a TWO-ARMED MERGE: exactly two predecessor blocks, and neither of them
   *  branches to the other, both arms' sole predecessor being the same `cond_br` head.
   *  `gcc/jump.c:443-445` rewrites `if (…) x = a; else x = b;` into
   *  `x = b; if (…) x = a;` — collapsing the diamond into the hoisted shape, where the join's own
   *  predecessor is the conditional branch that also targets the surviving arm. Its guard at
   *  `:471-502` requires each arm to be ONE insn holding ONE SET, which `gcc/thumb.h:344`
   *  PROMOTE_MODE forbids for a narrow-DECLARED local (the assignment expands to the arithmetic
   *  plus its truncation pair). So a surviving diamond is evidence FOR a declaration and a hoisted
   *  join is evidence against one. */
  mergeDiamond: boolean;
  /** …and the arms of that merge are ones `gcc/jump.c:471-502` could have collapsed: EXACTLY one
   *  value-producing op each — constants included — and nothing unsafe to SPECULATE above the
   *  compare. The guard is about the ARM, so a diamond over arms gcc could not have collapsed
   *  survives whatever the local's width and carries no information at all. See `armIsOneSet` for
   *  the two ways an op count alone gets this wrong, each of which is a benchmark row.
   *
   *  ALSO FALSE when the target declares no `hoistsSingleSetArm` — the whole conjunct is a claim
   *  about one compiler's optimizer, see `NarrowLocalOptions`. */
  armsHoistable: boolean;
}

export const NARROW_LOCAL_GATES: readonly Gate<NarrowLocalCandidate>[] = [
  {
    // SOUND, and its safety lives in ANOTHER table — which the `sound` flag has no word for, so it
    // is spelled out here. Dropping this rule does not re-decide an entry parameter, it takes the
    // decision from raise/paramwidth.ts: this pass runs first and deletes the extension, leaving
    // `proto-width` and `not-prologue` nothing to judge. Measured on the shape they exist for — a
    // prologue `sext16` under a caller prototype declaring `u8` — paramwidth narrows 0, this pass
    // narrows 0, this pass WITHOUT this gate narrows 1 to `s16` and paramwidth then sees nothing.
    // A wrong parameter width costs bytes at every prototyped call site, which no per-function
    // differ sees.
    id: 'entry-param',
    why: "a function's own arguments are the prologue pass's territory",
    sound: true,
    guardedBy: 'narrow-local.test.ts: an entry parameter is left to raise/paramwidth.ts',
    rejects: (c) => c.isEntryParam,
  },
  {
    id: 'param-typed',
    why: 'the pointer/aggregate recovery already decided this parameter',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a parameter the pointer recovery already typed is left alone',
    rejects: (c) => c.param.type.kind !== 'unknown',
  },
  {
    // ORDERED ABOVE `cast-width`, which is where the attribution lives: over 2288 sa3 functions
    // this rule refuses 2114 carriers and `cast-width` refuses none, and below it every one of
    // those 2114 read as "a width no C type spells".
    //
    // THIS RULE AND `cast-width` ARE ONE SOUNDNESS ARGUMENT IN TWO ENTRIES, and neither is
    // ablatable alone: a non-extension reader gives `width = 0`, which the other refuses, and no
    // producer in the tree emits an extension at a width outside `CAST_WIDTHS` (the pattern engine
    // and frontend/ppc.ts write 8 and 16; raise/narrow.ts re-writes a width already gated on that
    // set), so `cast-width` fires 0 times in this order. Drop BOTH and the pass types a carrier
    // `u0` and deletes the op that read it — which is why the joint ablation is the guard both
    // name, and why neither may rest on an ablation of its own.
    id: 'reader-is-extension',
    why: 'a carrier whose sole reader is not an extension states no width at all',
    sound: true,
    guardedBy: 'narrow-local.test.ts: the width pair is jointly load-bearing and neither half alone',
    rejects: (c) => !c.readerIsExtension,
  },
  {
    id: 'cast-width',
    why: 'only 8 and 16 are widths a `zext`/`sext` — and so a C declaration — carries',
    sound: true,
    guardedBy: 'narrow-local.test.ts: the width pair is jointly load-bearing and neither half alone',
    rejects: (c) => !CAST_WIDTHS.has(c.width),
  },
  {
    id: 'raw-reader',
    // Operand reads ONLY. raise/paramwidth.ts ships this id over a `useCount` that sums operands
    // AND successor arguments; here a forwarded carrier is `forwarded`'s refusal, so the same shape
    // is refused by both tables under two different names.
    why: 'a reader of the un-extended carrier observes the bits the declaration would drop',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a second reader of the raw carrier refuses the narrowing',
    rejects: (c) => c.operandReads !== 1,
  },
  {
    id: 'forwarded',
    why: 'a carrier passed on to another block parameter is read there at its full width',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a carrier forwarded as a branch argument refuses the narrowing',
    rejects: (c) => c.forwarded > 0,
  },
  {
    id: 'edge-reader',
    why: 'the C names the in-edge value with the carrier, so its other readers read the truncation',
    sound: true,
    guardedBy: 'narrow-local.test.ts: an in-edge value read at full width elsewhere refuses the narrowing',
    rejects: (c) => !c.edgeArgsObservedNarrow,
  },
  {
    id: 'edge-extends',
    // NOT sound: `s32 v` + one `(s16)v` at the use computes the same numbers, so what this decides
    // is a spelling and the header's 2×2 is the evidence for the direction. It is NOT the same
    // judgment as `paramwidth`'s `not-prologue`, which is `sound: true` for a reason this rule has
    // no access to: a parameter's width is its SIGNATURE, and agbcc truncates at every prototyped
    // call site of a narrow-declared callee — bytes in other functions, which no per-function
    // differ sees. A block local's width leaves the function's interface alone, so the worst this
    // rule can do is pick the losing spelling of two that compile, and nothing here is wrong.
    why: 'no truncation on an in-edge, none sunk to the join, and a join gcc would have hoisted',
    sound: false,
    guardedBy: 'narrow-local.test.ts: a merge whose in-edges carry no truncation is a cast, not a declaration',
    // ONE ENTRY, three conjuncts, and it cannot be split: a gate is a REJECTION, so "refuse unless
    // some evidence" is one rule — split across rows, each half over-fires alone.
    //
    // `without` therefore cannot ablate the join half alone — but the COMPILER FACT can, and that
    // is the second reason `hoistsSingleSetArm` is threaded rather than defaulted. Clearing it
    // leaves the two edge conjuncts standing and removes exactly this one, which is the ablation
    // `narrow-local.test.ts: a target that claims no single-SET hoist gets no join evidence` runs
    // and the sa3 census is measured against. The FIXTURES then price the halves of the conjunct
    // itself: MERGE_HOISTED_ARM the join, MERGE_DIAMOND_BIG_ARM / _LOAD_ARMS / _POOL_ARM the arms.
    //
    // The third conjunct is POSITIVE evidence, deliberately, and not `!hoistedJoin`. The negation
    // of a hoist is not evidence of a declaration: a one-predecessor join, a three-armed one, an
    // irreducible one all say nothing, and phrasing the rule as "refuse only what is provably
    // hoisted" would newly ADMIT every one of them on no evidence at all. `!mergeDiamond` keeps
    // every unmeasured shape refused exactly as before, so this widening admits only the shape the
    // header's 2x2 decides.
    rejects: (c) => !c.edgeArgsExtend && !c.writeBackTruncation && !(c.mergeDiamond && c.armsHoistable),
  },
];

/** The blocks that branch to `blk`, DEDUPLICATED — and the dedup is SEMANTICS, not a micro-
 *  optimisation. `ir/core.ts`'s `predecessors` is not interchangeable with this: it lists a block
 *  once per EDGE, so a `cond_br` whose two successors are the same block reports that block as two
 *  predecessors and reads as a two-armed merge with one arm. Here a predecessor is an ARM, and one
 *  block reaching the join twice is one arm. That dedup is the ONLY behavioural difference between
 *  the two: `verify` (ir/verify.ts:74-103) already guarantees exactly one terminator, last in its
 *  block, and no successors on any other op, so this walk over every op and `successorsOf`'s over
 *  the last one see the same edges. Measured over 2288 sa3 functions the two models disagree on 26
 *  blocks, and on 8 of them `ir/core`'s would have reported the two predecessors this file needs —
 *  so swapping in the shared utility is a silent behaviour change, which
 *  `narrow-local.test.ts: a block reached twice from one predecessor is ONE arm` pins.
 *
 *  Hoisted once per `narrowLocalCandidates` call rather than recomputed per parameter, which keeps
 *  this an O(E) walk of the function and not an O(E * params) one. */
function predecessorsOf(fn: Fn): Map<Block, Block[]> {
  const preds = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        const list = preds.get(s.block);
        if (list === undefined) {
          preds.set(s.block, [b]);
        } else if (!list.includes(b)) {
          list.push(b);
        }
      }
    }
  }
  return preds;
}

/** What the join shape says about the source, as ONE record — the two fields are read off the same
 *  walk because the second is a property of the arms the first identifies. */
export interface MergeShape {
  /** the block is a TWO-ARMED DIAMOND: `gcc/jump.c:471-502`'s input shape. */
  diamond: boolean;
  /** …and both arms are ones that guard could have collapsed. False whenever `diamond` is. */
  hoistable: boolean;
}

/** THE ARMS OF A TWO-ARMED DIAMOND, or `null`. Read against the transform this file's header cites,
 *  `gcc/jump.c:443-445` "Simplify `if (...) x = a; else x = b;` … to `x = b; if (...) x = a;`",
 *  whose guard is the conjunction at `:471-502` of the agbcc checkout:
 *
 *    :472/:474  `temp3 = prev_active_insn (insn)` … `single_set (temp3)`   the `x = a;` arm, ONE insn
 *    :490/:491  `temp  = prev_active_insn (temp3)` … `condjump_p (temp)`   the head branches straight to it
 *    :478/:480  `temp2 = next_active_insn (insn)` … `single_set (temp2)`   the `x = b;` arm, ONE insn
 *    :482/:483  `! side_effects_p` … `! may_trap_p (SET_SRC (temp4))`      …and speculatable
 *
 *  So the shape is: a join with exactly two arms, each arm ending in a plain `br` to the join, each
 *  arm's SOLE predecessor the same head, and that head ending in a `cond_br` whose two successors
 *  are exactly those two arms. THE HEAD TEST IS LOAD-BEARING AND ITS ABSENCE IS WHAT ADMITTED THE
 *  SHAPES THIS RULE HAS NO EVIDENCE FOR:
 *
 *    • a LOOP HEADER really is a two-predecessor join whose predecessors do not branch to each
 *      other — a rotated loop's preheader and latch are distinct blocks — and `gcc/jump.c` never
 *      considers a back edge, so nothing about a narrow declaration follows from one surviving.
 *      The preheader's sole predecessor is not the latch's, so the head test refuses it.
 *    • a FRONTEND-INVENTED join: an empty forwarding block cut at a label is an "arm" with no insn
 *      at all, and `:480`'s `single_set` on a nonexistent insn never matched. Its own predecessor
 *      is another join rather than the head, so the head test refuses it.
 *    • the ENTRY block, whose implicit entry edge `predecessorsOf` cannot see (the trap
 *      `raise/divpow2.ts:92-98` documents for the same recognizer).
 *
 *  The equivalent walk in `raise/divpow2.ts:99-115` recognizes a ONE-armed diamond (head → bias arm
 *  → merge, plus a direct head → merge edge) and is deliberately not shared with this: that pass
 *  DELETES a block and needs the arm's contents, this one only reads a shape. */
function mergeArms(preds: Map<Block, Block[]>, fn: Fn, blk: Block): [Block, Block] | null {
  const p = preds.get(blk);
  if (p === undefined || p.length !== 2 || blk === fn.blocks[0]) {
    return null;
  }
  const [x, y] = p;
  const term = (b: Block): Op | undefined => b.ops[b.ops.length - 1];
  for (const arm of [x, y]) {
    const t = term(arm);
    if (t === undefined || t.opcode !== 'br' || t.successors[0]?.block !== blk) {
      return null;
    }
  }
  const hx = preds.get(x) ?? [];
  const hy = preds.get(y) ?? [];
  if (hx.length !== 1 || hy.length !== 1 || hx[0] !== hy[0]) {
    return null;
  }
  const ht = term(hx[0]);
  if (ht === undefined || ht.opcode !== 'cond_br' || ht.successors.length !== 2) {
    return null;
  }
  const succ = ht.successors.map((s) => s.block);
  if (!((succ[0] === x && succ[1] === y) || (succ[0] === y && succ[1] === x))) {
    return null;
  }
  return [x, y];
}

/** ONE INSN HOLDING ONE SET, approximated over the lifted IR — `gcc/jump.c:474`/`:480`'s
 *  `single_set`, and `:482`/`:483`'s `! side_effects_p` / `! may_trap_p` beside it.
 *
 *  TWO THINGS THE OP COUNT ALONE GETS WRONG, and both cost a real byte-match (the benchmark rows
 *  `mergeldcast` and `mergepool` are exactly these):
 *
 *    • a MEMORY READ is one op and is NOT one speculatable SET. `gcc/rtlanal.c:1770-1771` sends a
 *      MEM to `rtx_addr_can_trap_p`, and `:144-147` says an address held in a plain pseudo CAN
 *      trap — so `jump.c` never hoists a load, the diamond survives under BOTH spellings, and it
 *      carries no information. `REEVAL_UNSAFE_OPS` is the set that answers this question (effects,
 *      reads, or traps — the trapping divides `may_trap_p` also refuses at `rtlanal.c:1774-1784`);
 *      `HOIST_UNSAFE_OPS` is NOT, because it omits reads for `raise/shortcircuit.ts`, whose arm is
 *      re-guarded by C's own `&&`, and that exemption does not transfer to speculation above a
 *      compare.
 *    • a CONSTANT is not free. `v = a + 0x12345` is a literal-pool `ldr` plus the `add` — two
 *      insns, no `single_set` — while `v = a + 3` is one `adds`. The lifted IR spells both as
 *      `const` feeding `add` and does not say which immediate the target can fold, so constants
 *      COUNT: the foldable case is refused too, and that costs nothing, because agbcc really does
 *      hoist it and the join is then not a diamond at all.
 *
 *  Over-refusal here is free by construction: refusing returns the carrier to the wide-local-plus-
 *  cast spelling this pass emitted before the rule existed. */
function armIsOneSet(b: Block): boolean {
  return (
    !b.ops.some((op) => REEVAL_UNSAFE_OPS.has(op.opcode)) && b.ops.filter((op) => op.results.length > 0).length === 1
  );
}

/** The join shape of every block, read ONCE off the given IR.
 *
 *  Exported and passed in by `narrowBlockLocals` because this pass MUTATES: it deletes an
 *  extension, then re-enumerates. Recomputing the arm test after that rewrite would judge a
 *  program agbcc never compiled — an arm whose `lsl/asr/add` this pass just shortened to `add`
 *  would read as one SET because of a SIBLING carrier's narrowing. The evidence is a fact about
 *  the lifted asm, so it is snapshotted before the first rewrite. */
export function mergeShapes(fn: Fn): Map<Block, MergeShape> {
  const preds = predecessorsOf(fn);
  const out = new Map<Block, MergeShape>();
  for (const b of fn.blocks) {
    const arms = mergeArms(preds, fn, b);
    out.set(b, { diamond: arms !== null, hoistable: arms !== null && arms.every(armIsOneSet) });
  }
  return out;
}

/** Every value arriving at `blk`'s parameter `idx`, over every edge in the function. */
function incomingArgs(fn: Fn, blk: Block, idx: number): (Value | undefined)[] {
  const args: (Value | undefined)[] = [];
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        if (s.block === blk) {
          args.push(s.args[idx]);
        }
      }
    }
  }
  return args;
}

/** Every op that reads `v` as an operand, and how many times `v` appears as a branch argument. */
function readersOf(fn: Fn, v: Value): { ops: Op[]; forwarded: number } {
  const ops: Op[] = [];
  let forwarded = 0;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const o of op.operands) {
        if (o === v) {
          ops.push(op);
        }
      }
      for (const s of op.successors) {
        forwarded += s.args.filter((a) => a === v).length;
      }
    }
  }
  return { ops, forwarded };
}

/** Every block parameter this pass judges, with the extension that would be deleted — the gate
 *  table's INPUT, separated from its application so a test can ask WHICH gate refuses a shape
 *  rather than only whether the pass fired. */
export function narrowLocalCandidates(
  fn: Fn,
  shapes: Map<Block, MergeShape> = mergeShapes(fn),
  opts: NarrowLocalOptions = {},
): { c: NarrowLocalCandidate; ext: Op }[] {
  const out: { c: NarrowLocalCandidate; ext: Op }[] = [];
  const defs = new Map<Value, Op>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        defs.set(r, op);
      }
    }
  }
  for (const [i, b] of fn.blocks.entries()) {
    const shape = shapes.get(b) ?? { diamond: false, hoistable: false };
    const diamond = shape.diamond;
    const hoistable = shape.hoistable && opts.hoistsSingleSetArm === true;
    for (const [pi, p] of b.params.entries()) {
      const { ops, forwarded } = readersOf(fn, p);
      const ext = ops[0];
      if (ext === undefined) {
        continue;
      }
      const isExt = ext.opcode === 'sext' || ext.opcode === 'zext';
      const w = isExt ? (ext.attrs.width as number) : 0;
      const args = incomingArgs(fn, b, pi);
      // HALF TWO of the soundness argument, and the evidence half beside it — both are properties
      // of the values that ARRIVE, and neither is visible from the carrier's own readers.
      const observedNarrow = args.every((a) => {
        if (a === undefined) {
          return false;
        }
        const r = readersOf(fn, a);
        // …read only through an extension NARROWER THAN OR EQUAL TO the bits the declaration
        // keeps. Such a reader re-extends from the name explicitly (`(s16)v`), so it observes
        // exactly what it observed of the raw value; its signedness is its own business. Anything
        // else — an `add`, an `icmp`, a store of a wider width — reads bits the declaration drops.
        if (!r.ops.every((o) => (o.opcode === 'sext' || o.opcode === 'zext') && (o.attrs.width as number) <= w)) {
          return false;
        }
        // …and handed to no block parameter but this one (another would read it full-width)
        return r.forwarded === args.filter((x) => x === a).length;
      });
      const argExtends = args.every((a) => {
        const d = a === undefined ? undefined : defs.get(a);
        if (d === undefined) {
          return false;
        }
        return d.opcode === 'const' || ((d.opcode === 'sext' || d.opcode === 'zext') && (d.attrs.width as number) <= w);
      });
      // …and the same truncation SUNK PAST THE JOIN, which is where gcc puts it when every arm
      // writes the local: the carrier's own reader is the `zext` write-back, and the sole reader of
      // THAT is the sign extension the narrow declaration is read through. A cast on a wide local
      // writes one extension, never this pair.
      const extRead = ext.opcode === 'zext' ? readersOf(fn, ext.results[0]) : undefined;
      const writeBackTruncation =
        extRead !== undefined &&
        extRead.forwarded === 0 &&
        extRead.ops.length === 1 &&
        extRead.ops[0].opcode === 'sext' &&
        extRead.ops[0].attrs.width === w;
      out.push({
        c: {
          param: p,
          width: w,
          isEntryParam: i === 0,
          operandReads: ops.length,
          readerIsExtension: isExt,
          forwarded,
          edgeArgsObservedNarrow: observedNarrow,
          edgeArgsExtend: argExtends,
          writeBackTruncation,
          mergeDiamond: diamond,
          armsHoistable: hoistable,
        },
        ext,
      });
    }
  }
  return out;
}

/** Type each block parameter at the width its sole reading extension proves, and drop that
 *  extension. Returns the number of carriers narrowed. */
export function narrowBlockLocals(
  fn: Fn,
  gates: readonly Gate<NarrowLocalCandidate>[] = NARROW_LOCAL_GATES,
  opts: NarrowLocalOptions = {},
): number {
  let narrowed = 0;
  // THE JOIN SHAPE IS READ OFF THE IR AS LIFTED, once, before any rewrite below — see
  // `mergeShapes`. Everything else the gates read is re-enumerated deliberately.
  const shapes = mergeShapes(fn);
  // Re-enumerated after each rewrite: narrowing one carrier deletes an op and re-points its
  // readers, which is exactly the evidence the edge rules of a LATER carrier read. `done` is the
  // re-entry guard and nothing else — `param-typed` is the RULE about an already-typed parameter,
  // and it has to stay ablatable.
  const done = new Set<Value>();
  for (let again = true; again;) {
    again = false;
    for (const { c, ext } of narrowLocalCandidates(fn, shapes, opts)) {
      if (done.has(c.param) || firstRejection(gates, c) !== null) {
        continue;
      }
      done.add(c.param);
      c.param.type = T.int(c.width, ext.opcode === 'sext');
      replaceAllUsesWith(fn, ext.results[0], c.param);
      for (const blk of fn.blocks) {
        const at = blk.ops.indexOf(ext);
        if (at >= 0) {
          blk.ops.splice(at, 1);
        }
      }
      narrowed++;
      again = true;
      break;
    }
  }
  return narrowed;
}
