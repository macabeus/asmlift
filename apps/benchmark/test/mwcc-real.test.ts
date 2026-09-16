// THE CODEWARRIOR REAL TIER (compile/mwcc.ts): the target build, the candidate compile and the
// vendor-time preprocessing of a GameCube project's include tree.
//
// What is worth pinning is exactly what makes this module different from the synthetic tier's
// `compilePpcTarget`, which compiles PowerPC perfectly well already:
//
//   - a real row's translation unit is compiled VERBATIM. The synthetic tier prepends `C_TYPEDEFS`,
//     and a project's own headers declare the same names — in C89 that is a duplicate typedef and
//     every row would be `noncompile` for a reason that has nothing to do with the decompiler.
//   - a project's headers are preprocessed by mwcceppc itself, under the wrapper the unit's own
//     build rule uses.
import { compilePpcTarget, ppcDockerAvailable } from '@asmlift/toolchains';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { unitCompileWrapper } from '../src/cases/dtk-project';
import { benchCheckoutsDir } from '../src/cases/manifests';
import { realCompilerFor } from '../src/compile/real';
import type { RealProjectCfg } from '../src/compile/types';
import { canonicalCodegen } from '../src/toolchains';

/** A compile in the container costs seconds, not milliseconds — and several of them on a loaded
 *  machine. Vitest's 5 s default would fail these for the machine's mood rather than for the code. */
const CONTAINER_BUDGET = 120_000;

const mwcc = realCompilerFor('mwcc_242_81');
const CFLAGS = canonicalCodegen('mwcc_242_81').cflags;

/** A translation unit shaped like a vendored one: it declares its own types, exactly as the
 *  project's preprocessed headers do — and it spells `u8` the way a GameCube project does
 *  (`-char unsigned`, so a plain `char`), which is NOT `C_TYPEDEFS`'s `unsigned char`. Two
 *  different definitions of one name is the C89 error a prelude in front of a project unit causes. */
const TU = ['typedef char u8;', 'u8 twice(u8 x) {', '  return (u8)(x + x);', '}', ''].join('\n');

test('the real tier is wired for CodeWarrior', () => {
  // The dispatch table is exhaustive over `ToolchainId`, so this is the runtime half of a fact tsc
  // already holds: every toolchain a row can name has a compile module.
  expect(typeof mwcc.buildTarget).toBe('function');
  expect(typeof mwcc.preprocess).toBe('function');
});

describe.runIf(ppcDockerAvailable())('the CodeWarrior real tier', () => {
  test(
    'compiles a preprocessed unit verbatim — no typedef prelude in front of it',
    () => {
      const built = mwcc.buildTarget(TU, 'twice', CFLAGS);
      expect(statSync(built.obj).size).toBeGreaterThan(0);
      expect(built.asm).toContain('twice');
      // THE CONTROL, and the reason this module is not `compilePpcTarget`: the same text through the
      // synthetic tier's target build redefines `u8`.
      expect(() => compilePpcTarget(TU, 'twice', CFLAGS)).toThrow(/mwcceppc/);
    },
    CONTAINER_BUDGET,
  );

  test(
    'compiles a candidate, and names the compiler in a failure instead of the container',
    () => {
      const obj = mwcc.compileCandidate(TU.replace('x + x', 'x * 2'), 'twice', CFLAGS);
      expect(statSync(obj).size).toBeGreaterThan(0);
      let message = '';
      try {
        mwcc.compileCandidate(TU.replace('x + x', 'x +'), 'twice', CFLAGS);
      } catch (e) {
        message = (e as Error).message;
      }
      // The COMPILER is named and its own words come back; the container is not the story a row's
      // error markers should tell.
      expect(message).toMatch(/^mwcceppc failed: /);
      expect(message).toMatch(/error/i);
      expect(message).not.toMatch(/docker/i);
    },
    CONTAINER_BUDGET,
  );
});

// The include tree of a REAL project, which is the thing a host `cpp` cannot read. Gated on the
// checkout as well as on Docker: `bench setup` materializes it, and CI has neither.
const AC = join(benchCheckoutsDir(), 'ac-decomp');
const AC_CFG: RealProjectCfg = {
  project: 'ac-decomp',
  toolchain: 'mwcc_242_81',
  root: AC,
  unit: 'src/static/GBA2/JoyBoot.c',
  // the tail of the flags objdiff.json says this unit's build compiles it at
  cflags: ['-O4,s', '-sdata', '0', '-sdata2', '0', '-inline', 'on', '-lang=c'],
  cppIncludes: [
    '-nosyspath',
    '-i',
    'include',
    '-i',
    'include/dolphin',
    '-i',
    'include/libc',
    '-i',
    'src/static/dolphin',
    '-i',
    'build/GAFE01_00/include',
  ],
  headers: ['GBA2/gba2.h'],
  defines: ['-DVERSION=0', '-DDEBUG=0', '-DNDEBUG', '-d', '_LANGUAGE_C', '-d', 'F3DEX_GBI_2', '-d', 'MUST_MATCH'],
};

describe.runIf(ppcDockerAvailable() && existsSync(join(AC, 'build.ninja')))("Animal Crossing's include tree", () => {
  test(
    'preprocesses through the compiler that wrote it, carrying no machine path',
    () => {
      const text = mwcc.preprocess(AC_CFG, '#include "GBA2/gba2.h"\nint f(void) { return GBA2_GBA_STATE_ERROR; }\n');
      // a declaration only this project's headers hold, so the include tree really was read
      expect(text).toContain('GBAGetStatus');
      // …and nothing of THIS machine: a vendored blob is committed
      expect(text).not.toMatch(/\/Users\/|\/home\/|\/private\/var\//);
      expect(text).not.toContain('#line');
    },
    CONTAINER_BUDGET,
  );

  test(
    "preprocesses a unit in the LANGUAGE its build compiles it in, not the one the blob's name implies",
    () => {
      // Every vendored TU is written as `u.c`, so mwcc's extension default would read all 4,103 of
      // Animal Crossing's units as C — including the 116 its build compiles with `-lang=c++`, whose
      // headers would then take the wrong `#ifdef __cplusplus` branch and vendor a blob the project
      // never compiled. The claim is checked on ONE header both ways, so the C++ answer cannot be
      // the C one misread.
      const src = '#include "m_house.h"\nint f(void) { return 0; }\n';
      const asCpp = mwcc.preprocess({ ...AC_CFG, unit: 'src/static/jsyswrap.cpp', cflags: ['-lang=c++'] }, src);
      expect(asCpp).toContain('extern "C"');
      expect(mwcc.preprocess(AC_CFG, src)).not.toContain('extern "C"');
    },
    CONTAINER_BUDGET,
  );

  test("uses the wrapper the unit's own rule uses — every Animal Crossing edge has one", () => {
    // If this stops holding, the preprocessing above stops being what the project compiled, and
    // the assertion that catches it is this one rather than a silent difference in the blob.
    expect(unitCompileWrapper(AC, AC_CFG.unit, 'mwcceppc.exe')).toEqual(['build/tools/sjiswrap.exe']);
  });
});
