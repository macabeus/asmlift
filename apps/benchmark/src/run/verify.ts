// Fast compile-check for a real-project manifest — the loop extraction agents iterate against,
// run where the LIVE checkout exists. For each function: preprocess against the checkout (the
// exact text `bench vendor` would freeze), compile, and check asmlift produces output or
// declines loudly. It does NOT score (skips the slower candidate compiles).
import { decompile } from '@asmlift/core/pipeline';
import { readFileSync } from 'node:fs';

import { type RealManifest, resolveProjectRoot, validateManifest } from '../cases/manifests';
import { makeTU, realCompilerFor } from '../compile/real';
import type { RealProjectCfg } from '../compile/types';
import { TOOLCHAINS } from '../toolchains';

export function verify(manifestPath: string): void {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as RealManifest;
  const problems = validateManifest(m, manifestPath);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(2);
  }
  const cfg: RealProjectCfg = {
    project: m.project,
    toolchain: m.toolchain,
    root: resolveProjectRoot(m),
    cppIncludes: m.cppIncludes,
    headers: m.headers,
    defines: m.defines,
  };
  const rc = realCompilerFor(m.toolchain);
  const tc = TOOLCHAINS[m.toolchain];

  let compiled = 0,
    asmliftOk = 0;
  for (const f of m.functions) {
    let asm: string;
    try {
      asm = rc.buildTarget(rc.preprocess(cfg, makeTU(cfg, f.prependC ?? '', f.funcC))).asm;
    } catch (e) {
      console.log(`✗ COMPILE ${f.sym}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    compiled++;
    try {
      const r = decompile(f.sym, asm, tc.targetDesc, f.proto ? { prototypes: f.proto } : {});
      asmliftOk++;
      console.log(`✓ ${f.sym}  (compiled, asmlift emitted ${r.source.split('\n').length} lines)`);
    } catch (e) {
      console.log(`~ ${f.sym}  (compiled; asmlift declined: ${(e as Error).message.split('\n')[0]})`);
    }
  }
  console.log(`\n${compiled}/${m.functions.length} compiled; asmlift emitted on ${asmliftOk}.`);
}
