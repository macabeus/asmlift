// asmlift cli — declaration synthesis re-export. The renderer itself lives in @asmlift/core
// (core/src/declare.ts — browser-pure) so the webapp's wasm scorer prepends the SAME
// declarations the cli's Node/objdiff scorer does; this module only preserves the cli's
// historical import path — the A/B matching suite (test/matching/self-declared-ab.test.ts) pins
// the compiled bytes either way. What it DOES own is how a synthesized declaration is REPORTED
// (`declaredBlock`): that is a claim about what a score rests on, so it needs exactly one spelling
// across every command that prints one.
import { renderDeclarations } from '@asmlift/core/declare';

export { macroDefinesOf, renderDeclarations, selfDeclaredContext } from '@asmlift/core/declare';

/** A declaration block as stderr lines: rendered, blank lines dropped, each one under the
 *  `asmlift:` prefix that separates this tool's output from the compiler's in a shared log. */
export const indentedDeclarations = (refs: Parameters<typeof renderDeclarations>[0]): string =>
  renderDeclarations(refs)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => `asmlift:   ${l}\n`)
    .join('');

/** THE `[declared]` BLOCK of a ranked run — the declarations asmlift INVENTED for the winner,
 *  named so the score can be checked against the reader's own headers.
 *
 *  One owner because it has two producers now: the CLI's ranked run and the benchmark's `bench
 *  fan`, which prints one row's whole fan and must not describe a synthesized declaration in
 *  different words than the command whose numbers it reproduces. Empty for an empty list — a
 *  block that says "0 declaration(s)" reads as a finding. */
export const declaredBlock = (refs: Parameters<typeof renderDeclarations>[0]): string =>
  refs.length === 0
    ? ''
    : `asmlift: [declared] ${refs.length} declaration(s) synthesized from the target asm — no symbol ` +
      `map knows these names, so the score is about this block plus the source; check it against your ` +
      `headers:\n` +
      indentedDeclarations(refs);
