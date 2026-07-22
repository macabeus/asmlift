// Content-keyed caches under apps/benchmark/.cache/ for the benchmark's repeated work: reference
// builds, the PPC AsmData objdump, and m2c (a frozen, pinned baseline). Each entry is keyed by a
// sha256 of its declared DATA inputs (source text, symbol, toolchain config, m2c commit,
// target-object bytes) plus a version lever `v` standing in for the CODE that runs inside the
// cached computation — data changes miss naturally; code changes require a `v` bump. No TTL.
// Delete the directory to drop the cache; ASMLIFT_BENCH_CACHE=0 bypasses it.
// Values are written tmp-then-rename so a concurrent reader never sees a torn file.
//
// Deliberately NOT cached: asmlift's own decompile/score work — that is the thing under test.
import type { DecompilerResult } from '@asmlift/bench-schema';
import { type AsmData, parseAsmData } from '@asmlift/core/frontend/asmdata';
import type { TargetDescription } from '@asmlift/core/target';
import { extractAsmData, mipsObjdumpText, ppcObjdumpText } from '@asmlift/toolchains';
import { GCC272_TOOLCHAIN, GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, TOOLCHAIN } from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE_DIR, M2C_DIR } from './config';
import type { BuiltTarget, Toolchain, ToolchainId } from './toolchains';

const enabled = () => process.env.ASMLIFT_BENCH_CACHE !== '0';
export const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function put(path: string, data: string | Buffer): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// The toolchain config participates in every reference key so a flag/path change invalidates
// naturally. These are the exact objects score.ts compiles with — no second copy to drift.
const TC_CFG: Record<ToolchainId, unknown> = {
  agbcc: TOOLCHAIN,
  'ido7.1': IDO_TOOLCHAIN,
  'gcc2.7.2kmc': GCC_KMC_TOOLCHAIN,
  'gcc2.7.2': GCC272_TOOLCHAIN,
  mwcc_242_81: MWCC_PPC_TOOLCHAIN,
};

/** `tc.buildTarget`, cached by (toolchain config, reference source, symbol, and — for c++ —
 *  language). The cached object file is returned by path and only ever READ downstream
 *  (objdiff target / objdump input). */
export function cachedBuildTarget(tc: Toolchain, refC: string, sym: string, lang?: 'c' | 'c++'): BuiltTarget {
  if (!enabled()) {
    return tc.buildTarget(refC, sym, lang);
  }
  // lang enters the key only for c++ (see cachedM2cResult for the rationale)
  const key = sha(
    JSON.stringify({ v: 2, kind: 'ref', tc: tc.id, cfg: TC_CFG[tc.id], refC, sym, ...(lang === 'c++' && { lang }) }),
  );
  const oPath = join(CACHE_DIR, `ref-${key}.o`);
  const aPath = join(CACHE_DIR, `ref-${key}.asm`);
  if (existsSync(oPath) && existsSync(aPath)) {
    return { obj: oPath, asm: readFileSync(aPath, 'utf8') };
  }
  const built = tc.buildTarget(refC, sym, lang);
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${oPath}.tmp${process.pid}`;
  copyFileSync(built.obj, tmp);
  renameSync(tmp, oPath);
  put(aPath, built.asm);
  return { obj: oPath, asm: built.asm };
}

/** The PPC dockerized `objdump -s -r -t` text, content-cached by object bytes — the ONE cache
 *  path both PPC dump consumers share, so the path scheme cannot fork. */
function cachedPpcDumpText(obj: string): string {
  if (!enabled()) {
    return ppcObjdumpText(obj);
  }
  const path = join(CACHE_DIR, `ppcdump-${sha(readFileSync(obj))}.txt`);
  if (existsSync(path)) {
    return readFileSync(path, 'utf8');
  }
  const dump = ppcObjdumpText(obj);
  put(path, dump);
  return dump;
}

/** Raw `objdump -s -r -t` text for the m2c normalizer's data-section emission: PPC via the
 *  content-cached dockerized dump; MIPS via the native objdump (cheap, uncached); ARM none
 *  (agbcc `.s` needs no normalization). */
export function cachedAsmDumpText(obj: string, tcId: ToolchainId): string | undefined {
  if (tcId === 'mwcc_242_81') {
    return cachedPpcDumpText(obj);
  }
  if (tcId === 'ido7.1') {
    return mipsObjdumpText(obj, IDO_TOOLCHAIN.objdump);
  }
  if (tcId === 'gcc2.7.2kmc') {
    return mipsObjdumpText(obj, GCC_KMC_TOOLCHAIN.objdump);
  }
  if (tcId === 'gcc2.7.2') {
    return mipsObjdumpText(obj, GCC272_TOOLCHAIN.objdump);
  }
  return undefined;
}

/** `extractAsmData`, with the PPC path's dockerized objdump TEXT cached by object content
 *  (the parse is cheap and stays live). MIPS uses a native objdump — no caching needed. */
export function cachedExtractAsmData(obj: string, target: TargetDescription): AsmData | undefined {
  if (target.compiler !== 'mwcc') {
    return extractAsmData(obj, target);
  }
  const dump = cachedPpcDumpText(obj);
  return parseAsmData(dump, dump, dump, true);
}

// m2c is keyed by its checkout commit: same commit + same inputs ⇒ same output. A dirty or
// unreadable checkout disables the cache (no safe key) rather than risking a stale result.
let m2cCommitMemo: string | null | undefined;
function m2cCommit(): string | null {
  if (m2cCommitMemo !== undefined) {
    return m2cCommitMemo;
  }
  const head = spawnSync('git', ['-C', M2C_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const dirty = spawnSync('git', ['-C', M2C_DIR, 'status', '--porcelain'], { encoding: 'utf8' });
  m2cCommitMemo = head.status === 0 && dirty.status === 0 && dirty.stdout.trim() === '' ? head.stdout.trim() : null;
  return m2cCommitMemo;
}

/** The key inputs of one row's m2c half. `lang` selects the m2c target dialect. */
export interface M2cKeyInputs {
  tcId: ToolchainId;
  sym: string;
  asm: string;
  ctx?: string;
  obj: string; // path; the KEY uses the object's bytes
  lang?: 'c' | 'c++';
}

/** The full m2c half of one row (decompile + compile + objdiff score), cached by
 *  (m2c commit, toolchain, symbol, asm, context, target-object bytes, and — for c++ —
 *  language). */
export function cachedM2cResult(inputs: M2cKeyInputs, compute: () => DecompilerResult): DecompilerResult {
  const { tcId, sym, asm, ctx, obj, lang } = inputs;
  const commit = m2cCommit();
  if (!enabled() || !commit) {
    return compute();
  }
  // The objdump→GNU-as normalizer, the m2c scoring prelude and the outcome classifier all run
  // INSIDE this cached computation but are not part of the key — any change to them MUST bump
  // `v`, or fixed rows keep serving stale results. `lang` enters the key only for c++ so every
  // existing C entry keeps its identity.
  const key = sha(
    JSON.stringify({
      v: 12,
      kind: 'm2c',
      commit,
      tc: tcId,
      sym,
      asm,
      ctx: ctx ?? null,
      obj: sha(readFileSync(obj)),
      ...(lang === 'c++' && { lang }),
    }),
  );
  const path = join(CACHE_DIR, `m2c-${key}.json`);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as DecompilerResult;
  }
  const result = compute();
  put(path, JSON.stringify(result));
  return result;
}
