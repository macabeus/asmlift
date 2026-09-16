// Run the m2c decompiler on one function and classify its output.
//
// m2c reads GNU-as text (NOT objdump): for ARM we feed agbcc's `.s` verbatim; for MIPS/PPC we feed
// the objdump→GNU-as normalization (m2c-normalizer.ts). m2c prints C to stdout. Exit code
// alone is unreliable — an undecodable op is a SOFT outcome (exit 0 + an `M2C_ERROR`/`M2C_UNK`
// DECLINE marker, classified by the caller via outcome.ts); this runner scans only for m2c's
// hard-failure report.
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSlot } from '../compile/util';
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

/** m2c's `ppc-mwcc-c++` target names the implicit receiver `this`, which is a KEYWORD in the dialect
 *  a C++ row is compiled in: `'(' expected`, on every member function it decompiles. That is an
 *  artifact of the harness's choice of front end, not of m2c's code — the same reason every rung
 *  re-provides `#define NULL` — so the receiver is renamed where it is DECLARED as a parameter of
 *  this function. A source that merely uses `this->` is a genuine member definition and is left
 *  alone: renaming there would change what the code means.
 *
 *  The caller scores the source AS EMITTED first and reaches for this only when nothing compiles
 *  (`m2cCandidates`): the plain-C fallback dialect accepts the word, and a row that already scores
 *  through it must not be re-scored in a different front end. */
export function renameReceiver(source: string, sym: string): string {
  const declared = new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(([^)]*)\\)`).exec(source);
  if (declared === null || !/(^|[\s*(])this\s*(,|$)/.test(declared[1])) {
    return source;
  }
  let name = 'this_';
  while (new RegExp(`\\b${name}\\b`).test(source)) {
    name += '_';
  }
  return source.replace(/\bthis\b/g, name);
}

/** The texts m2c's output is scored as, in order. The first that compiles is the measurement AND
 *  what the row publishes, so a reproduction compiles the text the benchmark graded. */
export function m2cCandidates(source: string, sym: string, language: 'c' | 'c++'): string[] {
  const renamed = language === 'c++' ? renameReceiver(source, sym) : source;
  return renamed === source ? [source] : [source, renamed];
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

// One scratch dir, reused per invocation (compile/util.ts scratchSlot) instead of one mkdtemp
// per row.
const m2cScratch = scratchSlot('bench-m2c-');

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
  const asmText =
    tc.asmKind === 'objdump' ? disasmToM2c(asm, tc.isa === 'ppc' ? 'ppc' : 'mips', sym, opts.asmDump) : asm; // agbcc .s is already GNU-as
  const dir = m2cScratch();
  const asmPath = join(dir, 'in.s');
  writeFileSync(asmPath, asmText);
  const args = ['m2c.py', '-t', m2cTarget(TOOLCHAIN_TARGETS[tc.id].family, opts.lang), '-f', sym, '--no-cache'];
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
