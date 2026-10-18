// Callee prototypes read out of a declaration context (src/proto-context.ts): what is read, what is
// skipped, and that every typedef resolves to the SAME type — a spelling here is printed beside the
// project's own headers, where a different type is a conflicting declaration.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { declaredCallArgs, declaredWidth } from '../src/proto';
import {
  ownContextEntry,
  prototypesFromContext,
  splitOwnContext,
  withContextPrototypes,
  withOwnContextMark,
} from '../src/proto-context';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC } from '../src/target';

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
    expect(declaredCallArgs(p.CARDMountAsync, PPC_MWCC)?.widths).toEqual([32, 32, 32, 32]);
    // `()` is an empty list in C++
    expect(p.CARDInit).toEqual({ returnsVoid: true, params: [] });
  });

  test('an empty list is UNSTATED in C, and `(void)` is empty in both', () => {
    const src = 'int f(); int g(void);';
    expect(prototypesFromContext(src, 'c').f).toEqual({ returns: 'int' });
    expect(prototypesFromContext(src, 'c').g).toEqual({ returns: 'int', params: [] });
    expect(prototypesFromContext(src, 'c++').f).toEqual({ returns: 'int', params: [] });
  });

  // `int k(V)` read as a list of one parameter spelled `void` would pass the first argument
  // register, and `k()` would lift as `k(a0)` on every toolchain
  test('a list of one `void` through a typedef is empty, and a pointer to it is a parameter', () => {
    const p = prototypesFromContext('typedef void V; typedef V *VP; int k(V); int kp(VP);', 'c');
    expect(p.k).toEqual({ returns: 'int', params: [] });
    expect(p.kp?.params).toHaveLength(1);
  });

  test('keeps qualifiers, reads arrays and function-pointer parameters as pointers', () => {
    const p = prototypesFromContext(
      'typedef unsigned long size_t; void *memcpy(void *dst, const void *src, size_t n); int sum(int v[4], int (*cmp)(int, int));',
      'c',
    );
    expect(p.memcpy).toEqual({ returns: 'void *', params: ['void *', 'const void *', 'size_t'] });
    expect(p.sum?.params).toEqual(['int *', 'int (*)(int, int)']);
    expect(declaredCallArgs(p.sum, PPC_MWCC)?.widths).toEqual([32, 32]);
  });

  test('a multi-dimensional array parameter is a pointer to its inner array', () => {
    const p = prototypesFromContext(
      `typedef float f32; typedef signed char s8; typedef unsigned char u8; typedef unsigned int u32;
       void GXSetIndTexMtx(u32 id, f32 offset[2][3], s8 scale_exp);
       void GXSetCopyFilter(u8 aa, const u8 sample_pattern[12][2], u8 vf, const u8 *vfilter);`,
      'c',
    );
    expect(p.GXSetIndTexMtx?.params).toEqual(['u32', 'f32 (*)[3]', 's8']);
    expect(p.GXSetCopyFilter?.params).toEqual(['u8', 'const u8 (*)[2]', 'u8', 'const u8 *']);
    expect(declaredCallArgs(p.GXSetIndTexMtx, PPC_MWCC)?.widths).toEqual([32, 32, 8]);
  });

  test('an array parameter of unstated outer extent is a pointer to its inner array', () => {
    const p = prototypesFromContext(
      'typedef float f32; typedef unsigned int u32; void GXLoadTexMtxImm(f32 mtx[][4], u32 id, u32 type);',
      'c',
    );
    expect(p.GXLoadTexMtxImm?.params).toEqual(['f32 (*)[4]', 'u32', 'u32']);
  });

  test('a pointer to an array, a pointer to a function pointer and a function-typed parameter are read', () => {
    const p = prototypesFromContext(
      `typedef float f32; typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32;
       typedef u8 bool8;
       u32 LinkMain1(u8 *shouldAdvanceLinkState, u16 *sendCmd, u16 (*recvCmds)[8]);
       void func_8008A430_8B030(f32(*)[], f32);
       u16 SetFlashTimerIntr(u8 timerNum, void (**intrFunc)(void));
       bool8 CopyablePlayerMovement_None(struct ObjectEvent *objectEvent, u8 playerDirection, bool8 tileCallback(u8));`,
      'c',
    );
    expect(p.LinkMain1?.params).toEqual(['u8 *', 'u16 *', 'u16 (*)[8]']);
    expect(p.func_8008A430_8B030?.params).toEqual(['f32 (*)[]', 'float']);
    expect(p.SetFlashTimerIntr?.params).toEqual(['u8', 'void (* *)(void)']);
    expect(p.CopyablePlayerMovement_None?.params).toEqual(['struct ObjectEvent *', 'u8', 'bool8 (*)(u8)']);
    expect(declaredCallArgs(p.SetFlashTimerIntr, ARMV4T_AGBCC)?.widths).toEqual([8, 32]);
  });

  test('a parameter with no name is its whole type, a typedef name included', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32; typedef float f32; typedef f32 Mtx33[3][3]; typedef struct Vec Vec;
       extern void GXLoadNrmMtxImm3x3(const Mtx33, u32 id);
       void fn_1_91A4(Vec *, Vec *, float[5]);`,
      'c',
    );
    expect(p.GXLoadNrmMtxImm3x3?.params).toEqual(['const Mtx33', 'u32']);
    expect(p.fn_1_91A4?.params).toEqual(['struct Vec *', 'struct Vec *', 'float *']);
  });

  test("a typedef name resolves to its own type, which the name's qualifiers qualify nearest the name", () => {
    const p = prototypesFromContext(
      `typedef void (*Cb)(int); typedef unsigned char u8; typedef const u8 CU8;
       void f(const Cb c, Cb const d, const Cb *e, const CU8 k); Cb *g(int y);`,
      'c',
    );
    expect(p.f?.params).toEqual(['void (* const)(int)', 'void (* const)(int)', 'void (* const *)(int)', 'const u8']);
    expect(p.g?.returns).toBe('void (* *)(int)');
    // a qualifier inside a template argument is that argument's
    expect(prototypesFromContext('void h(TVec3<const u8 *> a);', 'c++').h?.params).toEqual(['TVec3<const u8 *>']);
  });

  // a reference is returned as an address, never through a hidden pointer
  test('a function returning a reference to a struct states no struct return', () => {
    const p = prototypesFromContext('struct S { int a; }; struct S &f(int a); typedef struct S T; T &g(int a);', 'c++');
    expect(p.f).toEqual({ params: ['int'] });
    expect(p.g).toEqual({ params: ['int'] });
  });

  test('a function-pointer parameter keeps the qualifiers of its own parameters where they are', () => {
    const p = prototypesFromContext(
      `typedef unsigned char u8; typedef unsigned int u32;
       void sndVirtualSampleSetCallback(u32 (*callback)(u8 reason, const SND_VIRTUALSAMPLE_INFO* info));`,
      'c',
    );
    expect(p.sndVirtualSampleSetCallback?.params).toEqual(['u32 (*)(u8 reason, const SND_VIRTUALSAMPLE_INFO* info)']);
  });

  // compiled, agbcc passes `void f(long long (x), int y)`'s x in r0:r1 and y in r2, and reads
  // `int (x)[3]`'s x as an `int *`
  test('a name in parentheses in a parameter is a type where the context declares one', () => {
    const c = prototypesFromContext(
      `typedef int T; typedef int I;
       void wide(long long (x), int y); int narrow(char (c)); void named(I (x));
       void arr(int (x)[3], int y); void fun(int (x)(int), int y);
       void fn(char (T)); void fns(char (T), int (int));`,
      'c',
    );
    expect(c.wide).toEqual({ returnsVoid: true });
    expect(c.narrow).toEqual({ returns: 'int' });
    expect(c.named).toEqual({ returnsVoid: true });
    // a type followed by a list or an extent would be a function returning a function or an array
    expect(c.arr?.params).toEqual(['int *', 'int']);
    expect(c.fun?.params).toEqual(['int (*)(int)', 'int']);
    expect(c.fn?.params).toEqual(['char (*)(T)']);
    expect(c.fns?.params).toEqual(['char (*)(T)', 'int (*)(int)']);
    // a C++ tag is a type name
    const cpp = prototypesFromContext('struct V { int a; }; void tagged(int (V)); void plain(int (v));', 'c++');
    expect(cpp.tagged?.params).toEqual(['int (*)(V)']);
    expect(cpp.plain).toEqual({ returnsVoid: true });
  });

  test('a declarator in parentheses, and an attribute before a second declarator, are read as C reads them', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32; typedef int (T); void f(T x); int (g)(int x);
       u32 h(u32 x) __attribute__((long_call)), k(u32 y);`,
      'c',
    );
    expect(p.f).toEqual({ returnsVoid: true, params: ['int'] });
    expect(declaredCallArgs(p.f, ARMV4T_AGBCC)?.widths).toEqual([32]);
    expect(p.g).toEqual({ returns: 'int', params: ['int'] });
    expect(p.h).toEqual({ returns: 'u32', params: ['u32'] });
    expect(p.k).toEqual({ returns: 'u32', params: ['u32'] });
  });

  test('a parameter of a qualified C++ type name is read', () => {
    const p = prototypesFromContext(
      `typedef unsigned long u32; struct JKRAramBlock; class JKRAramHeap { public: enum EAllocMode { HEAD, TAIL }; };
       inline JKRAramBlock* JKRAllocFromAram(u32 size, JKRAramHeap::EAllocMode allocMode = JKRAramHeap::HEAD) {
         return 0;
       }`,
      'c++',
    );
    expect(p.JKRAllocFromAram).toEqual({ returns: 'JKRAramBlock *', params: ['u32', 'JKRAramHeap::EAllocMode'] });
  });

  test("a type name is spelled as written, in a parameter and in a function pointer's own list alike", () => {
    const p = prototypesFromContext('void f(A :: B a, void (*cb)(A :: B), TVec3< u8 > v);', 'c++');
    expect(p.f?.params).toEqual(['A :: B', 'void (*)(A :: B)', 'TVec3< u8 >']);
  });

  test('a list holding a spelling that cannot be sized is kept, and the frontend abstains on it', () => {
    const p = prototypesFromContext(
      'typedef struct Vec { float x, y; } Vec; float len(Vec v); float sq(float x);',
      'c',
    );
    expect(p.len?.params).toEqual(['Vec']);
    expect(declaredCallArgs(p.len, PPC_MWCC)?.widths).toBeUndefined();
    expect(declaredCallArgs(p.sq, PPC_MWCC)?.widths).toBeUndefined();
  });

  test('a floating return is kept as its keyword, through a typedef too', () => {
    const p = prototypesFromContext('typedef float f32; float g(int); f32 k(void); double d(void);', 'c');
    expect(p.g).toEqual({ returns: 'float', params: ['int'] });
    expect(p.k).toEqual({ returns: 'float', params: [] });
    expect(p.d).toEqual({ returns: 'double', params: [] });
  });

  test('skips members, namespaces, templates and operators, keeps only the fixed parameters of a variadic; drops an overloaded name', () => {
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
    expect(p.printf).toEqual({ returns: 'int', variadicParams: ['const char *'] });
    expect(p.after).toEqual({ returns: 'int', params: ['int'] });
  });

  // Compatible redeclarations are one function: read as a conflict, the name would be dropped, and
  // with it the by-value and variadic refusals its entry carries — the call would take the arity
  // guess (`takeW(*(s32 *)&gW)`, `takeL(*p0, p0[1])`), and a void callee's v0 would read as its return.
  test('two declarations of one function that differ only in top-level parameter qualifiers keep the entry', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32; struct W { u32 x; }; typedef const int CI;
       void takeW(const struct W w); void takeW(struct W w);
       void takeL(const long long x, ...); void takeL(long long x, ...);
       int logv(const int k, ...); int logv(int k, ...);
       int g(int *const p); int g(int *p);
       int f(CI x); int f(int x);
       int h(const char *s); int h(char *s);
       int n(int x); int n(long long x);`,
      'c',
    );
    expect(p.takeW).toMatchObject({ returnsVoid: true, params: ['struct W'], byValueParams: [0] });
    expect(p.takeL).toEqual({ returnsVoid: true, variadicParams: ['long long'] });
    expect(p.logv).toEqual({ returns: 'int', variadicParams: ['int'] });
    expect(p.g).toEqual({ returns: 'int', params: ['int *'] });
    expect(p.f).toEqual({ returns: 'int', params: ['int'] });
    // a qualifier on what a pointer points at is the parameter's type, and a different type conflicts
    expect(p.h).toBeUndefined();
    expect(p.n).toBeUndefined();
  });

  test('in C, a declaration whose parameters are not read is one with the declaration that states them', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32; struct W { u32 x; };
       void takeW(); void takeW(struct W w);
       int logv(const char *fmt, ...); int logv(const char *restrict fmt, ...);
       int r(); long long r(int);`,
      'c',
    );
    expect(p.takeW).toMatchObject({ returnsVoid: true, params: ['struct W'], byValueParams: [0] });
    expect(p.logv).toEqual({ returns: 'int', variadicParams: ['const char *'] });
    // the returns disagree: a conflict
    expect(p.r).toBeUndefined();
    // in C++, `()` states no parameters, and two lists that differ are overloads
    const cpp = prototypesFromContext('struct W { int x; }; void takeW(); void takeW(struct W w);', 'c++');
    expect(cpp.takeW).toBeUndefined();
  });

  // `()` before a list is compatible with it only where the list is not variadic and its parameters
  // keep their types under the default argument promotions (C99 6.7.5.3p15); after one, it is a
  // conflict whatever the types (byvalue-args.test.ts, mwcc). agbcc, gcc2.7.2kmc and gcc2.7.2 compile
  // `void f(char); void f();` without a word and the call unprototyped, so reading it as `f(char)`
  // would trim `f(1, 2)` to `f(1)`. An enum may be narrow (`-fshort-enums`), and a name never
  // resolved may be `u8`: neither composes.
  test('in C, a `()` declaration is one with a list only where no parameter is promoted', () => {
    const p = prototypesFromContext(
      `typedef unsigned char u8; typedef int s32; typedef float F; enum E { A, B };
       typedef struct { int x; } S; struct W { int x; };
       void c(char); void c();
       void cr(); void cr(char);
       void sh(); void sh(short, char);
       void u(); void u(u8);
       void b(); void b(_Bool);
       void fl(); void fl(F);
       void e(); void e(enum E);
       void un(); void un(Unknown);
       void v(); void v(int, ...);
       void ok(); void ok(s32, double, char *, struct W, S, int[4]);
       void ov(); void ov(void);
       int rs(const char *restrict s, ...); int rs(const char *s, int n);
       int ra(const char *restrict s, int n); int ra(const char *s);
       int rk(const char *restrict s, int n); int rk(const char *s, int n);`,
      'c',
    );
    for (const name of ['c', 'cr', 'sh', 'u', 'b', 'fl', 'e', 'un', 'v', 'rs', 'ra']) {
      expect(p[name], name).toBeUndefined();
    }
    expect(p.ok).toMatchObject({ returnsVoid: true, byValueParams: [3, 4] });
    expect(p.ok?.params).toHaveLength(6);
    expect(p.ov).toEqual({ returnsVoid: true, params: [] });
    expect(p.rk).toEqual({ returns: 'int', params: ['const char *', 'int'] });
  });

  test('a parameter nothing sizes is listed where it still travels in one register', () => {
    // an enum, and an array or a function behind a typedef name, which the parameter adjusts to a
    // pointer; a struct or union is passed by value, and a name never seen states nothing
    const p = prototypesFromContext(
      `typedef float f32; typedef enum { GX_TF_I4 } GXTexFmt; typedef f32 Mtx[3][4];
       typedef struct __va_list_struct { char a; } __va_list[1]; typedef void Fn(int);
       typedef struct { unsigned char r, g, b, a; } GXColor; typedef struct B { int x; } B_t;
       void f(GXTexFmt, Mtx, __va_list, Fn, enum E, GXColor, B_t, struct B, Unknown_t, int);`,
      'c',
    );
    expect(p.f?.params).toEqual([
      'GXTexFmt',
      'Mtx',
      '__va_list',
      'Fn',
      'enum E',
      'GXColor',
      'B_t',
      'struct B',
      'Unknown_t',
      'int',
    ]);
    expect(p.f?.wordParams).toEqual([0, 1, 2, 3, 4]);
    // …and a struct or union passed by value is stated as the positive fact it is, so a name never
    // seen (`Unknown_t`) is in neither list: unsized, not a struct by inference
    expect(p.f?.byValueParams).toEqual([5, 6, 7]);
    // every reader takes the same answer: the call lowering sizes the listed words too
    const g = prototypesFromContext('typedef enum { A, B } Fmt; typedef float Mtx[3][4]; int g(Fmt, Mtx, int);', 'c');
    expect(declaredCallArgs(g.g, PPC_MWCC)?.widths).toEqual([32, 32, 32]);
  });

  test('an enum holding a value an int cannot is no word: it may take two', () => {
    const p = prototypesFromContext('enum Big { B0 = 0x100000000LL }; void f(enum Big, int);', 'c');
    expect(p.f?.wordParams).toBeUndefined();
    expect(p.f?.byValueParams).toBeUndefined();
    expect(declaredCallArgs(p.f, PPC_MWCC)).toBeUndefined();
  });

  test('in C++ an enum tag names its type bare, and that name is one word as the struct name is a copy', () => {
    const src = 'enum Fmt { FA, FB }; struct V { int x, y; }; extern "C" void hk(Fmt e, V v, int x);';
    const p = prototypesFromContext(src, 'c++');
    expect(p.hk?.params).toEqual(['Fmt', 'V', 'int']);
    expect(p.hk?.wordParams).toEqual([0]);
    expect(p.hk?.byValueParams).toEqual([1]);
    // an enum C++ cannot fit in an int stays unsized under its bare name too
    const big = prototypesFromContext('enum Big { B0 = 0x100000000LL }; extern "C" void f(Big, int);', 'c++');
    expect(big.f?.wordParams).toBeUndefined();
    expect(declaredCallArgs(big.f, PPC_MWCC)).toBeUndefined();
    // in C the bare tag names nothing: only `enum Fmt` or a typedef does
    expect(
      prototypesFromContext('enum Fmt { FA }; typedef int Fmt2; void g(enum Fmt, Fmt2);', 'c').g?.wordParams,
    ).toEqual([0]);
  });

  test('a word C++ alone reserves names a parameter or a member in C', () => {
    const src = `typedef unsigned char u8; typedef unsigned short u16;
       void named(int class, int operator, int friend, int y);
       struct S { u8 class; u8 typename; u8 mutable; u16 x; }; struct S getS(void);`;
    const c = prototypesFromContext(src, 'c');
    expect(c.named?.params).toEqual(['int', 'int', 'int', 'int']);
    expect(c.getS?.returnLayout).toEqual({
      kind: 'struct',
      members: [
        { name: 'class', type: 'u8' },
        { name: 'typename', type: 'u8' },
        { name: 'mutable', type: 'u8' },
        { name: 'x', type: 'u16' },
      ],
    });
    const cpp = prototypesFromContext(src, 'c++');
    expect(cpp.named?.params).toBeUndefined();
    expect(cpp.getS?.returnLayout).toEqual({ kind: 'struct' });
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
       typedef float f32; typedef enum { K0, K1 } Kind; enum Col { RED };
       struct En { f32 x; Kind k; enum Col c; Kind *kp; }; struct En mken(void);
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
    // a float member is its keyword; an extent the header does not state leaves the kind and nothing
    // else
    expect(p.mkfl?.returnLayout?.members).toEqual([{ name: 'f', type: 'float' }]);
    // an enum is spelled `enum` and its name, whether the header tags it or names it by typedef
    expect(p.mken?.returnLayout?.members).toEqual([
      { name: 'x', type: 'float' },
      { name: 'k', type: 'enum Kind' },
      { name: 'c', type: 'enum Col' },
      { name: 'kp', type: 'enum Kind *' },
    ]);
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

  test('a typedef declares every name in its list, and a pointer name is a pointer, not the struct', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32; typedef int s32;
       typedef struct R { u32 a; u32 b; } R, *RP; RP getr(s32); R byval(s32); void taker(RP, s32);
       typedef struct { u32 w[16]; } Blob, *BlobPtr; Blob mkblob(s32); BlobPtr blobp(s32);
       typedef struct { u32 v; u32 w; } *NodeP; NodeP node(s32);
       struct W { NodeP p; RP q; }; struct W getw(s32);
       typedef u32 Word, *WordP; WordP wordp(Word);`,
      'c',
    );
    expect(p.getr).toEqual({ returns: 'struct R *', params: ['s32'] });
    expect(p.byval?.returnLayout?.members).toHaveLength(2);
    expect(p.taker?.params).toEqual(['struct R *', 's32']);
    expect(p.mkblob?.returnLayout?.members).toEqual([{ name: 'w', type: 'u32', dims: [16] }]);
    expect(p.blobp).toEqual({ returns: 'Blob *', params: ['s32'] });
    // a pointer to a body with no name to spell it by is the typedef name, which sizes to nothing
    expect(p.node).toEqual({ params: ['s32'] });
    // …and a member of it is a word all the same
    expect(p.getw?.returnLayout?.members).toEqual([
      { name: 'p', type: 'void *' },
      { name: 'q', type: 'struct R *' },
    ]);
    expect(p.wordp).toEqual({ returns: 'u32 *', params: ['u32'] });
  });

  test('a qualified typedef of a body names the body, the qualifier before or after it', () => {
    const w4 = [{ name: 'w', type: 'u32', dims: [4] }];
    const p = prototypesFromContext(
      `typedef unsigned int u32; typedef int s32;
       typedef struct R { u32 w[4]; } const CR; CR mk(s32);
       typedef struct { u32 w[4]; } volatile VR, *VRP; VR mkv(s32); VRP mkvp(s32);
       typedef const struct Q { u32 w[4]; } QR; QR mkq(s32); struct Q mkq2(s32);
       typedef struct R2 { u32 w; } const R2C, *CR2P; CR2P mkp(s32);`,
      'c',
    );
    expect(p.mk).toEqual({ returns: 'CR', returnLayout: { kind: 'struct', members: w4 }, params: ['s32'] });
    expect(p.mkv?.returnLayout?.members).toEqual(w4);
    expect(p.mkvp).toEqual({ returns: 'VR *', params: ['s32'] });
    expect(p.mkq?.returnLayout?.members).toEqual(w4);
    expect(p.mkq2?.returnLayout?.members).toEqual(w4);
    // compiled, `p->w = 1` through a `CR2P p` is an assignment of a read-only member
    expect(p.mkp).toEqual({ returns: 'const struct R2 *', params: ['s32'] });
  });

  // agbcc honours `packed` and `aligned` (c-common.c:446; compiled, a packed two-member enum array is
  // 4 bytes, not 8, and `struct {u16 x;} __attribute__((aligned(8)))` is 8 and comes back in memory)
  test('an attribute on a body, a member or an enum leaves the layout unread', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32; typedef unsigned short u16; typedef int s32;
       enum __attribute__((packed)) K { KA, KB }; struct P { enum K k[2]; }; struct P mkp(s32 *);
       enum K2 { K2A } __attribute__((packed)); typedef enum K2 K2T; struct P2 { K2T k; }; struct P2 mkp2(s32);
       struct A { u16 x; } __attribute__((aligned(8))); struct A mka(s32);
       struct M { u32 a; u32 b __attribute__((aligned(8))); }; struct M mkm(s32);
       enum E { E0 }; struct PE { enum E e; }; struct PE mkpe(s32);`,
      'c',
    );
    for (const name of ['mkp', 'mkp2', 'mka', 'mkm']) {
      expect(p[name]?.returnLayout, name).toEqual({ kind: 'struct' });
    }
    expect(p.mkpe?.returnLayout?.members).toEqual([{ name: 'e', type: 'enum E' }]);
  });

  // agbcc reads `__attribute` as `__attribute__` (c-parse.gperf:22-23); compiled, `mkw` below
  // returns in r0, since an attribute on a variable reaches only it
  // compiled, mwcc 4.3 lays `struct { char c; AI a; }` out in 16 bytes after
  // `typedef __declspec(align(8)) int AI;`
  test('a __declspec is an attribute: a typedef that carries one leaves every layout unread', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32; typedef __declspec(align(8)) int AI; struct S { u32 a; }; struct S g(void);
       __declspec(section ".init") void init(int a); __declspec(weak) int w(int a);`,
      'c',
    );
    expect(p.g?.returnLayout).toEqual({ kind: 'struct' });
    expect(p.init).toEqual({ returnsVoid: true, params: ['int'] });
    expect(p.w).toEqual({ returns: 'int', params: ['int'] });
  });

  test('an attribute reaches a body from its specifier, in either spelling', () => {
    const p = prototypesFromContext(
      `typedef unsigned short u16; typedef int s32;
       struct D { u16 x; } __attribute ((aligned(8))); struct D mkd(s32);
       enum __attribute ((packed)) K { KA, KB }; struct PK { enum K k[2]; }; struct PK mkpk(s32);
       struct W { s32 v; } gW __attribute__((section(".ewram"))); struct W mkw(s32);
       void nr(s32 a, s32 b) __attribute ((noreturn));`,
      'c',
    );
    expect(p.mkd?.returnLayout).toEqual({ kind: 'struct' });
    expect(p.mkpk?.returnLayout).toEqual({ kind: 'struct' });
    expect(p.mkw?.returnLayout?.members).toEqual([{ name: 'v', type: 's32' }]);
    expect(p.nr?.params).toEqual(['s32', 's32']);
  });

  // a typedef's attribute is applied to the type it names after layout (c-common.c:392-399,
  // 444-446, 623-624); compiled, each `struct O` below goes from 4 bytes to 8 and back through memory,
  // save the packed enum's, which goes from 8 to 4 and into r0
  test.each([
    'typedef struct R A __attribute__((aligned(8))); struct O { struct R r; };',
    'typedef struct R *RP __attribute__((aligned(8))); struct O { struct R *p; };',
    'typedef unsigned int AU __attribute__((aligned(8))); struct O { unsigned int v; };',
    'typedef __attribute__((aligned(8))) struct R A; struct O { struct R r; };',
    '__attribute__((aligned(8))) typedef struct R A; struct O { struct R r; };',
    'typedef struct Q { u16 y; } *QP __attribute__((aligned(8))); struct O { struct Q *q; };',
    'typedef struct R A __attribute__((__aligned__(8))); struct O { struct R r; };',
    'typedef enum E EA __attribute__((packed)); enum E { E0, E1 }; struct O { enum E k[2]; };',
  ])('a typedef attribute on a type it has no body for leaves every layout unread: %s', (decl) => {
    const p = prototypesFromContext(
      `typedef unsigned short u16; typedef int s32; struct R { u16 x; }; ${decl} struct O mko(s32);`,
      'c',
    );
    expect(p.mko?.returnLayout).toEqual({ kind: 'struct' });
  });

  // an attribute's own arguments may nest parentheses, spaced or not (c-parse.in:1205-1207)
  test('a declaration keeps its signature whatever parentheses its attribute nests', () => {
    const p = prototypesFromContext(
      `struct Big { int a, b, c; };
       void h(void *p) __attribute__((nonnull(1)));
       void h2(void *p) __attribute__((nonnull(1) ));
       __attribute__((section(".text"))) struct Big mkbig(int);
       __attribute__ ( (section (".text") ) ) struct Big mkbig2(int);`,
      'c',
    );
    expect(p.h?.params).toEqual(['void *']);
    expect(p.h2?.params).toEqual(['void *']);
    expect(p.mkbig?.params).toEqual(['int']);
    expect(p.mkbig2?.params).toEqual(['int']);
  });

  // compiled, `f`'s `x` takes r0:r1 and `y` r2, as `long long x` would
  test('a declaration whose attribute retypes a parameter with mode keeps its return and no params', () => {
    const p = prototypesFromContext(
      `struct Big { int a, b, c; };
       void f(int x __attribute__((mode(DI))), int y); void g(int x __attribute__ ((__mode__ (__QI__))));
       struct Big mk(int x); struct Big mk(int x __attribute__((mode(SI)))); struct Big mk(int x);
       int mode(int);`,
      'c',
    );
    expect(p.f).toEqual({ returnsVoid: true });
    expect(p.g).toEqual({ returnsVoid: true });
    expect(p.mk?.returns).toBe('struct Big');
    expect(p.mk?.params).toBeUndefined();
    expect(p.mode).toEqual({ returns: 'int', params: ['int'] });
  });

  test("a mode on a function pointer parameter's own parameter retypes nothing the function takes", () => {
    const p = prototypesFromContext(
      `typedef void (*Wide)(int x __attribute__((mode(DI))));
       void viaTypedef(Wide w, int y); void written(void (*w)(int x __attribute__((mode(DI)))), int y);`,
      'c',
    );
    expect(declaredCallArgs(p.viaTypedef, ARMV4T_AGBCC)?.widths).toEqual([32, 32]);
    expect(declaredCallArgs(p.written, ARMV4T_AGBCC)?.widths).toEqual([32, 32]);
  });

  // `mode` hands the attributes after it a shared scalar type (c-common.c:563, 996-1000); compiled,
  // `struct O { int a; }` is 8 bytes and comes back through memory
  test.each(['__attribute__((mode(SI), aligned(8)))', '__attribute__ ( ( __mode__ ( __SI__ ) , aligned ( 8 ) ) )'])(
    'an own-body typedef whose attributes start with mode leaves every layout unread: %s',
    (attr) => {
      const p = prototypesFromContext(
        `typedef struct R { int x; } A ${attr}; struct O { int a; }; struct O mko(int);`,
        'c',
      );
      expect(p.mko?.returnLayout).toEqual({ kind: 'struct' });
    },
  );

  // compiled, `struct G2 { G g; }` is 8 bytes and `struct S { s32 v; }` still 4 and in r0
  // compiled, agbcc refuses `aligned` on a parameter and ignores `packed` there, and lays
  // `struct { char c; Cb cb; }` out in 8 bytes
  test("an attribute on a function pointer's own parameter leaves its typedef, its member and layouts read", () => {
    const p = prototypesFromContext(
      `typedef unsigned short u16;
       typedef void (*Cb)(int x __attribute__((unused))); typedef void (*Wide)(int x __attribute__((mode(DI))));
       void g(Cb c, Wide w); struct S { Cb c; void (*d)(int y __attribute__((packed))); u16 x; }; struct S h(void);`,
      'c',
    );
    expect(p.g?.params).toEqual([
      'void (*)(int x __attribute__((unused)))',
      'void (*)(int x __attribute__((mode(DI))))',
    ]);
    expect(declaredCallArgs(p.g, ARMV4T_AGBCC)?.widths).toEqual([32, 32]);
    expect(p.h?.returnLayout?.members?.map((m) => m.name)).toEqual(['c', 'd', 'x']);
  });

  test('a function pointer member whose own parameter list cannot be read is still a member', () => {
    const layout = (src: string, language: 'c' | 'c++') =>
      prototypesFromContext(`typedef unsigned short u16; ${src} struct S h(void);`, language).h?.returnLayout;
    const members = {
      kind: 'struct',
      members: [
        { name: 'cb', type: 'void *' },
        { name: 'y', type: 'u16' },
      ],
    };
    expect(layout('struct S { void (*cb)(char (x)); u16 y; };', 'c')).toEqual(members);
    expect(layout('struct S { void (*cb)(int x, ); u16 y; };', 'c')).toEqual(members);
    expect(layout('struct S { void (*cb)(int class); u16 y; };', 'c++')).toEqual(members);
    // a member statement that cannot be read still leaves the layout unread
    expect(layout('struct S { void (*cb)(int); u16 y[; };', 'c')).toEqual({ kind: 'struct' });
  });

  test('an aligned typedef of its own body leaves that body unread, and no other', () => {
    const p = prototypesFromContext(
      `typedef int s32; typedef struct { s32 v; } G __attribute__((aligned(8)));
       struct G2 { G g; }; struct G2 mkg(s32); struct S { s32 v; }; struct S mks(s32);`,
      'c',
    );
    expect(p.mkg?.returnLayout).toEqual({ kind: 'struct' });
    expect(p.mks?.returnLayout?.members).toEqual([{ name: 'v', type: 's32' }]);
  });

  // compiled, `struct SB { enum Big k; }` and `struct SC { enum C k; }` are 8 bytes, where
  // `struct SN { Neg k; }` and `struct SI { enum Int k; }` are 4
  test('an enum with a value an int cannot hold is not sized', () => {
    const p = prototypesFromContext(
      `typedef int s32;
       enum Big { B0 = 0, B1 = 0x100000000LL }; struct SB { enum Big k; }; struct SB mkb(s32);
       enum C { C0, C1 = B1 }; struct SC { enum C k; }; struct SC mkc(s32);
       typedef enum { N0 = -1, N1 = 0x80000000 } Neg; struct SN { Neg k; }; struct SN mkn(s32);
       enum Int { I0 = 0, I1 = 0x80000000 }; struct SI { enum Int k; }; struct SI mki(s32);`,
      'c',
    );
    expect(p.mkb?.returnLayout).toEqual({ kind: 'struct' });
    expect(p.mkc?.returnLayout).toEqual({ kind: 'struct' });
    expect(p.mkn?.returnLayout?.members).toEqual([{ name: 'k', type: 'enum Neg' }]);
    expect(p.mki?.returnLayout?.members).toEqual([{ name: 'k', type: 'enum Int' }]);
  });

  // each member points at the struct itself: laying out every pointee on every path is 9^8 walks
  test('a struct whose members point back at it is laid out once per depth', () => {
    const ptrs = Array.from({ length: 8 }, (_, i) => `struct Node *p${i};`).join(' ');
    const p = prototypesFromContext(`struct Node { u32 v; ${ptrs} }; struct Node getnode(s32);`, 'c');
    expect(p.getnode?.returnLayout?.members).toHaveLength(9);
  });

  test('a struct return spelled in a way this cannot read still returns a struct', () => {
    const c = prototypesFromContext(
      'struct Blob64 { u32 w[16]; }; struct Blob64 EWRAM_FN makeblob(const void *); union U __attr mku(s32);',
      'c',
    );
    expect(c.makeblob).toEqual({ returnLayout: { kind: 'struct' }, params: ['const void *'] });
    expect(c.mku).toEqual({ returnLayout: { kind: 'union' }, params: ['s32'] });
    // …and so does one with an unknown word ahead of the type
    expect(prototypesFromContext('struct Blob64 { u32 w[16]; }; EWRAM_FN struct Blob64 mk(void);', 'c').mk).toEqual({
      returnLayout: { kind: 'struct' },
      params: [],
    });
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
    // …a definition after a forward declaration is the one laid out
    const gxc = prototypesFromContext('struct GXC; struct GXC { u8 r, g, b, a; }; GXC getc2(s32 i);', 'c++');
    expect(gxc.getc2?.returnLayout?.members).toEqual(['r', 'g', 'b', 'a'].map((name) => ({ name, type: 'u8' })));
    // …and a class, or a struct with a base, is a struct whose members this does not lay out
    for (const def of [
      'class Vec { public: u32 x, y, z; };',
      'struct Base { u32 x; }; struct Vec : Base { u32 y, z; };',
    ]) {
      expect(prototypesFromContext(`${def} extern "C" Vec getv(s32 i);`, 'c++').getv).toEqual({
        returns: 'Vec',
        returnLayout: { kind: 'struct' },
        params: ['s32'],
      });
    }
  });

  test('an unknown word ahead of the type leaves the parameters read, and states no return', () => {
    const p = prototypesFromContext(
      `typedef unsigned int u32;
       NAKED void naked(int x); UNUSED static void unused(int x); EWRAM_FN NAKED void two(int x);
       ARM_FUNC unsigned int words(u32 a, u32 b); void inparam(MACRO int x, int y);`,
      'c',
    );
    expect(p.naked).toEqual({ params: ['int'] });
    expect(p.unused).toEqual({ params: ['int'] });
    expect(p.two).toEqual({ params: ['int'] });
    expect(p.words).toEqual({ params: ['u32', 'u32'] });
    expect(p.inparam).toEqual({ returnsVoid: true, params: ['MACRO int', 'int'] });
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
    const p = withContextPrototypes({ makeblob: { params: ['const void *'] } }, ctx, 'f', undefined, ARMV4T_AGBCC);
    expect(p.makeblob).toEqual({ params: ['const void *'], ...blob });
    // …and one that states a return of its own is taken whole
    const own = withContextPrototypes({ makeblob: { params: 1, returns: 's32' } }, ctx, 'f', undefined, ARMV4T_AGBCC);
    expect(own.makeblob).toEqual({ params: 1, returns: 's32' });
    const none = withContextPrototypes(
      { makeblob: { params: 1, returnsVoid: true } },
      ctx,
      'f',
      undefined,
      ARMV4T_AGBCC,
    );
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
      ARMV4T_AGBCC,
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
    expect(withContextPrototypes(undefined, ctx, 'f', symbols, ARMV4T_AGBCC).mke).toEqual({ params: ['s32'], ...blob });
  });
});

// An entry whose parameters the map sizes better yields them, and keeps the return it states: the
// map derives no `returns`, so dropping the entry whole leaves a pointer-returning call undeclared,
// and a frame address handed to it reads as a possible hidden struct-return pointer.
// pokeemerald's ConvertIntToDecimalStringN is the shape: an enum parameter nothing here can size.
describe('a context register return under a mapped signature', () => {
  const ctx = prototypesFromContext(
    'typedef unsigned char u8; typedef signed int s32; enum Mode { M0, M1 };' +
      ' u8 *conv(u8 *dest, s32 value, enum Mode mode, u8 n); int count(enum Mode m);' +
      ' int nar(enum Mode m); void put(enum Mode m); u8 *gone(enum Mode m);',
    'c',
  );
  const word = (pointer?: boolean) => ({ size: 4, signed: pointer ? null : true, ...(pointer ? { pointer } : {}) });
  const symbols = new Map([
    [
      0x1000,
      [
        {
          name: 'conv',
          kind: 'code' as const,
          signature: {
            returns: word(true),
            params: [word(true), word(), { size: 4, signed: null }, { size: 1, signed: false }],
          },
        },
      ],
    ],
    [0x1100, [{ name: 'count', kind: 'code' as const, signature: { returns: word(), params: [word()] } }]],
    // the definition's DWARF says one byte where the header says a word
    [
      0x1200,
      [{ name: 'nar', kind: 'code' as const, signature: { returns: { size: 1, signed: false }, params: [word()] } }],
    ],
    [0x1300, [{ name: 'put', kind: 'code' as const, signature: { returns: null, params: [word()] } }]],
    // the definition's DWARF says void where the header says a pointer
    [0x1400, [{ name: 'gone', kind: 'code' as const, signature: { returns: null, params: [word()] } }]],
  ]);
  const merged = withContextPrototypes(undefined, ctx, 'f', symbols, ARMV4T_AGBCC);

  test('a pointer return is kept over the parameters the map sizes', () => {
    // the source question is asked of the spellings, which leave the enum unsized; the context's
    // own reading of it (`wordParams`) sizes it for a lowering, and does not outrank the map
    expect(declaredCallArgs({ params: ctx.conv!.params }, ARMV4T_AGBCC)).toBeUndefined();
    expect(declaredCallArgs(ctx.conv!, ARMV4T_AGBCC)?.widths).toEqual([32, 32, 32, 8]);
    expect(merged.conv).toEqual({ params: ['void *', 's32', 's32', 'u8'], returns: 'u8 *' });
    expect(merged.count).toEqual({ params: ['s32'], returns: 'int' });
  });

  test('a return the map contradicts is not kept', () => {
    // a width the definition disagrees with, and a value the definition calls void
    expect(ctx.nar).toEqual({ params: ['enum Mode'], returns: 'int', wordParams: [0] });
    expect(merged.nar).toBeUndefined();
    expect(merged.gone).toBeUndefined();
  });

  test("a void return is the map's to state", () => {
    expect(merged.put).toBeUndefined();
  });

  // the map's DWARF parameters leave a `...` out (gba-kit reads DW_TAG_formal_parameter only), so a
  // variadic entry's return under them would lower `pr(buf, s, a, b)` as `pr(buf, s)`; a K&R entry
  // states its parameters no better
  test('a return is kept only under as many parameters as the context states', () => {
    const odd = prototypesFromContext(
      'enum Mode { M0, M1 }; int pr(char *buf, const char *fmt, ...); int kr(); int two(enum Mode m, int n);',
      'c',
    );
    expect(odd.pr).toEqual({ returns: 'int', variadicParams: ['char *', 'const char *'] });
    expect(odd.kr).toEqual({ returns: 'int' });
    const ptr = { size: 4, signed: null, pointer: true };
    const sigs = new Map([
      [0x2000, [{ name: 'pr', kind: 'code' as const, signature: { returns: word(), params: [ptr, ptr] } }]],
      [0x2100, [{ name: 'kr', kind: 'code' as const, signature: { returns: word(), params: [word()] } }]],
      [0x2200, [{ name: 'two', kind: 'code' as const, signature: { returns: word(), params: [word()] } }]],
    ]);
    const m = withContextPrototypes(undefined, odd, 'f', sigs, ARMV4T_AGBCC);
    expect(m.pr).toBeUndefined();
    expect(m.kr).toBeUndefined();
    expect(m.two).toBeUndefined();
  });

  // a floating return says nothing of a hidden pointer the map's word does not, and on a target
  // with an FPU call-plan refuses every call to a name declared to return one
  test('a floating return is not kept', () => {
    const fl = prototypesFromContext('enum Mode { M0, M1 }; float g(enum Mode m); double d(enum Mode m);', 'c');
    const sigs = new Map([
      [0x3000, [{ name: 'g', kind: 'code' as const, signature: { returns: word(), params: [word()] } }]],
      [
        0x3100,
        [{ name: 'd', kind: 'code' as const, signature: { returns: { size: 8, signed: true }, params: [word()] } }],
      ],
    ]);
    const m = withContextPrototypes(undefined, fl, 'f', sigs, MIPS_IDO);
    expect(m.g).toBeUndefined();
    expect(m.d).toBeUndefined();
    // …nor under a stated entry, where no map width is there to disagree with it
    expect(withContextPrototypes({ g: { params: 1 } }, fl, 'f', undefined, MIPS_IDO).g).toEqual({ params: 1 });
  });

  // a --proto or manifest entry that states only the parameters meets the same rule
  test('a stated entry that says nothing of the return keeps it under as many parameters', () => {
    const arity = withContextPrototypes({ conv: { params: 4 } }, ctx, 'f', symbols, ARMV4T_AGBCC);
    expect(arity.conv).toEqual({ params: 4, returns: 'u8 *' });
    const notVoid = withContextPrototypes(
      { conv: { params: ['u8 *', 's32', 's32', 'u8'], returnsVoid: false } },
      ctx,
      'f',
      undefined,
      ARMV4T_AGBCC,
    );
    expect(notVoid.conv).toEqual({ params: ['u8 *', 's32', 's32', 'u8'], returnsVoid: false, returns: 'u8 *' });
    expect(withContextPrototypes({ conv: { params: 3 } }, ctx, 'f', symbols, ARMV4T_AGBCC).conv).toEqual({
      params: 3,
    });
    // an entry with no `params` states no arity, so it keeps no register return
    expect(withContextPrototypes({ conv: { returnsVoid: false } }, ctx, 'f', symbols, ARMV4T_AGBCC).conv).toEqual({
      returnsVoid: false,
    });
    // a COUNT states registers, but is compared with the header's parameters: under a 64-bit
    // parameter the right register count (4) keeps no return, and a parameter count (3) keeps it
    const wide = prototypesFromContext(
      'typedef unsigned char u8; typedef long long s64; enum E { A }; u8 *wconv(u8 *, s64, enum E);',
      'c',
    );
    expect(withContextPrototypes({ wconv: { params: 4 } }, wide, 'f', undefined, ARMV4T_AGBCC).wconv).toEqual({
      params: 4,
    });
    expect(withContextPrototypes({ wconv: { params: 3 } }, wide, 'f', undefined, ARMV4T_AGBCC).wconv).toEqual({
      params: 3,
      returns: 'u8 *',
    });
    const va = prototypesFromContext('int pr(char *buf, const char *fmt, ...);', 'c');
    expect(withContextPrototypes({ pr: { params: 2 } }, va, 'f', undefined, ARMV4T_AGBCC).pr).toEqual({ params: 2 });
  });

  // agbcc -O2 of `void f(s32 w, s32 i, s32 m) { u8 buf[16]; u8 *p = conv(buf, i, 1, 3); *p++ = 0xBA;
  // conv(p, m, 1, 3); print(w, 1, buf, center(1, buf, 56)); }`, the shape of pokeemerald's
  // DrawListIndexNumber: the frame buffer is argument 0 of a call whose result is used
  const HANDED = [
    'f:',
    'push\t{r4, r5, lr}',
    'add\tsp, sp, #-0x10',
    'add\tr4, r0, #0',
    'add\tr5, r2, #0',
    'mov\tr0, sp',
    'mov\tr2, #0x1',
    'mov\tr3, #0x3',
    'bl\tconv',
    'mov\tr1, #0xba',
    'strb\tr1, [r0]',
    'add\tr0, r0, #0x1',
    'add\tr1, r5, #0',
    'mov\tr2, #0x1',
    'mov\tr3, #0x3',
    'bl\tconv',
    'lsl\tr4, r4, #0x18',
    'lsr\tr4, r4, #0x18',
    'mov\tr0, #0x1',
    'mov\tr1, sp',
    'mov\tr2, #0x38',
    'bl\tcenter',
    'add\tr3, r0, #0',
    'lsl\tr3, r3, #0x18',
    'lsr\tr3, r3, #0x18',
    'add\tr0, r4, #0',
    'mov\tr1, #0x1',
    'mov\tr2, sp',
    'bl\tprint',
    'add\tsp, sp, #0x10',
    'pop\t{r4, r5}',
    'pop\t{r0}',
    'bx\tr0',
  ].join('\n\t');
  const others = prototypesFromContext(
    'typedef unsigned char u8; int center(int f, const u8 *s, int w); void print(u8 a, u8 b, const u8 *s, u8 x);',
    'c',
  );

  test("a frame buffer handed to the kept return's callee lifts with every store and argument", () => {
    const lifted = decompile('f', `${HANDED}\n`, ARMV4T_AGBCC, { prototypes: { ...merged, ...others } }).source;
    expect(lifted).toContain('u8 sp0[16];');
    expect(lifted).toContain('v0 = conv(sp0, a1, 1, 3);');
    expect(lifted).toContain('*v0 = 186;');
    expect(lifted).toContain('conv(v0 + 1, a2, 1, 3);');
    expect(lifted).toContain('print((u8)a0, 1, sp0, (u8)center(1, sp0, 56));');
    // …and without the return, nothing says `conv` is not handed a hidden struct-return pointer
    expect(() =>
      decompile('f', `${HANDED}\n`, ARMV4T_AGBCC, {
        prototypes: { ...merged, ...others, conv: { params: merged.conv!.params! } },
      }),
    ).toThrow(/`conv` takes it at argument 0 and nothing says what that callee returns/);
    // …and a stated entry that gives only the arity lifts it the same
    const stated = withContextPrototypes({ conv: { params: 4 } }, ctx, 'f', undefined, ARMV4T_AGBCC);
    expect(decompile('f', `${HANDED}\n`, ARMV4T_AGBCC, { prototypes: { ...stated, ...others } }).source).toContain(
      'v0 = conv(sp0, a1, 1, 3);',
    );
  });
});

describe('declaredWidth', () => {
  test('a function pointer is register-wide', () => {
    expect(declaredWidth('void (*)(s32 channel, s32 result)')).toBe(32);
    expect(declaredWidth('int (*)(void)')).toBe(32);
  });
});

// The context's own entry for the function being lifted (`ownContextEntry`): handed over where it is
// a typed list every parameter of which a bound can lay out, or where it returns a struct by value,
// and abstaining on every other shape, one case each.
describe("the context's own entry", () => {
  const own = (decl: string, name = 'f', language: 'c' | 'c++' = 'c') =>
    ownContextEntry(prototypesFromContext(`struct S { int a, b, c; };\n${decl}`, language), name);

  test('a typed list is handed over whole', () => {
    expect(own('int f(short, int);')).toEqual({ params: ['short', 'int'], returns: 'int' });
    expect(own('void f(void);')).toEqual({ params: [], returnsVoid: true });
    expect(own('void f(long long, double, float);')?.params).toEqual(['long long', 'double', 'float']);
  });

  test('no entry, and an entry the context dropped as a conflict, abstain', () => {
    expect(own('int g(int);')).toBeUndefined();
    expect(own('int f(int);\nint f(int, int);')).toBeUndefined();
  });

  test('a variadic declaration abstains', () => {
    expect(own('int f(int, ...);')).toBeUndefined();
  });

  test('`()` abstains', () => {
    expect(own('int f();')).toBeUndefined();
  });

  test('a struct passed by value abstains, and so does a spelling nothing sizes', () => {
    expect(own('int f(int, struct S);')).toBeUndefined();
    expect(own('int f(int, Unknown);')).toBeUndefined();
  });

  // the return comes first, ahead of whatever the parameters say, and the bound lays none of these
  // out (`ownArgumentWordsOn`), so it reads the return alone
  test('an entry returning a struct by value is handed over whatever its parameters', () => {
    for (const decl of [
      'struct S f(int, ...);',
      'struct S f();',
      'struct S f(int, struct S);',
      'struct S f(Unknown);',
    ]) {
      expect(own(decl)?.returns).toBe('struct S');
    }
    expect(own('struct S *f(int, ...);')).toBeUndefined();
    const ctx = prototypesFromContext('struct S { int a; int b; int c; };\nstruct S f__Fi(int);', 'c');
    expect(ownContextEntry(ctx, 'f__Fi')).toBeUndefined();
  });

  test('a mangled symbol or a member function abstains', () => {
    const ctx = prototypesFromContext('int f__Fi(int);\nint get__3Fooi(int);', 'c');
    expect(ownContextEntry(ctx, 'f__Fi')).toBeUndefined();
    expect(ownContextEntry(ctx, 'get__3Fooi')).toBeUndefined();
  });

  test('a bare count abstains', () => {
    expect(ownContextEntry({ f: { params: 2 } }, 'f')).toBeUndefined();
  });
});

// The mark a table carries the own context entry under (`withOwnContextMark`), and the split every
// entry path reads it back with (`splitOwnContext`): never a stated entry, and nothing else reads it.
describe("the own context entry's mark", () => {
  const ctx = prototypesFromContext('int f(short, int);\nint g(int);', 'c');

  test('is carried where nothing states the function, and read back out of the table', () => {
    const marked = withOwnContextMark({ g: { params: 1 } }, 'f', ctx);
    expect(marked).toEqual({ g: { params: 1 }, f: { params: ['short', 'int'], returns: 'int', fromContext: true } });
    expect(splitOwnContext(marked, 'f')).toEqual({
      prototypes: { g: { params: 1 } },
      ownContextProto: { params: ['short', 'int'], returns: 'int' },
    });
  });

  test('a stated entry wins, and is left in the table as it is', () => {
    const stated = { f: { params: ['int'], returns: 'int' } };
    expect(withOwnContextMark(stated, 'f', ctx)).toBe(stated);
    expect(splitOwnContext(stated, 'f')).toEqual({ prototypes: stated, ownContextProto: undefined });
    // `fromContext: false` is a stated entry
    const unmarked = { f: { params: ['int'], fromContext: false } };
    expect(splitOwnContext(unmarked, 'f').prototypes).toBe(unmarked);
  });

  test('a marked entry the bound cannot lay out is taken out and bounds nothing', () => {
    expect(splitOwnContext({ f: { variadicParams: ['int'], fromContext: true } }, 'f')).toEqual({
      prototypes: {},
      ownContextProto: undefined,
    });
  });

  test("an entry handed over beside the table wins over the table's mark", () => {
    const given = { params: ['int'], returns: 'int' };
    expect(splitOwnContext(withOwnContextMark(undefined, 'f', ctx), 'f', given).ownContextProto).toBe(given);
  });
});
