// Fast compile-check for a real-project manifest — the loop extraction agents iterate against,
// run where the LIVE checkout exists. For each function: preprocess against the checkout (the
// exact text `bench vendor` would freeze), compile at its unit's flags, and check asmlift produces
// output or declines loudly. It does NOT score (skips the slower candidate compiles).
import { decompile } from '@asmlift/core/pipeline';
import { readFileSync } from 'node:fs';

import { type RealManifest, resolveProjectRoot, validateManifest } from '../cases/manifests';
import { buildRealTarget, makeTU, realCompilerFor } from '../compile/real';
import type { RealProjectCfg } from '../compile/types';
import { codegenFor } from '../toolchains';

export function verify(manifestPath: string): void {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as RealManifest;
  const problems = validateManifest(m, manifestPath, { complete: false });
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(2);
  }
  const root = resolveProjectRoot(m);

  let compiled = 0,
    asmliftOk = 0;
  for (const f of m.functions) {
    const unit = m.units?.[f.unit];
    if (unit === undefined) {
      console.log(
        `✗ FLAGS ${f.sym}: its unit has no flags yet — run \`pnpm bench flags --project ${m.project} --write\``,
      );
      continue;
    }
    const cfg: RealProjectCfg = {
      project: m.project,
      toolchain: unit.toolchain,
      root,
      cppIncludes: m.cppIncludes,
      headers: m.headers,
      defines: m.defines,
    };
    const codegen = codegenFor(unit.toolchain, unit.cflags);
    let asm: string;
    try {
      const tuI = realCompilerFor(unit.toolchain).preprocess(cfg, makeTU(cfg, f.prependC ?? '', f.funcC));
      asm = buildRealTarget(unit.toolchain, f.sym, codegen.cflags, tuI).asm;
    } catch (e) {
      console.log(`✗ COMPILE ${f.sym}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    compiled++;
    try {
      const r = decompile(f.sym, asm, codegen.target, f.proto ? { prototypes: f.proto } : {});
      asmliftOk++;
      console.log(`✓ ${f.sym}  (compiled, asmlift emitted ${r.source.split('\n').length} lines)`);
    } catch (e) {
      console.log(`~ ${f.sym}  (compiled; asmlift declined: ${(e as Error).message.split('\n')[0]})`);
    }
  }
  console.log(`\n${compiled}/${m.functions.length} compiled; asmlift emitted on ${asmliftOk}.`);
}
