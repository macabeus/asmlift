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
import { MWCC_TOOLCHAIN_IDS, compilePpcTarget, ppcDockerAvailable } from '@asmlift/toolchains';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { cachedAsmDumpText } from '../src/cache';
import { unitCompileWrapper } from '../src/cases/dtk-project';
import { benchCheckoutsDir } from '../src/cases/manifests';
import { buildRealTarget, candidateLinkage, makeRealCompile, realCompilerFor } from '../src/compile/real';
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

test('…and it is the only C++ front end: every other toolchain refuses a c++ row', () => {
  // agbcc, IDO and the two GCCs implement the C parameters alone, so a c++ row would reach a
  // buildTarget that ignores the dialect and build a C object with an UNMANGLED symbol — which
  // scores, and publishes a number about a language the toolchain never read. No container: the
  // refusal happens while the case is built, before anything compiles.
  for (const id of ['agbcc', 'ido7.1', 'gcc2.7.2', 'gcc2.7.2kmc'] as const) {
    expect(() => makeRealCompile(id, [], '', '', 'c++'), id).toThrow(/has no C\+\+ front end/);
    expect(() => buildRealTarget(id, 'f', [], 'int f(void){return 0;}', 'c++'), id).toThrow(/has no C\+\+ front end/);
  }
  expect(() => makeRealCompile('agbcc', [], '', '', 'c')).not.toThrow();
});

// WHICH BINARY A ROW'S TOOLCHAIN ID ACTUALLY RUNS. Three CodeWarrior builds share one module, one
// container image and one set of flags; what separates them is the directory `mwccReal(id)` binds,
// and binding the wrong one produces a well-formed object that simply is not the ROM's. Nothing
// else in the suite can see that: the toolchain id travels with the row, the compile succeeds, and
// the only two ROM proofs are a checkout away (`mwcc-rom-proof.test.ts`) — one of them skipped on
// every machine, the other, on Mario Party 4's DOL code, byte-identical under two of the three
// builds by measurement. So the separation is asserted here, on a source chosen because all three
// builds disagree about it, with no checkout and no ROM.
const SEPARATOR = 'int sep(int x) { return x * 3 + (x >> 2); }\n';

describe.runIf(MWCC_TOOLCHAIN_IDS.every((id) => ppcDockerAvailable(id)))('each CodeWarrior build', () => {
  test(
    'is the binary its own toolchain id names — three ids, three different objects',
    () => {
      const digests = MWCC_TOOLCHAIN_IDS.map((id) => {
        const built = realCompilerFor(id).buildTarget(SEPARATOR, 'sep', CFLAGS, 'c');
        return createHash('sha256').update(readFileSync(built.obj)).digest('hex');
      });
      // Pairwise distinct, not pinned constants: what is being claimed is that the ids do not
      // collapse onto one binary, and a rebuilt container image may legitimately move all three.
      expect(new Set(digests).size).toBe(MWCC_TOOLCHAIN_IDS.length);
    },
    CONTAINER_BUDGET,
  );

  test(
    "publishes its object's data sections — the m2c normalizer's half of every row",
    () => {
      // `cache.ts` names all three in its dump table, and `cache-poison.test.ts` pins that list;
      // this is the same claim with the container attached, because what the table promises is a
      // dump and what a row needs is the dump's CONTENT. A build the table missed answered
      // `undefined`, which `evaluate` catches into a row published with no `asmDump` at all.
      for (const id of MWCC_TOOLCHAIN_IDS) {
        const built = realCompilerFor(id).buildTarget(SEPARATOR, 'sep', CFLAGS, 'c');
        const dump = cachedAsmDumpText(built.obj, id, 'sep');
        expect(dump, `${id} published no asmDump`).toBeDefined();
        expect(dump, `${id}'s dump names no section`).toContain('Contents of section');
      }
    },
    CONTAINER_BUDGET,
  );
});

describe.runIf(ppcDockerAvailable('mwcc_242_81'))('the CodeWarrior real tier', () => {
  test(
    'compiles a preprocessed unit verbatim — no typedef prelude in front of it',
    () => {
      const built = mwcc.buildTarget(TU, 'twice', CFLAGS, 'c');
      expect(statSync(built.obj).size).toBeGreaterThan(0);
      expect(built.asm).toContain('twice');
      // THE CONTROL, and the reason this module is not `compilePpcTarget`: the same text through the
      // synthetic tier's target build redefines `u8`.
      expect(() => compilePpcTarget('mwcc_242_81', TU, 'twice', CFLAGS)).toThrow(/mwcceppc/);
    },
    CONTAINER_BUDGET,
  );

  test(
    'compiles a candidate, and names the compiler in a failure instead of the container',
    () => {
      const obj = mwcc.compileCandidate(TU.replace('x + x', 'x * 2'), 'twice', CFLAGS, 'c');
      expect(statSync(obj).size).toBeGreaterThan(0);
      let message = '';
      try {
        mwcc.compileCandidate(TU.replace('x + x', 'x +'), 'twice', CFLAGS, 'c');
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

// ── a C++ row ──────────────────────────────────────────────────────────────────────────────
// A C++ target is keyed by a MANGLED symbol, and objdiff aligns a candidate to it by that exact
// string. Everything below is the measurement that decides how a candidate has to be compiled;
// each case is stated as the SYMBOL the object exports, because that is the only thing the scorer
// looks a candidate up by.
const VEC = 'struct Vec{int x;int y;int dot(Vec*o);};\n';
/** m2c's own `ppc-mwcc-c++` output shape: a C function NAMED by the mangled symbol, `this` and
 *  all. (Verified against the pinned m2c on this very function.) */
const AS_M2C_EMITS = `${VEC}int dot__3VecFP3Vec(Vec *thisp, Vec *o) { return thisp->x * o->x + thisp->y * o->y; }\n`;
/** asmlift's C++ backend shape: a real member definition, which mangles by itself. */
const AS_CPP_BACKEND = `${VEC}int Vec::dot(Vec * o) { return x * o->x + y * o->y; }\n`;

const exportedFunctions = (obj: string): string[] =>
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/386',
      '-v',
      `${dirname(obj)}:/w`,
      'asmlift-ppc',
      'sh',
      '-c',
      `powerpc-eabi-objdump -t /w/${basename(obj)}`,
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((l) => / F .*\.text\t/.test(l))
    .map((l) => l.trim().split(/\s+/).pop()!);

describe.runIf(ppcDockerAvailable('mwcc_242_81'))('a C++ row', () => {
  test(
    'compiles its candidates in the C++ dialect, whatever the scratch file is called',
    () => {
      // The candidate is always written as `c.c`, so the extension default would read a C++ row's
      // candidate as C. `-lang` decides it, and the dialects disagree on this source.
      expect(exportedFunctions(mwcc.compileCandidate(AS_CPP_BACKEND, 'dot__3VecFP3Vec', CFLAGS, 'c++'))).toEqual([
        'dot__3VecFP3Vec',
      ]);
      expect(() => mwcc.compileCandidate(AS_CPP_BACKEND, 'dot__3VecFP3Vec', CFLAGS, 'c')).toThrow(/mwcceppc failed/);
    },
    CONTAINER_BUDGET,
  );

  test(
    'needs C linkage on the candidate, because a C-shaped one mangles a SECOND time without it',
    () => {
      // THE DEFECT candidateLinkage exists for: m2c's output compiled as C++ exports a name the
      // target has none of, and the row would publish a noncompile about nothing.
      const bare = mwcc.compileCandidate(AS_M2C_EMITS, 'dot__3VecFP3Vec', CFLAGS, 'c++');
      expect(exportedFunctions(bare)).toEqual(['dot__3VecFP3Vec__FP3VecP3Vec']);

      // …and the linkage block restores it — for BOTH shapes, which is why it is one rule and not
      // a per-decompiler shim: mwcceppc gives a member function its normal mangling inside the
      // block, as the standard says a class member's language linkage is ignored.
      for (const shape of [AS_M2C_EMITS, AS_CPP_BACKEND]) {
        const wrapped = mwcc.compileCandidate(candidateLinkage('c++', shape), 'dot__3VecFP3Vec', CFLAGS, 'c++');
        expect(exportedFunctions(wrapped)).toEqual(['dot__3VecFP3Vec']);
      }
    },
    CONTAINER_BUDGET,
  );

  test(
    "falls back to plain C for a candidate the row's own dialect refuses — m2c names the receiver `this`",
    () => {
      // m2c's `ppc-mwcc-c++` target names the implicit receiver `this` on EVERY member function,
      // and `this` is a C++ keyword. Compiled in the row's own dialect that is a syntax error, and
      // m2c would go 0-for-42 on Pikmin for a spelling rather than for its code.
      // m2c self-declares a PLAIN struct — no member functions — exactly as it does on a real row.
      const POD = 'typedef struct Vec { int x; int y; } Vec;\n';
      const withThis = `${POD}int dot__3VecFP3Vec(Vec *this, Vec *o) { return this->x * o->x + this->y * o->y; }\n`;
      expect(() => mwcc.compileCandidate(candidateLinkage('c++', withThis), 'dot__3VecFP3Vec', CFLAGS, 'c++')).toThrow(
        /mwcceppc failed/,
      );

      // The ladder reaches it, and — the reason the fallback is sound rather than convenient — a C
      // compile exports the name the candidate is WRITTEN with, which on a C++ row is the mangled
      // symbol itself. No linkage block, and the same alignment key.
      const compile = makeRealCompile('mwcc_242_81', CFLAGS, '', '', 'c++');
      expect(exportedFunctions(compile(withThis, 'dot__3VecFP3Vec'))).toEqual(['dot__3VecFP3Vec']);

      // …and the two routes are the same OBJECT for a C-shaped body, which is what makes scoring
      // one against a C++-built target honest.
      const noThis = withThis.replaceAll('this->', 'self->').replace('Vec *this', 'Vec *self');
      const asCpp = mwcc.compileCandidate(candidateLinkage('c++', noThis), 'dot__3VecFP3Vec', CFLAGS, 'c++');
      const asC = mwcc.compileCandidate(candidateLinkage('c', noThis), 'dot__3VecFP3Vec', CFLAGS, 'c');
      expect(readFileSync(asCpp).equals(readFileSync(asC))).toBe(true);
    },
    CONTAINER_BUDGET,
  );

  test(
    "publishes the row's OWN front end's complaint when nothing compiles, not the fallback's",
    () => {
      // A row that compiles nowhere publishes this text as its `errorMarkers`. The fallback dialect
      // runs last, and a C++ candidate handed to the C parser dies on the word `class` — a
      // diagnostic about the harness's ladder, which would bury the one sentence describing the
      // decompiler's output. Same defect class as cache.ts's v17.
      const broken = `${VEC}int Vec::dot(Vec * o) { return x * o->x + undeclared_thing; }\n`;
      const compile = makeRealCompile('mwcc_242_81', CFLAGS, '', '', 'c++');
      let message = '';
      try {
        compile(broken, 'dot__3VecFP3Vec');
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/undeclared_thing/);
      expect(message).not.toMatch(/declaration syntax error/);
    },
    CONTAINER_BUDGET,
  );

  test('a C row keeps its candidate exactly as the decompiler wrote it', () => {
    expect(candidateLinkage('c', 'int f(void){return 0;}')).toBe('int f(void){return 0;}\n');
  });
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

describe.runIf(ppcDockerAvailable('mwcc_242_81') && existsSync(join(AC, 'build.ninja')))(
  "Animal Crossing's include tree",
  () => {
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
  },
);
