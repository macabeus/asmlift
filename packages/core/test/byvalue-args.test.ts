// A struct passed BY VALUE on agbcc travels in consecutive argument words (thumb.h:632-650): the
// caller builds it in its frame — through copies of sp, Thumb having no sp-relative halfword or byte
// store — and loads its words into the registers the declaration places it in. Every fixture is
// agbcc's own output at the corpus flags (`-mthumb-interwork -O2 -fhex-asm -fprologue-bugfix`), save
// the one marked hand-edited.
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

const A = {
  kind: 'struct' as const,
  members: [
    ...['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u16' })),
    { name: 'e', type: 's8' },
    { name: 'f', type: 's8' },
  ],
};
const take2 = { params: ['struct A'], byValueLayouts: { 0: A }, returnsVoid: true };

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
  });

  test('words loaded off a pointer, or off two places, decline', () => {
    expect(() => decompile('ptr', PTR, ARMV4T_AGBCC, { prototypes: { take2 } })).toThrow(
      /the call to `take2` passes struct A by value, and its words are not word loads off consecutive words of this function's frame/,
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
      /a store or a call lies between a word's load and the call/,
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

  test('without a layout the call is lifted as before, at the guessed arity', () => {
    const { source } = decompile('byvalregs', BYVALREGS, ARMV4T_AGBCC, {
      prototypes: { take2: { params: ['struct A'], returnsVoid: true } },
      onGap: 'annotate',
    });
    expect(source).not.toContain('take2(sp0)');
  });
});
