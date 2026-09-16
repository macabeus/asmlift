// A real manifest's build units: every row names the unit its permalink cites, every unit carries flags its
// compiler family parses, in normal form, the ones its recorded recipe line compiles with, and every row carries the digest
// `bench vendor` proved against the ROM. The authoring loader lets the fields `bench flags --write` and
// `bench vendor` write be absent; the runtime loader does not.
import { describe, expect, test } from 'vitest';

import { type BuildUnit, type RealManifest, validateManifest } from '../src/cases/manifests';

const UNIT: BuildUnit = {
  toolchain: 'agbcc',
  cflags: ['-mthumb-interwork', '-O2', '-fhex-asm', '-g'],
  flagsFrom: {
    from: 'makefile',
    commit: 'a'.repeat(40),
    file: 'Makefile',
    sha256: 'b'.repeat(64),
    command: 'tools/agbcc/bin/agbcc <src/f.c -o build/f.s -mthumb-interwork -Wimplicit -O2 -fhex-asm -g',
  },
};

const manifest = (over: Partial<RealManifest> = {}, row: Record<string, unknown> = {}): RealManifest =>
  ({
    project: 'fakeproj',
    repoDir: 'fakeproj',
    repo: 'macabeus/fakeproj',
    branch: 'asmlift-benchmark',
    tu: 'assembled',
    cppIncludes: [],
    headers: [],
    units: { 'src/f.c': UNIT },
    functions: [
      {
        sym: 'f',
        addr: '0x08000000',
        unit: 'src/f.c',
        romDigest: 'c'.repeat(64),
        features: [],
        funcC: 'int f(void) { return 1; }',
        sourceUrl: 'https://github.com/macabeus/fakeproj/blob/0123456/src/f.c#L1-L1',
        ...row,
      },
    ],
    ...over,
  }) as RealManifest;

const problems = (m: RealManifest, complete = true) => validateManifest(m, 'x.json', { complete }).join('\n');

describe('validateManifest: build units', () => {
  test('a complete manifest validates', () => {
    expect(problems(manifest())).toBe('');
  });

  test("a row's unit is the file its sourceUrl cites", () => {
    expect(problems(manifest({ units: { 'src/g.c': UNIT } }, { unit: 'src/g.c' }))).toMatch(
      /"unit" "src\/g.c" is not the file its sourceUrl cites/,
    );
  });

  test('a row citing a part its unit includes may name that unit, and a row citing a source file may not', () => {
    const inc = 'https://github.com/macabeus/fakeproj/blob/0123456/src/f_move.c_inc#L1-L1';
    expect(problems(manifest({}, { sourceUrl: inc }))).toBe('');
    expect(problems(manifest({ units: { 'src/g.c': UNIT } }, { unit: 'src/g.c' }))).toMatch(
      /is not the file its sourceUrl cites/,
    );
  });

  test('a unit no row names is refused', () => {
    expect(problems(manifest({ units: { 'src/f.c': UNIT, 'src/old.c': UNIT } }))).toMatch(
      /unit src\/old.c is named by no row/,
    );
  });

  test("a unit's flags parse, and are in normal form", () => {
    expect(problems(manifest({ units: { 'src/f.c': { ...UNIT, cflags: ['-O4,p'] } } }))).toMatch(
      /-O4,p is not an optimisation level agbcc accepts; mwcc spells its levels that way/,
    );
    expect(problems(manifest({ units: { 'src/f.c': { ...UNIT, cflags: ['-O2', '-Wimplicit'] } } }))).toMatch(
      /"cflags" are not in normal form: -O2$/m,
    );
    expect(problems(manifest({ units: { 'src/f.c': { ...UNIT, cflags: [] } } }))).toMatch(/"cflags" must be/);
  });

  test("a unit's flagsFrom names its build file at a full commit", () => {
    for (const flagsFrom of [
      { ...UNIT.flagsFrom, commit: 'a069e81b' },
      { ...UNIT.flagsFrom, sha256: 'x' },
      { from: 'harness' },
      { from: 'objdiff', commit: 'a'.repeat(40), file: 'objdiff.json', sha256: 'b'.repeat(64), command: 'cc1' },
    ]) {
      expect(
        problems(manifest({ units: { 'src/f.c': { ...UNIT, flagsFrom } as BuildUnit } })),
        JSON.stringify(flagsFrom),
      ).toMatch(/"flagsFrom" must be/);
    }
  });

  test('an unknown toolchain is refused', () => {
    expect(
      problems(manifest({ units: { 'src/f.c': { ...UNIT, toolchain: 'gcc9' } as unknown as BuildUnit } })),
    ).toMatch(/unit src\/f.c has unknown toolchain "gcc9"/);
  });

  test("a unit's flags are the ones its recipe line compiles with", () => {
    const withoutG = { ...UNIT, cflags: ['-mthumb-interwork', '-O2', '-fhex-asm'] };
    expect(problems(manifest({ units: { 'src/f.c': withoutG } }))).toMatch(
      /unit src\/f.c "cflags" are not the flags its flagsFrom.command compiles with: -mthumb-interwork -O2 -fhex-asm -g/,
    );
    const noCompiler = { ...UNIT, flagsFrom: { ...UNIT.flagsFrom, command: 'echo -O2' } };
    expect(problems(manifest({ units: { 'src/f.c': noCompiler } }))).toMatch(
      /"flagsFrom.command" runs no agbcc compiler/,
    );
  });

  test('a romDigest is a sha256', () => {
    expect(problems(manifest({}, { romDigest: 'C'.repeat(64) }))).toMatch(/"romDigest" must be a sha256/);
  });

  test('what `bench flags --write` and `bench vendor` write may be absent while authoring, and only then', () => {
    const authoring = manifest({ units: {} }, { unit: undefined, romDigest: undefined });
    expect(problems(authoring, false)).toBe('');
    const runtime = problems(authoring);
    expect(runtime).toMatch(/"units" must name every build unit/);
    expect(runtime).toMatch(/names no "unit" — run `pnpm bench flags --project fakeproj --write`/);
    expect(runtime).toMatch(/has no "romDigest" — run `pnpm bench vendor --project fakeproj`/);
    expect(problems(manifest({ units: {} }, { romDigest: undefined }))).toMatch(/src\/f.c has no flags in "units"/);
    // present, it is still checked
    expect(problems(manifest({}, { romDigest: 'x' }), false)).toMatch(/"romDigest" must be a sha256/);
  });
});

describe('validateManifest: a C++ row and m2c', () => {
  const CPP_UNIT: BuildUnit = {
    ...UNIT,
    toolchain: 'mwcc_242_81',
    cflags: ['-O4,p', '-lang=c++'],
    flagsFrom: {
      from: 'objdiff',
      commit: 'a'.repeat(40),
      file: 'objdiff.json',
      sha256: 'b'.repeat(64),
      unit: 'main/f',
    },
  };
  const cppRow = (row: Record<string, unknown> = {}) =>
    manifest(
      { units: { 'src/f.cpp': CPP_UNIT } },
      {
        unit: 'src/f.cpp',
        sourceUrl: 'https://github.com/macabeus/fakeproj/blob/0123456/src/f.cpp#L1-L1',
        ...row,
      },
    );

  // m2c's `--context` parser is pycparser: a C++ unit's vendored context is not degraded input,
  // it is a hard failure, and the row would publish `m2c=failed` for a harness decision.
  test('a c++ row cannot inherit the vendored C++ context', () => {
    expect(problems(cppRow({ m2cCtx: true }))).toMatch(
      /sets "m2cCtx" on a c\+\+ unit — m2c's context parser is C-only/,
    );
  });

  test('…and is fine with a hand-written context, or with none', () => {
    expect(problems(cppRow())).toBe('');
    expect(problems(cppRow({ ctx: 'struct Controller;' }))).toBe('');
  });

  // The rule is about the unit's DIALECT, never about the toolchain or the file name: the same
  // CodeWarrior toolchain builds Animal Crossing's 3,984 C units.
  test('a C unit of the same toolchain keeps the vendored context', () => {
    expect(
      problems(manifest({ units: { 'src/f.c': { ...CPP_UNIT, cflags: ['-O4,s', '-lang=c'] } } }, { m2cCtx: true })),
    ).toBe('');
  });

  // CodeWarrior is the only C++ front end here. On any other toolchain a c++ unit builds a C
  // object with an UNMANGLED symbol and publishes a number about a language the compiler never
  // read — compile/real.ts refuses the pairing, but only by toolchain and only once a case is
  // being constructed, which names neither the project nor the unit.
  test('a c++ unit needs a CodeWarrior toolchain, and the manifest says which unit', () => {
    expect(problems(manifest({ units: { 'src/f.c': { ...UNIT, cflags: [...UNIT.cflags, '-lang=c++'] } } }))).toMatch(
      /unit src\/f.c is C\+\+, and agbcc has no C\+\+ front end/,
    );
    // …and the extension alone is enough, because that is what the front end itself would read.
    expect(
      problems(
        manifest(
          { units: { 'src/f.cpp': UNIT } },
          { unit: 'src/f.cpp', sourceUrl: 'https://github.com/macabeus/fakeproj/blob/0123456/src/f.cpp#L1-L1' },
        ),
      ),
    ).toMatch(/unit src\/f.cpp is C\+\+, and agbcc has no C\+\+ front end/);
  });
});
