// IDO / MIPS (N64) — every harness-side spelling of "compile C with IDO": real-tier target
// build, real-tier candidate compile (shared cc step). Every compile passes the harness words from
// @asmlift/toolchains, then the row's codegen flags.
import { scopedObjectPath } from '@asmlift/cli/elf-section';
import { IDO_TOOLCHAIN } from '@asmlift/toolchains';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { undeclaredCallees as hostUndeclaredCallees } from '../cases/implicit-declarations';
import { CPP } from '../config';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import type { RealCompile, RealProjectCfg } from './types';
import { CPP_PREPROCESS_FLAGS, compilerDiagnostics, contentDir, run, scratchSlot } from './util';

/** .i → IDO cc at `cflags` → .o. Shared by target and candidate. */
function compile(iPath: string, oPath: string, cflags: readonly string[]): void {
  const cc = run(IDO_TOOLCHAIN.cc, [...IDO_TOOLCHAIN.harnessFlags, ...cflags, '-o', oPath, iPath]);
  if (cc.status !== 0) {
    throw new Error(`ido cc failed: ${compilerDiagnostics(cc.stderr || cc.stdout)}`);
  }
}

function disasm(oPath: string, sym: string): string {
  const dis = run(IDO_TOOLCHAIN.objdump, [...IDO_TOOLCHAIN.objdumpFlags, scopedObjectPath(oPath, sym, dirname(oPath))]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${compilerDiagnostics(dis.stderr)}`);
  }
  return dis.stdout;
}

// One scratch dir each, reused per compile (util.ts scratchSlot) instead of one mkdtemp per
// candidate.
const candScratch = scratchSlot('bench-cand-');
const vendorScratch = scratchSlot('bench-vendor-');

export const idoReal: RealCompile = {
  undeclaredCallees: (tu) => hostUndeclaredCallees(tu),
  buildTarget(iText, sym, cflags): BuiltTarget {
    const dir = contentDir('ido', cflags, iText);
    const iPath = join(dir, 'u.i'),
      oPath = join(dir, 'u.o');
    writeFileSync(iPath, iText);
    compile(iPath, oPath, cflags);
    return { obj: oPath, asm: disasm(oPath, sym) };
  },
  compileCandidate(tu, sym, cflags): string {
    const dir = candScratch();
    const cPath = join(dir, 'c.c'),
      iPath = join(dir, 'c.i'),
      oPath = join(dir, 'c.o');
    writeFileSync(cPath, tu);
    const cpp = run(CPP, [...CPP_PREPROCESS_FLAGS, cPath, '-o', iPath]);
    if (cpp.status !== 0) {
      throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
    }
    writeFileSync(iPath, stripPrototype(readFileSync(iPath, 'utf8'), sym));
    compile(iPath, oPath, cflags);
    return oPath;
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const dir = vendorScratch();
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
