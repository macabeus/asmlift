// agbcc / ARM (GBA) — EVERY harness-side spelling of "compile C with agbcc": the real-tier
// target build, the real-tier candidate compile (same steps, shared). Flags come from
// @asmlift/toolchains; the decomp.yaml candidate command lives in
// dataset/toolchains/agbcc/decomp.yaml.
import { NOT_CACHEABLE, candCache } from '@asmlift/cli/candcache';
import { TOOLCHAIN } from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BuiltTarget } from '../toolchains';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir, run, scratchSlot } from './util';

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

// One scratch dir each, reused per compile (util.ts scratchSlot) instead of one mkdtemp per
// candidate.
const candScratch = scratchSlot('bench-cand-');
const vendorScratch = scratchSlot('bench-vendor-');

// The cross-run candidate-object cache on the bench's real agbcc candidate compile.
//
// The NAMESPACE is a MEASUREMENT of the whole pipeline, and it must include the pipeline's
// TypeScript, not only its binaries. `compileCandidateRaw` below runs `cpp -nostdinc`, then
// `stripPrototype`, then agbcc, then APPENDS `.text/.align 2, 0` to the `.s`, then `as`. The
// last two are harness code: patching that tail to `.align 4, 0` changes the object by 16 bytes
// while every binary, flag and version banner stays identical, and a namespace that hashed only
// the toolchain served the stale object silently. So the module's OWN SOURCE, and `util.ts`'s
// (it owns `run`'s env and timeout, and `scratchSlot`), are hashed in. An unreadable source is a
// REFUSAL, never a guess.
const HERE = dirname(fileURLToPath(import.meta.url));
/** Every harness module whose text shapes what the compiler is handed, or how it is invoked. */
const SHAPING_SOURCES = [join(HERE, 'agbcc.ts'), join(HERE, 'util.ts')];
const CAND_CPP_FLAGS = ['-nostdinc'];
const STAMP_PROBE = 'int asmlift_candcache_stamp(int x) { return x * 3 + 1; }\n';
const CANDIDATE_READS_A_FILE = /^[ \t]*#[ \t]*include/m;

/** Run the candidate pipeline on a fixed probe TU in `dir`, returning the object's sha256 — or
 *  null if it did not compile. Its OWN directory, never the slot a candidate shares: a probe
 *  compiled into the reused candidate slot overwrites the object the caller is about to store. */
function stampProbeIn(dir: string): string | null {
  const cPath = join(dir, 'p.c'),
    iPath = join(dir, 'p.i'),
    sPath = join(dir, 'p.s'),
    oPath = join(dir, 'p.o');
  try {
    writeFileSync(cPath, STAMP_PROBE);
    if (run('arm-none-eabi-cpp', [...CAND_CPP_FLAGS, cPath, '-o', iPath]).status !== 0) {
      return null;
    }
    writeFileSync(iPath, stripPrototype(readFileSync(iPath, 'utf8'), 'asmlift_candcache_stamp'));
    assemble(iPath, sPath, oPath);
    return createHash('sha256').update(readFileSync(oPath)).digest('hex');
  } catch {
    return null;
  }
}

/** Where a bare command name resolves to on THIS $PATH, or an `UNRESOLVED:` marker. A
 *  `--version` banner is NOT an identity — a wrapper script, a rebuilt binutils and a patched cpp
 *  can all print the same string — so the namespace hashes the resolved file's BYTES instead.
 *  MEASURED before this existed: a shell wrapper in front of `arm-none-eabi-cpp` left the
 *  namespace at 8e0a7dccb4ead3f1, unmoved, three times running. */
function resolveOnPath(cmd: string): string {
  const r = spawnSync('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], { encoding: 'utf8' });
  const p = (r.stdout ?? '').trim();
  return p === '' ? `UNRESOLVED:${cmd}` : p;
}

/** Environment variables gcc/cpp read that CHANGE the compile. `CPATH` and `C_INCLUDE_PATH` are
 *  honoured even under `-nostdinc` (MEASURED: `CPATH=inc arm-none-eabi-cpp -nostdinc` resolves
 *  `#include "g0.h"` and its value reaches the object), so they are inputs to every candidate
 *  compile even though nothing in the command line names them. */
const COMPILE_ENV = [
  'CPATH',
  'C_INCLUDE_PATH',
  'CPLUS_INCLUDE_PATH',
  'GCC_EXEC_PREFIX',
  'COMPILER_PATH',
  'LIBRARY_PATH',
  'SOURCE_DATE_EPOCH',
  'DEPENDENCIES_OUTPUT',
  'SUNPRO_DEPENDENCIES',
];

/**
 * Every FILE whose BYTES are an input to a candidate compile — the compiler, the assembler, the
 * preprocessor, and the HARNESS'S OWN CODE that shapes what they are handed. This list IS the
 * namespace's file half: `candCacheStaticStamp` hashes exactly what it returns, so an input
 * dropped from here is an input the cache stops noticing.
 *
 * `agbcc.ts` and `util.ts` are on it because the pipeline is not only its binaries.
 * `compileCandidateRaw` runs `cpp -nostdinc`, then `stripPrototype`, then agbcc, then APPENDS
 * `.text/.align 2, 0` to the `.s`, then `as`; `util.ts` owns `run`'s env pass-through and its
 * 120 s timeout. Patching that tail to `.align 4, 0` changes the object by 16 bytes while every
 * binary, flag and version banner stays identical — and a namespace that hashed only the
 * toolchain served the stale 648-byte object where the truth is 660.
 */
export function candCacheNamespaceFiles(): string[] {
  return [TOOLCHAIN.agbcc, resolveOnPath(TOOLCHAIN.as), resolveOnPath('arm-none-eabi-cpp'), ...SHAPING_SOURCES];
}

/**
 * The namespace's STATIC half: flags, the compile environment, and the content of every file in
 * `files`. No compile runs here — the pipeline's own object bytes join the namespace separately
 * (the two-directory probe below), because that half is both the backstop and the purity test.
 *
 * `files` is a parameter so a test can hash copies it controls and assert that CONTENT, not the
 * path, is what moves the digest. An unreadable input THROWS: `candCache` turns that into a loud
 * refusal, which is the only sound answer — a namespace that guesses at an input it cannot read
 * is a namespace that serves stale objects.
 */
export function candCacheStaticStamp(files: readonly string[] = candCacheNamespaceFiles()): string {
  const h = createHash('sha256');
  h.update('bench-agbcc/v2');
  h.update(TOOLCHAIN.agbccFlags.join(' '));
  h.update(TOOLCHAIN.as + ' ' + TOOLCHAIN.asFlags.join(' '));
  h.update('cpp ' + CAND_CPP_FLAGS.join(' '));
  for (const v of COMPILE_ENV) {
    h.update(`env:${v}=${process.env[v] ?? ''}`);
  }
  for (const p of files) {
    h.update(`file:${p}`);
    // An `UNRESOLVED:` marker is the measurement: the command is not on this $PATH at all.
    h.update(p.startsWith('UNRESOLVED:') ? p : createHash('sha256').update(readFileSync(p)).digest('hex'));
  }
  return h.digest('hex');
}

const cache = candCache('bench-agbcc', () => {
  // DETERMINISM SELF-TEST, and the backstop object at the same time. A cached object is sound
  // only if it is a pure function of (input bytes, symbol) — which is NOT true of every toolchain
  // (`ido7.1` writes the absolute path of its input .c into the object). So compile one fixed
  // probe TU TWICE, in two DIFFERENT directories, and let the compiler answer.
  const a = stampProbeIn(mkdtempSync(join(tmpdir(), 'bench-ccstampA-')));
  const b = stampProbeIn(mkdtempSync(join(tmpdir(), 'bench-ccstampB-')));
  if (a === null || b === null || a !== b) {
    return NOT_CACHEABLE;
  }
  return createHash('sha256').update(candCacheStaticStamp()).update(a).digest('hex');
});

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
    // A candidate TU carrying an `#include` reads a file the namespace cannot see: the path is
    // in the TU, not in any flag, and the stamp probe does not exercise it. MEASURED on this
    // path: with `CPATH` pointing at a directory, editing the included header between two
    // cache-on runs served 7143fac350d6311b where the truth is 7430abf1c6ff95bc. Today no
    // candidate carries one (0 of 65,281 LBG sources), so this refusal costs nothing and stops
    // the day an emitter change arms it.
    if (CANDIDATE_READS_A_FILE.test(tu)) {
      return compileCandidateRaw(tu, sym);
    }
    if (cache.mode === 'on') {
      const hit = cache.get(tu, sym);
      if (typeof hit === 'string') {
        return hit;
      }
      if (hit instanceof Error) {
        throw hit;
      }
    }
    cache.warm();
    try {
      const o = compileCandidateRaw(tu, sym);
      if (cache.mode !== 'off') {
        cache.verify(tu, sym, o);
        return cache.put(tu, sym, o);
      }
      return o;
    } catch (e) {
      // A negative entry is only sound for a DETERMINISTIC rejection — the compiler ran and said
      // no. `util.ts run()` throws `spawnFailure` for a missing binary or the 120 s timeout, and
      // caching either of those would silently drop a candidate on every future run (the failure
      // mode this repo calls a silent wrong answer). Only the three banners a real diagnostic
      // carries are stored.
      const m = (e as Error).message;
      if (cache.mode === 'on' && /^(cpp|agbcc|as) failed: /.test(m)) {
        cache.putFail(tu, sym, m);
      }
      throw e;
    }
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const dir = vendorScratch();
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

function compileCandidateRaw(tu: string, sym: string): string {
  const dir = candScratch();
  const cPath = join(dir, 'c.c'),
    iPath = join(dir, 'c.i'),
    sPath = join(dir, 'c.s'),
    oPath = join(dir, 'c.o');
  writeFileSync(cPath, tu);
  // candidate TUs are self-contained (typedefs/vendored context inline) — bare -nostdinc cpp
  const cpp = run('arm-none-eabi-cpp', [...CAND_CPP_FLAGS, cPath, '-o', iPath]);
  if (cpp.status !== 0) {
    throw new Error(`cpp failed: ${compilerDiagnostics(cpp.stderr)}`);
  }
  writeFileSync(iPath, stripPrototype(readFileSync(iPath, 'utf8'), sym));
  assemble(iPath, sPath, oPath);
  return oPath;
}

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
