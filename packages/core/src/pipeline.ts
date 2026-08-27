// asmlift — the library entry point. `decompile(name, asm, target)` runs the raising tower and
// returns structured results: the source, the per-level IR dumps, and diagnostics.
import { cBackend } from './backend/c';
import {
  ContractError,
  assertDerefsTyped,
  assertEffectsPreserved,
  assertLocalsWritten,
  assertResolved,
  assertTypesRecovered,
} from './contracts';
import type { AsmData } from './frontend/asmdata';
import { FrontendUnsupportedError } from './frontend/errors';
import { frontendFor } from './frontend/registry';
import { type Block, type Fn, successorsOf } from './ir/core';
import { print } from './ir/print';
import { T } from './ir/types';
import { VerifyError, verify } from './ir/verify';
import { Expr, LanguageBackend, SFn, Stmt, exprChildren, gapReasonFor, stmtChildren, stmtExprs } from './l3/ast';
import { BASECSE_GATES, hoistBaseLocals } from './l3/basecse';
import { eliminateDeadStores } from './l3/dce';
import { mergeCommonTails } from './l3/tailmerge';
import { DEFAULT_IDIOM_PATTERNS, RewritePattern, applyPattern, dce, patternApplies } from './pattern/engine';
import { type FnProto, type Prototypes, prototypesFromSymbols } from './proto';
import { RaiseUnsupportedError } from './raise/errors';
import { foldEmptyLatches } from './raise/latch';
import { type PreRecoveryPass, runPreRecovery } from './raise/pre-recovery';
import { recoverTypes } from './raise/recover';
import { sinkReturns } from './raise/retsink';
import { StructureError, structure } from './structure/structure';
import { type SymbolMap, symbolsByName } from './symbols';
import { type TargetDescription, structureOptionsFor } from './target';

/** How a gap (a construct asmlift cannot faithfully model) degrades:
 *    "strict"   — throw / `"?"`-sentinel → ContractError. Loud in the PROCESS. The default, and
 *                 what every contract/loud-fail test pins: asmlift knows when it doesn't know.
 *    "annotate" — always emit SOMETHING (the m2c usefulness property), but every gap is loud in
 *                 the ARTIFACT: a localizable gap becomes an undefined ASMLIFT_ERROR("reason", …)
 *                 marker inline; a non-localizable failure (unliftable control flow, a broken
 *                 invariant) degrades to a stub carrying the reason + the original asm as a
 *                 comment. Either way the source cannot compile un-acknowledged, and the gaps are
 *                 ALSO returned as structured `diagnostics` for the harness / self-improve loop. */
export type OnGap = 'strict' | 'annotate';

/** One machine-readable gap: which stage declined and why. The comments/markers in the emitted
 *  source are the human projection of these entries — a tool should read THIS, not parse text. */
export interface Diagnostic {
  stage: 'lift' | 'raise' | 'structure' | 'contract' | 'verify' | 'internal';
  reason: string;
}

export interface DecompileOptions {
  backend?: LanguageBackend;
  /** idiom patterns applied at L1. DEFAULTS to `DEFAULT_IDIOM_PATTERNS` (every idiom asmlift
   *  owns, each `{compilers}`-gated so it self-selects per target). Pass an explicit list to
   *  override, or `[]` to run the naive lift with no idiom folding. */
  patterns?: RewritePattern[];
  /** function prototypes from the project's headers, keyed by symbol: a callee's `params`
   *  drives its `bl` argument recovery; the current function's own entry supplies its
   *  `returnsVoid`. One table, resolved at the point of use (see proto.ts). */
  prototypes?: Prototypes;
  /** OPTIONAL Regime-B side-table (data-section jump tables + relocations). Absent ⇒ a dense
   *  MIPS/PPC switch declines/loud-fails; present ⇒ the frontend recovers the `switch_br`.
   *  Produced by `extractAsmData(obj, target)` from the scoring object. */
  asmData?: AsmData;
  /** OPTIONAL address→symbol map (symbols.ts) — the project's own names (ELF symtab) and
   *  declaration shapes (DWARF types-sidecar). Drives the Thumb numeric-pool promotion and the
   *  byte-sensitive global spellings. Absent ⇒ byte-identical to today. */
  symbols?: SymbolMap;
  /** gap policy — see `OnGap`. Default "strict". */
  onGap?: OnGap;
}

export interface DecompileResult {
  source: string;
  sfn: SFn;
  ir: { raw: string; folded: string; recovered: string }; // IR dumps: post-lift, post-idiom, post-recovery
  patternHits: number;
  /** structured gap list — ALWAYS present. Non-empty ⇔ the source contains ASMLIFT_ERROR markers /
   *  a stub and will NOT compile until the user acts (the loud-in-artifact contract).
   *
   *  EMPTY IS THE ABSENCE OF A GAP, NOT A PROMISE THAT THE C COMPILES. A candidate can also fail
   *  on a symbol the caller never declared, which is a CONTEXT question the benchmark answers by
   *  escalating to the vendored preprocessed context. Most such names survive K&R implicit
   *  declaration; a function ADDRESS does not, and klonoa's `UpdateStageSelectScreen` reports 0
   *  gaps while emitting `((s32 *)50345232)[1] = &HandlePauseMenuInput;`, which agbcc rejects
   *  where the plain call above it passes with a warning. Declaring an address-taken unknown
   *  callee would close it — an emitter change, moving source bytes on every row that has one. */
  diagnostics: Diagnostic[];
}

export function decompile(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: DecompileOptions = {},
): DecompileResult {
  const onGap = opts.onGap ?? 'strict';
  if (onGap === 'strict') {
    return runTower(name, asm, target, opts, 'strict');
  }
  try {
    return runTower(name, asm, target, opts, 'annotate');
  } catch (e) {
    // A NON-localizable failure (unliftable control transfer, frame model, a broken internal
    // invariant): there is no line to mark, so degrade to a stub — the failure reason + the
    // original asm as comments, and one ASMLIFT_ERROR marker so the file stays uncompilable
    // un-acknowledged. The user/LLM gets the raw material to finish by hand instead of a throw.
    return stubResult(name, asm, opts.backend ?? cBackend, e);
  }
}

function runTower(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: DecompileOptions,
  onGap: OnGap,
): DecompileResult {
  const backend = opts.backend ?? cBackend;
  // The project's own DWARF signatures fill in what the caller did not state — in practice the
  // CALLEES (a function still in assembly has none), which is what makes this transferable.
  const prototypes = prototypesFromSymbols(opts.symbols, opts.prototypes ?? {});
  // (1) lift: ISA frontend (resolved by target) → L1 with block-argument SSA
  const fn = frontendFor(target).lift(name, asm, target, prototypes, opts.asmData, opts.symbols);
  verify(fn);
  const raw = print(fn);

  // (2) idiom fold: apply serializable patterns on the IR (the AI-improvement surface),
  // gated generically by the Target's capabilities (not an `arch ==` branch).
  const patternHits = applyIdiomPatterns(fn, target, opts.patterns);
  const folded = print(fn);

  // (2.35–3.5) pre-recovery recognizers → type recovery → return-sinking, the ONE shared spine
  // (`raiseRecovered`) that trace.ts and the cli's rank.ts/report.ts also run.
  raiseRecovered(fn, target, {}, prototypes[name]);
  const recovered = print(fn);

  // (4) structure: IR → neutral AST; boundary contract: no unresolved value leaked (strict), or
  // every unresolved value spelled as a loud ASMLIFT_ERROR marker (annotate).
  const sfn = structureChecked(fn, {
    ...structureOptionsFor(target, prototypes[name]?.returnsVoid ?? false),
    onGap,
    ...(opts.symbols ? { symbols: symbolsByName(opts.symbols) } : {}),
  });

  // (5) lower + print: neutral AST → target language
  const source = backend.emit(sfn);

  return { source, sfn, ir: { raw, folded, recovered }, patternHits, diagnostics: collectMarkers(sfn) };
}

// ── the shared raising tower ────────────────────────────────────────────────────────────────
// decompile(), decompileTraced (trace.ts), and the cli's decompileRanked (rank.ts) /
// decompileWithReport + its score probe (report.ts) all raise a lifted fn through the SAME
// stage sequence. The optional hooks are the only per-caller
// differences: rank pins its signedness candidate `beforeRecover`; the report pushes trace
// entries after each stage. Every hook fires AFTER the stage's verify, so a hook can never
// observe unverified IR.

/** Stage 2 — idiom fold: filter the pattern set by target capabilities, apply, dce + verify.
 *  Returns total hits. `patterns` defaults to DEFAULT_IDIOM_PATTERNS exactly like decompile(). */
export function applyIdiomPatterns(fn: Fn, target: TargetDescription, patterns?: RewritePattern[]): number {
  const active = (patterns ?? DEFAULT_IDIOM_PATTERNS).filter((p) => patternApplies(p, target));
  let hits = 0;
  for (const p of active) {
    hits += applyPattern(fn, p);
  }
  if (active.length) {
    dce(fn);
    verify(fn);
  }
  return hits;
}

export interface RaiseHooks {
  /** after each pre-recovery pass that changed the IR (fires after its verify) */
  afterPass?: (pass: PreRecoveryPass, result: number | boolean) => void;
  /** between pre-recovery and recoverTypes — rank.ts pins candidate signedness here */
  beforeRecover?: () => void;
  /** after recoverTypes + verify + assertTypesRecovered */
  afterRecover?: () => void;
  /** after return-sinking, only when it changed the fn (fires after its verify) */
  afterRetsink?: () => void;
  /** after empty-latch folding, only when it removed a block (fires after its verify) */
  afterLatchFold?: () => void;
}

/** Stages 2.35–3.5 — pre-recovery recognizers (the shared ordered list in raise/pre-recovery.ts)
 *  → type recovery (boundary contract: no `unknown` survives) → return-sinking (tail-duplicate a
 *  return-only merge so short-circuits emit early returns) → empty-latch folding (splice out a
 *  back-edge block SSA construction emptied). `verify` after every pass that changed the IR.
 *
 *  The two CFG passes look ordered and are not: running latch folding FIRST instead changes
 *  nothing across a 3337-function agbcc corpus. Worth saying, because folding an empty block ahead
 *  of return-sinking does take away `br` predecessors it needs — the dominance gate is what makes
 *  that unreachable, since the blocks retsink wants are never back-edge sources. It goes last
 *  because that is where the CFG stops moving. */
export function raiseRecovered(fn: Fn, target: TargetDescription, hooks: RaiseHooks = {}, self?: FnProto): void {
  runPreRecovery(
    fn,
    target,
    (pass, result) => {
      verify(fn);
      hooks.afterPass?.(pass, result);
    },
    self,
  );
  hooks.beforeRecover?.();
  recoverTypes(fn);
  verify(fn);
  assertTypesRecovered(fn);
  hooks.afterRecover?.();
  if (sinkReturns(fn)) {
    verify(fn);
    hooks.afterRetsink?.();
  }
  if (foldEmptyLatches(fn)) {
    verify(fn);
    hooks.afterLatchFold?.();
  }
}

/** Run `body`; if it declines, name the unmodelled instructions the function carries.
 *
 *  An `opaque` degrades its own value AND makes its block impure, so a shape recognizer refuses:
 *  `headerPure` rejects a header holding one, and the loop declines with "unrecovered back-edge …".
 *  True and useless — the shape is fine, an instruction is missing — and the benchmark classifies
 *  declines by that text, so the round is filed as a loop-capability gap and the improvement loop
 *  builds the wrong thing.
 *
 *  Only ADDS attribution: never converts a decline into a success, never fires without an
 *  unmodelled instruction, reachable blocks only (one in dead code did not cause the refusal). */
function attributeOpaques<T>(fn: Fn, body: () => T): T {
  try {
    return body();
  } catch (e) {
    // Attribution is a nicety, so it must not be able to throw: a crash here would replace a
    // DESIGNED loud failure with an incidental one, which contract-invariant.test.ts rejects by name.
    if (!(e instanceof StructureError) || !fn.blocks[0]) {
      throw e;
    }
    const seen = new Set<Block>([fn.blocks[0]]);
    for (const stack = [fn.blocks[0]]; stack.length;) {
      for (const s of successorsOf(stack.pop()!)) {
        if (!seen.has(s)) {
          seen.add(s);
          stack.push(s);
        }
      }
    }
    const names = new Set<string>();
    for (const b of seen) {
      for (const op of b.ops) {
        if (op.opcode === 'opaque') {
          names.add(typeof op.attrs.mnemonic === 'string' ? op.attrs.mnemonic : '?');
        }
      }
    }
    if (!names.size || /unmodelled instruction/.test(e.message)) {
      throw e;
    }
    // Through `gapReasonFor`, so the classifier sees its canonical text — a hand-written variant
    // misses the mnemonic-anchored classes and every attributed decline lands in the generic bucket.
    const list = [...names].sort().map(gapReasonFor).join(', ');
    throw new StructureError(`${e.message} — and the function carries ${list}, which is the more likely cause`);
  }
}

/** Stage 4 — structure + its boundary contracts, always as a pair. */
export function structureChecked(fn: Fn, opts: Parameters<typeof structure>[1]): SFn {
  const raw = attributeOpaques(fn, () => structure(fn, opts));
  // The boundary contracts run on the pre-DCE tree: the readability pass must never be able to
  // hide a structuring defect by dropping the dead statement that carries it. assertResolved
  // catches an unresolved `?` value; assertDerefsTyped catches an ill-typed deref (e.g. a pointer
  // under a rejected operator) — even one sitting in dead code structure emitted;
  // assertLocalsWritten catches a materialized def whose assignment no position emitted. DCE then
  // only removes statements/flips branches over an already-validated tree.
  assertResolved(raw);
  assertDerefsTyped(raw);
  assertLocalsWritten(raw);
  assertEffectsPreserved(fn, raw);
  // Then the readability/quality rewrites: merge a statement common to every arm of an if,
  // drop dead stores (whose empty-then peephole flips the arm the merge empties), then hoist each
  // leaf base the DEFAULT gate table admits into a typed local pointer. The hoist moves the deref
  // cast from each `index` node onto the local's initializer, so re-validate deref typing on the
  // rewritten tree.
  // Both arguments SPELLED, defaults or not: this is the one call to this pass that is committed
  // rather than offered, so it is the one whose gate table and whose placement can cost a MATCH
  // instead of a candidate (docs/level-tower.md). A committed policy that reads as "whatever the
  // default is" is the policy nobody reviews.
  const sfn = hoistBaseLocals(eliminateDeadStores(mergeCommonTails(raw)), BASECSE_GATES, 'head');
  assertDerefsTyped(sfn);
  // Re-checked after the readability rewrites for the same reason deref typing is: a pass that
  // merges arms or drops statements must not be able to lose or duplicate a call.
  assertEffectsPreserved(fn, sfn);
  return sfn;
}

// ── annotate-mode support ─────────────────────────────────────────────────────────────────

/** Classify a caught failure by which stage's designed signal it is. `instanceof`, not name
 *  strings: a renamed or newly-subclassed error class (PpcUnsupported subclasses
 *  FrontendUnsupported) stays correctly classified instead of silently degrading to "internal". */
function stageOf(e: unknown): Diagnostic['stage'] {
  if (e instanceof FrontendUnsupportedError) {
    return 'lift';
  }
  if (e instanceof RaiseUnsupportedError) {
    return 'raise';
  }
  if (e instanceof StructureError) {
    return 'structure';
  }
  if (e instanceof ContractError) {
    return 'contract';
  }
  if (e instanceof VerifyError) {
    return 'verify';
  }
  return 'internal';
}

/** The annotate-mode fallback for a failure with no line to mark: a compilable-shaped stub whose
 *  body is one ASMLIFT_ERROR marker, headed by the reason + the ORIGINAL ASM as comments.
 *  Exported for trace.ts (decompileTraced), whose annotate mode must degrade to the SAME stub
 *  as decompile(). */
export function stubResult(name: string, asm: string, backend: LanguageBackend, e: unknown): DecompileResult {
  const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
  const stage = stageOf(e);
  const sfn: SFn = {
    name,
    params: [],
    locals: [],
    retType: T.void(),
    body: [{ k: 'exprstmt', value: { k: 'marker', reason: `could not decompile (${stage}): ${msg}`, args: [] } }],
  };
  const header = [
    backend.comment(`asmlift could not decompile '${name}' — ${stage}: ${msg}`),
    backend.comment('original assembly:'),
    ...asm
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => backend.comment(`  ${l}`)),
  ];
  return {
    source: header.join('\n') + '\n' + backend.emit(sfn),
    sfn,
    ir: { raw: '', folded: '', recovered: '' },
    patternHits: 0,
    diagnostics: [{ stage, reason: msg }],
  };
}

/** Every ASMLIFT_ERROR marker in the emitted AST, as a structured diagnostic (one per marker,
 *  document order). The harness/self-improve loop reads THIS; the source text is for humans. */
function collectMarkers(sfn: SFn): Diagnostic[] {
  // On the shared exprChildren/stmtExprs/stmtChildren traversal. Order is exprs-then-children
  // per statement — deterministic and near-document-order (a `for`'s cond is visited before its
  // init; see the note on stmtChildren).
  const out: Diagnostic[] = [];
  const we = (e: Expr): void => {
    if (e.k === 'marker') {
      out.push({ stage: 'structure', reason: e.reason });
    }
    exprChildren(e).forEach(we);
  };
  const ws = (s: Stmt): void => {
    stmtExprs(s).forEach(we);
    stmtChildren(s).forEach(ws);
  };
  sfn.body.forEach(ws);
  return out;
}
