// asmlift — the TOKENS of a C or C++ declaration context: one pass that decides what is code.
//
// Whitespace, comments and preprocessor lines (continuations included) are not tokens: a context is
// preprocessed, so a `#` line left in it is a line marker or a pragma, and a raw header's
// conditionals are read as if every branch were taken. A string or character literal is one token,
// and ends at its newline when nothing closes it. `::` and `...` are one token each; every other
// punctuator is one character, so `>>` closing two template argument lists is two `>`.
//
// Brackets are matched once, here: a `}` closes everything opened since its `{`, and a `)` or `]`
// that does not close the innermost open bracket matches nothing. So an unbalanced `(` inside a
// body cannot carry the rest of the context with it.
//
// Storage is one typed array per field, indexed by token: a context is up to a few megabytes, and an
// object per token is what would make reading it slow.

export type TokenKind = 'identifier' | 'number' | 'string' | 'punct' | 'end';

export interface Tokens {
  readonly src: string;
  readonly count: number;
  /** `end` past the last token */
  kind(i: number): TokenKind;
  text(i: number): string;
  is(i: number, s: string): boolean;
  /** a punctuator's first character code, or -1 for any other token */
  char(i: number): number;
  /** the matching close of an open `{ ( [`, the open of a close, or -1 */
  match(i: number): number;
  /** the source offset of the token's first character */
  start(i: number): number;
  /** the source offset just past the token */
  end(i: number): number;
}

const KINDS: readonly TokenKind[] = ['end', 'identifier', 'number', 'string', 'punct'];
const IDENTIFIER = 1;
const NUMBER = 2;
const STRING = 3;
const PUNCT = 4;

const isIdentifierStart = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
/** whether the newline at `i` ends a line that a backslash continues */
const continued = (src: string, i: number): boolean =>
  src.charCodeAt(i - 1) === 92 || (src.charCodeAt(i - 1) === 13 && src.charCodeAt(i - 2) === 92);

class TokenArrays implements Tokens {
  readonly src: string;
  readonly count: number;
  readonly #kind: Uint8Array;
  readonly #start: Int32Array;
  readonly #end: Int32Array;
  readonly #match: Int32Array;

  constructor(src: string, count: number, kind: Uint8Array, start: Int32Array, end: Int32Array, match: Int32Array) {
    this.src = src;
    this.count = count;
    this.#kind = kind;
    this.#start = start;
    this.#end = end;
    this.#match = match;
  }

  kind(i: number): TokenKind {
    return i < this.count ? KINDS[this.#kind[i]] : 'end';
  }

  text(i: number): string {
    return this.src.slice(this.#start[i], this.#end[i]);
  }

  is(i: number, s: string): boolean {
    return i < this.count && this.#end[i] - this.#start[i] === s.length && this.src.startsWith(s, this.#start[i]);
  }

  char(i: number): number {
    return i < this.count && this.#kind[i] === PUNCT ? this.src.charCodeAt(this.#start[i]) : -1;
  }

  match(i: number): number {
    return i < this.count ? this.#match[i] : -1;
  }

  start(i: number): number {
    return i < this.count ? this.#start[i] : this.src.length;
  }

  end(i: number): number {
    return i < this.count ? this.#end[i] : this.src.length;
  }
}

export function lex(src: string): Tokens {
  let capacity = Math.max(16, src.length >> 2);
  let kind = new Uint8Array(capacity);
  let start = new Int32Array(capacity);
  let end = new Int32Array(capacity);
  let count = 0;
  const push = (k: number, from: number, to: number): void => {
    if (count === capacity) {
      capacity *= 2;
      const k2 = new Uint8Array(capacity);
      k2.set(kind);
      kind = k2;
      const s2 = new Int32Array(capacity);
      s2.set(start);
      start = s2;
      const e2 = new Int32Array(capacity);
      e2.set(end);
      end = e2;
    }
    kind[count] = k;
    start[count] = from;
    end[count] = to;
    count++;
  };
  const length = src.length;
  // only whitespace and comments since the last newline: a `#` here starts a directive
  let lineStart = true;
  let i = 0;
  while (i < length) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      lineStart = true;
      i++;
    } else if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11) {
      i++;
    } else if (c === 47 && src.charCodeAt(i + 1) === 47) {
      const newline = src.indexOf('\n', i);
      i = newline < 0 ? length : newline;
    } else if (c === 47 && src.charCodeAt(i + 1) === 42) {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? length : close + 2;
    } else if (c === 35 && lineStart) {
      while (i < length && !(src.charCodeAt(i) === 10 && !continued(src, i))) {
        i++;
      }
    } else {
      lineStart = false;
      let j = i + 1;
      if (isIdentifierStart(c)) {
        while (j < length && (isIdentifierStart(src.charCodeAt(j)) || isDigit(src.charCodeAt(j)))) {
          j++;
        }
        push(IDENTIFIER, i, j);
      } else if (isDigit(c)) {
        // a preprocessing number: `0x1F`, `1.5f`, `1e-3`
        for (; j < length; j++) {
          const d = src.charCodeAt(j);
          const sign = (d === 43 || d === 45) && /[eEpP]/.test(src[j - 1]);
          if (!(isIdentifierStart(d) || isDigit(d) || d === 46 || sign)) {
            break;
          }
        }
        push(NUMBER, i, j);
      } else if (c === 34 || c === 39) {
        while (j < length && src.charCodeAt(j) !== c && src.charCodeAt(j) !== 10) {
          j += src.charCodeAt(j) === 92 ? 2 : 1;
        }
        if (j < length && src.charCodeAt(j) === c) {
          j++;
        }
        push(STRING, i, j);
      } else if (c === 58 && src.charCodeAt(j) === 58) {
        j++;
        push(PUNCT, i, j);
      } else if (c === 46 && src.charCodeAt(j) === 46 && src.charCodeAt(j + 1) === 46) {
        j += 2;
        push(PUNCT, i, j);
      } else {
        push(PUNCT, i, j);
      }
      i = j;
    }
  }
  return new TokenArrays(src, count, kind, start, end, matchBrackets(src, count, kind, start));
}

function matchBrackets(src: string, count: number, kind: Uint8Array, start: Int32Array): Int32Array {
  const match = new Int32Array(count).fill(-1);
  const open: number[] = [];
  for (let t = 0; t < count; t++) {
    if (kind[t] !== PUNCT) {
      continue;
    }
    const c = src.charCodeAt(start[t]);
    if (c === 123 || c === 40 || c === 91) {
      open.push(t);
    } else if (c === 125) {
      let k = open.length - 1;
      while (k >= 0 && src.charCodeAt(start[open[k]]) !== 123) {
        k--;
      }
      if (k >= 0) {
        match[open[k]] = t;
        match[t] = open[k];
        open.length = k;
      }
    } else if (c === 41 || c === 93) {
      const top = open[open.length - 1];
      if (top !== undefined && src.charCodeAt(start[top]) === (c === 41 ? 40 : 91)) {
        match[top] = t;
        match[t] = top;
        open.pop();
      }
    }
  }
  return match;
}
