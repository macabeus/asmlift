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
// The engine's handles are component-model RESOURCES: without an explicit dispose they wait on
// the FinalizationRegistry, which a tight synchronous scoring loop never lets run — after a few
// hundred calls the wasm side exhausts and PANICS, and the poisoned instance then fails every
// later call in the process (a ranked run drops every remaining candidate). Disposal is the
// fix, not a nicety.
// the same key the engine binds (its jco output uses Symbol.dispose with a Symbol.for
// fallback on runtimes that predate it) — using only Symbol.dispose would silently no-op there
const DISPOSE: typeof Symbol.dispose = Symbol.dispose ?? (Symbol.for('dispose') as never);
const disposeAll = (...xs: unknown[]): void => {
  for (const x of xs) {
    (x as { [DISPOSE]?: () => void } | undefined)?.[DISPOSE]?.();
  }
};

// ONE config for the process, default-constructed and never mutated: the scorer's behaviour is
// objdiff's defaults. Nothing here may set a property on it — a knob that changes what a diff
// counts changes every number this project has published.
const CONFIG = new objdiff.diff.DiffConfig();

/** The parsed TARGET, memoized on its own BYTES. Every candidate in a ranked run is scored against
 *  the same target object, and parsing it once rather than once per candidate is what this saves:
 *  on klonoa's 102 KB `gfx.o` that parse measured 3.81 ms, against 0.07 ms for the one-function
 *  candidate beside it.
 *
 *  The key is the whole file content, compared byte for byte rather than by path, size or mtime: a
 *  hit then PROVES the parse would produce the same object, so a target rewritten in place between
 *  two calls can never be scored against stale bytes. The read stays — only the parse is saved.
 *
 *  ONE entry, held for the life of the process. `scoreObjects` is a published entry point, so an
 *  embedder that scores once still retains an engine handle and a copy of the target's bytes
 *  afterwards; `releaseTarget()` below is how it gets them back. */
let parsedTarget: { bytes: Uint8Array; obj: ObjdiffWasm.diff.Object } | undefined;

/** Drop the memoized target: its engine handle is disposed and its bytes are released. The next
 *  `scoreObjects` re-parses. For an embedder holding this module open past its last score — the CLI
 *  itself never needs it, since a ranked run scores one target and then exits. */
export function releaseTarget(): void {
  disposeAll(parsedTarget?.obj);
  parsedTarget = undefined;
}

function targetObject(path: string): ObjdiffWasm.diff.Object {
  const bytes = new Uint8Array(readFileSync(path));
  if (parsedTarget && Buffer.compare(bytes, parsedTarget.bytes) === 0) {
    return parsedTarget.obj;
  }
  // Parse BEFORE dropping the entry it replaces: a target that fails to parse must leave the
  // previous one intact and throw, never leave a disposed handle behind for the next call.
  const obj = objdiff.diff.Object.parse(bytes, CONFIG, 'target');
  disposeAll(parsedTarget?.obj);
  parsedTarget = { bytes, obj };
  return obj;
}

export function scoreObjects(targetObj: string, candidateObj: string, symbol: string): MatchScore {
  const mappingConfig = { mappings: [], selectingLeft: undefined, selectingRight: undefined };
  const target = targetObject(targetObj);
  let candidate, left, right;
  try {
    candidate = objdiff.diff.Object.parse(new Uint8Array(readFileSync(candidateObj)), CONFIG, 'base');

    // left = target, right = candidate (base).
    ({ left, right } = objdiff.diff.runDiff(target, candidate, CONFIG, mappingConfig));
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
        row >= disp.rowCount
          ? 'none'
          : (objdiff.display.displayInstructionRow(od, s.id, row, CONFIG).diffKind ?? 'none');
      // BOTH sides are displayed on every row and only one answer is read — displaying a row is
      // how this wrapper learns the engine can decode it. Consulting the candidate only where the
      // target's row said 'none' turns an engine REFUSAL of the candidate into a plausible score:
      // it enters the ranking instead of being dropped, and `[ranked] 0 dropped` still prints.
      // ~0.8 ms per scoring call on klonoa's `gfx.o` — the price of the guarantee.
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
  } finally {
    // the target and the config outlive the call by design; everything minted here does not
    disposeAll(left, right, candidate);
  }
}
