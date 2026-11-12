// asmlift — the READABILITY POLISH: re-spellings of a finished tree that a reader would write and the
// compiler cannot tell apart, applied by the C-family printer to the text it publishes.
//
// WHAT MAY LIVE HERE. A rewrite whose C is the SAME PROGRAM in every dialect the printer serves and
// compiles to the same bytes on every compiler the bench covers — `*p` as `p[0]`, `x = x + 1` as
// `x++`, a dropped `else` after a `return`. Not a rewrite the compiler can see: an early return's
// polarity, a narrower declared type or a `do`/`while` turned `for` move code on agbcc, so they are
// ranked candidates (a variation), never a polish. Each rewrite is its own module, states the
// condition under which it does not fire, and is pinned by its own test.
//
// WHERE IT RUNS, and why that is the whole design. The polish runs inside `emitCFamily`, last, on the
// tree the printer is about to print (after the pointer-write legalization, so it sees every cast the
// reader will), and both the text that is COMPILED and the text that is PUBLISHED carry it: a
// candidate is scored on what the report shows. But two decisions read printed text — the
// return-tail reading's size bound and rank's goto/cast/line tie-break — and rank collapses
// candidates whose text is equal. A polish that drops a line, or that prints two different trees as
// one text, would move a reading or a winner while every score held. So those three read the DRAFT,
// the same printer with the polish off (`LanguageBackend.draft`, `emitDraft`), and the polish moves
// what the reader sees and nothing the ranking decides.
import type { SFn } from '../ast';

/** The finished tree, re-spelled by every tree-level polish rewrite, in order. */
export function polishTree(fn: SFn): SFn {
  return fn;
}
