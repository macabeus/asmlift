// asmlift — `decomp.yaml` (decomp_settings) loader + target resolution.
//
// The config envelope is the community decomp_settings spec (github.com/ethteck/decomp_settings):
// standard project fields (`platform`, per-version `paths`) plus asmlift's payload in a
// spec-compliant `tools.asmlift` block. Loader shape: upward walk trying decomp.yaml AND
// decomp.yml, an explicit path short-circuits, `null` when absent — the config is an
// enhancement, never required. One deliberate choice: on an ambiguous platform
// (n64 ⇒ ido7.1, gcc2.7.2kmc or gcc2.7.2) asmlift DECLINES naming the candidates instead of falling back
// to a generic default — per the cardinal rule, a guessed compiler mis-scores candidates.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';

/** asmlift's payload inside `tools.asmlift` (arbitrary tool blocks are part of the spec). */
export interface AsmliftToolConfig {
  /** the asmlift target key (agbcc | ido7.1 | gcc2.7.2kmc | gcc2.7.2 | mwcc_242_81) — disambiguates
   *  platforms that map to several compilers */
  target?: string;
  /** candidate-compile command template ({{inputPath}}/{{outputPath}}/{{symbol}}) — the
   *  project's own toolchain */
  compiler?: string;
  /** host objdump binary for object-file input (overrides the built-in per-target choice) */
  objdump?: string;
  /** the project's built ELF (relative to this decomp.yaml) — the address→symbol source:
   *  names from `.symtab`, declaration shapes from the linked-in DWARF types-sidecar when
   *  present. Absent ⇒ no symbol map (today's behavior). */
  elf?: string;
  /** a symbol map already DERIVED, as JSON (the `symbolMapToJson` shape: hex address →
   *  SymbolInfo[]), relative to this decomp.yaml. The `elf` key is the ordinary source —
   *  a project has a built ELF and asmlift derives the map from it — and this key is for the
   *  case where there is no ELF to derive from and the map is authored: the benchmark's
   *  synthetic rows hand-write one, and a published reproduction script has to feed the CLI the
   *  same map or it reproduces a different answer. Mutually exclusive with `elf`: two sources
   *  for one map is a silent precedence question, so declaring both is a loud input error. */
  symbols?: string;
  /** `off` — this project REFUSES the cross-run candidate-object cache for its `compiler`
   *  command, whatever `ASMLIFT_CANDCACHE` says. The only value; anything else is an error, so a
   *  typo cannot silently read as "on".
   *
   *  A REFUSAL, never an assertion: a key that asserted what the command reads would serve a
   *  stale object the moment the assertion was incomplete, while an unnecessary refusal costs a
   *  cold start. Declare it when the command runs the compiler somewhere nothing here can read it
   *  — a container image named by a tag, another host, a wrapper that reads a config directory it
   *  never names on its command line. */
  candidateCache?: 'off';
}

export interface DecompVersion {
  name: string;
  fullname?: string;
  paths?: Record<string, string>;
}

export interface DecompConfig {
  name?: string;
  platform?: string;
  versions?: DecompVersion[];
  tools?: { asmlift?: AsmliftToolConfig; [tool: string]: unknown };
}

export interface LoadedConfig {
  /** absolute path of the decomp.yaml that was read (its dir anchors relative paths) */
  path: string;
  config: DecompConfig;
}

/** Load the nearest decomp.yaml/decomp.yml walking UP from `startDir`; `explicitPath` skips
 *  the walk (and its absence is then an error, not a null). Malformed YAML throws loud. */
export function loadDecompConfig(explicitPath?: string, startDir?: string): LoadedConfig | null {
  if (explicitPath) {
    const p = resolve(explicitPath);
    if (!existsSync(p)) {
      throw new Error(`config not found: ${explicitPath}`);
    }
    return readConfig(p);
  }
  let dir = resolve(startDir ?? process.cwd());
  for (;;) {
    for (const base of ['decomp.yaml', 'decomp.yml']) {
      const candidate = join(dir, base);
      if (existsSync(candidate)) {
        return readConfig(candidate);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    } // filesystem root
    dir = parent;
  }
}

function readConfig(path: string): LoadedConfig {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot parse ${path}: ${e instanceof Error ? e.message : e}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`cannot parse ${path}: expected a YAML mapping at the top level`);
  }
  const config = parsed as DecompConfig;
  noteObsoleteKeys(path, config);
  validateAsmliftKeys(path, config);
  return { path, config };
}

/** `tools.asmlift.cacheInputs` was the per-project DECLARATION of every file and directory the
 *  compile command reads — the gate the cross-run candidate-object cache would not start without,
 *  because one input class (a directory named by a flag) could not be measured. It is measured
 *  now, so the key is gone. Loading a config that still carries it is NOT an
 *  error: an obsolete key is not a broken project, and what replaced it is strictly more complete
 *  than the declaration ever was. But it is said out loud, once, because silence would leave a
 *  reader believing a seatbelt is fastened that does not exist any more. */
function validateAsmliftKeys(path: string, config: DecompConfig): void {
  const cc = config.tools?.asmlift?.candidateCache;
  if (cc !== undefined && cc !== 'off') {
    throw new Error(
      `${path}: tools.asmlift.candidateCache must be 'off' if present (got ${JSON.stringify(cc)}). ` +
        `It is a refusal, not a switch — there is no value that turns the cache ON, because ` +
        `ASMLIFT_CANDCACHE already does that and a project cannot know more than the measurement.`,
    );
  }
}

function noteObsoleteKeys(path: string, config: DecompConfig): void {
  if ((config.tools?.asmlift as { cacheInputs?: unknown } | undefined)?.cacheInputs !== undefined) {
    process.stderr.write(
      `${path}: tools.asmlift.cacheInputs is obsolete and no longer read — the candidate-object ` +
        `cache measures what the compile command reads (every path flag's operand, response files, ` +
        `glob directories, CPATH) instead of being told. You can delete the key.\n`,
    );
  }
}

// decomp_settings platform → asmlift target keys. A platform naming SEVERAL compilers needs
// `tools.asmlift.target` to disambiguate (resolveTarget declines, listing these).
const PLATFORM_TARGETS: Record<string, string[]> = {
  gba: ['agbcc'],
  n64: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
  gc: ['mwcc_242_81'],
  gamecube: ['mwcc_242_81'],
  wii: ['mwcc_242_81'],
};

export type TargetResolution = { targetKey: string; trace: string } | { error: string };

/** Resolve the target key: `--target` flag > `tools.asmlift.target` > platform inference.
 *  Returns a trace of HOW it resolved; ambiguity or an
 *  unknown platform is an error naming the candidates, never a guess. */
export function resolveTarget(flag: string | undefined, loaded: LoadedConfig | null): TargetResolution {
  if (flag) {
    return { targetKey: flag, trace: '--target flag' };
  }
  const tool = loaded?.config.tools?.asmlift;
  if (tool?.target) {
    return { targetKey: tool.target, trace: `tools.asmlift.target in ${loaded!.path}` };
  }
  const platform = loaded?.config.platform;
  if (!platform) {
    return { error: 'no --target, and no decomp.yaml with a platform/tools.asmlift.target was found' };
  }
  const candidates = PLATFORM_TARGETS[platform];
  if (!candidates) {
    return {
      error: `platform '${platform}' (${loaded!.path}) has no asmlift target mapping — pass --target or set tools.asmlift.target`,
    };
  }
  if (candidates.length > 1) {
    return {
      error: `platform '${platform}' is ambiguous (${candidates.join(' or ')}) — set tools.asmlift.target in ${loaded!.path}`,
    };
  }
  return { targetKey: candidates[0], trace: `platform '${platform}' in ${loaded!.path}` };
}
