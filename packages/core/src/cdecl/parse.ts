// asmlift — the DECLARATIONS of a C or C++ declaration context, read by recursive descent over its
// tokens (`lex.ts`).
//
// WHAT IS READ. Top-level declarations and function definitions, descending into `extern "C" { }`.
// Skipped whole, as nothing they declare has C linkage: `namespace` and `extern "C++"` blocks,
// `template` and `using` statements, and a top-level `asm("…")`. A function's body and a tag's body
// are kept as token ranges and not read: a struct or union body's members are read when a layout
// asks for them (`memberDeclarations`).
//
// A DECLARATOR IS READ AS C READS IT, from the name outward: `(*rows)[8]` is a pointer to an array
// of 8, `*rows[8]` an array of 8 pointers, and `(*getcb(void))(u8)` a function returning a pointer
// to a function. So the type of every name is its specifiers plus its derivations, in order.
//
// A STATEMENT THIS CANNOT READ IS COUNTED, never guessed at: its first token goes to `unread`, and
// reading resumes after its `;` or its body. A function's parameter list that cannot be read is
// counted apart, in `unreadLists`, and its derivation carries no parameters: the declaration around
// it is still read.
//
// THE LANGUAGE DECIDES THE KEYWORDS. A word C++ alone reserves (`class`, `operator`, `friend`, …) is
// an identifier in C, which may name a parameter or a member with it.
//
// A NAME IN PARENTHESES IN A PARAMETER IS A TYPE WHERE IT NAMES ONE (C99 6.7.5.3p11): with `typedef
// int T;`, `char (T)` is a function taking a T, and `char (c)` is a char named c. The names a context
// declares as types are gathered as it is read, and a name it does not declare as one may still be a
// type it never saw (a raw header's), so a parameter that parenthesises one is not read — unless a
// list or an extent follows, as in `void (callback)(void *)`: a type there would make a function
// that returns a function or an array.
//
// UNKNOWN WORDS. A run of identifiers between the type and the declarator is read as unknown words,
// the last identifier being the name: `struct Blob64 EWRAM_FN makeblob(…)` is a raw header's
// unexpanded macro, and the type it qualifies is still the one spelled. So is an identifier ahead of
// a type keyword: `NAKED void f(…)`, `EWRAM_FN struct Blob64 f(…)`. Valid C puts an identifier in
// neither place.
import { type Tokens, lex } from './lex';

/** A half-open run of token indices: `from` is the first token, `to` is past the last. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

export type Qualifier = 'const' | 'volatile';

export type TagKeyword = 'struct' | 'union' | 'enum' | 'class';

/** An `__attribute__((…))` or `__declspec(…)`, by its source text and where it was written: among
 *  the specifiers ahead of a tag's body, straight after that body, elsewhere among the specifiers,
 *  or on a declarator. A member's attributes are its own declaration's. */
export interface Attribute {
  readonly text: string;
  readonly site: 'specifier' | 'before-body' | 'after-body' | 'declarator';
}

export type TypeSpecifier =
  /** `unsigned int`, `Vec`, `A::B`, `TVec3<f32>`; none for a constructor, a destructor or a
   *  conversion operator */
  | { readonly kind: 'words'; readonly words: string[] }
  /** `base`: a C++ base clause or an enum's underlying type ahead of the body */
  | {
      readonly kind: 'tag';
      readonly keyword: TagKeyword;
      readonly tag?: string;
      readonly body?: Range;
      readonly base: boolean;
    };

export interface Specifiers {
  typedef: boolean;
  /** `extern`, `static`, `inline`, mwcc's `asm`, C++'s `virtual` … */
  storage: string[];
  qualifiers: Qualifier[];
  type: TypeSpecifier;
  /** identifiers ahead of a type keyword or between the type and the declarator: an unexpanded
   *  macro */
  unknownWords: string[];
  attributes: Attribute[];
  /** the qualifiers, the type and the unknown words in the order they are written, one space apart:
   *  `u8 const`, `struct R2`, `struct Blob64 EWRAM_FN`. A tag's body is not part of it */
  spelling: string;
}

export type Derivation =
  /** `member`: the class of a C++ pointer to member (`void (T::*)(A)`) */
  | { readonly kind: 'pointer'; readonly qualifiers: Qualifier[]; readonly member?: string }
  | { readonly kind: 'reference' }
  | { readonly kind: 'array'; readonly size?: Range }
  /** `list`: the tokens between the parentheses. `params` is absent where they could not be read;
   *  `()` is an empty list */
  | {
      readonly kind: 'function';
      readonly list: Range;
      readonly params?: Parameter[];
      readonly variadic: boolean;
    };

export interface Declarator {
  /** absent for an abstract declarator and an unnamed bit-field */
  name?: string;
  /** from the name outward, as C reads it: `(*f)[8]` is [pointer, array 8] */
  derivations: Derivation[];
  attributes: Attribute[];
  /** a member's bit width */
  bits?: Range;
}

export interface Parameter {
  specifiers: Specifiers;
  declarator: Declarator;
}

export interface Declaration {
  specifiers: Specifiers;
  declarators: Declarator[];
  /** a function definition: its body, braces excluded */
  body?: Range;
}

export type Language = 'c' | 'c++';

export interface ParsedContext {
  declarations: Declaration[];
  /** the first token of each statement that was not read */
  unread: number[];
  /** the `(` of each parameter list that was not read */
  unreadLists: number[];
  tokens: Tokens;
  language: Language;
  /** the names the top level declares as types: each typedef's, and in C++ each tag's */
  typeNames: ReadonlySet<string>;
}

export function parseDeclarations(src: string, language: Language): ParsedContext {
  const tokens = lex(src);
  const typeNames = new Set<string>();
  const parser = new Parser(tokens, language, typeNames);
  const declarations: Declaration[] = [];
  parser.topLevel(0, tokens.count, declarations, typeNames);
  return { declarations, unread: parser.unread, unreadLists: parser.unreadLists, tokens, language, typeNames };
}

/** A type name, `const u8 *` or `f32 (*)[3]`: its specifiers and abstract declarator, over its own
 *  tokens. */
export interface TypeName extends Parameter {
  tokens: Tokens;
}

/** The type name `src` spells, or undefined where it is anything else. A type name declares no name,
 *  so every name in it is a type. */
export function parseTypeName(src: string): TypeName | undefined {
  const tokens = lex(src);
  const p = new Parser(tokens, 'c++', 'every');
  const specifiers = p.specifiers(tokens.count, 'parameter');
  const declarator = specifiers === null ? null : p.declarator(tokens.count, 'parameter');
  return specifiers !== null && declarator !== null && declarator.name === undefined && p.i === tokens.count
    ? { specifiers, declarator, tokens }
    : undefined;
}

/** A struct, union or class body's member declarations, or undefined when one of them cannot be
 *  read. A C++ access label is not a member, and a member template or `using` declares no storage.
 *  A member's parameter list that cannot be read leaves the member read, as at the top level. */
export function memberDeclarations(ctx: ParsedContext, body: Range): Declaration[] | undefined {
  const p = new Parser(ctx.tokens, ctx.language, ctx.typeNames);
  const out: Declaration[] = [];
  p.i = body.from;
  while (p.i < body.to) {
    const k = p.i;
    if (p.t.char(k) === SEMICOLON) {
      p.i++;
    } else if (p.cxx && ACCESS.has(p.t.text(k)) && p.t.char(k + 1) === COLON && !p.t.is(k + 1, '::')) {
      p.i += 2;
    } else if (p.cxx && p.t.is(k, 'using')) {
      p.skipStatement(body.to);
    } else if (p.cxx && p.t.is(k, 'template')) {
      if (!p.template(body.to, 'member')) {
        return undefined;
      }
    } else {
      const d = p.declaration(body.to, 'member');
      if (d === null) {
        return undefined;
      }
      out.push(d);
    }
  }
  return out;
}

type Context = 'top' | 'member' | 'parameter';

const SEMICOLON = 59;
const COLON = 58;
const COMMA = 44;
const EQUALS = 61;
const STAR = 42;
const AMPERSAND = 38;
const TILDE = 126;
const OPEN_PAREN = 40;
const CLOSE_PAREN = 41;
const OPEN_BRACKET = 91;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const LESS = 60;
const GREATER = 62;
const CARET = 94;

const QUALIFIERS: ReadonlyMap<string, Qualifier> = new Map([
  ['const', 'const'],
  ['volatile', 'volatile'],
]);
const C_STORAGE = [
  'extern',
  'static',
  'inline',
  '__inline',
  '__inline__',
  'register',
  'auto',
  'asm',
  '__asm',
  '__asm__',
];
const STORAGE: Record<Language, ReadonlySet<string>> = {
  c: new Set(C_STORAGE),
  'c++': new Set([...C_STORAGE, 'virtual', 'explicit', 'friend', 'mutable']),
};
const BASIC = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned']);
/** a type word that combines with no other: after one, it is the name being declared, as C89
 *  reserves none of them (`typedef unsigned long bool;`) */
const LONE = new Set(['bool', '_Bool', 'wchar_t']);
const TAGS: Record<Language, ReadonlySet<string>> = {
  c: new Set<TagKeyword>(['struct', 'union', 'enum']),
  'c++': new Set<TagKeyword>(['struct', 'union', 'enum', 'class']),
};
const ATTRIBUTES = new Set(['__attribute__', '__attribute', '__declspec']);
const ASM = new Set(['asm', '__asm', '__asm__']);
const ACCESS = new Set(['public', 'private', 'protected']);
/** what may follow a function declarator's `)`: a member function's qualifiers and specifiers */
const FUNCTION_SUFFIXES = new Set(['const', 'volatile', 'throw', 'noexcept', 'override', 'final']);

class Parser {
  readonly t: Tokens;
  i = 0;
  readonly unread: number[] = [];
  readonly unreadLists: number[] = [];
  readonly cxx: boolean;
  readonly storage: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
  /** the names declared as types so far; in a type name, every name */
  readonly types: ReadonlySet<string> | 'every';

  constructor(t: Tokens, language: Language, types: ReadonlySet<string> | 'every') {
    this.t = t;
    this.cxx = language === 'c++';
    this.storage = STORAGE[language];
    this.tags = TAGS[language];
    this.types = types;
  }

  /** The declarations from `from` to `to`, into `out`, and the names they declare as types, into
   *  `types`. */
  topLevel(from: number, to: number, out: Declaration[], types: Set<string>): void {
    this.i = from;
    while (this.i < to) {
      const k = this.i;
      const c = this.t.char(k);
      if (c === SEMICOLON) {
        this.i++;
      } else if (c === CLOSE_BRACE) {
        this.unread.push(k);
        this.i++;
      } else if (this.t.is(k, 'extern') && this.t.kind(k + 1) === 'string' && this.t.char(k + 2) === OPEN_BRACE) {
        const close = this.closing(k + 2, to);
        if (this.t.is(k + 1, '"C"')) {
          this.topLevel(k + 3, close, out, types);
        }
        this.i = Math.min(close + 1, to);
      } else if (this.cxx && this.t.is(k, 'namespace')) {
        let j = k + 1;
        while (j < to && this.t.char(j) !== OPEN_BRACE && this.t.char(j) !== SEMICOLON) {
          j++;
        }
        this.i = this.t.char(j) === OPEN_BRACE ? Math.min(this.closing(j, to) + 1, to) : j + 1;
      } else if (
        (this.cxx && this.t.is(k, 'using')) ||
        (ASM.has(this.t.text(k)) && this.t.char(k + 1) === OPEN_PAREN)
      ) {
        this.skipStatement(to);
      } else if (this.cxx && this.t.is(k, 'template')) {
        this.template(to, 'top');
      } else {
        const d = this.declaration(to, 'top');
        if (d === null) {
          this.unread.push(k);
          this.i = k;
          this.skipStatement(to);
        } else {
          out.push(d);
          declaresTypes(d, this.cxx, types);
        }
      }
    }
  }

  /** A `template <…>` declaration, read and discarded: what it declares is never called by a C
   *  name. One that cannot be read is counted. */
  template(to: number, context: Context): boolean {
    const k = this.i;
    while (this.t.is(this.i, 'template')) {
      this.i++;
      if (this.t.char(this.i) === LESS && !this.angles(to)) {
        break;
      }
    }
    if (!this.t.is(this.i, 'template') && this.declaration(to, context) !== null) {
      return true;
    }
    this.unread.push(k);
    this.i = k;
    this.skipStatement(to);
    return false;
  }

  /** Past the statement at `i`: its `;`, or the end of a block that ends it. */
  skipStatement(to: number): void {
    while (this.i < to) {
      const c = this.t.char(this.i);
      if (c === SEMICOLON) {
        this.i++;
        return;
      }
      const close = this.t.match(this.i);
      if ((c === OPEN_BRACE || c === OPEN_PAREN || c === OPEN_BRACKET) && close > this.i && close < to) {
        this.i = close + 1;
        if (c === OPEN_BRACE) {
          if (this.t.char(this.i) === SEMICOLON) {
            this.i++;
          }
          return;
        }
      } else {
        this.i++;
      }
    }
  }

  declaration(to: number, context: Context): Declaration | null {
    const specifiers = this.specifiers(to, context);
    if (specifiers === null) {
      return null;
    }
    const declarators: Declarator[] = [];
    if (this.t.char(this.i) === SEMICOLON) {
      this.i++;
      return { specifiers, declarators };
    }
    for (;;) {
      const d = this.declarator(to, context);
      if (d === null) {
        return null;
      }
      this.declaratorTail(d);
      const fn = d.derivations[0]?.kind === 'function';
      const c = this.t.char(this.i);
      if (c === COLON && !this.t.is(this.i, '::')) {
        if (fn) {
          // a constructor's initializer list, up to its body
          while (this.i < to && this.t.char(this.i) !== OPEN_BRACE && this.t.char(this.i) !== SEMICOLON) {
            this.step(to);
          }
        } else if (context === 'member') {
          this.i++;
          const from = this.i;
          this.skipInitializer(to);
          d.bits = { from, to: this.i };
        } else {
          // mwcc's `extern volatile u16 REG : 0xCC006000;` places the variable at an address
          this.skipInitializer(to);
        }
      } else if (c === EQUALS || (c === OPEN_BRACE && !fn)) {
        this.skipInitializer(to);
      }
      if (d.name === undefined && d.bits === undefined) {
        return null;
      }
      declarators.push(d);
      const next = this.t.char(this.i);
      if (next === COMMA) {
        this.i++;
      } else if (next === SEMICOLON) {
        this.i++;
        return { specifiers, declarators };
      } else if (next === OPEN_BRACE && fn && declarators.length === 1) {
        const close = this.t.match(this.i);
        if (close < 0 || close >= to) {
          return null;
        }
        const body = { from: this.i + 1, to: close };
        this.i = close + 1;
        return { specifiers, declarators, body };
      } else {
        return null;
      }
    }
  }

  /** The specifiers at `i`, or null where there are none. A declaration may have none ahead of a
   *  constructor's, destructor's or conversion operator's name. */
  specifiers(to: number, context: Context): Specifiers | null {
    const from = this.i;
    const basic: string[] = [];
    const written: string[] = [];
    const s: Specifiers = {
      typedef: false,
      storage: [],
      qualifiers: [],
      type: { kind: 'words', words: basic },
      unknownWords: [],
      attributes: [],
      spelling: '',
    };
    let typed: 'none' | 'basic' | 'name' | 'tag' = 'none';
    let afterBody = false;
    while (this.i < to) {
      const k = this.i;
      if (this.isAttribute(k)) {
        s.attributes.push(this.attribute(afterBody ? 'after-body' : 'specifier'));
        continue;
      }
      afterBody = false;
      const kind = this.t.kind(k);
      if (kind === 'string' && this.t.is(k - 1, 'extern')) {
        this.i++;
        continue;
      }
      if (kind !== 'identifier') {
        if (typed === 'none' && this.t.is(k, '::') && this.t.kind(k + 1) === 'identifier') {
          s.type = { kind: 'words', words: [this.typeName(to)] };
          written.push(s.type.words[0]);
          typed = 'name';
          continue;
        }
        break;
      }
      const w = this.t.text(k);
      const qualifier = QUALIFIERS.get(w);
      if (w === 'typedef') {
        s.typedef = true;
        this.i++;
      } else if (qualifier !== undefined) {
        s.qualifiers.push(qualifier);
        written.push(w);
        this.i++;
      } else if (this.storage.has(w)) {
        s.storage.push(w);
        this.i++;
      } else if (this.cxx && w === 'typename') {
        this.i++;
      } else if (typed === 'name' && (BASIC.has(w) || this.tags.has(w))) {
        // what was read as the type is an unknown word ahead of it
        s.unknownWords.unshift(...(s.type.kind === 'words' ? s.type.words : []));
        s.type = { kind: 'words', words: basic };
        typed = 'none';
      } else if (BASIC.has(w) || (LONE.has(w) && typed === 'none')) {
        if (typed !== 'none' && typed !== 'basic') {
          break;
        }
        basic.push(w);
        written.push(w);
        typed = 'basic';
        this.i++;
      } else if (this.tags.has(w)) {
        if (typed !== 'none') {
          break;
        }
        const tag = this.tag(s, w as TagKeyword, to, context);
        s.type = tag;
        written.push(tag.tag === undefined ? w : `${w} ${tag.tag}`);
        typed = 'tag';
        afterBody = tag.body !== undefined;
        if (afterBody) {
          s.attributes = s.attributes.map((a) => (a.site === 'specifier' ? { ...a, site: 'before-body' } : a));
        }
      } else if (this.cxx && w === 'operator') {
        break;
      } else if (typed === 'none') {
        if (context !== 'parameter' && this.namesDeclarator(k)) {
          break;
        }
        s.type = { kind: 'words', words: [this.typeName(to)] };
        written.push(s.type.words[0]);
        typed = 'name';
      } else if (this.isUnknownWord(k)) {
        s.unknownWords.push(w);
        written.push(w);
        this.i++;
      } else {
        break;
      }
    }
    s.spelling = written.join(' ');
    if (this.i > from) {
      return s;
    }
    return context !== 'parameter' && this.startsName(from) ? s : null;
  }

  /** A struct, union, enum or class specifier: its tag, its base clause, its body. */
  tag(s: Specifiers, keyword: TagKeyword, to: number, context: Context): Extract<TypeSpecifier, { kind: 'tag' }> {
    this.i++;
    this.beforeBody(s);
    const tag = this.t.kind(this.i) === 'identifier' && !this.isAttribute(this.i) ? this.typeName(to) : undefined;
    this.beforeBody(s);
    let base = false;
    if (this.t.char(this.i) === COLON && !this.t.is(this.i, '::') && context !== 'parameter') {
      // a base clause or an enum base runs to the body; a `:` with no body after it is a bit width
      let j = this.i;
      for (; j < to; j++) {
        const c = this.t.char(j);
        if (c === OPEN_BRACE || c === SEMICOLON || c === CLOSE_PAREN) {
          break;
        }
        if ((c === OPEN_PAREN || c === OPEN_BRACKET) && this.t.match(j) > j) {
          j = this.t.match(j);
        }
      }
      if (this.t.char(j) === OPEN_BRACE) {
        base = true;
        this.i = j;
      }
    }
    let body: Range | undefined;
    const close = this.t.match(this.i);
    if (this.t.char(this.i) === OPEN_BRACE && close > this.i && close < to) {
      body = { from: this.i + 1, to: close };
      this.i = close + 1;
    }
    return { kind: 'tag', keyword, ...(tag !== undefined ? { tag } : {}), ...(body ? { body } : {}), base };
  }

  beforeBody(s: Specifiers): void {
    while (this.isAttribute(this.i)) {
      s.attributes.push(this.attribute('before-body'));
    }
  }

  /** A type's name at `i`: `Vec`, `::Vec`, `A::B`, `TVec3<f32>`, `A<B>::C`. */
  typeName(to: number): string {
    const from = this.i;
    if (this.t.is(this.i, '::')) {
      this.i++;
    }
    for (;;) {
      this.i++;
      if (this.t.char(this.i) === LESS && !this.angles(to)) {
        break;
      }
      if (!this.t.is(this.i, '::') || this.t.kind(this.i + 1) !== 'identifier' || this.t.is(this.i + 1, 'operator')) {
        break;
      }
      this.i++;
    }
    return this.spelled(from, this.i);
  }

  /** Past a template argument list at `i` (`<`), or false, having moved nothing, where none closes
   *  before the statement ends. */
  angles(to: number): boolean {
    const from = this.i;
    let depth = 0;
    for (let j = from; j < to; j++) {
      const c = this.t.char(j);
      if (c === LESS) {
        depth++;
      } else if (c === GREATER && --depth === 0) {
        this.i = j + 1;
        return true;
      } else if (c === SEMICOLON || c === OPEN_BRACE) {
        return false;
      } else if ((c === OPEN_PAREN || c === OPEN_BRACKET) && this.t.match(j) > j) {
        j = this.t.match(j);
      }
    }
    return false;
  }

  /** Whether the identifier at `k`, where no type has been read, is a declarator's name: a
   *  destructor's or an operator's qualified name, or a name called like a function — a
   *  constructor's, or C's implicit `int` — and not a type ahead of `(*`. */
  namesDeclarator(k: number): boolean {
    let j = k;
    while (this.t.is(j + 1, '::')) {
      if (this.t.char(j + 2) === TILDE || this.t.is(j + 2, 'operator')) {
        return true;
      }
      if (this.t.kind(j + 2) !== 'identifier') {
        return false;
      }
      j += 2;
    }
    return this.t.char(j + 1) === OPEN_PAREN && !this.opensPointer(j + 1);
  }

  /** Whether a declarator's name, with no specifiers ahead of it, starts at `k`. */
  startsName(k: number): boolean {
    return (
      (this.t.char(k) === TILDE && this.t.kind(k + 1) === 'identifier') ||
      (this.cxx && this.t.is(k, 'operator')) ||
      (this.t.kind(k) === 'identifier' && this.namesDeclarator(k))
    );
  }

  /** Whether the identifier at `k`, after the type, is an unknown word rather than the name: another
   *  identifier, or a declarator's `*` or `&`, follows it. */
  isUnknownWord(k: number): boolean {
    const n = k + 1;
    const c = this.t.char(n);
    if (c === STAR || c === AMPERSAND) {
      return true;
    }
    if (this.t.kind(n) !== 'identifier') {
      return false;
    }
    const w = this.t.text(n);
    return !this.isAttribute(n) && !ASM.has(w) && !QUALIFIERS.has(w) && !FUNCTION_SUFFIXES.has(w);
  }

  isAttribute(k: number): boolean {
    return (
      this.t.char(k + 1) === OPEN_PAREN &&
      this.t.kind(k) === 'identifier' &&
      ATTRIBUTES.has(this.t.text(k)) &&
      this.t.match(k + 1) > k
    );
  }

  /** The attribute at `i`, read past. */
  attribute(site: Attribute['site']): Attribute {
    const close = this.t.match(this.i + 1);
    const text = this.t.src.slice(this.t.start(this.i), this.t.end(close));
    this.i = close + 1;
    return { text, site };
  }

  /** A declarator at `i`, abstract or named. */
  declarator(to: number, context: Context): Declarator | null {
    const prefix: Derivation[] = [];
    const attributes: Attribute[] = [];
    for (;;) {
      const c = this.t.char(this.i);
      const member = c === -1 ? this.memberPointer() : undefined;
      if (c === STAR || member !== undefined) {
        this.i++;
        const qualifiers = this.pointerQualifiers(attributes);
        prefix.push({ kind: 'pointer', qualifiers, ...(member !== undefined ? { member } : {}) });
      } else if (c === AMPERSAND) {
        this.i++;
        if (this.t.char(this.i) === AMPERSAND) {
          this.i++;
        }
        prefix.push({ kind: 'reference' });
      } else {
        break;
      }
    }
    let inner: Declarator | undefined;
    let name: string | undefined;
    const groups = this.t.char(this.i) === OPEN_PAREN && this.groupsDeclarator(this.i, context);
    if (groups === undefined) {
      return null;
    }
    if (groups) {
      const close = this.t.match(this.i);
      if (close < 0 || close >= to) {
        return null;
      }
      this.i++;
      const d = this.declarator(close, context);
      if (d === null || this.i !== close) {
        return null;
      }
      inner = d;
      this.i = close + 1;
    } else if (this.startsName(this.i) || this.isName(this.i)) {
      name = this.declaratorName(to);
    }
    const suffixes: Derivation[] = [];
    for (;;) {
      const c = this.t.char(this.i);
      const close = this.t.match(this.i);
      if ((c === OPEN_BRACKET || c === OPEN_PAREN) && (close < 0 || close >= to)) {
        return null;
      }
      if (c === OPEN_BRACKET) {
        suffixes.push({ kind: 'array', ...(close > this.i + 1 ? { size: { from: this.i + 1, to: close } } : {}) });
        this.i = close + 1;
      } else if (c === OPEN_PAREN) {
        const read = this.parameters(this.i + 1, close);
        if (read === undefined) {
          this.unreadLists.push(this.i);
        }
        suffixes.push({
          kind: 'function',
          list: { from: this.i + 1, to: close },
          ...(read ? { params: read.params } : {}),
          variadic: read?.variadic ?? false,
        });
        this.i = close + 1;
        this.functionSuffixes(attributes);
      } else {
        break;
      }
    }
    return {
      ...(inner?.name !== undefined ? { name: inner.name } : name !== undefined ? { name } : {}),
      derivations: [...(inner?.derivations ?? []), ...suffixes, ...prefix.reverse()],
      attributes: [...(inner?.attributes ?? []), ...attributes],
    };
  }

  /** The class of a pointer to member at `i` (`T::*`), with `i` left on its `*`; or undefined. */
  memberPointer(): string | undefined {
    let j = this.i;
    while (this.t.kind(j) === 'identifier' && this.t.is(j + 1, '::')) {
      if (this.t.char(j + 2) === STAR) {
        const member = this.spelled(this.i, j + 1);
        this.i = j + 2;
        return member;
      }
      j += 2;
    }
    return undefined;
  }

  pointerQualifiers(attributes: Attribute[]): Qualifier[] {
    const qualifiers: Qualifier[] = [];
    for (;;) {
      const q = QUALIFIERS.get(this.t.text(this.i));
      if (this.t.kind(this.i) === 'identifier' && q !== undefined) {
        qualifiers.push(q);
        this.i++;
      } else if (this.isAttribute(this.i)) {
        attributes.push(this.attribute('declarator'));
      } else {
        return qualifiers;
      }
    }
  }

  /** Whether the `(` at `k`, where a declarator's name could start, opens a nested declarator
   *  (`(*f)`, `(T::*m)`, `(name)`) rather than a parameter list; undefined in a parameter, where a
   *  name in it that is no type may be either. */
  groupsDeclarator(k: number, context: Context): boolean | undefined {
    if (this.opensPointer(k)) {
      return true;
    }
    if (this.t.kind(k + 1) !== 'identifier' || this.isAttribute(k + 1)) {
      return false;
    }
    if (context !== 'parameter') {
      return true;
    }
    if (this.startsType(k + 1)) {
      return false;
    }
    const next = this.t.char(k + 3);
    return this.t.match(k) === k + 2 && (next === OPEN_PAREN || next === OPEN_BRACKET) ? true : undefined;
  }

  /** Whether the identifier at `k` starts a type: a word only a declaration's specifiers start
   *  with, a name declared as a type, or a C++ qualified or template name. */
  startsType(k: number): boolean {
    const w = this.t.text(k);
    return (
      QUALIFIERS.has(w) ||
      BASIC.has(w) ||
      this.storage.has(w) ||
      this.tags.has(w) ||
      (this.cxx && (LONE.has(w) || w === 'typename' || this.t.is(k + 1, '::') || this.t.char(k + 1) === LESS)) ||
      this.types === 'every' ||
      this.types.has(w)
    );
  }

  /** Whether the `(` at `k` opens a pointer's or a reference's declarator: `(*`, `(&`, `(T::*`. */
  opensPointer(k: number): boolean {
    const c = this.t.char(k + 1);
    if (c === STAR || c === AMPERSAND || c === CARET) {
      return true;
    }
    const save = this.i;
    this.i = k + 1;
    const member = this.memberPointer() !== undefined;
    this.i = save;
    return member;
  }

  isName(k: number): boolean {
    if (this.t.kind(k) !== 'identifier' || this.isAttribute(k)) {
      return false;
    }
    const w = this.t.text(k);
    return !QUALIFIERS.has(w) && !BASIC.has(w) && !this.tags.has(w);
  }

  /** A declarator's name at `i`: `f`, `A::f`, `A::~A`, `operator==`, `A::operator new[]`. */
  declaratorName(to: number): string {
    const parts: string[] = [];
    for (;;) {
      if (this.t.char(this.i) === TILDE) {
        parts.push(`~${this.t.text(this.i + 1)}`);
        this.i += 2;
      } else if (this.cxx && this.t.is(this.i, 'operator')) {
        parts.push(this.operatorName(to));
      } else {
        parts.push(this.t.text(this.i));
        this.i++;
        if (this.t.char(this.i) === LESS) {
          const from = this.i;
          if (this.angles(to) && (this.t.char(this.i) === OPEN_PAREN || this.t.is(this.i, '::'))) {
            parts[parts.length - 1] += this.spelled(from, this.i);
          } else {
            this.i = from;
          }
        }
      }
      const next = this.i + 1;
      if (
        !this.t.is(this.i, '::') ||
        !(this.t.kind(next) === 'identifier' || (this.t.char(next) === TILDE && this.t.kind(next + 1) === 'identifier'))
      ) {
        return parts.join('::');
      }
      this.i++;
    }
  }

  /** `operator` and what it names, up to its parameter list: `operator()`, `operator[]`,
   *  `operator new[]`, `operator==`, `operator int`. */
  operatorName(to: number): string {
    const from = this.i;
    this.i++;
    if (this.t.char(this.i) === OPEN_PAREN && this.t.match(this.i) === this.i + 1) {
      this.i += 2;
    }
    while (this.i < to && this.t.char(this.i) !== OPEN_PAREN) {
      this.i++;
    }
    return this.spelled(from, this.i);
  }

  /** What may follow a function declarator's `)`: `const`, `throw(…)`, `noexcept`, attributes. */
  functionSuffixes(attributes: Attribute[]): void {
    for (;;) {
      if (this.isAttribute(this.i)) {
        attributes.push(this.attribute('declarator'));
      } else if (this.t.kind(this.i) === 'identifier' && FUNCTION_SUFFIXES.has(this.t.text(this.i))) {
        this.i++;
        if (this.t.char(this.i) === OPEN_PAREN && this.t.match(this.i) > this.i) {
          this.i = this.t.match(this.i) + 1;
        }
      } else {
        return;
      }
    }
  }

  /** What a declaration may write after a declarator: attributes, and a symbol name `asm("sym")`. */
  declaratorTail(d: Declarator): void {
    for (;;) {
      if (this.isAttribute(this.i)) {
        d.attributes.push(this.attribute('declarator'));
      } else if (
        ASM.has(this.t.text(this.i)) &&
        this.t.kind(this.i) === 'identifier' &&
        this.t.char(this.i + 1) === OPEN_PAREN &&
        this.t.match(this.i + 1) > this.i
      ) {
        this.i = this.t.match(this.i + 1) + 1;
      } else {
        return;
      }
    }
  }

  /** The parameters between `from` and `to`, or undefined where they cannot be read. */
  parameters(from: number, to: number): { params: Parameter[]; variadic: boolean } | undefined {
    const save = this.i;
    this.i = from;
    const params: Parameter[] = [];
    let variadic = false;
    let read = true;
    while (read && this.i < to) {
      if (this.t.is(this.i, '...')) {
        variadic = true;
        this.i++;
      } else {
        const specifiers = this.specifiers(to, 'parameter');
        const declarator = specifiers === null ? null : this.declarator(to, 'parameter');
        if (specifiers === null || declarator === null) {
          read = false;
          break;
        }
        this.declaratorTail(declarator);
        if (this.t.char(this.i) === EQUALS) {
          this.skipInitializer(to);
        }
        params.push({ specifiers, declarator });
      }
      if (this.i < to) {
        read = this.t.char(this.i) === COMMA && this.i + 1 < to && !variadic;
        this.i++;
      }
    }
    this.i = save;
    return read ? { params, variadic } : undefined;
  }

  /** Past an initializer, a bit width or an address, up to the `,` or `;` after it. */
  skipInitializer(to: number): void {
    while (this.i < to && this.t.char(this.i) !== COMMA && this.t.char(this.i) !== SEMICOLON) {
      this.step(to);
    }
  }

  /** One token on, or past the bracket the token at `i` opens. */
  step(to: number): void {
    const c = this.t.char(this.i);
    const close = this.t.match(this.i);
    this.i =
      (c === OPEN_PAREN || c === OPEN_BRACKET || c === OPEN_BRACE) && close > this.i && close < to
        ? close + 1
        : this.i + 1;
  }

  /** The `}` or `)` closing the bracket at `k`, or `to` where none closes it before `to`. */
  closing(k: number, to: number): number {
    const close = this.t.match(k);
    return close > k && close < to ? close : to;
  }

  /** The tokens from `from` to `to` as one spelling: a space between two words, none elsewhere. */
  spelled(from: number, to: number): string {
    if (to === from + 1) {
      return this.t.text(from);
    }
    let out = '';
    for (let k = from; k < to; k++) {
      const word = this.t.kind(k) === 'identifier' || this.t.kind(k) === 'number';
      if (word && k > from && (this.t.kind(k - 1) === 'identifier' || this.t.kind(k - 1) === 'number')) {
        out += ' ';
      }
      out += this.t.text(k);
    }
    return out;
  }
}

/** The names a top-level declaration declares as types, into `types`: a typedef's, and in C++ the tag
 *  it names. */
function declaresTypes(d: Declaration, cxx: boolean, types: Set<string>): void {
  if (d.specifiers.typedef) {
    for (const x of d.declarators) {
      if (x.name !== undefined) {
        types.add(x.name);
      }
    }
  }
  if (cxx && d.specifiers.type.kind === 'tag' && d.specifiers.type.tag !== undefined) {
    types.add(d.specifiers.type.tag);
  }
}
