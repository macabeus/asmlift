// Real-project (Tier B) manifest schema + loader. A manifest is one JSON file per project under
// apps/benchmark/dataset/real/<project>.json describing how to compile that project's functions
// standalone and which functions to benchmark. Written/verified by extraction agents against the
// `bench verify` loop; consumed by the real case provider.
//
// PORTABILITY: manifests carry NO absolute paths — the project root is a workspace-relative
// directory name (`repoDir`) resolved against the sibling-checkout WORKSPACE convention,
// overridable per project via ASMLIFT_PROJ_<PROJECT> (uppercased, non-alphanumerics → _).
// Shape is VALIDATED at load time so a typo fails with the
// file name, not mid-run with a compile error; projects missing on this machine are reported
// once, aggregated, and skipped.
import type { Prototypes } from '@asmlift/core/proto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { WORKSPACE } from '../config';
import { TOOLCHAINS, type ToolchainId } from '../toolchains';

export interface RealFunction {
  sym: string;
  features: string[];
  funcC: string; // the extracted function source (verbatim from the decomp)
  sourceUrl?: string; // commit-pinned GitHub permalink to funcC's span in the project
  prependC?: string; // extra decls to prepend AFTER the project headers (rarely needed)
  ctx?: string; // m2c --context (prototypes only — no struct layouts, to match asmlift)
  /** Feed m2c the function's VENDORED project context (attribute-sanitized). Set on functions
   *  whose context-free m2c run declines on `?` placeholders — the context its real workflow
   *  would always have. The row publishes the vendored file path (ctxRef), not the text. */
  m2cCtx?: boolean;
  proto?: Prototypes; // asmlift prototypes (void-ness / callee params)
  note?: string;
}

/** The on-disk manifest shape (portable — no machine paths). */
export interface RealManifest {
  project: string;
  /** Manifest-level provenance/rationale for MAINTAINERS (why this project's extraction is
   *  structured the way it is — e.g. af's headers:[] + per-function prependC). Never published
   *  to rows; per-function `note` is the user-facing one. */
  note?: string;
  toolchain: ToolchainId;
  repoDir: string; // project checkout dir name, resolved against WORKSPACE (or ASMLIFT_PROJ_*)
  cppIncludes: string[]; // preprocessor flags (e.g. ["-nostdinc","-I","tools/agbcc/include"])
  headers: string[]; // project headers to #include so types resolve
  defines?: string[]; // extra -D macros
  functions: RealFunction[];
}

/** A manifest paired with its vendored compiler inputs (the runtime shape — no checkout). */
export interface VendoredManifest extends RealManifest {
  /** sym → gunzip'd preprocessed texts (target TU + candidate context). */
  vendored: (sym: string) => { tuI: string; ctxI: string };
  /** sym → repo-relative path of the vendored context blob (for the row's ctxRef). */
  ctxPath: (sym: string) => string;
}

export const REAL_DIR = join(import.meta.dirname, '..', '..', 'dataset', 'real');

/** ASMLIFT_PROJ_<PROJECT> override, else the sibling-checkout default. */
export function resolveProjectRoot(m: RealManifest): string {
  const envName = `ASMLIFT_PROJ_${m.project.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[envName] ?? join(WORKSPACE, m.repoDir);
}

/** Validate one manifest's shape. Returns the problems (empty = valid). */
export function validateManifest(m: unknown, file: string): string[] {
  const problems: string[] = [];
  const man = m as Partial<RealManifest>;
  if (typeof man.project !== 'string' || !man.project) {
    problems.push(`${file}: missing "project"`);
  }
  if (typeof man.toolchain !== 'string' || !(man.toolchain in TOOLCHAINS)) {
    problems.push(`${file}: unknown toolchain ${JSON.stringify(man.toolchain)}`);
  }
  if (typeof man.repoDir !== 'string' || !man.repoDir || man.repoDir.startsWith('/')) {
    problems.push(`${file}: "repoDir" must be a workspace-relative directory name (no absolute paths)`);
  }
  if (!Array.isArray(man.cppIncludes) || !Array.isArray(man.headers)) {
    problems.push(`${file}: "cppIncludes"/"headers" must be arrays`);
  }
  if (!Array.isArray(man.functions) || man.functions.length === 0) {
    problems.push(`${file}: "functions" must be a non-empty array`);
  } else {
    for (const f of man.functions) {
      if (typeof f.sym !== 'string' || typeof f.funcC !== 'string' || !Array.isArray(f.features)) {
        problems.push(`${file}: function entry missing sym/funcC/features (${JSON.stringify(f.sym)})`);
      }
    }
  }
  return problems;
}

/** Parse + validate every committed manifest. A malformed manifest throws — a typo must fail
 *  loudly at load, not surface as a mid-run compile error. */
function loadRaw(): RealManifest[] {
  let files: string[] = [];
  try {
    files = readdirSync(REAL_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    console.warn(`real tier: dataset dir unreadable (${REAL_DIR}) — no real cases`);
    return [];
  }
  return files.map((f) => {
    let man: RealManifest;
    try {
      man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
    } catch (e) {
      throw new Error(`invalid real-tier manifest ${f}: ${(e as Error).message}`);
    }
    const problems = validateManifest(man, f);
    if (problems.length > 0) {
      throw new Error(`invalid real-tier manifest:\n  ${problems.join('\n  ')}`);
    }
    return man;
  });
}

/** RUNTIME loader: manifests paired with their VENDORED compiler inputs — no project checkouts
 *  involved. A manifest without vendored blobs is skipped with one aggregated warning (run
 *  `bench vendor` where the checkouts live). */
export function loadManifests(): VendoredManifest[] {
  const available: VendoredManifest[] = [];
  const unvendored: string[] = [];
  const raw = loadRaw();
  for (const man of raw) {
    const dir = join(REAL_DIR, 'tu', man.project);
    const indexPath = join(dir, 'index.json');
    if (!existsSync(indexPath)) {
      unvendored.push(man.project);
      continue;
    }
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, { tu: string; ctx: string }>;
    available.push({
      ...man,
      vendored: (sym) => {
        const entry = index[sym];
        if (!entry) {
          throw new Error(`${man.project}:${sym}: not in the vendored index — re-run \`bench vendor\``);
        }
        return {
          tuI: gunzipSync(readFileSync(join(dir, entry.tu))).toString('utf8'),
          ctxI: gunzipSync(readFileSync(join(dir, entry.ctx))).toString('utf8'),
        };
      },
      ctxPath: (sym) => {
        const entry = index[sym];
        if (!entry) {
          throw new Error(`${man.project}:${sym}: not in the vendored index — re-run \`bench vendor\``);
        }
        return `apps/benchmark/dataset/real/tu/${man.project}/${entry.ctx}`;
      },
    });
  }
  if (unvendored.length > 0) {
    console.warn(
      `real tier: ${unvendored.length}/${raw.length} project(s) have no vendored TUs — skipped: ${unvendored.join(', ')} (run \`bench vendor\`)`,
    );
  }
  return available;
}

/** VENDOR/VERIFY loader: validated manifests, live checkouts required by the caller. */
export function loadManifestsForVendor(): RealManifest[] {
  return loadRaw();
}
