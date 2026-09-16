// CodeWarrior / PowerPC (GameCube, Docker) — real-tier target build, candidate compile, and the
// vendor-time preprocessing of a project's include tree.
//
// Every step runs mwcceppc-via-wibo inside the linux/386 container, through the same pooled helper
// the synthetic tier compiles with (@asmlift/toolchains' `ppcCompile`) — with ONE difference, and it
// is the whole reason this module exists rather than reusing `compilePpcTarget`: the synthetic tier
// prepends `C_TYPEDEFS` to its source, and a real row's translation unit arrives already
// preprocessed against the project's own headers, which declare its types themselves.
//
// PREPROCESSING is the other half. The GBA and N64 projects' units go through a host `cpp`; a
// GameCube project's cannot, because its headers are written for this front end — they branch on
// `__MWERKS__` and the other macros only mwcceppc declares. So the preprocessor here is the compiler
// itself (`ppcPreprocess`), run with the checkout mounted, under the wrapper the unit's own build
// rule runs it under.
import { type MwccToolchainId, ppcCompile, ppcPreprocess, ppcSectionScoped } from '@asmlift/toolchains';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { unitCompileWrapper } from '../cases/dtk-project';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir } from './util';

/** The CodeWarrior binary, as a project's own build rule names it. */
const MWCCEPPC = 'mwcceppc.exe';

/** The `-lang` word mwcceppc must be handed to read this unit in the dialect its own build reads it
 *  in — stated ALWAYS, never left to the front end's default.
 *
 *  That default is the source file's extension, and the translation unit is written here as `u.c`
 *  because a preprocessed blob has no project filename. Left implicit, every unit would be read as
 *  C and a C++ unit's headers would take the `#ifdef __cplusplus` branch the project's own build
 *  does not. The extension would be the wrong signal even under the real name: 62 of Animal
 *  Crossing's units are `.c` files its build compiles with `-lang=c++`.
 *
 *  The unit's flags are the signal. Where they name no language — 57 Pikmin units — the unit's own
 *  extension is what mwcc itself would have used, so that is what gets said out loud. The last
 *  `-lang` wins, as it does on the command line. */
function unitLang(cfg: RealProjectCfg): string {
  const stated = cfg.cflags.filter((f) => f.startsWith('-lang=')).at(-1);
  return stated ?? (/\.(cc|cp|cpp|cxx)$/i.test(cfg.unit) ? '-lang=c++' : '-lang=c');
}

/** Compile one source in `dir`, mapping a container or compiler failure onto the `<tool> failed:
 *  <diagnostic>` shape the evaluator turns into a row's error markers. */
function compile(
  mwcc: MwccToolchainId,
  dir: string,
  srcName: string,
  objName: string,
  cflags: readonly string[],
  disasm: boolean,
): string {
  try {
    return ppcCompile(mwcc, dir, srcName, objName, cflags, disasm);
  } catch (e) {
    throw new Error(`mwcceppc failed: ${compilerDiagnostics((e as Error).message)}`);
  }
}

/** The real tier for ONE CodeWarrior build. Three of them compile GameCube rows and they differ in
 *  codegen, so the build is bound here rather than defaulted: a row's target and its candidates
 *  must be the same compiler, and a scratch directory keyed by flags and text alone would let two
 *  builds share one. */
export const mwccReal = (mwcc: MwccToolchainId): RealCompile => ({
  buildTarget(iText, sym, cflags): BuiltTarget {
    const dir = contentDir('ppc', [mwcc, ...cflags], iText);
    writeFileSync(join(dir, 'u.c'), iText);
    const asm = compile(mwcc, dir, 'u.c', 'u.o', cflags, true);
    // A project unit is exactly where a translation unit gets several `.text` sections, all at
    // address 0: the decompiler reads the one that defines this row's function.
    return { obj: join(dir, 'u.o'), asm: ppcSectionScoped(mwcc, dir, 'u.o', sym, asm) };
  },
  compileCandidate(tu, sym, cflags): string {
    // ONE DIRECTORY PER CANDIDATE, leak and all — the rule kmc.ts and gcc272.ts follow, for the same
    // measured reason: a path reused across compiles that the container reaches through the shared
    // /tmp mount fails ~30% of the time with `c.o: No such file or directory`.
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-cand-'));
    writeFileSync(join(dir, 'c.c'), stripPrototype(tu, sym));
    compile(mwcc, dir, 'c.c', 'c.o', cflags, false);
    return join(dir, 'c.o');
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-vendor-'));
    writeFileSync(join(dir, 'u.c'), tu);
    return ppcPreprocess({
      mwcc,
      root: cfg.root,
      srcPath: join(dir, 'u.c'),
      outPath: join(dir, 'u.i'),
      argv: [...cfg.cppIncludes, ...(cfg.defines ?? []), unitLang(cfg)],
      wrapper: unitCompileWrapper(cfg.root, cfg.unit, MWCCEPPC),
    });
  },
});
