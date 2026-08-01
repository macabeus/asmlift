// Vendor the real tier's compiler inputs: for every manifest
// function, preprocess its translation unit against the LIVE project checkout and commit the
// result — the exact bytes the compiler consumes. The runner (and CI) then needs no project
// checkouts, no submodules, no generated headers and no upstream pins: the dataset is
// self-contained. Re-run `bench vendor` deliberately when a project state should change.
//
// Two blobs per function, gzip'd under dataset/real/tu/<project>/:
//   <sym>.i.gz      — the preprocessed TARGET TU (headers + prependC + function)
//   ctx-<sha12>.i.gz — the preprocessed CONTEXT (headers + prependC, no function), deduped by
//                      content (most functions of a project share one context); the candidate
//                      scorer's richest strategy compiles against it
// plus index.json (sym → blobs) and PROVENANCE.json (project commit, dirty flag, cpp version).
//
// Preprocessing uses -P (no linemarkers): vendored blobs must carry NO machine paths — enforced
// here and by test/real-manifests.test.ts.
import { loadSymbolMap } from '@asmlift/cli/symbols-provider';
import { type AddressMacro, addressCastMacros } from '@asmlift/core/macros';
import { type SymbolInfo, type SymbolMap, symbolMapToJson } from '@asmlift/core/symbols';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { sha } from '../cache';
import { makeTU, realCompilerFor } from '../compile/real';
import type { RealProjectCfg } from '../compile/types';
import { CPP } from '../config';
import { enforceCheckoutPin } from './checkout';
import { REAL_DIR, type RealManifest, loadManifestsForVendor, resolveProjectRoot } from './manifests';
import { resolveProjectElf } from './project-elf';

const MACHINE_PATH = /\/Users\/|\/home\/|\/private\/var\//;

/** The project's address-cast macros, from ITS OWN headers under ITS OWN preprocessor flags.
 *
 *  `cpp -dD` keeps the `#define`s alongside the expansion, so this sees exactly the macros a
 *  compile of this project sees — no header globbing, no guessing at include order. Recognition
 *  and every refusal live in core (`addressCastMacros`); this only supplies the text.
 *
 *  Best-effort by design: a project whose headers do not preprocess cleanly on their own simply
 *  contributes no macros, exactly as a project with no ELF contributes no map. */
function projectMacros(man: RealManifest, root: string): Map<number, AddressMacro> {
  const dir = mkdtempSync(join(tmpdir(), 'bench-macros-'));
  const cPath = join(dir, 'macros.c');
  writeFileSync(cPath, man.headers.map((h) => `#include "${h}"\n`).join(''));
  const cpp = spawnSync(CPP, ['-P', '-dD', ...man.cppIncludes, ...(man.defines ?? []), cPath], {
    cwd: root,
    encoding: 'utf8',
  });
  if (cpp.status !== 0) {
    console.warn(`${man.project}: headers did not preprocess for macro extraction — no macro names vendored`);
    return new Map();
  }
  return addressCastMacros(cpp.stdout);
}

/** THE vendored map, built from a project's two sources: its ELF (names + declaration shapes)
 *  and its headers (address-cast macro names). Exported because the fidelity gate re-derives the
 *  map to hold the vendored blob honest — it must build it the SAME way or every macro-bearing
 *  project reports permanent drift. One builder, so the two cannot disagree. */
export async function buildVendoredMap(man: RealManifest, root: string, elf: string): Promise<SymbolMap> {
  const map = await loadSymbolMap(elf);
  // Address-cast macros join the map as the CANONICAL name at their address. They are
  // source-faithful where a symtab name is not: these projects reach the cell through the macro,
  // and the macro is what makes the compiler emit the numeric pool word the target shows. The
  // symtab name stays as an alias, and the `/raw-globals` sibling still enumerates, so the differ
  // keeps refereeing.
  for (const [addr, mac] of projectMacros(man, root)) {
    const info: SymbolInfo = {
      name: mac.name,
      kind: 'data',
      declared: true,
      shape: 'scalar',
      size: mac.size,
      signed: mac.signed,
      macroBody: mac.body,
    };
    const prior = map.get(addr);
    map.set(addr, prior ? [info, ...prior] : [info]);
  }
  return map;
}

/** Vendor the project's symbol map (symbol-map-benchmark-plan-2026-07-23.md): the checkout's
 *  own decomp.yaml names its ELF (tools.asmlift.elf); the derived name/shape map is project
 *  METADATA (ldscript + headers), vendorable where the ELF itself (game code) is not. */
async function vendorSymbols(man: RealManifest, root: string, outDir: string): Promise<void> {
  const project = man.project;
  // resolveProjectElf builds a missing derived ELF via the checkout's own `make asmlift-elf`
  // target when it has one (the sidecar projects) — logged; a failed/absent build keeps
  // today's loud warn-and-skip.
  const res = resolveProjectElf(project, root);
  if (res.elf === null) {
    if (res.elfRel === null) {
      return; // project doesn't expose an ELF — no symbol map, rows run as before
    }
    console.warn(`${project}: tools.asmlift.elf points at ${res.elfRel} but ${res.reason} — symbols NOT vendored`);
    return;
  }
  const map = await buildVendoredMap(man, root, res.elf);
  const json = JSON.stringify(symbolMapToJson(map));
  writeFileSync(join(outDir, 'symbols.json.gz'), gzipSync(Buffer.from(json), { level: 9 }));
  console.log(`${project}: vendored symbol map (${map.size} addresses)`);
}

export async function vendor(filterProject?: string): Promise<void> {
  const manifests = loadManifestsForVendor().filter((m) => !filterProject || m.project === filterProject);
  for (const man of manifests) {
    // the vendored dataset must be reproducible from the pinned branch — a drifted checkout
    // fails loud here (ASMLIFT_ALLOW_DIRTY_CHECKOUT=1 downgrades to a warning for WIP machines)
    enforceCheckoutPin(man, 'vendor');
    const root = resolveProjectRoot(man);
    const cfg: RealProjectCfg = {
      project: man.project,
      toolchain: man.toolchain,
      root,
      cppIncludes: man.cppIncludes,
      headers: man.headers,
      defines: man.defines,
    };
    const rc = realCompilerFor(man.toolchain);
    const outDir = join(REAL_DIR, 'tu', man.project);
    mkdirSync(outDir, { recursive: true });
    const index: Record<string, { tu: string; ctx: string }> = {};
    const ctxSeen = new Map<string, string>(); // content sha → file name
    let done = 0;
    for (const f of man.functions) {
      const tuI = rc.preprocess(cfg, makeTU(cfg, f.prependC ?? '', f.funcC));
      const ctxI = rc.preprocess(cfg, makeTU(cfg, f.prependC ?? '', ''));
      for (const [what, text] of [
        ['tu', tuI],
        ['ctx', ctxI],
      ] as const) {
        if (MACHINE_PATH.test(text)) {
          throw new Error(`${man.project}:${f.sym}: machine path leaked into the vendored ${what}`);
        }
      }
      const tuName = `${f.sym}.i.gz`;
      writeFileSync(join(outDir, tuName), gzipSync(tuI));
      const ctxSha = sha(ctxI).slice(0, 12);
      let ctxName = ctxSeen.get(ctxSha);
      if (!ctxName) {
        ctxName = `ctx-${ctxSha}.i.gz`;
        writeFileSync(join(outDir, ctxName), gzipSync(ctxI));
        ctxSeen.set(ctxSha, ctxName);
      }
      index[f.sym] = { tu: tuName, ctx: ctxName };
      done++;
    }
    const git = (args: string) => execSync(`git -C ${JSON.stringify(root)} ${args}`, { encoding: 'utf8' }).trim();
    const provenance = {
      project: man.project,
      commit: git('rev-parse HEAD'),
      dirty: git('status --porcelain') !== '',
      cpp: execSync(`${CPP} --version`, { encoding: 'utf8' }).split('\n')[0],
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    writeFileSync(join(outDir, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
    console.log(`${man.project}: vendored ${done} TUs (${ctxSeen.size} unique context(s)) → ${outDir}`);
    await vendorSymbols(man, root, outDir);
  }
}
