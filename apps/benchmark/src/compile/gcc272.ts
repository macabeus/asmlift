// Mainline GCC 2.7.2 / MIPS (N64, Mario Party 3) — real-tier target build + candidate compile.
// Runs NATIVELY (the binary is on this host, unlike KMC's Docker path): the `-B <dir>/` +
// `COMPILER_PATH=<dir>` let the old driver find its bundled `cc1`/`as`. Flags come from
// @asmlift/toolchains. A DIFFERENT compiler from `gcc2.7.2kmc` — plain FSF GCC 2.7.2 at `-O1`.
import { GCC272_TOOLCHAIN } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CPP } from '../config';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir, run } from './util';

/** .i → GCC 2.7.2 cc → .o. Shared by target and candidate. */
function compile(iPath: string, oPath: string): void {
  const { dir, ccFlags } = GCC272_TOOLCHAIN;
  const cc = run(join(dir, 'gcc'), ['-B', `${dir}/`, ...ccFlags, '-o', oPath, iPath], undefined, {
    COMPILER_PATH: dir,
  });
  if (cc.status !== 0) {
    throw new Error(`gcc 2.7.2 failed: ${compilerDiagnostics(cc.stderr || cc.stdout)}`);
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
    const iPath = join(dir, 'u.i'),
      oPath = join(dir, 'u.o');
    writeFileSync(iPath, iText);
    compile(iPath, oPath);
    return { obj: oPath, asm: disasm(oPath) };
  },
  compileCandidate(tu, sym): string {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cand-'));
    const cPath = join(dir, 'c.c'),
      iPath = join(dir, 'c.i'),
      oPath = join(dir, 'c.o');
    writeFileSync(cPath, tu);
    const cpp = run(CPP, ['-P', '-nostdinc', cPath, '-o', iPath]);
    if (cpp.status !== 0) {
      throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
    }
    writeFileSync(iPath, stripPrototype(readFileSync(iPath, 'utf8'), sym));
    compile(iPath, oPath);
    return oPath;
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'bench-vendor-'));
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
