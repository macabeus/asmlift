// KMC GCC / MIPS (N64, Docker) — real-tier target build + candidate compile. The .i compiles
// inside the linux/386 container via the pooled helper score.ts uses (a one-shot shell command
// cannot express the container pool, so the harness strips this toolchain's decomp.yaml
// compiler — @asmlift/toolchains' compiler, bound at the row's flags, serves candidate scoring).
import { type PreprocessorReport, cppReport, cppReportFlags } from '@asmlift/cli/candcache-reads';
import { scopedObjectPath } from '@asmlift/cli/elf-section';
import { GCC_KMC_TOOLCHAIN, kmcCompile, kmcNative, kmcPoolCfg } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { undeclaredCallees as hostUndeclaredCallees } from '../cases/implicit-declarations';
import { CPP } from '../config';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import { type DockerCacheSpec, GCC_MIPS_HOST_SPECS, dockerCachedBy, dockerSources, gccRefused } from './docker-cache';
import type { RealCompile, RealProjectCfg } from './types';
import { CPP_PREPROCESS_FLAGS, compilerDiagnostics, contentDir, restated, run } from './util';

/** .i → pooled docker KMC gcc at `cflags` → .o (same helper score.ts uses). */
function compile(dir: string, iName: string, oName: string, cflags: readonly string[]): void {
  try {
    kmcCompile(dir, iName, oName, cflags);
  } catch (e) {
    throw restated('kmc gcc', e);
  }
}

function disasm(oPath: string, sym: string): string {
  const dis = run(GCC_KMC_TOOLCHAIN.objdump, [
    ...GCC_KMC_TOOLCHAIN.objdumpFlags,
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
const SOURCES = dockerSources(join(HERE, 'kmc.ts'), join(HERE, 'agbcc.ts'));
/** The candidate store's key for this pipeline at `cflags` (compile/docker-cache.ts). */
export const kmcCacheSpec = (cflags: readonly string[]): DockerCacheSpec => ({
  label: 'bench-kmc',
  native: kmcNative,
  docker: GCC_KMC_TOOLCHAIN.docker,
  image: GCC_KMC_TOOLCHAIN.image,
  pool: kmcPoolCfg().name,
  dirs: [GCC_KMC_TOOLCHAIN.dir],
  words: [...CPP_PREPROCESS_FLAGS, ...cppReportFlags('c.d'), ...GCC_KMC_TOOLCHAIN.harnessFlags, ...cflags],
  prelude: '',
  hostCommands: [CPP],
  sources: SOURCES,
  hostFiles: GCC_MIPS_HOST_SPECS,
  refused: gccRefused,
  gnuAs: true,
});
const cachedCandidate = dockerCachedBy(
  kmcCacheSpec,
  (cflags: readonly string[]) => (tu, sym, seen) => compileCandidateRaw(tu, sym, cflags, seen),
);

export const kmcReal: RealCompile = {
  undeclaredCallees: (tu) => hostUndeclaredCallees(tu),
  vendoredContext: (preprocessed) => preprocessed,
  buildTarget(iText, sym, cflags): BuiltTarget {
    const dir = contentDir('gcc', cflags, iText);
    const iPath = join(dir, 'u.i'),
      oPath = join(dir, 'u.o');
    writeFileSync(iPath, iText);
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
    return readFileSync(iPath, 'utf8');
  },
};
