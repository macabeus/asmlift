// Vendor the real tier's compiler inputs: for every manifest
// function, preprocess its translation unit against the LIVE project checkout and commit the
// result — the exact bytes the compiler consumes. The runner (and CI) then needs no project
// checkouts, no submodules, no generated headers and no upstream pins: the dataset is
// self-contained. Re-run `bench vendor` deliberately when a project state should change.
//
// Blobs per function, gzip'd under dataset/real/tu/<project>/:
//   <sym>.i.gz      — the preprocessed TARGET TU (`rowSources`)
//   ctx-<sha12>.i.gz — the preprocessed CONTEXT (the TU without the function), deduped by
//                      content (most functions of a project share one context); the candidate
//                      scorer's richest strategy compiles against it — and the context m2c reads
//                      (compile/real.ts `m2cContext`), which is the same file unless CodeWarrior
//                      preprocessed it
// plus index.json (sym → blobs) and PROVENANCE.json (project commit, dirty flag, cpp version).
//
// Preprocessing uses -P (no linemarkers): vendored blobs must carry NO machine paths, and a target TU the
// manifest assembles must declare every function it calls — enforced here, and by
// test/real-manifests.test.ts and test/implicit-declarations.test.ts over the committed blobs.
//
// Every row is proved before anything is written: its unit's stored flags must be the flags derived
// from the build at the checkout's HEAD, and its target, compiled at them, must be the function the
// project's linked ELF holds at the row's address. The proof is stored as the row's `romDigest`,
// which the runner's `build()` checks; a project with any refused row writes nothing.
//
// A row keyed by a REL MODULE LOCATION is compared with its MODULE's ELF rather than the linked one,
// which holds no module's bytes (cases/rom-function `romLocation`); before that it is proved to be
// where it says it is — its module ELF defines that symbol at that section and offset — so a wrong
// location is refused by name rather than as a byte difference.
import { moduleLocation, moduleOf } from '@asmlift/bench-schema';
import { moduleFunctionLocations } from '@asmlift/cli/module-elf';
import { loadModuleSymbolMap, loadSymbolMap } from '@asmlift/cli/symbols-provider';
import { unitLanguage } from '@asmlift/core/codegen-flags';
import { type SymbolMap, symbolMapToJson } from '@asmlift/core/symbols';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { sha } from '../cache';
import { buildRealTarget, m2cContext, makeTU, realCompilerFor } from '../compile/real';
import type { RealProjectCfg } from '../compile/types';
import { CPP } from '../config';
import { enforceCheckoutPin, git } from './checkout';
import { citedFile, flagsStatus, unitDeriver } from './derive-flags';
import {
  MODULE_MAP_DIR,
  REAL_DIR,
  type RealFunction,
  type RealManifest,
  type VendoredEntry,
  loadManifestsForVendor,
  resolveProjectRoot,
  rewriteManifest,
  vendoredMapFile,
} from './manifests';
import { placedModuleElves, resolveProjectElf } from './project-elf';
import { compareWithRom, romLocation } from './rom-function';

const MACHINE_PATH = /\/Users\/|\/home\/|\/private\/var\//;

/** A row's two texts before preprocessing: its translation unit, and the context its candidates compile in
 *  — the same text without the function. What the translation unit IS is the manifest's `tu`:
 *
 *    assembled  `headers`, `prependC`, `funcC`.
 *    unit       the row's unit (`readUnit`) through the last line `sourceUrl` cites. Its context is the unit
 *               before the first. Throws unless those lines are `funcC` verbatim — a permalink citing lines
 *               that are not the row's function is refused here rather than published.
 */
export function rowSources(
  tu: RealManifest['tu'],
  cfg: RealProjectCfg,
  f: Pick<RealFunction, 'sym' | 'funcC' | 'prependC' | 'sourceUrl'>,
  readUnit: () => string,
): { tu: string; ctx: string } {
  if (tu === 'assembled') {
    return { tu: makeTU(cfg, f.prependC ?? '', f.funcC), ctx: makeTU(cfg, f.prependC ?? '', '') };
  }
  const span = /#L(\d+)-L(\d+)$/.exec(f.sourceUrl ?? '');
  if (span === null) {
    throw new Error(`${f.sym}: its sourceUrl cites no line span`);
  }
  const [first, last] = [Number(span[1]), Number(span[2])];
  const lines = readUnit().split('\n');
  if (lines.slice(first - 1, last).join('\n') !== f.funcC) {
    throw new Error(`${f.sym}: funcC is not lines ${first}-${last} of ${cfg.unit}, which its sourceUrl cites`);
  }
  return { tu: `${lines.slice(0, last).join('\n')}\n`, ctx: `${lines.slice(0, first - 1).join('\n')}\n` };
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
  const write = (path: string, m: SymbolMap): void =>
    writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(symbolMapToJson(m))), { level: 9 }));
  const map = await loadSymbolMap(res.elf);
  write(vendoredMapFile(outDir, undefined), map);
  console.log(`${project}: vendored symbol map (${map.size} addresses)`);

  // ONE MAP PER REL MODULE THAT HAS ROWS. A module's code refers to the module's own symbols, so a
  // REL row is read with the module's map — its symbols, placed, over the base ELF's globals
  // (cli/symbols-provider `loadModuleSymbolMap`) — and never with a map of every module at once:
  // merged, name lookup is ambiguous at 62.8% of Mario Party 4's 324,965 REL relocation sites, and
  // `asIfUndecompiled(map, 'ObjectSetup')` would strip the facts of 90 modules' functions.
  //
  // The directory is REBUILT, not added to: a module whose last row left must not keep a map that
  // nothing checks and nothing reads.
  const moduleDir = join(outDir, MODULE_MAP_DIR);
  rmSync(moduleDir, { recursive: true, force: true });
  const modules = [...new Set(man.functions.map((f) => moduleOf(f.addr)))].filter((m) => m !== undefined).sort();
  if (modules.length === 0) {
    return;
  }
  mkdirSync(moduleDir, { recursive: true });
  for (const module of modules) {
    const mod = resolveProjectElf(project, root, module);
    if (mod.elf === null) {
      throw new Error(`${project}: rows live in module ${module}, but ${mod.reason}`);
    }
    const moduleMap = await loadModuleSymbolMap(mod.elf, res.elf);
    write(vendoredMapFile(outDir, module), moduleMap);
    console.log(`${project}: vendored ${module}'s symbol map (${moduleMap.size} addresses, over ${res.elfRel})`);
  }
}

/** THE DECISION a module-located row is proved by, over the places its module puts `sym`
 *  ({@link moduleFunctionLocations}): null when one of them is exactly the row's section AND
 *  offset, a refusal line naming the real ones otherwise.
 *
 *  Both halves matter and neither is checkable anywhere else. The SECTION because a symbol map
 *  records a section INDEX and not a name. The MODULE because `loadModuleSymbolMap` unions the
 *  base ELF's globals into every module's map at their real addresses, so a DOL function answers
 *  to any module's name there — here it is simply not among the module's own functions.
 *
 *  Exported as the testable core: the prover around it only resolves and reads a file. */
export function moduleIdentityRefusal(
  sym: string,
  addr: string,
  at: readonly { section: string; offset: number }[],
): string | null {
  const loc = moduleLocation(addr)!;
  if (at.some((p) => p.section === loc.section && p.offset === loc.offset)) {
    return null;
  }
  const where = (p: { section: string; offset: number }) => `${p.section}+0x${p.offset.toString(16).padStart(8, '0')}`;
  return at.length === 0
    ? `${sym}: ${addr} — ${loc.module} defines no function ${sym}`
    : `${sym}: ${addr} — ${loc.module} puts ${sym} at ${at.map(where).join(', ')}`;
}

/** {@link moduleIdentityRefusal} against the checkout: resolves each module's own ELF and reads it
 *  once — Animal Crossing's is 19 MB and every row of a project shares one. */
function moduleIdentityProver(project: string, root: string): (sym: string, addr: string) => string | null {
  const byModule = new Map<string, ReturnType<typeof moduleFunctionLocations> | string>();
  const read = (module: string): ReturnType<typeof moduleFunctionLocations> | string => {
    const mod = resolveProjectElf(project, root, module);
    return mod.elf === null
      ? `${project}: rows live in module ${module}, but ${mod.reason}`
      : moduleFunctionLocations(readFileSync(mod.elf));
  };
  return (sym, addr) => {
    const module = moduleOf(addr)!;
    if (!byModule.has(module)) {
      byModule.set(module, read(module));
    }
    const found = byModule.get(module)!;
    return typeof found === 'string' ? found : moduleIdentityRefusal(sym, addr, found.get(sym) ?? []);
  };
}

/** Write each row's TU blob and its context blob, one file per distinct context, into `outDir`, and remove
 *  every blob there this vendoring did not write: a row that left, or a context that changed, must not keep
 *  a file nothing reads. Returns the index `index.json` records and how many contexts were written. */
export function writeVendoredBlobs(
  outDir: string,
  prepared: readonly { sym: string; tuI: string; ctxI: string; m2cI: string }[],
): { index: Record<string, VendoredEntry>; contexts: number } {
  mkdirSync(outDir, { recursive: true });
  const index: Record<string, VendoredEntry> = {};
  const ctxSeen = new Map<string, string>(); // content sha → file name
  const contextFile = (text: string): string => {
    const ctxSha = sha(text).slice(0, 12);
    let name = ctxSeen.get(ctxSha);
    if (!name) {
      name = `ctx-${ctxSha}.i.gz`;
      writeFileSync(join(outDir, name), gzipSync(text));
      ctxSeen.set(ctxSha, name);
    }
    return name;
  };
  for (const { sym, tuI, ctxI, m2cI } of prepared) {
    const tuName = `${sym}.i.gz`;
    writeFileSync(join(outDir, tuName), gzipSync(tuI));
    index[sym] = { tu: tuName, ctx: contextFile(ctxI), m2c: contextFile(m2cI) };
  }
  const written = new Set(Object.values(index).flatMap((e) => [e.tu, e.ctx, e.m2c]));
  for (const stale of readdirSync(outDir).filter((f) => f.endsWith('.i.gz') && !written.has(f))) {
    rmSync(join(outDir, stale));
  }
  return { index, contexts: ctxSeen.size };
}

/** `symbolsOnly`: rewrite ONLY the ELF-derived symbol map, leaving the preprocessed TUs,
 *  index.json and PROVENANCE.json byte-for-byte as committed. The two halves of the vendored
 *  dataset have DIFFERENT sources — the TUs come from cpp over the checkout's headers, the map
 *  from the checkout's ELF through this repo's own provider — so a change to the PROVIDER
 *  invalidates the map alone. Re-preprocessing 252 TUs to fix that would churn the dataset for
 *  reasons the change does not own, and would restamp `generatedAt` (and a `dirty` flag) on
 *  provenance that did not change. The fidelity drift gate (run/symbol-drift.ts) compares the
 *  map, and only the map, against a fresh derivation. */
export async function vendor(filterProject?: string, opts: { symbolsOnly?: boolean } = {}): Promise<void> {
  const manifests = loadManifestsForVendor().filter((m) => !filterProject || m.project === filterProject);
  for (const man of manifests) {
    // the vendored dataset must be reproducible from the pinned branch — a drifted checkout
    // fails loud here (ASMLIFT_ALLOW_DIRTY_CHECKOUT=1 downgrades to a warning for WIP machines)
    enforceCheckoutPin(man, 'vendor');
    const root = resolveProjectRoot(man);
    if (opts.symbolsOnly) {
      const outDir = join(REAL_DIR, 'tu', man.project);
      mkdirSync(outDir, { recursive: true });
      await vendorSymbols(man, root, outDir);
      continue;
    }
    const elf = resolveProjectElf(man.project, root);
    if (elf.elf === null) {
      throw new Error(`${man.project}: no linked ELF to prove its rows against the ROM: ${elf.reason}`);
    }
    const linked = readFileSync(elf.elf);
    const deriver = unitDeriver(man.project, root);
    const refusals: string[] = [];
    const flagsWrite = `run \`pnpm bench flags --project ${man.project} --write\``;
    for (const f of man.functions) {
      const unit = deriver.unitOf(f);
      if (f.unit !== unit) {
        refusals.push(`${f.sym}: the build compiles ${citedFile(f)} in ${unit}, not ${f.unit} — ${flagsWrite}`);
      }
    }
    for (const unit of new Set(man.functions.map((f) => f.unit))) {
      const stored = unit === undefined ? undefined : man.units?.[unit];
      if (unit === undefined || stored === undefined) {
        refusals.push(`${unit ?? 'a row'}: no stored flags — ${flagsWrite}`);
        continue;
      }
      const status = flagsStatus(stored, deriver.derive(unit, stored.toolchain));
      if (status.kind !== 'ok') {
        refusals.push(
          `${unit}: the build's flags at ${deriver.commit.slice(0, 8)} differ (${status.kind === 'DRIFT' ? status.changes.join('; ') : status.kind}) — ${flagsWrite}`,
        );
      }
    }
    if (refusals.length > 0) {
      throw new Error(`${man.project}: refused, nothing written:\n  ${refusals.join('\n  ')}`);
    }

    const outDir = join(REAL_DIR, 'tu', man.project);
    const prepared: { sym: string; tuI: string; ctxI: string; m2cI: string; romDigest: string }[] = [];
    const moduleIdentity = moduleIdentityProver(man.project, root);
    const placedModule = placedModuleElves(man.project, root);
    for (const f of man.functions) {
      const unit = man.units[f.unit];
      const cfg: RealProjectCfg = {
        project: man.project,
        toolchain: unit.toolchain,
        root,
        unit: f.unit,
        cflags: unit.cflags,
        cppIncludes: man.cppIncludes,
        headers: man.headers,
        defines: man.defines,
      };
      const rc = realCompilerFor(unit.toolchain);
      let sources: { tu: string; ctx: string };
      try {
        sources = rowSources(man.tu, cfg, f, () => readFileSync(join(root, f.unit), 'utf8'));
      } catch (e) {
        refusals.push((e as Error).message);
        continue;
      }
      const tuI = rc.preprocess(cfg, sources.tu);
      const ctxI = rc.vendoredContext(rc.preprocess(cfg, sources.ctx), unit.cflags, unitLanguage(f.unit, unit.cflags));
      for (const [what, text] of [
        ['tu', tuI],
        ['ctx', ctxI],
      ] as const) {
        if (MACHINE_PATH.test(text)) {
          throw new Error(`${man.project}:${f.sym}: machine path leaked into the vendored ${what}`);
        }
      }
      // A unit's own text declares what the project's unit declares, implicit declarations included —
      // Mario Party 4's selmenuDll/main.c declares `rand8` only `#ifndef __MWERKS__` — so only a TU the
      // manifest assembles can be missing a declaration the game's unit had.
      const undeclared =
        man.tu === 'assembled' ? rc.undeclaredCallees(tuI, unit.cflags, unitLanguage(f.unit, unit.cflags)) : [];
      if (undeclared.length > 0) {
        refusals.push(
          `${f.sym}: the vendored TU calls ${undeclared.join(', ')} with no declaration in scope — ` +
            `declare each in the row's prependC as the project's unit does`,
        );
        continue;
      }
      if (moduleOf(f.addr) !== undefined) {
        const wrong = moduleIdentity(f.sym, f.addr);
        if (wrong !== null) {
          refusals.push(wrong);
          continue;
        }
      }
      const target = buildRealTarget(unit.toolchain, f.sym, unit.cflags, tuI, unitLanguage(f.unit, unit.cflags));
      const { elf: rom, at } = romLocation(f.addr, linked, placedModule);
      const proof = compareWithRom(readFileSync(target.obj), f.sym, rom, at);
      if (!proof.equal) {
        refusals.push(
          `${f.sym} (unit ${f.unit}, ${unit.cflags.join(' ')}): not the function the ROM holds, ${proof.detail}`,
        );
        continue;
      }
      prepared.push({ sym: f.sym, tuI, ctxI, m2cI: m2cContext(unit.toolchain, ctxI), romDigest: proof.digest });
    }
    if (refusals.length > 0) {
      throw new Error(`${man.project}: refused, nothing written:\n  ${refusals.join('\n  ')}`);
    }

    const { index, contexts } = writeVendoredBlobs(outDir, prepared);
    const romDigests = new Map(prepared.map((p) => [p.sym, p.romDigest]));
    rewriteManifest(man.project, (m) => ({
      ...m,
      functions: m.functions.map((f) => ({ ...f, romDigest: romDigests.get(f.sym) ?? f.romDigest })),
    }));
    const provenance = {
      project: man.project,
      commit: git(root, ['rev-parse', 'HEAD']),
      dirty: git(root, ['status', '--porcelain']) !== '',
      cpp: execSync(`${CPP} --version`, { encoding: 'utf8' }).split('\n')[0],
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    writeFileSync(join(outDir, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
    console.log(
      `${man.project}: vendored ${prepared.length} TUs (${contexts} unique context(s)) → ${outDir}; ` +
        'every row EQ to the ROM',
    );
    await vendorSymbols(man, root, outDir);
  }
}
