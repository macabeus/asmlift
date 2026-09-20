// asmlift — reading a compiler's diagnostic text: which lines are errors, and when two failed
// compiles failed THE SAME WAY. Pure string logic (core is browser-pure): the ranking drivers, the
// benchmark's compile modules and the CLI read a compiler's output through here, so "an error"
// means one thing on all of them.

/** A scorer's refusal that IS the compiler's verdict: it ran to completion, exited nonzero and
 *  said why. Everything else a scorer throws — a timeout, a killed process, a missing binary, a
 *  differ that could not find the symbol — is this machine or this harness having a bad minute,
 *  and says nothing about the candidate.
 *
 *  A CLASS because the distinction cannot be read back off a message: a compiler killed mid-run
 *  has already printed half its diagnostics, and that text has exactly the shape of a rejection.
 *  The seam that saw the spawn result is the only place that knows, so it says so in the type.
 *
 *  `diagnostic` is the compiler's WHOLE output. `message` is what the seam publishes, which may be
 *  a bounded selection of it; a comparison made over a bounded selection compares the bound. */
export class CompilerRejection extends Error {
  readonly diagnostic: string;
  constructor(message: string, diagnostic: string = message, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CompilerRejection';
    this.diagnostic = diagnostic;
  }
}

/** A warning or a note — a line the compiler prints about text it may still accept. */
const ADVISORY = /\b(?:warning|note)\b\s*:/i;
/** An mwcc caret line (`#   Error:      ^`). It carries no message: the NEXT line does, and the
 *  two are one diagnostic. */
const MWCC_CARET = /#\s*(Error|Warning):[\s^~]*$/i;

/** `lines` with every ERROR ahead of every warning and note, each class in its original order.
 *
 *  A compiler prints diagnostics in source order, and a candidate that casts its way through a
 *  project's types can print dozens of warnings above the one error that refused it. Whatever
 *  bounds the list downstream then keeps warnings only, and the reader is shown a cause that is
 *  not why the compile failed. An mwcc message line travels with its caret line, whichever class
 *  that is. */
export function errorsFirst(lines: readonly string[]): string[] {
  const errors: string[] = [];
  const advisories: string[] = [];
  let caretAdvisory: boolean | undefined;
  for (const l of lines) {
    const advisory = caretAdvisory ?? ADVISORY.test(l);
    caretAdvisory = MWCC_CARET.test(l) ? advisory : undefined;
    (advisory ? advisories : errors).push(l);
  }
  return [...errors, ...advisories];
}

/** `file:line:` or `file:line:column:` opening a diagnostic, the gcc family's spelling (clang's
 *  too). Behind an optional wrapper, because a seam's message puts its own words ahead of the
 *  first line (`agbcc failed: c.c:12: …`). */
const LOCATED = /(?:^|\s)[^\s:]+:\d+:(?:\d+:)?\s*(.*)$/;
/** The word a located error may carry ahead of its message (gcc 3+, clang); pre-3.0 gcc has none. */
const ERROR_TAG = /^(?:fatal\s+)?error\s*:\s*/i;
/** An error spelled with the word and no `file:line:`: `cc1: error: …`, `ld: fatal error: …`, and
 *  IDO's `cfe: Error: c.c, line 12: …`, whose own position is dropped with the rest. */
const TAGGED = /\b(?:fatal\s+)?error\s*:\s*(?:\S+, line \d+:\s*)?(.*)$/i;
/** Lines that belong to a diagnostic without being one: where the OTHER declaration was, and
 *  pre-3.0 gcc's two-line footnote to its first `undeclared`. None of them says what is wrong with
 *  the statement, and a `previous declaration` line points into the context rather than at the
 *  candidate. */
const CONTINUATION =
  /^(?:previous (?:implicit )?(?:declaration|definition)\b|this is the location of\b|\(Each undeclared identifier\b|for each function it appears in\b)/i;

/** The compiler's ERROR lines, each reduced to its message: no file, no line, no column, no
 *  `error:` tag. Warnings, notes, `In function` banners, `previous declaration` lines and source
 *  excerpts are not errors and are not here. Empty when the text holds nothing this recognises —
 *  which is an answer the caller must treat as "unknown", never as "no errors". */
export function errorMessages(diagnostic: string): string[] {
  const lines = diagnostic
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const caret = MWCC_CARET.exec(lines[i]);
    if (caret !== null) {
      const message = lines[i + 1]?.replace(/^#\s*/, '') ?? '';
      if (caret[1].toLowerCase() === 'error' && message !== '') {
        out.push(message);
      }
      i++;
      continue;
    }
    if (ADVISORY.test(lines[i])) {
      continue;
    }
    const located = LOCATED.exec(lines[i]);
    const message = located === null ? TAGGED.exec(lines[i])?.[1] : located[1].replace(ERROR_TAG, '');
    if (message !== undefined && message !== '' && !CONTINUATION.test(message)) {
      out.push(message);
    }
  }
  return out;
}

/** WHAT a failed compile failed ON, as a value two compiles can be compared by: the MULTISET of
 *  its error messages, positions normalised away. A multiset, not a set — two calls with too many
 *  arguments are two errors, and a variation that repairs one of them has changed the answer.
 *  Null when no error is recognised: an unreadable diagnostic equals nothing, itself included. */
export function errorKey(diagnostic: string): string | null {
  const messages = errorMessages(diagnostic);
  return messages.length === 0 ? null : JSON.stringify([...messages].sort());
}
