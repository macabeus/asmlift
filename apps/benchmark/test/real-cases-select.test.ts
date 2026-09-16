// `bench run --only` and `bench fidelity --only` select real rows through `realCases`. After an
// upstream rename, `bench target Old` resolved the row (bench-schema resolveRow) while this filter
// matched `sym` alone and selected nothing, with no error. The manifest loader is stubbed so a
// renamed row can exist: no committed manifest carries an alias today.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/cases/manifests', () => ({
  loadManifests: () => [
    {
      project: 'kleod',
      units: {
        'src/entity.c': {
          toolchain: 'agbcc',
          cflags: ['-mthumb-interwork', '-O2', '-fhex-asm', '-g', '-fprologue-bugfix'],
          flagsFrom: {
            from: 'makefile',
            commit: 'a'.repeat(40),
            file: 'Makefile',
            sha256: 'b'.repeat(64),
            command: 'agbcc -mthumb-interwork -O2 -fhex-asm -g -fprologue-bugfix -o entity.s -',
          },
        },
      },
      functions: [
        {
          sym: 'EntityLookup',
          addr: '0x0803d140',
          unit: 'src/entity.c',
          aliases: ['sub_0803D140'],
          features: [],
          funcC: 'void f(void) {}',
        },
        { sym: 'Other', addr: '0x08000100', unit: 'src/entity.c', features: [], funcC: 'void g(void) {}' },
      ],
      vendored: () => ({ tuI: '', ctxI: '' }),
      ctxPath: () => '',
      symbolsFor: () => undefined,
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
