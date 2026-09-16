// WHICH map each row is handed, at the one place that chooses: `realCases` (cases/real.ts) asks
// the manifest for `symbolsFor(moduleOf(addr))`.
//
// `vendoredSymbols` already refuses to serve a REL row the base ELF's map when the module's is
// missing. That refusal is worth nothing if the CALLER never asks for the module — a row would be
// read with the base map, quietly, and publish different source under a row that looks like every
// other one. So the choice is pinned here, separately from the refusal: the manifest records which
// module it was asked for.
import { describe, expect, it, vi } from 'vitest';

const asked: (string | undefined)[] = [];
const map = (name: string) => new Map([[0x1000, [{ name, kind: 'code' as const, address: 0x1000 }]]]);

vi.mock('../src/cases/manifests', () => ({
  loadManifests: () => [
    {
      project: 'marioparty4',
      units: {
        'src/m416Dll/objects.c': {
          toolchain: 'agbcc',
          cflags: ['-O2'],
          flagsFrom: {
            from: 'makefile',
            commit: 'a'.repeat(40),
            file: 'Makefile',
            sha256: 'b'.repeat(64),
            command: 'agbcc -O2 -o objects.s -',
          },
        },
      },
      functions: [
        {
          sym: 'HuDvdErrWait',
          addr: '0x801d3a04',
          unit: 'src/m416Dll/objects.c',
          features: [],
          funcC: 'void f(void) {}',
        },
        {
          sym: 'ObjectSetup',
          addr: 'm416Dll:.text+0x00001f20',
          unit: 'src/m416Dll/objects.c',
          features: [],
          funcC: 'void g(void) {}',
        },
      ],
      vendored: () => ({ tuI: '', ctxI: '' }),
      ctxPath: () => '',
      symbolsFor: (module: string | undefined) => {
        asked.push(module);
        return map(module ?? 'BASE');
      },
    },
  ],
}));

const { realCases } = await import('../src/cases/real');

describe('the map realCases hands a row', () => {
  it("asks for the row's own module, and for no module at a linked address", () => {
    const cases = realCases();
    expect(asked).toEqual([undefined, 'm416Dll']);
    // and the row really carries what that answer returned, so a wrong ask is a wrong map
    const named = (i: number) => [...cases[i].symbols!.values()].flat().map((s) => s.name);
    expect(named(0)).toEqual(['BASE']);
    expect(named(1)).toEqual(['m416Dll']);
  });
});
