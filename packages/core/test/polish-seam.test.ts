// The readability polish (l3/polish/) is a print policy the caller picks by handing in a backend
// `polished` made: its `emit` prints the published, compiled text, and its `draft` the inner
// printer's, which the return-tail bound and rank's duplicate collapse read. These tests pin the seam.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { T } from '../src/ir/types';
import { type SFn, emitDraft } from '../src/l3/ast';
import { polishFactsOf, polished } from '../src/l3/polish';
import { compareScored } from '../src/rank';
import { targetFor } from '../src/target';

const fn: SFn = {
  name: 'f',
  params: [{ name: 'a0', type: T.int(32, true) }],
  locals: [],
  retType: T.int(32, true),
  body: [{ k: 'return', value: { k: 'bin', op: '&', l: { k: 'var', name: 'a0' }, r: { k: 'const', value: 64 } } }],
};

describe('the polish seam', () => {
  test("a polished backend's draft is the inner backend's emit", () => {
    const pc = polished(cBackend, { literal: false });
    expect(pc.emit(fn)).toContain('a0 & 0x40');
    expect(pc.draft!(fn)).toBe(cBackend.emit(fn));
    expect(emitDraft(pc, fn)).toBe(cBackend.emit(fn));
    expect(pc.id).toBe('c');
  });

  test('the core default backend prints the tree as structured', () => {
    expect(cBackend.emit(fn)).toContain('a0 & 64');
    expect(cBackend.draft).toBeUndefined();
    expect(emitDraft(cBackend, fn)).toBe(cBackend.emit(fn));
  });

  test('polishing twice is polishing once, and a backend with no polish is returned as it is', () => {
    const pc = polished(cBackend, { literal: false });
    const twice = polished(pc, { literal: true });
    expect(twice).toBe(pc);
    expect(polished(pascalBackend, { literal: false })).toBe(pascalBackend);
  });

  test('a target at -O0 is a literal level, at -O2 it is not', () => {
    expect(polishFactsOf(targetFor('agbcc', ['-O0']).target).literal).toBe(true);
    expect(polishFactsOf(targetFor('agbcc', ['-O2']).target).literal).toBe(false);
    expect(polishFactsOf(targetFor('ido7.1', ['-O1']).target).literal).toBe(true);
    expect(polishFactsOf(targetFor('mwcc_242_81', ['-O4,p']).target).literal).toBe(false);
  });

  test('compareScored breaks a score tie by the published text, the one the report counts', () => {
    type C = Parameters<typeof compareScored>[0];
    const base = { variations: [], preference: 0, score: { score: 0 } };
    const a = { ...base, order: 0, source: 'x;\ny;\n' };
    const b = { ...base, order: 1, source: 'x;\n' };
    expect(compareScored(a as unknown as C, b as unknown as C)).toBeGreaterThan(0);
  });
});
