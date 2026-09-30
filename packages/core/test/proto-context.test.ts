// Callee prototypes read out of a declaration context (src/proto-context.ts): what is read, what is
// skipped, and that every typedef resolves to the SAME type — a spelling here is printed beside the
// project's own headers, where a different type is a conflicting declaration.
import { describe, expect, test } from 'vitest';

import { declaredArgWidths, declaredWidth } from '../src/proto';
import { prototypesFromContext, withContextPrototypes } from '../src/proto-context';

// the shape of the CARD block in Pikmin's context: its typedefs and an `extern "C"` block
const PIKMIN_CARD = `
# 1 "include/types.h"
typedef signed long s32;
typedef unsigned long u32;
typedef int BOOL;
typedef void (*CARDCallback)(s32 channel, s32 result);
typedef struct CARDMemoryCard { u8 buf[0x8000]; } CARDMemoryCard;
#ifdef __cplusplus
extern "C"{
#endif
s32 CARDCheckAsync(s32 channel, CARDCallback);
s32 CARDGetSectorSize(s32 channel, u32* size);
BOOL CARDProbe(s32 channel);
s32 CARDMountAsync(s32 channel, CARDMemoryCard* workArea, CARDCallback detachCallback, CARDCallback attachCallback);
void CARDInit();
#ifdef __cplusplus
}
#endif
`;

describe('prototypes from a declaration context', () => {
  test('reads a C-linkage block of a C++ context, resolving each typedef to the same type', () => {
    const p = prototypesFromContext(PIKMIN_CARD, 'c++');
    expect(p.CARDProbe).toEqual({ returns: 'int', params: ['s32'] });
    expect(p.CARDGetSectorSize).toEqual({ returns: 's32', params: ['s32', 'u32 *'] });
    expect(p.CARDCheckAsync).toEqual({ returns: 's32', params: ['s32', 'void (*)(s32 channel, s32 result)'] });
    // a struct keeps its name: it sizes only as the pointee of a pointer
    expect((p.CARDMountAsync?.params as string[])[1]).toBe('CARDMemoryCard *');
    expect(declaredArgWidths(p.CARDMountAsync)).toEqual([32, 32, 32, 32]);
    // `()` is an empty list in C++
    expect(p.CARDInit).toEqual({ returnsVoid: true, params: [] });
  });

  test('an empty list is UNSTATED in C, and `(void)` is empty in both', () => {
    const src = 'int f(); int g(void);';
    expect(prototypesFromContext(src, 'c').f).toEqual({ returns: 'int' });
    expect(prototypesFromContext(src, 'c').g).toEqual({ returns: 'int', params: [] });
    expect(prototypesFromContext(src, 'c++').f).toEqual({ returns: 'int', params: [] });
  });

  test('keeps qualifiers, reads arrays and function-pointer parameters as pointers', () => {
    const p = prototypesFromContext(
      'typedef unsigned long size_t; void *memcpy(void *dst, const void *src, size_t n); int sum(int v[4], int (*cmp)(int, int));',
      'c',
    );
    expect(p.memcpy).toEqual({ returns: 'void *', params: ['void *', 'const void *', 'size_t'] });
    expect(p.sum?.params).toEqual(['int *', 'int (*)(int, int)']);
    expect(declaredArgWidths(p.sum)).toEqual([32, 32]);
  });

  test('a list holding a spelling that cannot be sized is kept, and the frontend abstains on it', () => {
    const p = prototypesFromContext(
      'typedef struct Vec { float x, y; } Vec; float len(Vec v); float sq(float x);',
      'c',
    );
    expect(p.len?.params).toEqual(['Vec']);
    expect(declaredArgWidths(p.len)).toBeUndefined();
    expect(declaredArgWidths(p.sq)).toBeUndefined();
  });

  test('skips members, namespaces, templates, operators and variadics; drops an overloaded name', () => {
    const p = prototypesFromContext(
      `class Card { public: int probe(int chan); };
       namespace zen { int helper(int); }
       template <typename T> T id(T x);
       int operator+(int a, int b);
       int printf(const char *fmt, ...);
       int ov(int); int ov(float);
       int same(int); int same(int);
       int after(int x) { return x; }
       int last(int);`,
      'c++',
    );
    expect(Object.keys(p).sort()).toEqual(['after', 'last', 'printf', 'same']);
    expect(p.printf).toEqual({ returns: 'int' });
    expect(p.after).toEqual({ returns: 'int', params: ['int'] });
  });

  test('a literal or a comment holds no brace, and a namespace ends at its own brace', () => {
    const p = prototypesFromContext(
      `struct Prop { Prop() : name("}{") {} virtual void read(int s); };
       const char *msg = "// not a comment; int fake(int);";
       #define LONG_MACRO(x) \\
         int macroFake(int x);
       namespace std { inline float fmod(float x, float m) { return x; } }
       double fmod(double x, double y);
       int after(int v);`,
      'c++',
    );
    expect(Object.keys(p).sort()).toEqual(['after', 'fmod']);
    expect(p.fmod?.params).toEqual(['double', 'double']);
  });

  test('a struct or union returned by value is kept, with its members as the header lists them', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8; typedef int s32;
       struct Blob64 { u32 w[16]; };
       struct Blob64 makeblob(const void *);
       typedef struct { u32 a, b; } Pair; Pair mkpair(s32);
       typedef struct Tagged Alias; Alias mkalias(void);
       union U4 { u32 a; u16 b; }; union U4 mku(s32);
       struct BF { u32 a : 8; u32 : 4; u32 b : 0x4; }; struct BF mkbf(void);
       typedef enum { A, B } E; E mke(void);`,
      'c',
    );
    expect(p.makeblob).toEqual({
      returns: 'struct Blob64',
      returnLayout: { kind: 'struct', members: [{ name: 'w', type: 'u32', dims: [16] }] },
      params: ['const void *'],
    });
    // a typedef of a struct body spells no keyword, so the layout key is what says it
    expect(p.mkpair).toEqual({
      returns: 'Pair',
      returnLayout: {
        kind: 'struct',
        members: [
          { name: 'a', type: 'u32' },
          { name: 'b', type: 'u32' },
        ],
      },
      params: ['s32'],
    });
    // a tag with no body in the context is known to be a struct and nothing more
    expect(p.mkalias).toEqual({ returns: 'struct Tagged', returnLayout: { kind: 'struct' }, params: [] });
    expect(p.mku?.returnLayout?.kind).toBe('union');
    expect(p.mkbf?.returnLayout?.members).toEqual([
      { name: 'a', type: 'u32', bits: 8 },
      { name: '', type: 'u32', bits: 4 },
      { name: 'b', type: 'u32', bits: 4 },
    ]);
    // an enum is not an aggregate: its return stays unstated
    expect(p.mke).toEqual({ params: [] });
  });

  test('a member reads through typedefs, pointers, nested bodies and extents, or the layout abstains', () => {
    const p = prototypesFromContext(
      `typedef unsigned char u8; typedef unsigned short u16; typedef int s32;
       struct S4 { u8 a, b, c, d; };
       typedef struct { u16 x; struct S4 in; u8 *p; void (*cb)(int); s32 m[2][3]; struct Opaque *o; } Big;
       Big mkbig(void);
       struct Nest { struct { u8 a; } inner; union { s32 w; u8 b[4]; } u; }; struct Nest mknest(void);
       struct Fl { float f; }; struct Fl mkfl(void);
       struct Flex { s32 n; u8 tail[]; }; struct Flex mkflex(void);
       struct Pad { u16 unk0; u8 unk2; u8 pad3[0x4 - 0x3]; u8 m[(2 + 1) * 2]; }; struct Pad mkpad(void);
       struct Sym { u8 x[N]; }; struct Sym mksym(void);
       struct Oct { u8 a[010]; u8 b[0]; }; struct Oct mkoct(void); struct Nine { u8 a[09]; }; struct Nine mknine(void);`,
      'c',
    );
    expect(p.mkbig?.returnLayout?.members).toEqual([
      { name: 'x', type: 'u16' },
      {
        name: 'in',
        type: {
          kind: 'struct',
          members: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u8' })),
        },
      },
      { name: 'p', type: 'u8 *' },
      { name: 'cb', type: 'void *' },
      { name: 'm', type: 's32', dims: [2, 3] },
      { name: 'o', type: 'struct Opaque *' },
    ]);
    expect(p.mknest?.returnLayout?.members).toEqual([
      { name: 'inner', type: { kind: 'struct', members: [{ name: 'a', type: 'u8' }] } },
      {
        name: 'u',
        type: {
          kind: 'union',
          members: [
            { name: 'w', type: 's32' },
            { name: 'b', type: 'u8', dims: [4] },
          ],
        },
      },
    ]);
    // a float member, or an extent the header does not state, leaves the kind and nothing else
    expect(p.mkfl?.returnLayout).toEqual({ kind: 'struct' });
    expect(p.mkflex?.returnLayout).toEqual({ kind: 'struct' });
    expect(p.mksym?.returnLayout).toEqual({ kind: 'struct' });
    // …where an extent written as a constant expression is its value (kleod's `struct Unk_08014184`)
    expect(p.mkpad?.returnLayout?.members).toEqual([
      { name: 'unk0', type: 'u16' },
      { name: 'unk2', type: 'u8' },
      { name: 'pad3', type: 'u8', dims: [1] },
      { name: 'm', type: 'u8', dims: [6] },
    ]);
    // a leading zero is octal, and `09` is no literal at all
    expect(p.mkoct?.returnLayout).toEqual({ kind: 'struct' });
    expect(
      prototypesFromContext('struct O { u8 a[010]; }; struct O mko(void);', 'c').mko?.returnLayout?.members,
    ).toEqual([{ name: 'a', type: 'u8', dims: [8] }]);
    expect(p.mknine?.returnLayout).toEqual({ kind: 'struct' });
  });

  test('a struct return spelled in a way this cannot read still returns a struct', () => {
    const c = prototypesFromContext(
      'struct Blob64 { u32 w[16]; }; struct Blob64 EWRAM_FN makeblob(const void *); union U __attr mku(s32);',
      'c',
    );
    expect(c.makeblob).toEqual({ returnLayout: { kind: 'struct' }, params: ['const void *'] });
    expect(c.mku).toEqual({ returnLayout: { kind: 'union' }, params: ['s32'] });
    // C++ names a struct by its tag, and a linkage specification declares nothing about the type
    const vec = { kind: 'struct', members: ['x', 'y', 'z'].map((name) => ({ name, type: 'u32' })) };
    for (const decl of ['extern "C" Vec getv(s32 i);', 'extern "C" { Vec getv(s32 i); }']) {
      const cpp = prototypesFromContext(`struct Vec { u32 x, y, z; }; ${decl}`, 'c++');
      expect(cpp.getv).toEqual({ returns: 'Vec', returnLayout: vec, params: ['s32'] });
    }
    expect(prototypesFromContext('struct Fwd; Fwd getf(s32 i);', 'c++').getf).toEqual({
      returns: 'Fwd',
      returnLayout: { kind: 'struct' },
      params: ['s32'],
    });
  });

  test('C++ default arguments and comments do not reach a spelling', () => {
    const p = prototypesFromContext('/* a */ int f(int a = 3, /* b */ int b = 4); // c', 'c++');
    expect(p.f).toEqual({ returns: 'int', params: ['int', 'int'] });
  });
});

// The struct return is what says argument 0 may be a hidden pointer; a source that states the
// parameters better must not take it away with the rest of the entry.
describe('a context struct return under a stated or mapped signature', () => {
  const ctx = prototypesFromContext(
    'enum E { E0, E1 }; struct Blob64 { u32 w[16]; }; struct Blob64 makeblob(const void *); struct Blob64 mke(enum E e);',
    'c',
  );
  const blob = { returns: 'struct Blob64', returnLayout: ctx.makeblob!.returnLayout };

  test('a stated entry that states only the arity keeps it', () => {
    const p = withContextPrototypes({ makeblob: { params: ['const void *'] } }, ctx, 'f', undefined);
    expect(p.makeblob).toEqual({ params: ['const void *'], ...blob });
    // …and one that states a return of its own is taken whole
    const own = withContextPrototypes({ makeblob: { params: 1, returns: 's32' } }, ctx, 'f', undefined);
    expect(own.makeblob).toEqual({ params: 1, returns: 's32' });
    const none = withContextPrototypes({ makeblob: { params: 1, returnsVoid: true } }, ctx, 'f', undefined);
    expect(none.makeblob).toEqual({ params: 1, returnsVoid: true });
  });

  // `returnsVoid: false` states nothing a reader acts on, and it is how a manifest spells a callee
  // it knows only the parameters of
  test('a stated entry that says only that the return is not void keeps it', () => {
    const p = withContextPrototypes(
      { makeblob: { params: ['const void *'], returnsVoid: false } },
      ctx,
      'f',
      undefined,
    );
    expect(p.makeblob).toEqual({ params: ['const void *'], returnsVoid: false, ...blob });
  });

  test('an entry the symbol map sizes better keeps it', () => {
    const symbols = new Map([
      [
        0x1000,
        [
          {
            name: 'mke',
            kind: 'code' as const,
            signature: { returns: { size: 64, signed: null }, params: [{ size: 4, signed: null }] },
          },
        ],
      ],
    ]);
    expect(withContextPrototypes(undefined, ctx, 'f', symbols).mke).toEqual({ params: ['s32'], ...blob });
  });
});

describe('declaredWidth', () => {
  test('a function pointer is register-wide', () => {
    expect(declaredWidth('void (*)(s32 channel, s32 result)')).toBe(32);
    expect(declaredWidth('int (*)(void)')).toBe(32);
  });
});
