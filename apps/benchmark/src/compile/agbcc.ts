// agbcc / ARM (GBA) — EVERY harness-side spelling of "compile C with agbcc": the real-tier
// target build, the real-tier candidate compile (same steps, shared). Flags come from
// @asmlift/toolchains; the decomp.yaml candidate command lives in
// dataset/toolchains/agbcc-arm/decomp.yaml.
import { TOOLCHAIN } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuiltTarget } from '../toolchains';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir, run } from './util';

/** .i → agbcc → .s (asmlift ARM input) with the canonical .text/.align tail → as → .o. */
function assemble(iPath: string, sPath: string, oPath: string): void {
  const cc = run(TOOLCHAIN.agbcc, [iPath, '-o', sPath, ...TOOLCHAIN.agbccFlags]);
  if (cc.status !== 0) {
    throw new Error(`agbcc failed: ${compilerDiagnostics(cc.stderr)}`);
  }
  writeFileSync(sPath, readFileSync(sPath, 'utf8') + '\n.text\n\t.align\t2, 0\n');
  const as = run(TOOLCHAIN.as, [...TOOLCHAIN.asFlags, sPath, '-o', oPath]);
  if (as.status !== 0) {
    throw new Error(`as failed: ${compilerDiagnostics(as.stderr)}`);
  }
}

export const agbccReal: RealCompile = {
  buildTarget(iText): BuiltTarget {
    const dir = contentDir('arm', iText);
    const iPath = join(dir, 'u.i'),
      sPath = join(dir, 'u.s'),
      oPath = join(dir, 'u.o');
    writeFileSync(iPath, iText);
    assemble(iPath, sPath, oPath);
    return { obj: oPath, asm: readFileSync(sPath, 'utf8') };
  },
  compileCandidate(tu, sym): string {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cand-'));
    const cPath = join(dir, 'c.c'),
      iPath = join(dir, 'c.i'),
      sPath = join(dir, 'c.s'),
      oPath = join(dir, 'c.o');
    writeFileSync(cPath, tu);
    // candidate TUs are self-contained (typedefs/vendored context inline) — bare -nostdinc cpp
    const cpp = run('arm-none-eabi-cpp', ['-nostdinc', cPath, '-o', iPath]);
    if (cpp.status !== 0) {
      throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
    }
    writeFileSync(iPath, stripPrototype(readFileSync(iPath, 'utf8'), sym));
    assemble(iPath, sPath, oPath);
    return oPath;
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'bench-vendor-'));
    const cPath = join(dir, 'u.c'),
      iPath = join(dir, 'u.i');
    writeFileSync(cPath, tu);
    // -P strips linemarkers: vendored blobs must carry no machine paths
    const cpp = run(
      'arm-none-eabi-cpp',
      ['-P', ...cfg.cppIncludes, ...(cfg.defines ?? []), cPath, '-o', iPath],
      cfg.root,
    );
    if (cpp.status !== 0) {
      throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
    }
    return readFileSync(iPath, 'utf8');
  },
};

/** Drop the target symbol's PROTOTYPE declaration(s) from preprocessed text, keeping the definition.
 *  A decompiler infers generic types (`s32 f(s32)`) that conflict with the header's real prototype
 *  (`s8 f(u8)`); since the compilers pass args in registers regardless, we judge CODEGEN not
 *  signature spelling by removing the conflicting prototype (a decl line with `sym(` ending in
 *  `;`, no `{`). */
export function stripPrototype(iText: string, sym: string): string {
  const proto = new RegExp(`\\b${sym}\\s*\\(`);
  return iText
    .split('\n')
    .filter((l) => !(proto.test(l) && /;\s*$/.test(l.trim()) && !l.includes('{')))
    .join('\n');
}
