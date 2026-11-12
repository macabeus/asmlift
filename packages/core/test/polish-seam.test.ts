// The readability polish (l3/polish/) runs on the text the C-family printer publishes and compiles,
// and NOT on the text the three decisions that read printed text measure: the return-tail bound,
// rank's tie-break and its duplicate collapse read the backend's DRAFT. These tests pin the seam.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { emitCFamily } from '../src/backend/cfamily';
import { pascalBackend } from '../src/backend/pascal';
import { T } from '../src/ir/types';
import { type SFn, emitDraft } from '../src/l3/ast';
import { compareScored, tieShape } from '../src/rank';

const fn: SFn = {
  name: 'f',
  params: [{ name: 'a0', type: T.int(32, true) }],
  locals: [],
  retType: T.int(32, true),
  body: [{ k: 'return', value: { k: 'var', name: 'a0' } }],
};

describe('the polish seam', () => {
  test("the C backend's draft is the C-family printer with the polish off", () => {
    expect(cBackend.draft!(fn)).toBe(emitCFamily('s32 f(s32 a0)', fn, undefined, true, false));
    expect(emitDraft(cBackend, fn)).toBe(cBackend.draft!(fn));
  });

  test('a tree that does not ask for the polish prints its draft', () => {
    const plain: SFn = {
      ...fn,
      body: [{ k: 'return', value: { k: 'bin', op: '&', l: { k: 'var', name: 'a0' }, r: { k: 'const', value: 64 } } }],
    };
    expect(cBackend.emit(plain)).toBe(cBackend.draft!(plain));
    expect(cBackend.emit({ ...plain, polish: true })).toContain('a0 & 0x40');
  });

  test('a backend with no polish drafts what it emits', () => {
    expect(pascalBackend.draft).toBeUndefined();
    expect(emitDraft(pascalBackend, fn)).toBe(pascalBackend.emit(fn));
  });

  test("compareScored breaks a score tie by the draft's counts, not the published text's", () => {
    type C = Parameters<typeof compareScored>[0];
    const base = { variations: [], preference: 0, score: { score: 0 } };
    // `a` publishes the shorter text, but its draft was the longer: the draft decides
    const a = { ...base, order: 0, source: 'x;\n', tie: tieShape('x;\ny;\nz;\n') };
    const b = { ...base, order: 1, source: 'x;\ny;\n', tie: tieShape('x;\ny;\n') };
    expect(compareScored(a as unknown as C, b as unknown as C)).toBeGreaterThan(0);
    // with no draft recorded, the published text is counted
    const { tie: _a, ...bareA } = a;
    const { tie: _b, ...bareB } = b;
    expect(compareScored(bareA as unknown as C, bareB as unknown as C)).toBeLessThan(0);
  });
});
