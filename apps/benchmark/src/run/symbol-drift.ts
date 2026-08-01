// The symbol-map half of the fidelity gate: the vendored map (dataset/real/tu/<p>/
// symbols.json.gz) claims to be DERIVED from the checkout's own decomp.yaml ELF — so before
// certifying the published rows, re-derive it and hold the two equal by hash. Any drift means
// the published symbol-fed rows no longer describe the pinned project state: fail loud naming
// the remedy (`bench vendor --project <p>`). The comparison is over the DECOMPRESSED JSON
// (symbolMapToJson is byte-stable: hex keys sorted, array order preserved — the exact bytes
// vendor wrote); gzip envelopes vary by compressor and never participate.
import { symbolMapToJson } from '@asmlift/core/symbols';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { allowDirtyCheckout } from '../cases/checkout';
import { REAL_DIR, type RealManifest, resolveProjectRoot } from '../cases/manifests';
import { resolveProjectElf } from '../cases/project-elf';
import { buildVendoredMap } from '../cases/vendor';

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** The project's vendored symbol-map blob, when it has one. */
export function vendoredMapPath(project: string): string | null {
  const p = join(REAL_DIR, 'tu', project, 'symbols.json.gz');
  return existsSync(p) ? p : null;
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

/** Fidelity pre-step for one project with a vendored map: re-derive from the checkout's
 *  decomp.yaml ELF (building it via `make asmlift-elf` when the checkout exposes the target)
 *  and compare hashes. Unverifiable or drifted ⇒ loud error — downgraded to a warning by
 *  ASMLIFT_ALLOW_DIRTY_CHECKOUT=1 (the same WIP-machine escape hatch the checkout pin uses). */
export async function checkSymbolMapDrift(man: RealManifest): Promise<void> {
  const vendoredPath = vendoredMapPath(man.project);
  if (!vendoredPath) {
    return; // project vendors no symbol map — nothing to hold
  }
  const complain = (msg: string): void => {
    if (allowDirtyCheckout()) {
      console.warn(`WARN fidelity: ${msg} — allowed by ASMLIFT_ALLOW_DIRTY_CHECKOUT=1`);
    } else {
      throw new Error(`fidelity: ${msg}`);
    }
  };
  const res = resolveProjectElf(man.project, resolveProjectRoot(man));
  if (res.elf === null) {
    complain(`${man.project}: vendored symbol map is UNVERIFIABLE — ${res.reason}`);
    return;
  }
  const derived = JSON.stringify(symbolMapToJson(await buildVendoredMap(man, resolveProjectRoot(man), res.elf)));
  const vendored = gunzipSync(readFileSync(vendoredPath)).toString('utf8');
  const drift = symbolMapDrift(vendored, derived);
  if (drift) {
    complain(`${man.project}: symbol map DRIFTED (${drift}) — re-run \`pnpm bench vendor --project ${man.project}\``);
  } else {
    console.log(
      `fidelity: ${man.project} symbol map verified against ${res.elfRel} (${sha256(vendored).slice(0, 12)}…)`,
    );
  }
}
