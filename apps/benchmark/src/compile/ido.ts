// IDO / MIPS (N64) — every harness-side spelling of "compile C with IDO": real-tier target
// build, real-tier candidate compile (shared cc step). Flags come from @asmlift/toolchains.
import { IDO_TOOLCHAIN } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CPP } from '../config';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir, run } from './util';

/** .i → IDO cc → .o. Shared by target and candidate. */
function compile(iPath: string, oPath: string): void {
  const cc = run(IDO_TOOLCHAIN.cc, [...IDO_TOOLCHAIN.ccFlags, '-o', oPath, iPath]);
  if (cc.status !== 0) {
    throw new Error(`ido cc failed: ${compilerDiagnostics(cc.stderr || cc.stdout)}`);
  }
}

function disasm(oPath: string): string {
  const dis = run(IDO_TOOLCHAIN.objdump, [...IDO_TOOLCHAIN.objdumpFlags, oPath]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${compilerDiagnostics(dis.stderr)}`);
  }
  return dis.stdout;
}

export const idoReal: RealCompile = {
  buildTarget(iText): BuiltTarget {
    const dir = contentDir('ido', iText);
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
    return readFileSync(iPath, 'utf8');
  },
};
