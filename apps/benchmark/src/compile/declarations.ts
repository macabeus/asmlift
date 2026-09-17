// A translation unit's DECLARATIONS: the same text with every function body at file scope replaced by `;`.
//
// It is what m2c reads out of a context and nothing less. m2c's context reader (m2c/c_types.py, `parse_c` and
// the visitor after it) takes a function definition's declarator and never descends into its body, so a body
// can only ever cost m2c — and a CodeWarrior body costs it the whole context: the Dolphin SDK's
// `dolphin/os/OSFastCast.h`, which every Mario Party 4 unit includes, defines inline functions around
// `asm { … }` blocks, and m2c's C parser refuses the file at the first one (`Syntax error when parsing C
// context … asm {li r3, 0x0004`), on 42 of 42 of its contexts.
//
// Scanned, not parsed: a body is a `{` at file scope whose preceding declarator closes a parameter list and
// assigns nothing, which an initialiser (`= {`) and an aggregate definition (`struct s {`) never do. String
// and character literals, comments and preprocessor lines are stepped over, so a brace inside one is not
// structure.

/** `text` with every file-scope function body replaced by `;`. */
export function declarationsOnly(text: string): string {
  let out = '';
  let head = ''; // the file-scope text since the last `;`, `}` or directive: the declarator a `{` would open
  let depth = 0;
  let parens = 0;
  let lineStart = true;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const literal = skipLiteral(text, i);
    if (literal > i) {
      out += text.slice(i, literal);
      head += text.slice(i, literal);
      i = literal;
      lineStart = false;
      continue;
    }
    if (c === '#' && lineStart && depth === 0) {
      const end = directiveEnd(text, i);
      out += text.slice(i, end);
      head = '';
      i = end;
      continue;
    }
    if (c === '\n') {
      lineStart = true;
    } else if (c !== ' ' && c !== '\t' && c !== '\r') {
      lineStart = false;
    }
    if (c === '(') {
      parens++;
    } else if (c === ')') {
      parens--;
    } else if (c === '{' && depth === 0 && parens === 0 && isFunctionDeclarator(head)) {
      i = bodyEnd(text, i);
      out = `${out.trimEnd()};`;
      head = '';
      continue;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    }
    out += c;
    head = depth === 0 && (c === ';' || c === '}') ? '' : head + c;
    i++;
  }
  return out;
}

/** The index just past a string or character literal, or a comment, starting at `i`; `i` when none does. */
function skipLiteral(text: string, i: number): number {
  const c = text[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== c && text[j] !== '\n') {
      j += text[j] === '\\' ? 2 : 1;
    }
    return j + 1;
  }
  if (text.startsWith('//', i)) {
    const end = text.indexOf('\n', i);
    return end === -1 ? text.length : end;
  }
  if (text.startsWith('/*', i)) {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return i;
}

/** The index of the newline ending the preprocessor line at `i`, backslash continuations included. */
function directiveEnd(text: string, i: number): number {
  let end = text.indexOf('\n', i);
  while (end > 0 && text[end - 1] === '\\') {
    end = text.indexOf('\n', end + 1);
  }
  return end === -1 ? text.length : end;
}

/** A declarator that opens a function body: it closes a parameter list, and it assigns nothing. */
const isFunctionDeclarator = (head: string): boolean => /\)\s*$/.test(head) && !/=/.test(head.replace(/\([^]*$/, ''));

/** The index just past the `}` matching the `{` at `open`. */
function bodyEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length;) {
    const literal = skipLiteral(text, i);
    if (literal > i) {
      i = literal;
      continue;
    }
    if (text[i] === '{') {
      depth++;
    } else if (text[i] === '}' && --depth === 0) {
      return i + 1;
    }
    i++;
  }
  return text.length;
}
