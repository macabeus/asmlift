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
// same single extension, same raw in-edges, opposite answers — so nothing the carrier reads decides
// them.
//
// THE BRANCH SHAPE IS EVIDENCE THIS PASS CAN READ, and it decides rows three and four. Compiled
// with this benchmark's own agbcc, `u16 v` leaves a DIAMOND of 14 instructions and `s32 v` +
// `(u16)v` a HOISTED join of 12:
//
//   u16 v;  if (c) v = a+b; else v = a-b;  *out = v;      cmp / beq / adds / b / lsl+lsr / str
//   s32 v;  if (c) v = a+b; else v = a-b;  *out = (u16)v; subs / cmp / beq / adds / lsl+lsr / str
//                                                         ^^^^ the else arm ABOVE the compare
//
// `gcc/jump.c:443-445` rewrites `if (...) x = a; else x = b;` to `x = b; if (...) x = a;`, and
// `gcc/thumb.h:344` PROMOTE_MODE expands a narrow-DECLARED assignment into the arithmetic PLUS its
// `ashift`/`lshiftrt` truncation pair — five insns in the `.jump` dump, past the ONE SET that
// transform's guard wants. So a join gcc could have hoisted and did not is positive evidence FOR a
// declaration. `mergeArms` and `armIsOneSet` hold the guard, conjunct by conjunct. The shape is
// REQUIRED rather than `hoistedJoin` REFUSED, because the negation of a hoist is not evidence of a
// declaration: phrased that way the rule would newly admit every one-predecessor, three-armed and
// irreducible join on nothing at all.
//
// AND WHAT IT READS IS THE FINAL ASM, WHERE `jump_optimize` READ THE RTL — the one gap in the
// mechanism, and it runs BOTH ways. `if (c) v = a << b; else v = a >> b;` leaves arms of TWO insns
// (`adds` / `asrs`) and gcc hoisted anyway, reload having added the copies afterwards — an
// over-refusal, which is free. The other way, `s32 v; if (c) v = (u16)a; else v = (u16)b;
// out[0] = (u8)v;` is refused the hoist (its arms were `lsl`/`lsr` at jump time) and then has its
// common `lsr` SUNK past the join, leaving one-insn arms `armIsOneSet` calls hoistable. No fixture
// can close that: the mutation is the compiler's. Six authored cast spellings were aimed at the
// hole and all six hoisted, so it costs no measured row — but widening the arm test widens into
// it.
//
// ITS PRICE IS MEASURED OVER THE SET IT REFUSES, never over the set it admits — a gate priced on
// its own accepts cannot show a cost. Over 2288 per-function sa3 sources (1742 lift, 546 decline at
// the frontend) the table is IDENTICAL with the join conjunct and without it:
//
//   entry-param 1228 · reader-is-extension 2114 · param-typed 33 · raw-reader 13 · forwarded 7 ·
//   edge-reader 28 · edge-extends 40 (zext 30 / sext 10) · ACCEPT 60 (sext 51 / zext 9)
//   flipped carriers: 0        of the 40 refusals: diamond 28, diamond AND arms hoistable 0
//
// Over the benchmark's own 930 base rows, decompiled twice — the conjunct as shipped and cleared —
// exactly ONE row's emitted SOURCE BYTES change (`synthetic:mergeu16:agbcc`,
// `45b1755f7fc7 -> c528e2a30ab2`, gapCountChanged 0 over all 930). So over every corpus anything
// here has measured, this rule's only inhabitant is the row that motivated it, and the `merge*`
// rows in apps/benchmark/dataset/synthetic.ts are its whole score: four cells of the 2x2, plus
// `mergeldcast` (both arms one load) and `mergepool` (an arm whose immediate needs a pool load),
// which cost 6 and 1 under an arm test that read only the op count. sa3 can add nothing — every one
// of those functions references external symbols and its `ctx.c` is per translation unit, so no
// per-function score exists there.
//
// THE ADMIT SIDE'S ORACLE IS narrowlocal-fuzz.test.ts, whose generator appends this join shape to
// half its functions for this clause alone — 7421 acyclic and 7522 loop-bearing carriers admitted,
// every one structured, interpreted and compared against the un-narrowed spelling. A widening that
// changes what a function COMPUTES shows up there; one that only changes the SPELLING shows up in
// the rows.
//
// NO LOOP GATE, deliberately, AND THAT SENTENCE IS ABOUT THE SOUND RULES ONLY. The extension states
// the width whether or not the block is a loop header — the loop is where the width is worth
// something, not where it becomes true. The join clause gets no such licence: a rotated loop header
// IS a two-armed merge and `gcc/jump.c` never considers a back edge. It is refused by `mergeArms`'
// head test rather than by a loop predicate, because a per-FUNCTION loop question cannot decide a
// per-SITE one.
//
// TARGET-GATED IN ONE CONJUNCT AND NOWHERE ELSE, and the split is the point. The sound rules above
// are claims about C and hold for every compiler; "gcc 2.x's `jump_optimize` would have collapsed
// this diamond and did not" names one compiler's optimizer, and reads that compiler fact BACKWARDS.
// `docs/level-tower.md` legislates the case: such a fact belongs in
// `TargetDescription.compilerBehaviors`, and owes an explicit refusal from every pass that moves
// the thing it reads. `NarrowLocalOptions.hoistsSingleSetArm` carries it (absent ⇒ the clause never
// admits), and `runPreRecovery` reads the shape ahead of the pass that manufactures it —
// `mergeShapes`.
import { type Block, type Fn, type Op, type Value, predecessors, replaceAllUsesWith } from '../ir/core';
import { CAST_WIDTHS, REEVAL_UNSAFE_OPS } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';

/** THE ONE PER-COMPILER FACT THIS PASS READS, threaded rather than defaulted — see the header for
 *  why this conjunct and no other is a target's claim. ABSENT ⇒ the clause never admits, which is
 *  the behaviour this pass had before it existed. */
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
  /** the carrier's block is a two-armed merge (`mergeArms`). READ BY NO GATE — `armsHoistable`
   *  implies it — and carried only so a census can tell two different refusals apart: no diamond
   *  at all, against a diamond over arms gcc could not have collapsed. */
  mergeDiamond: boolean;
  /** …and the arms of that merge are ones that guard could have collapsed. The guard is about the
   *  ARM, so a diamond over arms gcc could not have collapsed survives whatever the local's width
   *  and carries no information at all — see `armIsOneSet`, whose refusals are two benchmark rows.
   *  IMPLIES `mergeDiamond`: there are no arms to judge without one. */
  armsHoistable: boolean;
  /** the TARGET's claim, kept apart from the IR facts above because it is not one. `armsHoistable`
   *  says what the arms are; this says whether this compiler's optimizer would have acted on that.
   *  Fused into one field the name lies and every census number over it is target-conditioned. */
  targetHoistsSingleSetArm: boolean;
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
    // some evidence" is one rule — split across rows, each half over-fires alone. `without`
    // therefore cannot ablate the join half, but the COMPILER FACT can, and that is the second
    // reason `hoistsSingleSetArm` is threaded rather than defaulted: clearing it leaves the two
    // edge conjuncts standing and removes exactly this one. That is the ablation `narrow-local.
    // test.ts: a target that claims no single-SET hoist gets no join evidence` runs and the sa3
    // census is measured against; the FIXTURES then price the conjunct's own halves —
    // MERGE_HOISTED_ARM the join, MERGE_DIAMOND_BIG_ARM / _LOAD_ARMS / _POOL_ARM the arms.
    rejects: (c) => !c.edgeArgsExtend && !c.writeBackTruncation && !(c.armsHoistable && c.targetHoistsSingleSetArm),
  },
];

/** What the join shape says about the source — one record, because the second field is a property
 *  of the arms the first identifies. */
export interface MergeShape {
  /** the block is a TWO-ARMED DIAMOND: `gcc/jump.c:471-502`'s input shape. */
  diamond: boolean;
  /** …and both arms are ones that guard could have collapsed. Never true without `diamond`. */
  hoistable: boolean;
}

/** THE ARMS OF A TWO-ARMED DIAMOND, or `null` — `gcc/jump.c:443-445`'s input shape, read conjunct
 *  by conjunct off that transform's guard at `:471-502` in the agbcc checkout:
 *
 *    :472/:474  `temp3 = prev_active_insn (insn)` … `single_set (temp3)`   the `x = a;` arm, ONE insn
 *    :490/:491  `temp  = prev_active_insn (temp3)` … `condjump_p (temp)`   the arm's own
 *               predecessor insn IS the conditional jump
 *    :478/:480  `temp2 = next_active_insn (insn)` … `single_set (temp2)`   the `x = b;` arm, ONE insn
 *    :482/:483  `! side_effects_p` … `! may_trap_p (SET_SRC (temp4))`      …and speculatable
 *
 *  THE HEAD TEST — both arms' SOLE predecessor being the same `cond_br` — is what keeps out the
 *  three two-predecessor joins this rule has no evidence about:
 *
 *    • a LOOP HEADER, whose preheader and latch really are distinct non-branching predecessors, and
 *      `gcc/jump.c` never considers a back edge. Their sole predecessors differ.
 *    • a FRONTEND-INVENTED join: an empty forwarding block cut at a label is an "arm" with no insn
 *      for `:480`'s `single_set` to match, and its own predecessor is another join.
 *    • the ENTRY block, whose implicit entry edge a predecessor map cannot see (the trap
 *      `raise/divpow2.ts:92-98` documents for the same recognizer).
 *
 *  `raise/divpow2.ts:99-115` walks a ONE-armed diamond (head → bias arm → merge, plus a direct
 *  head → merge edge) and is deliberately not shared with this: that pass DELETES a block and needs
 *  the arm's contents, this one only reads a shape.
 *
 *  THESE REFUSALS ARE NOT `NARROW_LOCAL_GATES` ENTRIES and cannot be: a gate rejects a CANDIDATE,
 *  and these are per-BLOCK shape facts read once per function, before any candidate exists. What
 *  the candidate carries instead is the ANSWER, split so a census can attribute it — `mergeDiamond`
 *  for the shape and `armsHoistable` for the arms. Their reach, over the 13733 blocks of 2288 sa3
 *  sources, first refusal only: pred-count 10734, arm-not-br 2169, head-not-shared 387,
 *  arm-unsafe-op 324, arm-op-count 59, head-not-cond_br 1, entry-block 0, and 59 hoistable. The
 *  entry-block guard is the one that never fires there; it stays because the shape it refuses is a
 *  wrong ANSWER rather than a missing one, and refusing costs nothing. */
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
  if (ht === undefined || ht.opcode !== 'cond_br') {
    return null;
  }
  return [x, y];
}

/** ONE INSN HOLDING ONE SET, approximated over the lifted IR — `gcc/jump.c:474`/`:480`'s
 *  `single_set` and `:482`/`:483`'s `! side_effects_p` / `! may_trap_p` beside it. THREE THINGS AN
 *  OP COUNT ALONE GETS WRONG, and the first two are the benchmark rows `mergeldcast`/`mergepool`:
 *
 *    • a MEMORY READ is one op and is NOT one speculatable SET. `gcc/rtlanal.c:1770-1771` sends a
 *      MEM to `rtx_addr_can_trap_p` and `:144-147` says an address held in a plain pseudo CAN trap,
 *      so `jump.c` never hoists a load and the diamond survives under BOTH spellings, carrying no
 *      information. `REEVAL_UNSAFE_OPS` answers this (effects, reads, or traps — `may_trap_p`
 *      refuses the trapping divides too, at `rtlanal.c:1774-1784`); `HOIST_UNSAFE_OPS` does NOT,
 *      because it omits reads for `raise/shortcircuit.ts`, whose arm C's own `&&` re-guards, and
 *      that exemption does not transfer to speculation above a compare.
 *    • a CONSTANT is not free. `v = a + 0x12345` is a literal-pool `ldr` plus the `add` — two
 *      insns, no `single_set` — while `v = a + 3` is one `adds`. The lifted IR spells both as
 *      `const` feeding `add` and does not say which immediate the target can fold, so constants
 *      COUNT: refusing the foldable case costs nothing, because agbcc really does hoist it and the
 *      join is then not a diamond at all.
 *    • an arm with NOTHING in it is not one SET either — which is why the budget is EXACTLY one and
 *      not at most one: `:480` runs `single_set` on the arm's own insn, and an arm whose only insn
 *      is its jump has none.
 *
 *  Over-refusal here is free by construction: it returns the carrier to the wide-local-plus-cast
 *  spelling this pass emits without the clause. */
function armIsOneSet(b: Block): boolean {
  return (
    !b.ops.some((op) => REEVAL_UNSAFE_OPS.has(op.opcode)) && b.ops.filter((op) => op.results.length > 0).length === 1
  );
}

/** The join shape of every block, read ONCE off the IR it is handed.
 *
 *  WHERE it is read is part of the rule, because the shape is a claim about what AGBCC emitted and
 *  asmlift rewrites the CFG on the way here. Two rewriters move it:
 *
 *    • this pass itself, which deletes an extension and re-enumerates: an arm whose `lsl/asr/add` a
 *      SIBLING carrier's narrowing just shortened to `add` would re-read as one SET.
 *    • the twelve pre-recovery passes ahead of it, eight of them followed by `dce`. Over sa3, 20
 *      blocks gain `diamond` and 10 gain `hoistable` between lift and narrowlocal's turn, and
 *      `branch-shortcircuit` accounts for all 10 (`IsWorldPtActive`, `IsScreenPtActive`,
 *      `sub_802C0D4`, `sub_802C1F8`, …): `raise/shortcircuit.ts` MANUFACTURES the shape out of
 *      condition trees the ROM never merged, and the head test does not answer it, because the head
 *      test PASSES on exactly those blocks.
 *
 *  So `runPreRecovery` calls this ONCE before the first pass and threads the map down
 *  (`PreRecoveryFacts`). A block a later pass creates is absent from the map and reads as no
 *  diamond, which refuses it.
 *
 *  IT IS STILL NOT THE ROM: the frontend cuts blocks at labels and `applyIdiomPatterns` folds shift
 *  pairs into casts before pre-recovery runs, so this is the CFG as it ENTERS pre-recovery, the
 *  earliest point any pass can name. Both of those only ever make an arm SHORTER, so they can admit
 *  a diamond gcc's guard would have refused. */
export function mergeShapes(fn: Fn): Map<Block, MergeShape> {
  const preds = predecessors(fn);
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
          mergeDiamond: shape.diamond,
          armsHoistable: shape.hoistable,
          targetHoistsSingleSetArm: opts.hoistsSingleSetArm === true,
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
  // The join shape, read before ANY pre-recovery pass rewrote the CFG — `mergeShapes` says why the
  // reading point is part of the rule. Defaulted for callers with no pass list around them (the
  // tests). Everything else the gates read is re-enumerated after every rewrite, deliberately.
  shapes: Map<Block, MergeShape> = mergeShapes(fn),
): number {
  let narrowed = 0;
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
