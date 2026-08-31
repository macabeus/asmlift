// Content-keyed caches under apps/benchmark/.cache/ for the benchmark's repeated work: reference
// builds, the PPC AsmData objdump, and m2c (a frozen, pinned baseline). Each entry is keyed by a
// sha256 of its declared DATA inputs (source text, symbol, toolchain config, m2c commit,
// target-object bytes) plus a version lever `v` standing in for the CODE that runs inside the
// cached computation — data changes miss naturally; code changes require a `v` bump. No TTL.
// Delete the directory to drop the cache; ASMLIFT_BENCH_CACHE=0 bypasses it.
// Values are written tmp-then-rename so a concurrent reader never sees a torn file.
//
// Deliberately NOT cached HERE: asmlift's own decompile/score work — that is the thing under test.
//
// There is a SECOND cache in the harness, at a different level and with a different keying
// philosophy: packages/cli/src/candcache.ts, the cross-run candidate-OBJECT cache. It caches the
// compiler's output for one candidate TU, which is an input to every objdiff score — so the
// sentence above is only true of asmlift's own work, not of the compiles underneath it. The
// boundary: this file caches DATA-keyed results of harness computations with a manual `v` lever
// for the code inside them; candcache caches one toolchain's object bytes under a namespace that
// MEASURES the toolchain, and it is off unless ASMLIFT_CANDCACHE is set. `ASMLIFT_BENCH_CACHE=0`
// bypasses both (candcache.ts reads it), because "bypass the benchmark's caches" has to mean all
// of them or bisecting a suspect row still reads candidate objects off disk.
import type { DecompilerResult } from '@asmlift/bench-schema';
import { objdiffVersion } from '@asmlift/cli/objdiff-version';
import { type AsmData, parseAsmData } from '@asmlift/core/frontend/asmdata';
import type { TargetDescription } from '@asmlift/core/target';
import { extractAsmData, mipsObjdumpText, ppcObjdumpText } from '@asmlift/toolchains';
import { GCC272_TOOLCHAIN, GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, TOOLCHAIN } from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE_DIR, M2C_DIR } from './config';
import { type BuiltTarget, type Toolchain, type ToolchainId, checkedTarget } from './toolchains';

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
  // `checkedTarget` (toolchains.ts) states the non-emptiness invariant; what is CACHE-specific is
  // that the tmp-then-rename write makes a bad result a WELL-FORMED entry with no TTL, so the same
  // question has to be asked twice — once on the way in, and once of what is already on disk.
  const build = (): BuiltTarget => checkedTarget(tc.buildTarget(refC, sym, lang), `${sym} on ${tc.id}`);
  if (!enabled()) {
    return build();
  }
  // lang enters the key only for c++ (see cachedM2cResult for the rationale)
  const key = sha(
    JSON.stringify({ v: 2, kind: 'ref', tc: tc.id, cfg: TC_CFG[tc.id], refC, sym, ...(lang === 'c++' && { lang }) }),
  );
  const oPath = join(CACHE_DIR, `ref-${key}.o`);
  const aPath = join(CACHE_DIR, `ref-${key}.asm`);
  if (existsSync(oPath) && existsSync(aPath)) {
    const asm = readFileSync(aPath, 'utf8');
    // BOTH halves, because the entry is two files and the observed poisoning had exactly one of
    // them bad. An empty `.o` beside a good `.asm` is the same event with the halves swapped — a
    // step that exited 0 having written nothing — and it is objdiff's scoring target, so left
    // unchecked it scores every candidate against an empty object.
    if (asm.trim() !== '' && statSync(oPath).size > 0) {
      return { obj: oPath, asm };
    }
  }
  const built = build();
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${oPath}.tmp${process.pid}`;
  copyFileSync(built.obj, tmp);
  renameSync(tmp, oPath);
  put(aPath, built.asm);
  return { obj: oPath, asm: built.asm };
}

/** The PPC dockerized `objdump -s -r -t` text, content-cached by object bytes — the ONE cache
 *  path both PPC dump consumers share, so the path scheme cannot fork.
 *
 *  An empty dump raises in `ppcObjdumpText`, covering this cache, the uncached MIPS dumps and the
 *  direct `extractAsmData` callers at once. What is left for the cache is the DURABLE half: an
 *  entry written before that guard existed is a well-formed, TTL-less file that would be served
 *  forever, so an empty one READS AS A MISS and is rebuilt. */
function cachedPpcDumpText(obj: string): string {
  if (!enabled()) {
    return ppcObjdumpText(obj);
  }
  const path = join(CACHE_DIR, `ppcdump-${sha(readFileSync(obj))}.txt`);
  if (existsSync(path)) {
    const cached = readFileSync(path, 'utf8');
    if (cached.trim() !== '') {
      return cached;
    }
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
 *  (m2c commit, objdiff-wasm version, toolchain, symbol, asm, context, target-object bytes, and
 *  — for c++ — language). */
export function cachedM2cResult(inputs: M2cKeyInputs, compute: () => DecompilerResult): DecompilerResult {
  const { tcId, sym, asm, ctx, obj, lang } = inputs;
  const commit = m2cCommit();
  if (!enabled() || !commit) {
    return compute();
  }
  // The objdump→GNU-as normalizer, the m2c scoring prelude, the outcome classifier and the
  // quality heuristic all run INSIDE this cached computation but are not part of the key — any
  // change to them MUST bump `v`, or fixed rows keep serving stale results. `lang` enters the
  // key only for c++ so every existing C entry keeps its identity.
  // v13: assessQuality exempts project-idiom address casts from the casts count.
  // v14: the objdump→GNU-as normalizer carries MIPS REL addends into %hi/%lo (m2c-normalizer.ts)
  //      — the KEY holds the raw disassembly, so a normalizer change is invisible to it.
  // The scorer is the one such input that is DERIVED rather than bumped by hand: the value cached
  // here holds `score`, which objdiff computes, and two objdiff versions can score one pair
  // differently. Off the key, a scorer bump replays the old engine's numbers out of a warm cache
  // and a per-row diff reports the bump inert without having scored anything.
  const key = sha(
    JSON.stringify({
      v: 14,
      kind: 'm2c',
      commit,
      objdiff: objdiffVersion(),
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
  // NEVER cache an EMPTY failure. `failed` covers three things (m2c.ts runM2c): a nonzero exit, a
  // failure report m2c itself wrote, and NO OUTPUT AT ALL. The first two are m2c's own behaviour
  // and are worth caching — the third never is. m2c always says something when it gives up, so an
  // empty stdout AND stderr means the process did not run: a spawn that lost the race for a pid or
  // a file descriptor under a parallel shard fan, which is exactly when it happens. Cached, one
  // such loss is permanent — every later run reads the poisoned entry in half a second and the
  // regression gate reports a LOST row that no code change caused. Observed once: a full-run shard
  // wrote `synthetic:astore:gcc2.7.2kmc [m2c] match → failed, "empty output"` while running m2c on
  // the same inputs by hand returned the base's exact output three times over.
  if (!(result.outcome === 'failed' && result.source.trim() === '')) {
    put(path, JSON.stringify(result));
  }
  return result;
}
