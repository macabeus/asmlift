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
//
// THREE SIBLING FILES, one job each — never a `rank/` directory, which beside `rank.ts` is a
// resolver trap:
//   rank.ts        this file: the enumeration DRIVER and the two ranking drivers over it.
//   rank-axes.ts   the TABLES the driver walks — structuring axes, shape/pre-fan products, the
//                  base-CSE admission rosters. Their DECLARATION ORDER is published behaviour
//                  (`compareScored` breaks a score tie by enumeration order), so reordering one
//                  is a behaviour change and never a tidy-up.
//   rank-declare.ts  the DECLARATION half: what a candidate's own asm says about the globals it
//                  names, and which of those names a declaration must refuse to claim.
import { cBackend } from './backend/c';
import {
  assertDerefsTyped,
  assertLocalsWritten,
  assertNoOrphanedLocals,
  assertPlacementSurvives,
  assertResolved,
} from './contracts';
import type { AsmData } from './frontend/asmdata';
import { frontendFor } from './frontend/registry';
import { hasSetupArgsNarrowing, narrowToSetupArgs } from './frontend/ssa';
import { Fn, defOpMap } from './ir/core';
import { T } from './ir/types';
import { verify } from './ir/verify';
import { materializeArgBases } from './l3/argbase';
import type { LanguageBackend, SFn } from './l3/ast';
import { type BaseKey, admittedBases, hoistBaseLocals } from './l3/basecse';
import { armDisjointCandidates, coalesceCandidates } from './l3/coalesce';
import type { Gate } from './l3/gates';
import type { HoistPlacement } from './l3/hoist';
import { homeSplitTag, homeSplitWithholds, splitHomeBases } from './l3/homesplit';
import { inlinableConstBases, inlineConstBases } from './l3/inlinebase';
import { mulFirstSums } from './l3/mulfirst';
import { nearBaseClusters } from './l3/nearbase';
import { spellOperandMembers } from './l3/offmember';
import { parkParamsFirst } from './l3/parkfirst';
import { pointerFields } from './l3/ptrfield';
import { type RegcopyTail, registerishSpellings } from './l3/regspell';
import { reindexWalks } from './l3/reindex';
import { hoistScopedBases } from './l3/scopebase';
import { sinkInitsToFirstUse } from './l3/sinkinit';
import type { SymbolRef } from './l3/symbol-refs';
import { type UnreduceResult, unreduceAccumulators } from './l3/unreduce';
import { deviceVolatileClaims, volatilePtrLocals, volatileSubsetCandidates } from './l3/volatileptr';
import { volatileValueLocals } from './l3/volatileval';
import { volatileDeviceStores } from './l3/volstore';
import { zeroSubNegates } from './l3/zerosub';
import { RewritePattern } from './pattern/engine';
import { applyIdiomPatterns, raiseRecovered, structureChecked } from './pipeline';
import { type Prototypes, prototypesFromSymbols } from './proto';
import { inferGlobalArrays, orderLicensedGlobals, sameDerivedShape } from './raise/globalshape';
import { runPreRecovery } from './raise/pre-recovery';
import { recoverTypes } from './raise/recover';
import {
  BASEFOLD_ADMISSIONS,
  type BaseAdmission,
  LIVEBASE_ADMISSIONS,
  NO_PIN_KINDS,
  ORDERBASE_ADMISSIONS,
  PRE_FAN_PRODUCTS,
  SHAPE_SUBSETS,
  SIGN_CANDS,
  STRUCTURING_AXES,
  type StructuringAxis,
  UNFOLDED_ADMISSIONS,
  applyShapes,
  createdLocals,
  sameBases,
} from './rank-axes';
import {
  type RefusedDeclarationReason,
  bareGlobalAccessFacts,
  bareGlobalSymbols,
  makeRefCollector,
} from './rank-declare';
import { type SymbolInfo, type SymbolMap, arrayInnerExtents, isPtrField, symbolsByName } from './symbols';
import { type TargetDescription, structureOptionsFor } from './target';

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

/** Re-exported so `@asmlift/core/rank` keeps its published surface: `onRefusedDeclaration`'s
 *  reason type is declared beside the refusals themselves (rank-declare.ts) and consumed from
 *  here. */
export type { RefusedDeclarationReason };

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
  /** Called with the axis suffix each time a STRUCTURING axis's shared probe gate says this
   *  function has no inhabitant for it, so the arm is never enumerated.
   *
   *  The two callbacks below report the enumeration's two SILENT candidate-deleting sites, and
   *  they exist for `onLeverError`'s reason read one level up: a candidate that was never
   *  enumerated is indistinguishable, from outside, from one the differ simply did not pick, and
   *  nothing else in the pipeline reports it. A gate that has stopped firing and a gate that
   *  correctly declines on every corpus row look identical without this.
   *
   *  They ride `EnumerateOptions` rather than `RankedResult` deliberately: these are facts about
   *  the enumeration's INTERNALS, and `RankedResult` is the published candidate set.
   *
   *  Nothing shipped passes either one, so a channel that had stopped firing would be invisible in
   *  exactly the way the channel exists to prevent. `test/enumerate-signals.test.ts` pins that both
   *  reach a caller. */
  onAxisGated?: (suffix: string) => void;
  /** Called once per axis point whose structured tree an earlier point already spelled — the tree
   *  dedup, which is where most of the cross's factors of two go. See `onAxisGated` for why both
   *  are here rather than on the result. */
  onTreeDeduped?: () => void;
  /** PROBE (`ASMLIFT_PERSITE_SENSE`, wired in the cli): fork the two per-FUNCTION branch-sense
   *  booleans into one bit per SITE, crossing every sense point with all 2^n masks over the first
   *  `n` sense sites. Costs a factor of 2^n on the whole fan, which is the measurement — see the
   *  `perSiteSense` block below. 0/absent = the shipped two-point axis. */
  perSiteSenseBits?: number;
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
  /** the denominator that score was measured against — objdiff's row count for THIS candidate's
   *  alignment, so it moves with the spelling. Present whenever the injected scorer supplies one
   *  (the cli and webapp objdiff scorers both do); a scorer whose result carries no `rows` leaves
   *  it absent rather than inventing a scale. A withheld score is compared across runs exactly
   *  like a published one, and a bare numerator invites the subtraction on a fixed scale that
   *  `kleod:CountCollectedGems:agbcc` (290/404 → 171/387) cost an attribution round. */
  rows?: number;
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

/** What one `fanOut` call produced: its spellings, plus the PRIMARY emit's refusal where the
 *  backend declined the tree it was handed.
 *
 *  RETURNED rather than written to the enumeration's shared `lastEmitError`, because only ONE
 *  caller may record one. `fanOut` runs over the row's own tree and over each PRE-FAN product's
 *  REWRITTEN tree, and a backend refusal of a rewrite is not a refusal of the row's spelling —
 *  letting it reach `lastEmitError` would put the wrong cause on the row's "no spellable
 *  candidate" throw. With the value returned, the primary caller records and the pre-fan caller
 *  does not, which is the rule made structural instead of saved and restored around the call.
 *
 *  A DISCRIMINATED FIELD, not a nullable error: a lever that throws a falsy value is still
 *  recorded, where `?? ` would read it as "nothing was thrown". */
interface FanResult {
  spellings: Spelling[];
  emit?: { error: unknown };
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
 *  It differs from `decompile()` in exactly two arguments to the shared spine — the signedness
 *  pin, injected between pre-recovery and recoverTypes via the `beforeRecover` hook, and the
 *  `pre.shortCircuit` connective owner (the raiseRecovered call below states both).
 *  Duplicate sources are collapsed so the scorer never
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
    // See the same line in pipeline.ts: a backend that cannot print switch fall-through must not
    // be handed a tree carrying one, because its refusal costs the whole candidate (and, when
    // every candidate carries it, the whole row).
    spellSwitchFallthrough: backend.spellsSwitchFallthrough,
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
  //
  // The four spelling booleans that PREDATE `STRUCTURING_AXES` and are still hand-carried
  // (`bitfields`, `ptrElems`, `declRank` and the anchor pair) start from one record, so a base
  // point's default lives in one place instead of six literals that can disagree. Each entry
  // states only what it VARIES — which is the whole content of the chain above.
  const SPELLING_DEFAULTS = { anchor: false, entry: false, bitfields: true, ptrElems: true, declRank: true };
  const senseAnchor = [
    { ...SPELLING_DEFAULTS, suffix: '', sense: defSense },
    { ...SPELLING_DEFAULTS, suffix: '/flip-branch', sense: !defSense },
    { ...SPELLING_DEFAULTS, suffix: '/defsite', sense: defSense, anchor: true },
    { ...SPELLING_DEFAULTS, suffix: '/flip-branch/defsite', sense: !defSense, anchor: true },
    { ...SPELLING_DEFAULTS, suffix: '/defsite/loop-entry', sense: defSense, anchor: true, entry: true },
    { ...SPELLING_DEFAULTS, suffix: '/flip-branch/defsite/loop-entry', sense: !defSense, anchor: true, entry: true },
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
  // where the `if` is the compiler's own and no source sense exists to be faithful to. The FIRST
  // of the three is now decided per site rather than enumerated — `/site-sense` (rank-axes.ts)
  // reads the orientation the fold records — and this axis stays because the other two are not.
  // The third
  // is what keeps the residue on targets that have neither: rows still win on the axis under
  // gcc2.7.2 / gcc2.7.2kmc / mwcc, with no `short-circuit` tag and no Thumb branch range to
  // explain them, and most of those carry `loop`. A function with no two-armed joined if emits identical
  // source and the dedup collapses it before any compile.
  const senseOnly = [
    ...senseAnchor.map((s) => ({ ...s, join: false })),
    ...senseAnchor.map((s) => ({ ...s, suffix: `${s.suffix}/flip-join`, join: true })),
  ];
  // THE PER-SITE PROBE, and it is a probe rather than a lever: every mask over the sense sites,
  // crossed with the whole fan. It exists to price the fork the two booleans above cannot express
  // — 2^n on a function with n sites, which is the number a decidable predicate would replace —
  // and to say whether the target's configuration is REACHABLE at all. Not enumerated unless the
  // caller asks; `structure()`'s own `branchSenseFlipSites` is the seam it drives.
  const maskSites = (m: number): ReadonlySet<number> => new Set([...Array(32).keys()].filter((i) => (m >> i) & 1));
  const senseMasks = Array.from({ length: 1 << (opts.perSiteSenseBits ?? 0) }, (_, m) => m);
  const baseSense = senseMasks.flatMap((m) =>
    senseOnly.map((s) => ({
      ...s,
      ...(m === 0 ? {} : { suffix: `${s.suffix}/sense-${m}` }),
      // Always present, `undefined` at mask 0: an optional key added on one arm of a ternary would
      // make the two arms different object TYPES, and the list is what the whole fan spreads from.
      flipSites: m === 0 ? undefined : maskSites(m),
    })),
  );
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
  // `gaddr` the const-test test then does not read. Measured once and NOT re-derived since: over
  // the real rows that lifted, 21 sites mapped and 21 raw with no per-row divergence. Read that as
  // the REASON the gate is asked per variant, not as a fact about today's corpus — it carries no
  // commit stamp. The SYNTHETIC tier is inside that comparison rather than exempt from it: 9 of
  // its 770 rows carry a map (`SynthSpec.symbols`) in the committed artifact, and that count moves
  // every time a map row is added, so re-derive it rather than carrying this one forward. So this
  // buys no candidate; what
  // it buys is that a lift-time change which splits them enumerates both arms rather than
  // silently dropping one, the failure nothing reports.
  let probeTreeOwned = false;
  // Probe: recover ONCE with no signedness pin, to learn which entry params are pointers/aggregates
  // so they are excluded from the signedness axis (see NO_PIN_KINDS). One extra lift+recover, no
  // compile. (The probe deliberately stops after recoverTypes — it only reads the param KINDS, so
  // the totality contract / return-sinking of the full spine are not run on it.)
  const probe = frontend.lift(name, asm, target, prototypes, opts.asmData, opts.symbols);
  verify(probe);
  // The ARRAY SHAPES the input assembly evidences (raise/globalshape.ts), for the DECLARATION
  // half. Read off the probe's LIFTED form — before the fold below and the tower rewrite it —
  // because the base-materialization order the derivation's licence reads does not survive them.
  // Probe-derived like `accessFacts` beside it, and for the same reason: it is a lift-time fact.
  // The candidate half reads its OWN lift (each symbol variant lifts differently), just as the
  // spelling axes do.
  const probeShapes = inferGlobalArrays(probe, target);
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
  //
  // The MAPPED variant reads it off the probe below, itself a lift in exactly that configuration —
  // reuse, not inheritance. Only a variant lifting under DIFFERENT symbols pays a lift of its own,
  // so the price is one per `/raw-globals` arm and zero on a map-less row, never per candidate.
  //
  // DECLARED AFTER THE PROBE'S OWN `runPreRecovery` ON PURPOSE, and that placement is the memo's
  // precondition: the map arm returns `probeTreeOwned`, which is only the answer once the probe's
  // `onTreeOwned` hook has had its chance to fire. Called any earlier it would report a confident
  // `false` for a function that owns a tree. As a `const` below that call, an early call is a TDZ
  // ReferenceError instead — a wrong answer traded for a loud one.
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
  // not a doubling. A ROUNDER NUMBER IS NOT A SAFER ONE: re-measure rather than reaching for a
  // vaguer word. The instrument is `decompileRanked`'s own enumeration, and a direct
  // `enumerateCandidates` call from a standalone script is NOT it (an ESM/CJS duplicate of this
  // module answers 544 where the harness answers 952 on `SetupBG3WindowOverlay`).
  //
  // The two arms are also NESTED rather than independent — `ptrElemCands` is built by doubling
  // `bitfieldCands`, so this arm's candidates include the `/no-bitfield` ones and adding the two
  // families' counts double-counts the overlap: on that same row 12,672 of the 23,040 carry BOTH
  // tokens, which is half of `/no-bitfield`'s own 25,344. A per-family price read off either
  // label alone therefore double-counts more than half of this row's cross.
  //
  // EXACTLY ONE WINNING LABEL IN THE ARTIFACT CARRIES `/no-ptr-elem` — `synthetic:ptrelem:agbcc`,
  // match at 0. READ THAT ONE, NOT A ZERO: the axis is two-sided where it fires. Compile the byte
  // spelling and the element spelling of the SAME address with the klonoa checkout's own agbcc,
  // lift each back with that project's own map, and the arm is the ONLY candidate that matches the
  // byte target while the default is the only one that matches the element target — on a constant
  // element offset, at one element in, at a pointee width of 1, and on a STORE.
  // `cli/test/matching/ptr-elem-axis.test.ts` is that measurement, and deleting the `ptrElemCands`
  // cross turns 8 of its 13 assertions red — the four BYTE-target ones (each scoring 1
  // rather than 0) and the four that check the arm is enumerated at all — while its four
  // ELEMENT-target ones stay green, which is the two-sidedness itself. A low count over the REAL
  // tier counts something else: klonoa's map declares a sized pointer member at ONE address, and
  // every decompiled caller of it happens to be written in the element form.
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
  // its 58752) and `kleod:SetupBG3WindowOverlay` (128 of 952), and only the first carries a
  // winning label at all, the second being `noncompile`. THE TWO-ROW REACH IS STABLE AND THE
  // COUNTS ARE NOT — they move with every fan-widening axis, so re-run the census rather than
  // quoting these. So the REAL tier's "0 winning labels" is 0 of ONE here, not 0 of 151 and not
  // 0 of the artifact's row count. That census enumerates 155 of the 252 real rows — the
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
  // WHERE THE WINNING LABELS ARE, since the REAL tier has none for either arm: the SYNTHETIC tier
  // carries rows that hand asmlift a map (`SynthSpec.symbols`), and both arms win on one —
  // `/no-bitfield` on `bfwordread` and `bfwordwrite`, `/no-ptr-elem` on `ptrelem`, each a match at
  // 0 that becomes a NONMATCH when its own arm is ablated. A LABEL CENSUS IS SCOPED TO ITS TIER
  // AND ITS COMMIT: say which tier a count is over, and re-derive it rather than carrying it
  // forward.
  // The name-keyed map `baseOpts` already built, not a second `symbolsByName` walk over the same
  // input: the function is deterministic and unmemoized, nothing in packages/core mutates a
  // SymbolMap or a map it returns, and `baseOpts` is never reassigned — so this is the same map,
  // 25-47 ms cheaper on the large vendored ones. The same idiom `mapSymbols` below uses.
  const byName = baseOpts.symbols;
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
  // fan does not grow. OVER THE ARTIFACT'S 957 ROWS: 10 name such a symbol at all — 9 of them in
  // their winning `symbolsUsed`, the tenth (`kleod:SetupBG3WindowOverlay`) in a source its row
  // cannot compile, which is why the count is taken off the emitted sources and not off
  // `symbolsUsed`, where a row with no winner is invisible. RE-DERIVE THIS PAIR RATHER THAN
  // RE-ANCHORING IT: adding one map-bearing row moves it, and one of the nine is exactly that —
  // `synthetic:sbscope:agbcc`, whose map declares `dims: [4, 1024]`.
  //
  // THE GATE READS THE MAP **OR** THE DERIVED SHAPES, and the map half alone was a live bug: since
  // raise/globalshape.ts, `structure()` builds the symbol render context from the UNION of the
  // project map and the shapes the asm evidences, so a MAP-LESS function whose own strides nest
  // (`synthetic:tblrank2:agbcc`) now spells `gPtrTbl[a0][a1]` by default while its flat sibling
  // `*(s32 *)((a1 << 2) + (a0 << 3) + (u32)&gPtrTbl)` — a genuinely different tree — was
  // enumerated nowhere. An axis exists BECAUSE the asm underdetermines the choice; supplying the
  // rank from a new place does not make it determined, and nothing reports a candidate that was
  // never enumerated. Map first, exactly as everywhere else: a name the map knows is answered by
  // the map.
  const derivedOrMapped = (n: string): SymbolInfo | undefined => byName?.get(n) ?? probeShapes.get(n);
  const fnNamesMultidimArray = [...bareGlobalSymbols(probe).keys()].some((n) => {
    const i = derivedOrMapped(n);
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
  /** Every axis OFF — seeded from the table so an added axis is one table entry and not a second
   *  hand-edited literal, in table order like everything else derived from it.
   *
   *  WHAT THE CAST CANNOT CATCH: a `StructuringAxis['flag']` union member with NO table entry.
   *  `Object.fromEntries` types its result by the key type it was handed, not by the union, so the
   *  assertion is taken on trust where the hand-written literal was checked. Such a member is
   *  inert either way — every reader of these flags iterates `STRUCTURING_AXES`, so a flag with no
   *  entry is never read — but it stops being a type error and becomes an absent field. */
  const axisFlagsOff = Object.fromEntries(STRUCTURING_AXES.map((ax) => [ax.flag, false])) as Record<
    StructuringAxis['flag'],
    boolean
  >;
  let axisCands: AxisCand[] = declRankCands.map((s) => ({ ...s, ...axisFlagsOff }));
  for (const ax of STRUCTURING_AXES) {
    if (ax.probeGate !== undefined && !ax.probeGate(probe, probeDefs)) {
      opts.onAxisGated?.(ax.suffix);
      continue;
    }
    axisCands = [
      ...axisCands,
      ...axisCands.map((s) => ({ ...s, suffix: `${s.suffix}${ax.suffix}`, [ax.flag]: true }) as AxisCand),
    ];
  }
  /** Is this the point where NO structuring lever is on? The base-axes abort guard's other half:
   *  at the base LIFT variant a failure here aborts the row, because it says the lift is broken
   *  rather than that one axis cannot spell this tree.
   *
   *  `s.suffix === ''` IS NOT THE SAME TEST, which is why this is a named predicate rather than
   *  the string compare it looks like. `/flip-branch` and `/flip-join` name a branch sense
   *  RELATIVE to the target's default, so BOTH senses are base axis points — the flipped one
   *  carries a suffix and still has every lever off. The table's own flags decide, plus the four
   *  shape booleans that predate the table. */
  const isBaseAxisPoint = (s: AxisCand): boolean =>
    !s.anchor && !s.join && s.bitfields && s.ptrElems && s.declRank && STRUCTURING_AXES.every((ax) => !s[ax.flag]);

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
  // THREE halves now, in increasing authority: the name-only pool/reloc symbols, the array shapes
  // the asm evidences for them (raise/globalshape.ts — an `extern u16 gTbl[];` where the bare
  // spelling needs one, and the declaration a candidate spelling `gTbl[i]` cannot compile
  // without), and the project map, which knows more than either.
  const mapSymbols = baseOpts.symbols;
  const declSymbols = new Map<string, SymbolInfo>([...bareGlobalSymbols(probe), ...probeShapes, ...(mapSymbols ?? [])]);
  // The four per-enumeration constants named at the seam rather than captured across 60 lines of
  // closure (rank-declare.ts states why they belong on one object).
  const refsOf = makeRefCollector({ declSymbols, accessFacts, mapSymbols, refuse });
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
  const fanOut = (sfn: SFn, leverLabel = ''): FanResult => {
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
      opts.onLeverError?.(name + leverLabel, firstLine(e));
      return { spellings, emit: { error: e } };
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
    // rather than on theirs. It cost nothing when measured: 0 violations over the 34357 trees the
    // artifact's agbcc rows enumerated in both symbol-map configurations. A count with no commit
    // stamp — re-run it rather than reading it as today's.
    // `assertEffectsPreserved` is the fourth and is NOT here: it needs the L1 `fn`, and
    // `fanOut`'s parameter list is the invariant the tree-dedup skip rests on (see its header).
    // Widening it for a contract is a defensible change and an argued one — not a silent import.
    // A lever returns its tree, or `{ sfn, needsProof }` when it cannot establish its own
    // semantics from inside the pass (Candidate.matchOnly carries the argument).
    const respell = (suffix: string, make: () => LeverResult, alreadyShaped = false): void => {
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
        assertNoOrphanedLocals(sfn, alt);
        spellings.push({ suffix, source: backend.emit(alt), ...refsOf(alt), ...volOf(alt), ...proof });
        // STATEMENT-SHAPE products, derived onto EVERY spelling — the second sanctioned
        // product mechanism (the POLICY note above carries the admission argument). Each is
        // a statement-order/shape fact orthogonal to representation; subsets compose in the
        // fixed order below. A shape that never fires declines and costs nothing.
        if (!alreadyShaped) {
          // A shape REORDERS statements, and it is derived after a lever has placed its defs — so
          // the placement is re-checked on the shaped tree (contracts.ts). Differential: judged
          // only where the unshaped tree already satisfied the walk, so a lever whose placement it
          // never described is not dropped on the strength of a model that does not apply.
          //
          // `minted` is a NAME DIFF, so for a RENAMING lever (`/regspell`, `/merge-names`) it also
          // holds locals the lever never PLACED. Harmless and deliberate: the differential's
          // early return absorbs a name the unshaped tree already fails on, and a renamed local
          // whose def a shape moved below a read is the same wrongness as a placed one.
          //
          // KNOWN GAP on the other side of the same diff: a lever that RELOCATES a local it did not
          // mint contributes no name, so the shape differential does not judge it. The `scope`
          // placement is the one that does this — it sinks the run `structureChecked` already
          // committed (l3/basecse.ts judges those itself, over the placer's own report of the
          // motion) — and closing it here needs that report threaded out to this level. Not widened
          // to every relocated local instead: judging those would drop candidates across the whole
          // fan with nothing measured to license it. What keeps it uninhabited is `initFirstGuards`,
          // which moves only const or pure-read assigns and so cannot lift a read of a base local
          // above its init.
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
                assertNoOrphanedLocals(alt, shaped.out);
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
              opts.onLeverError?.(name + leverLabel + suffix + shapeSuffix, firstLine(e));
            }
          }
        }
      } catch (e) {
        // A throwing lever, a contract failure, or an unspellable re-spelling: keep the primary.
        // REPORTED, not swallowed. `dropped` (below) records only spellings the SCORER refused,
        // so without this a lever that fails here vanishes with no trace — indistinguishable
        // from one that correctly declined, which is exactly the hidden failure
        // DroppedCandidate exists to surface.
        opts.onLeverError?.(name + leverLabel + suffix, firstLine(e));
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
          // the ONE call whose suffix already names shapes — say so, rather than making `respell`
          // read it back out of the label it was handed
          respell(shaped.suffix, () => shaped.out, true);
        }
      } catch (e) {
        // the error label falls back to the full subset — the fired set is unknown mid-throw
        const label = subset.map((x) => x.suffix).join('');
        opts.onLeverError?.(name + leverLabel + label, firstLine(e));
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
    /** `/vol-store`'s pass with the target's device-register window handed over — the window that
     *  keeps it off ordinary memory. Written once because five call sites take it. */
    const volStore = (from: SFn): SFn | null => volatileDeviceStores(from, target.capabilities.deviceRegisters);
    // `/vol-store` — pin a store at a fixed DEVICE-REGISTER address `volatile` (l3/volstore.ts).
    // Where `/volatile` above qualifies a pointer LOCAL holding the address, this qualifies the
    // access itself, which is the spelling a `REG_*` macro produces and the one structure.ts
    // leaves when the address re-materializes at each use. Codegen-visible: agbcc's `load_mems`
    // hoists an unpinned fixed-address store clean out of a loop (gcc/loop.c:8934), so the pinned
    // spelling is the only one that reproduces a device-driving loop body at all. Its window gate
    // is the target's own `deviceRegisters` range, which is what keeps it off ordinary memory.
    respell('/vol-store', () => volStore(sfn));
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
    // WHAT THE STANDALONE LINES COST, since neither of the two levers ever wins an artifact row
    // ALONE — every `/unreduce` and `/ptr-field` winner rides inside a `/vol-store` pairing, which
    // is the property `apps/benchmark/test/census.test.ts` asserts rather than the count it used
    // to quote here. They are kept because a lever has to be able to LOSE on its own terms: the
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
        opts.onLeverError?.(name + leverLabel + label, firstLine(e));
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
    // spelling under a different label, so it declines for that too. `/basefold`'s TWO rows and
    // `/unfolded` join the roster where the target declares the fold, and `/orderbase` where it
    // declares the array-shape fork, so a target with neither is offered the two `/livebase` rows
    // and nothing else. The same fact is stated at the POLICY sites above; a roster change repairs
    // all of them or none.
    const admissions: readonly BaseAdmission[] = [
      ...LIVEBASE_ADMISSIONS,
      ...(target.compilerBehaviors.foldsConstAddrOffset ? [...BASEFOLD_ADMISSIONS, ...UNFOLDED_ADMISSIONS] : []),
      // …and the ORDER row where the compiler's subscript expansion forks on the base's array-ness,
      // which is the same opt-in raise/globalshape.ts carries: with it off nothing is stamped, so
      // `order-licensed` would refuse every key anyway and this only saves the census.
      ...(target.compilerBehaviors.arrayShapeFromStride ? ORDERBASE_ADMISSIONS : []),
    ];
    // AND THE SAME SKIP KEYED ON THE LICENCE ITSELF WOULD BUY NOTHING, which is worth a paragraph
    // because this row is where the next reader will propose it. `orderLicensedGlobals` is decidable
    // on the lifted fn, so the row could also be dropped wherever THAT set is empty. It would be
    // sound, and it would be inert, for the same one reason: an empty licence stamps no
    // `baseOrdered` (structure.ts `stampOrderedBases`), so `order-licensed` refuses every key, so
    // `hoist` returns null and this row's three emission sites — two `respell`s and the `enumerate`
    // whose generator fans over volatile SUBSETS, so the third is a set and not one spelling — emit
    // nothing. Which GENERALIZES to every axis carrying a licence: a skip like it is sound exactly
    // where the axis would have emitted no candidate, so a sound one shrinks the fan by zero, so it
    // removes no COMPILE, and one compile per candidate is where a ranked run's cost is; what it
    // saves is one `admittedBases` walk per tree. `docs/level-tower.md` carries the general form.
    // Measured on klonoa's `LoadBGTilemapData`, the checkout function whose 112,896-candidate fan
    // raises the question: the licence is empty on every lift variant of BOTH symbol-map arms —
    // four named symbols DO reach the licence table map-ful and the ADDRESS gates refuse all four,
    // so "the pool spells no names" is not the reason — and the skip fires on every tree there and
    // removes not one candidate.
    //
    // IF IT IS EVER BUILT ANYWAY, IT IS `orderLicensedGlobals(fn, target)` READ AT THE SITE BELOW
    // that hands `orderLicensed` to the structuring call, PER LIFT VARIANT — never per function,
    // and never either of the two predicates standing beside it in that same loop. All three wrong
    // readings delete the SAME four live candidates on `sub_806800C` in the sa3 checkout, in BOTH
    // arms: `unsigned/setup-args/orderbase` and its `/flip-join`, `/derived-home` and
    // `/flip-join/derived-home` siblings.
    //   · PER FUNCTION — `/setup-args` narrows the lift and can license a name the base lift does
    //     not, so the first variant's answer is not the function's.
    //   · `inferGlobalArrays`, seven lines above the licence call and off the same `fn` — a
    //     documented strict SUBSET (`raise/globalshape.ts`), and measurably empty on functions
    //     where the licence is not, several of them carrying `/orderbase` candidates.
    //   · the licence RECOMPUTED after `raiseRecovered` — not the next statement but the third,
    //     ten lines down, past the map-precedence delete over `inferredSymbols` and
    //     `applyIdiomPatterns`. `raise/globalshape.ts` says in its own module note that the raising
    //     tower destroys the order evidence, but the tempting next step — "so it reads empty
    //     everywhere and the skip is free" — is FALSE: it reads NON-empty on a function whose
    //     `/orderbase` candidates it then deletes anyway. Firing less often is not a defence.
    // A per-row label/source diff catches the last two, and CANNOT catch the first. Both of those
    // delete `unsigned/orderbase` off `synthetic:bgarr:agbcc`, the exact source that row publishes
    // as its score-0 MATCH — a row carrying no symbol map, so its single arm is the one the gate
    // actually runs. The per-function reading needs `/setup-args` AND `/orderbase` in ONE label,
    // and NO published winner label carries both — so a green corpus gate is evidence about two of
    // these readings and none at all about the third. That property is the gate, not a count:
    // apps/benchmark/test/census.test.ts asserts it over the committed artifact.

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
    /** Does an EARLIER roster row already bind exactly `bound` at this placement? Then this row is
     *  that row's spelling under a second label and declines.
     *
     *  Same bases in the same POSITION is the same spelling; the same bases somewhere else is not,
     *  which is why the placement is a conjunct and not an afterthought. `rows` is the slice's
     *  own list, so the two readers scope it differently — the roster hoist asks over the whole
     *  admissions roster, the homesplit pairing over the PAIRED rows only, because a skip there
     *  must never drop a withhold no other row enumerates. Captures `census`, so a repeated table
     *  costs one memo lookup rather than a second walk. */
    const shadowedByEarlier = (
      rows: readonly { placement: HoistPlacement; gates: readonly Gate<BaseKey>[] }[],
      i: number,
      placement: HoistPlacement,
      bound: readonly string[],
    ): boolean => rows.slice(0, i).some((r) => r.placement === placement && sameBases(bound, census(r.gates)));
    const livebases = admissions.map(({ suffix, gates, placement, pairings }, i) => {
      const hoist = (): SFn | null => {
        const bound = census(gates);
        if (bound.length === 0) {
          return null;
        }
        return shadowedByEarlier(admissions, i, placement, bound) ? null : hoistBaseLocals(sfn, gates, placement);
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
    // lever spells alone because each applies its own policy to every base it binds: compiled
    // against that row's own object, the score reaches 0 only where the two policies land on
    // DIFFERENT bases, and every uniform choice is worse. The endpoint figures live in
    // l3/homesplit.ts, which is the measurement's one home, along with why this is a PIPE and
    // never a merge.
    //
    // WHICH key is withheld is not derivable, so every admitted key is its own candidate, LABELLED
    // with that key — a label is an identity, and one label over two withholds names two programs.
    // `HOMESPLIT_FAN_GATES`' `homesplit-fan-cap` is what bounds the product.
    // ADDITIVE, like every lever here: `/livebase-block`, `/regionbase`, `/scopebase` and the
    // un-hoisted primary all stay in the list, which is what keeps `synthetic:dmaflat` — where the
    // composed spelling scores 13 against its own 0 — at MATCH.
    for (const [i, { suffix, gates, placement }] of paired.entries()) {
      const bound = census(gates);
      // The ROSTER's dedup, which `hoist` applies to every other product and this loop has to ask
      // for itself: every pairing piped from a shadowed row is that row's spelling under a second
      // label too. Asked over the PAIRED rows only — the earlier row runs the identical pipe and
      // emits the identical source. Without it both run and `seen` collapses the pair afterwards,
      // having paid a head hoist, region plan, rewrite and emit for each.
      if (shadowedByEarlier(paired, i, placement, bound)) {
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
    // where R1 fired, so the list is 1, 2 or 3 long and the fresh tail sits at no fixed position;
    // an index-keyed label table names the fresh spelling `/regcopy-ret` on every R1-less function
    // — the dead-var-reuse name on the one spelling that has no dead var — and `candidateLabel` is
    // what every census in this repo counts, `bench diff` included. The exhaustive record is the
    // pin: a new tail kind is a type error here rather than a silent `/regcopy-3`.
    // `cli/test/matching/regspell-candidate.test.ts` holds the correspondence.
    const REGCOPY_LABEL: Record<RegcopyTail, string> = {
      none: '/regcopy',
      reuse: '/regcopy-ret',
      fresh: '/regcopy-ret-fresh',
    };
    registerishSpellings(sfn).forEach((alt) => respell(REGCOPY_LABEL[alt.tail], () => alt.sfn));
    return { spellings };
  };
  // The SYMBOL-MAP spelling is itself a ranked LEVER on the same footing as signedness/branch
  // sense: naming a global changes agbcc's codegen (the eager-load effect), and which side
  // byte-wins is genuinely per-function — the dogfood's landed matches split between extern
  // spellings and raw-address macros. So when a map is present the raw-global spelling is ALSO
  // enumerated ('/raw-globals') and the differ referees; the dedup below collapses the pair
  // wherever the map changed nothing, so this never scores worse than either side alone.
  //
  // Does the `/raw-globals` arm have a RANK of its own to spell? Read off the DERIVED shapes the
  // map does not answer for — the only ones a map-less structuring ever sees — because that is
  // exactly the population `/flat-rank`'s decline just below is about. A superset of what the raw
  // arm's own lift derives (it is read off the probe's), for the reason the axis gate above is one
  // too: this only ADDS an OFF arm, and where the arm changes nothing the tree dedup collapses it.
  const rawDerivesRank = [...probeShapes].some(
    ([n, i]) => byName?.get(n) === undefined && (arrayInnerExtents(i)?.length ?? 0) > 0,
  );
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
    // structure the identical tree on the raw variant. `/flat-rank` IS NOT a third such spelling,
    // and the difference is why its decline is asked of the EVIDENCE and not of the map: the
    // declared subscripts come off a render context structure() builds from the UNION of the map
    // and the shapes this function's own strides evidence (raise/globalshape.ts), so the raw arm
    // derives a rank of its own. The decline therefore stands only where no derived shape carries
    // a rank for that arm to spell — the condition under which both arms really do structure the
    // identical tree.
    const svCands = sv.symbols
      ? axisCands
      : axisCands.filter((s) => s.bitfields && s.ptrElems && (s.declRank || rawDerivesRank));
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
      // product's real price, and it is not free: this arm added 1201 distinct candidates, all of
      // them in the 13 rows whose narrowing changes anything downstream. Quoted as a DELTA with no
      // denominator, because the agbcc row count it was taken over has moved since — measured
      // before those six kleod rows declared their callee arities,
      // and declaring one takes its row out of this population.
      //
      // `/connective` — spell a same-scrutinee const-test chain as `x == 0 || x == 2` rather than
      // leaving it to switch recovery. They are mutually exclusive within one raise
      // (raise/shortcircuit.ts's REFUSALS note has the mechanism: a folded `logic_or` is not the
      // `icmp` switch-recover.ts requires), so no predicate settles it — the differ does.
      // Enumerated only where THIS VARIANT's lift reports the PAIRWISE refusal, which a handful of
      // corpus rows do.
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
      // WHERE IT IS WORTH 0 POINTS IT IS STILL NOT WORTH NOTHING, and the two populations differ.
      // On `kleod:ProcessInputAndUpdateEntities` the grouping alone reaches the same score the
      // axis reaches with it, yet the published winner there carries `/connective` and spells its
      // site `gUnk_030034C0 == 0 || gUnk_030034C0 == 2` — so deleting the axis moves that row's
      // SOURCE. It moves the SCORE on the other population, where switch recovery declined
      // ENTIRELY and the tree came out as nested `if`s: `kleod:CountCollectedGems` and
      // `kleod:CheckWorldCompletion`, neither with a `switch` at all. Telling the two apart needs
      // an L3 fact (did recovery produce a grouped arm?) at a raise-level hook, which is a level
      // inversion; the fan is the price instead. NO ABLATION PAIR IS QUOTED HERE: the artifact
      // carries only the with-axis score, so half a refreshed pair would manufacture a delta
      // across two bases — re-run the ablation to price it.
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
        let inferredSymbols = new Map<string, SymbolInfo>();
        let orderLicensed: ReadonlySet<string> = new Set<string>();
        try {
          // A NON-EMPTY SUFFIX IS WHAT NEEDS ITS OWN COPY, the catch below's spelling: naming the
          // flags here would leave a fourth axis sharing the primary's already-mutated `base`.
          fn = lv.suffix === '' ? base : frontend.lift(name, asm, target, prototypes, opts.asmData, sv.symbols);
          if (lv.narrow && !narrowToSetupArgs(fn)) {
            continue; // nothing to cut after all — the base lift's own candidates already cover it
          }
          verify(fn);
          // This variant's OWN array-shape evidence, off its own lifted fn (a symbol map promotes
          // numeric pool words to `gaddr`, so the `/raw-globals` arm genuinely answers differently).
          //
          // NEVER A NAME THE PROJECT MAP KNOWS, and the filter is here rather than left to
          // structure()'s map-first lookup because THE `/raw-globals` ARM STRUCTURES WITH NO MAP
          // AND DECLARES WITH ONE. `declSymbols` is probe-derived and map-last (the map wins every
          // name it knows), so on an asm whose pool NAMES its globals the raw arm could spell a
          // subscript off THIS function's strides — `gFoo[i][j]`, inner extent 2 — while the
          // declaration beside it came from the map — `extern u32 gFoo[][8];` — and the emitted C
          // would stride by 8. Compiling, and the wrong address. One name the map describes is
          // one name this derivation does not claim, on either arm.
          //
          // AND NEVER A SHAPE THE DECLARATION BLOCK WILL NOT CARRY, which is the same hazard one
          // step further out. `declSymbols` is built ONCE, off the probe's lift; this map is built
          // per variant, off the variant's own. Where the two lifts disagree about a name the map
          // does NOT know, the map-precedence delete above says nothing and the raw arm would
          // again spell from one shape and declare from another. So the test is not "the map
          // knows this name" but "whatever will be DECLARED for this name says the same thing" —
          // a name the two answer differently keeps the cast form, which needs no declaration.
          inferredSymbols = inferGlobalArrays(fn, target);
          // The ORDER half, off the same variant lift. NO map-precedence filter, and the
          // asymmetry is the point: a shape is a DECLARATION, so a name the map describes must
          // not be spelled from this function's strides — a licence declares nothing, and the
          // spelling it enables keeps the cast (`(T *)&gSym`), which is byte-correct under any
          // declaration. A map that names the symbol an array takes the access to a bare `var`
          // base anyway, which carries no licence: the two never meet.
          orderLicensed = orderLicensedGlobals(fn, target);
          for (const [n, si] of [...inferredSymbols]) {
            if (baseOpts.symbols?.has(n) === true || !sameDerivedShape(declSymbols.get(n), si)) {
              inferredSymbols.delete(n);
            }
          }
          applyIdiomPatterns(fn, target, opts.patterns);
          // The shared tower spine (pipeline.ts). TWO differences from `decompile()`, both passed
          // here: the signedness pin, injected between pre-recovery and recoverTypes via the
          // `beforeRecover` hook, and the `pre.shortCircuit` connective owner, which `decompile()`
          // leaves at its default. Stated in full so this copy and pipeline.ts's cannot silently
          // diverge again — a third argument added here is a third line in both.
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
          opts.onLeverError?.(name + lv.suffix, firstLine(e));
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
              ...(inferredSymbols.size ? { inferredSymbols } : {}),
              ...(orderLicensed.size ? { orderLicensedGlobals: orderLicensed } : {}),
              preserveDivergentBranchSense: s.sense,
              negateJoinedBranchSense: s.join ? !defSense : defSense,
              ...(s.flipSites ? { branchSenseFlipSites: s.flipSites } : {}),
              anchorConstCopies: s.anchor,
              anchorLoopEntryConsts: s.entry,
              spellBitfieldMembers: s.bitfields,
              spellPtrMemberElements: s.ptrElems,
              spellDeclaredSubscripts: s.declRank,
              ...STRUCTURING_AXES.reduce((acc, ax) => ({ ...acc, ...ax.options(s[ax.flag]) }), {}),
            });
          } catch (e) {
            if (lv.suffix === '' && isBaseAxisPoint(s)) {
              throw e; // the base lift's base axes keep their behavior: a failure aborts the row
            }
            // Recorded for EVERY dropped variant: a candidate with more axes on looks its siblings
            // up by stripping one axis at a time, and the stripped key can itself carry the other.
            droppedPrimary.add(s.suffix);
            // an anchored variant that fails structuring or its contracts is a dropped lever, never
            // an aborted enumeration — same rule as respell below
            opts.onLeverError?.(name + lv.suffix + s.suffix, firstLine(e));
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
            opts.onTreeDeduped?.();
            continue;
          }
          seenTrees.add(treeKey);
          // The row's OWN tree, so this is the one call whose backend refusal is the row's cause.
          const primary = fanOut(sfn);
          const spellings = primary.spellings;
          if (primary.emit) {
            lastEmitError = primary.emit.error;
          }
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
              assertNoOrphanedLocals(sfn, made);
              // A backend refusal on this REWRITTEN tree is not a refusal of the row's own
              // spelling, so it never becomes the row's stated cause: `FanResult.emit` is dropped
              // here and only the primary call above records one.
              //
              // It is reported instead through `onLeverError` under `pf.suffix`, which is what
              // `fanOut`'s second argument is for: a primary emit refusal does not THROW —
              // `fanOut` returns it — so the `catch` below never sees it, and under the bare
              // function name it would read as a refusal of the primary spelling while the lever's
              // whole half of the fan was deleted.
              const fanned = fanOut(made, pf.suffix).spellings;
              for (const sp of fanned) {
                spellings.push({ ...sp, suffix: `${pf.suffix}${sp.suffix}` });
              }
            } catch (e) {
              opts.onLeverError?.(`${name}${pf.suffix}`, firstLine(e));
            }
          }
          for (const sp of spellings) {
            const source = sp.source;
            // Collapse a spelling that produced identical source (a function with no divergent `if`
            // structures the same either way): no point scoring a duplicate spelling. Deduping the
            // WHOLE emitted set (not just scored survivors) is equivalent — an identical source
            // scores identically, so it can never change `best` — and it keeps the candidate set to
            // the genuinely distinct spellings.
            //
            // THE PUBLISHED LABEL IS THEREFORE NOT AN ATTRIBUTION, and every argument in this tree
            // that counts winning labels is unsound to exactly that extent. The label kept is the
            // FIRST route's; the later routes are discarded, silently and by design. Adding one
            // roster row renamed 21 agbcc rows whose emitted source sets were byte-identical —
            // a CANDIDATE-SET census (whole fan unchanged, some candidate relabelled), which is a
            // different population from a WINNING-label census: over published winners the same
            // row moved 5 labels, 2 of them renames.
            //
            // AND A LABEL CENSUS CANNOT EVEN SEPARATE A RENAME FROM A RESPELLING. Of those 5
            // winners, THREE changed the source they publish — `synthetic:unfoldpark`
            // (402 → 397 bytes, score 9 → 0), `kleod:ConfigureEntityBehavior` (3677 → 3993,
            // 233 → 230) and `synthetic:livepark` (337 → 346, both MATCH) — while
            // `synthetic:foldpark` and `kleod:DecompressDma` are byte-identical renames. The two
            // look the same from here; only the emitted SOURCE tells them apart (`bench diff`
            // publishes that field, `bench regression` does not).
            //
            // So "N rows win under this family" bounds nothing: a family can win zero labels and
            // still be the only route to a source, and a family can win five and have introduced
            // three. Price a family by ABLATING it and re-running the rows
            // (LIVEBASE_BLOCK_GATES carries the recipe); a zero census is not a death certificate,
            // and a nonzero one is not a mechanism.
            // THE SEAM FIX IS BOOKED AND NOT BUILT: keep the losing producers on the surviving
            // candidate (`label` plus an `alsoReachedBy: string[]`) and a census by mechanism
            // becomes one. It is not free — every consumer that reads `label` as the derivation
            // would have to say which it means, and the published `candidateLabel` must not
            // change — so build it when a round needs the census, not before. Until then the only
            // sound census is an ablation.
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
    throw new Error(`no spellable candidate for '${name}': ${firstLine(lastEmitError ?? 'no candidate produced')}`, {
      cause: lastEmitError,
    });
  }
  return out;
}

/** Score each candidate with the injected `scoreFn` and rank by score (lowest first). A candidate
 *  whose `scoreFn` throws — e.g. its C failed to compile — is SKIPPED so it cannot sink a sibling
 *  that compiles and matches; only if EVERY candidate fails is the failure surfaced. Synchronous:
 *  the scorer must be sync (the cli/Node objdiff path). The webapp scores asynchronously and does
 *  its own await-loop over `enumerateCandidates`, reusing this module's `Candidate`/`RankedResult`
 *  types but not this driver. */
export function rankBy<S extends { score: number; rows?: number }>(
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
        withheld.push({
          label: c.label,
          score: score.score,
          ...(score.rows === undefined ? {} : { rows: score.rows }),
          why,
        });
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
 *  ordinary memory that the asm does not support — over the bench, counting the word
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
 *  A WITHIN-GROUP tie-break over two spellings of ONE function, and deliberately NARROWER than
 *  the published readability metric (apps/benchmark/src/eval/quality.ts `casts`): it counts the
 *  decomp SCALAR typedef vocabulary only — `(u8)` … `(s32)` — so a pointer, struct or C-keyword
 *  cast is not read as noise, those being structural spellings a candidate does not choose.
 *
 *  ONE exemption, the `&` form: `(u32)&gSym` / `(s32)&gSym` is the CORRECT source spelling of
 *  integer arithmetic on a link-time address, which decomp projects write themselves, and
 *  counting it would penalize precisely the named spelling this ranking is supposed to prefer.
 *
 *  NOT a second copy of the published metric, and it must not be read as one: that one counts a
 *  wider vocabulary and exempts more, so a number here is not comparable to a number there. What
 *  the two share is only the direction — fewer casts reads better.
 *
 *  Deterministic, and total on any string. */
function castCount(source: string): number {
  const all = source.match(/\((?:u|s)(?:8|16|32)\)/g)?.length ?? 0;
  const addr = source.match(/\((?:u|s)32\)\s*&/g)?.length ?? 0;
  return all - addr;
}

/** First line of whatever a lever, a backend or the scorer threw — the compiler's own diagnostic,
 *  not a stack. TOTAL on any value, including a non-Error throw, so no caller has to re-spell the
 *  `instanceof` test; a caller wanting a word for "nothing was thrown" supplies it at the call. */
function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}
