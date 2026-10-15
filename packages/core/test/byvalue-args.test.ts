// A struct passed BY VALUE on agbcc travels in consecutive argument words (thumb.h:632-650): the
// caller builds it in its frame — through copies of sp, Thumb having no sp-relative halfword or byte
// store — and loads its words into the registers the declaration places it in. Every fixture is
// agbcc's own output at the corpus flags (`-mthumb-interwork -O2 -fhex-asm -fprologue-bugfix`), save
// the two marked hand-edited.
import { describe, expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

// `struct A { u16 a, b, c, d; s8 e, f; }; void take2(struct A a); void byvalregs(u16 x, u16 y) {
//  struct A a; a.a = x; a.b = y; a.c = 0xF0; a.d = 0x78; a.e = a.f = 4; take2(a); }` (the synthetic
//  row `byvalregs`)
const BYVALREGS =
  'byvalregs:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tlsl\tr1, r1, #0x10\n\tlsr\tr1, r1, #0x10\n' +
  '\tmov\tr2, sp\n\tstrh\tr0, [r2]\n\tmov\tr0, sp\n\tstrh\tr1, [r0, #0x2]\n\tmov\tr1, sp\n' +
  '\tmov\tr0, #0xf0\n\tstrh\tr0, [r1, #0x4]\n\tmov\tr0, #0x78\n\tstrh\tr0, [r1, #0x6]\n' +
  '\tmov\tr0, #0x4\n\tstrb\tr0, [r1, #0x9]\n\tstrb\tr0, [r2, #0x8]\n\tldr\tr0, [sp]\n' +
  '\tldr\tr1, [sp, #0x4]\n\tldr\tr2, [sp, #0x8]\n\tbl\ttake2\n\tadd\tsp, sp, #0xc\n\tpop\t{r0}\n' +
  '\tbx\tr0\n';
// `void ptr(struct A *p) { take2(*p); }` — the words come off a pointer, not the frame
const PTR =
  'ptr:\n\tpush\t{lr}\n\tadd\tr2, r0, #0\n\tldr\tr0, [r2]\n\tldr\tr1, [r2, #0x4]\n' +
  '\tldr\tr2, [r2, #0x8]\n\tbl\ttake2\n\tpop\t{r0}\n\tbx\tr0\n';
// `void five(u16 x) { struct A a; …; take5(1, 2, a); }` — `a` takes r2, r3 and [sp,#0]
const FIVE =
  'five:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr1, sp, #0x4\n\tstrh\tr0, [r1]\n' +
  '\tmov\tr0, #0x1\n\tstrh\tr0, [r1, #0x2]\n\tmov\tr0, #0x2\n\tstrh\tr0, [r1, #0x4]\n' +
  '\tmov\tr0, #0x3\n\tstrh\tr0, [r1, #0x6]\n\tadd\tr2, r1, #0\n\tmov\tr0, #0x4\n' +
  '\tstrb\tr0, [r1, #0x9]\n\tstrb\tr0, [r2, #0x8]\n\tldr\tr0, [sp, #0xc]\n\tstr\tr0, [sp]\n' +
  '\tldr\tr2, [sp, #0x4]\n\tldr\tr3, [sp, #0x8]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tbl\ttake5\n' +
  '\tadd\tsp, sp, #0x10\n\tpop\t{r0}\n\tbx\tr0\n';
// `struct R { u16 x, y; } mkr(struct A a); void sretby(u16 x) { struct A a; struct R r; …; r = mkr(a);
//  gOut = r.x; }` — the hidden pointer in r0, so the struct passed is r1-r3
const SRETBY =
  'sretby:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x10\n\tmov\tr1, sp\n\tstrh\tr0, [r1]\n\tmov\tr0, #0x1\n' +
  '\tstrh\tr0, [r1, #0x2]\n\tmov\tr0, #0x2\n\tstrh\tr0, [r1, #0x4]\n\tmov\tr0, #0x3\n' +
  '\tstrh\tr0, [r1, #0x6]\n\tmov\tr2, sp\n\tmov\tr0, #0x4\n\tstrb\tr0, [r1, #0x9]\n' +
  '\tstrb\tr0, [r2, #0x8]\n\tadd\tr0, sp, #0xc\n\tldr\tr1, [sp]\n\tldr\tr2, [sp, #0x4]\n' +
  '\tldr\tr3, [sp, #0x8]\n\tbl\tmkr\n\tldr\tr1, [sp, #0xc]\n\tldr\tr0, .L5\n\tstrh\tr1, [r0]\n' +
  '\tadd\tsp, sp, #0x10\n\tpop\t{r0}\n\tbx\tr0\n.L6:\n\t.align\t2, 0\n.L5:\n\t.word\tgOut\n';
// `void esc(u16 x) { struct A a; …; take2(a); use(&a); }`
const ESC =
  'esc:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tmov\tr1, sp\n\tstrh\tr0, [r1]\n\tmov\tr0, #0x1\n' +
  '\tstrh\tr0, [r1, #0x2]\n\tmov\tr0, #0x2\n\tstrh\tr0, [r1, #0x4]\n\tmov\tr0, #0x3\n' +
  '\tstrh\tr0, [r1, #0x6]\n\tmov\tr2, sp\n\tmov\tr0, #0x4\n\tstrb\tr0, [r1, #0x9]\n' +
  '\tstrb\tr0, [r2, #0x8]\n\tldr\tr0, [sp]\n\tldr\tr1, [sp, #0x4]\n\tldr\tr2, [sp, #0x8]\n' +
  '\tbl\ttake2\n\tmov\tr0, sp\n\tbl\tuse\n\tadd\tsp, sp, #0xc\n\tpop\t{r0}\n\tbx\tr0\n';

// `struct Big3 { struct A a; u16 x; }; void big3(u16 x) { struct Big3 g; g.x = x; g.a.a = x; …; take2(g.a);
//  gOut = g.x; }` — the struct passed is the first 12 bytes of a 16-byte local
const BIG3 =
  'big3:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x10\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n' +
  '\tmov\tr1, sp\n\tstrh\tr0, [r1, #0xc]\n\tstrh\tr0, [r1]\n\tmov\tr0, #0x1\n' +
  '\tstrh\tr0, [r1, #0x2]\n\tmov\tr0, #0x2\n\tstrh\tr0, [r1, #0x4]\n\tmov\tr0, #0x3\n' +
  '\tstrh\tr0, [r1, #0x6]\n\tmov\tr0, #0x4\n\tstrb\tr0, [r1, #0x8]\n\tmov\tr0, #0x5\n' +
  '\tstrb\tr0, [r1, #0x9]\n\tldr\tr0, [sp]\n\tldr\tr1, [sp, #0x4]\n\tldr\tr2, [sp, #0x8]\n' +
  '\tbl\ttake2\n\tldr\tr1, .L3\n\tmov\tr0, sp\n\tldrh\tr0, [r0, #0xc]\n\tstrh\tr0, [r1]\n' +
  '\tadd\tsp, sp, #0x10\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgOut\n';
// `void inner(void) { struct A v[2]; fillA(v); take2(v[1]); }` — the struct passed is an element of an
//  escaped array
const INNER =
  'inner:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x18\n\tmov\tr0, sp\n\tbl\tfillA\n' +
  '\tldr\tr0, [sp, #0xc]\n\tldr\tr1, [sp, #0x10]\n\tldr\tr2, [sp, #0x14]\n\tbl\ttake2\n' +
  '\tadd\tsp, sp, #0x18\n\tpop\t{r0}\n\tbx\tr0\n';
// `extern struct A gA; void glob(void) { take2(gA); }` — the words come off the global
const GLOB =
  'glob:\n\tpush\t{lr}\n\tldr\tr2, .L3\n\tldr\tr0, [r2]\n\tldr\tr1, [r2, #0x4]\n' +
  '\tldr\tr2, [r2, #0x8]\n\tbl\ttake2\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n' +
  '\t.word\tgA\n';
// `void taked3(u16 x, struct D c); void copy(u16 x, int i) { gD = gDT[i]; taked3(x, gD); }` — agbcc passes
//  the registers it just stored to `gD`
const COPY =
  'copy:\n\tpush\t{lr}\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n\tldr\tr3, .L3\n' +
  '\tldr\tr2, .L3+0x4\n\tlsl\tr1, r1, #0x3\n\tadd\tr1, r1, r2\n\tldr\tr2, [r1, #0x4]\n' +
  '\tldr\tr1, [r1]\n\tstr\tr1, [r3]\n\tstr\tr2, [r3, #0x4]\n\tbl\ttaked3\n\tpop\t{r0}\n' +
  '\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgD\n\t.word\tgDT\n';
// `void stale(void) { struct D t = gD; gD.a = 1; taked1(t); }` — a store to the global lies between its
//  loads and the call
const STALE =
  'stale:\n\tpush\t{lr}\n\tldr\tr3, .L3\n\tldr\tr0, [r3]\n\tldr\tr1, [r3, #0x4]\n' +
  '\tmov\tr2, #0x1\n\tstrh\tr2, [r3]\n\tbl\ttaked1\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n' +
  '\t.align\t2, 0\n.L3:\n\t.word\tgD\n';
// `void taked(u64 x, struct D c); void wide(u16 a, int i) { struct D c; c.a = a; …; ((u16 *)&c)[i] = 9;
//  taked(gX, c); }` — the u64 takes r0/r1, so the struct is r2/r3
const WIDE =
  'wide:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tlsl\tr0, r0, #0x10\n\tldr\tr3, .L3\n' +
  '\tldr\tr4, .L3+0x4\n\tlsr\tr0, r0, #0x10\n\tmov\tr2, #0x80\n\tlsl\tr2, r2, #0x9\n' +
  '\torr\tr0, r0, r2\n\tstr\tr0, [sp]\n\tldr\tr0, [sp, #0x4]\n\tand\tr0, r0, r3\n' +
  '\tmov\tr2, #0x2\n\torr\tr0, r0, r2\n\tand\tr0, r0, r4\n\tmov\tr2, #0xc0\n' +
  '\tlsl\tr2, r2, #0xa\n\torr\tr0, r0, r2\n\tstr\tr0, [sp, #0x4]\n\tlsl\tr1, r1, #0x1\n' +
  '\tadd\tr1, r1, sp\n\tmov\tr0, #0x9\n\tstrh\tr0, [r1]\n\tldr\tr0, .L3+0x8\n' +
  '\tldr\tr1, [r0, #0x4]\n\tldr\tr0, [r0]\n\tldr\tr2, [sp]\n\tldr\tr3, [sp, #0x4]\n\tbl\ttaked\n' +
  '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n' +
  '\t.word\t-0x10000\n\t.word\t0xffff\n\t.word\tgX\n';
// `struct F { u16 a, b; u32 c; s8 e, f; }; void fw0(u16 a, u32 w) { struct F x; x.a = a; x.b = 1;
//  x.c = w; x.e = 3; x.f = 4; takeF(x); }` — the word member is stored straight to [sp,#4]
const FW0 =
  'fw0:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tmov\tr2, sp\n\tstrh\tr0, [r2]\n' +
  '\tmov\tr0, #0x1\n\tstrh\tr0, [r2, #0x2]\n\tstr\tr1, [sp, #0x4]\n\tmov\tr1, sp\n' +
  '\tmov\tr0, #0x3\n\tstrb\tr0, [r1, #0x8]\n\tmov\tr0, #0x4\n\tstrb\tr0, [r1, #0x9]\n' +
  '\tldr\tr0, [sp]\n\tldr\tr1, [sp, #0x4]\n\tldr\tr2, [sp, #0x8]\n\tbl\ttakeF\n' +
  '\tadd\tsp, sp, #0xc\n\tpop\t{r0}\n\tbx\tr0\n';
// `… takeF(x); gW = x.c; }` — and read back off [sp,#4] after the call
const AFTER =
  'after:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tmov\tr2, sp\n\tstrh\tr0, [r2]\n' +
  '\tmov\tr0, #0x1\n\tstrh\tr0, [r2, #0x2]\n\tstr\tr1, [sp, #0x4]\n\tmov\tr1, sp\n' +
  '\tmov\tr0, #0x3\n\tstrb\tr0, [r1, #0x8]\n\tmov\tr0, #0x4\n\tstrb\tr0, [r1, #0x9]\n' +
  '\tldr\tr0, [sp]\n\tldr\tr1, [sp, #0x4]\n\tldr\tr2, [sp, #0x8]\n\tbl\ttakeF\n' +
  '\tldr\tr1, .L4\n\tldr\tr0, [sp, #0x4]\n\tstr\tr0, [r1]\n\tadd\tsp, sp, #0xc\n\tpop\t{r0}\n' +
  '\tbx\tr0\n.L5:\n\t.align\t2, 0\n.L4:\n\t.word\tgW\n';
// `… gp(&x.c); takeF(x); }` — the member's address is handed over
const INTERIOR =
  'interior:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tmov\tr2, sp\n\tstrh\tr0, [r2]\n' +
  '\tmov\tr0, #0x1\n\tstrh\tr0, [r2, #0x2]\n\tstr\tr1, [sp, #0x4]\n\tmov\tr1, sp\n' +
  '\tmov\tr0, #0x3\n\tstrb\tr0, [r1, #0x8]\n\tmov\tr0, #0x4\n\tstrb\tr0, [r1, #0x9]\n' +
  '\tadd\tr0, sp, #0x4\n\tbl\tgp\n\tldr\tr0, [sp]\n\tldr\tr1, [sp, #0x4]\n' +
  '\tldr\tr2, [sp, #0x8]\n\tbl\ttakeF\n\tadd\tsp, sp, #0xc\n\tpop\t{r0}\n\tbx\tr0\n';
// `struct E { u16 a; s8 c, d; u16 b; s8 e, f; }; void tm(u16 a, u16 b, u32 p, u32 q) { struct E x;
//  x.a = a; x.c = 1; x.d = 2; x.b = b; x.e = 3; x.f = 4; takeE(p, x, q); }` — an 8-byte struct built
//  by word read-modify-write at [sp] and [sp,#4]
const TM =
  'tm:\n\tpush\t{r4, r5, r6, lr}\n\tmov\tr6, r8\n\tpush\t{r6}\n\tadd\tsp, sp, #-0x8\n' +
  '\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n\tlsl\tr1, r1, #0x10\n\tlsr\tr1, r1, #0x10\n' +
  '\tldr\tr6, .L4\n\tadd\tr4, r6, #0\n\tldr\tr5, [sp]\n\tand\tr4, r4, r5\n\torr\tr4, r4, r0\n' +
  '\tstr\tr4, [sp]\n\tldr\tr5, .L4+0x4\n\tadd\tr0, r5, #0\n\tand\tr0, r0, r4\n' +
  '\tmov\tr4, #0x80\n\tlsl\tr4, r4, #0x9\n\torr\tr0, r0, r4\n\tstr\tr0, [sp]\n' +
  '\tldr\tr4, .L4+0x8\n\tmov\tr8, r4\n\tand\tr0, r0, r4\n\tmov\tr4, #0x80\n' +
  '\tlsl\tr4, r4, #0x12\n\torr\tr0, r0, r4\n\tstr\tr0, [sp]\n\tldr\tr0, [sp, #0x4]\n' +
  '\tand\tr6, r6, r0\n\torr\tr6, r6, r1\n\tstr\tr6, [sp, #0x4]\n\tand\tr5, r5, r6\n' +
  '\tmov\tr0, #0xc0\n\tlsl\tr0, r0, #0xa\n\torr\tr5, r5, r0\n\tstr\tr5, [sp, #0x4]\n' +
  '\tmov\tr4, r8\n\tand\tr5, r5, r4\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n' +
  '\torr\tr5, r5, r0\n\tstr\tr5, [sp, #0x4]\n\tadd\tr0, r2, #0\n\tldr\tr1, [sp]\n' +
  '\tldr\tr2, [sp, #0x4]\n\tbl\ttakeE\n\tadd\tsp, sp, #0x8\n\tpop\t{r3}\n\tmov\tr8, r3\n' +
  '\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n\tbx\tr0\n.L5:\n\t.align\t2, 0\n.L4:\n' +
  '\t.word\t-0x10000\n\t.word\t-0xff0001\n\t.word\t0xffffff\n';

const A = {
  kind: 'struct' as const,
  members: [
    ...['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u16' })),
    { name: 'e', type: 's8' },
    { name: 'f', type: 's8' },
  ],
};
const take2 = { params: ['struct A'], byValueLayouts: { 0: A }, returnsVoid: true };
const D = { kind: 'struct' as const, members: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u16' })) };

describe('a struct passed by value in argument registers', () => {
  test('is the frame object its words are loaded off, passed whole and written member by member', () => {
    const { source } = decompile('byvalregs', BYVALREGS, ARMV4T_AGBCC, { prototypes: { take2 } });
    expect(source).toContain('    struct A sp0;\n');
    expect(source).toContain('    sp0.a = a0;\n    sp0.b = a1;\n    sp0.c = 240;\n    sp0.d = 120;\n');
    expect(source).toContain('    take2(sp0);\n');
  });

  test('the callee is declared, and the struct defined beside it', () => {
    const [c] = enumerateCandidates('byvalregs', BYVALREGS, ARMV4T_AGBCC, { prototypes: { take2 } });
    const decls = renderDeclarations(c.symbolRefs ?? []);
    expect(decls).toContain('struct A { u16 a; u16 b; u16 c; u16 d; s8 e; s8 f; };');
    expect(decls).toContain('void take2(struct A);');
  });

  test('after a hidden struct-return pointer it is the registers past it', () => {
    const mkr = {
      params: ['struct A'],
      byValueLayouts: { 0: A },
      returns: 'struct R',
      returnLayout: { kind: 'struct' as const, members: ['x', 'y'].map((name) => ({ name, type: 'u16' })) },
    };
    const { source } = decompile('sretby', SRETBY, ARMV4T_AGBCC, { prototypes: { mkr } });
    expect(source).toContain('    sp12 = mkr(sp0);\n    gOut = sp12.x;\n');
    // the struct is operand 1 and declared parameter 0: the call carries the parameter, which is
    // the key the declaration's `byValueLayouts` defines it by
    const [c] = enumerateCandidates('sretby', SRETBY, ARMV4T_AGBCC, { prototypes: { mkr } });
    const decls = renderDeclarations(c.symbolRefs ?? []);
    expect(decls).toContain('struct A { u16 a; u16 b; u16 c; u16 d; s8 e; s8 f; };');
    expect(decls).toContain('struct R mkr(struct A);');
  });

  test('words loaded off a pointer, or off two places, decline', () => {
    expect(() => decompile('ptr', PTR, ARMV4T_AGBCC, { prototypes: { take2 } })).toThrow(
      /the call to `take2` passes struct A by value, and its words are not one frame object or one global, read whole just before the call/,
    );
    // hand-edited: the last word comes off [sp,#4] again, so no frame range is the struct's and the
    // words are read as the frame's own
    const twice = BYVALREGS.replace('\tldr\tr2, [sp, #0x8]\n', '\tldr\tr2, [sp, #0x4]\n');
    expect(() => decompile('byvalregs', twice, ARMV4T_AGBCC, { prototypes: { take2 } })).toThrow(
      /stack pointer used as data/,
    );
  });

  // hand-edited: the byte store moved between the word loads and the call
  test('a store between the loads and the call declines', () => {
    const late = BYVALREGS.replace('\tstrb\tr0, [r2, #0x8]\n', '').replace(
      '\tbl\ttake2\n',
      '\tmov\tr3, #0x4\n\tstrb\tr3, [r1, #0x8]\n\tbl\ttake2\n',
    );
    expect(() => decompile('byvalregs', late, ARMV4T_AGBCC, { prototypes: { take2 } })).toThrow(
      /the call to `take2` passes struct A by value, and its words are not one frame object or one global/,
    );
  });

  test('a struct inside a larger local, or an element of an escaped one, declines', () => {
    // the per-object model refuses `g.x` past the struct, and the one object is not on offer: a call
    // handed it would pass a pointer
    expect(() => decompile('big3', BIG3, ARMV4T_AGBCC, { prototypes: { take2 } })).toThrow(/overlap/);
    const fillA = { params: ['struct A *'], returnsVoid: true };
    expect(() => decompile('inner', INNER, ARMV4T_AGBCC, { prototypes: { take2, fillA } })).toThrow(
      /address-taken stack local/,
    );
  });

  test('a global loaded whole is passed bare, and declared as the struct', () => {
    const { source } = decompile('glob', GLOB, ARMV4T_AGBCC, { prototypes: { take2 } });
    expect(source).toContain('    take2(gA);\n');
    const [c] = enumerateCandidates('glob', GLOB, ARMV4T_AGBCC, { prototypes: { take2 } });
    const decls = renderDeclarations(c.symbolRefs ?? []);
    expect(decls).toContain('extern struct A gA;');
    expect(decls).toContain('void take2(struct A);');
  });

  test('a global just stored with the words passed is passed bare', () => {
    const taked3 = { params: ['u16', 'struct D'], byValueLayouts: { 1: D }, returnsVoid: true };
    const { source } = decompile('copy', COPY, ARMV4T_AGBCC, { prototypes: { taked3 } });
    expect(source).toContain('    taked3(a0, gD);\n');
  });

  test('a global written between its loads and the call declines', () => {
    const taked1 = { params: ['struct D'], byValueLayouts: { 0: D }, returnsVoid: true };
    expect(() => decompile('stale', STALE, ARMV4T_AGBCC, { prototypes: { taked1 } })).toThrow(
      /the call to `taked1` passes struct D by value, and its words are not one frame object or one global/,
    );
  });

  test('after a 64-bit argument it is the registers past both of its words', () => {
    // r2/r3 are read as the struct, which the audit then judges: indexed, so refused there rather
    // than as the slot model's `stack pointer used as data`
    const taked = { params: ['u64', 'struct D'], byValueLayouts: { 1: D }, returnsVoid: true };
    expect(() => decompile('wide', WIDE, ARMV4T_AGBCC, { prototypes: { taked } })).toThrow(
      /the object at \[sp,#0\) is passed by value as struct D, and this function also indexes it/,
    );
  });

  test('a struct partly on the stack declines', () => {
    const take5 = { params: ['s32', 's32', 'struct A'], byValueLayouts: { 2: A }, returnsVoid: true };
    expect(() => decompile('five', FIVE, ARMV4T_AGBCC, { prototypes: { take5 } })).toThrow(
      /`take5` takes struct A by value as its parameter 3, and it does not fit in the argument registers/,
    );
  });

  test('a struct whose address is also handed over declines', () => {
    const use = { params: ['struct A *'], returnsVoid: true };
    expect(() => decompile('esc', ESC, ARMV4T_AGBCC, { prototypes: { take2, use } })).toThrow(
      /the object at \[sp,#0\) is passed by value as struct A, and its address is also used another way/,
    );
  });

  describe('a word of the struct accessed straight at [sp,#k] is its member, not an object of its own', () => {
    const F = {
      kind: 'struct' as const,
      members: [
        { name: 'a', type: 'u16' },
        { name: 'b', type: 'u16' },
        { name: 'c', type: 'u32' },
        { name: 'e', type: 's8' },
        { name: 'f', type: 's8' },
      ],
    };
    const takeF = { params: ['struct F'], byValueLayouts: { 0: F }, returnsVoid: true };

    test('stored before the call', () => {
      const { source } = decompile('fw0', FW0, ARMV4T_AGBCC, { prototypes: { takeF } });
      expect(source).toContain('    sp0.b = 1;\n    sp0.c = a1;\n    sp0.e = 3;\n');
      expect(source).toContain('    takeF(sp0);\n');
    });

    test('read back after it', () => {
      const { source } = decompile('after', AFTER, ARMV4T_AGBCC, { prototypes: { takeF } });
      expect(source).toContain('    takeF(sp0);\n    gW = ((s32 *)&sp0)[1];\n');
    });

    test('a struct built by word read-modify-write', () => {
      const E = {
        kind: 'struct' as const,
        members: [
          { name: 'a', type: 'u16' },
          { name: 'c', type: 's8' },
          { name: 'd', type: 's8' },
          { name: 'b', type: 'u16' },
          { name: 'e', type: 's8' },
          { name: 'f', type: 's8' },
        ],
      };
      const takeE = { params: ['u32', 'struct E', 'u32'], byValueLayouts: { 1: E }, returnsVoid: true };
      const { source } = decompile('tm', TM, ARMV4T_AGBCC, { prototypes: { takeE } });
      expect(source).toContain('    v1 = ((s32 *)&sp0)[1];\n');
      expect(source).toContain('    takeE(a2, sp0, a3);\n');
    });

    test('whose address is handed over declines', () => {
      const gp = { params: ['u32 *'], returnsVoid: true };
      expect(() => decompile('interior', INTERIOR, ARMV4T_AGBCC, { prototypes: { takeF, gp } })).toThrow(
        /address-taken stack local/,
      );
    });
  });

  test('without a layout the call is lifted as before, at the guessed arity', () => {
    const { source } = decompile('byvalregs', BYVALREGS, ARMV4T_AGBCC, {
      prototypes: { take2: { params: ['struct A'], returnsVoid: true } },
      onGap: 'annotate',
    });
    expect(source).not.toContain('take2(sp0)');
  });
});
