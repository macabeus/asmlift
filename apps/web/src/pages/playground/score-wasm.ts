// asmlift webapp — the in-browser objdiff scorer, agbcc/ARMv4T only. The playground's own match
// verification: assemble the pasted `.s` to a target object, compile each
// recovered-C candidate with agbcc, and diff target-vs-candidate with the REAL objdiff engine —
// the same fitness function the benchmark uses, never a hand-rolled asm/text compare.
//
// SOUNDNESS — this file is a near-verbatim PORT of packages/cli/src/objdiff.ts. Its
// `scoreObjectBytes` MUST stay logic-identical to that file, and objdiff-wasm MUST stay pinned to
// the EXACT same version as packages/cli (3.7.0) — the two copies are a deliberate duplication
// (apps/web cannot import the Node cli), so they can only be trusted while they agree. In
// particular: match ⇔ `differences === 0` counted over instruction rows (NOT objdiff's rounded
// matchPercent, which can round 99.96 → 100), and a missing symbol THROWS (never a soft-fail that
// would mask an alignment bug as a perpetual "closest"). FAIL-CLOSED: nothing here is caught; any
// engine failure throws, and a row that cannot be displayed can never count as matched.
import { cBackend } from '@asmlift/core/backend/c';
import { selfDeclaredContextFor } from '@asmlift/core/declare';
import {
  type DroppedCandidate,
  type RankedResult,
  type RefusedDeclarationReason,
  type Scored,
  type WithheldCandidate,
  compareScored,
  enumerateCandidates,
  withheldReason,
} from '@asmlift/core/rank';
import type { SymbolMap } from '@asmlift/core/symbols';
import type { TargetDescription } from '@asmlift/core/target';
import { assemble, compileToObject } from 'agbcc';
import type * as ObjdiffWasm from 'objdiff-wasm';

import { toolFailureLine } from './candidate-compile';
import { type RankProgress, throttleProgress } from './rank-progress';

// ── Web-Worker protocol ──────────────────────────────────────────────────────────────────────
// Scoring runs in a worker (rank.worker.ts) so the agbcc + objdiff wasm compiles never jank
// typing. `reqId` is the H1 STALE-GUARD token: the UI stamps each request with a monotonic id,
// remembers the latest, and DISCARDS any response whose id is not the current one — so a score
// computed for a previous asm can never be shown against the asm now on screen.
export interface RankRequest {
  reqId: number;
  name: string;
  asm: string;
  target: TargetDescription;
  /** the Symbols pane's parsed address→symbol map — structured-clones fine (a Map of plain
   *  objects); absent ⇒ the plain raw-globals-only enumeration */
  symbols?: SymbolMap;
}
/** A name the candidate's tree references that asmlift REFUSED to declare
 *  (core `RefusedDeclarationReason`) — surfaced so the UI can say which `'x' undeclared` was
 *  asmlift's own decision. */
export interface RefusedDeclaration {
  name: string;
  reason: RefusedDeclarationReason;
}
/** The browser ranking: core's ranked result plus the declaration refusals this enumeration
 *  made. Kept local to the webapp rather than widened into core's `RankedResult` — this is the
 *  only consumer core's callback has, and the cli reports the fact it needs (how many
 *  declarations were synthesized) as a count on its own `[ranked]` line. */
export type BrowserRanking = RankedResult<MatchScore> & { refused: RefusedDeclaration[] };
export type RankResponse =
  | { kind: 'result'; reqId: number; ok: true; result: BrowserRanking }
  | { kind: 'result'; reqId: number; ok: false; error: string };
/** A phase/count observation from a run in flight. It carries the SAME `reqId` the result echoes,
 *  because it is subject to the SAME H1 stale-guard: progress for a superseded asm must be dropped,
 *  not rendered. */
export type RankProgressMessage = { kind: 'progress'; reqId: number } & RankProgress;
/** Everything the worker can post. Read on the explicit `kind` discriminant — never by sniffing for
 *  a property, which is how a fourth shape later gets silently mis-routed. */
export type RankMessage = RankProgressMessage | RankResponse;
export type { RankPhase, RankProgress } from './rank-progress';

export interface DiffBreakdown {
  insert: number;
  delete: number;
  replace: number;
  opMismatch: number;
  argMismatch: number;
}
export interface MatchScore {
  symbol: string;
  score: number; // objdiff total differences; 0 = byte-exact match
  match: boolean;
  rows: number;
  matching: number;
  breakdown: DiffBreakdown;
}

// objdiff-wasm is a jco-transpiled WebAssembly Component: it fetches its sibling
// `objdiff.core.wasm` via `new URL('./objdiff.core.wasm', import.meta.url)` and top-level-awaits
// its init. In the browser (and a worker) `fetch` + `WebAssembly.compileStreaming` are native, and
// Vite rewrites the URL to a hashed asset — so, unlike the Node cli, NO fetch patch is needed.
let modPromise: Promise<typeof ObjdiffWasm> | null = null;
function loadObjdiff(): Promise<typeof ObjdiffWasm> {
  if (!modPromise) {
    modPromise = import('objdiff-wasm').then((m) => {
      try {
        m.init('error');
      } catch {
        /* init() is idempotent-ish; ignore double-init */
      }
      return m;
    });
  }
  return modPromise;
}

/** Warm the wasm engines ahead of the first score (agbcc's two modules + objdiff). */
export function preloadScorers(): void {
  void loadObjdiff();
  void import('agbcc')
    .then((m) => m.preloadAgbcc())
    .catch(() => {
      /* warm-up only */
    });
}

const DIFF_KINDS: Record<string, keyof DiffBreakdown> = {
  insert: 'insert',
  delete: 'delete',
  replace: 'replace',
  'op-mismatch': 'opMismatch',
  'arg-mismatch': 'argMismatch',
};

/** Diff `candidateObj` against `targetObj` for one symbol and tally objdiff's per-row diffKind.
 *  score === 0 ⇔ objdiff reports zero differing rows ⇔ byte-exact match. Throws when either object
 *  fails to parse, the symbol is missing on either side, the symbol has no rows, or any row fails
 *  to display — an error is NEVER a match. Verbatim port of packages/cli/src/objdiff.ts
 *  scoreObjects (bytes instead of file paths; async because the engine loads lazily) plus the
 *  audit's `rows > 0` guard. */
export async function scoreObjectBytes(
  targetObj: Uint8Array,
  candidateObj: Uint8Array,
  symbol: string,
): Promise<MatchScore> {
  const objdiff = await loadObjdiff();
  const cfg = new objdiff.diff.DiffConfig();
  const mappingConfig = { mappings: [], selectingLeft: undefined, selectingRight: undefined };

  const target = objdiff.diff.Object.parse(targetObj, cfg, 'target');
  const candidate = objdiff.diff.Object.parse(candidateObj, cfg, 'base');

  // left = target, right = candidate (base).
  const { left, right } = objdiff.diff.runDiff(target, candidate, cfg, mappingConfig);
  if (!left || !right) {
    throw new Error('objdiff runDiff returned an empty side');
  }

  const sym = (od: ObjdiffWasm.diff.ObjectDiff, side: string) => {
    const s = od.findSymbol(symbol, undefined);
    if (!s) {
      throw new Error(`symbol '${symbol}' not found in ${side} object`);
    }
    return s;
  };
  const lSym = sym(left, 'target'),
    rSym = sym(right, 'candidate');
  const lDisp = objdiff.display.displaySymbol(left, lSym.id);
  const rDisp = objdiff.display.displaySymbol(right, rSym.id);
  const rows = Math.max(lDisp.rowCount, rDisp.rowCount);
  // H2 guard (audit MINOR M-a): a degenerate 0-row symbol would fall through the loop with
  // differences === 0 → a spurious "match". Not reachable for a real compiled body, but the
  // duplicated copy hardens it explicitly — a symbol with no instructions is never a match.
  if (rows === 0) {
    throw new Error(`symbol '${symbol}' has no instruction rows to diff`);
  }

  const breakdown: DiffBreakdown = { insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 };
  let matching = 0,
    differences = 0;

  for (let row = 0; row < rows; row++) {
    // Rows past a side's own rowCount are that side's padding for the other side's insertions —
    // kind "none" here is a fact, not a swallowed error.
    const kindOf = (od: ObjdiffWasm.diff.ObjectDiff, s: ObjdiffWasm.diff.SymbolInfo, disp: { rowCount: number }) =>
      row >= disp.rowCount ? 'none' : (objdiff.display.displayInstructionRow(od, s.id, row, cfg).diffKind ?? 'none');
    const lk = kindOf(left, lSym, lDisp);
    const rk = kindOf(right, rSym, rDisp);
    const kind = lk !== 'none' ? lk : rk;
    if (kind === 'none') {
      matching++;
      continue;
    }
    differences++;
    const bucket = DIFF_KINDS[kind];
    if (bucket) {
      breakdown[bucket]++;
    }
  }

  return { symbol, rows, matching, score: differences, match: differences === 0, breakdown };
}

/** The async analog of the cli's `decompileRanked`, agbcc-only: enumerate the distinct candidate
 *  spellings (shared @asmlift/core enumeration), assemble the pasted `.s` ONCE as the target, then
 *  compile + objdiff-score each candidate and rank by score (lowest first). Mirrors
 *  `@asmlift/core/rank`'s `rankBy` semantics — a candidate whose compile/score throws is skipped so
 *  it cannot sink a matching sibling; only if EVERY candidate fails is the failure surfaced.
 *
 *  SELF-DECLARING CANDIDATES: a candidate that names symbols carries their refs
 *  (Candidate.symbolRefs) — a UNION, with the map's facts winning per name and every name the
 *  map does not know read out of the asm's own literal pool (rank.ts bareGlobalSymbols) and
 *  marked `synthesized`. `selfDeclaredContextFor` (core declare.ts — the SAME composition the
 *  cli's compile seam uses) prepends the typedefs and that block. agbcc-wasm compiles bare
 *  candidates (no project headers), so the probe arbitration is unnecessary here: this scorer is
 *  ALWAYS the self-declared world, and a name with no declaration is a hard error.
 *
 *  A synthesized declaration is FITTED to the asm being scored (declare.ts's module note), so it
 *  cannot lose score — which is why the block comes back with the result for the UI to show, and
 *  the refusals with it.
 *
 *  Ranking always uses `cBackend` regardless of the UI backend selector — choosing cpp/pascal
 *  turns ranking off (it is gated to the agbcc target + C backend in Playground.tsx).
 *
 *  PROGRESS: `onProgress` (optional — the existing 4-arg call sites stay valid) is called with the
 *  phase, and with `done`/`total` once the candidate array exists. It is throttled HERE rather than
 *  in the worker because this is the only place that knows the loop index, and a second driver over
 *  this enumeration would inherit the throttle for free. */
export async function rankCandidatesInBrowser(
  name: string,
  asm: string,
  target: TargetDescription,
  symbols?: SymbolMap,
  onProgress?: (p: RankProgress) => void,
): Promise<BrowserRanking> {
  const emit = onProgress ? throttleProgress(onProgress) : () => {};

  // ASSEMBLE FIRST. This used to run AFTER `enumerateCandidates`, and the ordering cost a measured
  // 62.3 s of discarded work on every pret-dialect `.s`: agbcc's `assemble()` hands the source to
  // GNU as AS-IS, which does not know `thumb_func_start`, so `LoadBGTilemapData` enumerated 117,760
  // candidates and THEN died on line 1. `enumerateCandidates` does not consume `t`, so the swap is
  // behaviour-neutral whenever assembly succeeds and turns a minute into milliseconds when it does
  // not — and it gives the UI a real, cheap first phase to name instead of a minute-long unnamed
  // void. (The pret dialect itself is a separate gap: asmlift's own frontend reads it, the
  // in-browser scorer cannot.)
  emit({ phase: 'assembling' });
  const t = await assemble(asm);
  if (!t.ok) {
    throw new Error(`could not assemble the target asm: ${toolFailureLine(t.stderr)}`);
  }

  // A refused declaration is a name asmlift DECIDED not to declare. Collected here so the UI can
  // attribute an undeclared name to that decision instead of leaving the user to guess — and,
  // for `emitter-name`, so a row that produced NO candidate at all says which symbol collided.
  //
  // `enumerateCandidates` is SYNCHRONOUS and returns a finished array (62.3 s of it, measured, on
  // the function above), so there is no honest number to show inside it — the phase is named and
  // carries none. Subdividing it is a core change and a follow-up, not this round's.
  emit({ phase: 'enumerating' });
  const refused: RefusedDeclaration[] = [];
  const candidates = enumerateCandidates(name, asm, target, {
    backend: cBackend,
    ...(symbols ? { symbols } : {}),
    onRefusedDeclaration: (n, reason) => refused.push({ name: n, reason }),
  });

  // Mirrors core's `rankBy` (which this cannot reuse — the wasm scorer is async): a candidate
  // that fails to build is DROPPED rather than allowed to sink a sibling that compiles, and each
  // drop is RECORDED so a failed spelling is never invisible.
  //
  // The ORDERING is not re-spelled here, it is IMPORTED — `compareScored` is core's one copy. Two
  // drivers over the same enumeration with two hand-written comparators is how the playground and
  // the CLI come to disagree about which spelling of the same function is best.
  const results: (Scored<MatchScore> & { order: number })[] = [];
  const dropped: DroppedCandidate[] = [];
  const withheld: WithheldCandidate[] = [];
  let lastErr: unknown = null;
  // The total is only ever `candidates.length` — the number actually returned. No estimate, and no
  // borrowing the CLI's count for the same function (66,816 with a symbol map, against the
  // browser's map-less 117,760: a fabricated denominator would have been 76 % wrong).
  const total = candidates.length;
  emit({ phase: 'scoring', done: 0, total });
  for (const [order, c] of candidates.entries()) {
    // `order` is how many candidates are FINISHED, and the tick is emitted at the top so the
    // `continue` on a withheld spelling cannot skip it.
    emit({ phase: 'scoring', done: order, total });
    try {
      const cc = await compileToObject(c.source, { context: selfDeclaredContextFor(c.symbolRefs) });
      if (!cc.ok) {
        throw new Error(`agbcc could not compile candidate '${c.label}': ${toolFailureLine(cc.stderr)}`);
      }
      const score = await scoreObjectBytes(t.obj, cc.obj, name);
      // The PUBLICATION rule is imported for the same reason the ordering is: `withheldReason` is
      // core's one copy, and a `matchOnly` spelling this driver published while the CLI withheld
      // it would be the playground showing a source the CLI refuses to stand behind.
      const why = withheldReason(c, score);
      if (why !== null) {
        withheld.push({ label: c.label, score: score.score, why });
        continue;
      }
      results.push({ ...c, order, score });
    } catch (e) {
      lastErr = e;
      dropped.push({ label: c.label, error: e instanceof Error ? toolFailureLine(e.message) : String(e) });
    }
  }
  emit({ phase: 'scoring', done: total, total });
  // The scoring phase ends by CHANGING PHASE, never by sitting at done === total: the sort and the
  // structured clone of a six-figure array back to the main thread are real work, and a bar full
  // while the tab is still busy is the lie constraint 3 forbids. The UI falls back to an
  // indeterminate bar with a different label here.
  emit({ phase: 'ranking' });
  if (results.length === 0) {
    const why = lastErr instanceof Error ? lastErr.message.split('\n')[0] : String(lastErr ?? 'no candidate produced');
    throw new Error(`no scorable candidate for '${name}': ${why}`, { cause: lastErr });
  }
  results.sort(compareScored);
  return { best: results[0], candidates: results.map(({ order: _order, ...c }) => c), dropped, withheld, refused };
}
