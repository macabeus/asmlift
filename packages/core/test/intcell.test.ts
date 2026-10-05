// `/int-cell` (l3/intcell.ts): a global stored back advanced by an offset, spelled as the cell's own
// arithmetic beside the default's byte-pointer store, and published only at a byte-exact score.
import { describe, expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

// agbcc -O2 of `extern u32 *g; u32 kpA(u32 n) { *g = n; g++; return 0; }`
const STORE_ADVANCE =
  'kpA:\n\tldr\tr2, .L3\n\tldr\tr1, [r2]\n\tstr\tr0, [r1]\n\tldr\tr0, [r2]\n\tadd\tr0, r0, #0x4\n\tstr\tr0, [r2]\n' +
  '\tmov\tr0, #0x0\n\tbx\tlr\n.L3:\n\t.word\tg\n';

describe('integerCellStores', () => {
  const cands = enumerateCandidates('kpA', STORE_ADVANCE, ARMV4T_AGBCC);
  const cell = cands.filter((c) => hasVariation(c.variations, 'int-cell'));

  test('spells the self-store as the cell plus the offset, beside the default', () => {
    expect(cands.some((c) => c.variations.length === 1 && c.source.includes('g = (void *)((u8 *)g + 4);'))).toBe(true);
    expect(cell.length).toBeGreaterThan(0);
    for (const c of cell) {
      expect(c.source).toContain('g = g + 4;');
      expect(c.source).not.toContain('(void *)');
    }
  });

  test('publishes it only at a byte-exact score', () => {
    for (const c of cell) {
      expect(c.matchOnly).toBe(true);
    }
  });

  test('declares the cell an integer in its own self-declared world', () => {
    for (const c of cell) {
      expect(renderDeclarations(c.symbolRefs!)).toBe('extern u32 g;\n');
    }
  });

  test('does not fire where no global is stored back', () => {
    // agbcc -O2 of `extern u32 *g; u32 kpR(void) { return *g; }`
    const read = 'kpR:\n\tldr\tr1, .L3\n\tldr\tr1, [r1]\n\tldr\tr0, [r1]\n\tbx\tlr\n.L3:\n\t.word\tg\n';
    expect(enumerateCandidates('kpR', read, ARMV4T_AGBCC).some((c) => hasVariation(c.variations, 'int-cell'))).toBe(
      false,
    );
  });
});
