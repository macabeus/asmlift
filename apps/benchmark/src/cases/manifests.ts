// Real-project (Tier B) manifest schema + loader. A manifest is one JSON file per project under
// apps/benchmark/dataset/real/<project>.json describing how to compile that project's functions
// standalone and which functions to benchmark. Written/verified by extraction agents against the
// `bench verify` loop; consumed by the real case provider.
//
// PORTABILITY: manifests carry NO absolute paths — the project root is a workspace-relative
// directory name (`repoDir`), resolved in order: ASMLIFT_PROJ_<PROJECT> env override
// (uppercased, non-alphanumerics → _) > bench-owned checkout (apps/benchmark/checkouts/,
// materialized by `bench setup`) > sibling-checkout WORKSPACE dir.
// Shape is VALIDATED at load time so a typo fails with the
// file name, not mid-run with a compile error; projects missing on this machine are reported
// once, aggregated, and skipped.
import type { Prototypes } from '@asmlift/core/proto';
import { type SymbolMap, symbolMapFromJson } from '@asmlift/core/symbols';
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
  /** A HAND-WRITTEN m2c `--context` for this row: callee prototypes the project's own vendored
   *  headers happen not to declare, so `m2cCtx` alone would lose them. Held symmetric with
   *  `proto` by test/authored-facts.test.ts — a callee named to one decompiler and not the other
   *  is the defect that check exists to catch. Six kleod rows use it; every other real row takes
   *  the vendored context below. */
  ctx?: string;
  /** Feed m2c the function's VENDORED project context (attribute-sanitized) plus the function's
   *  own prototype — the project's real headers, which is what its real workflow always has. The
   *  row publishes the vendored file path (ctxRef), not the text.
   *
   *  WHAT EACH TOOL IS GIVEN ON THE REAL TIER, stated here once because it was previously stated
   *  wrongly ("prototypes only — no struct layouts, to match asmlift"):
   *
   *    asmlift  the project's vendored SYMBOL MAP, on all 252 rows. Not name-and-address: sizes,
   *             declaration shapes, scalar/element signedness, array extents, volatility,
   *             const-ness, callee signatures, address-cast macro bodies, and — where the DWARF
   *             types-sidecar carries them — struct tags with full field tables (name, offset,
   *             size, pointer-ness, element size, array length). The row's OWN definition-derived
   *             facts are redacted first (core's `asIfUndecompiled`).
   *    m2c      the project's vendored preprocessed CONTEXT — the same headers, as C — on every
   *             row that has no hand-written `ctx` above.
   *
   *  So withholding struct layouts from m2c does not "match asmlift"; it under-provisions m2c
   *  against a tool that is handed layouts outright. This flag is therefore set on every real row
   *  without a hand-written `ctx`, and both tools read the same project declarations out of the
   *  same vendored freeze.
   *
   *  The SYNTHETIC tier is the opposite, deliberately: there NEITHER tool gets project data — the
   *  spec's `ctx` is prototypes only and its `proto` carries the same facts to asmlift, so both
   *  must recover structure (see dataset/synthetic.ts). Do not read this note as applying there. */
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
  /** GitHub `owner/name` of the benchmark fork (never a URL) — `bench setup` clones it. */
  repo: string;
  /** The pinned integration branch on that fork (provenance base + one integration commit);
   *  `bench vendor`/`bench fidelity` verify the checkout sits on its remote head. */
  branch: string;
  /** Make target that derives the ELF `decomp.yaml` names (DWARF types-sidecar projects:
   *  af/marioparty3/snowboardkids2). Absent ⇒ the plain project build produces the ELF. */
  elfMake?: string;
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
  /** the project's vendored symbol map (names + declaration shapes), when it exposes an ELF */
  symbols?: SymbolMap;
}

export const REAL_DIR = join(import.meta.dirname, '..', '..', 'dataset', 'real');

/** The gitignored dir where `bench setup` clones the HARNESS-OWNED project checkouts —
 *  disposable clones the harness may freely mutate (build, split, venv), unlike the sibling
 *  WORKSPACE checkouts which carry the maintainer's WIP and are never touched.
 *  ASMLIFT_BENCH_CHECKOUTS relocates it (tests use a tmpdir). */
export function benchCheckoutsDir(): string {
  return process.env.ASMLIFT_BENCH_CHECKOUTS ?? join(import.meta.dirname, '..', '..', 'checkouts');
}

/** The project's ASMLIFT_PROJ_<PROJECT> env override, if set. */
export function projectEnvOverride(m: RealManifest): string | undefined {
  const envName = `ASMLIFT_PROJ_${m.project.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[envName];
}

/** Checkout resolution order: ASMLIFT_PROJ_<PROJECT> env override > bench-owned checkout
 *  (apps/benchmark/checkouts/<repoDir>, when present) > sibling WORKSPACE dir. */
export function resolveProjectRoot(m: RealManifest): string {
  const override = projectEnvOverride(m);
  if (override) {
    return override;
  }
  const owned = join(benchCheckoutsDir(), m.repoDir);
  return existsSync(owned) ? owned : join(WORKSPACE, m.repoDir);
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
  // `owner/name` only — a URL (scheme, host, extra slashes) must fail here, not mid-clone
  if (typeof man.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(man.repo)) {
    problems.push(`${file}: "repo" must be a GitHub owner/name (no URL)`);
  }
  if (typeof man.branch !== 'string' || !man.branch) {
    problems.push(`${file}: "branch" must be a non-empty string`);
  }
  if (man.elfMake !== undefined && (typeof man.elfMake !== 'string' || !man.elfMake)) {
    problems.push(`${file}: "elfMake" must be a non-empty string when present`);
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
    // the project's vendored symbol map (name/shape metadata derived from its ELF at vendor
    // time) — absent for projects without a tools.asmlift.elf, and rows then run as before
    const symbolsPath = join(dir, 'symbols.json.gz');
    const symbols = existsSync(symbolsPath)
      ? symbolMapFromJson(JSON.parse(gunzipSync(readFileSync(symbolsPath)).toString('utf8')))
      : undefined;
    available.push({
      ...man,
      symbols,
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
