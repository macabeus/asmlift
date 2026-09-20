// asmlift — reading a compiler's diagnostic text. Pure string logic (core is browser-pure): the
// benchmark's compile modules and the CLI read a compiler's output through here, so "an error"
// means one thing on all of them.

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
