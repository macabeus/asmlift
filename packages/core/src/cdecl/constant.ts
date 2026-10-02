// asmlift — the INTEGER CONSTANTS a declaration writes: a literal's value, and the value of a constant
// expression of literals, as an array's extent or a bit-field's width is written.
import type { Tokens } from './lex';
import type { Range } from './parse';

/** An integer literal's value and its suffix (`u`, `l`, `ll` in any case and order), read as C reads
 *  it: `0x` hexadecimal, a leading `0` octal. Undefined for any other text: `08`, `1.5`, `SIZE`. */
export function integerLiteral(text: string): { value: bigint; suffix: string } | undefined {
  const m = /^(?:0x([0-9a-f]+)|0([0-7]*)|([1-9]\d*))([ul]*)$/i.exec(text);
  if (m === null) {
    return undefined;
  }
  const [, hex, octal, decimal, suffix] = m;
  const value =
    hex !== undefined ? BigInt(`0x${hex}`) : octal !== undefined ? BigInt(`0o${octal || '0'}`) : BigInt(decimal);
  return { value, suffix };
}

/** The value of the integer constant expression in `r`, of literals, `+ - * /` and parentheses — the
 *  `u8 pad3[0x4 - 0x3]` a decomp header sizes its padding with — or undefined for anything else. */
export function constantValue(tokens: Tokens, r: Range): number | undefined {
  let at = r.from;
  const next = (): string | undefined => (at < r.to ? tokens.text(at++) : undefined);
  const primary = (): number | undefined => {
    const k = at;
    const t = next();
    if (t === '(') {
      const v = sum();
      return next() === ')' ? v : undefined;
    }
    if (t === '-') {
      const v = primary();
      return v === undefined ? undefined : -v;
    }
    const literal = t !== undefined && tokens.kind(k) === 'number' ? integerLiteral(t) : undefined;
    return literal === undefined ? undefined : Number(literal.value);
  };
  const product = (): number | undefined => {
    let v = primary();
    while (v !== undefined && at < r.to && (tokens.is(at, '*') || tokens.is(at, '/'))) {
      const op = next();
      const right = primary();
      v =
        right === undefined || (op === '/' && right === 0) ? undefined : op === '*' ? v * right : Math.trunc(v / right);
    }
    return v;
  };
  const sum = (): number | undefined => {
    let v = product();
    while (v !== undefined && at < r.to && (tokens.is(at, '+') || tokens.is(at, '-'))) {
      const op = next();
      const right = product();
      v = right === undefined ? undefined : op === '+' ? v + right : v - right;
    }
    return v;
  };
  const v = sum();
  return at === r.to ? v : undefined;
}
