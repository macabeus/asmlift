// Content-keyed caches under apps/benchmark/.cache/ for the benchmark's repeated work: reference
// builds, the PPC AsmData objdump, and m2c (a frozen, pinned baseline). Each entry is keyed by a
// sha256 of its declared DATA inputs (source text, symbol, toolchain config, m2c commit,
// target-object bytes) plus a version knob `v` standing in for the CODE that runs inside the
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
// boundary: this file caches DATA-keyed results of harness computations with a manual `v` knob
// for the code inside them; candcache caches one toolchain's object bytes under a namespace that
// MEASURES the toolchain, and it is ON unless ASMLIFT_CANDCACHE says otherwise. `ASMLIFT_BENCH_CACHE=0`
// bypasses both (candcache.ts reads it), because "bypass the benchmark's caches" has to mean all
// of them or bisecting a suspect row still reads candidate objects off disk.
import type { DecompilerResult } from '@asmlift/bench-schema';
import { objdiffVersion } from '@asmlift/cli/objdiff-version';
import { type AsmData, parseAsmData } from '@asmlift/core/frontend/asmdata';
import type { TargetDescription } from '@asmlift/core/target';
import { extractAsmData, mipsObjdumpText, ppcObjdumpText, scopedForDump } from '@asmlift/toolchains';
import {
  GCC272_TOOLCHAIN,
  GCC_KMC_TOOLCHAIN,
  IDO_TOOLCHAIN,
  MWCC_PPC_TOOLCHAIN,
  TOOLCHAIN,
  mwccDir,
} from '@asmlift/toolchains';
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
  // One bag per CodeWarrior build: the shared half plus the directory that is the build, so two
  // builds at one flag set never key to the same reference object.
  mwcc_242_81: [MWCC_PPC_TOOLCHAIN, mwccDir('mwcc_242_81')],
  mwcc_233_163n: [MWCC_PPC_TOOLCHAIN, mwccDir('mwcc_233_163n')],
  mwcc_247_107: [MWCC_PPC_TOOLCHAIN, mwccDir('mwcc_247_107')],
};

/** `tc.buildTarget`, cached by (toolchain config, codegen flags, reference source, symbol, and — for
 *  c++ — language). The cached object file is returned by path and only ever READ downstream
 *  (objdiff target / objdump input). */
export function cachedBuildTarget(
  tc: Toolchain,
  cflags: readonly string[],
  refC: string,
  sym: string,
  lang?: 'c' | 'c++',
): BuiltTarget {
  // `checkedTarget` (toolchains.ts) states the non-emptiness invariant; what is CACHE-specific is
  // that the tmp-then-rename write makes a bad result a WELL-FORMED entry with no TTL, so the same
  // question has to be asked twice — once on the way in, and once of what is already on disk.
  const build = (): BuiltTarget => checkedTarget(tc.buildTarget(refC, sym, cflags, lang), `${sym} on ${tc.id}`);
  if (!enabled()) {
    return build();
  }
  // lang enters the key only for c++ (see cachedM2cResult for the rationale)
  const key = sha(
    JSON.stringify({
      v: 2,
      kind: 'ref',
      tc: tc.id,
      cfg: TC_CFG[tc.id],
      cflags,
      refC,
      sym,
      ...(lang === 'c++' && { lang }),
    }),
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

/** Where the `objdump -s -r -t` text for `sym` is cached, and which object it is a dump OF.
 *
 *  THE KEY IS THE SCOPED OBJECT'S BYTES, not the object's and not the object-plus-symbol: a dump
 *  describes the whole object it is given, so the object the dump is OF is the whole key. On a
 *  single-code-section object — every target the synthetic tier builds and every one the GBA/N64
 *  projects build — the scoped object IS the object, so the key is byte-for-byte the one this
 *  cache has always written; on a CodeWarrior object with several `.text` sections, two functions
 *  key apart because they are dumped from different bytes.
 *
 *  `scopedForDump` is the dump seam's OWN answer to "which object is this", asked once here and
 *  handed back to it below rather than spelled a second time: two derivations of one fact can
 *  drift, and the one deciding the key would then not be the one deciding the bytes.
 *
 *  Exported for the test that pins this, which needs neither Docker nor a toolchain to ask it. */
export function ppcDumpCacheEntry(obj: string, sym: string): { scoped: string; path: string } {
  const scoped = scopedForDump(obj, sym);
  return { scoped, path: join(CACHE_DIR, `ppcdump-${sha(readFileSync(scoped))}.txt`) };
}

/** The PPC dockerized `objdump -s -r -t` text for one function, content-cached — the ONE cache
 *  path both PPC dump consumers share, so the path scheme cannot fork.
 *
 *  An empty dump raises in `ppcObjdumpText`, covering this cache, the uncached MIPS dumps and the
 *  direct `extractAsmData` callers at once. What is left for the cache is the DURABLE half: an
 *  entry written before that guard existed is a well-formed, TTL-less file that would be served
 *  forever, so an empty one READS AS A MISS and is rebuilt. */
function cachedPpcDumpText(obj: string, sym: string): string {
  if (!enabled()) {
    return ppcObjdumpText(obj, sym);
  }
  const { scoped, path } = ppcDumpCacheEntry(obj, sym);
  if (existsSync(path)) {
    const cached = readFileSync(path, 'utf8');
    if (cached.trim() !== '') {
      return cached;
    }
  }
  const dump = ppcObjdumpText(scoped, sym);
  put(path, dump);
  return dump;
}

/** How each toolchain's object is dumped for the m2c normalizer — ONE table, EXHAUSTIVE over
 *  `ToolchainId`, so a new toolchain is a compile error here rather than a row that silently
 *  publishes no `asmDump` (`compile/real.ts`'s dispatch table is exhaustive for the same reason).
 *
 *  `null` is the ARM answer and it is a statement, not an omission: agbcc's `.s` needs no
 *  normalization. Every CodeWarrior build shares one entry because the dump is the IMAGE's
 *  objdump reading an ELF — the build that WROTE the object changes nothing about reading it. */
const ASM_DUMP_TEXT: Record<ToolchainId, ((obj: string, sym: string) => string) | null> = {
  agbcc: null,
  'ido7.1': (obj, sym) => mipsObjdumpText(obj, IDO_TOOLCHAIN.objdump, sym),
  'gcc2.7.2kmc': (obj, sym) => mipsObjdumpText(obj, GCC_KMC_TOOLCHAIN.objdump, sym),
  'gcc2.7.2': (obj, sym) => mipsObjdumpText(obj, GCC272_TOOLCHAIN.objdump, sym),
  mwcc_242_81: cachedPpcDumpText,
  mwcc_233_163n: cachedPpcDumpText,
  mwcc_247_107: cachedPpcDumpText,
};

/** Raw `objdump -s -r -t` text for the m2c normalizer's data-section emission, describing `sym`'s
 *  own code section: PPC via the content-cached dockerized dump; MIPS via the native objdump
 *  (cheap, uncached); ARM none (agbcc `.s` needs no normalization).
 *
 *  `undefined` reaches `evaluate` as a text-only row and nothing says so, which is why the answer
 *  comes from a table tsc checks rather than from a chain of ids a new toolchain falls off. */
export function cachedAsmDumpText(obj: string, tcId: ToolchainId, sym: string): string | undefined {
  return ASM_DUMP_TEXT[tcId]?.(obj, sym);
}

/** `extractAsmData`, with the PPC path's dockerized objdump TEXT cached by object content
 *  (the parse is cheap and stays live). MIPS uses a native objdump — no caching needed. */
export function cachedExtractAsmData(obj: string, target: TargetDescription, sym: string): AsmData | undefined {
  if (target.compiler !== 'mwcc') {
    return extractAsmData(obj, target, sym);
  }
  const dump = cachedPpcDumpText(obj, sym);
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
  /** the flags m2c's candidate is compiled with: two flag sets can leave the target object
   *  byte-identical and still score the same candidate differently */
  cflags: readonly string[];
  sym: string;
  asm: string;
  ctx?: string;
  obj: string; // path; the KEY uses the object's bytes
  lang?: 'c' | 'c++';
}

/** The full m2c half of one row (decompile + compile + objdiff score), cached by
 *  (m2c commit, objdiff-wasm version, toolchain, candidate compile flags, symbol, asm, context,
 *  target-object bytes, and — for c++ — language). */
export function cachedM2cResult(inputs: M2cKeyInputs, compute: () => DecompilerResult): DecompilerResult {
  const { tcId, cflags, sym, asm, ctx, obj, lang } = inputs;
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
  // v15: `scoreM2c` gained escalation rungs carrying a synthetic map row's declarations — the
  //      analogue of the real tier's project-context compile. `ctx` IS in the key, so the four
  //      map rows re-keyed anyway when their ctx grew the map; what is invisible to the key is
  //      that every OTHER row's scoring path changed shape too, and a rung nobody reaches still
  //      has to be proved inert by re-running rather than by argument.
  // v16: those rungs pass the declarations through the compiler's PRELUDE SLOT rather than
  //      concatenating them onto the source. v15 did the latter and every rung died on
  //      `redefinition of s16` — the prelude already emits C_TYPEDEFS — so v15's entries record a
  //      retry that failed for its own reason, which is indistinguishable in the cache from the
  //      failure it was added to fix.
  // v17: when NO rung compiles, `scoreM2c` now reports the failure of the last rung that compiled
  //      the source AS EMITTED (rung 2 where there are declarations) rather than rung 0's. The
  //      whole difference is the `errorMarkers` this function's own value carries, so a v16 entry
  //      replays ``gPacked' undeclared`` for a row whose deciding rung declares the symbol — the
  //      exact wrong answer the change removes, served out of a warm store and invisible to every
  //      artifact comparison of the day — the incident that put `errorMarkers` into `FIELDS.m2c`.
  //      Caught by reading this list before publishing a run, which is what it is for.
  // v18: the agbcc candidate compile names its translation unit `c.c`. The name is part of the
  //      compiler's diagnostics, which are this value's `errorMarkers`, and it is in no key field.
  // v19: a C++ row's candidate compiles with C linkage, and the context ladder falls back to plain
  //      C for a candidate the row's own dialect refuses (compile/real.ts). `lang` is in the key,
  //      so no C entry moves — but a c++ entry written before the fallback records a `noncompile`
  //      the ladder now scores, which is how this was found: `pikmin:getMainStickX__10ControllerFv`
  //      replayed `noncompile` out of a warm store while a direct `scoreM2c` on the same arguments
  //      returned MATCH 0/14.
  // The scorer is the one such input that is DERIVED rather than bumped by hand: the value cached
  // here holds `score`, which objdiff computes, and two objdiff versions can score one pair
  // differently. Off the key, a scorer bump replays the old engine's numbers out of a warm cache
  // and a per-row diff reports the bump inert without having scored anything.
  const key = sha(
    JSON.stringify({
      v: 19,
      kind: 'm2c',
      commit,
      objdiff: objdiffVersion(),
      tc: tcId,
      cflags,
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
