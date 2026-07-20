// asmlift — the objdiff engine, in-process. asmlift is a pure generator; it does NOT own the
// scorer: scoring drives the community objdiff engine through the npm package `objdiff-wasm`,
// PINNED to an exact version in package.json and resolved from asmlift's own node_modules —
// never a sibling checkout, never a hand-rolled diff. The wrapper shape follows Mizuchi's (the
// downstream loop this generator plugs into) so both read the engine the same way, but shares
// no code with it.
//
// FAIL-CLOSED: NOTHING is caught here. Any engine failure throws, and a row that cannot be
// displayed can never count as matched — a swallowed per-row error could report a false
// byte-exact match, the worst possible defect.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as ObjdiffWasm from 'objdiff-wasm';

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

// objdiff-wasm fetches its sibling `objdiff.core.wasm` by file:// URL while its module
// top-level-await initializes. Node's fetch does not read file:// URLs — so the import goes
// through a temporary fetch patch that serves that one URL from disk (Mizuchi's technique).
// The patch is scoped to the import and restored before anything else runs.
const objdiff = await (async (): Promise<typeof ObjdiffWasm> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.startsWith('file://') && url.includes('objdiff.core.wasm')) {
      const buf = readFileSync(fileURLToPath(url));
      return new Response(buf, { headers: { 'content-type': 'application/wasm' } });
    }
    return originalFetch(input);
  }) as typeof fetch;
  try {
    const mod = await import('objdiff-wasm');
    mod.init('error');
    return mod;
  } finally {
    globalThis.fetch = originalFetch;
  }
})();

const DIFF_KINDS: Record<string, keyof DiffBreakdown> = {
  insert: 'insert',
  delete: 'delete',
  replace: 'replace',
  'op-mismatch': 'opMismatch',
  'arg-mismatch': 'argMismatch',
};

/** Diff `candidateObj` against `targetObj` for one symbol and tally objdiff's per-row diffKind.
 *  score === 0 ⇔ objdiff reports zero differing rows ⇔ byte-exact match. Throws when either
 *  object fails to parse, the symbol is missing on either side, or any row fails to display —
 *  an error is never a match. */
export function scoreObjects(targetObj: string, candidateObj: string, symbol: string): MatchScore {
  const cfg = new objdiff.diff.DiffConfig();
  const mappingConfig = { mappings: [], selectingLeft: undefined, selectingRight: undefined };

  const parse = (path: string, side: ObjdiffWasm.diff.DiffSide) =>
    objdiff.diff.Object.parse(new Uint8Array(readFileSync(path)), cfg, side);
  const target = parse(targetObj, 'target');
  const candidate = parse(candidateObj, 'base');

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

  const breakdown: DiffBreakdown = { insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: 0 };
  let matching = 0,
    differences = 0;

  for (let row = 0; row < rows; row++) {
    // Rows past a side's own rowCount are that side's padding for the other side's
    // insertions — kind "none" here is a fact, not a swallowed error.
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
