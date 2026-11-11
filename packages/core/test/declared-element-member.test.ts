// A member of a struct-array element spelled through the array the declaration context declares,
// `g[i].a`, rather than through a cast of its address (structure/memory-access.ts
// `declaredElementMember`, DECLARED_MEMBER_GATES). On agbcc only the declared array's subscript is
// an ARRAY_REF, which expands base-first, so the two spellings place the array's address load
// differently: kleod:sub_0804C7FC:agbcc matches with this spelling and with no cast spelling.
//
// The assembly is agbcc's own (-O2 -mthumb-interwork) for
//   struct S { u32 p; u16 a; u16 b; s16 c; u8 d; };  extern struct S g[4];
//   void f(u32 i, u16 x, u16 y) { g[i].a = x; g[i].b = y; }
//   int h(u32 i) { return g[i].a + g[i].b; }
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { globalsFromContext } from '../src/proto-context';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const F = `f:
\tpush\t{r4, lr}
\tldr\tr4, .L3
\tlsl\tr3, r0, #0x1
\tadd\tr3, r3, r0
\tlsl\tr3, r3, #0x2
\tadd\tr3, r3, r4
\tstrh\tr1, [r3, #0x4]
\tstrh\tr2, [r3, #0x6]
\tpop\t{r4}
\tpop\t{r0}
\tbx\tr0
.L3:
\t.word\tg
`;

const H = `h:
\tldr\tr2, .L3
\tlsl\tr1, r0, #0x1
\tadd\tr1, r1, r0
\tlsl\tr1, r1, #0x2
\tadd\tr1, r1, r2
\tldrh\tr0, [r1, #0x4]
\tldrh\tr1, [r1, #0x6]
\tadd\tr0, r0, r1
\tbx\tlr
.L3:
\t.word\tg
`;

// `typedef void (*Fp)(void); struct S3 { Fp p; u32 x; }; extern struct S3 g3[4];`
//   s32 fpc(u32 i) { return (s32)g3[i].p > 5; }
const FPC = `fpc:
\tpush\t{lr}
\tmov\tr2, #0
\tldr\tr1, .L4
\tlsl\tr0, r0, #3
\tadd\tr0, r0, r1
\tldr\tr0, [r0]
\tcmp\tr0, #5
\tble\t.L3
\tmov\tr2, #1
.L3:
\tadd\tr0, r2, #0
\tpop\t{r1}
\tbx\tr1
.L4:
\t.word\tg3
`;

// `struct Cell { u16 tile; u16 attr; }; extern struct Cell gCells[32];`, which the map shapes as an
// array of 4-byte elements (the shape DWARF gives), copied whole and then read through a member:
//   u32 cp2(u32 i, u32 j, u32 k) { gCells[k] = gCells[j]; return gCells[i].tile; }
const CP2 = `cp2:
\tldr\tr3, .L6
\tlsl\tr2, r2, #2
\tadd\tr2, r2, r3
\tlsl\tr1, r1, #2
\tadd\tr1, r1, r3
\tldr\tr1, [r1]
\tstr\tr1, [r2]
\tlsl\tr0, r0, #2
\tadd\tr0, r0, r3
\tldrh\tr0, [r0]
\tbx\tlr
.L6:
\t.word\tgCells
`;

const TYPES = 'typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32; typedef short s16;\n';
const S = 'struct S { u32 p; u16 a; u16 b; s16 c; u8 d; };\n';

/** a map that knows another name: the structurer's symbol context exists, and says nothing of `g` */
const MAP: SymbolMap = new Map([[0x3000000, [{ name: 'gOther', kind: 'data', shape: 'scalar', size: 1 }]]]);

const lift = (asm: string, ctx: string | undefined) =>
  decompile(asm.slice(0, asm.indexOf(':')), asm, ARMV4T_AGBCC, {
    symbols: MAP,
    ...(ctx === undefined ? {} : { contextGlobals: globalsFromContext(TYPES + ctx, 'c') }),
    prototypes: {
      f: { params: ['u32', 'u16', 'u16'], returnsVoid: true },
      h: { params: ['u32'], returns: 's32' },
      fpc: { params: ['u32'], returns: 's32' },
    },
  }).source;

describe('a struct-array member spelled through the declared array', () => {
  test('stores to two members name the declared array and its members, with no cast', () => {
    const src = lift(F, `${S}extern struct S g[4];`);
    expect(src).toMatch(/\bg\[a0\]\.a = a1;/);
    expect(src).toMatch(/\bg\[a0\]\.b = a2;/);
    expect(src).not.toContain('&g');
    // the recovered element no access names any more is not declared
    expect(src).not.toContain('struct Elem');
  });

  test('loads of two members read the declared members', () => {
    const src = lift(H, `${S}extern struct S g[4];`);
    expect(src).toMatch(/\bg\[a0\]\.a\b/);
    expect(src).toMatch(/\bg\[a0\]\.b\b/);
  });

  test('a typedef element and an unsized array take it too', () => {
    const src = lift(F, `typedef ${S.replace(/;\n$/, '')} S_t;\nextern S_t g[];`);
    expect(src).toMatch(/\bg\[a0\]\.a = a1;/);
  });

  test('a struct array the context does not declare keeps the cast', () => {
    expect(lift(F, undefined)).toContain('&g)[a0]');
    expect(lift(F, undefined)).toMatch(/^struct Elem0 \{/m);
    expect(lift(F, `${S}extern u32 gOtherArray[4];`)).toContain('&g)[a0]');
  });

  test('a volatile struct array keeps the cast', () => {
    expect(lift(F, `${S}extern volatile struct S g[4];`)).not.toMatch(/\bg\[a0\]\.a\b/);
  });

  test('a rank-2 struct array keeps the cast', () => {
    expect(lift(F, `${S}extern struct S g[4][2];`)).not.toMatch(/\bg\[a0\]/);
  });

  test('an element of another size keeps the cast', () => {
    const wide = 'struct S { u32 p; u16 a; u16 b; s16 c; u8 d; u32 e; };\n';
    expect(lift(F, `${wide}extern struct S g[4];`)).not.toMatch(/\bg\[a0\]/);
  });

  test('an offset no member starts at keeps the cast', () => {
    // 12 bytes, but the u32 at 4 spans both accessed halves
    const shifted = 'struct S { u32 p; u32 q; u16 c; u8 d; };\n';
    expect(lift(F, `${shifted}extern struct S g[4];`)).not.toMatch(/\bg\[a0\]/);
  });

  test('a member of another width or a load of another sign keeps the cast', () => {
    const bytes = 'struct S { u32 p; u8 a; u8 a1; u16 b; s16 c; u8 d; };\n';
    expect(lift(F, `${bytes}extern struct S g[4];`)).not.toMatch(/\bg\[a0\]\.a\b/);
    // `a` read by `ldrh` against an s16 member: the declared spelling would sign-extend it
    const signedA = 'struct S { u32 p; s16 a; u16 b; s16 c; u8 d; };\n';
    const src = lift(H, `${signedA}extern struct S g[4];`);
    expect(src).not.toMatch(/\bg\[a0\]\.a\b/);
    expect(src).toMatch(/\bg\[a0\]\.b\b/);
  });

  test('a member pointing at a function keeps the cast: the declared spelling compares it unsigned', () => {
    const src = lift(FPC, 'typedef void (*Fp)(void);\nstruct S3 { Fp p; u32 x; };\nextern struct S3 g3[4];');
    expect(src).not.toMatch(/\bg3\[a0\]\.p\b/);
    expect(src).toContain('&g3)[a0]');
  });

  test('a word copy of the same array spelled bare does not hide the declared element from the member', () => {
    // the bare copy notes `gCells` as a pointer to u32 (memory-access.ts `bareArrayIndex`); the
    // member read must still type `gCells[a0]` as the declared struct, or the lift throws ill-typed
    const cells: SymbolMap = new Map([
      ...MAP,
      [0x3000100, [{ name: 'gCells', kind: 'data', shape: 'array', elemSize: 4, dims: [32] }]],
    ]);
    const src = decompile('cp2', CP2, ARMV4T_AGBCC, {
      symbols: cells,
      contextGlobals: globalsFromContext(
        `${TYPES}struct Cell { u16 tile; u16 attr; };\nextern struct Cell gCells[32];`,
        'c',
      ),
      prototypes: { cp2: { params: ['u32', 'u32', 'u32'], returns: 'u32' } },
    }).source;
    expect(src).toMatch(/\bgCells\[a2\] = gCells\[a1\];/);
    expect(src).toMatch(/\bgCells\[a0\]\.tile\b/);
  });

  test('a store of another sign takes it: a store truncates to the member whatever its type', () => {
    const signedA = 'struct S { u32 p; s16 a; s16 b; s16 c; u8 d; };\n';
    expect(lift(F, `${signedA}extern struct S g[4];`)).toMatch(/\bg\[a0\]\.a = /);
  });
});
