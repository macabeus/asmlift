// Callee prototypes read out of a declaration context (src/proto-context.ts): what is read, what is
// skipped, and that every typedef resolves to the SAME type — a spelling here is printed beside the
// project's own headers, where a different type is a conflicting declaration.
import { describe, expect, test } from 'vitest';

import { declaredCallArgs, declaredWidth } from '../src/proto';
import { prototypesFromContext, withContextPrototypes } from '../src/proto-context';
import { ARMV4T_AGBCC, PPC_MWCC } from '../src/target';

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
    expect(p.SetFlashTimerIntr?.params).toEqual(['u8', 'void (**)(void)']);
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

  test('a list holding a spelling that cannot be sized is kept, and the frontend abstains on it', () => {
    const p = prototypesFromContext(
      'typedef struct Vec { float x, y; } Vec; float len(Vec v); float sq(float x);',
      'c',
    );
    expect(p.len?.params).toEqual(['Vec']);
    expect(declaredCallArgs(p.len, PPC_MWCC)?.widths).toBeUndefined();
    expect(declaredCallArgs(p.sq, PPC_MWCC)?.widths).toBeUndefined();
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

describe('declaredWidth', () => {
  test('a function pointer is register-wide', () => {
    expect(declaredWidth('void (*)(s32 channel, s32 result)')).toBe(32);
    expect(declaredWidth('int (*)(void)')).toBe(32);
  });
});
