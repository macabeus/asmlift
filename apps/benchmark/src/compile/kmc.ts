// KMC GCC / MIPS (N64, Docker) — real-tier target build + candidate compile. The .i compiles
// inside the linux/386 container via the pooled helper score.ts uses (a one-shot shell command
// cannot express the container pool, so the harness strips this toolchain's decomp.yaml
// compiler — the registry built-in serves candidate scoring).
import { GCC_KMC_TOOLCHAIN, kmcCompile } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CPP } from '../config';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir, run } from './util';

/** .i → pooled docker KMC gcc → .o (same helper score.ts uses). */
function compile(dir: string, iName: string, oName: string): void {
  try {
    kmcCompile(dir, iName, oName);
  } catch (e) {
    throw new Error(`kmc gcc failed: ${compilerDiagnostics((e as Error).message)}`);
  }
}

function disasm(oPath: string): string {
  const dis = run(GCC_KMC_TOOLCHAIN.objdump, [...GCC_KMC_TOOLCHAIN.objdumpFlags, oPath]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${compilerDiagnostics(dis.stderr)}`);
  }
  return dis.stdout;
}

export const kmcReal: RealCompile = {
  buildTarget(iText): BuiltTarget {
    const dir = contentDir('gcc', iText);
    const iPath = join(dir, 'u.i'),
      oPath = join(dir, 'u.o');
    writeFileSync(iPath, iText);
    compile(dir, 'u.i', 'u.o');
    return { obj: oPath, asm: disasm(oPath) };
  },
  compileCandidate(tu, sym): string {
    // candidate scratch must live under /tmp (the container pool's mount)
    const dir = mkdtempSync(join('/tmp', 'bench-cand-'));
    const cPath = join(dir, 'c.c'),
      iPath = join(dir, 'c.i'),
      oPath = join(dir, 'c.o');
    writeFileSync(cPath, tu);
    const cpp = run(CPP, ['-P', '-nostdinc', cPath, '-o', iPath]);
    if (cpp.status !== 0) {
      throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
    }
    writeFileSync(iPath, stripPrototype(readFileSync(iPath, 'utf8'), sym));
    compile(dir, 'c.i', 'c.o');
    return oPath;
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const dir = mkdtempSync(join('/tmp', 'bench-vendor-'));
    const cPath = join(dir, 'u.c'),
      iPath = join(dir, 'u.i');
    writeFileSync(cPath, tu);
    const cpp = run(CPP, ['-P', ...cfg.cppIncludes, ...(cfg.defines ?? []), cPath, '-o', iPath], cfg.root);
    if (cpp.status !== 0) {
      throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
    }
    return readFileSync(iPath, 'utf8');
  },
};
