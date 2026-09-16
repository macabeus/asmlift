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
import { ADDR_PATTERN, type FlagsFrom, type Identifiable } from '@asmlift/bench-schema';
import { commandFlags } from '@asmlift/cli/flags';
import { parseFlags, storedFlags, unitLanguage } from '@asmlift/core/codegen-flags';
import type { Prototypes } from '@asmlift/core/proto';
import { type SymbolMap, symbolMapFromJson } from '@asmlift/core/symbols';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { WORKSPACE } from '../config';
import { TOOLCHAINS, type ToolchainId } from '../toolchains';

export interface RealFunction {
  /** The upstream project's name for the function, as-is — presentation, and the row id's middle. */
  sym: string;
  /** Where the function is — the row's IDENTITY (bench-schema `rowIdentity`). Either its address in
   *  the project's linked ELF (`0x` + 8 lowercase hex, the spelling the vendored symbol map keys by;
   *  GBA ROM-mapped with the Thumb bit clear, N64 VRAM), or, for code in a GameCube REL module,
   *  which the game's loader places and which therefore has no linked address, its location
   *  `<module>:<section>+0x<offset>`. MEASURED from the build artifact, never typed from a name:
   *  `test/real-manifests.test.ts` holds it against the map the row is read with.
   *
   *  The module stem is also its `objdiff.json` unit prefix, so a module the project splits into no
   *  unit — 6 of Mario Party 4's 99 — can hold no row: the row would need `units` flags, and
   *  `bench flags` refuses it with `objdiff.json has no unit compiled from …`. */
  addr: string;
  /** The build unit the function is compiled in, and a key of the manifest's `units`: the source file its
   *  `sourceUrl` cites — or, where that file is a part a unit `#include`s rather than a source file of its
   *  own (Animal Crossing's `.c_inc` bodies), the unit whose compile reads it. Written by `bench flags
   *  --write`, which takes that unit from what the project's build recorded reading; `bench vendor`
   *  refuses a row naming any other. */
  unit: string;
  /** The digest of the function's target as `bench vendor` proved it equal to the function the project's
   *  linked ELF holds at `addr` (cases/rom-function.ts `targetDigest`). A target built with another
   *  digest is not the game's function, and its row is refused.
   *
   *  A row keyed by a REL MODULE LOCATION is proved the same way against its MODULE's ELF, the one the
   *  build turns into the disc's module (cases/rom-function.ts `romLocation`). */
  romDigest: string;
  /** Earlier upstream names of this function, oldest first. An upstream rename is a data change:
   *  `sym` takes the new name, the old one is appended here, and every citation, permalink and
   *  brief that named the old spelling keeps resolving to this row. */
  aliases?: string[];
  features: string[];
  funcC: string; // the extracted function source (verbatim from the decomp)
  sourceUrl?: string; // commit-pinned GitHub permalink to funcC's span in the project
  prependC?: string; // extra decls to prepend AFTER the project headers (rarely needed)
  /** A HAND-WRITTEN m2c `--context` for this row: callee prototypes the project's own vendored
   *  headers happen not to declare, so `m2cCtx` alone would lose them. Held symmetric with
   *  `proto` by test/authored-facts.test.ts — a callee named to one decompiler and not the other
   *  is the defect that check exists to catch. No row uses it today (six kleod rows did before the
   *  2026-09-13 swap); every real row takes
   *  the vendored context below. */
  ctx?: string;
  /** Feed m2c the function's VENDORED project context: the exact bytes the project's own
   *  preprocessor produced for this function's translation unit with the body removed. Passed
   *  VERBATIM — the row publishes the file path (ctxRef), not the text.
   *
   *  WHAT EACH TOOL IS GIVEN ON THE REAL TIER, stated here once because it was previously stated
   *  wrongly ("prototypes only — no struct layouts, to match asmlift"):
   *
   *    asmlift  the project's vendored SYMBOL MAP, on all 252 rows. Not name-and-address: sizes,
   *             declaration shapes, scalar/element signedness, array extents, volatility,
   *             const-ness, address-cast macro bodies, and — where the vendoring found them —
   *             callee signatures and struct tags with full field tables. The row's OWN
   *             definition-derived facts are redacted first (core's `asIfUndecompiled`).
   *    m2c      the same project's vendored preprocessed CONTEXT, plus at most the one prototype
   *             line `proto` already gives asmlift (real.ts's `m2cOwnPrototype`). Neither tool is
   *             handed the row's own signature out of the reference source — with one measured
   *             exception, README residual 4.
   *
   *  So withholding struct layouts from m2c does not "match asmlift"; it under-provisions m2c
   *  against a tool handed layouts outright. This flag is set on every real row without a
   *  hand-written `ctx`.
   *
   *  IT IS NOT EXACT PARITY, and the residuals run in both directions — apps/benchmark/README.md
   *  lists them. Nor is a "project context" one uniform thing: it is whatever that project's TU
   *  preprocesses to. af's manifest has `headers: []` (its headers do not survive a host cpp), so
   *  an af row's whole context is that row's own `prependC` — 17 to 603 bytes, a handful of
   *  typedefs — while marioparty3's is ~168 KB of real header tree. Read the blob, not this
   *  comment.
   *
   *  The SYNTHETIC tier is the opposite, deliberately: there NEITHER tool gets project data — the
   *  spec's `ctx` is prototypes only and its `proto` carries the same facts to asmlift, so both
   *  must recover structure (see dataset/synthetic.ts). Do not read this note as applying there.
   *
   *  NOT AVAILABLE ON A C++ ROW, and validateManifest refuses it there: m2c's context parser is
   *  pycparser, so a C++ unit's context makes m2c fail rather than degrade. The reason, the
   *  measurement and what a C++ row gets instead are at that check. */
  m2cCtx?: boolean;
  proto?: Prototypes; // asmlift prototypes (void-ness / callee params)
  note?: string;
}

/** One translation unit of the project's build: the compiler that builds it and the codegen flags the
 *  build passes for it, copied from the build by `bench flags --write` (cases/derive-flags.ts) and never
 *  typed. The target and every candidate of every row in the unit compile with these flags. */
export interface BuildUnit {
  toolchain: ToolchainId;
  /** the build's flags in core's normal form (`storedFlags`) */
  cflags: string[];
  flagsFrom: FlagsFrom;
}

/** The on-disk manifest shape (portable — no machine paths). */
export interface RealManifest {
  project: string;
  /** Manifest-level provenance/rationale for MAINTAINERS (why this project's extraction is
   *  structured the way it is — e.g. af's headers:[] + per-function prependC). Never published
   *  to rows; per-function `note` is the user-facing one. */
  note?: string;
  repoDir: string; // project checkout dir name, resolved against WORKSPACE (or ASMLIFT_PROJ_*)
  /** GitHub `owner/name` of the benchmark fork (never a URL) — `bench setup` clones it. */
  repo: string;
  /** The pinned integration branch on that fork (provenance base + one integration commit);
   *  `bench vendor`/`bench fidelity` verify the checkout sits on its remote head. */
  branch: string;
  /** Make target that derives the ELF `decomp.yaml` names — every real project has one today,
   *  because every one of them declares a DERIVED `tools.asmlift.elf` (a copy of the linked ELF
   *  carrying a DWARF sidecar). Absent ⇒ the plain project build produces the ELF. NOT optional
   *  decoration: the published repro script prints the derive step only when this is set
   *  (`src/report/repro-scripts.ts`), so an unset field silently tells every reader of those rows
   *  to reproduce them from a map the rows were not measured with. Gated in
   *  `test/real-manifests.test.ts` against the checkout's own Makefile. */
  elfMake?: string;
  cppIncludes: string[]; // preprocessor flags (e.g. ["-nostdinc","-I","tools/agbcc/include"])
  headers: string[]; // project headers to #include so types resolve
  defines?: string[]; // extra -D macros
  /** every build unit a row compiles in, keyed by its source path */
  units: Record<string, BuildUnit>;
  functions: RealFunction[];
}

/** A manifest paired with its vendored compiler inputs (the runtime shape — no checkout). */
export interface VendoredManifest extends RealManifest {
  /** sym → gunzip'd preprocessed texts (target TU + candidate context). */
  vendored: (sym: string) => { tuI: string; ctxI: string };
  /** sym → repo-relative path of the vendored context blob (for the row's ctxRef). */
  ctxPath: (sym: string) => string;
  /** The vendored symbol map (names + declaration shapes) a row of `module` is read with: the
   *  project's own for a row with a linked address (`undefined` module), and the REL module's —
   *  its own symbols over the base ELF's globals — for a row in one. Undefined for a project that
   *  exposes no ELF; THROWS for a module the vendoring did not write, because reading a module's
   *  row with the project's map alone would publish different source silently. */
  symbolsFor: (module: string | undefined) => SymbolMap | undefined;
}

/** Where `bench vendor` writes one map per REL module that has rows, under `tu/<project>/`. */
export const MODULE_MAP_DIR = 'symbols';

/** The vendored map blob a row of `module` is read from, inside the project's vendored dir. */
export const vendoredMapFile = (dir: string, module: string | undefined): string =>
  module === undefined ? join(dir, 'symbols.json.gz') : join(dir, MODULE_MAP_DIR, `${module}.json.gz`);

/** The vendored symbol map (name/shape metadata derived from the project's ELFs at vendor time) a
 *  row of `module` is read with, out of the project's vendored dir `dir`.
 *
 *  Undefined for a project that vendors no map at all — one without a `tools.asmlift.elf`, whose
 *  rows run map-less as they always have. A project WITH a map but without the MODULE's THROWS
 *  instead of falling back to it: a module's code refers to the module's own symbols, so a REL row
 *  read with the base ELF's map alone would publish different source while looking like every
 *  other row.
 *
 *  THE MODULE'S OWN FILE DECIDES FIRST, and the base map's absence is only ever an answer for a
 *  base-map row. Asked the other way round, a dir holding `symbols/m416Dll.json.gz` and no
 *  `symbols.json.gz` would answer "this project vendors no map" for m416Dll and run its rows
 *  map-less — the quiet version of exactly the mix-up the throw below exists to prevent. */
export function vendoredSymbols(project: string, dir: string, module: string | undefined): SymbolMap | undefined {
  const path = vendoredMapFile(dir, module);
  if (existsSync(path)) {
    return symbolMapFromJson(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')));
  }
  if (module === undefined || !existsSync(vendoredMapFile(dir, undefined))) {
    return undefined; // the project vendors no map at all
  }
  throw new Error(
    `${project}: rows live in module ${module}, but no map is vendored for it — ` +
      `run \`pnpm bench vendor --project ${project}\``,
  );
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

/** A cited file that is not a C or C++ source: a part some unit `#include`s, so the row's unit may be another
 *  file. Which one is decidable only against the build (`bench flags`, `bench vendor`). */
const isIncludedPart = (path: string | undefined): boolean =>
  path !== undefined && !/\.(?:c|cc|cp|cpp|cxx)$/.test(path);
const COMMIT = /^[0-9a-f]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const SHA256 = /^[0-9a-f]{64}$/;

/** A unit's problems: a known toolchain, flags its family parses and that are already in normal form,
 *  a dialect that toolchain has a front end for, and a typed `flagsFrom`. */
function unitProblems(file: string, path: string, u: Partial<BuildUnit> | undefined): string[] {
  const where = `${file}: unit ${path}`;
  const problems: string[] = [];
  if (typeof u?.toolchain !== 'string' || !(u.toolchain in TOOLCHAINS)) {
    return [`${where} has unknown toolchain ${JSON.stringify(u?.toolchain)}`];
  }
  if (!Array.isArray(u.cflags) || u.cflags.length === 0 || u.cflags.some((w) => typeof w !== 'string' || !w)) {
    problems.push(`${where} "cflags" must be the build's flag words`);
  } else {
    const family = TOOLCHAIN_TARGETS[u.toolchain].family;
    try {
      if (storedFlags(family, u.cflags).join('\0') !== u.cflags.join('\0')) {
        problems.push(`${where} "cflags" are not in normal form: ${storedFlags(family, u.cflags).join(' ')}`);
      }
      parseFlags(family, u.cflags);
      // CodeWarrior is the only C++ front end here. On any other toolchain a c++ unit reaches a
      // `buildTarget` that ignores the dialect, builds a C object with an UNMANGLED symbol and
      // publishes a number about a language the compiler never read. compile/real.ts refuses the
      // pairing too, but it does so while a case is being constructed and can only name the
      // TOOLCHAIN; the manifest is where a reader can act on it, so it is named here by unit.
      if (family !== 'mwcc' && unitLanguage(path, u.cflags) === 'c++') {
        problems.push(`${where} is C++, and ${u.toolchain} has no C++ front end — a c++ unit needs CodeWarrior`);
      }
    } catch (e) {
      problems.push(`${where} "cflags": ${(e as Error).message}`);
    }
  }
  const from = u.flagsFrom as Partial<Record<string, unknown>> | undefined;
  const typed =
    from !== undefined &&
    typeof from.commit === 'string' &&
    COMMIT.test(from.commit) &&
    typeof from.file === 'string' &&
    from.file !== '' &&
    typeof from.sha256 === 'string' &&
    SHA256.test(from.sha256) &&
    ((from.from === 'makefile' && typeof from.command === 'string' && from.command !== '') ||
      (from.from === 'objdiff' && typeof from.unit === 'string' && from.unit !== ''));
  if (!typed) {
    problems.push(
      `${where} "flagsFrom" must be {from: "makefile", commit, file, sha256, command} or {from: "objdiff", commit, file, sha256, unit}`,
    );
  } else if (from.from === 'makefile' && problems.length === 0) {
    // `cflags` are the flags `flagsFrom.command` compiles with, read the way `bench flags` derived them, so
    // the two fields cannot drift apart: a word edited out of `cflags` alone can leave every target
    // ROM-equal and still move every candidate. The build itself is re-read only by `bench flags`.
    const family = TOOLCHAIN_TARGETS[u.toolchain].family;
    const cflags = u.cflags as string[];
    try {
      const recipe = commandFlags(from.command as string, family);
      if (recipe === undefined) {
        problems.push(`${where} "flagsFrom.command" runs no ${u.toolchain} compiler`);
      } else if (recipe.join('\0') !== cflags.join('\0')) {
        problems.push(`${where} "cflags" are not the flags its flagsFrom.command compiles with: ${recipe.join(' ')}`);
      }
    } catch (e) {
      problems.push(`${where} "flagsFrom.command": ${(e as Error).message}`);
    }
  }
  return problems;
}

/** The fields `bench flags --write` and `bench vendor` write: a manifest being authored may lack them. */
export interface ManifestValidation {
  /** false: a row's `unit`, its `units` entry and its `romDigest` may be absent (each is still checked
   *  when present) */
  complete: boolean;
}

/** Validate one manifest's shape. Returns the problems (empty = valid). */
export function validateManifest(
  m: unknown,
  file: string,
  { complete }: ManifestValidation = { complete: true },
): string[] {
  const problems: string[] = [];
  const man = m as Partial<RealManifest>;
  if (typeof man.project !== 'string' || !man.project) {
    problems.push(`${file}: missing "project"`);
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
  if (man.units !== undefined && !isRecord(man.units)) {
    problems.push(`${file}: "units" must map each unit's source path to its toolchain and flags`);
  } else if (complete && (man.units === undefined || Object.keys(man.units).length === 0)) {
    problems.push(`${file}: "units" must name every build unit a row compiles in`);
  } else {
    const named = new Set((Array.isArray(man.functions) ? man.functions : []).map((f) => f.unit));
    for (const [path, u] of Object.entries(man.units ?? {})) {
      problems.push(...unitProblems(file, path, u));
      if (!named.has(path)) {
        problems.push(`${file}: unit ${path} is named by no row`);
      }
    }
  }
  if (!Array.isArray(man.functions) || man.functions.length === 0) {
    problems.push(`${file}: "functions" must be a non-empty array`);
  } else {
    const addrs = new Map<string, string>();
    const names = new Map<string, string>();
    for (const f of man.functions) {
      if (typeof f.sym !== 'string' || typeof f.funcC !== 'string' || !Array.isArray(f.features)) {
        problems.push(`${file}: function entry missing sym/funcC/features (${JSON.stringify(f.sym)})`);
      }
      // identity: one address per row, and no two rows of a project at the same one
      if (typeof f.addr !== 'string' || !ADDR_PATTERN.test(f.addr)) {
        problems.push(
          `${file}: ${JSON.stringify(f.sym)} "addr" must be where the function is — the linked ELF address as ` +
            `0x + 8 lowercase hex, or a REL module location <module>:<section>+0x<offset> ` +
            `(got ${JSON.stringify(f.addr)})`,
        );
      } else if (addrs.has(f.addr)) {
        problems.push(
          `${file}: ${JSON.stringify(f.sym)} shares addr ${f.addr} with ${JSON.stringify(addrs.get(f.addr))}`,
        );
      } else {
        addrs.set(f.addr, f.sym);
      }
      // the second half of identity: WHOSE source sits at that address. `joinArtifacts` keeps two
      // rows that meet at an address apart only when both cite a repository, so a row without a
      // `sourceUrl` would join another decompilation's row there silently. Required, and required
      // to cite the repository this manifest pins — the fork `bench setup` clones.
      const cited =
        typeof f.sourceUrl === 'string'
          ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/[0-9a-f]{7,40}\//.exec(f.sourceUrl)?.[1]
          : undefined;
      if (cited === undefined) {
        problems.push(
          `${file}: ${JSON.stringify(f.sym)} "sourceUrl" must be a commit-pinned https://github.com/<owner>/<name>/blob/<sha>/… permalink (got ${JSON.stringify(f.sourceUrl)})`,
        );
      } else if (typeof man.repo === 'string' && cited !== man.repo) {
        problems.push(
          `${file}: ${JSON.stringify(f.sym)} "sourceUrl" cites ${cited}, not this manifest's repo ${man.repo}`,
        );
      }
      // the unit: the file the permalink cites, with its flags in `units`
      const citedFile =
        typeof f.sourceUrl === 'string' ? /\/blob\/[0-9a-f]+\/([^#]+)/.exec(f.sourceUrl)?.[1] : undefined;
      if (f.unit === undefined) {
        if (complete) {
          problems.push(
            `${file}: ${JSON.stringify(f.sym)} names no "unit" — run \`pnpm bench flags --project ${man.project} --write\``,
          );
        }
      } else if (typeof f.unit !== 'string' || (f.unit !== citedFile && !isIncludedPart(citedFile))) {
        problems.push(
          `${file}: ${JSON.stringify(f.sym)} "unit" ${JSON.stringify(f.unit)} is not the file its sourceUrl cites`,
        );
      } else if (!isRecord(man.units) || !(f.unit in man.units)) {
        if (complete) {
          problems.push(
            `${file}: ${JSON.stringify(f.sym)} "unit" ${f.unit} has no flags in "units" — run \`pnpm bench flags --project ${man.project} --write\``,
          );
        }
      } else if (f.m2cCtx && unitLanguage(f.unit, (man.units[f.unit] as BuildUnit).cflags ?? []) === 'c++') {
        // m2c's `--context` parser is pycparser: C, and only C. A C++ unit's vendored context IS a
        // C++ translation unit — measured on Pikmin's `src/sysCommon/controller.cpp`, 25,892 bytes
        // holding 36 `class` and 55 `virtual` — and m2c does not degrade on it, it FAILS:
        // `Syntax error when parsing C context. before: AgeServer … class AgeServer;`. The row
        // would publish `m2c=failed` for a harness decision, which is the one thing a comparative
        // benchmark must not do.
        //
        // Given NO context the same function decompiles cleanly, because m2c's `ppc-mwcc-c++`
        // target reads the class, the implicit `this` and the field offsets out of the MANGLED
        // symbol itself (measured: `f32 getMainStickX__10ControllerFv(Controller *this) { return
        // (f32) (s8) this->unk45 / 74.0f; }`, against a reference of `mMainStickX / 74.0f`). So a
        // C++ row states its choice — a hand-written C-parseable `ctx`, or none — rather than
        // inheriting a blob no version of m2c can read.
        problems.push(
          `${file}: ${JSON.stringify(f.sym)} sets "m2cCtx" on a c++ unit — m2c's context parser is C-only and ` +
            `fails outright on a C++ context; give the row a C-parseable "ctx", or neither`,
        );
      }
      if (f.romDigest === undefined) {
        if (complete) {
          problems.push(
            `${file}: ${JSON.stringify(f.sym)} has no "romDigest" — run \`pnpm bench vendor --project ${man.project}\``,
          );
        }
      } else if (typeof f.romDigest !== 'string' || !SHA256.test(f.romDigest)) {
        problems.push(`${file}: ${JSON.stringify(f.sym)} "romDigest" must be a sha256 in lowercase hex`);
      }
      // a name — current or former — answers to exactly one row, or a citation of it is ambiguous
      if (
        f.aliases !== undefined &&
        (!Array.isArray(f.aliases) || f.aliases.some((a) => typeof a !== 'string' || !a))
      ) {
        problems.push(`${file}: ${JSON.stringify(f.sym)} "aliases" must be an array of names when present`);
      }
      for (const n of [f.sym, ...(Array.isArray(f.aliases) ? f.aliases : [])]) {
        if (names.has(n)) {
          problems.push(
            `${file}: the name ${JSON.stringify(n)} answers to two rows (${JSON.stringify(names.get(n))}, ${JSON.stringify(f.sym)})`,
          );
        }
        names.set(n, f.sym);
      }
    }
  }
  return problems;
}

/** Parse + validate every committed manifest. A malformed manifest throws — a typo must fail
 *  loudly at load, not surface as a mid-run compile error. */
function loadRaw(validation: ManifestValidation): RealManifest[] {
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
    const problems = validateManifest(man, f, validation);
    if (problems.length > 0) {
      throw new Error(`invalid real-tier manifest:\n  ${problems.join('\n  ')}`);
    }
    return man;
  });
}

/** A manifest with its vendored compiler inputs attached: `vendored` and `ctxPath` throw for a row
 *  `bench vendor` has not written. */
export function withVendoredInputs(man: RealManifest): VendoredManifest {
  const dir = join(REAL_DIR, 'tu', man.project);
  const indexPath = join(dir, 'index.json');
  const index = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, { tu: string; ctx: string }>)
    : {};
  const entryOf = (sym: string) => {
    const entry = index[sym];
    if (!entry) {
      throw new Error(`${man.project}:${sym}: not in the vendored index — re-run \`bench vendor\``);
    }
    return entry;
  };
  const maps = new Map<string | undefined, SymbolMap | undefined>();
  return {
    ...man,
    symbolsFor: (module) => {
      if (!maps.has(module)) {
        maps.set(module, vendoredSymbols(man.project, dir, module));
      }
      return maps.get(module);
    },
    vendored: (sym) => {
      const entry = entryOf(sym);
      return {
        tuI: gunzipSync(readFileSync(join(dir, entry.tu))).toString('utf8'),
        ctxI: gunzipSync(readFileSync(join(dir, entry.ctx))).toString('utf8'),
      };
    },
    ctxPath: (sym) => `apps/benchmark/dataset/real/tu/${man.project}/${entryOf(sym).ctx}`,
  };
}

/** RUNTIME loader: complete manifests paired with their VENDORED compiler inputs — no project checkouts
 *  involved. A manifest without vendored blobs is skipped with one aggregated warning (run
 *  `bench vendor` where the checkouts live). */
export function loadManifests(): VendoredManifest[] {
  const raw = loadRaw({ complete: true });
  const unvendored = raw.filter((man) => !existsSync(join(REAL_DIR, 'tu', man.project, 'index.json')));
  if (unvendored.length > 0) {
    console.warn(
      `real tier: ${unvendored.length}/${raw.length} project(s) have no vendored TUs — skipped: ${unvendored.map((m) => m.project).join(', ')} (run \`bench vendor\`)`,
    );
  }
  return raw.filter((man) => !unvendored.includes(man)).map(withVendoredInputs);
}

/** AUTHORING loader: validated manifests that may lack what `bench flags --write` and `bench vendor` write
 *  (see `ManifestValidation`), for the commands that run before those fields exist (`bench setup`,
 *  `bench flags`, `bench vendor`); live checkouts required by the caller. */
export function loadManifestsForVendor(): RealManifest[] {
  return loadRaw({ complete: false });
}

/** Complete manifests without their vendored inputs: what a reader of published rows needs. */
export function loadCompleteManifests(): RealManifest[] {
  return loadRaw({ complete: true });
}

/** Every real row the dataset carries, as the fields row identity is computed from (bench-schema
 *  `rowIdentity`/`joinArtifacts`) — read off the manifests alone, no vendored TU and no checkout, so
 *  a guard that must join an artifact to the CURRENT rows can afford to ask. */
export function realRowIdentities(): Identifiable[] {
  return loadRaw({ complete: true }).flatMap((man) =>
    man.functions.map((f) => ({
      id: `${man.project}:${f.sym}:${man.units[f.unit].toolchain}`,
      project: man.project,
      sym: f.sym,
      toolchain: man.units[f.unit].toolchain,
      tier: 'real' as const,
      addr: f.addr,
      ...(f.aliases !== undefined ? { aliases: f.aliases } : {}),
      ...(f.sourceUrl !== undefined ? { sourceUrl: f.sourceUrl } : {}),
    })),
  );
}

/** Rewrite one project's committed manifest through `edit`, the way `bench flags --write` and `bench vendor`
 *  store what they derive: `units` right before `functions`, and each row's `unit` and `romDigest` right
 *  after its `addr`. */
export function rewriteManifest(project: string, edit: (man: RealManifest) => RealManifest): void {
  const file = join(REAL_DIR, `${project}.json`);
  const { units, functions, ...rest } = edit(JSON.parse(readFileSync(file, 'utf8')) as RealManifest);
  const ordered = {
    ...rest,
    units,
    functions: functions.map(({ sym, addr, unit, romDigest, ...row }) => ({ sym, addr, unit, romDigest, ...row })),
  };
  writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`);
}
