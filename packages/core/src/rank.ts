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
import { assertDerefsTyped, assertResolved } from './contracts';
import type { AsmData } from './frontend/asmdata';
import { frontendFor } from './frontend/registry';
import { hasSetupArgsNarrowing, narrowToSetupArgs } from './frontend/ssa';
import { globalCellOf } from './ir/alias';
import { Fn, type Op, type Value, defOpMap, successorsOf } from './ir/core';
import { T } from './ir/types';
import { verify } from './ir/verify';
import { materializeArgBases } from './l3/argbase';
import type { LanguageBackend, SFn } from './l3/ast';
import { LIVEBASE_GATES, hoistReusedGlobalBases } from './l3/basecse';
import { armDisjointCandidates, coalesceCandidates } from './l3/coalesce';
import { initFirstGuards } from './l3/initfirst';
import { mulFirstSums } from './l3/mulfirst';
import { nearBaseClusters } from './l3/nearbase';
import { parkParamsFirst } from './l3/parkfirst';
import { pollGuards, pollReads } from './l3/pollguard';
import { registerishSpellings } from './l3/regspell';
import { reindexWalks } from './l3/reindex';
import { hoistScopedBases } from './l3/scopebase';
import { type SymbolRef, collectSymbolRefs } from './l3/symbol-refs';
import { volatilePtrLocals, volatileSubsetCandidates } from './l3/volatileptr';
import { RewritePattern } from './pattern/engine';
import { applyIdiomPatterns, raiseRecovered, structureChecked } from './pipeline';
import { type Prototypes, prototypesFromSymbols } from './proto';
import { runPreRecovery } from './raise/pre-recovery';
import { recoverTypes } from './raise/recover';
import { hasDerivedReadHome, hasHomeableSharedAddress, hasLoopSharedPureValue } from './structure/analysis';
import { type SymbolMap, symbolsByName } from './symbols';
import { type TargetDescription, structureOptionsFor } from './target';

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
  flag: 'reread' | 'inplace' | 'mergeNames' | 'addrHome' | 'exprHome' | 'derivedHome' | 'unsCmp';
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
  // homeLoopExprs): a pure value defined outside a loop with 2+ distinct consumers inside it
  // materializes into a local carrying the value's recovered type — the register the compiler
  // holds across the iterations (`u32 size = 16 << t;` driving a loop bound, a product and a
  // shift), where the default re-derives per use. Gated per symbol variant like `/addr-home`
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
];

/** The signedness of the entry parameters — the classic ambiguity asm cannot resolve.
 *
 * Struct LAYOUT is recovered structurally (raise/structs.ts), not as a scored axis here:
 * `->field_N` and `[idx]` compile identically, so the differ cannot referee between them. */
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

const SIGN_CANDS = [
  { label: 'unsigned', signed: false },
  { label: 'signed', signed: true },
];

// A recovered POINTER/aggregate param must NOT be signedness-pinned: pinning a still-`unknown`
// pointer param to a scalar int BEFORE recovery blocks pointer recovery and emits uncompilable
// `*(s32)`. Only genuine scalars carry the signedness axis.
const NO_PIN_KINDS = new Set(['ptr', 'struct', 'array']);

/** Pin every SCALAR entry param (index not in `ptrIdx`) to the candidate signedness, before recovery. */
function pinScalarParams(fn: Fn, signed: boolean, ptrIdx: Set<number>): void {
  fn.blocks[0].params.forEach((p, i) => {
    if (ptrIdx.has(i)) {
      return;
    }
    if (p.type.kind === 'unknown' || p.type.kind === 'int') {
      p.type = signed ? T.s(32) : T.u(32);
    }
  });
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
  /** the map-derived VALUE references this candidate's tree contains — what the scoring
   *  layer's declaration synthesis renders. DERIVED, never carried: computed once from the
   *  exact tree this candidate's source was emitted from, at the moment the candidate is
   *  finalized (l3/symbol-refs.ts — no pipeline stage caches refs, so they cannot go stale).
   *  Present on EVERY spelling variant that names mapped symbols — including '/raw-globals',
   *  whose tree still names pool/reloc-derived globals (it only drops the map's shaped
   *  SPELLINGS). Absent without a map — synthesis then has nothing to do. */
  symbolRefs?: SymbolRef[];
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

export interface RankedResult<S> {
  best: Scored<S>; // lowest score
  candidates: Scored<S>[]; // sorted best (lowest) first
  /** candidates whose scoreFn threw — empty when every spelling built */
  dropped: DroppedCandidate[];
}

/** Emit the DISTINCT type/branch-sense candidate spellings for `name` — PURE, no scoring.
 *  The ONE difference from `decompile()` is the signedness pin, injected between pre-recovery and
 *  recoverTypes via the `beforeRecover` hook. Duplicate sources are collapsed so the scorer never
 *  recompiles an identical spelling. */
export function enumerateCandidates(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: EnumerateOptions = {},
): Candidate[] {
  const backend = opts.backend ?? cBackend;
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
  const senseAnchor = [
    { suffix: '', sense: defSense, anchor: false, bitfields: true },
    { suffix: '/flip-branch', sense: !defSense, anchor: false, bitfields: true },
    { suffix: '/defsite', sense: defSense, anchor: true, bitfields: true },
    { suffix: '/flip-branch/defsite', sense: !defSense, anchor: true, bitfields: true },
  ];
  // `/flip-join` — the JOINED-if sibling of `/flip-branch` (structure.ts
  // negateJoinedBranchSense): a reconverging two-armed if reads the same fall-through-is-then
  // layout evidence the divergent case does, and which sense the source spelled is just as
  // ambiguous — so both are emitted and the differ referees. Crossed with the pair above
  // (divergent and joined ifs are disjoint sets, so the axes are independent); a function with
  // no two-armed joined if emits identical source and the dedup collapses it before any compile.
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
  // Probe: recover ONCE with no signedness pin, to learn which entry params are pointers/aggregates
  // so they are excluded from the signedness axis (see NO_PIN_KINDS). One extra lift+recover, no
  // compile. (The probe deliberately stops after recoverTypes — it only reads the param KINDS, so
  // the totality contract / return-sinking of the full spine are not run on it.)
  const probe = frontend.lift(name, asm, target, prototypes, opts.asmData, opts.symbols);
  verify(probe);
  applyIdiomPatterns(probe, target, opts.patterns);
  runPreRecovery(probe, target, () => verify(probe));
  recoverTypes(probe);
  const ptrIdx = new Set<number>(probe.blocks[0].params.flatMap((p, i) => (NO_PIN_KINDS.has(p.type.kind) ? [i] : [])));
  // Access facts for name-only symbol declarations (see bareGlobalAccessFacts) — derived once
  // from the probe: widths/offsets are lift-time facts, identical across every candidate.
  const accessFacts = opts.symbols ? bareGlobalAccessFacts(probe) : new Map<string, never>();
  // The axis chain, derived from STRUCTURING_AXES: each admitted axis doubles the list, OFF arm
  // first — order is load-bearing for the dropped-primary skip below (every OFF sibling
  // enumerates before its ON twin, so a twin's stripped-key lookup always finds a sibling that
  // has already run or been condemned). Each per-axis rationale lives on its table entry; both
  // arms are always emitted and the differ referees, never a default — the dedup below collapses
  // a pair wherever the axis changed nothing.
  const probeDefs = defOpMap(probe);
  type AxisCand = (typeof bitfieldCands)[number] & Record<StructuringAxis['flag'], boolean>;
  let axisCands: AxisCand[] = bitfieldCands.map((s) => ({
    ...s,
    reread: false,
    inplace: false,
    mergeNames: false,
    addrHome: false,
    exprHome: false,
    derivedHome: false,
    unsCmp: false,
  }));
  for (const ax of STRUCTURING_AXES) {
    if (ax.probeGate === undefined || ax.probeGate(probe, probeDefs)) {
      axisCands = [
        ...axisCands,
        ...axisCands.map((s) => ({ ...s, suffix: `${s.suffix}${ax.suffix}`, [ax.flag]: true }) as AxisCand),
      ];
    }
  }

  const seen = new Set<string>();
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
  const refsOf = (tree: SFn): { symbolRefs?: SymbolRef[] } => {
    const refs = baseOpts.symbols
      ? collectSymbolRefs(tree.body, baseOpts.symbols, tree.name).map((r) => {
          // name-only symbols carry the IR-derived access facts — the width authority
          // for their synthesized declaration (shaped symbols keep the map's truth)
          const access = r.info.shape === undefined ? accessFacts.get(r.name) : undefined;
          return access ? { ...r, access } : r;
        })
      : [];
    return refs.length ? { symbolRefs: refs } : {};
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
    for (const cand of SIGN_CANDS) {
      const base = frontend.lift(name, asm, target, prototypes, opts.asmData, sv.symbols);
      // `/setup-args` — pass a prototype-less callee only what the CALLING BLOCK set up; which of
      // the two readings the source spelled is genuinely ambiguous, and frontend/ssa.ts
      // narrowToSetupArgs carries the argument for why the differ is what settles it.
      //
      // A LIFT VARIANT, in the same product position as the signedness pin and the symbol-map
      // spelling — not a re-spelling lever under the POLICY note below. Dropping an argument
      // changes the IR every structuring axis then reads: the value the argument carried loses a
      // consumer, so what materializes changes with it, and `kleod:ReadKeyInput` needs the
      // narrowed lift's `/flip-join/derived-home` spelling, which neither side reaches alone.
      // Only spellings the narrowing actually changed reach a compiler: one that changes nothing
      // downstream emits the base spelling's source and the dedup collapses it, and a DECLARED
      // arity records nothing and enumerates no variant at all.
      const liftVariants: { suffix: string; narrow: boolean }[] = hasSetupArgsNarrowing(base)
        ? [
            { suffix: '', narrow: false },
            { suffix: '/setup-args', narrow: true },
          ]
        : [{ suffix: '', narrow: false }];
      for (const lv of liftVariants) {
        let fn: Fn;
        try {
          fn = lv.narrow ? frontend.lift(name, asm, target, prototypes, opts.asmData, sv.symbols) : base;
          if (lv.narrow && !narrowToSetupArgs(fn)) {
            continue; // nothing to cut after all — the base lift's own candidates already cover it
          }
          verify(fn);
          applyIdiomPatterns(fn, target, opts.patterns);
          // The shared tower spine (pipeline.ts) — the candidate's ONE difference from decompile()
          // is the signedness pin, injected between pre-recovery and recoverTypes via the
          // beforeRecover hook.
          raiseRecovered(fn, target, { beforeRecover: () => pinScalarParams(fn, cand.signed, ptrIdx) });
        } catch (e) {
          if (!lv.narrow) {
            throw e; // the base lift keeps its behavior: a raising failure aborts the row
          }
          // A dropped lever, never an aborted enumeration — the same posture as `respell`.
          opts.onLeverError?.(`${name}/setup-args`, e instanceof Error ? e.message.split('\n')[0] : String(e));
          continue;
        }
        // the per-variant axis gates, on THIS variant's lifted fn — see the table doc
        const variantOff = STRUCTURING_AXES.filter((ax) => ax.variantGate !== undefined && !ax.variantGate(fn));
        const variantCands = axisCands.filter((s) => variantOff.every((ax) => !s[ax.flag]));
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
              negateJoinedBranchSense: s.join,
              anchorConstCopies: s.anchor,
              spellBitfieldMembers: s.bitfields,
              ...STRUCTURING_AXES.reduce((acc, ax) => ({ ...acc, ...ax.options(s[ax.flag]) }), {}),
            });
          } catch (e) {
            if (!lv.narrow && !s.anchor && !s.join && s.bitfields && STRUCTURING_AXES.every((ax) => !s[ax.flag])) {
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
          // The walk→index re-spelling (l3/reindex.ts) is a THIRD lever on the same footing as
          // signedness and branch sense: whether the source spelled `*p; p++` or `arr[i]` is
          // genuinely ambiguous from asm (compilers strength-reduce the latter into the former), so
          // when a loop re-spells, BOTH representations are emitted and the differ referees. The
          // re-spelling passes the same boundary contracts as the primary; one that fails them is
          // dropped here — never scored, never able to win.
          const spellings: { suffix: string; source: string; symbolRefs?: SymbolRef[] }[] = [
            { suffix: '', source: backend.emit(sfn), ...refsOf(sfn) },
          ];
          // Representation re-spellings — each a lever on the same footing as signedness/branch sense,
          // each guarded: it must pass the same boundary contracts as the primary AND emit (a backend
          // that declines by throwing — Pascal loud-fails unspellable shapes — drops the candidate,
          // never aborts the enumeration). A dropped re-spelling loses nothing: the primary remains.
          //
          // POLICY: re-spellings derive from the BASE spelling only — levers do not compose by
          // default. THREE product mechanisms are sanctioned, each with its own admission bar —
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
          // same argument, not just a row. And a specific LEVER PAIRING is admitted when a row
          // demands it AND the joint spelling is reachable from neither lever alone (the
          // /livebase × /indexed, × /nearbase, and × /coalesce pairings below, each with its
          // demanding row); anything else stays un-composed. And a lever must
          // PRESERVE SEMANTICS by construction: the differ referees byte-exactness (a wrong candidate
          // can never fake a score-0 match), but on a NONMATCH row the best-scoring source is shown
          // to the user — a semantically-wrong re-spelling there is plausible-but-wrong output, the
          // defect class this project exists to avoid. Hence each lever's decline-over-approximate
          // gates, adversarially audited.
          // Takes a THUNK, so the lever's own computation is inside the try too. A lever that threw
          // from the pass itself — rather than from the contracts or the backend — would escape and
          // abort the whole enumeration for this row, primary included: the one way a lever can cost
          // a match. Making that structural rather than per-call-site means no lever can opt out.
          const respell = (suffix: string, make: () => SFn | null | undefined): void => {
            try {
              const alt = make();
              if (!alt) {
                return; // the lever declined to fire — no candidate, not a duplicate of the primary
              }
              assertResolved(alt);
              assertDerefsTyped(alt);
              spellings.push({ suffix, source: backend.emit(alt), ...refsOf(alt) });
              // STATEMENT-SHAPE products, derived onto EVERY spelling — the second sanctioned
              // product mechanism (the POLICY note above carries the admission argument). Each is
              // a statement-order/shape fact orthogonal to representation; subsets compose in the
              // fixed order below. A shape that never fires declines and costs nothing.
              if (!SHAPE_PRODUCTS.some(({ suffix: sx }) => suffix.includes(sx))) {
                for (const subset of SHAPE_SUBSETS) {
                  const shaped = applyShapes(subset, alt);
                  if (shaped !== null) {
                    assertResolved(shaped.out);
                    assertDerefsTyped(shaped.out);
                    spellings.push({
                      suffix: `${suffix}${shaped.suffix}`,
                      source: backend.emit(shaped.out),
                      ...refsOf(shaped.out),
                    });
                  }
                }
              }
            } catch (e) {
              // A throwing lever, a contract failure, or an unspellable re-spelling: keep the primary.
              // REPORTED, not swallowed. `dropped` (below) records only spellings the SCORER refused,
              // so without this a lever that fails here vanishes with no trace — indistinguishable
              // from one that correctly declined, which is exactly the hidden failure
              // DroppedCandidate exists to surface.
              opts.onLeverError?.(name + suffix, e instanceof Error ? e.message.split('\n')[0] : String(e));
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
              opts.onLeverError?.(name + label, e instanceof Error ? e.message.split('\n')[0] : String(e));
            }
          }
          respell('/argbase', () => materializeArgBases(sfn));
          // `/volatile` — declare a pointer local holding a NUMERIC address as pointing to volatile
          // data (l3/volatileptr.ts). A raw constant has no declaration anywhere, so the original
          // qualifier is not derivable — and it is codegen-visible (a volatile MEM is barred from
          // motion, which lands the allocator on different homes). Both spellings are emitted and
          // the differ referees.
          respell('/volatile', () => volatilePtrLocals(sfn));
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
              opts.onLeverError?.(name + label, e instanceof Error ? e.message.split('\n')[0] : String(e));
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
          const livebase = (): SFn | null => {
            const r = hoistReusedGlobalBases(sfn, LIVEBASE_GATES);
            return r === sfn ? null : r;
          };
          respell('/livebase', livebase);
          const livebaseVolatile = (): SFn | null => {
            const r = livebase();
            if (!r) {
              return null;
            }
            // Only the locals THIS lever created (a name-diff, not a positional slice, so a pass
            // that ever reorders locals cannot silently empty the set) — see the POLICY note above.
            const before = new Set(sfn.locals.map((l) => l.name));
            const created = new Set(r.locals.filter((l) => !before.has(l.name)).map((l) => l.name));
            return volatilePtrLocals(r, created);
          };
          respell('/livebase/volatile', livebaseVolatile);
          enumerate('/livebase/volatile', livebase, (r) => {
            const before = new Set(sfn.locals.map((l) => l.name));
            return volatileSubsetCandidates(r, new Set(r.locals.filter((l) => !before.has(l.name)).map((l) => l.name)));
          });
          // The livebase × indexed PAIRINGS — the third sanctioned product kind (see POLICY):
          // row-demanded, and the joint spelling is reachable from neither lever alone (the
          // frame-copy + DMA shape).
          respell('/livebase/indexed', () => {
            const r = livebase();
            return r ? reindexWalks(r) : null;
          });
          respell('/livebase/volatile/indexed', () => {
            const r = livebaseVolatile();
            return r ? reindexWalks(r) : null;
          });
          // `/mulfirst` — product-first commutative sums (l3/mulfirst.ts): IDO/mwcc schedule the
          // independent operand's load above the product's mflo/mullw, so def order re-spells a
          // product-first source as load-first. Both orders are emitted; the differ referees.
          respell('/mulfirst', () => mulFirstSums(sfn));
          // `/nearbase` — neighbor absolute addresses derive from one shared base local
          // (l3/nearbase.ts): one object's cells anchored as separate pool constants re-spell as
          // offsets off its lowest address, within the target's declared derivation reach. Both
          // spellings are emitted; the differ referees.
          const nearSpan = target.compilerBehaviors.nearBaseSpan;
          respell('/nearbase', () => (nearSpan !== undefined ? nearBaseClusters(sfn, nearSpan) : null));
          // The livebase × nearbase PAIRINGS — the same admission as livebase × indexed above:
          // the volatile triple is the row-demanded one, and the joint spelling is reachable from
          // neither lever alone (a neighbor-cell object and a multi-index MMIO block in one
          // function — each lever's constants are invisible to the other's model); the plain
          // sibling rides for symmetry with /livebase/indexed.
          respell('/livebase/nearbase', () => {
            const r = livebase();
            return r && nearSpan !== undefined ? nearBaseClusters(r, nearSpan) : null;
          });
          respell('/livebase/volatile/nearbase', () => {
            const r = livebaseVolatile();
            return r && nearSpan !== undefined ? nearBaseClusters(r, nearSpan) : null;
          });
          // The livebase × coalesce PAIRINGS — same admission again: the volatile triple is the
          // row-demanded one, the joint spelling reachable from neither lever alone (an MMIO base
          // worth homing and a counter shared across both arms of one if, in one function); the
          // plain sibling rides for symmetry.
          // ARM-DISJOINT merges only: the demanding row's shared counter is that class, and the
          // span-model merges already ride the plain /coalesce label — pairing them too would
          // multiply candidates with no row behind it.
          enumerate('/livebase/coalesce', livebase, armDisjointCandidates);
          enumerate('/livebase/volatile/coalesce', livebaseVolatile, armDisjointCandidates);
          // `/parkfirst` — incoming-argument parks lead the entry prefix (l3/parkfirst.ts): the
          // park's `mov` lifts to pure SSA aliasing, so its position is unrecoverable and the
          // default order is emission's. Both orders are emitted; the differ referees.
          respell('/parkfirst', () => parkParamsFirst(sfn));
          // the register-copy spelling (l3/regspell.ts): 0–3 variants (base; tail assign-back reusing
          // the dead value var; tail assign-back into a fresh var — the tail choice is allocator-
          // ambiguous, so both are ranked)
          const REGCOPY_LABELS = ['/regcopy', '/regcopy-ret', '/regcopy-ret-fresh'];
          registerishSpellings(sfn).forEach((alt, i) => respell(REGCOPY_LABELS[i] ?? `/regcopy-${i}`, () => alt));
          for (const sp of spellings) {
            const source = sp.source;
            // Collapse a spelling that produced identical source (a function with no divergent `if`
            // structures the same either way): no point scoring a duplicate spelling. Deduping the
            // WHOLE emitted set (not just scored survivors) is equivalent — an identical source
            // scores identically, so it can never change `best` — and it keeps the candidate set to
            // the genuinely distinct spellings.
            if (seen.has(source)) {
              continue;
            }
            seen.add(source);
            out.push({
              label: `${cand.label}${lv.suffix}${s.suffix}${sp.suffix}${sv.suffix}`,
              source,
              group: svIndex,
              ...(sp.symbolRefs ? { symbolRefs: sp.symbolRefs } : {}),
            });
          }
        }
      }
    }
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
  let lastScoreErr: unknown = null;
  candidates.forEach((c, order) => {
    try {
      results.push({ ...c, order, score: scoreFn(c.source, symbol, c) });
    } catch (e) {
      lastScoreErr = e;
      dropped.push({ label: c.label, error: firstLine(e) });
    }
  });
  if (results.length === 0) {
    throw new Error(`no scorable candidate for '${symbol}': ${firstLine(lastScoreErr)}`, { cause: lastScoreErr });
  }
  results.sort(compareScored);
  return { best: results[0], candidates: results.map(({ order: _order, ...c }) => c), dropped };
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
 *  CAST COUNT next, and only WITHIN a group. A wrong signedness pin is what manufactures casts —
 *  the C backend has to cast a shift operand back to the signedness the machine op needs, so
 *  pinning `u32` on a genuinely-signed parameter buys `s32 f(u32 a0) { return (s32)a0 >> a1; }`
 *  for the same bytes as `s32 f(s32 a0) { return a0 >> a1; }`. Before the backend synthesized that
 *  cast the wrong pin simply lost on score; now it ties, and enumeration order alone would
 *  silently install the noisier spelling.
 *
 *  ENUMERATION ORDER last, which makes this a strict total order (indices are unique) and the
 *  result deterministic. Spelled explicitly rather than leaning on Array#sort's stability, which
 *  would make each preference an accident of two unrelated decisions. */
export function compareScored<S extends { score: number }>(
  a: Candidate & { score: S; order: number },
  b: Candidate & { score: S; order: number },
): number {
  return (
    a.score.score - b.score.score || a.group - b.group || castCount(a.source) - castCount(b.source) || a.order - b.order
  );
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
