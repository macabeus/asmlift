// @asmlift/toolchains — AsmData extraction for the pinned toolchains.
//
// The Regime-B jump table lives in a DATA section + relocations that `objdump -d` never shows.
// Extract it ONCE from the SAME object the compile* helpers already produced, via a single
// companion `objdump -s -r -t` (section bytes + all relocations + symbols; NO `-j`, so the `.text`
// relocs needed to locate the table base are included). The output is header-gated, so the one
// dump feeds all three parsers safely. MIPS-N64 and PPC are big-endian (the only Regime-B
// consumers). Validated against IDO/KMC/mwcc.
//
// (The CLI's .o input has its own PATH-based extraction in @asmlift/cli/objfile — user surface,
// no Docker. This module serves the benchmark/tests, sharing compile.ts's container pool.)
import { type AsmData, parseAsmData } from '@asmlift/core/frontend/asmdata';
import type { TargetDescription } from '@asmlift/core/target';
import { copyFileSync, rmSync } from 'node:fs';

import { hostTmp, mkShareableTmp, poolExec, ppcPoolCfg, run } from './compile';
import { GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN } from './toolchain';

/** A DUMP THAT SUCCEEDED AND SAID NOTHING IS A FAILURE THAT DID NOT SAY SO. `objdump -s -r -t`
 *  always prints at least its `file format` header, so empty stdout on exit 0 is a dump step that
 *  died quietly — a container that never ran the binary, a truncated pipe. Downstream nothing
 *  notices: `parseAsmData` of nothing is a well-formed EMPTY AsmData (no sections, no relocs, no
 *  symbols), so asmlift lifts a Regime-B jump table it cannot see and m2c's normalizer emits no
 *  data section, both silently and both forever once a content-keyed cache has stored it.
 *
 *  The refusal lives HERE, at the one producer all three extractors and both cache consumers go
 *  through, rather than at any one of them — the same failure reached the reference-build cache as
 *  a zero-byte `.s` and surfaced days later in another module as an unparseable objdump. */
function nonEmptyDump(text: string, what: string): string {
  if (text.trim() === '') {
    throw new Error(`${what} exited 0 but produced NO output — refusing an empty dump`);
  }
  return text;
}

/** Raw `objdump -s -r -t` text for a MIPS object (native objdump — only compilation is
 *  containerized). */
export function mipsObjdumpText(obj: string, objdumpBin: string): string {
  const d = run(objdumpBin, ['-s', '-r', '-t', obj]);
  if (d.status !== 0) {
    throw new Error(`objdump (asmdata) failed: ${d.stderr}`);
  }
  return nonEmptyDump(d.stdout, `objdump (asmdata) on ${obj}`);
}

/** Extract AsmData from a MIPS object. */
export function extractMipsAsmData(obj: string, objdumpBin: string): AsmData {
  const dump = mipsObjdumpText(obj, objdumpBin);
  return parseAsmData(dump, dump, dump, true);
}

/** Raw `objdump -s -r -t` text for a PPC (mwcc) object — the PowerPC objdump lives inside the
 *  linux/386 container. The pool only mounts /tmp, so an object living elsewhere (e.g. a
 *  repo-local cache dir) is COPIED into a /tmp scratch first: a pooled exec costs ~0.2 s where
 *  the one-shot `docker run` fallback costs ~1.8 s, and this runs once per PPC benchmark row.
 *  Exported so the benchmark can cache this text by object content (apps/benchmark/src/cache.ts). */
export function ppcObjdumpText(obj: string): string {
  const t = MWCC_PPC_TOOLCHAIN;
  let poolPath = hostTmp(obj);
  let scratch: string | null = null;
  if (!poolPath) {
    scratch = mkShareableTmp('asmlift-ppcdump-');
    const copy = `${scratch}/a.o`;
    copyFileSync(obj, copy);
    poolPath = hostTmp(copy);
  }
  try {
    if (poolPath) {
      const { name, mounts } = ppcPoolCfg(t);
      const r = poolExec(t.docker, t.image, name, mounts, [name, t.objdump, '-s', '-r', '-t', poolPath]);
      if (r) {
        if (r.status !== 0) {
          throw new Error(`ppc objdump (asmdata) failed: ${r.stderr || r.stdout}`);
        }
        return nonEmptyDump(r.stdout, `ppc objdump (asmdata, pooled) on ${obj}`);
      }
    }
  } finally {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  // pool unavailable (ASMLIFT_DOCKER_POOL=0 / creation failed) — one-shot container on the
  // object's own directory
  const dir = obj.slice(0, obj.lastIndexOf('/')),
    base = obj.split('/').pop()!;
  const r = run(t.docker, [
    'run',
    '--rm',
    '--platform',
    'linux/386',
    '-v',
    `${dir}:/work:ro`,
    '-w',
    '/work',
    t.image,
    t.objdump,
    '-s',
    '-r',
    '-t',
    `/work/${base}`,
  ]);
  if (r.status !== 0) {
    throw new Error(`ppc objdump (asmdata) failed: ${r.stderr || r.stdout}`);
  }
  return nonEmptyDump(r.stdout, `ppc objdump (asmdata, one-shot) on ${obj}`);
}

/** Extract AsmData from a PPC (mwcc) object. */
export function extractPpcAsmData(obj: string): AsmData {
  const dump = ppcObjdumpText(obj);
  return parseAsmData(dump, dump, dump, true);
}

/** Dispatch AsmData extraction by target compiler. `undefined` for agbcc (its `.word` table is
 *  already inline in the `.s` the Thumb frontend reads) and any compiler without an extractor. */
export function extractAsmData(obj: string, target: TargetDescription): AsmData | undefined {
  switch (target.compiler) {
    case 'ido':
      return extractMipsAsmData(obj, IDO_TOOLCHAIN.objdump);
    case 'gcc':
      return extractMipsAsmData(obj, GCC_KMC_TOOLCHAIN.objdump);
    case 'mwcc':
      return extractPpcAsmData(obj);
    default:
      return undefined;
  }
}
