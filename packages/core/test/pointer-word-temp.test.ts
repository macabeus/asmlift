// A temp that only holds the value of a global the map declares a pointer, and is the base of a
// sum `t + (x + K)`, is declared `u8 *` (structure/structure.ts, pointer-spelling.ts
// `declaresBytePointer`), where the IR types it an integer because nothing it feeds is a pointer the
// type recovery could see: here the offsets added to it are `176 << 4` and `(pos << 2) + K`,
// neither a constant op. Declared an integer, the sum it feeds is an
// integer sum, which gcc reassociates; on a compiler that does not (`keepsPointerSumAddend`) the
// temp keeps its integer. The compiled evidence is packages/cli/test/matching/pointer-spelling.test.ts.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

// agbcc -O2 of `if (a == 14) gP->shift = &gP->party[pos]; else gP->shift = &gP->box[pos];`, the
// shape of pokeemerald's SaveMonSpriteAtPos: `gP` is loaded in each arm and merged, then added to
// `(pos << 2) + K`. `second` is the else arm's value of r1, `off` how both arms build 2816.
const ARMS = (second = '\tldr\tr3, .L5\n\tldr\tr1, [r3]\n', off = '\tmov\tr0, #176\n\tlsl\tr0, r0, #4\n') =>
  'f:\n\tpush\t{r4, lr}\n\tlsl\tr1, r1, #24\n\tlsr\tr4, r1, #24\n\tcmp\tr0, #14\n\tbne\t.L2\n' +
  `\tldr\tr3, .L5\n\tldr\tr1, [r3]\n${off}\tadd\tr2, r1, r0\n\tlsl\tr0, r4, #2\n` +
  '\tmov\tr4, #167\n\tlsl\tr4, r4, #4\n\tb\t.L3\n' +
  `.L2:\n${second}${off}\tadd\tr2, r1, r0\n\tlsl\tr0, r4, #2\n\tldr\tr4, .L6\n` +
  '.L3:\n\tadd\tr0, r0, r4\n\tadd\tr1, r1, r0\n\tstr\tr1, [r2]\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n' +
  '.L5:\n\t.word\tgP\n.L6:\n\t.word\t0xa88\n.L7:\n\t.word\t0xb00\n';

const mapWith = (shape: SymbolInfo['shape']): SymbolMap =>
  new Map([[0x03001000, [{ name: 'gP', kind: 'data', declared: true, shape, size: 4 }]]]);
const run = (asm: string, symbols?: SymbolMap, target = ARMV4T_AGBCC) =>
  decompile('f', asm, target, { symbols }).source;

describe('a temp holding a map-declared pointer global', () => {
  test('is declared a byte pointer, so the sum it feeds is a pointer sum', () => {
    const src = run(ARMS(), mapWith('pointer'));
    expect(src).toContain('u8 *v2;');
    expect(src).toContain('v2 = (u8 *)gP;');
    expect(src).toContain('*v3 = (s32)(v2 + (v1 + v0));');
  });

  test('carries its byte pointer into the sum under `/unmerge`', () => {
    const unmerge = enumerateCandidates('f', ARMS(), ARMV4T_AGBCC, { symbols: mapWith('pointer') }).find(
      (c) => hasVariation(c.variations, 'unmerge') && c.variations.length === 2,
    );
    expect(unmerge?.source).toContain('= (s32)((u8 *)gP + ((a1 << 2) + (167 << 4)));');
  });
});

describe('a temp that keeps its integer', () => {
  test("on a compiler whose byte-pointer sum is not the source's", () => {
    const target = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, keepsPointerSumAddend: false },
    };
    const src = run(ARMS(), mapWith('pointer'), target);
    expect(src).toContain('s32 v2;');
    expect(src).not.toContain('u8 *v');
  });

  test('when the map declares the global anything but a pointer', () => {
    const src = run(ARMS(), mapWith('scalar'));
    expect(src).toContain('s32 v2;');
    expect(src).not.toContain('u8 *v');
  });

  test('when no declaration types the global and the IR never loads it as a pointer', () => {
    const src = run(ARMS());
    expect(src).toContain('s32 v2;');
    expect(src).not.toContain('u8 *v');
  });

  test('when no sum reads it', () => {
    // read only as a call argument: the byte pointer buys no sum its association
    const src = run(
      'f:\n\tpush\t{r4, lr}\n\tldr\tr1, .L2\n\tldr\tr4, [r1]\n\tbl\tSideEffect\n' +
        '\tmov\tr0, r4\n\tbl\tSideEffect\n\tmov\tr0, #0x0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '.L2:\n\t.word\tgP\n',
      mapWith('pointer'),
    );
    expect(src).toMatch(/v\d+ = \(s32\)gP;/);
    expect(src).not.toContain('u8 *v');
  });

  test('when an in-edge passes it anything else', () => {
    const src = run(ARMS('\tmov\tr1, r5\n'), mapWith('pointer'));
    expect(src).toContain('*v2 = a2 + (v1 + v0);');
    expect(src).not.toContain('u8 *v');
  });

  test('when the IR already types it a pointer, whose own type it keeps', () => {
    const src = run(ARMS(undefined, '\tldr\tr0, .L7\n'), mapWith('pointer'));
    expect(src).toContain('s32 *v2;');
    expect(src).not.toContain('u8 *v');
  });
});
