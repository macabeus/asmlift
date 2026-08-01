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
import type { LanguageBackend, SFn } from './l3/ast';
import { registerishSpellings } from './l3/regspell';
import { reindexWalks } from './l3/reindex';
import { type SymbolRef, collectSymbolRefs } from './l3/symbol-refs';
import { RewritePattern } from './pattern/engine';
import { applyIdiomPatterns, raiseRecovered, structureChecked } from './pipeline';
import type { Prototypes } from './proto';
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
export interface RankedResult<S> {
  best: Scored<S>; // lowest score
  candidates: Scored<S>[]; // sorted best (lowest) first
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
  const prototypes = opts.prototypes ?? {};
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
  for (const sv of symbolVariants) {
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
        const respell = (suffix: string, alt: SFn): void => {
          try {
            assertResolved(alt);
            assertDerefsTyped(alt);
            spellings.push({ suffix, source: backend.emit(alt), ...refsOf(alt) });
          } catch {
            // contract-failing or unspellable re-spelling: drop it, keep the primary
          }
        };
        const indexed = reindexWalks(sfn);
        if (indexed) {
          respell('/indexed', indexed);
        }
        // the register-copy spelling (l3/regspell.ts): 0–3 variants (base; tail assign-back reusing
        // the dead value var; tail assign-back into a fresh var — the tail choice is allocator-
        // ambiguous, so both are ranked)
        const REGCOPY_LABELS = ['/regcopy', '/regcopy-ret', '/regcopy-ret-fresh'];
        registerishSpellings(sfn).forEach((alt, i) => respell(REGCOPY_LABELS[i] ?? `/regcopy-${i}`, alt));
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
  let lastScoreErr: unknown = null; // a candidate's C that failed to compile; only fatal if ALL do
  candidates.forEach((c, order) => {
    try {
      results.push({ ...c, order, score: scoreFn(c.source, symbol, c) });
    } catch (e) {
      lastScoreErr = e;
    }
  });
  if (results.length === 0) {
    const why =
      lastScoreErr instanceof Error
        ? lastScoreErr.message.split('\n')[0]
        : String(lastScoreErr ?? 'no candidate produced');
    throw new Error(`no scorable candidate for '${symbol}': ${why}`, { cause: lastScoreErr });
  }
  // Score first; ENUMERATION ORDER breaks a tie. That order is meaningful, not incidental:
  // enumerateCandidates emits the symbol-map spellings before their `/raw-globals` siblings, so
  // when both compile to the same bytes the named one wins and the reader gets `gCounter` rather
  // than a bare address. Spelled as an explicit comparator because relying on Array#sort's
  // stability would make the preference an accident of two unrelated decisions.
  results.sort((a, b) => a.score.score - b.score.score || a.order - b.order);
  return { best: results[0], candidates: results.map(({ order: _order, ...c }) => c) };
}
