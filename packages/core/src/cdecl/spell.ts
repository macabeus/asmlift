// asmlift — the PRINTER of what the parser reads: a declared type in asmlift's type vocabulary
// (`ParamType`): `u8 *`, `void (*)(s32 channel)`, `f32 (*)[3]`, and every run of tokens a spelling
// holds, as written.
//
// The derivations come from the parser (`parse.ts`), listed from the declarator's name outward, so
// the printer rebuilds the abstract declarator from the inside: a pointer is written ahead of what it
// binds, an array or a function after it, and a pointer that an array or a function binds next is
// grouped in parentheses.
//
// A RUN OF TOKENS IS PRINTED AS WRITTEN, one space wherever the source separates two of them: a type's
// name (`A::B`, `TVec3<const u8 *>`), a member pointer's class, a function's parameter list and an
// array's extent alike. A function pointer's own parameters are part of its spelling, not types this
// reads.
import type { Tokens } from './lex';
import type { DeclaredType, Range } from './parse';

/** The type `t` spells: its qualifiers, its base and its abstract declarator, `const u8 *`. */
export function spellType(t: DeclaredType, tokens: Tokens): string {
  const base = t.qualifiers.length === 0 ? t.spelling : [...t.qualifiers, t.spelling].filter((w) => w !== '').join(' ');
  let declarator = '';
  // whether the last derivation was written ahead: an array or a function after it groups it in parentheses
  let prefixed = false;
  // whether the declarator is only the extents and lists written straight after the absent name
  let suffixes = true;
  for (const d of t.derivations) {
    if (d.kind === 'pointer' || d.kind === 'reference') {
      const own =
        d.kind === 'reference' ? '&' : [`${d.member !== undefined ? `${d.member}::` : ''}*`, ...d.qualifiers].join(' ');
      // a pointer is a word kept apart from what it binds, `u8 * *`, unless that is the name's own suffix
      declarator = declarator === '' || suffixes ? own + declarator : `${own} ${declarator}`;
      prefixed = true;
      suffixes = false;
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

/** A parameter's type as C adjusts it: an array nearest the name is a pointer to what it holds, and a
 *  function nearest the name a pointer to it. `f32 m[2][3]` is `f32 (*)[3]`, and `int fn(int)` is
 *  `int (*)(int)`. */
export function asParameter(t: DeclaredType): DeclaredType {
  const [first, ...rest] = t.derivations;
  if (first?.kind === 'array') {
    return { ...t, derivations: [{ kind: 'pointer', qualifiers: [] }, ...rest] };
  }
  if (first?.kind === 'function') {
    return { ...t, derivations: [{ kind: 'pointer', qualifiers: [] }, ...t.derivations] };
  }
  return t;
}

/** The tokens of `r` as written, one space wherever the source separates two of them. */
export function written(tokens: Tokens, r: Range): string {
  let out = '';
  for (let k = r.from; k < r.to; k++) {
    if (k > r.from && tokens.start(k) > tokens.end(k - 1)) {
      out += ' ';
    }
    out += tokens.text(k);
  }
  return out;
}
