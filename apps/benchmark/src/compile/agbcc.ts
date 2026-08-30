// agbcc / ARM (GBA) — EVERY harness-side spelling of "compile C with agbcc": the real-tier
// target build, the real-tier candidate compile (same steps, shared). Flags come from
// @asmlift/toolchains; the decomp.yaml candidate command lives in
// dataset/toolchains/agbcc/decomp.yaml.
import { NOT_CACHEABLE, candCache, candidateCacheRefusal, toolchainFileChain } from '@asmlift/cli/candcache';
import { TOOLCHAIN } from '@asmlift/toolchains';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BuiltTarget } from '../toolchains';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir, run, scratchSlot } from './util';

/**
 * A failed step, thrown so that a DETERMINISTIC rejection and a TRANSIENT one cannot be confused.
 *
 * `<tool> failed: <diagnostic>` means the compiler ran and said no — that verdict is a property of
 * the TU and may be cached. Everything else is this machine having a bad minute and must never be:
 * a stored transient drops that candidate from every future run under the namespace, which is a
 * spelling silently missing from the row's fan.
 *
 * The distinction is read off the SPAWN RESULT, never off the message. `status !== 0` is also true
 * when `status === null` because the process was KILLED BY A SIGNAL — an OOM kill, a stray
 * `pkill`, a shard reaped under load — and `util.ts run()` only throws for `error` (ENOENT and the
 * 120 s timeout). Measured before this guard: a SIGKILLed agbcc produced literally
 * `"agbcc failed: "`, which the negative-entry guard matched, and the next healthy run served that
 * rejection for a TU that compiles.
 */
export function stepFailed(
  tool: 'cpp' | 'agbcc' | 'as',
  r: { status: number | null; signal?: NodeJS.Signals | null; stderr: string },
): never {
  if (r.status === null) {
    throw new Error(
      `${tool} did not run to completion (killed by ${r.signal ?? 'a signal'}) — transient, not a rejection`,
    );
  }
  const d = compilerDiagnostics(r.stderr);
  if (d.trim() === '') {
    // A compiler that exits nonzero and says nothing did not diagnose anything; the precedent is
    // apps/benchmark/src/cache.ts, which refuses to cache an empty m2c answer for the same reason.
    throw new Error(`${tool} exited ${r.status} with no diagnostic — transient, not a rejection`);
  }
  throw new Error(`${tool} failed: ${d}`);
}

/** .i → agbcc → .s (asmlift ARM input) with the canonical .text/.align tail → as → .o. */
function assemble(iPath: string, sPath: string, oPath: string): void {
  const cc = run(TOOLCHAIN.agbcc, [iPath, '-o', sPath, ...TOOLCHAIN.agbccFlags]);
  if (cc.status !== 0) {
    stepFailed('agbcc', cc);
  }
  writeFileSync(sPath, readFileSync(sPath, 'utf8') + '\n.text\n\t.align\t2, 0\n');
  const as = run(TOOLCHAIN.as, [...TOOLCHAIN.asFlags, sPath, '-o', oPath]);
  if (as.status !== 0) {
    stepFailed('as', as);
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
  // `toolchainFileChain` is what makes a bare command name an identity. Hashing the file a name
  // resolves to STOPS ONE LEVEL SHORT: on the machine this was found on, `cpp` is a 208-byte
  // `#!/bin/sh` shim that execs Homebrew's `cpp-14`, and `arm-none-eabi-cpp` is a driver binary
  // that execs `libexec/gcc/arm-none-eabi/14.2.1/cc1` — neither delegate was in the namespace, and
  // repointing one served a stale object with the outer file byte-identical. The chain follows
  // both, and REFUSES (throws) where it cannot follow.
  return [
    ...toolchainFileChain(TOOLCHAIN.agbcc),
    ...toolchainFileChain(TOOLCHAIN.as),
    ...toolchainFileChain('arm-none-eabi-cpp'),
    ...SHAPING_SOURCES,
  ];
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
  // 'bench-agbcc/v2' is FORMAT SALT, not a version lever, and it must never be bumped as one:
  // this function lives inside agbcc.ts, whose own bytes it hashes, so a change to the pipeline
  // re-namespaces by MEASUREMENT already. Bumping a constant instead of adding the missing input
  // to candCacheNamespaceFiles() is the whole class of bug this round closed. Change it only if
  // the digest's LAYOUT changes and old entries must be abandoned wholesale.
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
  // Two DIFFERENT directories, and REMOVED afterwards: mkdtemp cleans up nothing, and util.ts's
  // `scratchSlot` exists precisely because that leak "had accumulated into the millions".
  const dirA = mkdtempSync(join(tmpdir(), 'bench-ccstampA-'));
  const dirB = mkdtempSync(join(tmpdir(), 'bench-ccstampB-'));
  const a = stampProbeIn(dirA);
  const b = stampProbeIn(dirB);
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  if (a === null || b === null || a !== b) {
    return NOT_CACHEABLE;
  }
  return createHash('sha256').update(candCacheStaticStamp()).update(a).digest('hex');
});

/** The message shape a DETERMINISTIC rejection has, and nothing else does. `\\S` is not
 *  decoration: a SIGKILLed compiler used to produce exactly `"agbcc failed: "`, which the older
 *  `/^(cpp|agbcc|as) failed: /` matched. `stepFailed` is the real guard; this is the second one. */
export const DETERMINISTIC_REJECTION = /^(cpp|agbcc|as) failed: \S/;

/** A per-key refusal is a fact about the emitter, not about this candidate, so it is worth saying
 *  — once per reason, not 65,280 times. */
const saidRefusals = new Set<string>();
function noteKeyRefusal(reason: string): void {
  if (saidRefusals.has(reason) || cache.mode === 'off') {
    return;
  }
  saidRefusals.add(reason);
  process.stderr.write(`[candcache] REFUSED-KEY label=bench-agbcc reason=${reason}\n`);
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
    // A candidate TU whose object is not a function of its own bytes is refused PER KEY, and the
    // reason is said once. Two shapes: a TU that reads a file (the path is in the TU, not in any
    // flag, and no probe exercises it — MEASURED: with `CPATH` pointing at a directory, editing
    // the included header between two cache-on runs served 7143fac350d6311b where the truth is
    // 7430abf1c6ff95bc), and a TU that bakes its own path or the clock in through `__FILE__` /
    // `__DATE__`. Today no candidate carries either (0 of 65,281 LBG sources), so the refusal
    // costs nothing and stops the day an emitter change arms it.
    const refusal = candidateCacheRefusal(tu);
    if (refusal) {
      noteKeyRefusal(refusal);
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
      // A negative entry is only sound for a DETERMINISTIC rejection — the compiler ran, exited
      // nonzero AND diagnosed something (`stepFailed` above is where that is decided, off the
      // spawn result rather than off the message). `util.ts run()` throws `spawnFailure` for a
      // missing binary or the 120 s timeout. Caching any of those would silently drop a candidate
      // on every future run, the failure mode this repo calls a silent wrong answer.
      const m = (e as Error).message;
      if (cache.mode !== 'off' && DETERMINISTIC_REJECTION.test(m)) {
        // verifyFail FIRST: under `verify` a stored OBJECT for a TU that no longer compiles is a
        // mismatch, and it is the direction that was audited by nothing at all.
        cache.verifyFail(tu, sym, m);
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
    stepFailed('cpp', cpp);
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
