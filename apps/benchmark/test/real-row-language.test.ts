// A REAL ROW'S LANGUAGE IS ITS UNIT'S, and the row reads it off the build's own flags.
//
// Every real row was `language: 'c'` because every real row was C. A GameCube project's rows are
// not: Pikmin compiles 442 of its 583 units as C++, and the field decides three things at once —
// m2c's `--target` dialect (`ppc-mwcc-c++`), the `-lang` word both compiles state, and whether a
// candidate needs C linkage to export the mangled symbol its target is keyed by. A row left at
// 'c' would run the C front end over C++ source and publish that as the decompiler's result.
//
// The manifest loader is stubbed: no committed manifest carries a C++ unit yet (GC-13's Pikmin
// rows are the first), and the wiring has to be pinned before the rows land on top of it.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/cases/manifests', () => ({
  loadManifests: () => [
    {
      project: 'pikmin',
      units: {
        // the tail of the flags `objdiff.json` gives a Pikmin game unit, `=` spelling
        'src/sysCommon/controller.cpp': { toolchain: 'mwcc_242_81', cflags: ['-O4,p', '-lang=c++'] },
        // …and a jaudio unit, which spells the same option with a space
        'src/jaudio/aramcall.c': { toolchain: 'mwcc_242_81', cflags: ['-O4,p', '-lang', 'c++'] },
        // …and Animal Crossing's shape, a C unit compiled by the same toolchain
        'src/static/m_house.c': { toolchain: 'mwcc_242_81', cflags: ['-O4,s', '-lang=c'] },
      },
      functions: [
        {
          sym: 'getMainStickX__10ControllerFv',
          addr: '0x80040a9c',
          unit: 'src/sysCommon/controller.cpp',
          features: [],
          funcC: 'f32 Controller::getMainStickX() { return mStickX; }',
        },
        {
          sym: 'aramCallBack',
          addr: '0x80100000',
          unit: 'src/jaudio/aramcall.c',
          features: [],
          funcC: 'void aramCallBack(void) {}',
        },
        {
          sym: 'mHouse_init',
          addr: '0x80200000',
          unit: 'src/static/m_house.c',
          features: [],
          funcC: 'void mHouse_init(void) {}',
        },
      ],
      vendored: () => ({ tuI: '', ctxI: '' }),
      ctxPath: () => '',
      symbolsFor: () => undefined,
    },
  ],
}));

const { realCases } = await import('../src/cases/real');

describe("a real row's language", () => {
  it('comes from the unit its build compiles it in, in either -lang spelling', () => {
    expect(Object.fromEntries(realCases().map((c) => [c.sym, c.language]))).toEqual({
      getMainStickX__10ControllerFv: 'c++',
      aramCallBack: 'c++',
      mHouse_init: 'c',
    });
  });
});
