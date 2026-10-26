// The vendored-ELF half of the fidelity gate: the vendored maps (dataset/real/tu/<p>/
// symbols.json.gz, and symbols/<module>.json.gz for each REL module that has rows) claim to be
// DERIVED from the checkout's own ELFs — so before
// certifying the published rows, re-derive them and hold each equal by hash. Any drift means
// the published symbol-fed rows no longer describe the pinned project state: fail loud naming
// the remedy (`bench vendor --project <p>`). The comparison is over the DECOMPRESSED JSON
// (symbolMapToJson is byte-stable: hex keys sorted, array order preserved — the exact bytes
// vendor wrote); gzip envelopes vary by compressor and never participate.
//
// The callee bodies frozen out of the same ELF (callee-bodies.json.gz, cases/callee-bodies.ts) are
// held the same way (`checkCalleeBodiesDrift`): re-read, with the CLI's reader, for every callee the
// file names, and compared as content. The completeness test (test/callee-bodies-complete.test.ts)
// holds the NAMES, off the committed artifact; only this holds what each body IS, so a relinked ELF,
// a debug-info bump or a change to the CLI's reader (elf-bodies.ts) that changes a body the harness
// hands is refused here by name, rather than read as a repro that does not reproduce.
import { moduleOf } from '@asmlift/bench-schema';
import { loadModuleSymbolMap, loadSymbolMap } from '@asmlift/cli/symbols-provider';
import { symbolMapToJson } from '@asmlift/core/symbols';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { type VendoredCalleeBodies, calleeBodiesJson, readVendoredCalleeBodies } from '../cases/callee-bodies';
import { calleeBodiesTarget, projectObjdump, readCalleeBodies } from '../cases/callee-bodies-elf';
import { allowDirtyCheckout } from '../cases/checkout';
import { REAL_DIR, type RealManifest, resolveProjectRoot, vendoredMapFile } from '../cases/manifests';
import { resolveProjectElf } from '../cases/project-elf';

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** The project's vendored symbol-map blob, when it has one. */
export function vendoredMapPath(project: string): string | null {
  const p = vendoredMapFile(join(REAL_DIR, 'tu', project), undefined);
  return existsSync(p) ? p : null;
}

/** EVERY map the project's rows are read with, in the order they are vendored: the project's own,
 *  then one per REL module that has rows. Paths, not contents — a map a row needs and the vendoring
 *  did not write is as much a defect as a drifted one, and both are reported by the same loop. */
export function vendoredMapPaths(man: RealManifest): { module: string | undefined; path: string }[] {
  const dir = join(REAL_DIR, 'tu', man.project);
  const modules = [...new Set(man.functions.map((f) => moduleOf(f.addr)))].filter((m) => m !== undefined).sort();
  return [undefined, ...modules].map((module) => ({ module, path: vendoredMapFile(dir, module) }));
}

/** Pure comparison over the two decompressed JSON texts: null when identical, else a
 *  human-readable mismatch (the testable core of the drift check). */
export function symbolMapDrift(vendoredJson: string | Buffer, derivedJson: string | Buffer): string | null {
  const vendored = sha256(vendoredJson);
  const derived = sha256(derivedJson);
  return vendored === derived
    ? null
    : `vendored map sha256 ${vendored.slice(0, 12)}… != re-derived ${derived.slice(0, 12)}…`;
}

/** Fidelity pre-step for one project with a vendored map: re-derive EACH of its maps — the
 *  project's, and every REL module's — from the checkout's own ELFs (building the declared one via
 *  `make asmlift-elf` when the checkout exposes the target) and compare hashes. Unverifiable,
 *  missing or drifted ⇒ loud error — downgraded to a warning by ASMLIFT_ALLOW_DIRTY_CHECKOUT=1
 *  (the same WIP-machine escape hatch the checkout pin uses). */
export async function checkSymbolMapDrift(man: RealManifest): Promise<void> {
  if (!vendoredMapPath(man.project)) {
    return; // project vendors no symbol map — nothing to hold
  }
  const complain = (msg: string): void => {
    if (allowDirtyCheckout()) {
      console.warn(`WARN fidelity: ${msg} — allowed by ASMLIFT_ALLOW_DIRTY_CHECKOUT=1`);
    } else {
      throw new Error(`fidelity: ${msg}`);
    }
  };
  const root = resolveProjectRoot(man);
  const base = resolveProjectElf(man.project, root);
  if (base.elf === null) {
    complain(`${man.project}: vendored symbol map is UNVERIFIABLE — ${base.reason}`);
    return;
  }
  const revendor = `re-run \`pnpm bench vendor --project ${man.project}\``;
  for (const { module, path } of vendoredMapPaths(man)) {
    const what = module === undefined ? `${man.project} symbol map` : `${man.project} module ${module}'s symbol map`;
    const res = module === undefined ? base : resolveProjectElf(man.project, root, module);
    if (res.elf === null) {
      complain(`${what} is UNVERIFIABLE — ${res.reason}`);
      continue;
    }
    if (!existsSync(path)) {
      complain(`${what} is MISSING, and its rows are read with it — ${revendor}`);
      continue;
    }
    const derived = JSON.stringify(
      symbolMapToJson(
        module === undefined ? await loadSymbolMap(res.elf) : await loadModuleSymbolMap(res.elf, base.elf),
      ),
    );
    const vendored = gunzipSync(readFileSync(path)).toString('utf8');
    const drift = symbolMapDrift(vendored, derived);
    if (drift) {
      complain(`${what} DRIFTED (${drift}) — ${revendor}`);
    } else {
      console.log(`fidelity: ${what} verified against ${res.elfRel} (${sha256(vendored).slice(0, 12)}…)`);
    }
  }
}

/** Pure comparison of a project's frozen callee bodies with a fresh read of the same callees: null
 *  when the content is identical, else the callees whose body (or unread-ness) differs. The
 *  `objdump` line is not compared: a release that reads every body alike decided nothing. */
export function calleeBodiesDrift(vendored: VendoredCalleeBodies, derived: VendoredCalleeBodies): string | null {
  const content = (v: VendoredCalleeBodies) => calleeBodiesJson({ ...v, objdump: null });
  if (content(vendored) === content(derived)) {
    return null;
  }
  const names = [...new Set([...Object.keys(vendored.bodies), ...vendored.unread])].sort();
  const body = (v: VendoredCalleeBodies, c: string) =>
    Object.hasOwn(v.bodies, c) ? calleeBodiesJson({ objdump: null, bodies: { [c]: v.bodies[c] }, unread: [] }) : null;
  const moved = names.filter((c) => body(vendored, c) !== body(derived, c));
  const objdump =
    vendored.objdump === derived.objdump ? '' : ` (vendored with ${vendored.objdump}, read with ${derived.objdump})`;
  return `${moved.length} callee bod${moved.length === 1 ? 'y' : 'ies'} differ: ${moved.slice(0, 8).join(', ')}${
    moved.length > 8 ? ', …' : ''
  }${objdump}`;
}

/** Fidelity pre-step for one project with vendored callee bodies: re-read, off the checkout's ELF and
 *  with the objdump `bench vendor` reads them with (cases/callee-bodies-elf.ts), every callee the
 *  frozen file names, and compare content. Unverifiable or drifted ⇒ loud error, downgraded to a
 *  warning by ASMLIFT_ALLOW_DIRTY_CHECKOUT=1 as the map check is. */
export function checkCalleeBodiesDrift(man: RealManifest): void {
  const dir = join(REAL_DIR, 'tu', man.project);
  const vendored = readVendoredCalleeBodies(man.project, dir, vendoredMapPath(man.project) !== null);
  if (vendored === undefined) {
    return; // no linked ELF: the CLI reads no bodies either
  }
  const complain = (msg: string): void => {
    if (allowDirtyCheckout()) {
      console.warn(`WARN fidelity: ${msg} — allowed by ASMLIFT_ALLOW_DIRTY_CHECKOUT=1`);
    } else {
      throw new Error(`fidelity: ${msg}`);
    }
  };
  const what = `${man.project} callee bodies`;
  const root = resolveProjectRoot(man);
  const res = resolveProjectElf(man.project, root);
  if (res.elf === null) {
    complain(`${what} are UNVERIFIABLE — ${res.reason}`);
    return;
  }
  const target = calleeBodiesTarget(man.project);
  const names = [...Object.keys(vendored.bodies), ...vendored.unread];
  let derived: VendoredCalleeBodies;
  try {
    derived =
      target === undefined
        ? { objdump: null, bodies: {}, unread: names }
        : readCalleeBodies(man.project, res, names, target, projectObjdump(root, target));
  } catch (e) {
    complain(`${what} are UNVERIFIABLE — ${(e as Error).message}`);
    return;
  }
  const drift = calleeBodiesDrift(vendored, derived);
  if (drift) {
    complain(
      `${what} DRIFTED from ${res.elfRel} (${drift}) — re-run \`pnpm bench vendor --project ${man.project} --callee-bodies-only\``,
    );
  } else {
    console.log(`fidelity: ${what} verified against ${res.elfRel} (${names.length} callees)`);
  }
}
