// `bench run --only` and `bench fidelity --only` select real rows through `realCases`. After an
// upstream rename, `bench target Old` resolved the row (bench-schema resolveRow) while this filter
// matched `sym` alone and selected nothing, with no error. The manifest loader is stubbed so a
// renamed row can exist: no committed manifest carries an alias today.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/cases/manifests', () => ({
  loadManifests: () => [
    {
      project: 'kleod',
      toolchain: 'agbcc',
      functions: [
        { sym: 'EntityLookup', addr: '0x0803d140', aliases: ['sub_0803D140'], features: [], funcC: 'void f(void) {}' },
        { sym: 'Other', addr: '0x08000100', features: [], funcC: 'void g(void) {}' },
      ],
      vendored: () => ({ tuI: '', ctxI: '' }),
      ctxPath: () => '',
    },
  ],
}));

const { realCases } = await import('../src/cases/real');

describe('realCases --only answers to a former name', () => {
  it('selects the renamed row by its old name and by its new one, and nothing else', () => {
    expect(realCases({ only: 'sub_0803D140' }).map((c) => c.id)).toEqual(['kleod:EntityLookup:agbcc']);
    expect(realCases({ only: 'Lookup' }).map((c) => c.id)).toEqual(['kleod:EntityLookup:agbcc']);
    expect(realCases({ only: 'kleod' })).toEqual([]);
  });
});
