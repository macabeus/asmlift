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

const TYPES = 'typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32; typedef short s16;\n';
const S = 'struct S { u32 p; u16 a; u16 b; s16 c; u8 d; };\n';

/** a map that knows another name: the structurer's symbol context exists, and says nothing of `g` */
const MAP: SymbolMap = new Map([[0x3000000, [{ name: 'gOther', kind: 'data', shape: 'scalar', size: 1 }]]]);

const lift = (asm: string, ctx: string | undefined) =>
  decompile(asm.slice(0, asm.indexOf(':')), asm, ARMV4T_AGBCC, {
    symbols: MAP,
    ...(ctx === undefined ? {} : { contextGlobals: globalsFromContext(TYPES + ctx, 'c') }),
    prototypes: { f: { params: ['u32', 'u16', 'u16'], returnsVoid: true }, h: { params: ['u32'], returns: 's32' } },
  }).source;

describe('a struct-array member spelled through the declared array', () => {
  test('stores to two members name the declared array and its members, with no cast', () => {
    const src = lift(F, `${S}extern struct S g[4];`);
    expect(src).toMatch(/\bg\[a0\]\.a = a1;/);
    expect(src).toMatch(/\bg\[a0\]\.b = a2;/);
    expect(src).not.toContain('&g');
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

  test('a store of another sign takes it: a store truncates to the member whatever its type', () => {
    const signedA = 'struct S { u32 p; s16 a; s16 b; s16 c; u8 d; };\n';
    expect(lift(F, `${signedA}extern struct S g[4];`)).toMatch(/\bg\[a0\]\.a = /);
  });
});
