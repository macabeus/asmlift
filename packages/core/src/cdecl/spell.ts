// asmlift — a declared type printed in asmlift's type vocabulary (`ParamType`): `u8 *`,
// `void (*)(s32 channel)`, `f32 (*)[3]`. The derivations come from the parser (`parse.ts`), listed from
// the declarator's name outward, so the printer rebuilds the abstract declarator from the inside: a
// pointer is written ahead of what it binds, an array or a function after it, and a pointer that an
// array or a function binds next is grouped in parentheses.
//
// A function's parameter list and an array's extent are printed from their tokens as written, one
// space wherever the source separates two tokens: a function pointer's own parameters are part of
// its spelling, not types this reads.
import type { Tokens } from './lex';
import type { Derivation, Range } from './parse';

/** The type a base and its derivations spell. As a parameter (`parameter`), an array or a function
 *  nearest the name is adjusted to a pointer to what it holds or is, as C adjusts it: `f32 m[2][3]`
 *  is `f32 (*)[3]`, and `int fn(int)` is `int (*)(int)`. */
export function spellType(
  base: string,
  derivations: readonly Derivation[],
  tokens: Tokens,
  o: { parameter: boolean },
): string {
  let declarator = '';
  // whether the last derivation was written ahead: an array or a function after it groups it in parentheses
  let prefixed = false;
  for (const d of o.parameter ? adjusted(derivations) : derivations) {
    if (d.kind === 'pointer' || d.kind === 'reference') {
      const own =
        d.kind === 'reference' ? '&' : [`${d.member !== undefined ? `${d.member}::` : ''}*`, ...d.qualifiers].join(' ');
      // a qualifier, or a member pointer's class, is a word kept apart from its neighbour
      declarator =
        declarator !== '' && (/\w$/.test(own) || /^\w/.test(declarator)) ? `${own} ${declarator}` : own + declarator;
      prefixed = true;
    } else {
      const grouped = prefixed ? `(${declarator})` : declarator;
      declarator =
        d.kind === 'array'
          ? `${grouped}[${d.size === undefined ? '' : written(tokens, d.size)}]`
          : `${grouped}(${written(tokens, d.list)})`;
      prefixed = false;
    }
  }
  return declarator === '' ? base : `${base} ${declarator}`;
}

/** A parameter's derivations as C adjusts them: an array nearest the name becomes a pointer, and a
 *  function nearest the name gains one. */
function adjusted(derivations: readonly Derivation[]): readonly Derivation[] {
  const [first, ...rest] = derivations;
  if (first?.kind === 'array') {
    return [{ kind: 'pointer', qualifiers: [] }, ...rest];
  }
  if (first?.kind === 'function') {
    return [{ kind: 'pointer', qualifiers: [] }, ...derivations];
  }
  return derivations;
}

/** The tokens of `r` as written, one space wherever the source separates two of them. */
function written(tokens: Tokens, r: Range): string {
  let out = '';
  for (let k = r.from; k < r.to; k++) {
    if (k > r.from && tokens.start(k) > tokens.end(k - 1)) {
      out += ' ';
    }
    out += tokens.text(k);
  }
  return out;
}

const LITERAL = /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)[ul]*$/i;

/** The value of the integer constant expression in `r`, of literals, `+ - * /` and parentheses — the
 *  `u8 pad3[0x4 - 0x3]` a decomp header sizes its padding with — or undefined for anything else. A
 *  literal reads as C reads it: `0x` hexadecimal, a leading `0` octal. */
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
    return t !== undefined && tokens.kind(k) === 'number' && LITERAL.test(t)
      ? Number.parseInt(t, /^0x/i.test(t) ? 16 : /^0\d/.test(t) ? 8 : 10)
      : undefined;
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
