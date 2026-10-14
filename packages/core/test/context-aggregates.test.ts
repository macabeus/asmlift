// The globals a declaration context declares as structs, unions or arrays, and those with a volatile
// byte (src/proto-context.ts `globalsFromContext`), and the structurer reading them where it would
// read the map's `shape` (structure.ts, the declaration-shape override of `scalarGlobals`). A
// global the map does not describe and the function reads only at offset 0 is otherwise spelled by
// its bare name, which is a compile error over a struct and a read of the address over an array.
// The compiled proof is packages/cli/test/matching/context-aggregate-global.test.ts.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { type ContextGlobals, globalsFromContext } from '../src/proto-context';
import { enumerateCandidates } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC, MIPS_GCC } from '../src/target';

/** The context's aggregates with no volatile byte. */
function plainAggregates(src: string, language: 'c' | 'c++'): Set<string> {
  const { aggregates, volatiles } = globalsFromContext(src, language);
  return new Set([...aggregates].filter((n) => !volatiles.has(n)));
}

describe('aggregate objects a declaration context declares', () => {
  const ctx = `
typedef unsigned char u8;
typedef struct Pos { short x, y; } Pos;
typedef struct Fwd Fwd;
typedef Pos PosAlias;
typedef u8 *Bytes;
typedef enum { A, B } Mode;
struct Info { u8 a:1; u8 b:3; };
union U { int w; short h[2]; };
extern struct Info gInfo;
extern union U gU;
extern Pos gPos;
extern Fwd gFwd;
extern PosAlias gPosAlias;
extern u8 gTab[];
extern u8 *gPtrs[4];
extern struct Info sDefined = { 0 };
struct Inline { int a; } gInline;
extern u8 gByte;
extern u8 *gPtr;
extern struct Info *gInfoPtr;
extern u8 (*gRow)[4];
extern Bytes gBytes;
extern Mode gMode;
extern enum Tag { C } gTagged;
extern UNEXPANDED_MACRO gMacro;
struct Info gFn(void);
u8 gArrFn(void);
`;
  const found = plainAggregates(ctx, 'c');

  test('a struct, a union, an array and a class through a typedef are aggregates', () => {
    expect([...found].sort()).toEqual(
      ['gFwd', 'gInfo', 'gInline', 'gPos', 'gPosAlias', 'gPtrs', 'gTab', 'gU', 'sDefined'].sort(),
    );
  });

  test('a scalar, a pointer, an enum, a function and an unread type are not', () => {
    for (const n of ['gByte', 'gPtr', 'gInfoPtr', 'gRow', 'gBytes', 'gMode', 'gTagged', 'gMacro', 'gFn', 'gArrFn']) {
      expect(found.has(n), n).toBe(false);
    }
  });

  test('an array through a typedef is an aggregate, volatile or not', () => {
    // The type table reads no typedef of an array; unless it is followed as written, `gTB`'s
    // offset-0 read is spelled `gTB`, its address, and `gTC`'s poll compares the address with 0.
    const td =
      'typedef unsigned short u16;\ntypedef u16 Arr4[4];\ntypedef volatile u16 VArr4[4];\n' +
      'typedef Arr4 Arr4b;\nextern Arr4 gTB;\nextern VArr4 gTC;\nextern Arr4b gTD;\nextern Arr4 *gTP;\n';
    const { aggregates, volatiles } = globalsFromContext(td, 'c');
    expect([...aggregates].sort()).toEqual(['gTB', 'gTC', 'gTD']);
    expect([...volatiles]).toEqual(['gTC']);
  });

  test('a C++ class is an aggregate', () => {
    expect([...plainAggregates('class Obj { int a; }; extern Obj gObj;', 'c++')]).toEqual(['gObj']);
  });
});

describe('an aggregate object with volatile storage is read as volatile', () => {
  // `*(T *)&g` drops the qualifier, so the compiler may merge the reads or hoist one out of a
  // polling loop: such an object's accesses are stamped, so the cast carries the qualifier
  const ctx = `
typedef unsigned char u8;
typedef unsigned short u16;
struct V { u16 a; u16 b; };
struct V2 { volatile u16 a; u16 b; };
struct Outer { struct V2 in; u16 c; };
struct Later;
struct Anon { struct { volatile u8 x; } s; u8 y; };
struct Nested { struct NestedIn { volatile u8 x; } in; };
struct PtrMember { volatile u8 *p; u8 *volatile q; };
struct PtrOnly { volatile u8 *p; };
typedef volatile struct V VV;
typedef VV VVAlias;
typedef volatile u16 VU16;
typedef u8 *volatile VPtr;
typedef volatile u8 *PtrToV;
union VU { volatile u16 h; u8 b; };
extern volatile struct V gV;
extern struct V volatile gVPost;
extern struct V2 gV2;
extern struct Outer gOuter;
extern VV gVV;
extern VVAlias gVVAlias;
extern volatile u16 gVArr[4];
extern VU16 gVTArr[4];
extern volatile struct V gVStructArr[2];
extern struct Anon gAnon;
extern struct NestedIn gNestedIn;
extern struct PtrMember gPtrMember;
extern VPtr gVPtrs[4];
extern u8 *volatile gVPtrs2[4];
extern union VU gVU;
extern struct V gPlain;
extern struct PtrOnly gPtrOnly;
extern volatile u8 *gPtrsToV[4];
extern PtrToV gPtrsToV2[4];
extern const struct V gConst;
extern struct Later gLater;
`;
  const found = plainAggregates(ctx, 'c');

  test('a volatile object, member, typedef, element or nested member is volatile', () => {
    for (const n of [
      'gV',
      'gVPost',
      'gV2',
      'gOuter',
      'gVV',
      'gVVAlias',
      'gVArr',
      'gVTArr',
      'gVStructArr',
      'gAnon',
      'gNestedIn',
      'gPtrMember',
      'gVPtrs',
      'gVPtrs2',
      'gVU',
    ]) {
      expect(found.has(n), n).toBe(false);
    }
  });

  test('a pointer to volatile is no volatile byte of the object, and const is no volatile', () => {
    expect([...found].sort()).toEqual(['gConst', 'gLater', 'gPlain', 'gPtrOnly', 'gPtrsToV', 'gPtrsToV2'].sort());
  });

  test('a typedef that defines a body, qualifies one, or bounds a volatile array is read through', () => {
    const typedefs = `
typedef unsigned char u8;
typedef volatile u8 vu8;
typedef unsigned short u16;
typedef u16 Name;
typedef struct { vu8 type; u8 mode; } Wipe;
typedef struct Tagged { volatile u8 a; } TaggedT;
typedef volatile struct { u8 a; } QualT;
typedef vu8 VBuf[4];
typedef u8 Buf[4];
typedef struct { Name n; Buf b; } Plain;
struct HoldsVBuf { VBuf m; u8 c; };
struct HoldsBuf { Buf m; u8 c; };
struct Gnu { __volatile__ u8 a; };
struct Gnu2 { __volatile u8 a; };
extern Wipe gWipe;
extern TaggedT gTagged;
extern QualT gQual;
extern struct HoldsVBuf gHoldsVBuf;
extern struct Gnu gGnu;
extern struct Gnu2 gGnu2;
extern Plain gPlainT;
extern struct HoldsBuf gHoldsBuf;
`;
    expect([...plainAggregates(typedefs, 'c')].sort()).toEqual(['gHoldsBuf', 'gPlainT']);
  });

  test('a chain of typedefs deeper than the nesting bound is no volatile', () => {
    // each member reaches `u8` through eighteen typedef names, and the bound counts bodies, not names
    const names = Array.from({ length: 18 }, (_, i) => `typedef T${i} T${i + 1};`).join('\n');
    const deep = `typedef unsigned char T0;\n${names}\nstruct D { T18 a; T18 b; }; extern struct D gDeep;`;
    expect([...plainAggregates(deep, 'c')]).toEqual(['gDeep']);
  });

  test('a typedef cycle is read as volatile, and a restated typedef keeps its body', () => {
    const cyc = 'typedef struct S { volatile int a; } T; typedef T U; typedef U T; extern T gCyc; extern U gCycU;';
    expect([...plainAggregates(cyc, 'c')]).toEqual([]);
    const self = 'typedef struct { volatile int a; } T; typedef T T; extern T gSelf;';
    expect([...plainAggregates(self, 'c')]).toEqual([]);
    expect([...plainAggregates('struct S { volatile int a; }; typedef S S; extern S gS;', 'c++')]).toEqual([]);
  });

  test('a C++ member typedef or static member is no byte of the object', () => {
    const cpp = 'struct S { static volatile int s; typedef S Self; int a; }; extern S gStatic;';
    expect([...plainAggregates(cpp, 'c++')]).toEqual(['gStatic']);
  });

  test('a C++ member typedef is read where a member names it, and a base class is read too', () => {
    const typedefs = [
      'struct MT { typedef volatile unsigned short VU; VU a; unsigned short b; }; extern MT gMT;',
      'struct MB { typedef struct { volatile int x; } In; In i; }; extern MB gMB;',
      'struct MA { typedef volatile unsigned char B[4]; B b; }; extern MA gMA;',
      'typedef int VI; struct MS { typedef volatile int VI; VI a; }; extern MS gMS;',
      'struct MP { typedef volatile int VI; VI *p; }; extern MP gMP;',
    ].join('\n');
    expect([...plainAggregates(typedefs, 'c++')]).toEqual(['gMP']);
    const bases = [
      'struct B0 { volatile unsigned short a; }; struct B1 { int n; };',
      'struct D : public B0 { int c; }; extern D gD;',
      'class D2 : B1, private D { public: int c; }; extern D2 gD2;',
      'struct D3 : public B1 { int c; }; extern D3 gD3;',
      'namespace ns { struct B { int b; }; } struct D4 : ns::B { int c; }; extern D4 gD4;',
      'template <class T> struct TB { T t; }; struct D5 : TB<int> { int c; }; extern D5 gD5;',
      'struct D6 : Unread { int c; }; extern D6 gD6;',
    ].join('\n');
    // a base this cannot read (qualified, a template, one with no body here) is read as volatile
    expect([...plainAggregates(bases, 'c++')]).toEqual(['gD3']);
  });

  test('a C++ class with a volatile member is volatile', () => {
    expect([...plainAggregates('class Reg { volatile int a; }; extern Reg gReg;', 'c++')]).toEqual([]);
  });
});

describe('the volatile objects a declaration context declares', () => {
  const ctx = `
typedef unsigned char u8;
typedef unsigned short u16;
typedef volatile u16 vu16;
struct V { u16 a; u16 b; };
struct V2 { vu16 a; u16 b; };
typedef struct { volatile u8 x; } Anon;
extern volatile struct V gV;
extern struct V2 gV2;
extern Anon gAnon;
extern volatile u16 gVArr[4];
extern vu16 gReg;
extern u8 *volatile gVPtr;
extern volatile u8 *gPtrToV;
extern struct V gPlain;
extern u16 gScalar;
extern struct Unread gUnread;
struct Opaque { UNREADABLE_MACRO(x) };
extern struct Opaque gOpaque;
volatile int gFn(void);
`;
  const { aggregates, volatiles } = globalsFromContext(ctx, 'c');

  test('every object with a volatile byte, aggregate or scalar, is volatile', () => {
    expect([...volatiles].sort()).toEqual(['gAnon', 'gOpaque', 'gReg', 'gV', 'gV2', 'gVArr', 'gVPtr'].sort());
  });

  test('a volatile aggregate is still an aggregate', () => {
    expect([...aggregates].sort()).toEqual(['gAnon', 'gOpaque', 'gPlain', 'gUnread', 'gV', 'gV2', 'gVArr'].sort());
  });
});

/** `ldrb` of a pool-addressed global at offset 0, and nothing else: the bare spelling's only reader */
const READ = 'f:\n\tldr\tr0, .L1\n\tldrb\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\tgInfo\n';
const STORE = 'f:\n\tldr\tr1, .L1\n\tstrb\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\tgInfo\n';
const INFO: ContextGlobals = { aggregates: new Set(['gInfo']), volatiles: new Set(), pointeeVolatiles: new Set() };

describe('a context-declared aggregate the map does not describe', () => {
  test('an offset-0 read and store are spelled through the address, not the bare name', () => {
    expect(decompile('f', READ, ARMV4T_AGBCC).source).toContain('return gInfo;');
    expect(decompile('f', READ, ARMV4T_AGBCC, { contextGlobals: INFO }).source).toContain('return *(u8 *)&gInfo;');
    expect(decompile('f', STORE, ARMV4T_AGBCC).source).toContain('gInfo = a0;');
    expect(decompile('f', STORE, ARMV4T_AGBCC, { contextGlobals: INFO }).source).toContain('*(u8 *)&gInfo = a0;');
  });

  test('every ranked candidate takes it, with the map and in the raw-globals setting', () => {
    // a map that knows another name, so the raw-globals setting is enumerated
    const map: SymbolMap = new Map([[0x3000000, [{ name: 'gOther', kind: 'data', shape: 'scalar', size: 1 }]]]);
    const cands = enumerateCandidates('f', READ, ARMV4T_AGBCC, { symbols: map, contextGlobals: INFO });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.source, c.variations.join('/')).toContain('*(u8 *)&gInfo');
    }
  });

  test('the spelling is the toolchain-neutral structurer’s: a MIPS read takes it too', () => {
    const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlbu\tv0,0(v0)\n';
    const asmData: AsmData = {
      sections: new Map(),
      relocs: [
        { section: '.text', offset: 0, type: 'R_MIPS_HI16', sym: 'gInfo', addend: 0 },
        { section: '.text', offset: 8, type: 'R_MIPS_LO16', sym: 'gInfo', addend: 0 },
      ],
      symbols: new Map(),
      symbolCount: 0,
      bigEndian: true,
    };
    expect(decompile('getg', asm, MIPS_GCC, { asmData }).source).toContain('return gInfo;');
    expect(decompile('getg', asm, MIPS_GCC, { asmData, contextGlobals: INFO }).source).toContain(
      'return *(u8 *)&gInfo;',
    );
  });
});
