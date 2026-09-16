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
import { ppcCompile, ppcPreprocess, ppcSectionScoped } from '@asmlift/toolchains';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { unitCompileWrapper } from '../cases/dtk-project';
import type { BuiltTarget } from '../toolchains';
import { stripPrototype } from './agbcc';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir } from './util';

/** The CodeWarrior binary, as a project's own build rule names it. */
const MWCCEPPC = 'mwcceppc.exe';

/** Compile one source in `dir`, mapping a container or compiler failure onto the `<tool> failed:
 *  <diagnostic>` shape the evaluator turns into a row's error markers. */
function compile(dir: string, srcName: string, objName: string, cflags: readonly string[], disasm: boolean): string {
  try {
    return ppcCompile(dir, srcName, objName, cflags, disasm);
  } catch (e) {
    throw new Error(`mwcceppc failed: ${compilerDiagnostics((e as Error).message)}`);
  }
}

export const mwccReal: RealCompile = {
  buildTarget(iText, sym, cflags): BuiltTarget {
    const dir = contentDir('ppc', cflags, iText);
    writeFileSync(join(dir, 'u.c'), iText);
    const asm = compile(dir, 'u.c', 'u.o', cflags, true);
    // A project unit is exactly where a translation unit gets several `.text` sections, all at
    // address 0: the decompiler reads the one that defines this row's function.
    return { obj: join(dir, 'u.o'), asm: ppcSectionScoped(dir, 'u.o', sym, asm) };
  },
  compileCandidate(tu, sym, cflags): string {
    // ONE DIRECTORY PER CANDIDATE, leak and all — the rule kmc.ts and gcc272.ts follow, for the same
    // measured reason: a path reused across compiles that the container reaches through the shared
    // /tmp mount fails ~30% of the time with `c.o: No such file or directory`.
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-cand-'));
    writeFileSync(join(dir, 'c.c'), stripPrototype(tu, sym));
    compile(dir, 'c.c', 'c.o', cflags, false);
    return join(dir, 'c.o');
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-vendor-'));
    writeFileSync(join(dir, 'u.c'), tu);
    return ppcPreprocess({
      root: cfg.root,
      srcPath: join(dir, 'u.c'),
      outPath: join(dir, 'u.i'),
      argv: [...cfg.cppIncludes, ...(cfg.defines ?? [])],
      wrapper: unitCompileWrapper(cfg.root, cfg.unit, MWCCEPPC),
    });
  },
};
