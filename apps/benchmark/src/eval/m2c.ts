// Run the m2c decompiler on one function and classify its output.
//
// m2c reads GNU-as text (NOT objdump): for ARM we feed agbcc's `.s` verbatim; for MIPS/PPC we feed
// the objdump→GNU-as normalization (m2c-normalizer.ts). m2c prints C to stdout. Exit code
// alone is unreliable — an undecodable op is a SOFT outcome (exit 0 + an `M2C_ERROR`/`M2C_UNK`
// DECLINE marker, classified by the caller via outcome.ts); this runner scans only for m2c's
// hard-failure report.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { M2C_DIR, M2C_PINNED_COMMIT } from '../config';
import type { Toolchain } from '../toolchains';
import { disasmToM2c, m2cTarget } from './m2c-normalizer';
import { isHardFailure } from './outcome';

/** Loud preflight: a bench run must measure the PINNED m2c, never whatever the checkout
 *  happens to be at — a drifted checkout would silently change the baseline. */
export function assertM2cPinned(): void {
  const head = spawnSync('git', ['-C', M2C_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) {
    throw new Error(`m2c checkout not found at ${M2C_DIR} (ASMLIFT_M2C_DIR)`);
  }
  const actual = head.stdout.trim();
  if (actual !== M2C_PINNED_COMMIT) {
    throw new Error(
      `m2c checkout is at ${actual.slice(0, 12)} but the benchmark pins ${M2C_PINNED_COMMIT.slice(0, 12)} ` +
        `(apps/benchmark/M2C_COMMIT) — run: git -C ${M2C_DIR} checkout ${M2C_PINNED_COMMIT}`,
    );
  }
}

export interface M2cResult {
  failed: boolean; // NO usable output: nonzero exit, empty stdout+stderr, or m2c's failure report
  source: string; // the C m2c emitted (or, when failed, the failure text)
}

export interface M2cOptions {
  context?: string; // C header string (typedefs/prototypes) — must parse as C, m2c's context parser is C-only
  asmDump?: string; // `objdump -s -r -t` text feeding the normalizer's data-section emission (best-effort)
  lang?: 'c' | 'c++'; // 'c++' switches the mwcc target to ppc-mwcc-c++; no effect elsewhere
}

/** Feed a function to m2c. `asm` is the objdump text (MIPS/PPC) or agbcc `.s` (ARM); `asmKind`
 *  selects whether to normalize. Output classification (failed vs declined vs compile+score) is
 *  the caller's job via outcome.ts — this runner only detects "produced no usable output at all". */
export function runM2c(tc: Toolchain, sym: string, asm: string, opts: M2cOptions = {}): M2cResult {
  // A missing m2c is a SETUP defect, never an m2c result: classifying it as `failed` would
  // publish rows where m2c "lost" functions it never saw.
  if (!existsSync(join(M2C_DIR, 'm2c.py'))) {
    throw new Error(
      `m2c checkout not found at ${M2C_DIR} — clone https://github.com/matt-kempster/m2c ` +
        `and point ASMLIFT_M2C_DIR at it (sibling-checkout default: ../m2c)`,
    );
  }
  const asmText = tc.asmKind === 'objdump' ? disasmToM2c(asm, tc.isa === 'ppc' ? 'ppc' : 'mips', opts.asmDump) : asm; // agbcc .s is already GNU-as
  const dir = mkdtempSync(join(tmpdir(), 'bench-m2c-'));
  const asmPath = join(dir, 'in.s');
  writeFileSync(asmPath, asmText);
  const args = ['m2c.py', '-t', m2cTarget(tc.compiler, opts.lang), '-f', sym, '--no-cache'];
  if (opts.context) {
    const ctxPath = join(dir, 'ctx.h');
    writeFileSync(ctxPath, opts.context);
    args.push('--context', ctxPath);
  }
  args.push(asmPath);
  const r = spawnSync('python3', args, { cwd: M2C_DIR, encoding: 'utf8', timeout: 60_000 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(`cannot run python3 (ENOENT) — m2c needs a python3 on PATH`);
  }
  const source = (r.stdout ?? '') || (r.stderr ?? '');
  const failed = r.status !== 0 || source.trim().length === 0 || isHardFailure(source);
  return { failed, source };
}
