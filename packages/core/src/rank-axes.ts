// asmlift — the candidate-enumeration TABLES, split out of rank.ts so the enumeration driver and
// the data it walks are two files. Every table here is DATA the driver derives from: adding an
// axis, a shape product or a base-CSE admission is one entry in one of these lists, and the
// driver reads it without a second hand-edited site.
//
// DECLARATION ORDER IS PUBLISHED BEHAVIOUR. `compareScored` breaks a score tie by enumeration
// order, so the order of `STRUCTURING_AXES`, `SHAPE_PRODUCTS` and every `*_ADMISSIONS` roster
// decides which of two byte-identical spellings wins and gets its `candidateLabel` into
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
// TYPE-ONLY, and deliberately: the axes table types its `options` as
// `Parameters<typeof structureChecked>[1]`, which needs the binding in a `typeof` position and
// nothing at runtime. A value import here would make this module depend on the whole pipeline.
import type { structureChecked } from './pipeline';
import {
  hasDerivedReadHome,
  hasHomeableSharedAddress,
  hasLoopSharedPureValue,
  hasMergeFeedHome,
} from './structure/analysis';
import { edgeCopyOrdersDiffer, hasParamRootedMerge } from './structure/structure';

/** The STRUCTURING AXES — the boolean candidate dimensions crossed into every enumeration
 *  (after signedness/branch-sense/defsite/bitfields, which have their own shapes). One entry per
 *  axis; chain construction, the dropped-sibling strip closure, the per-candidate
 *  StructureOptions, and the base-axes abort guard all derive from this table, so a new axis is
 *  one entry — not four hand-edited sites that can drift.
 *
 *  `probeGate` gates the arm's ENUMERATION on the shared probe (the only thing the axis can
 *  change must exist at all); `variantGate` re-evaluates per symbol-variant on that variant's
 *  own lifted fn (a map-lifted probe spells const bases as gaddr, which would blind the
 *  /raw-globals siblings — the /addr-home lesson). `strip` opts the axis into the
 *  dropped-sibling closure: an axis-ON candidate is skipped when its OFF sibling failed the
 *  boundary contracts. Two axes are EXEMPT from structure()'s assertPrimaryAccepts invariant:
 *  `/reread-globals` only relaxes inlining barriers and `/uns-cmp` only changes spelling and
 *  declarations — neither adds materialization or merging, so neither can unlock a function the
 *  primary declines (reread also skips the strip closure). Both exemptions are stated here
 *  rather than left implicit in a missing `||` arm or trigger term. */
export interface StructuringAxis {
  flag:
    | 'reread'
    | 'inplace'
    | 'mergeNames'
    | 'addrHome'
    | 'exprHome'
    | 'derivedHome'
    | 'mergeHome'
    | 'unsCmp'
    | 'freshMerge'
    | 'copyDefPos'
    | 'siteSense';
  suffix: string;
  options: (on: boolean) => Parameters<typeof structureChecked>[1];
  probeGate?: (probe: Fn, defs: Map<Value, Op>) => boolean;
  variantGate?: (fn: Fn) => boolean;
  strip: boolean;
}
export const STRUCTURING_AXES: readonly StructuringAxis[] = [
  // `/reread-globals` — the VALUE-HOME axis (structure/analysis.ts AnalyzeOptions). Whether the
  // source read a global once into a variable or re-read it at each use is not derivable from
  // asm: the compiler CSEs the second spelling back into one load, and the round-5 dogfood
  // watched agbcc land on both sides inside a single function (its highest-cost defect, 25 of
  // 27 points on one klonoa function and 35/50 both ways on another). Gated on the function
  // having a load that resolves to a named global at all.
  {
    flag: 'reread',
    suffix: '/reread-globals',
    options: (on) => ({ rereadGlobals: on }),
    probeGate: (probe, defs) =>
      probe.blocks.some((b) =>
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
    suffix: '/inplace',
    options: (on) => ({ materializeJoinFeeds: on }),
    probeGate: (probe, defs) =>
      probe.blocks.some((b) =>
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
    suffix: '/merge-names',
    options: (on) => ({ coalesceMergeNames: on }),
    probeGate: (probe) =>
      probe.blocks
        .slice(1)
        .some(
          (b) => b.params.length > 0 && new Set(probe.blocks.filter((pr) => successorsOf(pr).includes(b))).size > 1,
        ),
    strip: true,
  },
  // `/addr-home` — the address-home axis (structure/analysis.ts AnalyzeOptions
  // homeSharedAddresses): a pure computed address dereferenced at 2+ sites, and the multi-render
  // loads through it, materialize into locals — the source's pointer-local + scalar-temp
  // spelling, where the default re-derives per use (a pool literal per folded offset). Gated PER
  // SYMBOL VARIANT (see the table doc) on that variant's own lifted fn having a homeable base.
  {
    flag: 'addrHome',
    suffix: '/addr-home',
    options: (on) => ({ homeSharedAddresses: on }),
    variantGate: hasHomeableSharedAddress,
    strip: true,
  },
  // `/expr-home` — the loop-expression-home axis (structure/analysis.ts AnalyzeOptions
  // homeLoopExprs): a pure value defined outside a loop with 2+ distinct consumers, at least one
  // of them inside it, materializes into a local carrying the value's recovered type — the register
  // the compiler holds across the iterations (`u32 size = 16 << t;` driving a loop bound, a product
  // and a shift), where the default re-derives per use. Gated per symbol variant like `/addr-home`
  // (the cone refusal reads the variant's own lift).
  {
    flag: 'exprHome',
    suffix: '/expr-home',
    options: (on) => ({ homeLoopExprs: on }),
    variantGate: hasLoopSharedPureValue,
    strip: true,
  },
  // `/derived-home` — the derived-read-home axis (structure/analysis.ts AnalyzeOptions
  // homeDerivedReads): a pure value with 2+ consumers standing on a memory read materializes, and
  // the read then renders once inside it — the register the asm carried the DERIVED value in
  // (`eor r1,r1,r0` keeps `0x3FF ^ REG_KEYINPUT`), where the default homes the read and re-derives
  // the computation at every use. Both spellings compile (agbcc CSEs the re-derivation back), so
  // the differ referees. Gated per symbol variant like its `/addr-home` and `/expr-home` siblings,
  // and for the same reason the /addr-home lesson names: the scope refuses a cone holding a
  // standalone address, and a pool constant the map lifts to a `gaddr` is a bare `const` in the
  // `/raw-globals` sibling — so the two variants genuinely answer differently.
  {
    flag: 'derivedHome',
    suffix: '/derived-home',
    options: (on) => ({ homeDerivedReads: on }),
    variantGate: hasDerivedReadHome,
    strip: true,
  },
  // `/merge-home` — the merge-feed-home axis (structure/analysis.ts AnalyzeOptions
  // homeMergeFeeds): a pure value one join's incoming edges render into the SAME parameter slot
  // from 2+ places materializes in the block that dominates them — the value the source computed
  // once above the branch (`s32 m = (b & 1) ? 0x400 : 0;`), where the default has no name to
  // reference on an edge and re-derives the whole expression per arm. Gated per symbol variant on
  // the scope itself rather than on an approximation of it.
  //
  // An ADMISSION, not a default: forced on, the spelling is REPLACED across the fan rather than
  // added to it, which costs `kleod:MultiplyQ4`, `kleod:MultiplyQ8` and
  // `pokeemerald:MathUtil_Mul16` their matches. On the roster that is unreachable — `compareScored`
  // orders by score and the un-homed sibling rides beside it.
  //
  // Its fan is essentially one row's: over the 16 corpus rows the gate admits, 2790 → 5841
  // candidates map-less and 2538 → 5363 with a map, of which `kleod:UpdateCameraScroll` (outcome
  // `noncompile`, so they buy nothing) is +2944 and +2752, three rows add none at all where
  // `/defsite` already spells the same tree, and the rest pay 107 and 73 between them.
  {
    flag: 'mergeHome',
    suffix: '/merge-home',
    options: (on) => ({ homeMergeFeeds: on }),
    variantGate: hasMergeFeedHome,
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
    suffix: '/uns-cmp',
    options: (on) => ({ unsignedCompareSpelling: on }),
    probeGate: (probe) => probe.blocks.some((b) => b.ops.some((op) => op.opcode.startsWith('icmp_u'))),
    strip: true,
  },
  // `/fresh-merge` — the parameter-merge-home axis (structure.ts `freshParamMerge`, whose
  // `FRESH_MERGE_GATES` carry the argument): a merge whose carrier is a parameter takes its own
  // local (`if (a1 < a0) { v0 = a0; } else { v0 = a1; }`) where the default assigns back into the
  // parameter (`if (a1 < a0) a1 = a0;`). Both are ordinary C over the same values, so
  // the differ decides. At TWO arguments they compile to the SAME bytes on agbcc and on mwcc
  // (measured, both directions), which is why `maxi`/`mini` hold under the axis.
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
  // so it cannot answer differently per symbol variant.
  {
    flag: 'freshMerge',
    suffix: '/fresh-merge',
    options: (on) => ({ freshParamMerge: on }),
    probeGate: (probe) => hasParamRootedMerge(probe),
    strip: true,
  },
  // `/copy-defpos` — the EDGE-COPY ORDER axis (structure.ts `preferDefPosCopyOrder`). The frontend
  // measures the order each predecessor wrote its successors' keys (ir/core.ts `WriteOrder`) and
  // the default lays the edge's copies out in it. That the compiler laid its copies out in the
  // order it wrote them is only licensed for a CYCLIC copy set, where the spill has to be the
  // register whose old value was displaced first; for an acyclic set it is an assumption, and the
  // benchmark answers it BOTH WAYS INSIDE ONE COMPILER: `synthetic:gcd:mwcc_242_81` matches only
  // with the record, while `memcpy1:mwcc_242_81` (19 → 23) and `memset1:mwcc_242_81` (19 → 21)
  // score worse with it, as does `armfall:agbcc` (8 → 11). A per-compiler boolean cannot decide a
  // question with rows on both sides of it inside one compiler, and a lever that emits one tree
  // referees nothing — so the def-position spelling is enumerated beside the record's and the
  // differ picks, exactly as `/fresh-merge` above does for the merge home.
  //
  // THE AXIS SPANS THE UNLICENSED HALF ONLY: its ON arm keeps the record on cyclic sets, so
  // neither arm spells a cycle against the instruction that names the compiler's temp. Over the
  // whole benchmark corpus that scoping moves nothing — `memcpy1`, `memset1` and `armfall` keep their
  // `/copy-defpos` winners, so the acyclic half is what they needed — and it makes one spelling
  // reachable that neither whole-function arm has: the record on a cycle and the proxy on an
  // acyclic edge of the same function, which is what `synthetic:gcd:agbcc`'s two edges want.
  //
  // Gated on the two orders actually differing somewhere in this function, so on a row where the
  // record changes nothing the pair is one tree and the fan does not grow. PER SYMBOL VARIANT, on
  // that variant's own fully-raised fn, because that is `structure()`'s own input and only there
  // is withholding provably inert: same fn, same comparators, so a false answer means the ON arm
  // would structure the tree the OFF arm already spelled. Asked any earlier the claim does not
  // follow, and both ways it fails are real —
  //   - THE SYMBOL VARIANT. klonoa's `UpdateHUDCollectibleCount` answers false with the kleod map
  //     and true on the `/raw-globals` sibling's own lift (fixture: test/corpus/agbcc-hudcount.s).
  //   - THE STAGE. A probe stopping after `recoverTypes` is asked before `foldEmptyLatches`
  //     (raise/latch.ts) repoints edges and rewrites the record the gate reads: klonoa's
  //     `EntityGravityAndFloorCheck` answers false there and true after that fold.
  // Neither costs candidates today — over 192 klonoa functions enumerated with the map the fan is
  // 27,847 either way, 1,970 of them `/copy-defpos`. `strip` like its neighbours: a reordering
  // cannot rescue a spelling whose OFF sibling failed the boundary contracts.
  {
    flag: 'copyDefPos',
    suffix: '/copy-defpos',
    options: (on) => ({ preferDefPosCopyOrder: on }),
    variantGate: edgeCopyOrdersDiffer,
    strip: true,
  },
  // `/site-sense` — spell a folded short-circuit `if` from the FOLD'S own orientation evidence
  // rather than from the per-function branch-sense boolean (structure.ts senseFromFoldEvidence,
  // raise/shortcircuit.ts `scSharedOnFall`). The two sense booleans are per FUNCTION, so a
  // function whose `if`s were written in opposite senses reaches neither spelling: over
  // `synthetic:mixsense`'s four divergent ladder sites the whole 2^4 per-site enumeration scores
  // 10 at the source's own mixed configuration against 20 and 27 for the two the booleans reach,
  // and `synthetic:joinsense` MATCHES at a mix the booleans cannot spell.
  //
  // WHY IT IS AN AXIS AND NOT THE DEFAULT. The reading — a shared block the last test FELL INTO is
  // the source's `then` — is derived from gcc laying a condition's arms out in source order, which
  // holds for the SHORT-branch layout; the long-branch form inverts the last test and is only
  // MEASURED here (`synthetic:ifand_far`, which scores the same either way). An axis costs a
  // candidate where it is wrong; a default would cost the row.
  //
  // Gated on this variant's own fully-raised fn carrying a stamped branch at all, for
  // `/copy-defpos`'s reason one entry up: the `/connective` lift axis and the symbol variants each
  // change which sites fold, and a gate asked on a different lift would govern a fan it did not
  // measure. A function with no fold structures the identical tree on both arms and the tree dedup
  // collapses the pair before any compile.
  {
    flag: 'siteSense',
    suffix: '/site-sense',
    options: (on) => ({ senseFromFoldEvidence: on }),
    variantGate: (fn) => fn.blocks.some((b) => b.ops.some((op) => typeof op.attrs.scSharedOnFall === 'boolean')),
    strip: false,
  },
];

/** The statement-shape products (rank's second sanctioned product mechanism): each entry is a
 *  statement-order/shape re-spelling orthogonal to every representation lever, derived onto every
 *  spelling as sanctioned in the POLICY note at the respell site. Each shape fires alone, plus
 *  all of them together in table order — not the full subset lattice; the pairs question is
 *  settled by applyShapes' skip-on-decline below, and a row demanding a true EXCLUSION pair —
 *  all three fire, the match needs exactly two — is what would earn the lattice. */
export const SHAPE_PRODUCTS: { suffix: string; apply: (sfn: SFn) => SFn | null }[] = [
  { suffix: '/initfirst', apply: initFirstGuards },
  { suffix: '/pollguard', apply: pollGuards },
  { suffix: '/pollread', apply: pollReads },
];
/** The PRE-FAN products (rank's FOURTH sanctioned product mechanism): a tree rewrite applied
 *  BEFORE the re-spelling fan, so the whole fan derives from its output instead of composing onto
 *  it. Same record type as SHAPE_PRODUCTS above, and deliberately so — the only difference is
 *  WHERE it is applied, and that is the whole admission bar.
 *
 *  ADMITTED on one ground: the spelling a row demands needs a downstream lever to run on this
 *  rewrite's OUTPUT, and the measured pair shows neither order alone reaches it. For `/unmerge`
 *  (l3/unmerge.ts, the dual of the unconditional `tailmerge`) that measurement is
 *  `synthetic:dmascope`: the un-merged store has to land inside the arm's own region base
 *  (`p0[2] = …`), which only a base lever running AFTER the un-merge can spell — hand-compiled,
 *  that source is byte-exact where the merged spelling the structurer produces is 9, and applying
 *  the un-merge to the WINNER's tree instead measures 14. Every other lever derives from the base
 *  tree, so the order can only be had this way.
 *
 *  A pre-fan product only ADDS candidates, so it cannot cost a match; its price is a second fan
 *  on every tree where the rewrite fires, which is why the table is not a place to put a lever
 *  that would compose perfectly well as a `respell`. */
export const PRE_FAN_PRODUCTS: typeof SHAPE_PRODUCTS = [{ suffix: '/unmerge', apply: unmergeJoins }];

export const SHAPE_SUBSETS: (typeof SHAPE_PRODUCTS)[number][][] = [
  ...SHAPE_PRODUCTS.map((x) => [x]),
  ...(SHAPE_PRODUCTS.length > 1 ? [SHAPE_PRODUCTS] : []),
];

/** The subset applied in table order, SKIP-ON-DECLINE: a member that declines contributes
 *  nothing rather than killing the combination — the all-shapes candidate is "everything that
 *  fires", so a pair is reachable whenever the third declines. The label is built from the
 *  members that actually FIRED, so a suffix never names a lever that declined; a fired-set that
 *  duplicates a smaller subset emits identical source and the dedup collapses it. Null when
 *  nothing fired. */
export const applyShapes = (
  subset: readonly (typeof SHAPE_PRODUCTS)[number][],
  from: SFn,
): { out: SFn; suffix: string } | null => {
  let cur = from;
  const fired: string[] = [];
  for (const sp of subset) {
    const r = sp.apply(cur);
    if (r) {
      cur = r;
      fired.push(sp.suffix);
    }
  }
  return fired.length > 0 ? { out: cur, suffix: fired.join('') } : null;
};

/** The locals a lever added — a NAME diff rather than a positional slice, so a pass that ever
 *  reorders locals cannot silently empty the set. It is what scopes `/volatile` to the pointers
 *  the lever itself created (volatilePtrLocals' `only`), leaving the tree's own locals alone. */
export const createdLocals = (from: SFn, to: SFn): Set<string> => {
  const before = new Set(from.locals.map((l) => l.name));
  return new Set(to.locals.filter((l) => !before.has(l.name)).map((l) => l.name));
};

/** The base-CSE ADMISSIONS `/livebase` offers the differ, widest first. WHICH of several numeric
 *  bases the source named is per-base knowledge the asm does not carry — a DMA register file wants
 *  one register held across the whole body while the IWRAM halfword beside it re-materializes — so
 *  each admission rides as its own candidate and the differ referees between them. A new
 *  admission is one entry here, one gate table, and that table's line in the gate-contract
 *  roster — not nine hand-edited sites that can drift; whether it also fans over the `/livebase`
 *  PRODUCTS below is the entry's own `pairings`. A MIRROR admission (bind the scalar cells, leave
 *  the register file inline) is that, with the complementary predicate; it is never another entry
 *  in LIVEBASE_BLOCK_GATES, which can only reject more.
 *
 *  WHAT BOUNDS IT. A row declines unless it binds a non-empty set of bases no earlier row already
 *  bound, and each product declines wherever its own lever does, so the list widens only where an
 *  inhabitant exists — over the corpus the second admission reaches 8 rows, its `/nearbase`
 *  pairing 3, and its `/indexed`, `/coalesce` and volatile-subset products none at all. A function
 *  inhabiting them all pays far more, and the fan is not always a win there: the mixpoll dataset
 *  entry prices one where the `/coalesce` pairing costs the most candidates of any and scores two
 *  points worse than going unpaired. THAT row fans anyway because on the `/livebase` rows a
 *  pairing belongs to the LEVER rather than to one of its admissions — but it is a per-row
 *  decision, not a property of the roster: three of the five rows below are unpaired. `pairings`
 *  is the field, and its own doc says how a row earns a `true`.
 *
 *  `/basefold` is the third and fourth admission and `/unfolded` the fifth; those three are the
 *  conditional set — `enumerateCandidates` appends them where the target declares
 *  `compilerBehaviors.foldsConstAddrOffset`. They need no second "did the primary already carry
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
 *  structuring, leaving that fan the size it was, with ZERO `basefold`-labelled candidates in the
 *  control arm. NO FAN TOTAL IS QUOTED HERE ON PURPOSE: that function's fan was 112896 at this
 *  commit and two five-figure numbers ago at others, and a DELTA outlives the total it was
 *  measured beside — which is what makes a stale paragraph read as verified. Re-run the total
 *  before budgeting against it. All floors, though: the ranked path structures each function many ways
 *  where this census builds one tree per observation.
 *
 *  WHAT THE PAIR COSTS, through the HARNESS's own enumeration and re-runnable from the recipe in
 *  the BASEFOLD_ADMISSIONS note below: enumerate every agbcc row with the pair on and off,
 *  `ASMLIFT_CANDCACHE=0`, candidates only. The pair adds 3921
 *  distinct candidate sources over 14 observations — 3911 over 12 real rows and 10 over 2
 *  synthetic ones (`foldsink` 4 → 12, `basecell` 2 → 4) — and every per-row delta equals that
 *  row's count of `basefold`-labelled candidates exactly, which is both what says the ablation
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
 *  ablation in the note on BASEFOLD_ADMISSIONS, which carries the fan counts that prove it
 *  reached. */
export interface BaseAdmission {
  suffix: string;
  gates: readonly Gate<BaseKey>[];
  /** WHERE the locals this row binds are initialized (l3/hoist.ts). Eligibility and placement are
   *  two questions and this roster answers both, so a row can offer the same bases in the other
   *  position without a second gate table — and a row that wants both offers both, as the
   *  `/basefold` pair below does. */
  placement: HoistPlacement;
  /** Whether the row joins the `/livebase ×` PAIRINGS below. Each of those products was added for
   *  a row that demanded the joint spelling (see POLICY), and every demanding row so far is a
   *  `/livebase` row — so a new admission joins them when a row demands it, not by roster
   *  membership.
   *
   *  ONE BOOLEAN PER ROSTER ROW, ANSWERING A QUESTION THAT IS REALLY PER FUNCTION, so a `false`
   *  here is a corpus claim and has to be measured like one — on the whole corpus, not on the
   *  synthetic row that earned the entry. The measurement is candidates-only and cheap: enumerate
   *  every agbcc row twice from `row.scripts.asmlift`'s heredocs and compare the distinct-source
   *  sets. For `/unfolded` (see its note) that is +912 sources over 8 rows (+1.92% corpus fan) and
   *  the only nonmatch among the 8 scores the same either way, which is what the `false` rests on.
   *  Flipping one of these is one character; the gate on doing it is that census plus a score on
   *  every row it moves. */
  pairings: boolean;
}

export const LIVEBASE_ADMISSIONS: readonly BaseAdmission[] = [
  { suffix: '/livebase', gates: LIVEBASE_GATES, placement: 'head', pairings: true },
  { suffix: '/livebase-block', gates: LIVEBASE_BLOCK_GATES, placement: 'head', pairings: true },
];

/** Narrower than either `/livebase` row, so both go last: they keep both placement heuristics and
 *  exempt only `single-use`, and only for a base whose offset survived the compiler's fold.
 *
 *  They are ONE eligibility rule at the two placements, because for a base reached ONCE the
 *  question the differ has to settle is where the pool load sits, not whether the local exists:
 *  the head keeps the address live over everything above the access, the first-use position is
 *  where a single access loaded it. Which one the source wrote is per-function knowledge the asm
 *  does not carry, so both ride and the differ referees.
 *
 *  WHAT EACH ROW IS WORTH, ablated through the harness rather than read off the winning labels,
 *  because a label a row wins can be a TIE another row also reaches. THE HEAD ADMISSION IS
 *  BRACKETED AND THE SUNK ONE IS NOT. `synthetic:foldhead` is MATCH at 0 under
 *  `unsigned/basefold` and becomes NONMATCH 11 under `unsigned` the moment the HEAD entry is
 *  removed — and removing BOTH entries gives the same 11, so the sunk entry is what nothing here
 *  brackets. `synthetic:foldsink` and `synthetic:basecell` are unbracketed for a reason worth
 *  keeping: they are MATCH at 0 in every configuration because `/offmember` ALSO reaches 0 on
 *  them and wins `compareScored`'s line-count tie-break. A TIE IS NOT A SUBSUMPTION — that is
 *  why a census over winning labels reads zero here, and reading that zero as "loses" would
 *  delete a pair that no other spelling reaches.
 *  (Their fans still move: `foldsink` 12 → 8 → 8 → 4 over control/sunk/head/both, `basecell`
 *  4 → 4 → 4 → 2, the four-number sequence saying that on `basecell` the two entries emit the
 *  SAME two sources and `seen` collapses them, so only removing both takes the fan down.)
 *  `sa3:sub_803213C` MATCH, and — with the pair removed — `kleod:ProcessInputAndUpdateEntities`
 *  211, `kleod:CountCollectedGems` 290 and `kleod:RollRandomLevelVariant` 18, each of them the
 *  number the artifact already carries, and each of them ENTAILED rather than separately scored:
 *  the ablated candidate set is a strict SUBSET of the control one on every row here (enumerated
 *  both ways, 0 sources ADDED and 0 RELABELLED — `ProcessInputAndUpdateEntities` 58752 → 48384
 *  with 10368 carrying the token, `CountCollectedGems` 576 → 384 with 192, `RollRandomLevelVariant`
 *  29 → 11 with 18, `sub_803213C` 36 → 20 with 16), and no winner's label carries a `basefold`
 *  token, so the minimum cannot move. A BRACKET IS A CLAIM ABOUT THE WHOLE TREE, so it expires
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
 *  site (the `admissions` const in `enumerateCandidates`) behind a temporary env read, run the
 *  rows with `ASMLIFT_CANDCACHE=0`, and revert. Prove the filter REACHED before believing a null
 *  result — `synthetic:livepark` MATCH → diff:3 with `/livebase` AND `/unfolded` both removed is
 *  the positive control, and a fan count per configuration is the second. Removing `/livebase`
 *  alone leaves that row MATCH today, which is a control silently going vacuous rather than a
 *  lever going dead: `/unfolded` binds the same base there. Any positive control naming ONE roster
 *  row expires the next time a row is added — re-run it, and if it no longer moves, widen the
 *  ablation until it does before concluding anything from a null. */
export const BASEFOLD_ADMISSIONS: readonly BaseAdmission[] = [
  { suffix: '/basefold', gates: BASEFOLD_GATES, placement: 'head', pairings: false },
  { suffix: '/basefold/sinkinit', gates: BASEFOLD_GATES, placement: 'first-use', pairings: false },
];

/** The fifth admission: its table requires the fold evidence (l3/basecse.ts, UNFOLDED_GATES), so
 *  it binds the reused bases an operand offset says a pointer local strode and leaves the ones the
 *  pool already carried folded. `/livebase` and `/livebase-block` are a chain — all the reused
 *  bases, or those minus the scalar cells — and a source that parked one numeric base and spelled
 *  another inline is at neither end of it. This row is not a third link in that chain but beside
 *  it: `singleCell` and `unfoldedOffset` are independent fields, so each of the two tables binds
 *  keys the other refuses (censused, with its scope, in UNFOLDED_GATES' own note). Read the roster
 *  as hand-picked subsets, never as a narrowness ranking.
 *
 *  LAST on the roster, so `seen` and `sameBases` between them keep it from restating an earlier
 *  ROSTER row — but only `seen` does any work here. `sameBases` declines a row that binds what an
 *  EARLIER row binds AT THE SAME PLACEMENT, and the only earlier `first-use` row is
 *  `/basefold/sinkinit`, whose table keeps the two gates this one ablates; instrumented over every
 *  agbcc row it fires on 0 of 5541 roster observations for this entry (33 distinct functions),
 *  against 3939 for `/livebase-block`. So the shadow is available and vacuous, and what keeps this
 *  row from restating anything is `seen` — WHICH MAKES IT A RENAMER, and it renames: the roster
 *  loop below runs before the `/livebase ×` product loops, so a source one of those products would
 *  emit later is claimed by this row's label instead. `synthetic:foldpark` is that case measured —
 *  fan 34 with this entry and 34 without, the same source winning at 0 under
 *  `signed/unfolded/volatile` here and `signed/livebase-block/volatile/sinkinit` there.
 *  Corpus-wide (map-less, candidates only, over the artifact's agbcc rows as they stood) 21 of the 333 rows
 *  whose distinct-source set is byte-identical either way carry `/unfolded`-labelled candidates:
 *  21 pure renames against 7 rows that really gain sources, and 0 that lose one. What that costs
 *  any census taken over labels is at the `seen` dedup site below.
 *
 *  ONE placement, unlike the `/basefold` pair, and by measurement rather than by symmetry. All
 *  four configurations scored on `synthetic:unfoldpark`, cache off — the fan, then that fan's best
 *  score:
 *    first-use, unpaired  44   0  MATCH — shipped
 *    first-use, paired    44   0  no product emits a source the unpaired row does not
 *    head,      unpaired  44   9  the score the row already had without any of this
 *    head,      paired    48   0  reached only through the `/sinkinit` product
 *  The head is where `/livebase` already offers a spelling for every base this table can bind —
 *  these are bases reached 2+ times — so what the row adds is the SUNK init, which is where a
 *  source that declares its base pointer beside the loop it feeds puts the pool load. On both
 *  neighbouring rows the head placement is shadowed outright (`/unfolded` binds set-for-set what
 *  `/livebase` binds on `synthetic:livepark` and what `/livebase-block` binds on
 *  `synthetic:foldpark`). A second row at the head is one line and no new table; add it when a row
 *  demands it, which none does today.
 *
 *  `pairings: false` for the reason the field's own doc gives — a product is added for a row that
 *  demands the joint spelling, and the row that earned this entry does not: paired and unpaired
 *  are the same 44 candidates above. ONE 15-LINE FUNCTION CANNOT SETTLE A CORPUS QUESTION, so the
 *  same knob was censused over every agbcc row the artifact carries, candidates only: `true` adds
 *  912 distinct sources over 8 rows, +1.92% of the agbcc corpus fan (quoted as the DELTA,
 *  because the total moves with the corpus and with the roster) — `kleod:UpdateCameraScroll`
 *  +608, `synthetic:sizebound` +128, `synthetic:dmascope` +64, `kleod:SetupBG3WindowOverlay` and
 *  `synthetic:maskhome` +32 each, and +16 each on `dmafield`, `dmaflat` and `dmapoll`. Five of the
 *  eight are MATCH and two are `noncompile`, where extra candidates cannot help; the one that
 *  could, `synthetic:sizebound`, scores diff:8 with the products on and diff:8 with them off. So
 *  the `false` buys 1.92% of the agbcc fan for a measured zero, on the whole corpus rather than on
 *  the row that earned the entry. Flip it when a row scores better with it, and re-run that
 *  census when one does. */
export const UNFOLDED_ADMISSIONS: readonly BaseAdmission[] = [
  { suffix: '/unfolded', gates: UNFOLDED_GATES, placement: 'first-use', pairings: false },
];

/** The sixth admission, and the only one whose evidence is the INSTRUCTION ORDER rather than the
 *  shape of the accesses (l3/basecse.ts, ORDERBASE_GATES). It binds a base the assembly says was
 *  materialized before the index was scaled — including the `(struct S *)&gSym` of an
 *  array-of-struct element, which no other table on this roster can even see.
 *
 *  LAST, so `sameBases` can shadow it and it can shadow nothing: on a function whose licensed base
 *  is a plain leaf reached twice, `/livebase` already binds exactly that set at this placement and
 *  this row declines rather than restating it under a second label.
 *
 *  TWO PLACEMENTS, and the FLAT second one is a measured zero. `synthetic:bgarr` emits the identical
 *  source at `head` and `first-use` (the hoist has nothing to sit above) and that one row
 *  generalizes to nothing: over the artifact's agbcc rows the two emit DIFFERENT source on 3 of the
 *  8 rows this admission binds map-less and 4 of the 10 map-ful — `kleod:SetupBG3WindowOverlay`,
 *  `kleod:UpdateCameraScroll`, `pokeemerald:TrySetCantSelectMoveBattleScript`, and map-ful
 *  `kleod:StreamCmd_SetBGScroll`. Run through the harness on all four, an entry at
 *  `placement: 'first-use'` scores nothing: 146 → 146, noncompile → noncompile, MATCH → MATCH,
 *  noncompile → noncompile, against +1129 candidates over those rows' 15167 (+7.4%) and
 *  `kleod:UpdateCameraScroll` 224 s → 278 s. That row stays withheld.
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
 *  scoped row that answered there would ship the withheld candidate under this row's name — and it
 *  is the COMMON case, not the corner: over each project's whole `asm` tree, map-ful, of the 48
 *  functions this gate table admits, 41 place every init in the top-level list and only 7 reach a
 *  nested one. `hoistBaseLocals` DECLINES at `scope` in exactly that case (l3/basecse.ts) — a
 *  WITHDRAWAL and not a dedup, because on 29 of the 41 the flat spelling is one no other row here
 *  produces, which that file's header prices. Measured on
 *  `kleod:UpdateCameraScroll` map-ful, the row that priced the withheld one: 512 of its 512
 *  `/orderbase/scoped` sources placed the init at the top level, and all 512 are gone.
 *
 *  `pairings: false` on both for the field's own reason — a product is added for a row that demands
 *  the joint spelling, and neither row here demands one. */
export const ORDERBASE_ADMISSIONS: readonly BaseAdmission[] = [
  { suffix: '/orderbase', gates: ORDERBASE_GATES, placement: 'head', pairings: false },
  { suffix: '/orderbase/scoped', gates: ORDERBASE_GATES, placement: 'scope', pairings: false },
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
 * What is true is that no candidate is enumerated for the axis, and none is NEEDED: the recovery
 * reads the base from the observed pool word and the field offset from the observed load
 * displacement, so it reproduces the target's own split by construction. The measurements and the
 * conditions are in `raise/structs.ts`; nothing about them belongs in a roster comment. */
export const SIGN_CANDS = [
  { label: 'unsigned', signed: false },
  { label: 'signed', signed: true },
];

// A recovered POINTER/aggregate param must NOT be signedness-pinned: pinning a still-`unknown`
// pointer param to a scalar int BEFORE recovery blocks pointer recovery and emits uncompilable
// `*(s32)`. Only genuine scalars carry the signedness axis.
export const NO_PIN_KINDS = new Set(['ptr', 'struct', 'array']);
