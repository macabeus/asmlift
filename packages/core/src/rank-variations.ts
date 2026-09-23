// asmlift — the candidate-enumeration TABLES, split out of rank.ts so the enumeration driver and
// the data it walks are two files. Every table here is DATA the driver derives from: adding a
// structure variation, a stacked variation or a base-CSE hoist is one entry in one of these lists, and the
// driver reads it without a second hand-edited site.
//
// DECLARATION ORDER IS PUBLISHED BEHAVIOUR. `compareScored` breaks a score tie by enumeration
// order, so the order of `STRUCTURE_VARIATIONS`, `STACKED_VARIATIONS` and every `*_HOISTS` roster
// decides which of two byte-identical candidates wins and gets its variations into
// `results.json`. Reordering one of these arrays is a behaviour change wearing a cleanup's
// clothes — never do it as tidying.
//
// A SIBLING MODULE, never a `rank/` directory: a directory named `rank` beside `rank.ts` is a
// resolver trap, and `@asmlift/core`'s `"./*": "./src/*.ts"` export map addresses these files by
// name.
import { globalCellOf } from './ir/alias';
import type { Fn, Op, Value } from './ir/core';
import { successorsOf } from './ir/core';
import type { SFn } from './l3/ast';
import {
  BASEFOLD_GATES,
  type BaseKey,
  LIVEBASE_BLOCK_GATES,
  LIVEBASE_GATES,
  ORDERBASE_GATES,
  UNFOLDED_GATES,
} from './l3/basecse';
import type { Gate } from './l3/gates';
import type { HoistPlacement } from './l3/hoist';
import { initFirstGuards } from './l3/initfirst';
import { pollGuards, pollReads } from './l3/pollguard';
import { unmergeJoins } from './l3/unmerge';
// TYPE-ONLY, and deliberately: the structure-variation table types its `options` as
// `Parameters<typeof structureChecked>[1]`, which needs the binding in a `typeof` position and
// nothing at runtime. A value import here would make this module depend on the whole pipeline.
import type { structureChecked } from './pipeline';
import {
  hasDerivedReadHome,
  hasEscapingExtension,
  hasHomeableSharedAddress,
  hasLoopSharedPureValue,
  hasMergeFeedHome,
} from './structure/analysis';
import { edgeCopyOrdersDiffer, hasParamRootedMerge } from './structure/structure';
import type { VariationName } from './variation-tokens';

/** The STRUCTURE VARIATIONS — the boolean candidate dimensions crossed into every enumeration
 *  (after signedness/branch-sense/defsite/bitfields, which have their own shapes). One entry per
 *  variation; chain construction, the dropped-sibling strip closure, the per-candidate
 *  StructureOptions, and the default-setting abort guard all derive from this table, so a new
 *  structure variation is one entry — not four hand-edited sites that can drift.
 *
 *  `sharedGate` gates the alternative's ENUMERATION on the shared lift (the only thing the
 *  variation can change must exist at all); `perLiftGate` re-evaluates per symbol-map setting on
 *  that setting's own lifted fn (a map-lifted shared lift spells const bases as gaddr, which would
 *  blind the /raw-globals siblings — the /addr-home lesson). `strip` opts the variation into the
 *  dropped-sibling closure: a candidate that applies it is skipped when its default sibling (the
 *  same setting without it) failed the boundary contracts. Which of these entries `structure()`'s
 *  `assertDefaultAccepts` guard does NOT reset — the ones that cannot unlock a function the default
 *  declines, and so carry a written argument in place of the guard — is stated ONCE, beside that
 *  guard in structure.ts, and derived from the guard's own reset list in
 *  test/variation-offers.test.ts — never restated here, where a second copy drifts from the guard
 *  without anything going red. */
export interface StructureVariation {
  flag:
    | 'reread'
    | 'inplace'
    | 'mergeNames'
    | 'addrHome'
    | 'exprHome'
    | 'derivedHome'
    | 'mergeHome'
    | 'escapeHome'
    | 'unsCmp'
    | 'freshMerge'
    | 'copyDefPos'
    | 'siteSense';
  name: VariationName;
  options: (on: boolean) => Parameters<typeof structureChecked>[1];
  sharedGate?: (sharedLift: Fn, defs: Map<Value, Op>) => boolean;
  perLiftGate?: (fn: Fn) => boolean;
  strip: boolean;
}
export const STRUCTURE_VARIATIONS: readonly StructureVariation[] = [
  // `/reread-globals` — the VALUE-HOME variation (structure/analysis.ts AnalyzeOptions). Whether the
  // source read a global once into a variable or re-read it at each use is not derivable from
  // asm: the compiler CSEs the second spelling back into one load, and the round-5 dogfood
  // watched agbcc land on both sides inside a single function (its highest-cost defect, 25 of
  // 27 points on one klonoa function and 35/50 both ways on another). Gated on the function
  // having a load that resolves to a named global at all.
  {
    flag: 'reread',
    name: 'reread-globals',
    options: (on) => ({ rereadGlobals: on }),
    sharedGate: (sharedLift, defs) =>
      sharedLift.blocks.some((b) =>
        b.ops.some((op) => op.opcode === 'load' && globalCellOf(defs, op.operands[0], op.attrs.off as number) !== null),
      ),
    strip: false,
  },
  // `/inplace` — materialize a load that feeds a `cond_br` join arg (structure.ts
  // materializeJoinFeeds), so the merge homes in the load's own variable and the identity arm
  // elides to a one-sided in-place overwrite (`v = *p; if (v > 31) v = 32;`). The recompiled
  // code differs (the two-sided form needs a second register — at the margin a callee-save
  // push — and the emptied arm flips the branch sense). Gated on a load-fed cond_br arg.
  {
    flag: 'inplace',
    name: 'inplace',
    options: (on) => ({ materializeJoinFeeds: on }),
    sharedGate: (sharedLift, defs) =>
      sharedLift.blocks.some((b) =>
        b.ops.some(
          (op) =>
            op.opcode === 'cond_br' && op.successors.some((sx) => sx.args.some((a) => defs.get(a)?.opcode === 'load')),
        ),
      ),
    strip: true,
  },
  // `/merge-names` — coalesce two variables a merge copy would join when the values under them
  // never interfere (structure/namecoalesce.ts). Whether the source had one variable there is
  // not derivable, and the copies are worth less than they look — agbcc coalesces most of them
  // itself, so which side scores better is per-function. Gated on a merge fed by 2+ edges.
  {
    flag: 'mergeNames',
    name: 'merge-names',
    options: (on) => ({ coalesceMergeNames: on }),
    sharedGate: (sharedLift) =>
      sharedLift.blocks
        .slice(1)
        .some(
          (b) =>
            b.params.length > 0 && new Set(sharedLift.blocks.filter((pr) => successorsOf(pr).includes(b))).size > 1,
        ),
    strip: true,
  },
  // `/addr-home` — the address-home variation (structure/analysis.ts AnalyzeOptions
  // homeSharedAddresses): a pure computed address dereferenced at 2+ sites, and the multi-render
  // loads through it, materialize into locals — the source's pointer-local + scalar-temp
  // spelling, where the default re-derives per use (a pool literal per folded offset). Gated PER
  // SYMBOL-MAP SETTING (see the table doc) on that setting's own lifted fn having a homeable base.
  {
    flag: 'addrHome',
    name: 'addr-home',
    options: (on) => ({ homeSharedAddresses: on }),
    perLiftGate: hasHomeableSharedAddress,
    strip: true,
  },
  // `/expr-home` — the loop-expression-home variation (structure/analysis.ts AnalyzeOptions
  // homeLoopExprs): a pure value defined outside a loop with 2+ distinct consumers, at least one
  // of them inside it, materializes into a local carrying the value's recovered type — the register
  // the compiler holds across the iterations (`u32 size = 16 << t;` driving a loop bound, a product
  // and a shift), where the default re-derives per use. Gated per symbol-map setting like `/addr-home`
  // (the cone refusal reads the setting's own lift).
  {
    flag: 'exprHome',
    name: 'expr-home',
    options: (on) => ({ homeLoopExprs: on }),
    perLiftGate: hasLoopSharedPureValue,
    strip: true,
  },
  // `/derived-home` — the derived-read-home variation (structure/analysis.ts AnalyzeOptions
  // homeDerivedReads): a pure value with 2+ consumers standing on a memory read materializes, and
  // the read then renders once inside it — the register the asm carried the DERIVED value in
  // (`eor r1,r1,r0` keeps `0x3FF ^ REG_KEYINPUT`), where the default homes the read and re-derives
  // the computation at every use. Both spellings compile (agbcc CSEs the re-derivation back), so
  // the differ referees. Gated per symbol-map setting like its `/addr-home` and `/expr-home` siblings,
  // and for the same reason the /addr-home lesson names: the scope refuses a cone holding a
  // standalone address, and a pool constant the map lifts to a `gaddr` is a bare `const` in the
  // `/raw-globals` sibling — so the two settings genuinely answer differently.
  {
    flag: 'derivedHome',
    name: 'derived-home',
    options: (on) => ({ homeDerivedReads: on }),
    perLiftGate: hasDerivedReadHome,
    strip: true,
  },
  // `/merge-home` — the merge-feed-home variation (structure/analysis.ts AnalyzeOptions
  // homeMergeFeeds): a pure value one join's incoming edges render into the SAME parameter slot
  // from 2+ places materializes in the block that dominates them — the value the source computed
  // once above the branch (`s32 m = (b & 1) ? 0x400 : 0;`), where the default has no name to
  // reference on an edge and re-derives the whole expression per arm. Gated per symbol-map setting on
  // the scope itself rather than on an approximation of it.
  //
  // A VARIATION, not a default: forced on, the spelling is REPLACED across the fan rather than
  // added to it, which costs `kleod:MultiplyQ8` (measured on kl-eod-decomp's source, before 2026-09-13) and `pokeemerald:MathUtil_Mul16` their matches
  // (and cost `MultiplyQ4`, its byte-for-byte twin, until the 2026-09 kleod source swap retired that
  // row as a duplicate). As a variation that is unreachable — `compareScored`
  // orders by score and the un-homed sibling rides beside it.
  //
  // Its fan is essentially one row's: over the corpus rows the gate admits, 2790 → 5841
  // candidates map-less and 2538 → 5363 with a map, of which `kleod:UpdateCameraScroll` (outcome
  // `noncompile`, so they buy nothing) is +2944 and +2752, three rows add none at all where
  // `/defsite` already spells the same tree, and the rest pay 107 and 73 between them.
  //
  // THAT CENSUS IS A STATEMENT ABOUT `hasMergeFeedHome`'s ADMITTED SET, and the admitted set is not
  // a property of this file: it moves whenever an upstream pass changes whether a merge feed still
  // EXISTS in the IR. It now reads **20** of the 804 rows that lift (mine, both tiers), three more
  // than the same census over the tree before this branch: `synthetic:sinkacc:agbcc`,
  // `kleod:CountCollectedGems:agbcc` and `kleod:CheckWorldCompletion:agbcc`, which `raise/const.ts`
  // gained by REFUSING to fold an accumulator's `add(const 0, const 1)` and so keeping the feed
  // alive for this gate to see. Re-measure the counts above before tuning off them — the number
  // recorded here has gone stale once already.
  {
    flag: 'mergeHome',
    name: 'merge-home',
    options: (on) => ({ homeMergeFeeds: on }),
    perLiftGate: hasMergeFeedHome,
    strip: true,
  },
  // `/escape-home` — the escaping-extension-home variation (structure/analysis.ts AnalyzeOptions
  // homeEscapingExtensions): a `zext`/`sext` with 2+ consumers, none of them in its own block,
  // materializes into a local — the register the asm narrowed into once and every later block read
  // — where the default re-evaluates the truncation at each consumer (`(u16)v` per use). The
  // MIRROR of `/expr-home`, which wants a def outside a loop and a consumer inside; neither scope
  // reaches the other's shape. Gated per symbol-map setting like its four siblings.
  //
  // A VARIATION, not a default, and `pokeemerald:AcroBikeHandleInputTurning:agbcc` is the row that
  // decides it: it is a MATCH inside the scope, so forced on the spelling would be REPLACED across
  // the fan rather than added to it. As a variation `compareScored` rides the un-homed sibling
  // beside it and the match cannot be lost — the same argument `/merge-home` records above.
  {
    flag: 'escapeHome',
    name: 'escape-home',
    options: (on) => ({ homeEscapingExtensions: on }),
    perLiftGate: hasEscapingExtension,
    strip: true,
  },
  // `/uns-cmp` — spell unsigned compares unsigned (structure.ts unsignedCompareSpelling): an
  // icmp_u* operand takes a (u32) cast where the rendered operands do not guarantee the
  // unsignedness, and a mixed-claimant declaration reconciles to u32 when nothing under the
  // name needs signed. Which side the source spelled is genuinely ambiguous: a signed spelling
  // that byte-matched was PROVED non-negative by the compiler (only then does it emit the
  // unsigned branch from a signed compare), and emission's provable set is smaller than the
  // compiler's. Gated on the function having an unsigned compare at all.
  {
    flag: 'unsCmp',
    name: 'uns-cmp',
    options: (on) => ({ unsignedCompareSpelling: on }),
    sharedGate: (sharedLift) => sharedLift.blocks.some((b) => b.ops.some((op) => op.opcode.startsWith('icmp_u'))),
    strip: true,
  },
  // `/fresh-merge` — the parameter-merge-home variation (structure.ts `freshParamMerge`, whose
  // `FRESH_MERGE_GATES` carry the argument): a merge whose carrier is a parameter takes its own
  // local (`if (a1 < a0) { v0 = a0; } else { v0 = a1; }`) where the default assigns back into the
  // parameter (`if (a1 < a0) a1 = a0;`). Both are ordinary C over the same values, so
  // the differ decides. At TWO arguments they compile to the SAME bytes on agbcc and on mwcc
  // (measured, both directions), which is why `maxi`/`mini` hold under the variation.
  //
  // IT ALSO UNLOCKS `/defsite`. `anchorConstCopies` refuses a merge whose name claims another SSA
  // value, so a merge that adopted its parameter is never anchored, while a minted home is sole by
  // construction and clears that one refusal — a constant arm then writes above the branch, where
  // the remaining placement rules allow it. That pair spells m2c's own
  // `v0 = 0xFF; if (a0 <= 0xFF) v0 = a0;`, which is how `synthetic:clampu8:mwcc_242_81` matches
  // under `signed/defsite/fresh-merge` — `signed/defsite` is inert on the base tree and does not
  // appear in that row's fan at all. Priced at the guard it widens: sole-claimant admissions go
  // 196 → 245, 34 rows gaining 49 merges between them. A DELTA WITHOUT ITS DENOMINATOR, on
  // purpose — the corpus grows, so the row count that census ran over is not today's and quoting
  // it would read as verified. Re-run the sweep before budgeting against the totals.
  //
  // Gated on `hasParamRootedMerge`, which lives beside the rule it over-approximates. Structural,
  // so it cannot answer differently per symbol-map setting.
  {
    flag: 'freshMerge',
    name: 'fresh-merge',
    options: (on) => ({ freshParamMerge: on }),
    sharedGate: (sharedLift) => hasParamRootedMerge(sharedLift),
    strip: true,
  },
  // `/copy-defpos` — the EDGE-COPY ORDER variation (structure.ts `preferDefPosCopyOrder`). The frontend
  // measures the order each predecessor wrote its successors' keys (ir/core.ts `WriteOrder`) and
  // the default lays the edge's copies out in it. That the compiler laid its copies out in the
  // order it wrote them is only licensed for a CYCLIC copy set, where the spill has to be the
  // register whose old value was displaced first; for an acyclic set it is an assumption, and the
  // benchmark answers it BOTH WAYS INSIDE ONE COMPILER: `synthetic:gcd:mwcc_242_81` matches only
  // with the record, while `memcpy1:mwcc_242_81` (19 → 23) and `memset1:mwcc_242_81` (19 → 21)
  // score worse with it, as does `armfall:agbcc` (8 → 11). A per-compiler boolean cannot decide a
  // question with rows on both sides of it inside one compiler, and a variation that emits one tree
  // referees nothing — so the def-position spelling is enumerated beside the record's and the
  // differ picks, exactly as `/fresh-merge` above does for the merge home.
  //
  // THE VARIATION SPANS THE UNLICENSED HALF ONLY: its alternative keeps the record on cyclic sets,
  // so neither spelling puts a cycle against the instruction that names the compiler's temp. Over the
  // whole benchmark corpus that scoping moves nothing — `memcpy1`, `memset1` and `armfall` keep their
  // `/copy-defpos` winners, so the acyclic half is what they needed — and it makes one spelling
  // reachable that neither whole-function spelling has: the record on a cycle and the proxy on an
  // acyclic edge of the same function, which is what `synthetic:gcd:agbcc`'s two edges want.
  //
  // Gated on the two orders actually differing somewhere in this function, so on a row where the
  // record changes nothing the pair is one tree and the fan does not grow. PER SYMBOL-MAP SETTING,
  // on that setting's own fully-raised fn, because that is `structure()`'s own input and only there
  // is withholding provably inert: same fn, same comparators, so a false answer means the
  // alternative would structure the tree the default already produced. Asked any earlier the claim does not
  // follow, and both ways it fails are real —
  //   - THE SYMBOL-MAP SETTING. klonoa's `UpdateHUDCollectibleCount` answers false with the kleod map
  //     and true on the `/raw-globals` sibling's own lift (fixture: test/corpus/agbcc-hudcount.s).
  //   - THE STAGE. A shared lift stopping after `recoverTypes` is asked before `foldEmptyLatches`
  //     (raise/latch.ts) repoints edges and rewrites the record the gate reads: klonoa's
  //     `EntityGravityAndFloorCheck` answers false there and true after that fold.
  // Neither costs candidates today — over 192 klonoa functions enumerated with the map the fan is
  // 27,847 either way, 1,970 of them `/copy-defpos`. `strip` like its neighbours: a reordering
  // cannot rescue a spelling whose default sibling failed the boundary contracts.
  {
    flag: 'copyDefPos',
    name: 'copy-defpos',
    options: (on) => ({ preferDefPosCopyOrder: on }),
    perLiftGate: edgeCopyOrdersDiffer,
    strip: true,
  },
  // `/site-sense` — spell a folded short-circuit `if` from the FOLD'S own orientation evidence
  // rather than from the per-function branch-sense boolean (structure.ts senseFromFoldEvidence,
  // raise/shortcircuit.ts `scSharedOnFall` + `scSharedIsTaken` + `scEdgeRelayed`). The two sense
  // booleans are per FUNCTION, so a function whose `if`s were written in opposite senses reaches
  // neither spelling: over `synthetic:mixsense`'s four divergent ladder sites the whole 2^4
  // per-site enumeration scores 10 at the source's own mixed configuration against 20 and 27 for
  // the two the booleans reach,
  // and `synthetic:joinsense` MATCHES at a mix the booleans cannot spell.
  //
  // WHY IT IS A VARIATION AND NOT THE DEFAULT. The reading rests on gcc laying a condition's arms out
  // in SOURCE ORDER, so that a shared block the last test FELL INTO is the source's `then`. That is
  // a claim about one compiler's layout, and the differ is what referees it per row — the long
  // branch is the layout that BREAKS it, gcc inverting the last test and laying the `else` arm
  // first (`synthetic:ifand_far` and `synthetic:ifor_far`, whose scores cannot referee anything:
  // both MATCH on `/flip-join` either way, so their spellings are pinned by
  // test/site-sense.test.ts instead).
  //
  // The premise is only ever consulted where it decides something. The fold also stamps the
  // successor SLOT the shared arm landed in, and a shared arm in the FALL slot leaves the source's
  // `then` in the taken slot whichever way the last test went — so at a CHAINED fold, whose outer
  // `^g` is the head's taken edge, the site is positive and does not ask the premise at all
  // (`synthetic:chainsense`, 4/44 when only the source arm is read, MATCH once the slot is). The THIRD stamp
  // is the long-branch trampoline, the layout where the premise is known to be false: it is the one
  // cell that is GUARDED rather than consulted, and without it the long `||` presents the same two
  // booleans as the short `&&` and is spelled its own dual (`synthetic:ifor_far`, the row added for
  // exactly that cell).
  //
  // THE MAPPING IS STILL NOT A FUNCTION, which is the standing reason this is a variation rather
  // than a default: at `(scSharedOnFall=true, scSharedIsTaken=false)` the corpus holds one function with
  // two sites of OPPOSITE source sense (`kleod:CheckWorldCompletion:agbcc`, 45/191 and unmoved
  // because `/site-sense` is not its winner), so no constant is right there. Read the table in
  // structure.ts as the best per-site default, never as a decision procedure — the enumeration that
  // does not have to pick is `rank.ts`'s per-site `/sense-N` measurement.
  //
  // Gated on this lift's own fully-raised fn carrying a stamped branch at all, for
  // `/copy-defpos`'s reason one entry up: the `/connective` lift variation and the symbol-map
  // settings each change which sites fold, and a gate asked on a different lift would govern a fan
  // it did not measure. A function with no fold structures the identical tree either way and the
  // tree dedup collapses the pair before any compile.
  //
  // NOT in the strip closure, like the two per-function sense variations it refines — which are not in
  // this table at all. `negateCond` is total (l3/ast.ts: a relational opcode swaps, a connective
  // distributes, anything else takes a `!`), so re-spelling a sense can neither throw nor let a
  // candidate structure a function the default declines; there is no failing default sibling for
  // an alternative to ride past.
  {
    flag: 'siteSense',
    name: 'site-sense',
    options: (on) => ({ senseFromFoldEvidence: on }),
    // ALL THREE stamps, which is the predicate the consumer admits a site on (structure.ts's
    // `senseFromFoldEvidence` site default): one contract, not two spellings of it in two files.
    // The fold writes the three in one object literal, so this is the same set of functions today —
    // measured, 0 partially-stamped sites over the 1037 committed rows at both `/connective`
    // settings.
    perLiftGate: (fn) =>
      fn.blocks.some((b) =>
        b.ops.some(
          (op) =>
            typeof op.attrs.scSharedOnFall === 'boolean' &&
            typeof op.attrs.scSharedIsTaken === 'boolean' &&
            typeof op.attrs.scEdgeRelayed === 'boolean',
        ),
      ),
    strip: false,
  },
];

/** The STACKED variations (sanctioned in the POLICY note at rank.ts's respell site): each entry is
 *  a statement-order/shape respell variation orthogonal to every other respell variation, derived
 *  onto every source. Each fires alone, plus
 *  all of them together in table order — not the full subset lattice; the pairs question is
 *  settled by applyStacked' skip-on-decline below, and a row demanding a true EXCLUSION pair —
 *  all three fire, the match needs exactly two — is what would earn the lattice. */
export const STACKED_VARIATIONS: { name: VariationName; apply: (sfn: SFn) => SFn | null }[] = [
  { name: 'initfirst', apply: initFirstGuards },
  { name: 'pollguard', apply: pollGuards },
  { name: 'pollread', apply: pollReads },
];

/** The PRE-RESPELL variations (sanctioned in the POLICY note at rank.ts's respell site): a tree
 *  rewrite applied BEFORE the respell set, so the whole set derives from its output instead of
 *  composing onto it. Same record type as STACKED_VARIATIONS above, and deliberately so — the only difference is
 *  WHERE it is applied, and that is the whole admission bar.
 *
 *  ADMITTED on one ground: the spelling a row demands needs a downstream respell variation to run on this
 *  rewrite's OUTPUT, and the measured pair shows neither order alone reaches it. For `/unmerge`
 *  (l3/unmerge.ts, the dual of the unconditional `tailmerge`) that measurement is
 *  `synthetic:dmascope`: the un-merged store has to land inside the arm's own region base
 *  (`p0[2] = …`), which only a base-hoisting variation running AFTER the un-merge can spell — hand-compiled,
 *  that source is byte-exact where the merged spelling the structurer produces is 9, and applying
 *  the un-merge to the WINNER's tree instead measures 14. Every other respell variation derives
 *  from the structured tree it is handed, before any other respell variation, so the order can
 *  only be had this way.
 *
 *  A pre-respell variation only ADDS candidates, so it cannot cost a match; its price is a second
 *  respell set on every tree where the rewrite fires, which is why the table is not a place to put
 *  a variation that would compose perfectly well as a `respell`.
 *
 *  NOT A SECOND ADMISSION GROUND — the bar above is still WHERE the rewrite is applied, and sign
 *  base-dependence discriminates nothing (every variation in this file has a base-dependent price).
 *  What follows is why the variation is ENUMERATED at all. `/unmerge`'S SIGN IS A PROPERTY OF THE
 *  BASE, NOT OF THE VARIATION. One variation, one row (`kleod:CountCollectedGems:agbcc`), with the
 *  variation untouched throughout — two MEASUREMENTS and three GRAFTS, kept apart because a graft is
 *  a lower bound with an unreliable sign AND magnitude, which this very variation then demonstrated:
 *
 *    MEASURED  +44   against the #172-era winner (three routes: the fan's own candidate, a graft,
 *                    a recompile)
 *    MEASURED  +24   at #169's base
 *    GRAFT      +2   at a flat ladder
 *    GRAFT      −3   at flat + no-copies — #172 published this as the prediction for THIS round;
 *                    the build delivered −17, an under-read of 5.7×
 *    GRAFT      +4   at flat + no-copies + connective — the rung a connective round makes real, and
 *                    the ONLY one where the sign goes back POSITIVE at a base strictly CLOSER to
 *                    the reference. Quote it with the rest: it says the "−17, among the winner's
 *                    variations" state below may not survive the next rung.
 *    MEASURED  −17/352  once #184 and #185 made the flat+no-copies base real
 *
 *  Six numbers, two signs. Nothing about the tree changed the variation; what changed was which tree the
 *  fan derives from, and the fan is itself choosing that tree. So the mapping from a tree to "is the
 *  merged tail cheaper" is not a function of anything a gate here could read, and no predicate this
 *  pass could evaluate settles it. That is what enumeration is for. The corollary a future author
 *  needs more than the rule: MEASURING A VARIATION AT +44 ON TODAY'S WINNER DOES NOT REFUTE IT.
 *  `/unmerge` was the most expensive variation on that row for three rounds and is among its
 *  winner's variations now, with no change to the variation at all.
 *
 *  WHAT ENUMERATION BUYS AND WHAT IT DOES NOT. It buys the whole-function delta above being honest
 *  — the differ picks, so the number cannot be WRONG. It buys no REACH: `unmergeJoins` rewrites
 *  every site clearing its gates and returns one tree, so the fan carries TWO trees, all-merged
 *  and all-un-merged, never 2^k, and a function wanting site A un-merged and site B merged has no
 *  candidate. Measured, not assumed — `unmergeAt`'s SUCCESSFUL returns counted per call under an
 *  instrumented `unmergeJoins` (`bench gates --pass unmerge` tallies each rule's REFUSALS and never
 *  a success), over the synthetic agbcc tier: k = 1 on 23 of the 25 firing rows and on
 *  `kleod:CountCollectedGems:agbcc` itself, k = 2 on `synthetic:joinsame` and
 *  `synthetic:joinsense` — both MATCH, so the refusal costs nothing today. State it as PR #120
 *  states its own: a price, never an immunity.
 *
 *  WHAT BREAKS IF THIS TABLE IS EMPTIED, so an author editing here is not measuring it again:
 *  twelve MATCH rows fall, `sa3:numToASCII:agbcc` (REAL-TIER) among them, plus
 *  `synthetic:dmascope`, `synthetic:dmascope2`, `synthetic:joinsame`, `synthetic:joinsense`,
 *  `synthetic:armcb`, `synthetic:armcb2`, `synthetic:ladder4`, `synthetic:ladder5`,
 *  `synthetic:ladidx1`, `synthetic:ladidx2`, `synthetic:revlad5s`. `bench regression` is an
 *  OUTCOME gate over all tiers, so every one of them turns it red — but `benchmark.yml` is
 *  `workflow_dispatch`, manual, with no cron, so nothing runs that gate on a PR. The scores and the
 *  method are in `apps/benchmark/dataset/synthetic.ts`'s `/unmerge` block. */
export const PRE_RESPELL_VARIATIONS: typeof STACKED_VARIATIONS = [{ name: 'unmerge', apply: unmergeJoins }];

export const STACKED_SUBSETS: (typeof STACKED_VARIATIONS)[number][][] = [
  ...STACKED_VARIATIONS.map((x) => [x]),
  ...(STACKED_VARIATIONS.length > 1 ? [STACKED_VARIATIONS] : []),
];

/** The subset applied in table order, SKIP-ON-DECLINE: a member that declines contributes
 *  nothing rather than killing the combination — the all-shapes candidate is "everything that
 *  fires", so a pair is reachable whenever the third declines. The variations are the members that
 *  actually FIRED, so they never name a variation that declined; a fired-set that
 *  duplicates a smaller subset emits identical source and the dedup collapses it. Null when
 *  nothing fired. */
export const applyStacked = (
  subset: readonly (typeof STACKED_VARIATIONS)[number][],
  from: SFn,
): { out: SFn; variations: VariationName[] } | null => {
  let cur = from;
  const fired: VariationName[] = [];
  for (const sp of subset) {
    const r = sp.apply(cur);
    if (r) {
      cur = r;
      fired.push(sp.name);
    }
  }
  return fired.length > 0 ? { out: cur, variations: fired } : null;
};

/** The locals a variation added — a NAME diff rather than a positional slice, so a pass that ever
 *  reorders locals cannot silently empty the set. It is what scopes `/volatile` to the pointers
 *  the variation itself created (volatilePtrLocals' `only`), leaving the tree's own locals alone. */
export const createdLocals = (from: SFn, to: SFn): Set<string> => {
  const before = new Set(from.locals.map((l) => l.name));
  return new Set(to.locals.filter((l) => !before.has(l.name)).map((l) => l.name));
};

/** The base-CSE HOISTS `/livebase` offers the differ, widest first. WHICH of several numeric
 *  bases the source named is per-base knowledge the asm does not carry — a DMA register file wants
 *  one register held across the whole body while the IWRAM halfword beside it re-materializes — so
 *  each hoist rides as its own candidate and the differ referees between them. A new
 *  hoist is one entry here, one gate table, and that table's line in the gate-contract
 *  roster — not nine hand-edited sites that can drift; whether it also joins the `/livebase`
 *  PAIRINGS is the entry's own `pairings`. A MIRROR hoist (bind the scalar cells, leave
 *  the register file inline) is that, with the complementary predicate; it is never another entry
 *  in LIVEBASE_BLOCK_GATES, which can only reject more.
 *
 *  WHAT BOUNDS IT. A hoist declines unless it binds a non-empty set of bases no earlier hoist
 *  already bound, and each composition declines wherever its own variation does, so the list widens
 *  only where an inhabitant exists — over the corpus the second hoist reaches 8 rows, its
 *  `/nearbase` pairing 3, and its `/indexed` and `/coalesce` pairings and its volatile subsets none
 *  at all. A function
 *  inhabiting them all pays far more, and the fan is not always a win there: the mixpoll dataset
 *  entry prices one where the `/coalesce` pairing costs the most candidates of any and scores two
 *  points worse than going unpaired. THAT row fans anyway because on the `/livebase` hoists a
 *  pairing belongs to the VARIATION rather than to one of its hoists — but it is a per-hoist
 *  decision, not a property of the roster: three of the five hoists below are unpaired. `pairings`
 *  is the field, and its own doc says how a hoist earns a `true`.
 *
 *  `/basefold` is the third and fourth hoist and `/unfolded` the fifth; those three are the
 *  conditional set — their registry entries' target gate offers them only where the target declares
 *  `compilerBehaviors.foldsConstAddrOffset`. They need no second "did the default already carry
 *  this" test: `structureChecked` runs the DEFAULT hoist to its fixpoint before any tree reaches
 *  here, so a key still admissible is by construction one `BASECSE_GATES` rejected, and binding
 *  nothing is the whole of the decline.
 *  WHAT THE EXEMPTION REACHES, over the agbcc rows the artifact carried when the census ran and in
 *  BOTH symbol-map configurations — 451 observations, of which 39 do not lift on this one-tree
 *  census. The 451 is the census's OWN denominator, quoted so the "0 of 451" below has one; the
 *  corpus row count it came from is deliberately not, because that number has moved since.
 *  HOW TO REPRODUCE IT: the prototypes live inside `row.scripts.asmlift`'s `PROTO_INPUT`
 *  heredoc, and there is no `row.proto` field — a census reaching for one lifts all 451 with
 *  `prototypes: {}` while the harness scores every one of them with `--proto proto.json`, and
 *  says nothing about it. Numbers below are from the heredoc.
 *  20 observations bind a key the default table refuses, spread over 14 rows in 4 projects (6
 *  map-ful, 14 map-less), 25 keys in all. FOUR are numeric — two on `kleod:RollRandomLevelVariant`
 *  and one each on `synthetic:basecell` and `synthetic:foldsink`, all map-less, because with a map
 *  the pool constant lifts to a `gaddr` and the numeric clause stands down while the symbol clause
 *  takes over. The other 21 are SYMBOL keys over 11 rows in three projects (6 of those
 *  observations map-ful, 11 map-less), and all 21 are what the symbol half added: on the
 *  value-proxy predicate this replaced, the same census binds the 4 numeric keys and nothing else,
 *  losing none of them. `admittedBases(sfn, BASECSE_GATES)` — the COMMITTED table — differs on 0
 *  of 451, which is the check that says the widening stayed on the roster.
 *  A target that declares no fold is offered none of the three — not to protect a score (no roster
 *  row can cost one; see LIVEBASE_BLOCK_GATES) but because `unfoldedOffset` would be read as
 *  evidence on an instruction that carries the addend by construction, where there is none.
 *  On klonoa's `LoadBGTilemapData` — a checkout function rather than a row, so re-run it with the
 *  ranked command in docs/ranked-repro.md — the `/basefold` admission declines on every
 *  structuring, leaving that fan the size it was, with ZERO candidates carrying `basefold` in the
 *  control run. NO FAN TOTAL IS QUOTED HERE ON PURPOSE: that function's fan was 112896 at this
 *  commit and two five-figure numbers ago at others, and a DELTA outlives the total it was
 *  measured beside — which is what makes a stale paragraph read as verified. Re-run the total
 *  before budgeting against it. All floors, though: the ranked path structures each function many ways
 *  where this census builds one tree per observation.
 *
 *  WHAT THE PAIR COSTS, through the HARNESS's own enumeration and re-runnable from the recipe in
 *  the BASEFOLD_HOISTS note below: enumerate every agbcc row with the pair on and off,
 *  `ASMLIFT_CANDCACHE=0`, candidates only. The pair adds 3921
 *  distinct candidate sources over 14 observations — 3911 over 12 real rows and 10 over 2
 *  synthetic ones (`foldsink` 4 → 12, `basecell` 2 → 4) — and every per-row delta equals that
 *  row's count of candidates carrying `basefold` exactly, which is both what says the ablation
 *  reached and what says these are sources nothing earlier in the roster emits.
 *  It is CONCENTRATED, not spread: in the map configuration the harness uses on real rows,
 *  `kleod:ProcessInputAndUpdateEntities` takes +2880 (14976 → 17856),
 *  `kleod:UpdateCameraScroll` +512 (5968 → 6480), `kleod:CountCollectedGems` +192 (384 → 576),
 *  `kleod:UpdateWorldMapNodeAnim` +176 (488 → 664) and nothing else more than 32. Re-run a
 *  concentration figure before budgeting against it: a DELTA can reproduce while the fan it was
 *  quoted against has moved, and that is what makes a stale paragraph read as verified.
 *  `kleod:UpdateCameraScroll` is an `outcome: noncompile` row — `decompileRanked` throws only when
 *  EVERY candidate failed to build — so its whole fan is compiled and discarded, and this made
 *  that discard 10% bigger. Timed on two full bench runs on a shared box, and not re-timed since
 *  the deltas above, so read them as a floor rather than a price: that row 377.6s → 483.0s, the
 *  second 238.4s → 313.6s, real tier 416.1s → 529.4s. Priced — and the three rows the pair was
 *  bought with DO NOT BUY IT TODAY: ablated, `sa3:sub_803213C` is MATCH with the pair removed,
 *  `kleod:ProcessInputAndUpdateEntities` 211 either way and `kleod:CountCollectedGems` 290 either
 *  way. A SCORE QUOTED HERE IS THE ARTIFACT'S: it moves whenever anything at all moves the row,
 *  a basefold change or not, so re-read it off the artifact rather than off this line. Read the
 *  ablation in the note on BASEFOLD_HOISTS, which carries the fan counts that prove it
 *  reached. */
export interface BaseHoist {
  /** the variations this hoist's candidates carry, in name order */
  variations: readonly VariationName[];
  gates: readonly Gate<BaseKey>[];
  /** WHERE the locals this hoist binds are initialized (l3/hoist.ts). Eligibility and placement are
   *  two questions and this roster answers both, so a hoist can offer the same bases in the other
   *  position without a second gate table — and a variation that wants both offers both, as the
   *  `/basefold` pair below does. */
  placement: HoistPlacement;
  /** Whether the hoist joins the `/livebase ×` PAIRINGS in rank.ts. Each of those pairings was added
   *  for a row that demanded the joint spelling (see POLICY), and every demanding row so far is served
   *  by a `/livebase` hoist — so a new hoist joins them when a row demands it, not by roster
   *  membership.
   *
   *  ONE BOOLEAN PER HOIST, ANSWERING A QUESTION THAT IS REALLY PER FUNCTION, so a `false`
   *  here is a corpus claim and has to be measured like one — on the whole corpus, not on the
   *  synthetic row that earned the entry. The measurement is candidates-only and cheap: enumerate
   *  every agbcc row twice from `row.scripts.asmlift`'s heredocs and compare the distinct-source
   *  sets. For `/unfolded` (see its note) that is +912 sources over 8 rows (+1.92% corpus fan) and
   *  the only nonmatch among the 8 scores the same either way, which is what the `false` rests on.
   *  Flipping one of these is one character; the gate on doing it is that census plus a score on
   *  every row it moves. */
  pairings: boolean;
}

export const LIVEBASE_HOISTS: readonly BaseHoist[] = [
  { variations: ['livebase'], gates: LIVEBASE_GATES, placement: 'head', pairings: true },
  { variations: ['livebase-block'], gates: LIVEBASE_BLOCK_GATES, placement: 'head', pairings: true },
];

/** Narrower than either `/livebase` hoist, so both go last: they keep both placement heuristics and
 *  exempt only `single-use`, and only for a base whose offset survived the compiler's fold.
 *
 *  They are ONE eligibility rule at the two placements, because for a base reached ONCE the
 *  question the differ has to settle is where the pool load sits, not whether the local exists:
 *  the head keeps the address live over everything above the access, the first-use position is
 *  where a single access loaded it. Which one the source wrote is per-function knowledge the asm
 *  does not carry, so both ride and the differ referees.
 *
 *  WHAT EACH HOIST IS WORTH, ablated through the harness rather than read off the winners'
 *  variations, because a winner a hoist names can be a TIE another hoist also reaches. THE HEAD
 *  HOIST IS BRACKETED AND THE SUNK ONE IS NOT. `synthetic:foldhead` is MATCH at 0 under
 *  `unsigned/basefold` and becomes NONMATCH 11 under `unsigned` the moment the HEAD entry is
 *  removed — and removing BOTH entries gives the same 11, so the sunk entry is what nothing here
 *  brackets. `synthetic:foldsink` and `synthetic:basecell` are unbracketed for a reason worth
 *  keeping: they are MATCH at 0 in every configuration because `/offmember` ALSO reaches 0 on
 *  them and wins `compareScored`'s line-count tie-break. A TIE IS NOT A SUBSUMPTION — that is
 *  why a census over winners' variations reads zero here, and reading that zero as "loses" would
 *  delete a pair that no other spelling reaches.
 *  (Their fans still move: `foldsink` 12 → 8 → 8 → 4 over control/sunk/head/both, `basecell`
 *  4 → 4 → 4 → 2, the four-number sequence saying that on `basecell` the two entries emit the
 *  SAME two sources and `seen` collapses them, so only removing both takes the fan down.)
 *  `sa3:sub_803213C` MATCH, and — with the pair removed — `kleod:ProcessInputAndUpdateEntities`
 *  211, `kleod:CountCollectedGems` 290 and `kleod:RollRandomLevelVariant` 18, each of them the
 *  number the artifact carried then (all three retired 2026-09-13), and each of them ENTAILED
 *  rather than separately scored:
 *  the ablated candidate set is a strict SUBSET of the control one on every row here (enumerated
 *  both ways, 0 sources ADDED and 0 RENAMED — `ProcessInputAndUpdateEntities` 58752 → 48384
 *  with 10368 carrying `basefold`, `CountCollectedGems` 576 → 384 with 192, `RollRandomLevelVariant`
 *  29 → 11 with 18, `sub_803213C` 36 → 20 with 16), and no winner carries `basefold`, so the
 *  minimum cannot move. A BRACKET IS A CLAIM ABOUT THE WHOLE TREE, so it expires
 *  whenever anything else learns to reach the same spelling more cheaply: re-run one before
 *  re-quoting it, including the number that survived the last re-run.
 *  The SUNK entry is kept ONLY because it is a real spelling: 3921 distinct candidate sources over
 *  14 observations that nothing else emits (see WHAT THE PAIR COSTS for the per-row split), and
 *  a C source that initializes its base pointers where it declares them is the ordinary case.
 *  That is a weaker justification than a protected row and should be read as one — a round pricing
 *  the agbcc fan may delete it, and the gate on doing so is `bench diff`, not this note. The HEAD
 *  entry is NOT in that category: deleting it costs `synthetic:foldhead` its match, which
 *  `bench regression` fails on.
 *  HOW THE ABLATION IS DONE, since there is no shipped knob: filter this roster at its one use
 *  site (the `hoists` const in `enumerateCandidates`) behind a temporary env read, run the
 *  rows with `ASMLIFT_CANDCACHE=0`, and revert. Prove the filter REACHED before believing a null
 *  result — `synthetic:livepark` MATCH → diff:3 with `/livebase` AND `/unfolded` both removed is
 *  the positive control, and a fan count per configuration is the second. Removing `/livebase`
 *  alone leaves that row MATCH today, which is a control silently going vacuous rather than a
 *  variation going dead: `/unfolded` binds the same base there. Any positive control naming ONE
 *  hoist expires the next time a hoist is added — re-run it, and if it no longer moves, widen the
 *  ablation until it does before concluding anything from a null. */
export const BASEFOLD_HOISTS: readonly BaseHoist[] = [
  { variations: ['basefold'], gates: BASEFOLD_GATES, placement: 'head', pairings: false },
  { variations: ['basefold', 'sinkinit'], gates: BASEFOLD_GATES, placement: 'first-use', pairings: false },
];

/** The fifth hoist: its table requires the fold evidence (l3/basecse.ts, UNFOLDED_GATES), so
 *  it binds the reused bases an operand offset says a pointer local strode and leaves the ones the
 *  pool already carried folded. `/livebase` and `/livebase-block` are a chain — all the reused
 *  bases, or those minus the scalar cells — and a source that parked one numeric base and spelled
 *  another inline is at neither end of it. This hoist is not a third link in that chain but beside
 *  it: `singleCell` and `unfoldedOffset` are independent fields, so each of the two tables binds
 *  keys the other refuses (censused, with its scope, in UNFOLDED_GATES' own note). Read the roster
 *  as hand-picked subsets, never as a narrowness ranking.
 *
 *  LAST on the roster, so `seen` and `sameBases` between them keep it from restating an earlier
 *  HOIST — but only `seen` does any work here. `sameBases` declines a hoist that binds what an
 *  EARLIER hoist binds AT THE SAME PLACEMENT, and the only earlier `first-use` hoist is
 *  `/basefold/sinkinit`, whose table keeps the two gates this one ablates; instrumented over every
 *  agbcc row it fires on 0 of 5541 roster observations for this entry (33 distinct functions),
 *  against 3939 for `/livebase-block`. So the shadow is available and vacuous, and what keeps this
 *  hoist from restating anything is `seen` — WHICH MAKES IT A RENAMER, and it renames: the roster
 *  loop runs before the `/livebase ×` pairing loops, so a source one of those pairings would
 *  emit later is claimed under this hoist's variations instead. `synthetic:foldpark` is that case measured —
 *  fan 34 with this entry and 34 without, the same source winning at 0 under
 *  `signed/unfolded/volatile` here and `signed/livebase-block/volatile/sinkinit` there.
 *  Corpus-wide (map-less, candidates only, over the artifact's agbcc rows as they stood) 21 of the 333 rows
 *  whose distinct-source set is byte-identical either way carry candidates with `/unfolded`:
 *  21 pure renames against 7 rows that really gain sources, and 0 that lose one. What that costs
 *  any census taken over candidates' variations is at the `seen` dedup site below.
 *
 *  ONE placement, unlike the `/basefold` pair, and by measurement rather than by symmetry. All
 *  four configurations scored on `synthetic:unfoldpark`, cache off — the fan, then that fan's best
 *  score:
 *    first-use, unpaired  44   0  MATCH — shipped
 *    first-use, paired    44   0  no paired candidate emits a source the unpaired row does not
 *    head,      unpaired  44   9  the score the row already had without any of this
 *    head,      paired    48   0  reached only through the `/sinkinit` pairing
 *  The head is where `/livebase` already offers a spelling for every base this table can bind —
 *  these are bases reached 2+ times — so what the hoist adds is the SUNK init, which is where a
 *  source that declares its base pointer beside the loop it feeds puts the pool load. On both
 *  neighbouring rows the head placement is shadowed outright (`/unfolded` binds set-for-set what
 *  `/livebase` binds on `synthetic:livepark` and what `/livebase-block` binds on
 *  `synthetic:foldpark`). A second hoist at the head is one line and no new table; add it when a row
 *  demands it, which none does today.
 *
 *  `pairings: false` for the reason the field's own doc gives — a pairing is added for a row that
 *  demands the joint spelling, and the row that earned this entry does not: paired and unpaired
 *  are the same 44 candidates above. ONE 15-LINE FUNCTION CANNOT SETTLE A CORPUS QUESTION, so the
 *  same knob was censused over every agbcc row the artifact carries, candidates only: `true` adds
 *  912 distinct sources over 8 rows, +1.92% of the agbcc corpus fan (quoted as the DELTA,
 *  because the total moves with the corpus and with the roster) — `kleod:UpdateCameraScroll`
 *  +608, `synthetic:sizebound` +128, `synthetic:dmascope` +64, `kleod:SetupBG3WindowOverlay` and
 *  `synthetic:maskhome` +32 each, and +16 each on `dmafield`, `dmaflat` and `dmapoll`. Five of the
 *  eight are MATCH and two are `noncompile`, where extra candidates cannot help; the one that
 *  could, `synthetic:sizebound`, scores diff:8 with the pairings on and diff:8 with them off. So
 *  the `false` buys 1.92% of the agbcc fan for a measured zero, on the whole corpus rather than on
 *  the row that earned the entry. Flip it when a row scores better with it, and re-run that
 *  census when one does. */
export const UNFOLDED_HOISTS: readonly BaseHoist[] = [
  { variations: ['unfolded'], gates: UNFOLDED_GATES, placement: 'first-use', pairings: false },
];

/** The sixth hoist, and the only one whose evidence is the INSTRUCTION ORDER rather than the
 *  shape of the accesses (l3/basecse.ts, ORDERBASE_GATES). It binds a base the assembly says was
 *  materialized before the index was scaled — including the `(struct S *)&gSym` of an
 *  array-of-struct element, which no other table on this roster can even see.
 *
 *  LAST, so `sameBases` can shadow it and it can shadow nothing: on a function whose licensed base
 *  is a plain leaf reached twice, `/livebase` already binds exactly that set at this placement and
 *  this hoist declines rather than restating it under different variations.
 *
 *  TWO PLACEMENTS, and the FLAT second one is a measured zero. `synthetic:bgarr` emits the identical
 *  source at `head` and `first-use` (the hoist has nothing to sit above) and that one row
 *  generalizes to nothing: over the artifact's agbcc rows the two emit DIFFERENT source on 3 of the
 *  8 rows this hoist binds map-less and 4 of the 10 map-ful — `kleod:SetupBG3WindowOverlay`,
 *  `kleod:UpdateCameraScroll`, `pokeemerald:TrySetCantSelectMoveBattleScript`, and map-ful
 *  `kleod:StreamCmd_SetBGScroll`. Run through the harness on all four, an entry at
 *  `placement: 'first-use'` scores nothing: 146 → 146, noncompile → noncompile, MATCH → MATCH,
 *  noncompile → noncompile, against +1129 candidates over those rows' 15167 (+7.4%) and
 *  `kleod:UpdateCameraScroll` 224 s → 278 s. That hoist stays withheld.
 *
 *  `scope` is a DIFFERENT question and a row demanded it. `first-use` reaches only the top-level
 *  statement list, so on a function whose licensed base is used solely inside a guarded loop it
 *  spells the same bytes `head` does — the pool word above the branch — while the reference loads
 *  it after. Compiled through the benchmark's own agbcc on `synthetic:ereadctl`'s target, with
 *  everything else held identical: the init above the `if` differs, the same init INSIDE the arm is
 *  instruction-identical. So the two flat placements are one answer here and this is the other, the
 *  way `/basefold`'s pair is one eligibility rule at two positions.
 *
 *  AND THE WITHHOLDING ABOVE IS ENFORCED BY THE PLACEMENT, not by this row's absence. `scope`
 *  reproduces `first-use` on every function where no nested list holds all of a base's uses, so a
 *  scoped hoist that answered there would ship the withheld candidate under this hoist's variations — and it
 *  is the COMMON case, not the corner: over each project's whole `asm` tree, map-ful, of the 48
 *  functions this gate table admits, 41 place every init in the top-level list and only 7 reach a
 *  nested one. `hoistBaseLocals` DECLINES at `scope` in exactly that case (l3/basecse.ts) — a
 *  WITHDRAWAL and not a dedup, because on 29 of the 41 the flat spelling is one no other row here
 *  produces, which that file's header prices. Measured on
 *  `kleod:UpdateCameraScroll` map-ful, the row that priced the withheld one: 512 of its 512
 *  `/orderbase-scoped` sources placed the init at the top level, and all 512 are gone.
 *
 *  `pairings: false` on both for the field's own reason — a pairing is added for a row that demands
 *  the joint spelling, and neither row here demands one. */
export const ORDERBASE_HOISTS: readonly BaseHoist[] = [
  { variations: ['orderbase'], gates: ORDERBASE_GATES, placement: 'head', pairings: false },
  { variations: ['orderbase-scoped'], gates: ORDERBASE_GATES, placement: 'scope', pairings: false },
];

export const sameBases = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/** The signedness of the entry parameters — the classic ambiguity asm cannot resolve.
 *
 * Struct LAYOUT is recovered structurally (raise/structs.ts) rather than enumerated here, and the
 * reason is REACH, not neutrality. This file used to say `->field_N` and `[idx]` "compile
 * identically, so the differ cannot referee between them"; the second clause is FALSE on agbcc and
 * `synthetic:dmanest` is the counterexample — the same element read scores 0 as
 * `((struct Elem0 *)K)[a1].field_4` and 2 as `((s32 *)((a1 << 3) + K))[1]`, because an index folds
 * the field offset into the pool literal (tree reassociation) where a COMPONENT_REF leaves it in
 * the load displacement. `synthetic:dmaptrsrc` is a second counterexample on the field's TYPE.
 *
 * What is true is that no candidate is enumerated for the question, and none is NEEDED: the recovery
 * reads the base from the observed pool word and the field offset from the observed load
 * displacement, so it reproduces the target's own split by construction. The measurements and the
 * conditions are in `raise/structs.ts`; nothing about them belongs in a roster comment. */
export const SIGNEDNESS: readonly { variation: VariationName; signed: boolean }[] = [
  { variation: 'unsigned', signed: false },
  { variation: 'signed', signed: true },
];

// A recovered POINTER/aggregate param must NOT be signedness-pinned: pinning a still-`unknown`
// pointer param to a scalar int BEFORE recovery blocks pointer recovery and emits uncompilable
// `*(s32)`. Only genuine scalars carry the signedness variation.
export const NO_PIN_KINDS = new Set(['ptr', 'struct', 'array']);
