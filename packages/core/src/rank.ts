// asmlift — candidate ENUMERATION, split from scoring. Type recovery is genuinely ambiguous
// from asm alone (is this value signed or unsigned? which branch sense did the source spell?).
// Rather than guess, asmlift emits a small set of CANDIDATES and lets an external differ score
// pick the winner — the differ is the fitness function; types/branch-sense are differ-ranked
// levers, not asserted truths.
//
// This module owns only the PURE half: producing the distinct candidate spellings. It has NO
// scorer (that stays out of @asmlift/core, which is browser-pure). `rankBy` takes an INJECTED
// scoreFn, so the same enumeration feeds the cli's Node/objdiff scorer and the webapp's
// wasm/objdiff scorer alike.
import { cBackend } from './backend/c';
import { assertDerefsTyped, assertLocalsWritten, assertPlacementSurvives, assertResolved } from './contracts';
import type { AsmData } from './frontend/asmdata';
import { frontendFor } from './frontend/registry';
import { hasSetupArgsNarrowing, narrowToSetupArgs } from './frontend/ssa';
import { globalCellOf } from './ir/alias';
import { Fn, type Op, type Value, defOpMap, successorsOf } from './ir/core';
import { T } from './ir/types';
import { verify } from './ir/verify';
import { materializeArgBases } from './l3/argbase';
import type { LanguageBackend, SFn } from './l3/ast';
import {
  BASEFOLD_GATES,
  type BaseKey,
  LIVEBASE_BLOCK_GATES,
  LIVEBASE_GATES,
  admittedBases,
  hoistBaseLocals,
} from './l3/basecse';
import { armDisjointCandidates, coalesceCandidates } from './l3/coalesce';
import type { Gate } from './l3/gates';
import type { HoistPlacement } from './l3/hoist';
import { homeSplitTag, homeSplitWithholds, splitHomeBases } from './l3/homesplit';
import { initFirstGuards } from './l3/initfirst';
import { inlinableConstBases, inlineConstBases } from './l3/inlinebase';
import { mulFirstSums } from './l3/mulfirst';
import { nearBaseClusters } from './l3/nearbase';
import { spellOperandMembers } from './l3/offmember';
import { parkParamsFirst } from './l3/parkfirst';
import { pollGuards, pollReads } from './l3/pollguard';
import { pointerFields } from './l3/ptrfield';
import { type RegcopyTail, registerishSpellings } from './l3/regspell';
import { reindexWalks } from './l3/reindex';
import { hoistScopedBases } from './l3/scopebase';
import { sinkInitsToFirstUse } from './l3/sinkinit';
import { type SymbolRef, collectSymbolRefs } from './l3/symbol-refs';
import { unmergeJoins } from './l3/unmerge';
import { type UnreduceResult, unreduceAccumulators } from './l3/unreduce';
import { deviceVolatileClaims, volatilePtrLocals, volatileSubsetCandidates } from './l3/volatileptr';
import { volatileValueLocals } from './l3/volatileval';
import { volatileDeviceStores } from './l3/volstore';
import { zeroSubNegates } from './l3/zerosub';
import { RewritePattern } from './pattern/engine';
import { applyIdiomPatterns, raiseRecovered, structureChecked } from './pipeline';
import { type Prototypes, prototypesFromSymbols } from './proto';
import { runPreRecovery } from './raise/pre-recovery';
import { recoverTypes } from './raise/recover';
import {
  hasDerivedReadHome,
  hasHomeableSharedAddress,
  hasLoopSharedPureValue,
  hasMergeFeedHome,
} from './structure/analysis';
import { hasParamRootedMerge } from './structure/structure';
import { type SymbolInfo, type SymbolMap, arrayInnerExtents, isPtrField, symbolsByName } from './symbols';
import { C_TYPEDEFS, type TargetDescription, structureOptionsFor } from './target';

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
interface StructuringAxis {
  flag:
    | 'reread'
    | 'inplace'
    | 'mergeNames'
    | 'addrHome'
    | 'exprHome'
    | 'derivedHome'
    | 'mergeHome'
    | 'unsCmp'
    | 'freshMerge';
  suffix: string;
  options: (on: boolean) => Parameters<typeof structureChecked>[1];
  probeGate?: (probe: Fn, defs: Map<Value, Op>) => boolean;
  variantGate?: (fn: Fn) => boolean;
  strip: boolean;
}
const STRUCTURING_AXES: readonly StructuringAxis[] = [
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
  // 196 → 245 over 679 corpus rows, 34 of them gaining 49 merges.
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
];

/** The statement-shape products (rank's second sanctioned product mechanism): each entry is a
 *  statement-order/shape re-spelling orthogonal to every representation lever, derived onto every
 *  spelling as sanctioned in the POLICY note at the respell site. Each shape fires alone, plus
 *  all of them together in table order — not the full subset lattice; the pairs question is
 *  settled by applyShapes' skip-on-decline below, and a row demanding a true EXCLUSION pair —
 *  all three fire, the match needs exactly two — is what would earn the lattice. */
const SHAPE_PRODUCTS: { suffix: string; apply: (sfn: SFn) => SFn | null }[] = [
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
const PRE_FAN_PRODUCTS: typeof SHAPE_PRODUCTS = [{ suffix: '/unmerge', apply: unmergeJoins }];

const SHAPE_SUBSETS: (typeof SHAPE_PRODUCTS)[number][][] = [
  ...SHAPE_PRODUCTS.map((x) => [x]),
  ...(SHAPE_PRODUCTS.length > 1 ? [SHAPE_PRODUCTS] : []),
];

/** The subset applied in table order, SKIP-ON-DECLINE: a member that declines contributes
 *  nothing rather than killing the combination — the all-shapes candidate is "everything that
 *  fires", so a pair is reachable whenever the third declines. The label is built from the
 *  members that actually FIRED, so a suffix never names a lever that declined; a fired-set that
 *  duplicates a smaller subset emits identical source and the dedup collapses it. Null when
 *  nothing fired. */
const applyShapes = (
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
const createdLocals = (from: SFn, to: SFn): Set<string> => {
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
 *  inhabitant exists — over the 856-row corpus the second admission reaches 8 rows, its `/nearbase`
 *  pairing 3, and its `/indexed`, `/coalesce` and volatile-subset products none at all. A function
 *  inhabiting them all pays far more, and the fan is not always a win there: the mixpoll dataset
 *  entry prices one where the `/coalesce` pairing costs the most candidates of any and scores two
 *  points worse than going unpaired. It fans anyway because a pairing belongs to the LEVER, not to
 *  one of its admissions.
 *
 *  `/basefold` is the third and fourth admission and the only conditional pair —
 *  `enumerateCandidates` appends them where the target declares
 *  `compilerBehaviors.foldsConstAddrOffset`. They need no second "did the primary already carry
 *  this" test: `structureChecked` runs the DEFAULT hoist to its fixpoint before any tree reaches
 *  here, so a key still admissible is by construction one `BASECSE_GATES` rejected, and binding
 *  nothing is the whole of the decline.
 *  WHAT THE EXEMPTION REACHES, over the 325 agbcc rows the artifact carries and in BOTH symbol-map
 *  configurations — 451 observations, of which 39 do not lift on this one-tree census.
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
 *  A target that declares no fold is offered neither row — not to protect a score (no roster row
 *  can cost one; see LIVEBASE_BLOCK_GATES) but because `unfoldedOffset` would be read as evidence
 *  on an instruction that carries the addend by construction, where there is none.
 *  On klonoa's `LoadBGTilemapData` — a checkout function rather than a row, so re-run it with the
 *  ranked command in docs/ranked-repro.md — the admission declines on every structuring, leaving
 *  that fan the size it was: 68352 candidates either way, with ZERO `basefold`-labelled candidates
 *  in the control arm. All floors, though: the ranked path structures each function many ways
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
 *  `kleod:ProcessInputAndUpdateEntities` 248 either way and `kleod:CountCollectedGems` 290 either
 *  way. Read the ablation in the note on BASEFOLD_ADMISSIONS, which carries the fan counts that
 *  prove it reached. */
interface BaseAdmission {
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
   *  membership. */
  pairings: boolean;
}

const LIVEBASE_ADMISSIONS: readonly BaseAdmission[] = [
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
 *  because a label a row wins can be a TIE another row also reaches. THE HEAD ADMISSION IS NOW
 *  BRACKETED AND THE SUNK ONE IS NOT. `synthetic:foldhead` is MATCH at 0 under
 *  `unsigned/basefold` and becomes NONMATCH 11 under `unsigned` the moment the HEAD entry is
 *  removed — and removing BOTH entries gives the same 11, so the sunk entry is what nothing here
 *  brackets. The rows this note used to cite as unbracketed still are, and for a reason worth
 *  keeping: `synthetic:foldsink` and `synthetic:basecell` are MATCH at 0 in every configuration
 *  because `/offmember` ALSO reaches 0 on them and wins `compareScored`'s line-count tie-break.
 *  A TIE IS NOT A SUBSUMPTION — that distinction is why a census over winning labels read zero
 *  here for as long as it did, and reading the zero as "loses" is what nearly deleted the pair.
 *  (Their fans still move: `foldsink` 12 → 8 → 8 → 4 over control/sunk/head/both, `basecell`
 *  4 → 4 → 4 → 2, the four-number sequence saying that on `basecell` the two entries emit the
 *  SAME two sources and `seen` collapses them, so only removing both takes the fan down.)
 *  `sa3:sub_803213C` MATCH, and — with the pair removed — `kleod:ProcessInputAndUpdateEntities`
 *  248, `kleod:CountCollectedGems` 290 and `kleod:RollRandomLevelVariant` 18, each of them the
 *  number the artifact already carries. A BRACKET IS A CLAIM ABOUT THE WHOLE TREE, so it expires
 *  whenever anything else learns to reach the same spelling more cheaply: re-run one before
 *  re-quoting it, including the number that survived the last re-run.
 *  The SUNK entry is kept ONLY because it is a real spelling: 3921 distinct candidate sources over
 *  14 observations that nothing else emits (see WHAT THE PAIR COSTS above for the per-row split),
 *  and a C source that initializes its base pointers where it declares them is the ordinary case.
 *  That is a weaker justification than a protected row and should be read as one — a round pricing
 *  the agbcc fan may delete it, and the gate on doing so is `bench diff`, not this note. The HEAD
 *  entry is no longer in that category: deleting it costs `synthetic:foldhead` its match, which
 *  `bench regression` fails on.
 *  HOW THE ABLATION IS DONE, since there is no shipped knob: filter this roster at its one use
 *  site (the `admissions` const in `enumerateCandidates`) behind a temporary env read, run the
 *  rows with `ASMLIFT_CANDCACHE=0`, and revert. Prove the filter REACHED before believing a null
 *  result — `synthetic:livepark` MATCH → diff:3 with `/livebase` removed is the positive control,
 *  and a fan count per configuration is the second. */
const BASEFOLD_ADMISSIONS: readonly BaseAdmission[] = [
  { suffix: '/basefold', gates: BASEFOLD_GATES, placement: 'head', pairings: false },
  { suffix: '/basefold/sinkinit', gates: BASEFOLD_GATES, placement: 'first-use', pairings: false },
];

const sameBases = (a: readonly string[], b: readonly string[]): boolean =>
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
const SIGN_CANDS = [
  { label: 'unsigned', signed: false },
  { label: 'signed', signed: true },
];

// A recovered POINTER/aggregate param must NOT be signedness-pinned: pinning a still-`unknown`
// pointer param to a scalar int BEFORE recovery blocks pointer recovery and emits uncompilable
// `*(s32)`. Only genuine scalars carry the signedness axis.
const NO_PIN_KINDS = new Set(['ptr', 'struct', 'array']);

/** Pin every SCALAR entry param (index not in `ptrIdx`) to the candidate signedness, before
 *  recovery. Answers whether any param was PINNABLE — not whether its type moved: which of the
 *  two passes writes first is an accident of enumeration order, and the arms differ exactly where
 *  a param can be written at all.
 *
 *  A param NARROWED by raise/paramwidth.ts is not pinnable: the extension it was narrowed at states
 *  the signedness as well as the width — agbcc's shift pair by its `asr`/`lsr`, PPC's `extsb`/`extsh`
 *  by the opcode — so there is no question for the axis to put to the differ, and pinning would
 *  widen it back to 32 bits. */
function pinScalarParams(fn: Fn, signed: boolean, ptrIdx: Set<number>): boolean {
  let pinnable = false;
  fn.blocks[0].params.forEach((p, i) => {
    if (ptrIdx.has(i)) {
      return;
    }
    if (p.type.kind === 'unknown' || (p.type.kind === 'int' && p.type.width === 32)) {
      pinnable = true;
      p.type = signed ? T.s(32) : T.u(32);
    }
  });
  return pinnable;
}

/** Bare-global ACCESS FACTS for name-only map symbols — the width/signedness authority the
 *  declaration synthesis (declare.ts) uses when the map has no shape. The map knows only the
 *  NAME (symtab-only projects: marioparty3); the candidate's own IR knows exactly how the cell
 *  is accessed, and the bare `gSym = v` / `x = gSym` spelling compiles to those bytes only
 *  under a decl of that exact width (`extern u16 g;` is `sh` where a guessed u32 is `sw`).
 *  Mirrors structure()'s scalar-global rule: a fact is recorded only for a symbol accessed
 *  EXCLUSIVELY at offset 0 with ONE width and ONE load signedness — anything else (interior
 *  offsets, address arithmetic, width or sign conflicts) records nothing, because those
 *  spellings go through `&gSym` casts where every object decl is address-identical. */
function bareGlobalAccessFacts(fn: Fn): Map<string, { width: number; signed: boolean }> {
  const defs = defOpMap(fn);
  const symOf = (v: Value): string | null => {
    const d = defs.get(v);
    return d?.opcode === 'gaddr' && d.attrs.code !== true ? (d.attrs.sym as string) : null;
  };
  const acc = new Map<string, { widths: Set<number>; signs: Set<boolean>; interior: boolean }>();
  const get = (s: string) => acc.get(s) ?? acc.set(s, { widths: new Set(), signs: new Set(), interior: false }).get(s)!;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'load' || op.opcode === 'store') {
        const s = symOf(op.operands[0]);
        if (s) {
          const a = get(s);
          if ((op.attrs.off as number) !== 0) {
            a.interior = true;
          } else {
            a.widths.add(op.attrs.width as number);
            if (op.opcode === 'load') {
              a.signs.add(((op.attrs.signed as boolean) ?? false) && (op.attrs.width as number) < 4);
            }
          }
        }
      } else if (op.opcode === 'aload' || op.opcode === 'astore') {
        const s = symOf(op.operands[0]);
        if (s) {
          get(s).interior = true;
        }
      } else {
        // any other use of the address (arithmetic, a call arg, a comparison) is interior/escape
        for (const o of op.operands) {
          const s = symOf(o);
          if (s) {
            get(s).interior = true;
          }
        }
      }
    }
  }
  const out = new Map<string, { width: number; signed: boolean }>();
  for (const [s, a] of acc) {
    if (!a.interior && a.widths.size === 1 && a.signs.size <= 1) {
      out.set(s, { width: [...a.widths][0], signed: a.signs.has(true) });
    }
  }
  return out;
}

/** Names a declaration must never claim, because `extern u32 <name>;` is not a declaration of
 *  `<name>` at all for them. Four groups, and only the first two are guessed:
 *
 *    1. the prelude's own typedef names, derived FROM `C_TYPEDEFS` rather than re-listed (a
 *       prelude that grows a name grows this set) — `extern u32 u16;` redefines the type the
 *       declaration is written in;
 *    2. the C89 keywords;
 *    3. the gnu89 keywords gcc-2.9 REJECTS in this position, and the two library objects it
 *       refuses to have redeclared. MEASURED against the pinned agbcc — 72 plausible pool names
 *       compiled as `extern u32 <name>;` at file scope, 18 exited non-zero: `syntax error before
 *       'asm'` for the keyword class, ``'exit' redeclared as different kind of symbol`` for the
 *       two built-ins;
 *    4. the gnu89 declaration SPECIFIERS that PARSE and thereby declare nothing — `inline`,
 *       `__const`, `__volatile__`, … are `warning: useless keyword or type name in empty
 *       declaration`, exit 0, and the name is still undeclared. Emitting the line would be a
 *       declaration that is not one.
 *
 *  WHAT REFUSING BUYS is less than a plain `'<name>' undeclared`, and the difference is the
 *  reason the refusal is REPORTED rather than trusted to the compiler. A hard error in the block
 *  kills that candidate's whole TU (its own — every candidate compiles alone) for a name it
 *  merely mentioned, so refusing is right. But for a KEYWORD the body spells the same token
 *  anyway and the candidate still fails: the refusal only moves the diagnostic. And for the two
 *  BUILT-INS nothing fails — agbcc reads `&exit` as the address of its own builtin, exit 0 with
 *  `warning: built-in function 'exit' used without declaration`, where the declaration would have
 *  been exit 1. There the refusal trades a candidate that cannot build for one that builds
 *  against the wrong object, which is the better half of a bad choice only because a target
 *  naming a global `exit` has no honest spelling either way. */
const DECL_RESERVED = new Set<string>([
  ...[...C_TYPEDEFS.matchAll(/(\w+)\s*;/g)].map((m) => m[1]),
  ...(
    'auto break case char const continue default do double else enum extern float for goto if int long ' +
    'register return short signed sizeof static struct switch typedef union unsigned void volatile while'
  ).split(' '),
  // group 3 — measured hard errors (agbcc, `extern u32 <name>;` at file scope)
  ...(
    'asm __asm __asm__ typeof __typeof __typeof__ __attribute __attribute__ __extension__ __label__ ' +
    '__alignof __alignof__ __real__ __imag__ __func__ __FUNCTION__ exit abort'
  ).split(' '),
  // group 4 — measured "useless keyword ... in empty declaration": parses, declares nothing
  ...(
    'inline __inline __inline__ __const __const__ __signed __signed__ __volatile __volatile__ ' +
    '__restrict __restrict__ __complex__'
  ).split(' '),
]);

/** The emitter's own NAME GRAMMAR for storage it invents: parameters `a0, a1, …` (structure.ts
 *  names them positionally, so no rename can move one) and coalesced/temp locals `v0…`/`t0…`
 *  (structure.ts's `localNames` accepts exactly `/^[vt]\d+$/`). A pool or map symbol with one of
 *  these names cannot be declared beside the C that spells it — see the refusal in `refsOf`, which
 *  is the one that kills the spelling rather than the line.
 *
 *  Checked as a grammar IN ADDITION to the tree's own bound names, because the collision that
 *  matters is the one the tree cannot show: `localNames` DROPS a local whose name a written
 *  global already claims, so where the global is stored `tree.locals` is silent about it. The
 *  price is refusing a real global that happens to be named `v3` in a function that never mints
 *  one — measured at zero: over the 930 benchmark rows, in each row's own symbol world, no
 *  candidate references such a name, and none of the six vendored symbol maps contains one
 *  (184163 names, 0 matches). */
const EMITTER_NAME = /^[avt]\d+$/;

/** Why a name the candidate's tree references got NO declaration. Reported rather than silently
 *  applied, because an undeclared name and a REFUSED one produce the same `'x' undeclared` from
 *  the compiler and only the second one is asmlift's own decision. Same argument as `onLeverError`
 *  one screen down: a refusal nobody can see is indistinguishable from a capability that was
 *  never there.
 *
 *  ALL FIVE ARE DECIDED AT ONE POINT (`refsOf`), over the names the collector actually returns
 *  and AFTER the map/pool union — so the report and the rendered block are one list read two
 *  ways. A test applied where a name ENTERS can be undone by the other half of the union, and
 *  then the report contradicts the block beside it. */
export type RefusedDeclarationReason =
  | 'not-an-identifier' // a relocation name like `$L1` / `.rodata.str1`
  | 'reserved' // a name `extern u32 <name>;` cannot declare (DECL_RESERVED)
  | 'call-target' // the name is some call's target: `void F(void);` hard-errors over args
  | 'self-name' // the function's own name — its definition already declares it
  | 'emitter-name'; // a name the emitted C uses for its OWN locals and parameters

/** The globals a candidate names because its own asm named them, as name-only `SymbolInfo`s —
 *  half of the declaration-synthesis dictionary (the symbol map, where there is one, is the other).
 *
 *  asmlift does not need a map to EMIT a symbol name: the Thumb frontend reads it out of the
 *  `.s` file's own literal pool (`.word gBgTilemapBufs` → `gaddr`, thumb.ts's pool grammar) and
 *  the MIPS frontend out of an object relocation, and structure() spells such a `gaddr` as
 *  `&gSym`. So the invariant "a candidate's source only names symbols the map knows" is FALSE,
 *  and a consumer that compiles candidates OUTSIDE the project's own headers (the playground)
 *  needs these declarations or every candidate fails with "`gSym' undeclared".
 *
 *  `kind: 'data'` unconditionally: `code: true` is set only where a symbol MAP said so
 *  (frontend/thumb.ts), so map-less the IR cannot tell a function pointer from a data address —
 *  and it does not need to. structure() spells a `code`-less `gaddr` as `&Name`, and `&Name`
 *  under `extern u32 Name;` is the relocated address whatever Name really is.
 *
 *  NOTHING IS REFUSED HERE, deliberately: a name this walk drops is a name the union above it
 *  could put straight back. Every refusal is decided once, over the collector's output, in
 *  `refsOf` (see `RefusedDeclarationReason`).
 *
 *  A declaration built from this half is a HYPOTHESIS, and where `bareGlobalAccessFacts` gives it
 *  a width that width came out of the asm the candidate is scored against. The marker is
 *  `SymbolRef.synthesized`; the argument, and its price against the vendored maps, is declare.ts's
 *  module note. */
function bareGlobalSymbols(fn: Fn): Map<string, SymbolInfo> {
  const out = new Map<string, SymbolInfo>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'gaddr' && typeof op.attrs.sym === 'string') {
        out.set(op.attrs.sym, { name: op.attrs.sym, kind: 'data' });
      }
    }
  }
  return out;
}

export interface EnumerateOptions {
  patterns?: RewritePattern[];
  backend?: LanguageBackend;
  prototypes?: Prototypes;
  asmData?: AsmData;
  /** address→symbol map (symbols.ts) — same contract as DecompileOptions.symbols */
  symbols?: SymbolMap;
  /** Called when a re-spelling lever THROWS or fails a boundary contract, so the failure is visible
   *  instead of the candidate silently not existing. Enumeration continues either way — the primary
   *  spelling is unaffected — but a lever that never fires because it always throws is a defect, and
   *  without this it looks identical to a lever that correctly declined. */
  onLeverError?: (label: string, error: string) => void;
  /** Called once per (name, reason) when the declaration synthesis REFUSES a name the tree
   *  references (see `RefusedDeclarationReason`). The name then stays undeclared and the
   *  candidate fails loudly in a self-declared world — this is what lets the consumer say which
   *  undeclared name was asmlift's own refusal rather than a symbol it never saw. */
  onRefusedDeclaration?: (name: string, reason: RefusedDeclarationReason) => void;
}

/** One distinct candidate spelling — a point in the axis cross (signedness × branch sense ×
 *  def-site anchoring × bitfield spelling × symbol-map variant, plus the L3 re-spellings) —
 *  emitted to source. */
export interface Candidate {
  label: string;
  source: string;
  /** Which PREFERENCE GROUP this spelling belongs to — the symbol-variant index (0 = the map's own
   *  named spellings, 1 = their `/raw-globals` siblings). Enumeration emits the groups in
   *  preference order, and a lower group WINS a score tie: when both compile to the same bytes the
   *  reader should get `gCounter.field`, not a byte offset off a hoisted `(u8 *)` base.
   *
   *  Carried structurally rather than left to enumeration order because the readability tie-break
   *  (compareScored) must compare only spellings that are genuinely alternatives of the same
   *  thing. Ranking a named spelling against a raw-address one on cast count is not a readability
   *  comparison at all — the raw form's `(u8 *)` base is not counted, so it would win by
   *  construction, trading named struct fields for anonymous byte offsets. */
  group: number;
  /** the DECLARABLE VALUE references this candidate's tree contains — what the scoring layer's
   *  declaration synthesis renders. DERIVED, never carried: computed once from the exact tree
   *  this candidate's source was emitted from, at the moment the candidate is finalized
   *  (l3/symbol-refs.ts — no pipeline stage caches refs, so they cannot go stale). Present on
   *  EVERY spelling variant that names such symbols — including '/raw-globals', whose tree still
   *  names pool/reloc-derived globals (it only drops the map's shaped SPELLINGS).
   *
   *  PRESENT WITHOUT A MAP TOO: a name is read out of the asm's own literal pool or relocation,
   *  so "a candidate only names symbols the map knows" is false. Where a map DOES know the name
   *  its facts win; the rest are
   *  synthesized name-only symbols (`bareGlobalSymbols`) and carry `synthesized: true` — a
   *  consumer publishing a byte-exact verdict must show those declarations, because they were
   *  fitted to the same asm the verdict is about (see SymbolRef.synthesized). */
  symbolRefs?: SymbolRef[];
  /** `volatile` claims this spelling makes on one of the target's device registers — the
   *  volatility tie-break's input (compareScored). DERIVED from the tree the source was emitted
   *  from, like `symbolRefs`, because the qualifier and the address it applies to are often two
   *  statements apart and the rendered text cannot pair them. */
  deviceVolatile?: number;
  /** PUBLISHABLE ONLY WHERE THE DIFFER PROVES IT — a byte-exact score, nothing else.
   *
   *  The third admission ground, and the narrowest. A lever must preserve semantics by
   *  construction (the POLICY note at the respell site), because on a nonmatch row the best
   *  spelling is what the user is shown. One spelling cannot meet that bar from inside the pass:
   *  `l3/unreduce.ts` moves a memory read into a loop whose stores are all device registers, and
   *  on this board a device store can make the DEVICE write ordinary memory (a DMA trigger), which
   *  no gate over the C can rule out. What settles it instead is the object: a candidate that
   *  assembles to the target's own bytes IS the program, whatever a gate could have proved. So the
   *  spelling is offered, scored, and then either wins on proof or is WITHHELD — never shown as a
   *  best-effort answer. Both ranking drivers ask `withheldReason`, so neither can publish what the
   *  other would not. */
  matchOnly?: true;
}
/** A candidate paired with its score `S` (the injected scorer's result shape — must carry `.score`). */
export interface Scored<S> extends Candidate {
  score: S;
}
/** A candidate the scorer REFUSED — its C did not build. Recorded rather than discarded: a
 *  spelling that fails to compile is a defect in the emitter or in the facts it was given, and a
 *  scoring harness that shows only the surviving sibling reports a clean win over a hidden
 *  failure. */
export interface DroppedCandidate {
  label: string;
  /** the scorer's first error line (a compiler diagnostic, usually) */
  error: string;
}

/** A candidate that BUILT and SCORED and was then withheld for want of proof (`Candidate.
 *  matchOnly`). Kept apart from `dropped`, which means "the scorer refused it": a spelling that
 *  compiled fine and simply did not earn publication is a different fact, and folding the two
 *  would make the `[dropped]` line report compile failures that never happened. */
export interface WithheldCandidate {
  label: string;
  score: number;
  /** one line: why publication needed a proof this score did not supply */
  why: string;
}

export interface RankedResult<S> {
  best: Scored<S>; // lowest score
  candidates: Scored<S>[]; // sorted best (lowest) first
  /** candidates whose scoreFn threw — empty when every spelling built */
  dropped: DroppedCandidate[];
  /** candidates withheld for want of a byte-exact proof — empty unless a `matchOnly` lever fired */
  withheld: WithheldCandidate[];
}

/** THE publication rule for a `matchOnly` spelling, in one place because there are TWO ranking
 *  drivers over one enumeration (this module's sync `rankBy` and the webapp's async await-loop),
 *  and a filter written twice is how they come to publish different answers. Null ⇒ publish.
 *
 *  `score === 0` is objdiff's byte-exact match (cli objdiff.ts states the equivalence), which is
 *  why a bare `.score` suffices and the generic needs no `match` field. */
export function withheldReason<S extends { score: number }>(c: Candidate, score: S): string | null {
  return c.matchOnly === true && score.score !== 0
    ? 'this spelling rests on a device-behaviour fact no gate over the C can settle; only a byte-exact score proves it'
    : null;
}

/** What a re-spelling lever hands `respell`: its tree, or — when the lever cannot establish the
 *  candidate's semantics from inside the pass — the tree paired with that fact. `undefined`/`null`
 *  is a decline. */
type LeverResult = SFn | { sfn: SFn; needsProof: boolean } | null | undefined;

/** REQUIRE-ALL composition of re-spelling levers, and the ONE place a proof obligation crosses
 *  from one lever to the next.
 *
 *  `LeverResult` is a union, so a hand-written composition can spell the obligation away by
 *  accident and stay type-correct: `return pointerFields(u.sfn);` in place of
 *  `return { sfn: t, needsProof: u.needsProof };` compiles, passes tsc and passes every suite,
 *  and publishes as asmlift's answer a spelling that was supposed to be withheld unless byte-exact.
 *  Composing through here makes dropping it INEXPRESSIBLE — a caller lists the stages and never
 *  touches the flag.
 *
 *  The obligation is MONOTONE, which is what lets it be an `or`: it says "no gate over this C can
 *  settle the fact this spelling rests on", and a later re-spelling cannot settle a fact about an
 *  earlier one. `/ptr-field` re-types a field and never moves a read, so it carries `/unreduce`'s
 *  obligation through unchanged rather than discharging it.
 *
 *  REQUIRE-ALL, never skip-on-decline: one declining stage declines the whole composition, so the
 *  label always names exactly the levers that fired. That is the property the pairing site turns
 *  on, and the reason it rejects `applyShapes` — see the POLICY note there. */
export function composeLevers(sfn: SFn, stages: readonly ((s: SFn) => LeverResult)[]): LeverResult {
  let cur = sfn;
  let needsProof = false;
  for (const stage of stages) {
    const made = stage(cur);
    if (!made) {
      return null;
    }
    cur = 'sfn' in made ? made.sfn : made;
    needsProof = needsProof || ('sfn' in made && made.needsProof);
  }
  return needsProof ? { sfn: cur, needsProof } : cur;
}

/** One emitted spelling of a structured tree: the label suffix naming the lever that produced it,
 *  the rendered source, and the tree-derived facts `compareScored` ranks by. */
interface Spelling {
  suffix: string;
  source: string;
  symbolRefs?: SymbolRef[];
  deviceVolatile?: number;
  /** see `Candidate.matchOnly` — set by a lever that cannot establish its own semantics */
  matchOnly?: true;
}

/** Emit the DISTINCT type/branch-sense candidate spellings for `name` — PURE, no scoring.
 *  The ONE difference from `decompile()` is the signedness pin, injected between pre-recovery and
 *  recoverTypes via the `beforeRecover` hook. Duplicate sources are collapsed so the scorer never
 *  recompiles an identical spelling, and the fan runs once per distinct STRUCTURED TREE rather
 *  than once per axis point — an axis inert on this function reaches a tree an earlier point
 *  already spelled, and every re-spelling is a pure function of that tree. */
export function enumerateCandidates(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: EnumerateOptions = {},
): Candidate[] {
  const backend = opts.backend ?? cBackend;
  /** The last refusal from a backend asked to spell a tree — what the empty-enumeration check
   *  below reports, so "this backend can spell nothing here" names its reason. */
  let lastEmitError: unknown = null;
  // Same merge as `decompile`: the project's DWARF signatures fill in what the caller did not
  // state, so both the annotate pass and the ranked candidates reason about one prototype table.
  const prototypes = prototypesFromSymbols(opts.symbols, opts.prototypes ?? {});
  const frontend = frontendFor(target);
  const baseOpts = {
    ...structureOptionsFor(target, prototypes[name]?.returnsVoid ?? false),
    ...(opts.symbols ? { symbols: symbolsByName(opts.symbols) } : {}),
  };
  // Branch-sense is a differ-ranked LEVER, the same class as param signedness: a divergent `if`
  // can be spelled with either sense (`if (c) A else B` vs `if (!c) B else A`), and which one the
  // source compiler emitted is genuinely ambiguous from asm. There is no safe global heuristic
  // (`ifor` wants positive, `simpleif` wants negated, `diamond` wants positive) — emit BOTH senses
  // and let the differ referee. The default sense is always among them, so this never scores
  // worse; it only wins where the flip matches.
  const defSense = baseOpts.preserveDivergentBranchSense ?? true;
  // `/defsite` — def-site-anchored constant merge copies (structure.ts anchorConstCopies) — is a
  // structuring axis on the same footing as branch sense: where the asm materialized a merge
  // constant is placement evidence, but whether the SOURCE spelled it there is genuinely
  // ambiguous, so both placements are emitted and the differ referees. Crossed with branch sense
  // (an anchored copy empties an arm, which is exactly what changes which sense wins); the dedup
  // below collapses every variant the anchoring left unchanged.
  //
  // `/defsite/loop-entry` widens it to a LOOP HEADER's entry const (`int s = 0;` above the guard
  // rather than on the edge into the loop). Its own point rather than a widening of `/defsite`
  // because it is a SECOND placement decision: a function carrying both kinds of anchorable const
  // has THREE spellings, and folding the two decisions into one boolean would delete the middle
  // one — measured on klonoa's TransitionSelfRemoveFadeIn, where 448 of the 896 sources `/defsite`
  // reaches became unreachable. Enumerated as a CHAIN (none ⊂ plain ⊂ plain + entry) rather than a
  // 2×2 cross: the fourth point costs another quarter of the whole fan — the anchor dimension
  // multiplies everything below it — and no row has been shown to need it.
  const senseAnchor = [
    { suffix: '', sense: defSense, anchor: false, entry: false, bitfields: true, ptrElems: true, declRank: true },
    {
      suffix: '/flip-branch',
      sense: !defSense,
      anchor: false,
      entry: false,
      bitfields: true,
      ptrElems: true,
      declRank: true,
    },
    {
      suffix: '/defsite',
      sense: defSense,
      anchor: true,
      entry: false,
      bitfields: true,
      ptrElems: true,
      declRank: true,
    },
    {
      suffix: '/flip-branch/defsite',
      sense: !defSense,
      anchor: true,
      entry: false,
      bitfields: true,
      ptrElems: true,
      declRank: true,
    },
    {
      suffix: '/defsite/loop-entry',
      sense: defSense,
      anchor: true,
      entry: true,
      bitfields: true,
      ptrElems: true,
      declRank: true,
    },
    {
      suffix: '/flip-branch/defsite/loop-entry',
      sense: !defSense,
      anchor: true,
      entry: true,
      bitfields: true,
      ptrElems: true,
      declRank: true,
    },
  ];
  // `/flip-join` — the JOINED-if sibling of `/flip-branch` (structure.ts
  // negateJoinedBranchSense): a reconverging two-armed if reads the same fall-through-is-then
  // layout evidence the divergent case does, so the DEFAULT sense is the divergent one's and
  // this axis emits the other. Read off the TARGET's sense, not this candidate's `s.sense`, so
  // `/flip-branch` still moves only divergent ifs and the two axes stay independent. The suffix
  // therefore names a sense RELATIVE to the target's default: a label quoted from a log identifies
  // a spelling only together with the tree that produced it, which is what the `[asmlift source
  // <commit>]` stamp on the `[ranked]` line is for (docs/ranked-repro.md).
  // Crossed with the pair above. The two senses are two different sources wherever a two-armed
  // joined `if` exists at all — agbcc emits different bytes for the arms-swapped spelling — and
  // all three things that invert the polarity are per-SITE where this lever is per-function, so no
  // per-function predicate decides it: a short-circuit fold choosing the orientation, a
  // conditional branch relayed past Thumb's ±256-byte reach, and a rotated loop's zero-trip guard,
  // where the `if` is the compiler's own and no source sense exists to be faithful to. The third
  // is what keeps the residue on targets that have neither: of the 19 rows that still win on the
  // axis, 7 are gcc2.7.2 / gcc2.7.2kmc / mwcc with no `short-circuit` tag and no Thumb branch
  // range, and 5 of those 7 carry `loop`. A function with no two-armed joined if emits identical
  // source and the dedup collapses it before any compile.
  const baseSense = [
    ...senseAnchor.map((s) => ({ ...s, join: false })),
    ...senseAnchor.map((s) => ({ ...s, suffix: `${s.suffix}/flip-join`, join: true })),
  ];
  // `/no-bitfield` — keep the honest shift spelling where the map would name a bitfield member.
  // The named read recompiles at the DECLARATION's access width; where that diverges from the
  // asm's load width, the shifts are the spelling that matches — so both are emitted and the
  // differ referees. Enumerated only when the map carries any bitfield member at all (checked
  // below), so the 2× cross is paid exactly by the functions it can help; the dedup collapses
  // every variant where no fold fired.
  const mapHasBitfields =
    opts.symbols !== undefined &&
    [...opts.symbols.values()].some((infos) =>
      infos.some((i) => [...(i.layout ?? []), ...(i.pointee?.layout ?? [])].some((f) => f.bitWidth !== undefined)),
    );
  const bitfieldCands = mapHasBitfields
    ? [...baseSense, ...baseSense.map((s) => ({ ...s, suffix: `${s.suffix}/no-bitfield`, bitfields: false }))]
    : baseSense;
  // `/connective`'s enumeration gate, read off the pass's OWN refusal rather than from a second
  // copy of its matcher: the fold reports every site where the PAIRWISE comparison-tree refusal is
  // the ONE thing stopping it — asked after `sameArgs` and the negatability check, so a report
  // means a candidate that DIFFERS, not a refusal merely reached — and a function with none has no
  // inhabitant for the axis.
  //
  // PER SYMBOL VARIANT, on a lift of its OWN, for the reason the `/setup-args` gate below states
  // for itself: no lift may be governed by a fact measured on a different one. The pin and
  // `/setup-args` cannot move this answer — neither a parameter's type nor a call's argument list
  // moves a `cond_br` — but a SYMBOL MAP can, by lifting a pool-loaded comparison constant as a
  // `gaddr` the const-test test then does not read. Today they agree: over the 164 real rows that
  // lift (the other 88 are frontend declines), 21 sites mapped and 21 raw with no per-row
  // divergence. The synthetic tier used to be excluded from that sentence as carrying "no map at
  // all"; it is 705 rows of which 4 now DO carry one (`SynthSpec.symbols`), so it is a population
  // this comparison could run over rather than one it is exempt from — and the count moves every
  // time a map row is added, which is why the exemption is gone rather than renumbered. So this buys no candidate; what it buys is
  // that a lift-time change which splits them enumerates both arms rather than silently dropping
  // one, the failure nothing reports.
  //
  // The MAPPED variant reads it off the probe below, itself a lift in exactly that configuration —
  // reuse, not inheritance. Only a variant lifting under DIFFERENT symbols pays a lift of its own,
  // so the price is one per `/raw-globals` arm and zero on a map-less row, never per candidate.
  let probeTreeOwned = false;
  const treeOwnedIn = (symbols: typeof opts.symbols): boolean => {
    if (symbols === opts.symbols) {
      return probeTreeOwned;
    }
    const p = frontend.lift(name, asm, target, prototypes, opts.asmData, symbols);
    verify(p);
    applyIdiomPatterns(p, target, opts.patterns);
    let seen = false;
    runPreRecovery(p, target, () => verify(p), prototypes[name], {
      shortCircuit: {
        onTreeOwned: () => {
          seen = true;
        },
      },
    });
    return seen;
  };
  // Probe: recover ONCE with no signedness pin, to learn which entry params are pointers/aggregates
  // so they are excluded from the signedness axis (see NO_PIN_KINDS). One extra lift+recover, no
  // compile. (The probe deliberately stops after recoverTypes — it only reads the param KINDS, so
  // the totality contract / return-sinking of the full spine are not run on it.)
  const probe = frontend.lift(name, asm, target, prototypes, opts.asmData, opts.symbols);
  verify(probe);
  applyIdiomPatterns(probe, target, opts.patterns);
  runPreRecovery(probe, target, () => verify(probe), prototypes[name], {
    shortCircuit: {
      onTreeOwned: () => {
        probeTreeOwned = true;
      },
    },
  });
  recoverTypes(probe);
  const ptrIdx = new Set<number>(probe.blocks[0].params.flatMap((p, i) => (NO_PIN_KINDS.has(p.type.kind) ? [i] : [])));
  // Access facts for name-only symbol declarations (see bareGlobalAccessFacts) — derived once
  // from the probe: widths/offsets are lift-time facts, identical across every candidate.
  // Ungated on `opts.symbols`: map-less candidates now carry name-only refs too (see
  // `bareGlobalSymbols`), and these facts are their declarations' WIDTH AUTHORITY — without them
  // every map-less decl would be the `extern u32` fallback and a bare `gCell = x` would compile
  // to `str` where the target says `strh`. One IR walk; on a function with no `gaddr` at all
  // (every synthetic corpus row) it returns the same empty map the gate used to hand back.
  const accessFacts = bareGlobalAccessFacts(probe);
  // `/no-ptr-elem` — keep the honest byte arithmetic where the map would spell a whole-element
  // subscript through a pointer MEMBER (`gBg.pMap[i + 157]`). The two are the same address and
  // DIFFERENT objects — measured against agbcc, they differ in which register the `add` targets at
  // every constant tested — so which side matches is per-function knowledge the asm does not
  // carry, and the differ referees it exactly as it referees `/no-bitfield`.
  //
  // THE CROSS IS EXPENSIVE AND THE GATE IS WHAT BOUNDS IT, so the gate is asked of THIS FUNCTION,
  // not of the map: a pointer member is only ever spelled off a container the function names, and
  // every named global reaches the IR as a `gaddr`. A map-wide `some` would charge the cross to
  // every function lifted alongside such a symbol, which is co-occurrence, not reach. The map must
  // still declare a pointee WIDTH of 1, 2 or 4 — nothing else is an element — and `isPtrField` is
  // the shared two-fact test, so this gate and the rule it gates cannot disagree about what a
  // pointer member is.
  //
  // (`/no-bitfield` above still asks the MAP rather than the function; narrowing it would be this
  // same edit against a different measurement. Its cross is censused below beside this one.)
  //
  // Where it DOES reach, the cross is the honest price of an arm the differ has to referee, and on
  // the corpus's largest fan it is large: `kleod:ProcessInputAndUpdateEntities` enumerates 58,752
  // candidates of which 23,040 carry this arm, so removing it leaves 35,712 — a factor of 1.65,
  // NOT the doubling this paragraph claimed after it deleted a stale pair (17,856 / 12,096) for
  // being stale. A vaguer number is not a safer one: that replacement was larger than the truth.
  // Re-measure before quoting either — the instrument is `decompileRanked`'s own enumeration, and
  // a direct `enumerateCandidates` call from a standalone script is NOT it (an ESM/CJS duplicate
  // of this module answers 544 where the harness answers 952 on `SetupBG3WindowOverlay`).
  //
  // The two arms are also NESTED rather than independent — `ptrElemCands` is built by doubling
  // `bitfieldCands`, so this arm's candidates include the `/no-bitfield` ones and adding the two
  // families' counts double-counts the overlap: on that same row 12,672 of the 23,040 carry BOTH
  // tokens, which is half of `/no-bitfield`'s own 25,344. A per-family price read off either
  // label alone therefore double-counts more than half of this row's cross.
  //
  // ONE WINNING LABEL IN THE ARTIFACT CARRIES `/no-ptr-elem` — `synthetic:ptrelem:agbcc`, match at
  // 0 — and until that row was authored there were none. This paragraph used to conclude from the
  // zero that the arm is "a price paid for a question the asm cannot answer, not a lever earning
  // its keep", and then, having disproved that, went on asserting the zero as a standing fact in
  // the same breath as shipping the row that ends it. Measured, the axis
  // is two-sided: compile the byte spelling and the element spelling of the SAME address with the
  // klonoa checkout's own agbcc, lift each back with that project's own map, and the arm is the
  // ONLY candidate that matches the byte target while the default is the only one that matches the
  // element target — on a constant element offset, at one element in, at a pointee width of 1, and
  // on a STORE. `cli/test/matching/ptr-elem-axis.test.ts` is that measurement, and deleting the
  // `ptrElemCands` cross below turns 8 of its 13 assertions red — the four BYTE-target ones (each
  // scoring 1 rather than 0) and the four that check the arm is enumerated at all — while its four
  // ELEMENT-target ones stay green, which is the two-sidedness itself. What the census counts is
  // that the ONE symbol klonoa's map declares with a sized pointer member happens to be spelled in
  // the element form by every decompiled caller of it — not that the OFF arm loses where it fires.
  //
  // WHERE IT GENUINELY DOES NOT REACH, measured on the same probes: at element offset ZERO the two
  // arms emit the IDENTICAL source (`((u16 *)gSym.pMap)[a0]`, because with no constant left there
  // is nothing for the byte form to spell differently), the tree dedup collapses the pair — 10
  // candidates, not 12 — and neither arm matches a byte-form target. That is an open gap in the
  // spelling, not a refusal of this axis.
  //
  // STATE THE DENOMINATOR, AND DERIVE IT FROM REACH RATHER THAN FROM CO-OCCURRENCE — the same
  // distinction the paragraph above draws about the gate, applied to the gate's own price.
  // "Offered only where a symbol map exists" is true and useless: all 252 real rows carry a map,
  // so that framing hands back 151 labelled rows, which is the map-wide `some` this gate was
  // written to avoid. The gate is per-FUNCTION, so census the FUNCTIONS. Enumerating every real
  // case (candidates only, `ASMLIFT_CANDCACHE=0`, the harness's own inputs) and counting rows with
  // any surviving `/no-ptr-elem` candidate: TWO — `kleod:ProcessInputAndUpdateEntities` (23040 of
  // its 58752) and `kleod:SetupBG3WindowOverlay` (128 of 952), and only the first carries a winning
  // label at all, the second being `noncompile`. (Re-derived at c30799cd; the counts this sentence
  // used to carry, 5760 of 17856 and 48 of 544, were measured before the fan grew — the TWO-row
  // reach held, every number did not, so re-run the census rather than quoting one.) So the REAL
  // tier's "0 winning labels" is 0 of ONE here, not 0 of 151 and not 0 of the artifact's row
  // count. That census enumerates 155 of the 252 real rows — the
  // 151 the artifact labels plus its 4 `noncompile` rows — and the 97 it cannot enumerate are
  // exactly the rows the artifact declines. What makes "no row is LOST" a proof rather than a
  // sample is the soundness rule instead: this axis only ADDS candidates, so a row whose winner
  // does not carry it cannot move when it is removed. The same census prices `/no-bitfield`: it
  // survives dedup on FIVE real rows — `ProcessInputAndUpdateEntities` 25344, `CountCollectedGems`
  // 192, `UpdateWorldMapNodeAnim` 168, `UpdateHUDCounterDisplay` 96, `CopyBGScrollTiles` 4 — every
  // one of them a row the artifact labels, and none of the five wins under it. So its map-wide
  // enumeration gate buys a candidate cross on 5 functions and the dedup collapses it everywhere
  // else.
  //
  // WHAT THE WINNING-LABEL CENSUS SAYS TODAY, and it is no longer zero for either arm: the
  // SYNTHETIC tier now carries rows that hand asmlift a map (`SynthSpec.symbols`), and both arms
  // win on one — `/no-bitfield` on `bfwordread` and `bfwordwrite`, `/no-ptr-elem` on `ptrelem`,
  // each a match at 0 that becomes a NONMATCH when its own arm is ablated. The "no winning label
  // carries it" sentences that used to stand here were written in the same change that shipped
  // those rows, and read against the artifact that change published they were already false. Both
  // counts and the reach census above are per-TIER and per-COMMIT: quote neither without saying
  // which tier it is over, and re-run it rather than carrying it forward.
  const byName = opts.symbols !== undefined ? symbolsByName(opts.symbols) : undefined;
  const fnHasSizedPtrFields =
    byName !== undefined &&
    [...bareGlobalSymbols(probe).keys()].some((n) => {
      const i = byName.get(n);
      return (
        i !== undefined &&
        [...(i.layout ?? []), ...(i.pointee?.layout ?? [])].some(
          (f) => isPtrField(f) && (f.pointeeSize === 1 || f.pointeeSize === 2 || f.pointeeSize === 4),
        )
      );
    });
  const ptrElemCands = fnHasSizedPtrFields
    ? [...bitfieldCands, ...bitfieldCands.map((s) => ({ ...s, suffix: `${s.suffix}/no-ptr-elem`, ptrElems: false }))]
    : bitfieldCands;
  // `/flat-rank` — spell a multidimensional global's access as the FLAT byte arithmetic
  // (`*(u16 *)((r << 11) + (i << 1) + (u32)&g)`) where the default recovers the map's declared
  // subscripts (`g[r][i]`). The recovery's evidence is a term at the declared ROW stride, and that
  // is evidence the residual carries a row — NOT evidence about which of the two spellings that
  // both produce it was written. Compiled (structure.ts `spellDeclaredSubscripts` carries the
  // table): the two differ only in where the pool load sits under agbcc, kmc and mwcc, and are
  // BYTE-IDENTICAL under IDO, which also distributes the flat sum into the same separate scales.
  // So the asm underdetermines it on every compiler measured, and the differ referees — the same
  // posture as `/no-ptr-elem` and `/no-bitfield`.
  //
  // THE GATE IS ASKED OF THIS FUNCTION, not of the map, for `/no-ptr-elem`'s reason: a declared
  // subscript is only ever recovered off a global the function NAMES, and every named global
  // reaches the IR as a `gaddr`. `arrayInnerExtents` is the recovery's own rank test, called here
  // rather than re-spelled, so the gate cannot be narrower than the rule it gates. It is still a
  // superset — it does not know the access WIDTH, and it cannot know whether any residual carries
  // a row term — so where the axis changes nothing the tree dedup below collapses the pair and the
  // fan does not grow. 9 of the 951 rows this was measured over name such a symbol at all — 8 of them in
  // their winning `symbolsUsed`, the ninth (`kleod:SetupBG3WindowOverlay`) in a source its row
  // cannot compile, which is why that count is taken off the emitted sources and not off
  // `symbolsUsed`, where a row with no winner is invisible.
  const fnNamesMultidimArray =
    byName !== undefined &&
    [...bareGlobalSymbols(probe).keys()].some((n) => {
      const i = byName.get(n);
      return i !== undefined && i.shape === 'array' && (arrayInnerExtents(i)?.length ?? 0) > 0;
    });
  const declRankCands = fnNamesMultidimArray
    ? [...ptrElemCands, ...ptrElemCands.map((s) => ({ ...s, suffix: `${s.suffix}/flat-rank`, declRank: false }))]
    : ptrElemCands;
  // The axis chain, derived from STRUCTURING_AXES: each admitted axis doubles the list, OFF arm
  // first — order is load-bearing for the dropped-primary skip below (every OFF sibling
  // enumerates before its ON twin, so a twin's stripped-key lookup always finds a sibling that
  // has already run or been condemned). Each per-axis rationale lives on its table entry; both
  // arms are always emitted and the differ referees, never a default — the dedup below collapses
  // a pair wherever the axis changed nothing.
  const probeDefs = defOpMap(probe);
  type AxisCand = (typeof ptrElemCands)[number] & Record<StructuringAxis['flag'], boolean>;
  let axisCands: AxisCand[] = declRankCands.map((s) => ({
    ...s,
    reread: false,
    inplace: false,
    mergeNames: false,
    addrHome: false,
    exprHome: false,
    derivedHome: false,
    mergeHome: false,
    unsCmp: false,
    freshMerge: false,
  }));
  for (const ax of STRUCTURING_AXES) {
    if (ax.probeGate === undefined || ax.probeGate(probe, probeDefs)) {
      axisCands = [
        ...axisCands,
        ...axisCands.map((s) => ({ ...s, suffix: `${s.suffix}${ax.suffix}`, [ax.flag]: true }) as AxisCand),
      ];
    }
  }

  const seen = new Map<string, Candidate>();
  const seenTrees = new Set<string>();
  /** the PRE-FAN products' own tree dedup — see the pre-fan loop for why it is not `seenTrees` */
  const seenPreFan = new Set<string>();
  const out: Candidate[] = [];
  // The map-derived VALUE references one emitted tree contains, applied at every point a candidate
  // is finalized and derived from the tree that candidate emitted. No pipeline stage carries refs
  // (SFn has no such field), so a future l3 pass that rewrites the tree can never leave a stale ref
  // behind: whatever tree reaches emit is the tree the refs describe, by construction. Collected
  // against the FULL name-keyed map for EVERY spelling variant — the '/raw-globals' sibling drops
  // the map's shaped SPELLINGS, but its tree still NAMES pool/reloc-derived globals (ARM
  // `.word gSym`, MIPS `%lo(gSym)`), and those references need declarations in the self-declared
  // scoring world exactly like the named variant's (without them every raw sibling fails to compile
  // there, and the eval-winning raw candidate becomes unreproducible outside project headers).
  // The volatility tie-break's input, derived at the same moment as the refs and for the same
  // reason: whatever tree reaches emit is the tree it describes. Absent on a target that declares
  // no device window, which is how every non-GBA target opts out.
  const volOf = (tree: SFn): { deviceVolatile?: number } => {
    const n = deviceVolatileClaims(tree, target.capabilities.deviceRegisters);
    return n > 0 ? { deviceVolatile: n } : {};
  };
  // Every refusal is reported at most once per (name, reason): `refsOf` runs per CANDIDATE over
  // the same probe-derived dictionary, so without this the caller would hear the same refusal
  // once per spelling in the fan (hundreds of times on a wide row).
  const refusalsSeen = new Set<string>();
  const refuse = (name: string, reason: RefusedDeclarationReason): void => {
    if (refusalsSeen.has(`${name}\u0000${reason}`)) {
      return;
    }
    refusalsSeen.add(`${name}\u0000${reason}`);
    opts.onRefusedDeclaration?.(name, reason);
  };
  // The names the tree spells are read out of the asm's own literal pool / relocations and
  // synthesized as name-only symbols (`bareGlobalSymbols`); where a symbol MAP knows a name, the
  // map's facts WIN. A UNION rather than an either/or: the per-CALL fallback it replaced
  // (`opts.symbols ?? bareGlobalSymbols(...)`) let ONE map entry switch the synthesis off for
  // every OTHER name in the function, so supplying more information made the tool strictly
  // worse. A union cannot — each name is declared by whichever half knows more about it.
  // SCOPE: `declSymbols` is used ONLY here. It must never reach `opts.symbols`/`baseOpts.symbols`
  // or `frontend.lift` — feeding it to the lift would turn on pool promotion, interior
  // attribution and the `/raw-globals` variant, which is a different (and source-moving) change.
  const mapSymbols = baseOpts.symbols;
  const declSymbols = new Map([...bareGlobalSymbols(probe), ...(mapSymbols ?? [])]);
  const refsOf = (tree: SFn): { symbolRefs?: SymbolRef[] } => {
    // The names THIS tree binds. Computed per tree because the emitter mints local names per
    // spelling — but the test below is NOT `bound` alone, and the difference is a wrong answer.
    const bound = new Set<string>([...tree.params.map((p) => p.name), ...tree.locals.map((l) => l.name)]);
    const refs = collectSymbolRefs(tree.body, declSymbols, tree.name, refuse).flatMap((r) => {
      // THE ONE REFUSAL THAT IS NOT A REFUSAL — a name the emitted C uses for its OWN storage
      // kills the SPELLING, because no declaration makes that candidate right and no declaration
      // makes it fail either. Two shapes, and the second is why the test is the emitter's whole
      // NAME GRAMMAR rather than this tree's bound set:
      //   READ — the tree binds `v0` and also spells `&v0` for the pool global. The local
      //     shadows the extern, so the candidate takes a stack address where the asm takes a
      //     relocated one. Withholding the declaration does not stop it compiling: its SIBLING
      //     names still get theirs, and the TU builds.
      //   WRITE — structure.ts drops a local whose name a WRITTEN global already claims
      //     (`localNames`, filtered by `globalNames`), so the collision is INVISIBLE in
      //     `tree.locals`: every use of the emitter's local binds the extern instead, and the
      //     loop pointer it was holding becomes a store to that global once per iteration.
      // Both compile, both are wrong, and a compiling wrong answer is the one outcome this
      // project trades nothing for — so the spelling dies here and `fanOut`'s catch reports it.
      // If every spelling of every tree dies, the row declines LOUDLY naming the collision.
      if (bound.has(r.name) || EMITTER_NAME.test(r.name)) {
        refuse(r.name, 'emitter-name');
        throw new Error(
          `cannot spell '${tree.name}': the target names a global '${r.name}', which is a name the ` +
            `emitted C uses for its own locals and parameters — no declaration can bind it`,
        );
      }
      // Applied to the UNION, not to the pool half on its way in: a map can supply `$LC0` or
      // `abort` as readily as a relocation can, and `extern u32 abort;` is the same hard error
      // whichever half it came from.
      if (!/^[A-Za-z_]\w*$/.test(r.name)) {
        refuse(r.name, 'not-an-identifier');
        return [];
      }
      if (DECL_RESERVED.has(r.name)) {
        refuse(r.name, 'reserved');
        return [];
      }
      // name-only symbols carry the IR-derived access facts — the width authority
      // for their synthesized declaration (shaped symbols keep the map's truth)
      const access = r.info.shape === undefined ? accessFacts.get(r.name) : undefined;
      // A ref no MAP accounts for is a hypothesis read out of the target asm, and it is marked
      // as one all the way to the consumer (SymbolRef.synthesized).
      const synthesized = mapSymbols?.has(r.name) ? {} : { synthesized: true as const };
      return [{ ...r, ...(access ? { access } : {}), ...synthesized }];
    });
    return refs.length ? { symbolRefs: refs } : {};
  };
  // THE RE-SPELLING FAN, as a function whose PARAMETER LIST is the invariant the tree skip below
  // rests on: every spelling here is a pure function of the structured tree and this call's own
  // constants, so a tree an earlier axis point already spelled can only re-emit sources `seen`
  // already holds. Inline in that loop the invariant would be a comment asking future levers not to
  // read `fn` or the axis flags; as a signature, a lever that needs one has to widen it in front of
  // a reviewer. The same argument l3/ast.ts's `walkExprs` header makes for its own shape, and it
  // counts for more here: a lever reading `fn` would not misprint a candidate, it would DELETE one,
  // and nothing in the harness reports a candidate that was never enumerated.
  // `leverLabel` names the SPELLING this call is fanning, and it is a diagnostic argument only: it
  // reaches `onLeverError` and nothing else, so the invariant the parameter list states above —
  // every spelling is a pure function of the tree and this call's own constants — is untouched by
  // it. It exists because the pre-fan products call this on a REWRITTEN tree, where a refusal of
  // the primary spelling is a refusal of the rewrite, not of the row's own spelling.
  //
  // IT PREFIXES EVERY `onLeverError` IN THIS FUNCTION, not just the primary emit's, and that is
  // the whole point rather than a detail: every one of them is reachable from both fans, and the
  // suffix each already carries names a LEVER, which on a pre-fan tree is a lever applied to the
  // rewrite. Reported without this prefix, a refusal of `/unmerge/volatile` reads as a refusal of
  // `/volatile` — a spelling that did not fail and is still in the fan. The order
  // is the candidate labels' own (`${pf.suffix}${sp.suffix}`), so a reported label and an
  // enumerated one name the same spelling the same way.
  const fanOut = (sfn: SFn, leverLabel = ''): Spelling[] => {
    // The walk→index re-spelling (l3/reindex.ts) is a THIRD lever on the same footing as
    // signedness and branch sense: whether the source spelled `*p; p++` or `arr[i]` is
    // genuinely ambiguous from asm (compilers strength-reduce the latter into the former), so
    // when a loop re-spells, BOTH representations are emitted and the differ referees. The
    // re-spelling passes the same boundary contracts as the primary; one that fails them is
    // dropped here — never scored, never able to win.
    const spellings: Spelling[] = [];
    // The PRIMARY spelling takes the same posture as every re-spelling below: a backend that
    // declines by throwing costs this tree — its primary and the re-spellings built from it —
    // never the row. The opposite posture from the STRUCTURING refusal below, which aborts the
    // row at the base point, and for the reason that separates them: that one says the lift is
    // broken, this one that the target language has no spelling for a tree the lift got right
    // (structuring is language-neutral, and the signedness pins it inserts are `cast` nodes the
    // Pascal backend loud-declines). Refusing EVERY tree is still loud — the empty-enumeration
    // check at the end raises the last refusal.
    try {
      spellings.push({ suffix: '', source: backend.emit(sfn), ...refsOf(sfn), ...volOf(sfn) });
    } catch (e) {
      lastEmitError = e;
      opts.onLeverError?.(name + leverLabel, e instanceof Error ? e.message.split('\n')[0] : String(e));
      return spellings;
    }
    // Representation re-spellings — each a lever on the same footing as signedness/branch sense,
    // each guarded: it must pass the same boundary contracts as the primary AND emit (a backend
    // that declines by throwing — Pascal loud-fails unspellable shapes — drops the candidate,
    // never aborts the enumeration). A dropped re-spelling loses nothing: the primary remains.
    //
    // POLICY: re-spellings derive from the BASE spelling only — levers do not compose by
    // default. FOUR product mechanisms are sanctioned, each with its own admission bar — the
    // three below, which all derive from or compose onto a spelling, plus the PRE-FAN products
    // (PRE_FAN_PRODUCTS, applied to the TREE before this fan runs over it; its admission bar is
    // stated at the table) —
    // plus ALTERNATIVE OUTPUTS: one lever whose single application has several legitimate
    // results (which locals a coalesce merges, which pointers /volatile qualifies) emits
    // each as its own candidate via `enumerate`, capped at the lever, with the base spelling
    // retained; outputs may also ride an already-sanctioned product (the /livebase/volatile
    // subsets), since they add no new lever to the composition.
    // Products with /volatile go only onto a lever whose re-spelling CENTRES ON a
    // numeric-address pointer local — the joint spelling is reachable from neither lever
    // alone, each product narrows /volatile to the lever's own locals (volatilePtrLocals'
    // `only`), and each needed a row to demand it. The SHAPE products (SHAPE_PRODUCTS) are
    // derived onto EVERY spelling: statement order/shape is orthogonal to what any
    // representation lever changes — the same kind of independent dimension as signedness —
    // so they compose as an axis rather than a pairing; a third blanket product needs the
    // same argument, not just a row. And a specific LEVER PAIRING is admitted on one of two
    // grounds, never on "it might help". FIRST, a row demands the joint spelling AND that
    // spelling is reachable from neither lever alone: /livebase × /indexed, × /sinkinit,
    // × /nearbase and × /coalesce, plus /vol-store × /unreduce and that pair × /ptr-field —
    // each with its demanding row at the respell site. (A TRIPLE is admitted on the same ground
    // and no weaker one: it is one joint spelling with one demanding row, and the pairs BELOW it
    // are not thereby admitted — on synthetic:dmaptrsrc the two intermediate pairs measure 27 and
    // 32 against the triple's 0, and neither is in the fan.) SECOND, a
    // lever COMMITS a policy the differ would otherwise never see — /nearbase × /sinkinit,
    // where `l3/nearbase.ts` picks one of two init orderings inside the pass, so without the
    // pairing that choice decides a match with no candidate beside it to lose to. The second
    // ground is narrower than it looks: it needs a committed choice INSIDE a lever with an
    // existing lever that expresses the alternative, not a lever one could imagine wanting
    // twice. Anything else stays un-composed. A pairing is admitted for a LEVER, so it fans
    // over that lever's whole admission table (LIVEBASE_ADMISSIONS): a roster row changes
    // which bases the same hoist binds, not what pairing it with /coalesce means.
    // And a lever must PRESERVE SEMANTICS by construction: the differ referees byte-exactness
    // (a wrong candidate can never fake a score-0 match), but on a NONMATCH row the best-
    // scoring source is shown to the user — a semantically-wrong re-spelling there is
    // plausible-but-wrong output, the defect class this project exists to avoid. THE ONE
    // EXCEPTION IS THE SAME RULE READ FORWARD: where a lever cannot establish its semantics from
    // inside the pass — `l3/unreduce.ts` moving a read into a loop whose device stores may make
    // the DEVICE write memory — the spelling is marked `Candidate.matchOnly` and published ONLY
    // at a byte-exact score, which is the clause in brackets above used as a licence instead of a
    // consolation. It is never shown as a best-effort answer, so the nonmatch case the sentence
    // is about cannot arise. Hence each
    // lever's decline-over-approximate gates, adversarially audited.
    // Takes a THUNK, so the lever's own computation is inside the try too. A lever that threw
    // from the pass itself — rather than from the contracts or the backend — would escape and
    // abort the whole enumeration for this row, primary included: the one way a lever can cost
    // a match. Making that structural rather than per-call-site means no lever can opt out.
    //
    // WHICH boundary contracts run here, and why it is three of the four. A lever gets the
    // tree `structureChecked` already validated, so what these re-check is what a LEVER can
    // break, not what structuring can. `assertResolved` and `assertDerefsTyped` catch an
    // unspellable tree — a candidate the compiler would reject, which the harness would report
    // as a dropped spelling with no cause. `assertLocalsWritten` catches the one wrongness the
    // differ REWARDS: a pass that moves or suppresses an assignment and never emits it leaves
    // the reads standing over whatever the allocator left behind, and that candidate compiles,
    // scores, and can win (the shape #106 shipped). Levers that place a def — l3/sinkinit.ts,
    // l3/basecse.ts's first-use policy, l3/nearbase.ts, l3/scopebase.ts, l3/argbase.ts — are
    // exactly the population that can produce it, so the check belongs on every lever tree
    // rather than on theirs. It costs nothing today: 0 violations over the 34357 trees the
    // artifact's 325 agbcc rows enumerate in both symbol-map configurations.
    // `assertEffectsPreserved` is the fourth and is NOT here: it needs the L1 `fn`, and
    // `fanOut`'s parameter list is the invariant the tree-dedup skip rests on (see its header).
    // Widening it for a contract is a defensible change and an argued one — not a silent import.
    // A lever returns its tree, or `{ sfn, needsProof }` when it cannot establish its own
    // semantics from inside the pass (Candidate.matchOnly carries the argument).
    const respell = (suffix: string, make: () => LeverResult): void => {
      try {
        const made = make();
        if (!made) {
          return; // the lever declined to fire — no candidate, not a duplicate of the primary
        }
        const alt = 'sfn' in made ? made.sfn : made;
        const proof: { matchOnly?: true } = 'sfn' in made && made.needsProof ? { matchOnly: true } : {};
        assertResolved(alt);
        assertDerefsTyped(alt);
        assertLocalsWritten(alt);
        spellings.push({ suffix, source: backend.emit(alt), ...refsOf(alt), ...volOf(alt), ...proof });
        // STATEMENT-SHAPE products, derived onto EVERY spelling — the second sanctioned
        // product mechanism (the POLICY note above carries the admission argument). Each is
        // a statement-order/shape fact orthogonal to representation; subsets compose in the
        // fixed order below. A shape that never fires declines and costs nothing.
        if (!SHAPE_PRODUCTS.some(({ suffix: sx }) => suffix.includes(sx))) {
          // A shape REORDERS statements, and it is derived after a lever has placed its defs — so
          // the placement is re-checked on the shaped tree (contracts.ts). Differential: judged
          // only where the unshaped tree already satisfied the walk, so a lever whose placement it
          // never described is not dropped on the strength of a model that does not apply.
          //
          // `minted` is a NAME DIFF, so for a RENAMING lever (`/regspell`, `/merge-names`) it also
          // holds locals the lever never PLACED. Harmless and deliberate: the differential's
          // early return absorbs a name the unshaped tree already fails on, and a renamed local
          // whose def a shape moved below a read is the same wrongness as a placed one.
          const minted = createdLocals(sfn, alt);
          for (const subset of SHAPE_SUBSETS) {
            // ONE TRY PER SHAPE — a shape is its own candidate and fails as its own candidate.
            // Sharing the lever's outer try would let a throw deriving one subset discard every
            // later one, under a label (the base lever's suffix) that names no shape at all.
            const shapeSuffix = subset.map((x) => x.suffix).join('');
            try {
              const shaped = applyShapes(subset, alt);
              if (shaped !== null) {
                assertResolved(shaped.out);
                assertDerefsTyped(shaped.out);
                assertLocalsWritten(shaped.out);
                assertPlacementSurvives(alt, shaped.out, minted);
                spellings.push({
                  suffix: `${suffix}${shaped.suffix}`,
                  source: backend.emit(shaped.out),
                  ...refsOf(shaped.out),
                  ...volOf(shaped.out),
                  // a shape derived from a proof-gated spelling inherits the requirement
                  ...proof,
                });
              }
            } catch (e) {
              opts.onLeverError?.(
                name + leverLabel + suffix + shapeSuffix,
                e instanceof Error ? e.message.split('\n')[0] : String(e),
              );
            }
          }
        }
      } catch (e) {
        // A throwing lever, a contract failure, or an unspellable re-spelling: keep the primary.
        // REPORTED, not swallowed. `dropped` (below) records only spellings the SCORER refused,
        // so without this a lever that fails here vanishes with no trace — indistinguishable
        // from one that correctly declined, which is exactly the hidden failure
        // DroppedCandidate exists to surface.
        opts.onLeverError?.(name + leverLabel + suffix, e instanceof Error ? e.message.split('\n')[0] : String(e));
      }
    };
    // `/argbase` — name a call's argument bases before the call (l3/argbase.ts). A lever on the
    // same footing as the others: the primary inline spelling stays in the list, so the differ
    // referees and this can never cost a match.
    for (const subset of SHAPE_SUBSETS) {
      // the truthful suffix needs the pass to RUN first, so this bypasses respell's
      // label-then-thunk shape: same try posture, label from the fired members
      try {
        const shaped = applyShapes(subset, sfn);
        if (shaped !== null) {
          respell(shaped.suffix, () => shaped.out);
        }
      } catch (e) {
        // the error label falls back to the full subset — the fired set is unknown mid-throw
        const label = subset.map((x) => x.suffix).join('');
        opts.onLeverError?.(name + leverLabel + label, e instanceof Error ? e.message.split('\n')[0] : String(e));
      }
    }
    respell('/argbase', () => materializeArgBases(sfn));
    // `/zerosub` — spell a negate of a SHARED subtraction as `0 - x` (l3/zerosub.ts). gcc 2.9
    // folds `-(a - b)` into `(b - a)` before CSE but leaves `0 - (a - b)` as a negate of the
    // subtraction itself, so over a value the function also uses elsewhere the two spellings are
    // a computation and a register apart — and both are reachable from a real source. The differ
    // referees; its gate keeps it off every shape where the fold rule does not apply, which is
    // every operand but a shared subtraction.
    respell('/zerosub', () => zeroSubNegates(sfn));
    // `/volatile` — declare a pointer local holding a NUMERIC address as pointing to volatile
    // data (l3/volatileptr.ts). A raw constant has no declaration anywhere, so the original
    // qualifier is not derivable — and it is codegen-visible (a volatile MEM is barred from
    // motion, which lands the allocator on different homes). Both spellings are emitted and
    // the differ referees.
    respell('/volatile', () => volatilePtrLocals(sfn));
    // `/vol-slot` — declare a STACK-HOMED scalar local volatile (l3/volatileval.ts). The
    // qualifier takes away the allocator's freedom to keep the value in a callee-saved
    // register across a call, and which of the three ways a slot can arise (a volatile local,
    // an address-taken one, plain register pressure) the source used is not derivable from
    // the asm. A DECLARATION lever, not a structuring axis (docs/level-tower.md's third
    // fork): it changes nothing structure() decides, so it rides the base spelling like its
    // `/volatile` sibling rather than doubling every enumeration, and its frame-flag gate
    // costs nothing on a function with no slot.
    respell('/vol-slot', () => volatileValueLocals(sfn));
    // `/vol-store` — pin a store at a fixed DEVICE-REGISTER address `volatile` (l3/volstore.ts).
    // Where `/volatile` above qualifies a pointer LOCAL holding the address, this qualifies the
    // access itself, which is the spelling a `REG_*` macro produces and the one structure.ts
    // leaves when the address re-materializes at each use. Codegen-visible: agbcc's `load_mems`
    // hoists an unpinned fixed-address store clean out of a loop (gcc/loop.c:8934), so the pinned
    // spelling is the only one that reproduces a device-driving loop body at all. Its window gate
    // is the target's own `deviceRegisters` range, which is what keeps it off ordinary memory.
    respell('/vol-store', () => volatileDeviceStores(sfn, target.capabilities.deviceRegisters));
    /** `/unreduce` with both halves of the device model handed over — the SPELLING range and the
     *  MEMORY-MODEL trigger list (target.ts). Written once because three call sites take it. */
    const unreduced = (from: SFn): UnreduceResult | null =>
      unreduceAccumulators(from, target.capabilities.deviceRegisters, target.capabilities.deviceMemoryWriters);
    // `/unreduce` — delete a loop-carried accumulator and spell each read as its closed form
    // (l3/unreduce.ts). Strength reduction is a compiler pass, so the accumulated form is what the
    // asm shows whichever form the source had; the un-reduced form is the other pre-image, and it
    // reaches a preheader slot no C statement can (a compiler-created giv init is inserted after
    // the invariant hoist, gcc/loop.c:1151 then :1173). The scalar-value sibling of `/indexed`,
    // which makes the same argument for a pointer walk.
    respell('/unreduce', () => unreduced(sfn));
    // `/ptr-field` — declare a recovered WORD field a pointer (l3/ptrfield.ts). raise/structs.ts
    // types a field from the access width alone, and on a 32-bit target `void *` fits that
    // evidence exactly — but not the compiler's alias analysis, which is what lets a pointer
    // field's load leave a loop an `s32` store pins it inside. Both are enumerated.
    respell('/ptr-field', () => pointerFields(sfn));
    // `/offmember` — spell a leaf base's constant subscript as a struct MEMBER (l3/offmember.ts),
    // so the offset stays in the load's displacement instead of folding into the pool literal.
    // The SECOND source of the shape `/basefold` already reads: that row answers the same
    // evidence with a named base, this one with an aggregate member, and the two are different C
    // and different register pressure. Offered only where the target declares the fold — MIPS and
    // PPC put the addend in the instruction by construction, so nothing there says a member put
    // it there, exactly as with BASEFOLD_ADMISSIONS above.
    if (target.compilerBehaviors.foldsConstAddrOffset) {
      respell('/offmember', () => spellOperandMembers(sfn));
    }
    // The `/vol-store` × `/unreduce` PAIRING — row-demanded (synthetic:dmafill), and the joint
    // spelling is reachable from neither lever alone: pinning the stores keeps three of them in
    // the loop body, which is what makes the loop's register pressure — and so the placement of
    // the induction init — observable at all. Alone the two score 19 and 34 against the row's own
    // 30; together, 0. The TRIPLE adds `/ptr-field` for synthetic:dmaptrsrc, whose closed form
    // reads a struct field the un-reduce puts back inside the loop: 27 · 35 · 42 alone, 0
    // together. The intermediate pairs are not admitted, and the reason is that NO ROW DEMANDS
    // ONE — neither could win where they are reachable: compiled on synthetic:dmaptrsrc, VT TIES
    // `/vol-store`'s 27 and RT LOSES to it at 32. (An earlier version of this note said "each
    // scores worse than a lever already on the roster", which is loose twice over: VT ties rather
    // than loses, and RT's 32 beats the ADMITTED standalone `/unreduce`'s 35. Ranking the pairs
    // against the BEST already-admitted spelling is the comparison that holds.)
    //
    // WHAT THE STANDALONE LINES COST, since neither of the two levers ever wins one of the 894
    // artifact rows alone — `/unreduce` appears in 2 winners and `/ptr-field` in 1, all three
    // inside a pairing. They are kept because a lever has to be able to LOSE on its own terms: the
    // admission posture (compareScored orders by score) is what makes a wrong re-spelling
    // harmless, and it is only observable when the single-lever spelling is in the fan —
    // `synthetic:dmastride` exists to show exactly that for `/unreduce`, at 33 against its match.
    //
    // AND THE SUBSET APPLIER IS NOT THE RIGHT MECHANISM HERE, though it looks like it: rebuilding
    // this as a SHAPE_SUBSETS-style table would admit VT and RT by construction, because
    // `applyShapes` is SKIP-ON-DECLINE and would emit "everything that fired" on any tree where
    // one of the three declines. That is the property the shape products are designed around and
    // the one the pairing policy forbids — a pair reaches the fan only when a row demands it.
    //
    // Both compose through `composeLevers`, which carries `/unreduce`'s proof obligation across
    // the stages after it — hand-writing that carry made dropping it a type-correct edit.
    const volStore = (s: SFn): SFn | null => volatileDeviceStores(s, target.capabilities.deviceRegisters);
    respell('/vol-store/unreduce', () => composeLevers(sfn, [volStore, unreduced]));
    respell('/vol-store/unreduce/ptr-field', () => composeLevers(sfn, [volStore, unreduced, pointerFields]));
    // `/inlinebase` — spell a CONSTANT-address pointer local at its uses instead
    // (l3/inlinebase.ts). The local is structure/analysis.ts's value home for a `const` the
    // asm kept in a callee-saved register across a call; the register is real, but a constant
    // re-spelled per use is CSEd back into that same one, so which the source had is not
    // derivable. Its own bare-`const`-initializer gate keeps it off l3/basecse.ts's reuse
    // hoists, whose placement levers already answer that question.
    //
    // TWO ALTERNATIVE OUTPUTS, not a product: deleting the local also deletes the only place
    // a `volatile` POINTEE could be written, and a raw address has no declaration anywhere
    // else to carry it. So the qualified spelling is emitted too, `/volatile` narrowed to
    // exactly the locals this lever deletes. Usually the bytes separate them and the score
    // decides (11 against 12 on pokeemerald:EReader_Reset), but where the compiler was not
    // exploiting the non-volatility they are byte-identical — as they are on that row's
    // WINNING shape, the one that also qualifies the slot — and `compareScored`'s device-
    // volatility term picks the qualified twin, 0x4000208 being REG_IME.
    //
    // COST — it fires broadly: on 33 of the 69 klonoa functions that lift with no symbol map
    // (a symbol-map sweep sees fewer, since an absolute pool constant lifts to a `gaddr`
    // there). Both outputs together add 766 candidates over 47058, +1.6%, and up to +67% on
    // one function (EntityPositionFromLevelTable) — the same class of price the enumeration
    // already pays for `/volatile`, and cheaper than the axis over the same question would
    // be — the choice the lever's header argues. `/vol-slot` adds nothing at all there: no
    // klonoa function reaches its frame gate.
    const inlineVolatile = (): SFn | null => {
      const only = new Set(inlinableConstBases(sfn));
      const q = only.size ? volatilePtrLocals(sfn, only) : null;
      return q ? inlineConstBases(q) : null;
    };
    respell('/inlinebase/volatile', inlineVolatile);
    respell('/inlinebase', () => inlineConstBases(sfn));
    // The `/inlinebase` × `/vol-slot` PAIRING — row-demanded, and the joint spelling is
    // reachable from neither lever alone: on pokeemerald:EReader_Reset the primary scores 11,
    // `/inlinebase` alone 11 and `/vol-slot` alone 2, and the pair 0. The two touch disjoint
    // locals (one pointer-typed, one a scalar frame slot), so applying them in either order
    // gives the same spelling — and each of `/inlinebase`'s two outputs carries it.
    respell('/inlinebase/volatile/vol-slot', () => {
      const r = inlineVolatile();
      return r ? volatileValueLocals(r) : null;
    });
    respell('/inlinebase/vol-slot', () => {
      const r = inlineConstBases(sfn);
      return r ? volatileValueLocals(r) : null;
    });
    // `/scopebase` — name a reused global base at the INNERMOST scope holding its uses
    // (l3/scopebase.ts). Distinct from basecse's function-top hoist, which the primary already
    // carries: this one fires exactly where that placement would extend a live range the
    // original never had.
    // `/scopebase`, and its COALESCED variants. Which locals a register allocator shared is not
    // derivable from the tree — on the row this was built for the two legal merges score 18 and
    // 40 against a no-merge 21, so committing to one by declaration order costs 19 points and
    // discards the winner. Every variant is emitted and the differ referees, exactly as
    // `/regcopy` does for its allocator-ambiguous tail choice.
    //
    // POLICY NOTE: rank.ts's rule is that re-spellings derive from the BASE spelling only —
    // levers do not compose. These are not a second lever composed onto the first: coalescing is
    // enumerated as alternative OUTPUTS of the base hoist, in the one place that knows the hoist
    // just happened. The un-coalesced `/scopebase` stays in the list, so nothing is lost.
    //
    // EVERY pass invocation stays INSIDE a thunk — see the paragraph above on why a pass that
    // runs outside `respell`'s try is the one way a lever can cost a match. `enumerate` re-runs
    // the hoist per candidate, which is pure and cheap, rather than caching it outside the guard.
    respell('/scopebase', () => hoistScopedBases(sfn));
    // `/regionbase` — the same pass under its second region rule: a base the source spells inside N
    // disjoint regions becomes N locals, one per region, rather than one at function scope. A LEVER
    // beside `/scopebase`, not a replacement for it: both spellings and the un-hoisted primary stay
    // in the list, so the differ settles which allocation the original had.
    const regionbase = (): SFn | null => hoistScopedBases(sfn, { regions: 'per-region' });
    respell('/regionbase', regionbase);
    // …and its `/volatile` PRODUCT, narrowed to exactly the locals this lever mints — the same
    // pairing `/livebase` and `/inlinebase` already carry, for the same reason. The shape this
    // lever exists for is a DEVICE base (the DMA block at 0x040000D4), and the project's own
    // reference spells it `vu32 *dmaRegs`; without the product every region local this lever wins
    // with is published UNqualified, and `compareScored`'s `deviceVolatile` term — which prefers
    // the qualified twin on a tie — never sees a qualified twin to prefer. It is a candidate like
    // any other where the qualifier costs bytes, and the differ referees.
    const regionVolatile = (): SFn | null => {
      const r = regionbase();
      return r ? volatilePtrLocals(r, createdLocals(sfn, r)) : null;
    };
    respell('/regionbase/volatile', regionVolatile);
    // …and the `/vol-store` triple, the pairing this lever is the first to inhabit (see
    // l3/volstore.ts, where the two qualifiers' reach over a tree's OWN locals is disjoint).
    // `/volatile` qualifies a pointer LOCAL and `/vol-store` a STORE SITE, and this lever leaves
    // both in one function: it homes the regions holding two or more direct uses and leaves every
    // other spelling of the same device address inline. On `synthetic:dmascope` that residue is
    // the write to REG_DMA0CNT that STARTS the transfer, and without the triple it is published
    // bare beside three `volatile s32 *` region locals.
    respell('/regionbase/volatile/vol-store', () => {
      const v = regionVolatile();
      return v ? volStore(v) : null;
    });
    const enumerate = (
      label: string,
      from: () => SFn | null | undefined,
      variantsOf: (s: SFn) => { merged: string; sfn: SFn }[] = coalesceCandidates,
    ): void => {
      let variants: { merged: string; sfn: SFn }[] = [];
      try {
        const base = from();
        variants = base ? variantsOf(base) : [];
      } catch (e) {
        opts.onLeverError?.(name + leverLabel + label, e instanceof Error ? e.message.split('\n')[0] : String(e));
        return;
      }
      for (const c of variants) {
        respell(`${label}-${c.merged}`, () => c.sfn);
      }
    };
    enumerate('/scopebase-coalesce', () => hoistScopedBases(sfn));
    enumerate('/coalesce', () => sfn);
    // `/volatile`'s per-local SUBSETS: which pointers the source declared volatile is
    // per-pointer knowledge (an MMIO block and a plain RAM table sit side by side, and
    // qualifying the table blocks the read collapse its region wants), so each proper
    // non-empty subset is its own candidate — the same alternative-OUTPUTS mechanism as the
    // coalesce merges, not a product (l3/volatileptr.ts volatileSubsetCandidates carries the
    // ≤3 cap). The all-qualifiers form is plain `/volatile` above; the livebase product's
    // subsets ride below with the product's own `only` scope.
    enumerate(
      '/volatile',
      () => sfn,
      (s) => volatileSubsetCandidates(s),
    );
    respell('/indexed', () => reindexWalks(sfn));
    respell('/indexed/volatile', () => {
      const kept = new Set<string>();
      const r = reindexWalks(sfn, kept);
      return r ? volatilePtrLocals(r, kept) : null;
    });
    // `/livebase` — hoist a reused leaf base the default basecse pass REFUSED (l3/basecse.ts,
    // LIVEBASE_GATES): its `loop` and `repeated-const-offset` rules predict re-materialization,
    // and an MMIO poll (store then re-read the same fixed offset while it spins) is the shape
    // where the prediction is wrong — the compiler holds ONE base register across stores, the
    // loop, and the read-back. The primary already carries every base those rules admit, so a
    // hoist-nothing result means the lever has nothing to add and declines.
    // One family per admission row; a row binding exactly what an earlier row bound is the same
    // spelling under a different label, so it declines for that too. `/basefold` joins the roster
    // where the target declares the fold.
    const admissions: readonly BaseAdmission[] = target.compilerBehaviors.foldsConstAddrOffset
      ? [...LIVEBASE_ADMISSIONS, ...BASEFOLD_ADMISSIONS]
      : LIVEBASE_ADMISSIONS;
    // The CENSUS is a pure function of (this tree, that table) and every row asks for every
    // earlier row's, from thunks each product re-invokes — quadratic in the roster, times the
    // number of products. Memoized on the gate table's identity. The value is a list of key
    // STRINGS whose two readers here only compare and count it, so a memo hit shares no tree.
    const censuses = new Map<readonly Gate<BaseKey>[], readonly string[]>();
    const census = (g: readonly Gate<BaseKey>[]): readonly string[] => {
      const hit = censuses.get(g);
      if (hit) {
        return hit;
      }
      const v = admittedBases(sfn, g);
      censuses.set(g, v);
      return v;
    };
    const livebases = admissions.map(({ suffix, gates, placement, pairings }, i) => {
      const hoist = (): SFn | null => {
        const bound = census(gates);
        if (bound.length === 0) {
          return null;
        }
        // Same bases in the same POSITION is the same spelling under a second label; the same
        // bases somewhere else is not, so an earlier row only shadows this one at its placement.
        const shadowed = admissions
          .slice(0, i)
          .some((a) => a.placement === placement && sameBases(bound, census(a.gates)));
        return shadowed ? null : hoistBaseLocals(sfn, gates, placement);
      };
      const volatiles = (): SFn | null => {
        const r = hoist();
        return r ? volatilePtrLocals(r, createdLocals(sfn, r)) : null;
      };
      return { suffix, hoist, volatiles, pairings, gates, placement };
    });
    // THE PLACEMENT DIFFERENTIAL, one composition inwards. `respell` re-checks a lever's
    // placement across the statement SHAPES derived onto it; the lever-on-lever products below
    // are the same hazard in the same file and are outside it, because the composition happens
    // INSIDE one `make()` thunk and the intermediate tree never reaches `respell`'s check. A
    // def-MOVING pass (`sinkInitsToFirstUse`, `nearBaseClusters`, `reindexWalks`) running on a
    // tree a PLACING lever built can move a def below a use exactly as a shape can. Same
    // differential, so a placement neither pass can model is not judged either way, and the throw
    // lands inside the thunk — a reported, dropped candidate.
    //
    // BOTH SIDES' minted locals, because the mover MINTS TOO: `nearBaseClusters` creates the
    // cluster base it then places, and `reindexWalks` creates the induction variable, so the
    // outer lever's name diff alone is empty for a standalone mover and a strict subset for a
    // composition — the mover's own stranding of its own local walks straight through. Judging a
    // name the BEFORE tree does not carry keeps the differential honest rather than turning it
    // absolute: a name absent from `before` is never read there, so that walk passes and only the
    // `after` placement is judged.
    const survives = (before: SFn | null, after: SFn | null): SFn | null => {
      if (before !== null && after !== null) {
        assertPlacementSurvives(before, after, new Set([...createdLocals(sfn, before), ...createdLocals(sfn, after)]));
      }
      return after;
    };
    // Every product below fans over the rows a demanding row earned, never the whole roster.
    const paired = livebases.filter((l) => l.pairings);
    for (const { suffix, hoist, volatiles } of livebases) {
      respell(suffix, hoist);
      respell(`${suffix}/volatile`, volatiles);
      enumerate(`${suffix}/volatile`, hoist, (r) => volatileSubsetCandidates(r, createdLocals(sfn, r)));
    }
    // The livebase × indexed PAIRINGS — the third sanctioned product kind (see POLICY):
    // row-demanded, and the joint spelling is reachable from neither lever alone (the
    // frame-copy + DMA shape).
    for (const { suffix, hoist, volatiles } of paired) {
      respell(`${suffix}/indexed`, () => {
        const r = hoist();
        return r ? survives(r, reindexWalks(r)) : null;
      });
      respell(`${suffix}/volatile/indexed`, () => {
        const r = volatiles();
        return r ? survives(r, reindexWalks(r)) : null;
      });
    }
    // The livebase × sinkinit PAIRINGS — the same admission again: row-demanded
    // (kleod:DecompressDma), and the joint spelling is reachable from neither lever alone. The
    // bases whose placement moves the row are the ones only this lever's ablation binds, and
    // `/sinkinit` alone reads the DEFAULT hoist's head, which does not carry them.
    for (const { suffix, hoist, volatiles } of paired) {
      respell(`${suffix}/sinkinit`, () => {
        const r = hoist();
        return r ? survives(r, sinkInitsToFirstUse(r)) : null;
      });
      respell(`${suffix}/volatile/sinkinit`, () => {
        const r = volatiles();
        return r ? survives(r, sinkInitsToFirstUse(r)) : null;
      });
    }
    // The livebase x homesplit PAIRINGS — the fourth sanctioned product kind, and row-demanded
    // (synthetic:dmapoll): ONE base kept at the head and a SECOND split per region, which neither
    // lever spells alone because each applies its own policy to every base it binds. Compiled
    // against that row's own object the reachable cells are 69 with neither hoist, 18 with both
    // split per region, 11 with both at function scope — and 0 only where the two policies land on
    // DIFFERENT bases. See l3/homesplit.ts for why it is a PIPE and never a merge.
    //
    // WHICH key is withheld is not derivable, so every admitted key is its own candidate, LABELLED
    // with that key — a label is an identity, and one label over two withholds names two programs.
    // `HOMESPLIT_FAN_GATES`' `homesplit-fan-cap` is what bounds the product.
    // ADDITIVE, like every lever here: `/livebase-block`, `/regionbase`, `/scopebase` and the
    // un-hoisted primary all stay in the list, which is what keeps `synthetic:dmaflat` — where the
    // composed spelling scores 13 against its own 0 — at MATCH.
    for (const [i, { suffix, gates, placement }] of paired.entries()) {
      const bound = census(gates);
      // The ROSTER's dedup, which `hoist` applies to every other product and this loop has to spell
      // for itself: a row binding exactly what an earlier row bound at the same placement is that
      // row's spelling under a second label, and so is every pairing piped from it. Asked over the
      // PAIRED rows only, so a skip can never drop a withhold no other row enumerates — the earlier
      // row runs the identical pipe and emits the identical source. Without it both run and `seen`
      // collapses the pair afterwards, having paid a head hoist, region plan, rewrite and emit for
      // each.
      if (paired.slice(0, i).some((p) => p.placement === placement && sameBases(bound, census(p.gates)))) {
        continue;
      }
      // The function-level half of the pairing's admission, asked ONCE over the census: both its
      // rules read the key count and nothing else, so inside the pipe they would cost that whole
      // pipe to report a fact this loop already holds.
      for (const key of homeSplitWithholds(bound)) {
        const lever = `${suffix}/homesplit-${homeSplitTag(key)}`;
        const homesplit = (): SFn | null => {
          const p = splitHomeBases(sfn, {
            gates,
            placement,
            key,
            ...(target.capabilities.deviceRegisters ? { deviceRegisters: target.capabilities.deviceRegisters } : {}),
          });
          return p ? survives(p.homed, p.split) : null;
        };
        const homesplitVolatile = (): SFn | null => {
          const r = homesplit();
          return r ? volatilePtrLocals(r, createdLocals(sfn, r)) : null;
        };
        respell(lever, homesplit);
        respell(`${lever}/volatile`, homesplitVolatile);
        respell(`${lever}/volatile/vol-store`, () => {
          const v = homesplitVolatile();
          return v ? volStore(v) : null;
        });
      }
    }
    // `/mulfirst` — product-first commutative sums (l3/mulfirst.ts): IDO/mwcc schedule the
    // independent operand's load above the product's mflo/mullw, so def order re-spells a
    // product-first source as load-first. Both orders are emitted; the differ referees.
    respell('/mulfirst', () => mulFirstSums(sfn));
    // `/nearbase` — neighbor absolute addresses derive from one shared base local
    // (l3/nearbase.ts): one object's cells anchored as separate pool constants re-spell as
    // offsets off its lowest address, within the target's declared derivation reach. Both
    // spellings are emitted; the differ referees.
    const nearSpan = target.compilerBehaviors.nearBaseSpan;
    const near = (base: SFn | null): SFn | null =>
      base !== null && nearSpan !== undefined ? survives(base, nearBaseClusters(base, nearSpan)) : null;
    // …and WHERE its cluster inits sit, which is a second question with its own answer.
    // `l3/nearbase.ts` places them above the run already there, and that is a committed choice
    // made on one row (`synthetic:dmafield`) rather than on a compiler fact — a cluster base is
    // reached at 2+ addresses by construction, so "first touched late" says nothing about it, and
    // which order the source wrote is per-function knowledge the asm does not carry. With no
    // second candidate that choice decides a MATCH rather than a candidate, which is the whole
    // reason this row is here. `/sinkinit` here is the same transform it is everywhere else — each leading base init at its own first use — applied to a run whose order
    // `prepend` chose, so where first use does not separate two inits the cluster base still leads
    // (that tie is the one thing this is NOT identical to `placeBaseLocals(…, 'first-use')` on;
    // pinned in test/sinkinit.test.ts). Priced over the corpus at 590 candidate sources on 15 of
    // 1140 observations — where the two orderings agree the sink declines and nothing is added.
    const nearSunk = (base: SFn | null): SFn | null => {
      const r = near(base);
      return r ? survives(r, sinkInitsToFirstUse(r)) : null;
    };
    respell('/nearbase', () => near(sfn));
    respell('/nearbase/sinkinit', () => nearSunk(sfn));
    // The livebase × nearbase PAIRINGS — the same admission as livebase × indexed above:
    // the volatile triple is the row-demanded one, and the joint spelling is reachable from
    // neither lever alone (a neighbor-cell object and a multi-index MMIO block in one
    // function — each lever's constants are invisible to the other's model); the plain
    // sibling rides for symmetry with /livebase/indexed.
    for (const { suffix, hoist, volatiles } of paired) {
      respell(`${suffix}/nearbase`, () => near(hoist()));
      respell(`${suffix}/volatile/nearbase`, () => near(volatiles()));
      respell(`${suffix}/nearbase/sinkinit`, () => nearSunk(hoist()));
      respell(`${suffix}/volatile/nearbase/sinkinit`, () => nearSunk(volatiles()));
    }
    // The livebase × coalesce PAIRINGS — same admission again: the volatile triple is the
    // row-demanded one, the joint spelling reachable from neither lever alone (an MMIO base
    // worth homing and a counter shared across both arms of one if, in one function); the
    // plain sibling rides for symmetry.
    // ARM-DISJOINT merges only: the demanding row's shared counter is that class, and the
    // span-model merges already ride the plain /coalesce label — pairing them too would
    // multiply candidates with no row behind it.
    for (const { suffix, hoist, volatiles } of paired) {
      enumerate(`${suffix}/coalesce`, hoist, armDisjointCandidates);
      enumerate(`${suffix}/volatile/coalesce`, volatiles, armDisjointCandidates);
    }
    // `/parkfirst` — incoming-argument parks lead the entry prefix (l3/parkfirst.ts): the
    // park's `mov` lifts to pure SSA aliasing, so its position is unrecoverable and the
    // default order is emission's. Both orders are emitted; the differ referees.
    respell('/parkfirst', () => parkParamsFirst(sfn));
    // `/sinkinit` — each leading pointer-base init sinks to its own first use (l3/sinkinit.ts):
    // the base hoist places every init at the head of the body, which keeps the base live across
    // everything above its first use and can cost a callee-saved register the original avoided.
    // Which placement the source used is not derivable from the asm, so both are emitted and the
    // differ referees.
    respell('/sinkinit', () => sinkInitsToFirstUse(sfn));
    // the register-copy spelling (l3/regspell.ts): 0–3 variants (base; tail assign-back reusing
    // the dead value var; tail assign-back into a fresh var — the tail choice is allocator-
    // ambiguous, so both are ranked).
    //
    // LABELLED BY THE TAIL THE VARIANT CARRIES, NEVER BY ITS INDEX. The reuse tail exists only
    // where R1 fired, so the list is 1, 2 or 3 long and the fresh tail is not at a fixed position:
    // indexing a label table by `i` published the fresh spelling as `/regcopy-ret` on every
    // R1-less function — the dead-var-reuse name on the one spelling that has no dead var — and
    // `candidateLabel` is what every census in this repo counts, `bench diff` included. The
    // exhaustive record is the pin: a new tail kind is a type error here rather than a silent
    // `/regcopy-3`. `cli/test/matching/regspell-candidate.test.ts` holds the correspondence.
    const REGCOPY_LABEL: Record<RegcopyTail, string> = {
      none: '/regcopy',
      reuse: '/regcopy-ret',
      fresh: '/regcopy-ret-fresh',
    };
    registerishSpellings(sfn).forEach((alt) => respell(REGCOPY_LABEL[alt.tail], () => alt.sfn));
    return spellings;
  };
  // The SYMBOL-MAP spelling is itself a ranked LEVER on the same footing as signedness/branch
  // sense: naming a global changes agbcc's codegen (the eager-load effect), and which side
  // byte-wins is genuinely per-function — the dogfood's landed matches split between extern
  // spellings and raw-address macros. So when a map is present the raw-global spelling is ALSO
  // enumerated ('/raw-globals') and the differ referees; the dedup below collapses the pair
  // wherever the map changed nothing, so this never scores worse than either side alone.
  const symbolVariants: { suffix: string; symbols?: typeof opts.symbols }[] = opts.symbols
    ? [
        { suffix: '', symbols: opts.symbols },
        { suffix: '/raw-globals', symbols: undefined },
      ]
    : [{ suffix: '' }];
  for (const [svIndex, sv] of symbolVariants.entries()) {
    const svOpts = sv.symbols ? baseOpts : { ...baseOpts, symbols: undefined };
    // `/no-bitfield` names a spelling the MAP makes available, so it has no inhabitant on the
    // variant that structures without one: structure() normalizes `spellBitfieldMembers` to false
    // when `symbols` is absent, so both arms structure the identical tree whatever reads it. This
    // declines to build the second arm rather than leaving the tree skip to collapse it, which is
    // worth 512 of LoadBGTilemapData's 1536 structurings under docs/ranked-repro.md's flags.
    // Declining is not pruning — same posture as the signedness decline below, and the same
    // candidate list; bitfield-members.test.ts pins the normalization the decline rests on.
    // …and `/no-ptr-elem` names a spelling only the MAP makes available, for the same reason:
    // structure() normalizes `spellPtrMemberElements` to false without `symbols`, so both arms
    // structure the identical tree on the raw variant. `/flat-rank` is the third: the declared
    // subscripts come off the symbol RENDER CONTEXT, which structure() builds only from a map, so
    // its OFF arm is the raw variant's only spelling already.
    const svCands = sv.symbols ? axisCands : axisCands.filter((s) => s.bitfields && s.ptrElems && s.declRank);
    const treeOwnedFold = treeOwnedIn(sv.symbols);
    // The signedness axis DECLINES where the pin has nothing to pin. `pinScalarParams` writes only
    // over an entry param still `unknown`/`int` that is not one of the recovered pointers/
    // aggregates `ptrIdx` excludes; where no param is left, the second pass re-lifts, re-raises and
    // re-structures a function BYTE-IDENTICAL to the first, reaching a tree the first pass already
    // spelled. Declining is not pruning: the candidate list is the same list, reached without
    // building the duplicates. What the decline saves is therefore invisible in the candidates —
    // sign-axis.test.ts counts LIFTS, the one reading of the enumeration that it moves.
    //
    // Read off the pin's OWN call, per symbol variant — the `/raw-globals` arm lifts without the
    // map and answers for itself, so no lift is governed by a fact measured on a different one.
    let pinnable = false;
    for (const cand of SIGN_CANDS) {
      if (cand.signed && !pinnable) {
        break;
      }
      const base = frontend.lift(name, asm, target, prototypes, opts.asmData, sv.symbols);
      // `/setup-args` — pass a prototype-less callee only what the CALLING BLOCK set up; which of
      // the two readings the source spelled is genuinely ambiguous, and frontend/ssa.ts
      // narrowToSetupArgs carries the argument for why the differ is what settles it.
      //
      // A LIFT VARIANT, in the same product position as the signedness pin and the symbol-map
      // spelling — not a re-spelling lever under the POLICY note below. Dropping an argument
      // changes the IR every structuring axis then reads: the value the argument carried loses a
      // consumer, so what materializes changes with it, and a row whose callee arities are GUESSED
      // can need the narrowed lift to reach a spelling neither side reaches alone —
      // `kleod:ReadKeyInput` did, until its manifest declared those arities to asmlift as its own
      // `ctx` already declared them to m2c; it now matches on the base lift, at
      // `unsigned/derived-home`, enumerating no variant at all.
      // Only spellings the narrowing actually changed reach a compiler: one that changes nothing
      // downstream emits the base spelling's source and the dedup collapses it, and a DECLARED
      // arity records nothing and enumerates no variant at all. What survives the dedup is the
      // product's real price, and it is not free: over the benchmark's 272 agbcc rows this arm
      // adds 1201 distinct candidates to 3862, all of them in the 13 rows whose narrowing changes
      // anything downstream — measured before those six kleod rows declared their callee arities,
      // and declaring one takes its row out of this population.
      //
      // `/connective` — spell a same-scrutinee const-test chain as `x == 0 || x == 2` rather than
      // leaving it to switch recovery. They are mutually exclusive within one raise
      // (raise/shortcircuit.ts's REFUSALS note has the mechanism: a folded `logic_or` is not the
      // `icmp` switch-recover.ts requires), so no predicate settles it — the differ does.
      // Enumerated only where THIS VARIANT's lift reports the PAIRWISE refusal — 6 of 923 rows.
      //
      // WHAT IT IS *NOT* FOR: the shared-arm spelling `switch (x) { case 0: case 2: … }`. That is
      // the structurer's DEFAULT (switch-recover.ts groups case values sharing a body), and it is
      // the same object as the `||` only in the DEGENERATE shape — one case group plus `default:`,
      // where the dispatch has nothing to balance (agbcc 12 instructions each and one .text md5,
      // IDO 64 bytes each and one md5). A second group parts them: agbcc 20 against 16, the switch
      // building a balanced `bgt` dispatch where the chain tests sequentially; IDO 80 bytes each,
      // different bytes. So on a recovered MULTI-GROUP switch the connective is a genuine second
      // spelling, and this axis is the only thing that reaches it.
      //
      // Where it is worth 0 POINTS is one ROW, not the shape: on
      // `kleod:ProcessInputAndUpdateEntities:agbcc` the grouping alone scores 306, and so does the
      // grouping with this axis — same breakdown cell for cell, in half the wall clock (681s →
      // 339s). Worth 0 points is not worth nothing: the published winner there carries
      // `/connective` and spells its site `gUnk_030034C0 == 0 || gUnk_030034C0 == 2`, so deleting
      // the axis moves that row's source. It moves the SCORE where switch recovery declined
      // ENTIRELY and the tree came out as nested `if`s — `CountCollectedGems` 327 → 299,
      // `CheckWorldCompletion` 135 → 124, neither with a `switch` at all. Telling the populations
      // apart needs an L3 fact (did recovery produce a grouped arm?) at a raise-level hook, which
      // is a level inversion; the fan is the price instead.
      //
      // It rides the LIFT variants because the raise mutates in place: a second raise policy needs
      // its own copy of the lifted fn, exactly as `/setup-args` needs one to narrow. Crossed with
      // `/setup-args` rather than nested under it — dropping a call argument and choosing this
      // shape are independent, and the four combinations dedup down to whatever the trees differ on.
      const connectiveVariants = treeOwnedFold
        ? [
            { suffix: '', connective: false },
            { suffix: '/connective', connective: true },
          ]
        : [{ suffix: '', connective: false }];
      const liftVariants: { suffix: string; narrow: boolean; connective: boolean }[] = (
        hasSetupArgsNarrowing(base)
          ? [
              { suffix: '', narrow: false },
              { suffix: '/setup-args', narrow: true },
            ]
          : [{ suffix: '', narrow: false }]
      ).flatMap((l) => connectiveVariants.map((c) => ({ ...l, ...c, suffix: `${l.suffix}${c.suffix}` })));
      for (const lv of liftVariants) {
        let fn: Fn;
        try {
          // A NON-EMPTY SUFFIX IS WHAT NEEDS ITS OWN COPY, the catch below's spelling: naming the
          // flags here would leave a fourth axis sharing the primary's already-mutated `base`.
          fn = lv.suffix === '' ? base : frontend.lift(name, asm, target, prototypes, opts.asmData, sv.symbols);
          if (lv.narrow && !narrowToSetupArgs(fn)) {
            continue; // nothing to cut after all — the base lift's own candidates already cover it
          }
          verify(fn);
          applyIdiomPatterns(fn, target, opts.patterns);
          // The shared tower spine (pipeline.ts) — the candidate's ONE difference from decompile()
          // is the signedness pin, injected between pre-recovery and recoverTypes via the
          // beforeRecover hook.
          raiseRecovered(
            fn,
            target,
            {
              beforeRecover: () => {
                pinnable = pinScalarParams(fn, cand.signed, ptrIdx) || pinnable;
              },
            },
            prototypes[name],
            { shortCircuit: { foldTreeOwned: lv.connective } },
          );
        } catch (e) {
          // THE PRIMARY IS THE EMPTY SUFFIX, by construction: every lift axis appends a non-empty
          // one, so `suffix === ''` is the only spelling of "no lever is on" that stays correct
          // when a fourth is added — the same reason the structuring half below reads its table
          // instead of naming its flags.
          if (lv.suffix === '') {
            throw e; // the base lift keeps its behavior: a raising failure aborts the row
          }
          // A dropped lever, never an aborted enumeration — the same posture as `respell`.
          opts.onLeverError?.(name + lv.suffix, e instanceof Error ? e.message.split('\n')[0] : String(e));
          continue;
        }
        // the per-variant axis gates, on THIS variant's lifted fn — see the table doc
        const variantOff = STRUCTURING_AXES.filter((ax) => ax.variantGate !== undefined && !ax.variantGate(fn));
        const variantCands = svCands.filter((s) => variantOff.every((ax) => !s[ax.flag]));
        // `/merge-names` combinations whose un-merged sibling was DROPPED. `structure()` already
        // refuses to let the axis unlock a function the primary declines, but it can only see its own
        // refusals — a boundary contract fails out here, in `structureChecked`. Without this a
        // `/reread-globals/merge-names` candidate could ship where plain `/reread-globals` did not,
        // which is the same trade one level up. `senseCands` puts each `mergeNames:false` sibling
        // first, so the entry is always recorded before its merged twin is reached.
        const droppedPrimary = new Set<string>();
        for (const s of variantCands) {
          if (
            STRUCTURING_AXES.some((ax) => ax.strip && s[ax.flag] && droppedPrimary.has(s.suffix.replace(ax.suffix, '')))
          ) {
            // A SKIPPED variant is recorded exactly like a dropped one, or the closure would not be
            // transitive: with plain X dropped and X/inplace skipped-but-unrecorded,
            // X/inplace/merge-names would find neither stripped key and run — shipping a
            // double-lever candidate where its ancestor failed the boundary contracts.
            droppedPrimary.add(s.suffix);
            continue;
          }
          // structure() reads `fn` and produces a fresh SFn (it does not mutate `fn`), so both branch
          // senses structure the same recovered function without re-lifting.
          let sfn: SFn;
          try {
            sfn = structureChecked(fn, {
              ...svOpts,
              preserveDivergentBranchSense: s.sense,
              negateJoinedBranchSense: s.join ? !defSense : defSense,
              anchorConstCopies: s.anchor,
              anchorLoopEntryConsts: s.entry,
              spellBitfieldMembers: s.bitfields,
              spellPtrMemberElements: s.ptrElems,
              spellDeclaredSubscripts: s.declRank,
              ...STRUCTURING_AXES.reduce((acc, ax) => ({ ...acc, ...ax.options(s[ax.flag]) }), {}),
            });
          } catch (e) {
            if (
              lv.suffix === '' &&
              !s.anchor &&
              !s.join &&
              s.bitfields &&
              s.ptrElems &&
              s.declRank &&
              STRUCTURING_AXES.every((ax) => !s[ax.flag])
            ) {
              throw e; // the base lift's base axes keep their behavior: a failure aborts the row
            }
            // Recorded for EVERY dropped variant: a candidate with more axes on looks its siblings
            // up by stripping one axis at a time, and the stripped key can itself carry the other.
            droppedPrimary.add(s.suffix);
            // an anchored variant that fails structuring or its contracts is a dropped lever, never
            // an aborted enumeration — same rule as respell below
            opts.onLeverError?.(name + lv.suffix + s.suffix, e instanceof Error ? e.message.split('\n')[0] : String(e));
            continue;
          }
          // A TREE another axis point already spelled. `fanOut` reads the tree and this call's own
          // constants, nothing that varies per axis point — its signature is the argument — so a
          // repeated tree can only re-emit sources `seen` already holds: the candidate list, its
          // order and its labels are exactly the ones the whole fan produces, reached without
          // re-deriving forty passes. An axis is INERT on most functions (nothing to re-read, no
          // bitfield member, no joined if), and an inert axis is a factor of two in the cross that
          // changes nothing: on the klonoa checkout's `LoadBGTilemapData` under
          // docs/ranked-repro.md's flags, 640 of 1024 axis points (62.5%) re-derive a tree an
          // earlier one already emitted.
          //
          // Keyed on the JSON text, in a Set of STRINGS — a value comparison, so it can never
          // merge two trees the way a hash could. Its one direction of error is a MISS (a
          // differing key order re-runs a fan whose spellings then dedup as they do today), and
          // the property that rules the other direction out — that the text determines the tree —
          // is pinned by rank-tree-key.test.ts rather than assumed.
          //
          // The key therefore spans EVIDENCE fields too, `index.operandOff` among them, which
          // `exprEquals` deliberately ignores (l3/ast.ts). The two are right to disagree: two
          // trees identical but for that field denote the same cells, so a CSE may collapse them,
          // and they admit different bases under `BASEFOLD_GATES`, so a fan may not. Dropping it
          // from the key would be the direction the paragraph above rules out. It carries a
          // DISPLACEMENT rather than a presence flag, so it can split two trees that print the
          // same subscript off different addends — re-priced when it widened, over klonoa's
          // `LoadBGTilemapData` under docs/ranked-repro.md's flags: 66816 candidates either way,
          // and all 66816 `[score]` lines identical. It splits 0 keys, so the miss it can cause
          // has no inhabitant.
          const treeKey = JSON.stringify(sfn);
          if (seenTrees.has(treeKey)) {
            continue;
          }
          seenTrees.add(treeKey);
          const spellings = fanOut(sfn);
          // The PRE-FAN products (PRE_FAN_PRODUCTS, the fourth mechanism the POLICY note names):
          // rewrite the TREE, then fan the whole re-spelling set over the result, so every lever
          // below derives from the rewrite instead of composing onto it. The gate is the pass's
          // own decline; the contracts are `respell`'s three, for `respell`'s reasons.
          for (const pf of PRE_FAN_PRODUCTS) {
            try {
              const made = pf.apply(sfn);
              if (made === null) {
                continue;
              }
              // The SAME tree dedup the primary above gets, and for the same reason: `fanOut` is a
              // pure function of the tree, so re-fanning one already fanned buys nothing and makes
              // the row's quoted fan cost a number that is partly duplicates. A SEPARATE set, not
              // `seenTrees`: adding a rewritten tree there would let it skip a later PRIMARY tree
              // that happens to equal it, and that primary's own pre-fan output — which nothing
              // has computed — would go with it.
              const madeKey = JSON.stringify(made);
              if (seenPreFan.has(madeKey)) {
                continue;
              }
              seenPreFan.add(madeKey);
              assertResolved(made);
              assertDerefsTyped(made);
              assertLocalsWritten(made);
              // `fanOut` writes the shared `lastEmitError` when the PRIMARY emit throws, and that
              // is what the row's "no spellable candidate" refusal reports. A backend refusal on a
              // REWRITTEN tree is not a refusal of the primary spelling, so it must not be able to
              // become the row's stated cause — saved and restored around the call, in a `finally`
              // so a throw cannot leak it either, rather than letting the wrong cause outlive it.
              //
              // It is reported instead through `onLeverError` under `pf.suffix`, which is what
              // `fanOut`'s second argument is for, and it is the other half of the same rule: a
              // primary emit refusal does not THROW — `fanOut` records it and returns — so the
              // `catch` below never sees it, and under the bare function name it would read as a
              // refusal of the primary spelling while the lever's whole half of the fan was
              // deleted.
              const before = lastEmitError;
              let fanned: Spelling[];
              try {
                fanned = fanOut(made, pf.suffix);
              } finally {
                lastEmitError = before;
              }
              for (const sp of fanned) {
                spellings.push({ ...sp, suffix: `${pf.suffix}${sp.suffix}` });
              }
            } catch (e) {
              opts.onLeverError?.(`${name}${pf.suffix}`, e instanceof Error ? e.message.split('\n')[0] : String(e));
            }
          }
          for (const sp of spellings) {
            const source = sp.source;
            // Collapse a spelling that produced identical source (a function with no divergent `if`
            // structures the same either way): no point scoring a duplicate spelling. Deduping the
            // WHOLE emitted set (not just scored survivors) is equivalent — an identical source
            // scores identically, so it can never change `best` — and it keeps the candidate set to
            // the genuinely distinct spellings.
            const dup = seen.get(source);
            if (dup !== undefined) {
              // The same TEXT, reached twice. `matchOnly` is a property of the DERIVATION and the
              // published artifact is the text, so a spelling some sound route also produces is a
              // proven one however the first route reached it — clear the flag rather than keeping
              // whichever route the enumeration happened to walk first.
              if (sp.matchOnly === undefined) {
                delete dup.matchOnly;
              }
              continue;
            }
            const made: Candidate = {
              label: `${cand.label}${lv.suffix}${s.suffix}${sp.suffix}${sv.suffix}`,
              source,
              group: svIndex,
              ...(sp.symbolRefs ? { symbolRefs: sp.symbolRefs } : {}),
              ...(sp.deviceVolatile ? { deviceVolatile: sp.deviceVolatile } : {}),
              ...(sp.matchOnly ? { matchOnly: sp.matchOnly } : {}),
            };
            seen.set(source, made);
            out.push(made);
          }
        }
      }
    }
  }
  // Every tree the fan produced was refused by the backend. Each refusal on its own is a dropped
  // candidate; all of them together is the row, and it stays LOUD — the alternative is a caller
  // ranking an empty list and reporting no match for a function nothing ever tried to spell.
  if (out.length === 0) {
    throw new Error(`no spellable candidate for '${name}': ${firstLine(lastEmitError)}`, { cause: lastEmitError });
  }
  return out;
}

/** Score each candidate with the injected `scoreFn` and rank by score (lowest first). A candidate
 *  whose `scoreFn` throws — e.g. its C failed to compile — is SKIPPED so it cannot sink a sibling
 *  that compiles and matches; only if EVERY candidate fails is the failure surfaced. Synchronous:
 *  the scorer must be sync (the cli/Node objdiff path). The webapp scores asynchronously and does
 *  its own await-loop over `enumerateCandidates`, reusing this module's `Candidate`/`RankedResult`
 *  types but not this driver. */
export function rankBy<S extends { score: number }>(
  candidates: Candidate[],
  symbol: string,
  scoreFn: (source: string, symbol: string, candidate: Candidate) => S,
): RankedResult<S> {
  const results: (Scored<S> & { order: number })[] = [];
  const dropped: DroppedCandidate[] = []; // spellings that failed to build; only fatal if ALL do
  const withheld: WithheldCandidate[] = []; // spellings that built but did not earn publication
  let lastScoreErr: unknown = null;
  candidates.forEach((c, order) => {
    try {
      const score = scoreFn(c.source, symbol, c);
      const why = withheldReason(c, score);
      if (why !== null) {
        withheld.push({ label: c.label, score: score.score, why });
        return;
      }
      results.push({ ...c, order, score });
    } catch (e) {
      lastScoreErr = e;
      dropped.push({ label: c.label, error: firstLine(e) });
    }
  });
  if (results.length === 0) {
    // Naming the withheld count matters here: "no scorable candidate" with a null cause reads as a
    // scorer failure, and a list that was entirely proof-gated is a different thing entirely.
    const why =
      lastScoreErr !== null ? firstLine(lastScoreErr) : `${withheld.length} candidate(s) withheld, none scored`;
    throw new Error(`no scorable candidate for '${symbol}': ${why}`, { cause: lastScoreErr });
  }
  results.sort(compareScored);
  return { best: results[0], candidates: results.map(({ order: _order, ...c }) => c), dropped, withheld };
}

/** THE candidate ordering — score, then preference group, then readability, then enumeration
 *  order. Exported because there are TWO drivers over the same enumeration (this module's sync
 *  `rankBy` for the Node/objdiff scorer, and the webapp's async await-loop for the wasm one), and
 *  a per-driver copy would let the same input produce two different winners.
 *
 *  SCORE dominates absolutely: the differ is the fitness function, and a tie means the axis that
 *  separates these two spellings did not change the bytes — so everything below only chooses what
 *  the READER sees, and can never cost a match.
 *
 *  GROUP next: a named symbol-map spelling beats its `/raw-globals` sibling at equal bytes.
 *
 *  DEVICE VOLATILITY next: at equal bytes, the spelling that qualifies a DEVICE REGISTER
 *  (`capabilities.deviceRegisters`) is the one to publish. A dropped `volatile` on an MMIO cell is
 *  a real bug in the C that only this compiler at these flags hides — the differ cannot referee
 *  it, because the compiler was not exploiting the non-volatility on this input. Gated on the
 *  window rather than counting the word, because outside it the qualifier is a claim about
 *  ordinary memory that the asm does not support — over the 856-row bench, counting the word
 *  alone decides twelve rows and only two of them touch a device address. A declared term rather
 *  than an enumeration order, which an unrelated lever's spellings can slide between.
 *
 *  IT IS A PREFERENCE, AND EVERY NEW MINTER INHERITS IT. `deviceVolatileClaims` only ever ADDS a
 *  claim, so any lever that qualifies a device access wins its own tie by construction: when
 *  `/vol-store` joined the roster, six rows changed their published `candidateLabel` and `source`
 *  with no score and no outcome moving. That is a judgement about the source rather than a
 *  measurement of it — the differ never refereed those six — and it is the same judgement this
 *  term was declared to make, taken on the same evidence. What it must never do is change WHICH
 *  candidates exist; that stays an admission question, one lever at a time.
 *
 *  CAST COUNT next, and only WITHIN a group. A wrong signedness pin is what manufactures casts —
 *  the C backend has to cast a shift operand back to the signedness the machine op needs, so
 *  pinning `u32` on a genuinely-signed parameter buys `s32 f(u32 a0) { return (s32)a0 >> a1; }`
 *  for the same bytes as `s32 f(s32 a0) { return a0 >> a1; }`. Before the backend synthesized that
 *  cast the wrong pin simply lost on score; now it ties, and enumeration order alone would
 *  silently install the noisier spelling.
 *
 *  LINE COUNT next, the other half of the same job: two spellings can tie on score AND on casts
 *  and still differ by a whole control-flow shape — a `/defsite`-anchored `v0 = 0; if (c) v0 = 1;`
 *  against the braced `if/else` its sibling emits. Counted the way the report counts it
 *  (apps/benchmark/src/eval/quality.ts `lines`), for the same reason `castCount` is: ranking must
 *  not optimize for something the published metric measures differently.
 *
 *  ENUMERATION ORDER last, which makes this a strict total order (indices are unique) and the
 *  result deterministic. Spelled explicitly rather than leaning on Array#sort's stability, which
 *  would make each preference an accident of two unrelated decisions.
 *
 *  WHAT NO TERM HERE WEIGHS: a comparison's rendered SIGNEDNESS. `/uns-cmp`'s whole product is
 *  that polarity, and it carries in a DECLARED TYPE rather than a cast — `castCount` reads 0 on
 *  both sides of the tie it loses — so at equal bytes enumeration order decides, and a rival
 *  axis's spelling can publish a signed compare where the asm's is unsigned. Weighing it needs
 *  the candidate's own SFn and the icmp facts it was structured from, neither of which this
 *  comparator carries; `deviceVolatile` is the shape such a term would take. */
export function compareScored<S extends { score: number }>(
  a: Candidate & { score: S; order: number },
  b: Candidate & { score: S; order: number },
): number {
  return (
    a.score.score - b.score.score ||
    a.group - b.group ||
    (b.deviceVolatile ?? 0) - (a.deviceVolatile ?? 0) ||
    castCount(a.source) - castCount(b.source) ||
    lineCount(a.source) - lineCount(b.source) ||
    a.order - b.order
  );
}

/** Non-blank lines in a candidate's rendered source — the compactness tie-break above, counted
 *  exactly as `quality.ts` counts `lines`. Deterministic, and total on any string. */
function lineCount(source: string): number {
  return source.split('\n').filter((l) => l.trim().length > 0).length;
}

/** Scalar casts in a candidate's rendered source — the readability tie-break above.
 *
 *  A TEXT count over the emitted string, matching how the benchmark's own readability metric
 *  measures the same thing (apps/benchmark/src/eval/quality.ts) — the two must agree about what
 *  "cast noise" means, or ranking optimizes for something the report then scores differently.
 *
 *  It counts the decomp typedef vocabulary only, so a pointer or struct cast is not read as noise
 *  — those are structural spellings a candidate does not choose. And it carries `quality.ts`'s
 *  ADDRESS-CAST exemption: `(u32)&gSym` / `(s32)&gSym` is the CORRECT source spelling of integer
 *  arithmetic on a link-time address, which decomp projects write themselves. Counting it would
 *  penalize precisely the named spelling this ranking is supposed to prefer.
 *
 *  Deterministic, and total on any string. */
function castCount(source: string): number {
  const all = source.match(/\((?:u|s)(?:8|16|32)\)/g)?.length ?? 0;
  const addr = source.match(/\((?:u|s)32\)\s*&/g)?.length ?? 0;
  return all - addr;
}

/** First line of whatever the scorer threw — the compiler's own diagnostic, not a stack. */
function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e ?? 'no candidate produced');
}
