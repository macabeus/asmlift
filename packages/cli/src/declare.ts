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

/** THE `[declared]` BLOCK of a ranked run — the declarations the winner's translation unit carries
 *  that no symbol map supplied, named so the score can be checked against the reader's own headers.
 *
 *  NOT "the ones asmlift invented", and the difference is a line in the block. Most of them are
 *  fitted to the target's own asm; a call target asmlift has a `--proto` for is declared in the
 *  PROJECT's words, and claiming asmlift wrote it would misdescribe the one line in the block the
 *  reader has already checked. What every entry does share is the predicate the list is filtered
 *  on: no map accounts for the name, so the score is about this block plus the source.
 *
 *  One owner because it has two producers now: the CLI's ranked run and the benchmark's `bench
 *  fan`, which prints one row's whole fan and must not describe such a declaration in different
 *  words than the command whose numbers it reproduces. Empty for an empty list — a block that says
 *  "0 declaration(s)" reads as a finding. */
export const declaredBlock = (refs: Parameters<typeof renderDeclarations>[0]): string =>
  refs.length === 0
    ? ''
    : `asmlift: [declared] ${refs.length} declaration(s) no symbol map supplied — fitted to the ` +
      `target asm, or re-spelled from a prototype you stated, so the score is about this block plus ` +
      `the source; check it against your headers:\n` +
      indentedDeclarations(refs);
