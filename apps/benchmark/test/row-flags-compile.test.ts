// A ROW'S FLAGS REACH EVERY NON-AGBCC COMPILE. The IDO, KMC GCC and GCC 2.7.2 real-tier modules
// compile a target and a candidate at the flags the row hands them, and the pooled toolchains'
// candidate compiler is bound at the row's flags rather than held at canonical ones. Every compiler
// call is intercepted, so no toolchain runs: what is asserted is the argv each step would run.
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { IDO_TOOLCHAIN } from '@asmlift/toolchains';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  run: [] as { cmd: string; args: string[] }[],
  pooledCompile: [] as { compiler: string; flags: readonly string[] }[],
  pooledBind: [] as { compiler: string; flags: readonly string[] }[],
}));

// Every step "succeeds" and writes what it names after `-o`, so the module's next step finds a file.
vi.mock('../src/compile/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/compile/util')>();
  const { writeFileSync } = await import('node:fs');
  return {
    ...actual,
    run: (cmd: string, args: string[]) => {
      seen.run.push({ cmd, args });
      const out = args.indexOf('-o');
      if (out >= 0) {
        writeFileSync(args[out + 1], 'int f(void) { return 0; }\n');
      }
      return { status: 0, stdout: 'disassembly', stderr: '', signal: null };
    },
  };
});

vi.mock('@asmlift/toolchains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@asmlift/toolchains')>();
  const compileAt = (compiler: string) => (_dir: string, _src: string, _obj: string, flags: readonly string[]) => {
    seen.pooledCompile.push({ compiler, flags });
  };
  const bindAt = (compiler: string) => (flags: readonly string[]) => {
    seen.pooledBind.push({ compiler, flags });
    return () => '/nonexistent.o';
  };
  return {
    ...actual,
    kmcCompile: compileAt('kmc'),
    gcc272Compile: compileAt('gcc272'),
    kmcCandidateCompiler: bindAt('kmc'),
    // CodeWarrior's binds in two steps — the BUILD, then the row's flags — so the recorded
    // compiler name carries the build the pool would mount.
    mwccCandidateCompiler: (mwcc: string) => bindAt(`mwcc:${mwcc}`),
  };
});

const { idoReal } = await import('../src/compile/ido');
const { kmcReal } = await import('../src/compile/kmc');
const { gcc272Real } = await import('../src/compile/gcc272');
const { benchCompilerFor } = await import('../src/decomp-config');

/** A toolchain's canonical flags at another optimisation level: a set no constant in the harness spells. */
const atAnotherLevel = (flags: readonly string[]): string[] =>
  flags.map((w) => (/^-O\d$/.test(w) ? (w === '-O1' ? '-O2' : '-O1') : w));

const TU = 'int f(void) { return 0; }\n';

describe("the real tier's non-agbcc modules compile at the row's flags", () => {
  test('IDO: the target and the candidate cc argv carry them', () => {
    const flags = atAnotherLevel(TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags);
    seen.run.length = 0;
    const { obj } = idoReal.buildTarget(TU, 'f', flags);
    const candidate = idoReal.compileCandidate(TU, 'f', flags);
    const cc = seen.run.filter((r) => r.cmd === IDO_TOOLCHAIN.cc).map((r) => r.args);
    expect(cc).toEqual([
      [...IDO_TOOLCHAIN.harnessFlags, ...flags, '-o', obj, join(obj, '..', 'u.i')],
      [...IDO_TOOLCHAIN.harnessFlags, ...flags, '-o', candidate, join(candidate, '..', 'c.i')],
    ]);
  });

  test.each([
    ['KMC GCC', 'kmc', kmcReal, TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags],
    ['GCC 2.7.2', 'gcc272', gcc272Real, TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags],
  ] as const)(
    '%s: the pooled compile of the target and the candidate receives them',
    (_name, compiler, real, canonical) => {
      const flags = atAnotherLevel(canonical);
      expect(flags).not.toEqual([...canonical]);
      seen.pooledCompile.length = 0;
      real.buildTarget(TU, 'f', flags);
      real.compileCandidate(TU, 'f', flags);
      expect(seen.pooledCompile).toEqual([
        { compiler, flags },
        { compiler, flags },
      ]);
    },
  );

  test('two flag sets of one TU build in two reference directories', () => {
    const canonical = TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags;
    expect(idoReal.buildTarget(TU, 'f', atAnotherLevel(canonical)).obj).not.toBe(
      idoReal.buildTarget(TU, 'f', canonical).obj,
    );
  });
});

describe("the pooled toolchains' candidate compiler is bound at the row's flags", () => {
  test.each([
    ['gcc2.7.2kmc', 'kmc'],
    ['mwcc_242_81', 'mwcc:mwcc_242_81'],
  ] as const)('%s', (id, compiler) => {
    const flags = atAnotherLevel(TOOLCHAIN_TARGETS[id].canonicalFlags);
    seen.pooledBind.length = 0;
    benchCompilerFor(id, flags);
    expect(seen.pooledBind).toEqual([{ compiler, flags }]);
  });
});
