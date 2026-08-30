// The playground candidate-compile path's PURE half: the translation unit a candidate is
// compiled in, and the one line of a failed tool's stderr the UI shows. It lives beside
// score-wasm.ts rather than inside it so both are testable — score-wasm.ts imports the `agbcc`
// package, which cannot be loaded outside a browser (its wasm has no fetch in node, and vitest's
// ESM loader rejects its `lib/config.json` import), so nothing in that file can be unit-tested.
import { renderDeclarations } from '@asmlift/core/declare';
import type { Candidate } from '@asmlift/core/rank';
import { C_TYPEDEFS } from '@asmlift/core/target';

/** The ONE line of a tool's stderr worth showing, in DIAGNOSTIC-first order.
 *
 *  Every compiler and assembler here brackets its real diagnostics with lines that are not one:
 *  GNU as opens with an `in.s: Assembler messages:` banner, and gcc 2.9 opens an in-function
 *  error with an ``in.i: In function `X':`` header. The old rule was "first line containing
 *  `Error:`, else the first non-empty line" — correct for as, and GUARANTEED WRONG for agbcc,
 *  which is the only compiler this path uses: gcc 2.9 never prints `Error:` (it prints
 *  ``in.i:24: `x' undeclared``), so the search always missed and the fallback always returned
 *  the header — a message ending in a colon with nothing after it, which is exactly how a real
 *  bug (candidates naming undeclared globals) stayed invisible.
 *
 *  So: an explicit error line first (keeps GNU as's banner out), then the first `file:line:`
 *  diagnostic that is not a warning/note, then any `file:line:` line, and only then today's
 *  first-non-empty fallback. Total on every input — the third call site summarises an
 *  already-thrown Error's `.message`, normally a single line the other two built, and that must
 *  pass through unchanged. */
export function firstDiagnosticLine(s: string): string {
  const lines = (s || '').split('\n');
  const located = /^[^\s:]+:\d+:/;
  return (
    lines.find((l) => /(^|\s)[Ee]rror:/.test(l)) ??
    lines.find((l) => located.test(l) && !/\b(warning|note):/.test(l)) ??
    lines.find((l) => located.test(l)) ??
    lines.find((l) => l.trim() !== '') ??
    ''
  );
}

/** The context a candidate is compiled in: the typedef prelude, then the declarations
 *  synthesized for the symbols this candidate's own tree names (core's `renderDeclarations`, the
 *  same renderer the cli scorer uses). agbcc-wasm compiles bare candidates with no project
 *  headers, so this is ALWAYS the self-declared world — a symbol with no declaration here is an
 *  `undeclared` hard error, never a fall-back to a header. */
export function candidateContext(c: Pick<Candidate, 'symbolRefs'>): string {
  return C_TYPEDEFS + (c.symbolRefs?.length ? renderDeclarations(c.symbolRefs) : '');
}
