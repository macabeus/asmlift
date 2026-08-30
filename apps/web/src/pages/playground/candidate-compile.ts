// The playground candidate-compile path's PURE half: the ONE line of a failed tool's stderr the
// UI shows. It lives beside score-wasm.ts rather than inside it so it is testable —
// score-wasm.ts imports the `agbcc` package, which cannot be loaded outside a browser (its wasm
// has no fetch in node, and vitest's ESM loader rejects its `lib/config.json` import), so nothing
// in that file can be unit-tested.
//
// The translation unit a candidate is compiled in used to live here too; it is core's
// `selfDeclaredContextFor` now (@asmlift/core/declare) — the cli's compile seam composes its
// self-declared prelude with the same function, so the two scoring worlds cannot drift.

/** Lines that BRACKET a diagnostic without being one: gcc 2.9 opens an in-function error with
 *  ``in.i: In function `X':`` and GNU as opens with `in.s: Assembler messages:`. Neither ever
 *  says what went wrong. */
const BANNER = /^\S*:\s*(In function|Assembler messages)\b/;

/** The ONE line of a tool's stderr worth showing, in DIAGNOSTIC-first order.
 *
 *  `Error:` alone cannot be the rule: GNU as says it, and agbcc — the only COMPILER this path
 *  uses — never does. gcc 2.9 prints ``in.i:24: `x' undeclared``, so a rule that searches for
 *  `Error:` and falls back to the first non-empty line returns ``in.i: In function `X':`` for
 *  every in-function error there is: a message ending in a colon with nothing after it.
 *
 *  So, in order: an explicit error line (keeps GNU as's banner out and puts its first `Error:`
 *  first), then the first line that is neither a banner nor a warning/note — the diagnosis,
 *  whether or not it carries a `file:line:` prefix — then the first non-banner line (a
 *  warnings-only failure), then the first non-empty line. Ordering on the DIAGNOSIS rather than
 *  on a `file:line:` prefix is what keeps `in.i:3: warning: …` from outranking an unlocated
 *  fatal like `cc1: out of memory allocating 4064 bytes`, which under wasm is a live failure
 *  mode.
 *
 *  Total on every input — the third call site summarises an already-thrown Error's `.message`,
 *  normally a single line the other two built, and that must pass through unchanged. Callers
 *  handle the empty result themselves (a tool that failed with NO stderr at all); this returns
 *  '' rather than inventing text for it. */
export function firstDiagnosticLine(s: string): string {
  const lines = (s || '').split('\n');
  const banner = (l: string) => BANNER.test(l);
  return (
    lines.find((l) => /(^|\s)[Ee]rror:/.test(l)) ??
    lines.find((l) => l.trim() !== '' && !banner(l) && !/\b(warning|note):/.test(l)) ??
    lines.find((l) => l.trim() !== '' && !banner(l)) ??
    lines.find((l) => l.trim() !== '') ??
    ''
  );
}

/** What a failed tool's message says when its stderr is EMPTY — the residual of the reported
 *  bug's shape (a message ending in a colon with nothing after it), now for a different cause. */
export const NO_DIAGNOSTIC = '(the tool failed with no diagnostic output)';

/** `firstDiagnosticLine`, never empty — for the two call sites that paste it after a colon. */
export function toolFailureLine(stderr: string): string {
  return firstDiagnosticLine(stderr) || NO_DIAGNOSTIC;
}
