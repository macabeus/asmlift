// A pointer cell (l3/ptrcell.ts): a global the body stores a pointer into is declared `void *` in the
// candidate's own world, so its integer uses convert to the integer they read as, and an integer
// stored into it converts to a pointer. A global the cell meets bare holds a pointer too, unless the
// body also reads it as an integer.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { renderDeclarations } from '../src/declare';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS, targetFor } from '../src/target';
import { decompileTraced } from '../src/trace';

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

// agbcc -O2 of `extern struct N *gCur; extern s32 gLim; u32 r5(void) { u32 v = gCur->v; gCur = gCur + 1;
//   use(v); if ((s32)gCur == gLim) use(1); use(2); return gLim * 3; }`
const R5 =
  'r5:\n\tpush\t{r4, r5, lr}\n\tldr\tr4, .L21\n\tldr\tr1, [r4]\n\tldr\tr0, [r1, #0x4]\n\tadd\tr1, r1, #0x8\n' +
  '\tstr\tr1, [r4]\n\tbl\tuse\n\tldr\tr5, .L21+0x4\n\tldr\tr1, [r4]\n\tldr\tr0, [r5]\n\tcmp\tr1, r0\n' +
  '\tbne\t.L20\t@cond_branch\n\tmov\tr0, #0x1\n\tbl\tuse\n.L20:\n\tmov\tr0, #0x2\n\tbl\tuse\n\tldr\tr1, [r5]\n' +
  '\tlsl\tr0, r1, #0x1\n\tadd\tr0, r0, r1\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n.L21:\n\t.word\tgCur\n\t.word\tgLim\n';

// agbcc -O2 of `extern s32 gSave; extern u32 gOut; u32 f1(void) { u32 v = gCur->v; gCur = gCur + 1;
//   use(v); gSave = (s32)gCur; use(1); gOut = gSave + 4; return 0; }`
const F1 =
  'f1:\n\tpush\t{r4, r5, lr}\n\tldr\tr4, .L3\n\tldr\tr1, [r4]\n\tldr\tr0, [r1, #0x4]\n\tadd\tr1, r1, #0x8\n' +
  '\tstr\tr1, [r4]\n\tbl\tuse\n\tldr\tr5, .L3+0x4\n\tldr\tr0, [r4]\n\tstr\tr0, [r5]\n\tmov\tr0, #0x1\n\tbl\tuse\n' +
  '\tldr\tr1, .L3+0x8\n\tldr\tr0, [r5]\n\tadd\tr0, r0, #0x4\n\tstr\tr0, [r1]\n\tmov\tr0, #0x0\n\tpop\t{r4, r5}\n' +
  '\tpop\t{r1}\n\tbx\tr1\n.L3:\n\t.word\tgCur\n\t.word\tgSave\n\t.word\tgOut\n';

// agbcc -O2 of `extern u8 *gCur, *gSave, *gP2; u32 u3(void) { u32 v = *(u32 *)(gCur + 4); gCur = gCur + 8;
//   use(v); gSave = gCur; use(1); if (gSave + 4 == gP2) use(2); return 0; }`
const U3 =
  'u3:\n\tpush\t{r4, r5, lr}\n\tldr\tr4, .L10\n\tldr\tr1, [r4]\n\tldr\tr0, [r1, #0x4]\n\tadd\tr1, r1, #0x8\n' +
  '\tstr\tr1, [r4]\n\tbl\tuse\n\tldr\tr5, .L10+0x4\n\tldr\tr0, [r4]\n\tstr\tr0, [r5]\n\tmov\tr0, #0x1\n\tbl\tuse\n' +
  '\tldr\tr0, [r5]\n\tadd\tr0, r0, #0x4\n\tldr\tr1, .L10+0x8\n\tldr\tr1, [r1]\n\tcmp\tr0, r1\n\tbne\t.L9\t@cond_branch\n' +
  '\tmov\tr0, #0x2\n\tbl\tuse\n.L9:\n\tmov\tr0, #0x0\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n' +
  '.L10:\n\t.word\tgCur\n\t.word\tgSave\n\t.word\tgP2\n';

// agbcc -O2 of `struct N *GetNode(void); u32 k1(void) { u32 v = gCur->v; gCur = gCur + 1; use(v);
//   if (gCur == GetNode()) use(1); return 0; }`
const K1 =
  'k1:\n\tpush\t{r4, lr}\n\tldr\tr4, .L4\n\tldr\tr1, [r4]\n\tldr\tr0, [r1, #0x4]\n\tadd\tr1, r1, #0x8\n' +
  '\tstr\tr1, [r4]\n\tbl\tuse\n\tbl\tGetNode\n\tldr\tr1, [r4]\n\tcmp\tr1, r0\n\tbne\t.L3\t@cond_branch\n' +
  '\tmov\tr0, #0x1\n\tbl\tuse\n.L3:\n\tmov\tr0, #0x0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L4:\n\t.word\tgCur\n';

const SINK = { sink2: { params: [], returnsVoid: true } };
const USE = { use: { params: ['u32'], returnsVoid: true } };
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

  test('leaves a global the cell meets bare as spelled, and declares it a pointer', () => {
    // converted, `gLimit` would be converted under whatever the project declares it, a float
    // included, where bare a float compared with a pointer does not compile
    const c = defaultOf('kr1', KR1, SINK);
    expect(c.source).toContain('g = (void *)((u8 *)g + 4);');
    expect(c.source).toContain('if (g >= gLimit) g = gBase;');
    const decls = renderDeclarations(c.symbolRefs!);
    expect(decls).toContain('extern void *gLimit;\n');
    expect(decls).toContain('extern void *gBase;\n');
  });

  test('prints the conversions on every path that prints the function', () => {
    const prototypes = { use: { params: ['u32'], returnsVoid: true } };
    const ranked = defaultOf('r4', R4, prototypes).source;
    expect(ranked).toContain('use((u32)gCur);');
    expect(decompile('r4', R4, ARMV4T_AGBCC, { prototypes }).source).toBe(ranked);
    const traced = decompileTraced('r4', R4, targetFor('agbcc', TOOLCHAIN_TARGETS.agbcc.canonicalFlags), {
      prototypes,
    });
    expect(traced.source).toBe(ranked);
  });

  test('converts a cell returned as an integer', () => {
    expect(defaultOf('kr5', KR5, SINK).source).toContain('return (u32)g;');
  });

  test('converts the cell to meet a global the body also reads as an integer, which stays one', () => {
    const c = defaultOf('r5', R5, USE);
    expect(c.source).toContain('if ((u32)gCur == (u32)(u8 *)gLim) use(1);');
    expect(c.source).toContain('return gLim * 3;');
    const decls = renderDeclarations(c.symbolRefs!);
    expect(decls).toContain('extern void *gCur;\n');
    expect(decls).not.toContain('extern void *gLim;');
  });

  test('takes a global stored a cell moved by integers for a cell, stored in bytes', () => {
    const c = defaultOf('f1', F1, USE);
    expect(c.source).toContain('gSave = gCur;');
    expect(c.source).toContain('gOut = (void *)((u8 *)gSave + 4);');
    const decls = renderDeclarations(c.symbolRefs!);
    expect(decls).toContain('extern void *gSave;\n');
    expect(decls).toContain('extern void *gOut;\n');
  });

  test('leaves a global compared with a cell moved by integers bare, and declares it a pointer', () => {
    const c = defaultOf('u3', U3, USE);
    expect(c.source).toContain('if ((u8 *)gSave + 4 == gP2) use(2);');
    expect(renderDeclarations(c.symbolRefs!)).toContain('extern void *gP2;\n');
  });

  test('leaves a cell compared with a call the prototype says returns a pointer bare', () => {
    const c = defaultOf('k1', K1, { ...USE, GetNode: { params: [], returns: 'struct N *' } });
    expect(c.source).toContain('if (gCur == GetNode()) use(1);');
  });
});

describe('the C backend', () => {
  const v = (name: string): Expr => ({ k: 'var', name });
  const voidp = (e: Expr): Expr => ({ k: 'cast', to: T.ptr(T.void()), e });
  const fn = (body: Stmt[]): SFn => ({
    name: 'f',
    params: [],
    locals: [],
    retType: T.u(32),
    body: [
      { k: 'assign', name: 'gCur', value: voidp(v('gOther')) },
      ...body,
      { k: 'return', value: { k: 'const', value: 0 } },
    ],
    declaredArgs: { use: ['u32'] },
  });

  test('converts a byte sum on a cell passed to an integer parameter', () => {
    const sum: Expr = {
      k: 'bin',
      op: '+',
      l: { k: 'cast', to: T.ptr(T.u(8)), e: v('gCur') },
      r: { k: 'const', value: 8 },
    };
    const out = cBackend.emit(fn([{ k: 'exprstmt', value: { k: 'call', fn: 'use', args: [sum] } }]));
    expect(out).toContain('use((u32)((u8 *)gCur + 8));');
  });

  test('takes a global stored a cell for a cell, and converts nothing it meets bare', () => {
    const out = cBackend.emit(
      fn([
        { k: 'assign', name: 'gPrev', value: v('gCur') },
        { k: 'if', cond: { k: 'bin', op: '==', l: v('gCur'), r: v('gF') }, then: [], else: [] },
        { k: 'exprstmt', value: { k: 'call', fn: 'use', args: [v('gPrev')] } },
      ]),
    );
    expect(out).toContain('gPrev = gCur;');
    expect(out).toContain('gCur == gF');
    expect(out).toContain('use((u32)gPrev);');
  });
});
