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

/** `<<` — a heredoc or a here-string. Its BODY is not shell comments, so the comment stripper
 *  cannot be trusted over a script that has one; such a script is scanned as written. */
const SHELL_HEREDOC = /<</;

/** The PROGRAM a shell text describes: its prose dropped, where that can be decided.
 *
 *  Line NUMBERING survives — `stripShellComments` replaces a comment with the newline that ended
 *  it — so a caller can name the line it is about.
 *
 *  The one asymmetry is a HEREDOC, and it is the refusing side: inside one a leading `#` is body
 *  text rather than a comment, and an unquoted heredoc still substitutes, so the comment reading
 *  is not decidable there and such a text is handed back as written. */
export function shellProgramText(text: string): string {
  return SHELL_HEREDOC.test(text) ? text : stripShellComments(text);
}
