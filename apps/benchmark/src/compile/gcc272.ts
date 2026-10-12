// GCC 2.7.2 / MIPS (N64, Mario Party 3, Docker) — real-tier target build + candidate compile.
// A DIFFERENT flag convention from `gcc2.7.2kmc` (`-O1`, not `-O2`), but the same i386-Linux
// situation: the published binary is `decompals/mips-gcc-2.7.2`, so the .c/.i compiles inside a
// linux/386 container via the pooled helper (gcc272Compile) that score.ts also uses. The object
// is disassembled + scored with the native host binutils/objdiff.
import { type PreprocessorReport, cppReport, cppReportFlags } from '@asmlift/cli/candcache-reads';
import { scopedObjectPath } from '@asmlift/cli/elf-section';
import { GCC272_TOOLCHAIN, gcc272Compile, gcc272Native, gcc272PoolCfg } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { undeclaredCallees as hostUndeclaredCallees } from '../cases/implicit-declarations';
import { CPP } from '../config';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import { DOCKER_COMPILE_SOURCES, type DockerCacheSpec, dockerCachedBy, gccRefused } from './docker-cache';
import type { RealCompile, RealProjectCfg } from './types';
import { CPP_PREPROCESS_FLAGS, compilerDiagnostics, contentDir, restated, run } from './util';

/** .i → pooled docker GCC 2.7.2 at `cflags` → .o (same helper score.ts uses). */
function compile(dir: string, iName: string, oName: string, cflags: readonly string[]): void {
  try {
    gcc272Compile(dir, iName, oName, cflags);
  } catch (e) {
    throw restated('gcc 2.7.2', e);
  }
}

function disasm(oPath: string, sym: string): string {
  const dis = run(GCC272_TOOLCHAIN.objdump, [
    ...GCC272_TOOLCHAIN.objdumpFlags,
    scopedObjectPath(oPath, sym, dirname(oPath)),
  ]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${compilerDiagnostics(dis.stderr)}`);
  }
  return dis.stdout;
}

function compileCandidateRaw(
  tu: string,
  sym: string,
  cflags: readonly string[],
  seen: { report?: PreprocessorReport },
): string {
  // candidate scratch must live under /tmp (the container pool's mount) — and stays ONE
  // DIRECTORY PER CANDIDATE, leak and all: reusing a path the container reaches through
  // that shared mount fails ~30% of compiles with `c.o: No such file or directory`
  // (util.ts scratchSlot carries the measurement)
  const dir = mkdtempSync(join('/tmp', 'bench-cand-'));
  const cPath = join(dir, 'c.c'),
    iPath = join(dir, 'c.i'),
    dPath = join(dir, 'c.d'),
    oPath = join(dir, 'c.o');
  writeFileSync(cPath, tu);
  const cpp = run(CPP, [...CPP_PREPROCESS_FLAGS, ...cppReportFlags(dPath), cPath, '-o', iPath]);
  if (cpp.status !== 0) {
    throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
  }
  seen.report = cppReport(dPath, iPath, cPath);
  writeFileSync(iPath, stripPrototype(readFileSync(iPath, 'utf8'), sym));
  compile(dir, 'c.i', 'c.o', cflags);
  return oPath;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** The `specs` files GCC 2.7.2's driver reads, when they exist, after its own directory's: its
 *  built-in search prefixes. */
const HOST_SPECS = [
  '/opt/cross/lib/gcc-lib/mips-mips-gnu/2.7.2/specs',
  '/opt/cross/mips-mips-gnu/lib/mips-mips-gnu/2.7.2/specs',
  '/opt/cross/mips-mips-gnu/lib/specs',
  '/usr/lib/gcc/mips-mips-gnu/2.7.2/specs',
];
/** The candidate store's key for this pipeline at `cflags` (compile/docker-cache.ts). */
export const gcc272CacheSpec = (cflags: readonly string[]): DockerCacheSpec => ({
  label: 'bench-gcc272',
  native: gcc272Native,
  docker: GCC272_TOOLCHAIN.docker,
  image: GCC272_TOOLCHAIN.image,
  pool: gcc272PoolCfg().name,
  dirs: [GCC272_TOOLCHAIN.dir],
  words: [...CPP_PREPROCESS_FLAGS, ...cppReportFlags('c.d'), ...GCC272_TOOLCHAIN.harnessFlags, ...cflags],
  prelude: '',
  hostCommands: [CPP],
  sources: [join(HERE, 'gcc272.ts'), join(HERE, 'agbcc.ts'), ...DOCKER_COMPILE_SOURCES],
  hostFiles: HOST_SPECS,
  refused: gccRefused,
  gnuAs: true,
});
const cachedCandidate = dockerCachedBy(
  gcc272CacheSpec,
  (cflags: readonly string[]) => (tu, sym, seen) => compileCandidateRaw(tu, sym, cflags, seen),
);

export const gcc272Real: RealCompile = {
  undeclaredCallees: (tu) => hostUndeclaredCallees(tu),
  vendoredContext: (preprocessed) => preprocessed,
  buildTarget(iText, sym, cflags): BuiltTarget {
    const dir = contentDir('gcc272', cflags, iText);
    const oPath = join(dir, 'u.o');
    writeFileSync(join(dir, 'u.i'), iText);
    compile(dir, 'u.i', 'u.o', cflags);
    return { obj: oPath, asm: disasm(oPath, sym) };
  },
  compileCandidate(tu, sym, cflags): string {
    return cachedCandidate(cflags)(tu, sym);
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const dir = mkdtempSync(join('/tmp', 'bench-vendor-'));
    const cPath = join(dir, 'u.c'),
      iPath = join(dir, 'u.i');
    writeFileSync(cPath, tu);
    const cpp = run(CPP, ['-P', ...cfg.cppIncludes, ...(cfg.defines ?? []), cPath, '-o', iPath], { cwd: cfg.root });
    if (cpp.status !== 0) {
      throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
    }
    // marioparty3's include_asm.h emits top-level `asm(".include \"include/…inc\"")` for its
    // INCLUDE_ASM machinery. A standalone matched-function TU doesn't need them, and they would make
    // the vendored object need the project's `.inc` files at compile time — strip them so the .i is
    // self-contained (the whole point of vendoring).
    return readFileSync(iPath, 'utf8').replace(/^\s*(?:__asm__|asm)\s*\(\s*"\s*\.include[^\n]*\n/gm, '');
  },
};
