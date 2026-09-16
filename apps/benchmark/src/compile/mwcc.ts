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
import { unitLanguage } from '@asmlift/core/codegen-flags';
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

/** The `-lang` word mwcceppc is handed to read a source in one dialect — stated ALWAYS, never left
 *  to the front end's default, and stated LAST so it overrides whatever the unit's own flags say.
 *
 *  That default is the file's extension, and every source this module writes is named `u.c` or
 *  `c.c`: neither a preprocessed blob nor a candidate has a project filename. Left implicit, a C++
 *  unit would be preprocessed against the `#ifdef __cplusplus` branch its own build does not take,
 *  its target would be built by the C front end, and its candidates would compile to unmangled
 *  symbols the mangled target has none of. */
const langFlag = (language: 'c' | 'c++'): string => `-lang=${language}`;

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
  buildTarget(iText, sym, cflags, language): BuiltTarget {
    const flags = [...cflags, langFlag(language)];
    const dir = contentDir('ppc', [mwcc, ...flags], iText);
    writeFileSync(join(dir, 'u.c'), iText);
    const asm = compile(mwcc, dir, 'u.c', 'u.o', flags, true);
    // A project unit is exactly where a translation unit gets several `.text` sections, all at
    // address 0: the decompiler reads the one that defines this row's function.
    return { obj: join(dir, 'u.o'), asm: ppcSectionScoped(mwcc, dir, 'u.o', sym, asm) };
  },
  compileCandidate(tu, sym, cflags, language): string {
    // ONE DIRECTORY PER CANDIDATE, leak and all — the rule kmc.ts and gcc272.ts follow, for the same
    // measured reason: a path reused across compiles that the container reaches through the shared
    // /tmp mount fails ~30% of the time with `c.o: No such file or directory`.
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-cand-'));
    writeFileSync(join(dir, 'c.c'), stripPrototype(tu, sym));
    compile(mwcc, dir, 'c.c', 'c.o', [...cflags, langFlag(language)], false);
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
      argv: [...cfg.cppIncludes, ...(cfg.defines ?? []), langFlag(unitLanguage(cfg.unit, cfg.cflags))],
      wrapper: unitCompileWrapper(cfg.root, cfg.unit, MWCCEPPC),
    });
  },
});
