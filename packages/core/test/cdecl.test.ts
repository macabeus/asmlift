// The declaration reader under the context reader (src/cdecl/): what is a token, and how each shape
// of declaration reads. A declarator is printed from its name outward, as C reads it, ending in its
// specifiers' type: `rows: * → [8] → f32` is a pointer to an array of 8 `f32`.
import { describe, expect, test } from 'vitest';

import { type Tokens, lex } from '../src/cdecl/lex';
import {
  type Attribute,
  type Declaration,
  type Declarator,
  type Derivation,
  type Language,
  type ParsedContext,
  type Range,
  type Specifiers,
  memberDeclarations,
  parseDeclarations,
  parseTypeName,
} from '../src/cdecl/parse';
import { constantValue, spellType } from '../src/cdecl/spell';

const texts = (t: Tokens): string[] => Array.from({ length: t.count }, (_, k) => t.text(k));

const spelled = (t: Tokens, r: Range | undefined): string =>
  r === undefined ? '' : texts(t).slice(r.from, r.to).join(' ');

const typeOf = (s: Specifiers): string => {
  const type =
    s.type.kind === 'words'
      ? s.type.words
      : [s.type.keyword, ...(s.type.tag !== undefined ? [s.type.tag] : []), ...(s.type.body ? ['{…}'] : [])];
  return [...s.qualifiers, ...type].join(' ');
};

const derivation = (ctx: Pick<ParsedContext, 'tokens'>, d: Derivation): string => {
  switch (d.kind) {
    case 'pointer':
      return [d.member !== undefined ? `${d.member}::*` : '*', ...d.qualifiers].join(' ');
    case 'reference':
      return '&';
    case 'array':
      return `[${spelled(ctx.tokens, d.size)}]`;
    case 'function':
      return d.params === undefined
        ? '(?)'
        : `(${[...d.params.map((p) => declarator(ctx, p.specifiers, p.declarator)), ...(d.variadic ? ['...'] : [])].join(', ')})`;
  }
};

const declarator = (ctx: Pick<ParsedContext, 'tokens'>, s: Specifiers, d: Declarator): string =>
  `${d.name ?? '_'}: ${[...d.derivations.map((x) => derivation(ctx, x)), typeOf(s)].join(' → ')}` +
  (d.bits ? ` : ${spelled(ctx.tokens, d.bits)}` : '');

/** Each declaration as its declarators, or as its type where it declares none. */
const read = (ctx: ParsedContext, ds: Declaration[] = ctx.declarations): string[] =>
  ds.map((d) =>
    d.declarators.length === 0
      ? typeOf(d.specifiers)
      : d.declarators.map((x) => declarator(ctx, d.specifiers, x)).join('; '),
  );

const declarations = (src: string, language: Language): string[] => {
  const ctx = parseDeclarations(src, language);
  expect([...ctx.unread, ...ctx.unreadLists]).toEqual([]);
  return read(ctx);
};

const tagBody = (d: Declaration): Range => {
  if (d.specifiers.type.kind !== 'tag' || d.specifiers.type.body === undefined) {
    throw new Error('no tag body');
  }
  return d.specifiers.type.body;
};

const members = (src: string, language: Language, at = 0): string[] | undefined => {
  const ctx = parseDeclarations(src, language);
  const m = memberDeclarations(ctx, tagBody(ctx.declarations[at]));
  return m === undefined ? undefined : read(ctx, m);
};

const attributes = (as: Attribute[]): string[] => as.map((a) => `${a.site} ${a.text}`);

describe('the tokens of a context', () => {
  test('skips whitespace, comments and preprocessor lines, continuations included', () => {
    const src = '# 1 "a.h"\n#define F(a) \\\n  a {\n  /* { */ int // }\nx; # not a directive\n';
    expect(texts(lex(src))).toEqual(['int', 'x', ';', '#', 'not', 'a', 'directive']);
  });

  test('a directive after a comment that opens its line is still a directive', () => {
    expect(texts(lex('/* c */ # pragma once\nint x;'))).toEqual(['int', 'x', ';']);
  });

  test('keeps a literal whole, and ends one nothing closes at its newline', () => {
    const t = lex(`f("}{)", '\\'', "open\n);`);
    expect(texts(t)).toEqual(['f', '(', '"}{)"', ',', "'\\''", ',', '"open', ')', ';']);
    expect([t.kind(0), t.kind(2), t.kind(3), t.kind(t.count)]).toEqual(['identifier', 'string', 'punct', 'end']);
  });

  test('keeps `::` and `...` as one token each, and a number with its suffix and exponent', () => {
    expect(texts(lex('A::B(int, ...) x[0x1Fu] = 1.5e-3f >> 2'))).toEqual([
      'A',
      '::',
      'B',
      '(',
      'int',
      ',',
      '...',
      ')',
      'x',
      '[',
      '0x1Fu',
      ']',
      '=',
      '1.5e-3f',
      '>',
      '>',
      '2',
    ]);
  });

  test('matches brackets, and a `}` closes what its `{` left open', () => {
    const t = lex('{ ( [ ] ) } { ( } )');
    expect([t.match(0), t.match(1), t.match(2), t.match(5)]).toEqual([5, 4, 3, 0]);
    // the `(` inside the second block is closed by nothing; the stray `)` matches nothing
    expect([t.match(6), t.match(7), t.match(8), t.match(9)]).toEqual([8, -1, 6, -1]);
  });
});

describe('a declarator, read from its name outward', () => {
  test('pointers and arrays in C order, each pointer with its own qualifiers', () => {
    expect(declarations('int *a[3], (*b)[3], **c, * const * d;', 'c')).toEqual([
      'a: [3] → * → int; b: * → [3] → int; c: * → * → int; d: * → * const → int',
    ]);
  });

  test('a multi-dimensional array parameter, and one of unstated extent', () => {
    expect(declarations('void GXSetIndTexMtx(GXIndTexMtxID id, f32 offset[2][3], f32 mtx[][4]);', 'c')).toEqual([
      'GXSetIndTexMtx: (id: GXIndTexMtxID, offset: [2] → [3] → f32, mtx: [] → [4] → f32) → void',
    ]);
  });

  test('a pointer to an array, a pointer to a function pointer, and a function-typed parameter', () => {
    expect(
      declarations('void a1(f32 (*rows)[8], f32 (*)[4], void (**cb)(void), int fn(int), int (int));', 'c'),
    ).toEqual([
      'a1: (rows: * → [8] → f32, _: * → [4] → f32, cb: * → * → (_: void) → void, fn: (_: int) → int, _: (_: int) → int) → void',
    ]);
  });

  test('a function pointer, and an array of them', () => {
    expect(declarations('typedef void (*CARDCallback)(s32 channel, s32 result); int (*table[4])(void);', 'c')).toEqual([
      'CARDCallback: * → (channel: s32, result: s32) → void',
      'table: [4] → * → (_: void) → int',
    ]);
  });

  test('a function keeps the tokens of its parameter list, read or not', () => {
    const ctx = parseDeclarations('void (*cb)(s32 *chan, ...); void bad(int, = 3);', 'c');
    expect(
      ctx.declarations.map((d) =>
        d.declarators[0].derivations.flatMap((x) => (x.kind === 'function' ? [spelled(ctx.tokens, x.list)] : [])),
      ),
    ).toEqual([['s32 * chan , ...'], ['int , = 3']]);
  });

  test('a name in parentheses in a parameter: a type where one is declared, a name before a list or an extent', () => {
    const ctx = parseDeclarations(
      'typedef int T; void f(char (T), int (x)[3], void (cb)(void *)); void g(long long (x)); void h(int (x[2]));',
      'c',
    );
    expect(read(ctx)).toEqual([
      'T: int',
      'f: (_: (_: T) → char, x: [3] → int, cb: (_: * → void) → void) → void',
      'g: (?) → void',
      'h: (?) → void',
    ]);
    expect(ctx.unread).toEqual([]);
    expect(ctx.unreadLists.map((k) => ctx.tokens.text(k - 1))).toEqual(['g', 'h']);
  });

  test('a function returning a function pointer', () => {
    expect(declarations('const u32 (*getcb(void))(u8 reason, const INFO *info);', 'c')).toEqual([
      'getcb: (_: void) → * → (reason: u8, info: * → const INFO) → const u32',
    ]);
  });

  test('an empty list, `(void)` and a variadic list are each kept as written', () => {
    expect(declarations('void f(); void g(void); int printf(const char *fmt, ...);', 'c')).toEqual([
      'f: () → void',
      'g: (_: void) → void',
      'printf: (fmt: * → const char, ...) → int',
    ]);
  });

  test('qualified names, references and default arguments', () => {
    expect(
      declarations(
        'JKRAramBlock *JKRAllocFromAram(u32 size, JKRAramHeap::EAllocMode m = JKRAramHeap::HEAD, const Vec& v = Vec(1, 2));',
        'c++',
      ),
    ).toEqual(['JKRAllocFromAram: (size: u32, m: JKRAramHeap::EAllocMode, v: & → const Vec) → * → JKRAramBlock']);
  });

  test('a template argument list stays part of the type name', () => {
    expect(declarations('TVec3<f32> v3; JSUList<JKRHeap>::Iterator it;', 'c++')).toEqual([
      'v3: TVec3<f32>',
      'it: JSUList<JKRHeap>::Iterator',
    ]);
  });

  test('a pointer to member names its class', () => {
    expect(declarations('typedef void (particleGenerator::*DrawCallBack)(Mtx&, f32&);', 'c++')).toEqual([
      'DrawCallBack: particleGenerator::* → (_: & → Mtx, _: & → f32) → void',
    ]);
  });

  test('operators, constructors and destructors, which have no type of their own', () => {
    expect(
      declarations(
        `
        bool operator==(const Vec& a, const Vec& b);
        void* A::operator new[](size_t n);
        A::A() : x(0), y("}") { }
        A::~A() { }
      `,
        'c++',
      ),
    ).toEqual([
      'operator==: (a: & → const Vec, b: & → const Vec) → bool',
      'A::operator new[]: (n: size_t) → * → void',
      'A::A: () → ',
      'A::~A: () → ',
    ]);
  });
});

describe('a declaration', () => {
  test('a typedef of a body, qualified, with a pointer beside it', () => {
    const ctx = parseDeclarations('typedef struct R2 { u32 w; } const R2C, *CR2P;', 'c');
    expect(ctx.declarations[0].specifiers.typedef).toBe(true);
    expect(read(ctx)).toEqual(['R2C: const struct R2 {…}; CR2P: * → const struct R2 {…}']);
  });

  test('a function definition keeps its body as a range, `asm { }` and mwcc `asm` functions included', () => {
    const ctx = parseDeclarations(
      'inline void f2(void) { asm { li r3, 0 } }\nasm void f3(void) { nofralloc; blr }',
      'c',
    );
    expect(read(ctx)).toEqual(['f2: (_: void) → void', 'f3: (_: void) → void']);
    expect(ctx.declarations.map((d) => spelled(ctx.tokens, d.body))).toEqual(['asm { li r3 , 0 }', 'nofralloc ; blr']);
    expect(ctx.declarations.map((d) => d.specifiers.storage)).toEqual([['inline'], ['asm']]);
  });

  test('an initializer, mwcc `: address` and `asm("sym")` are read past', () => {
    expect(
      declarations('int x = {1, 2}, y; extern volatile u16 REG : 0xCC006000; int sym asm("_sym") = 3;', 'c'),
    ).toEqual(['x: int; y: int', 'REG: volatile u16', 'sym: int']);
  });

  // C89 has no `bool` or `wchar_t`: marioparty4's MusyX headers declare `typedef unsigned long bool;`
  test('a word C++ reserves for a type is the name it declares after another type word', () => {
    expect(declarations('typedef unsigned long bool; typedef unsigned short wchar_t; bool f(bool b);', 'c')).toEqual([
      'bool: unsigned long',
      'wchar_t: unsigned short',
      'f: (b: bool) → bool',
    ]);
  });

  test('a word C++ alone reserves is an identifier in C', () => {
    expect(declarations('void f(int class, int operator, int friend); struct S { u8 typename; };', 'c')).toEqual([
      'f: (class: int, operator: int, friend: int) → void',
      'struct S {…}',
    ]);
    expect(members('struct S { u8 public : 1, mutable; };', 'c')).toEqual(['public: u8 : 1; mutable: u8']);
  });

  test('an identifier ahead of a type keyword is an unknown word', () => {
    const ctx = parseDeclarations('EWRAM_FN NAKED void f(int x); UNUSED static struct Blob64 g(void);', 'c');
    expect(read(ctx)).toEqual(['f: (x: int) → void', 'g: (_: void) → struct Blob64']);
    expect(ctx.declarations.map((d) => [d.specifiers.unknownWords, d.specifiers.spelling])).toEqual([
      [['EWRAM_FN', 'NAKED'], 'EWRAM_FN NAKED void'],
      [['UNUSED'], 'UNUSED struct Blob64'],
    ]);
  });

  test('a run of identifiers after the type is unknown words and the name', () => {
    const ctx = parseDeclarations('struct Blob64 EWRAM_FN makeblob(const void *);', 'c');
    expect(read(ctx)).toEqual(['makeblob: (_: * → const void) → struct Blob64']);
    expect(ctx.declarations[0].specifiers.unknownWords).toEqual(['EWRAM_FN']);
  });

  test('a C++ base clause and an enum base are read past, and said', () => {
    const ctx = parseDeclarations(
      'class B : public A, private C { int v; }; enum E2 : u8 { X = 1 }; struct P { int q; };',
      'c++',
    );
    expect(read(ctx)).toEqual(['class B {…}', 'enum E2 {…}', 'struct P {…}']);
    expect(ctx.declarations.map((d) => d.specifiers.type.kind === 'tag' && d.specifiers.type.base)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe('attributes, by the site they were written at', () => {
  test('ahead of a body, after union and enum, and straight after the body', () => {
    const ctx = parseDeclarations(
      `
      union __attribute__((packed)) U { u8 a; } __attribute__((aligned(4)));
      enum __attribute__((packed)) E { E0 };
      __attribute__((aligned(8))) struct A { u8 a; } const __attribute__((unused)) a;
    `,
      'c',
    );
    expect(ctx.declarations.map((d) => attributes(d.specifiers.attributes))).toEqual([
      ['before-body __attribute__((packed))', 'after-body __attribute__((aligned(4)))'],
      ['before-body __attribute__((packed))'],
      ['before-body __attribute__((aligned(8)))', 'specifier __attribute__((unused))'],
    ]);
  });

  test('among the specifiers, and on a declarator', () => {
    const ctx = parseDeclarations(
      `
      __attribute__((noreturn)) void die(void);
      typedef struct R *RP __attribute__((aligned(8)));
      void retyped(int x __attribute__((mode(DI))));
    `,
      'c',
    );
    const [die, rp, retyped] = ctx.declarations;
    expect(attributes(die.specifiers.attributes)).toEqual(['specifier __attribute__((noreturn))']);
    expect(attributes(rp.declarators[0].attributes)).toEqual(['declarator __attribute__((aligned(8)))']);
    const fn = retyped.declarators[0].derivations[0];
    expect(fn.kind === 'function' && attributes(fn.params?.[0].declarator.attributes ?? [])).toEqual([
      'declarator __attribute__((mode(DI)))',
    ]);
  });

  test("on a member, as that member's own", () => {
    const ctx = parseDeclarations('struct S { u32 a __attribute__((aligned(8))); };', 'c');
    const [a] = memberDeclarations(ctx, tagBody(ctx.declarations[0])) ?? [];
    expect(attributes(a.declarators[0].attributes)).toEqual(['declarator __attribute__((aligned(8)))']);
  });
});

describe('what the top level reads, descends into and skips', () => {
  test('descends into `extern "C"`, with or without braces, and skips `extern "C++"`', () => {
    expect(
      declarations('extern "C" {\nint c1(void);\n}\nextern "C" int c2(int);\nextern "C++" { int cpp(void); }', 'c++'),
    ).toEqual(['c1: (_: void) → int', 'c2: (_: int) → int']);
  });

  test('skips namespaces, templates, `using` and a top-level asm statement', () => {
    expect(
      declarations(
        `
        namespace JSystem { int inside(void); }
        template <typename T, int N = (3 > 2)> T max(T a, T b) { return a > b ? a : b; }
        template <> struct Box<int> { int v; };
        using namespace std;
        asm(".set x, 1");
        int outside(void);
      `,
        'c++',
      ),
    ).toEqual(['outside: (_: void) → int']);
  });

  test('a statement it cannot read is counted at its first token, and reading goes on after it', () => {
    const ctx = parseDeclarations('int bad[;\nvoid g(int, = 3);\n}\nint after;', 'c');
    expect(ctx.unread.map((k) => ctx.tokens.text(k))).toEqual(['int', '}']);
    // a parameter list it cannot read is counted apart, and its declaration is read
    expect(ctx.unreadLists.map((k) => ctx.tokens.text(k - 1))).toEqual(['g']);
    expect(read(ctx)).toEqual(['g: (?) → void', 'after: int']);
  });
});

describe('a body read for its members', () => {
  test('bit-fields, an unnamed one included, extents and function pointers', () => {
    expect(members('struct S { u32 a : 3, : 0, b; u8 pad[0x4 - 0x3]; void (*fp)(s32); };', 'c')).toEqual([
      'a: u32 : 3; _: u32 : 0; b: u32',
      'pad: [0x4 - 0x3] → u8',
      'fp: * → (_: s32) → void',
    ]);
  });

  test('a nested body is one member declaration', () => {
    expect(members('struct S { union { u8 b[4]; u32 w; } u; struct { int x; }; };', 'c')).toEqual([
      'u: union {…}',
      'struct {…}',
    ]);
  });

  test('a class body: access labels, constructors, methods with bodies, conversions, statics', () => {
    expect(
      members(
        `class B : public A {
        public: B(); virtual ~B(); int get() const { return v; } operator bool() const;
        B(int x) : v(x) {} virtual void f() = 0;
        private: int v; static const int k = 3;
      };`,
        'c++',
      ),
    ).toEqual([
      'B: () → ',
      '~B: () → ',
      'get: () → int',
      'operator bool: () → ',
      'B: (x: int) → ',
      'f: () → void',
      'v: int',
      'k: const int',
    ]);
  });

  test('is none when a member cannot be read', () => {
    expect(members('struct T { int ok; int (; };', 'c')).toBeUndefined();
  });

  test("is read when a member's own parameter list cannot be", () => {
    expect(members('struct T { void (*cb)(char (x)); int ok; };', 'c')).toEqual(['cb: * → (?) → void', 'ok: int']);
  });
});

describe('a type name', () => {
  test('is its specifiers and an abstract declarator', () => {
    const t = parseTypeName('const f32 (*)[3]');
    expect(t && declarator({ tokens: t.tokens }, t.specifiers, t.declarator)).toBe('_: * → [3] → const f32');
  });

  test('is none for a declarator with a name, or text left after the declarator', () => {
    expect(['void (*cb)(void)', 'u8 * p', 'int (*)[3] x', '(*)(void)'].map(parseTypeName)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

/** Each declarator of each declaration, spelled as a parameter or not. */
const spelledTypes = (src: string, language: Language, parameter: boolean): string[] => {
  const ctx = parseDeclarations(src, language);
  expect([...ctx.unread, ...ctx.unreadLists]).toEqual([]);
  return ctx.declarations.flatMap((d) =>
    d.declarators.map((x) => spellType(typeOf(d.specifiers), x.derivations, ctx.tokens, { parameter })),
  );
};

/** The type of each parameter of the function `src` declares last. */
const parameterTypes = (src: string, language: Language): string[] => {
  const ctx = parseDeclarations(src, language);
  const fn = ctx.declarations[ctx.declarations.length - 1].declarators[0].derivations[0];
  if (fn.kind !== 'function' || fn.params === undefined) {
    throw new Error('no parameter list');
  }
  return fn.params.map((p) =>
    spellType(typeOf(p.specifiers), p.declarator.derivations, ctx.tokens, { parameter: true }),
  );
};

describe('a type printed in the prototype vocabulary', () => {
  test('a pointer after its base, each pointer with its own qualifiers', () => {
    expect(
      parameterTypes('void f(u8 *a, const u8 * const * b, char **c, u8 ** const d, const Vec& r);', 'c++'),
    ).toEqual(['u8 *', 'const u8 * const *', 'char **', 'u8 ** const', 'const Vec &']);
  });

  test('a parameter array is a pointer to its element, and a multi-dimensional one to its rows', () => {
    expect(parameterTypes('void f(f32 v[3], f32 offset[2][3], f32 mtx[][4], f32 (*rows)[8]);', 'c')).toEqual([
      'f32 *',
      'f32 (*)[3]',
      'f32 (*)[4]',
      'f32 (*)[8]',
    ]);
  });

  test('a parameter function is a pointer to it', () => {
    expect(
      parameterTypes(
        'typedef unsigned char u8; void f(int fn(int), int (u8), void (**cb)(void), void (* const k)(void));',
        'c',
      ),
    ).toEqual(['int (*)(int)', 'int (*)(u8)', 'void (**)(void)', 'void (* const)(void)']);
  });

  test("a function pointer's own parameter list is printed as written, one space for any gap", () => {
    expect(
      parameterTypes(
        'void f(void (*h)( s32  chan,\n u8* /* c */ p ), u8 *(*mk)(const INFO *info), void (*v)(int, ...));',
        'c',
      ),
    ).toEqual(['void (*)(s32 chan, u8* p)', 'u8 *(*)(const INFO *info)', 'void (*)(int, ...)']);
  });

  test('outside a parameter, an array and a function stay what they are', () => {
    expect(
      spelledTypes(
        'int (*table[4])(void); f32 grid[2][3]; void (*getcb(void))(u8 reason); u8 pad[0x4 - 0x3];',
        'c',
        false,
      ),
    ).toEqual(['int (*[4])(void)', 'f32 [2][3]', 'void (*(void))(u8 reason)', 'u8 [0x4 - 0x3]']);
  });

  test('a pointer to member names its class, and is not spelled as a pointer', () => {
    expect(
      spelledTypes('typedef void (particleGenerator::*DrawCallBack)(Mtx&, f32&); int * C::* m;', 'c++', false),
    ).toEqual(['void (particleGenerator::*)(Mtx&, f32&)', 'int * C::*']);
  });
});

describe('a constant expression', () => {
  const value = (src: string): number | undefined => {
    const t = lex(src);
    return constantValue(t, { from: 0, to: t.count });
  };

  test('literals as C reads them, with + - * / and parentheses', () => {
    expect(['0x4 - 0x3', '(2 + 3) * 4', '010', '-1 + 2', '0x10UL', '7 / 2', '2 - 3 - 4', '--3'].map(value)).toEqual([
      1, 20, 8, 1, 16, 3, -5, 3,
    ]);
  });

  test('is none for anything else', () => {
    expect(['16 / 0', 'SIZE', '4 4', '1.5', '(2', '08', '', 'sizeof(int)'].map(value)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('reads only its range', () => {
    const t = lex('u8 pad[0x8 - 0x3];');
    expect(constantValue(t, { from: 3, to: 6 })).toBe(5);
  });
});
