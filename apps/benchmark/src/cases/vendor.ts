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
// Preprocessing uses -P (no linemarkers): vendored blobs must carry NO machine paths, and a target TU
// must declare every function it calls — enforced here, and by test/real-manifests.test.ts and
// test/implicit-declarations.test.ts over the committed blobs.
//
// Every row is proved against the ROM before anything is written: its unit's stored flags must be the
// flags derived from the build at the checkout's HEAD, and its target, compiled at them, must be the
// function the project's linked ELF holds at the row's address. The proof is stored as the row's
// `romDigest`, which the runner's `build()` checks; a project with any refused row writes nothing.
import { loadSymbolMap } from '@asmlift/cli/symbols-provider';
import { symbolMapToJson } from '@asmlift/core/symbols';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { sha } from '../cache';
import { buildRealTarget, makeTU, realCompilerFor } from '../compile/real';
import type { RealProjectCfg } from '../compile/types';
import { CPP } from '../config';
import { enforceCheckoutPin, git } from './checkout';
import { flagsStatus, unitDeriver } from './derive-flags';
import { undeclaredCallees } from './implicit-declarations';
import { REAL_DIR, type RealManifest, loadManifestsForVendor, resolveProjectRoot, rewriteManifest } from './manifests';
import { resolveProjectElf } from './project-elf';
import { compareWithRom } from './rom-function';

const MACHINE_PATH = /\/Users\/|\/home\/|\/private\/var\//;

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
  const map = await loadSymbolMap(res.elf);
  const json = JSON.stringify(symbolMapToJson(map));
  writeFileSync(join(outDir, 'symbols.json.gz'), gzipSync(Buffer.from(json), { level: 9 }));
  console.log(`${project}: vendored symbol map (${map.size} addresses)`);
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
    const prepared: { sym: string; tuI: string; ctxI: string; romDigest: string }[] = [];
    for (const f of man.functions) {
      const unit = man.units[f.unit];
      const cfg: RealProjectCfg = {
        project: man.project,
        toolchain: unit.toolchain,
        root,
        cppIncludes: man.cppIncludes,
        headers: man.headers,
        defines: man.defines,
      };
      const rc = realCompilerFor(unit.toolchain);
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
      const undeclared = undeclaredCallees(tuI);
      if (undeclared.length > 0) {
        refusals.push(
          `${f.sym}: the vendored TU calls ${undeclared.join(', ')} with no declaration in scope — ` +
            `declare each in the row's prependC as the project's unit does`,
        );
        continue;
      }
      const target = buildRealTarget(unit.toolchain, f.sym, unit.cflags, tuI);
      const rom = compareWithRom(readFileSync(target.obj), f.sym, linked, Number.parseInt(f.addr, 16));
      if (!rom.equal) {
        refusals.push(
          `${f.sym} (unit ${f.unit}, ${unit.cflags.join(' ')}): not the function the ROM holds, ${rom.detail}`,
        );
        continue;
      }
      prepared.push({ sym: f.sym, tuI, ctxI, romDigest: rom.digest });
    }
    if (refusals.length > 0) {
      throw new Error(`${man.project}: refused, nothing written:\n  ${refusals.join('\n  ')}`);
    }

    mkdirSync(outDir, { recursive: true });
    const index: Record<string, { tu: string; ctx: string }> = {};
    const ctxSeen = new Map<string, string>(); // content sha → file name
    for (const { sym, tuI, ctxI } of prepared) {
      const tuName = `${sym}.i.gz`;
      writeFileSync(join(outDir, tuName), gzipSync(tuI));
      const ctxSha = sha(ctxI).slice(0, 12);
      let ctxName = ctxSeen.get(ctxSha);
      if (!ctxName) {
        ctxName = `ctx-${ctxSha}.i.gz`;
        writeFileSync(join(outDir, ctxName), gzipSync(ctxI));
        ctxSeen.set(ctxSha, ctxName);
      }
      index[sym] = { tu: tuName, ctx: ctxName };
    }
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
      `${man.project}: vendored ${prepared.length} TUs (${ctxSeen.size} unique context(s)) → ${outDir}; every row EQ to the ROM`,
    );
    await vendorSymbols(man, root, outDir);
  }
}
