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
import { renderDeclarations } from '@asmlift/core/declare';
import { type DroppedCandidate, type RankedResult, type Scored, enumerateCandidates } from '@asmlift/core/rank';
import type { SymbolMap } from '@asmlift/core/symbols';
import { C_TYPEDEFS, type TargetDescription } from '@asmlift/core/target';
import { assemble, compileToObject } from 'agbcc';
import type * as ObjdiffWasm from 'objdiff-wasm';

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
export type RankResponse =
  { reqId: number; ok: true; result: RankedResult<MatchScore> } | { reqId: number; ok: false; error: string };

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

/** The one line of a tool's stderr worth showing. GNU as prefixes everything with an
 *  "in.s: Assembler messages:" banner and puts the real diagnostics after it — preferring the
 *  first `Error:` line over the first non-empty one is what keeps the banner out of the UI. */
const firstLine = (s: string) => {
  const lines = (s || '').split('\n');
  return lines.find((l) => l.includes('Error:')) ?? lines.find((l) => l.trim() !== '') ?? '';
};

/** The async analog of the cli's `decompileRanked`, agbcc-only: enumerate the distinct candidate
 *  spellings (shared @asmlift/core enumeration), assemble the pasted `.s` ONCE as the target, then
 *  compile + objdiff-score each candidate and rank by score (lowest first). Mirrors
 *  `@asmlift/core/rank`'s `rankBy` semantics — a candidate whose compile/score throws is skipped so
 *  it cannot sink a matching sibling; only if EVERY candidate fails is the failure surfaced.
 *
 *  SELF-DECLARING CANDIDATES: with a symbol map, a candidate that names map symbols carries
 *  their refs (Candidate.symbolRefs) — its synthesized declaration block (the SAME core
 *  renderer the cli scorer uses) is prepended after the typedefs, exactly the cli's
 *  self-declared world (rank.ts). agbcc-wasm compiles bare candidates (no project headers),
 *  so the probe arbitration is unnecessary here: this scorer is ALWAYS the self-declared world.
 *
 *  Ranking always uses `cBackend` regardless of the UI backend selector — choosing cpp/pascal
 *  turns ranking off (it is gated to the agbcc target + C backend in Playground.tsx). */
export async function rankCandidatesInBrowser(
  name: string,
  asm: string,
  target: TargetDescription,
  symbols?: SymbolMap,
): Promise<RankedResult<MatchScore>> {
  const candidates = enumerateCandidates(name, asm, target, { backend: cBackend, ...(symbols ? { symbols } : {}) });

  const t = await assemble(asm);
  if (!t.ok) {
    throw new Error(`could not assemble the target asm: ${firstLine(t.stderr)}`);
  }

  // Mirrors core's `rankBy` (which this cannot reuse — the wasm scorer is async): a candidate
  // that fails to build is DROPPED rather than allowed to sink a sibling that compiles, and each
  // drop is RECORDED so a failed spelling is never invisible. Enumeration order breaks a score
  // tie, exactly as `rankBy` spells it — the named spelling is enumerated before its
  // `/raw-globals` sibling, so equal bytes show the reader the named one.
  const results: (Scored<MatchScore> & { order: number })[] = [];
  const dropped: DroppedCandidate[] = [];
  let lastErr: unknown = null;
  for (const [order, c] of candidates.entries()) {
    try {
      const decls = c.symbolRefs?.length ? renderDeclarations(c.symbolRefs) : '';
      const cc = await compileToObject(c.source, { context: C_TYPEDEFS + decls });
      if (!cc.ok) {
        throw new Error(`agbcc could not compile candidate '${c.label}': ${firstLine(cc.stderr)}`);
      }
      const score = await scoreObjectBytes(t.obj, cc.obj, name);
      results.push({ ...c, order, score });
    } catch (e) {
      lastErr = e;
      dropped.push({ label: c.label, error: e instanceof Error ? firstLine(e.message) : String(e) });
    }
  }
  if (results.length === 0) {
    const why = lastErr instanceof Error ? lastErr.message.split('\n')[0] : String(lastErr ?? 'no candidate produced');
    throw new Error(`no scorable candidate for '${name}': ${why}`, { cause: lastErr });
  }
  results.sort((a, b) => a.score.score - b.score.score || a.order - b.order);
  return { best: results[0], candidates: results.map(({ order: _order, ...c }) => c), dropped };
}
