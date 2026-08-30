// agbcc / ARM (GBA) — EVERY harness-side spelling of "compile C with agbcc": the real-tier
// target build, the real-tier candidate compile (same steps, shared). Flags come from
// @asmlift/toolchains; the decomp.yaml candidate command lives in
// dataset/toolchains/agbcc/decomp.yaml.
import { NOT_CACHEABLE, candCache } from '@asmlift/cli/candcache';
import { TOOLCHAIN } from '@asmlift/toolchains';
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

const cache = candCache('bench-agbcc', () => {
  const h = createHash('sha256');
  h.update('bench-agbcc/v1');
  h.update(readFileSync(TOOLCHAIN.agbcc));
  h.update(TOOLCHAIN.agbccFlags.join(' '));
  h.update(TOOLCHAIN.as + ' ' + TOOLCHAIN.asFlags.join(' '));
  h.update(run(TOOLCHAIN.as, ['--version']).stdout ?? '');
  h.update('cpp ' + CAND_CPP_FLAGS.join(' '));
  h.update(run('arm-none-eabi-cpp', ['--version']).stdout ?? '');
  // (1) the harness's own code, per the note above.
  for (const p of SHAPING_SOURCES) {
    h.update(p);
    h.update(readFileSync(p)); // throws => candCache REFUSES, loudly
  }
  // (2) DETERMINISM SELF-TEST, and the backstop object at the same time. A cached object is
  // sound only if it is a pure function of (input bytes, symbol) — which is NOT true of every
  // toolchain (`ido7.1` writes the absolute path of its input .c into the object). So compile
  // the probe TWICE, in two DIFFERENT directories, and let the compiler answer.
  const a = stampProbeIn(mkdtempSync(join(tmpdir(), 'bench-ccstampA-')));
  const b = stampProbeIn(mkdtempSync(join(tmpdir(), 'bench-ccstampB-')));
  if (a === null || b === null || a !== b) {
    return NOT_CACHEABLE;
  }
  h.update(a);
  return h.digest('hex');
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
