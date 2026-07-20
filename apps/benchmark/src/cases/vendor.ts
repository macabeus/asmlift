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
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { sha } from '../cache';
import { makeTU, realCompilerFor } from '../compile/real';
import type { RealProjectCfg } from '../compile/types';
import { CPP } from '../config';
import { REAL_DIR, loadManifestsForVendor, resolveProjectRoot } from './manifests';

const MACHINE_PATH = /\/Users\/|\/home\/|\/private\/var\//;

export function vendor(filterProject?: string): void {
  const manifests = loadManifestsForVendor().filter((m) => !filterProject || m.project === filterProject);
  for (const man of manifests) {
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
  }
}
