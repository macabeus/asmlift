// GCC 2.7.2 / MIPS (N64, Mario Party 3, Docker) — real-tier target build + candidate compile.
// A DIFFERENT flag convention from `gcc2.7.2kmc` (`-O1`, not `-O2`), but the same i386-Linux
// situation: the published binary is `decompals/mips-gcc-2.7.2`, so the .c/.i compiles inside a
// linux/386 container via the pooled helper (gcc272Compile) that score.ts also uses. The object
// is disassembled + scored with the native host binutils/objdiff.
import { GCC272_TOOLCHAIN, gcc272Compile } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CPP } from '../config';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir, run } from './util';

/** .i → pooled docker GCC 2.7.2 → .o (same helper score.ts uses). */
function compile(dir: string, iName: string, oName: string): void {
  try {
    gcc272Compile(dir, iName, oName);
  } catch (e) {
    throw new Error(`gcc 2.7.2 failed: ${compilerDiagnostics((e as Error).message)}`);
  }
}

function disasm(oPath: string): string {
  const dis = run(GCC272_TOOLCHAIN.objdump, [...GCC272_TOOLCHAIN.objdumpFlags, oPath]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${compilerDiagnostics(dis.stderr)}`);
  }
  return dis.stdout;
}

export const gcc272Real: RealCompile = {
  buildTarget(iText): BuiltTarget {
    const dir = contentDir('gcc272', iText);
    const oPath = join(dir, 'u.o');
    writeFileSync(join(dir, 'u.i'), iText);
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
    // marioparty3's include_asm.h emits top-level `asm(".include \"include/…inc\"")` for its
    // INCLUDE_ASM machinery. A standalone matched-function TU doesn't need them, and they would make
    // the vendored object need the project's `.inc` files at compile time — strip them so the .i is
    // self-contained (the whole point of vendoring).
    return readFileSync(iPath, 'utf8').replace(/^\s*(?:__asm__|asm)\s*\(\s*"\s*\.include[^\n]*\n/gm, '');
  },
};
