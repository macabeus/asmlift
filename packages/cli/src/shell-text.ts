// Reading SHELL TEXT as a program rather than as bytes.
//
// Two places in this package scan shell: `compile-command.ts` scans a project's `compiler:`
// TEMPLATE for the paths it names, and `candcache.ts` scans a WRAPPER SCRIPT the template names
// for what it delegates to. They are the same language and must read it the same way, so the
// reading lives here rather than in either of them — `candcache` is a 1,500-line cache and
// `compile-command` a command builder; neither is the natural home of a tokenizer, and a copy in
// each is a drift waiting to happen.
//
// Nothing here decides anything. It answers one question — WHICH BYTES OF THIS TEXT ARE THE
// PROGRAM — and hands the answer to callers that do.

/** A shell COMMENT is not argv. `sh` drops from an unquoted `#` that begins a word to the end of
 *  the line, so nothing in there is read, executed or resolved — and both a decomp `compiler:`
 *  template and a wrapper script it names are shell where a `#` line is ordinary.
 *
 *  MEASURED, and it is why every scan over shell text starts here. `# remember to clean build` put
 *  the project's OWN OUTPUT TREE in the namespace, so every rebuild was a cold start — the payoff
 *  of the whole cache, spent by a word in a comment. `# see [1] and *.o notes` promoted prose to
 *  the glob rule. `# our CI also builds this in docker` and `# copy with scp/ssh` each REFUSED the
 *  project's cache outright, with a message asserting the compile runs through a container that it
 *  does not. `# … a `bl` is a relocation …` refused a project over a backtick in an English
 *  sentence.
 *
 *  Dropping the text loses no measurement: the raw bytes of a template AND of every script in the
 *  chain are hashed unconditionally, so editing a comment still moves the namespace. Quotes are
 *  tracked because `-DTAG='#1'` is a `#` that is not a comment, and an UNTERMINATED quote keeps the
 *  rest of the text — the over-scanning side, which costs a cold start. */
export function stripShellComments(template: string): string {
  let out = '';
  let quote: string | undefined;
  let prev = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    // A BACKSLASH takes the next character verbatim — unquoted and inside a DOUBLE quote, but not
    // inside a single quote, where `sh` gives it no meaning at all. Skipping this let `\"` close
    // the tracker's quote EARLY, which is the under-scanning direction: a later `#` on that line
    // then read as a comment and deleted a `$( )` that `sh` really does substitute, out from under
    // a SAFETY detector. `sh -c 'CC="a \" # $(command -v true) "; echo "[$CC]"'` prints `[a " # true ]`.
    // The escaped character is emitted (line numbers never shift) but does not become `prev`
    // unless it is a newline: `a\ #b` is one word with a literal `#` in it, while a line
    // continuation really does put the next line's `#` at the start of a word.
    if (c === '\\' && quote !== "'" && i + 1 < template.length) {
      out += c + template[i + 1];
      prev = template[i + 1] === '\n' ? '\n' : 'x';
      i++;
      continue;
    }
    if (quote !== undefined) {
      out += c;
      if (c === quote) {
        quote = undefined;
      }
      prev = c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      prev = c;
      continue;
    }
    if (c === '#' && (prev === '' || /[\s;&|(]/.test(prev))) {
      while (i < template.length && template[i] !== '\n') {
        i++;
      }
      out += '\n';
      prev = '\n';
      continue;
    }
    out += c;
    prev = c;
  }
  return out;
}

/** A HEREDOC's opening: `<<`, an optional `-`, then the delimiter word (which may be quoted or
 *  backslash-escaped). Its BODY is not shell comments, so the stripper cannot be trusted over a
 *  text that has one.
 *
 *  The shape matters, twice over. A bare `/<</` also matched `$((1 << 2))` — an arithmetic
 *  expansion, where `<<` is a shift — and `cat <<<"x"`, a here-STRING whose body is an ordinary
 *  word with ordinary `#` rules; both switched the whole text back to being read as prose. It is
 *  still deliberately loose in the over-refusing direction: `echo "a << b"` inside a quoted string
 *  reads as a heredoc here and costs a cold start, which is the safe side of this predicate. */
const SHELL_HEREDOC = /(?<!<)<<(?!<)-?\s*(['"\\]?[A-Za-z_])/;

/** The PROGRAM a shell text describes: its prose dropped, where that can be decided.
 *
 *  Line NUMBERING survives — `stripShellComments` replaces a comment with the newline that ended
 *  it — so a caller can name the line it is about.
 *
 *  The one asymmetry is a HEREDOC, and it is the refusing side: inside one a leading `#` is body
 *  text rather than a comment, and an unquoted heredoc still substitutes, so the comment reading
 *  is not decidable there and such a text is handed back as written. */
export function shellProgramText(text: string): string {
  // The heredoc test is on the STRIPPED text, not the raw text: a `<<` inside an English comment
  // is not a heredoc, and testing the raw bytes let prose decide the reading after all — the very
  // defect this function exists to remove, one level up. Stripping only ever deletes COMMENT
  // text, so a real `<<EOF` in code always survives into the answer this tests.
  const stripped = stripShellComments(text);
  return SHELL_HEREDOC.test(stripped) ? text : stripped;
}
