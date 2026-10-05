// A pointer cell (l3/ptrcell.ts): a global the body stores a pointer into is declared `void *` in the
// candidate's own world, so its integer uses convert to the integer they read as, and an integer
// stored into it converts to a pointer.
import { describe, expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

// agbcc -O2 of `struct N { struct N *next; u32 v; }; extern struct N *gCur, *gOther; void use(u32);
//   u32 r4(void) { u32 v = gCur->v + gOther->v; use(v); use((u32)gCur); gCur = gOther; return 0; }`
const R4 =
  'r4:\n\tpush\t{r4, r5, lr}\n\tldr\tr4, .L3\n\tldr\tr0, [r4]\n\tldr\tr5, .L3+0x4\n\tldr\tr1, [r5]\n' +
  '\tldr\tr0, [r0, #0x4]\n\tldr\tr1, [r1, #0x4]\n\tadd\tr0, r0, r1\n\tbl\tuse\n\tldr\tr0, [r4]\n\tbl\tuse\n' +
  '\tldr\tr0, [r5]\n\tstr\tr0, [r4]\n\tmov\tr0, #0x0\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n' +
  '.L3:\n\t.word\tgCur\n\t.word\tgOther\n';

// agbcc -O2 of `extern u32 *g; extern u32 gLimit, gBase; void sink2(void); u32 kr1(u32 n) {
//   *g = n; g++; sink2(); if ((u32)g >= gLimit) g = (u32 *)gBase; return 0; }`
const KR1 =
  'kr1:\n\tpush\t{r4, lr}\n\tldr\tr4, .L4\n\tldr\tr1, [r4]\n\tstr\tr0, [r1]\n\tldr\tr0, [r4]\n' +
  '\tadd\tr0, r0, #0x4\n\tstr\tr0, [r4]\n\tbl\tsink2\n\tldr\tr0, .L4+0x4\n\tldr\tr1, [r4]\n\tldr\tr0, [r0]\n' +
  '\tcmp\tr1, r0\n\tbcc\t.L3\t@cond_branch\n\tldr\tr0, .L4+0x8\n\tldr\tr0, [r0]\n\tstr\tr0, [r4]\n.L3:\n' +
  '\tmov\tr0, #0x0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L4:\n\t.word\tg\n\t.word\tgLimit\n\t.word\tgBase\n';

// agbcc -O2 of the same with `return (u32)g;` after the call
const KR5 =
  'kr5:\n\tpush\t{r4, lr}\n\tldr\tr4, .L3\n\tldr\tr1, [r4]\n\tstr\tr0, [r1]\n\tldr\tr0, [r4]\n' +
  '\tadd\tr0, r0, #0x4\n\tstr\tr0, [r4]\n\tbl\tsink2\n\tldr\tr0, [r4]\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
  '.L3:\n\t.word\tg\n';

const SINK = { sink2: { params: [], returnsVoid: true } };
const defaultOf = (name: string, asm: string, prototypes = {}) =>
  enumerateCandidates(name, asm, ARMV4T_AGBCC, { prototypes }).find((c) => c.variations.length === 1)!;

describe('legalizePointerCells', () => {
  test('converts a cell passed to an integer parameter, and declares the cell a pointer', () => {
    const c = defaultOf('r4', R4, { use: { params: ['u32'], returnsVoid: true } });
    expect(c.source).toContain('gCur = (void *)gOther;');
    expect(c.source).toContain('use((u32)gCur);');
    expect(renderDeclarations(c.symbolRefs!)).toContain('extern void *gCur;\n');
  });

  test('leaves an argument bare where no prototype says the parameter is an integer', () => {
    const c = defaultOf('r4', R4);
    expect(c.source).toContain('use(gCur);');
  });

  test('compares a cell as a word and converts an integer stored into it', () => {
    const c = defaultOf('kr1', KR1, SINK);
    expect(c.source).toContain('g = (void *)((u8 *)g + 4);');
    expect(c.source).toMatch(/if \(\(u32\)g >= \(u32\)gLimit\)/);
    expect(c.source).toContain('g = (void *)gBase;');
  });

  test('converts a cell returned as an integer', () => {
    expect(defaultOf('kr5', KR5, SINK).source).toContain('return (u32)g;');
  });
});
