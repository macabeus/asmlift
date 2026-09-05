// Reading shell text as a PROGRAM — `src/shell-text.ts`, driven directly.
//
// This is a pure function with two callers, and both of them use it to decide something with a
// stale-object consequence: `compile-command.ts` decides which paths a compile template names, and
// `candcache.ts` decides whether a wrapper script computes the program it runs — a SAFETY refusal.
// Dropping text before a safety detector is the false-negative direction, so every case here is
// about a `#` that is NOT a comment, and what `sh` itself does with it is quoted beside it.
import { describe, expect, test } from 'vitest';

import { shellProgramText, stripShellComments } from '../../src/shell-text';

/** The detector `candcache.ts` runs over the answer. Duplicated deliberately: this file is about
 *  what the READING hands over, and pinning it against a copy of the predicate keeps the two
 *  questions apart. */
const COMPUTES = /\$\(|`|(^|[\s;&|])eval[\s]/;

describe('a comment is dropped, and only a comment', () => {
  test('an unquoted `#` starting a word begins a comment', () => {
    expect(stripShellComments('exec cc "$@" # run the compiler\n')).toBe('exec cc "$@" \n');
  });

  test("a `#` inside a quoted string is not a comment — `-DTAG='#1'`", () => {
    const t = "cc -DTAG='#1 $(uname)' x.c\n";
    expect(stripShellComments(t)).toBe(t);
  });

  test('line numbering survives: a comment becomes the newline that ended it', () => {
    expect(stripShellComments('a\n# b\nc\n').split('\n')).toHaveLength(4);
  });
});

describe('a BACKSLASH escape does not close a quote — the under-scanning side', () => {
  // The reading tracks quotes so that a `#` inside one is not a comment. If a `\"` is allowed to
  // close a double quote, the tracker leaves the string EARLY, the next `#` on that line reads as
  // a comment, and everything after it — including a `$( )` that `sh` really does substitute — is
  // deleted before the safety detector ever sees it. That is loud-to-silent inside the detector.
  //
  // What `sh` actually does with this line, so the substitution is not hypothetical:
  //   $ sh -c 'CC="a \" # $(command -v true) "; echo "[$CC]"'
  //   [a " # true ]
  const ESCAPED_QUOTE = 'CC="a \\" # $(command -v true) "\nexec $CC "$@"\n';

  test('the `$( )` after an escaped quote SURVIVES the strip', () => {
    expect(stripShellComments(ESCAPED_QUOTE)).toContain('$(command -v true)');
  });

  test('…so the computed-delegate detector still fires on it', () => {
    expect(COMPUTES.test(shellProgramText(ESCAPED_QUOTE))).toBe(true);
  });

  test('an escaped `#` outside quotes is a literal `#`, not a comment', () => {
    // `sh -c 'echo a\# $(echo b)'` prints `a# b`.
    expect(stripShellComments('echo a\\# $(echo b)\n')).toContain('$(echo b)');
  });

  test('a backslash inside SINGLE quotes is literal — it must not escape the closing quote', () => {
    // `sh -c "echo 'a\\' # x"` prints `a\`; the `#` really is a comment.
    expect(stripShellComments("echo 'a\\' # x\n")).toBe("echo 'a\\' \n");
  });

  test('a backslash-newline continuation keeps the newline, so line numbers do not shift', () => {
    expect(stripShellComments('a \\\nb\n# c\nd\n').split('\n')).toHaveLength(5);
  });
});

describe('a HEREDOC is decided on the PROGRAM, not on the prose', () => {
  // `<<` used to be tested on the RAW text, so prose decided the program after all: a `<<` inside
  // an English comment — or an arithmetic left-shift — turned comment stripping off for the whole
  // script, and the refusal that followed quoted the comment as its reason. That is this round's
  // own defect class, one level up from the detector it was fixing.
  const PROSE = '#!/bin/sh\n# see the <<NOTE>> above; built by `make`\nexec /bin/echo "$@"\n';

  test('a `<<` inside a COMMENT does not switch the reading back to raw', () => {
    expect(shellProgramText(PROSE)).not.toContain('make');
  });

  test('an arithmetic left-shift is not a heredoc', () => {
    const t = '#!/bin/sh\n# built by `make`\nMASK=$((1 << 2))\nexec /bin/echo "$@"\n';
    const scan = shellProgramText(t);
    expect(scan, 'the comment is still dropped').not.toContain('make');
    expect(scan, 'and the real `$( ` in code is still there to refuse on').toContain('$((1 << 2))');
  });

  test('a here-STRING is not a heredoc — its body is an ordinary word', () => {
    expect(shellProgramText('#!/bin/sh\n# built by `make`\ncat <<<"x"\n')).not.toContain('make');
  });

  test('a real heredoc IS one, and the text comes back as written — the refusing side', () => {
    // Inside an unquoted heredoc a leading `#` is body text and `$(…)` still substitutes, so the
    // comment reading is not decidable there.
    for (const marker of ['<<EOF', '<< EOF', '<<-EOF', "<<'EOF'", '<<"EOF"', '<<\\EOF']) {
      const t = `#!/bin/sh\n# built by \`make\`\ncat ${marker}\n# $(command -v true)\nEOF\n`;
      expect(shellProgramText(t), marker).toBe(t);
    }
  });
});
