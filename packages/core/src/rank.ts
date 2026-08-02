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
import { Fn, type Value, defOpMap } from './ir/core';
import { T } from './ir/types';
import { verify } from './ir/verify';
import { materializeArgBases } from './l3/argbase';
import type { LanguageBackend, SFn } from './l3/ast';
import { registerishSpellings } from './l3/regspell';
import { reindexWalks } from './l3/reindex';
import { hoistScopedBases } from './l3/scopebase';
import { type SymbolRef, collectSymbolRefs } from './l3/symbol-refs';
import { RewritePattern } from './pattern/engine';
import { applyIdiomPatterns, raiseRecovered, structureChecked } from './pipeline';
import { type Prototypes, prototypesFromSymbols } from './proto';
import { runPreRecovery } from './raise/pre-recovery';
import { recoverTypes } from './raise/recover';
import { type SymbolMap, symbolsByName } from './symbols';
import { type TargetDescription, structureOptionsFor } from './target';

/** The signedness of the entry parameters — the classic ambiguity asm cannot resolve.
 *
 * Struct LAYOUT is recovered structurally (raise/structs.ts), not as a scored axis here:
 * `->field_N` and `[idx]` compile identically, so the differ cannot referee between them. */
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
}

/** One distinct candidate spelling (a signedness × branch-sense lever combination), emitted to source. */
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
  const senseCands = [
    { suffix: '', sense: defSense },
    { suffix: '/flip-branch', sense: !defSense },
  ];
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

  const seen = new Set<string>();
  const out: Candidate[] = [];
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
      const fn = frontend.lift(name, asm, target, prototypes, opts.asmData, sv.symbols);
      verify(fn);
      applyIdiomPatterns(fn, target, opts.patterns);
      // The shared tower spine (pipeline.ts) — the candidate's ONE difference from decompile() is the
      // signedness pin, injected between pre-recovery and recoverTypes via the beforeRecover hook.
      raiseRecovered(fn, target, { beforeRecover: () => pinScalarParams(fn, cand.signed, ptrIdx) });
      for (const s of senseCands) {
        // structure() reads `fn` and produces a fresh SFn (it does not mutate `fn`), so both branch
        // senses structure the same recovered function without re-lifting.
        const sfn = structureChecked(fn, { ...svOpts, preserveDivergentBranchSense: s.sense });
        // The walk→index re-spelling (l3/reindex.ts) is a THIRD lever on the same footing as
        // signedness and branch sense: whether the source spelled `*p; p++` or `arr[i]` is
        // genuinely ambiguous from asm (compilers strength-reduce the latter into the former), so
        // when a loop re-spells, BOTH representations are emitted and the differ referees. The
        // re-spelling passes the same boundary contracts as the primary; one that fails them is
        // dropped here — never scored, never able to win.
        // Each spelling's symbol refs are DERIVED from its own final tree right where the
        // spelling is emitted — the single point a candidate comes into existence. No pipeline
        // stage carries refs (SFn has no such field), so a future l3 pass that rewrites the tree
        // can never leave a stale ref behind: whatever tree reaches emit is the tree the refs
        // describe, by construction. Collected against the FULL name-keyed map for EVERY
        // spelling variant — the '/raw-globals' sibling drops the map's shaped SPELLINGS, but
        // its tree still NAMES pool/reloc-derived globals (ARM `.word gSym`, MIPS `%lo(gSym)`),
        // and those references need declarations in the self-declared scoring world exactly
        // like the named variant's (without them every raw sibling fails to compile there,
        // and the eval-winning raw candidate becomes unreproducible outside project headers).
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
        const spellings: { suffix: string; source: string; symbolRefs?: SymbolRef[] }[] = [
          { suffix: '', source: backend.emit(sfn), ...refsOf(sfn) },
        ];
        // Representation re-spellings — each a lever on the same footing as signedness/branch sense,
        // each guarded: it must pass the same boundary contracts as the primary AND emit (a backend
        // that declines by throwing — Pascal loud-fails unspellable shapes — drops the candidate,
        // never aborts the enumeration). A dropped re-spelling loses nothing: the primary remains.
        //
        // POLICY: re-spellings derive from the BASE spelling only — levers do not compose
        // (an /indexed + /regcopy product is deferred until a row demands it). And a lever must
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
          } catch {
            // a throwing lever, a contract failure, or an unspellable re-spelling: keep the primary
          }
        };
        // `/argbase` — name a call's argument bases before the call (l3/argbase.ts). A lever on the
        // same footing as the others: the primary inline spelling stays in the list, so the differ
        // referees and this can never cost a match.
        respell('/argbase', () => materializeArgBases(sfn));
        // `/scopebase` — name a reused global base at the INNERMOST scope holding its uses
        // (l3/scopebase.ts). Distinct from basecse's function-top hoist, which the primary already
        // carries: this one fires exactly where that placement would extend a live range the
        // original never had.
        respell('/scopebase', () => hoistScopedBases(sfn));
        respell('/indexed', () => reindexWalks(sfn));
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
            label: `${cand.label}${s.suffix}${sp.suffix}${sv.suffix}`,
            source,
            group: svIndex,
            ...(sp.symbolRefs ? { symbolRefs: sp.symbolRefs } : {}),
          });
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
