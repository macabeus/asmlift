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
  /** every file and directory the `compiler` command reads, relative to this decomp.yaml.
   *  DECLARING them is what opts this project into the cross-run candidate-object cache: the
   *  cache's namespace can only measure inputs it can name, and an input reached through a
   *  directory (`-I ./inc`) is nameable only here. Absent: no candidate caching, ever. */
  cacheInputs?: string[];
  /** the project's built ELF (relative to this decomp.yaml) — the address→symbol source:
   *  names from `.symtab`, declaration shapes from the linked-in DWARF types-sidecar when
   *  present. Absent ⇒ no symbol map (today's behavior). */
  elf?: string;
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
  validateCacheInputs(path, config);
  return { path, config };
}

/**
 * `tools.asmlift.cacheInputs` is the ONE field in this file that is a soundness contract rather
 * than a preference, so it is validated at the seam and not only in the type: `parsed as
 * DecompConfig` is a compile-time claim about a file a project wrote.
 *
 * MEASURED before this existed: `cacheInputs: gen` (a YAML scalar where a list was meant) reached
 * `compile-command.ts`, which iterates the declaration — a string iterates PER CHARACTER, so
 * `"gen"` hashed as three MISSING entries, the digest was identical to `["g","e","n"]`, the cache
 * turned ON having measured nothing the project declared, and editing the declared input served a
 * stale object with no diagnostic anywhere. A one-character YAML mistake re-armed the hole the
 * declaration exists to close, so this throws and names the field.
 */
function validateCacheInputs(path: string, config: DecompConfig): void {
  const declared = config.tools?.asmlift?.cacheInputs;
  if (declared === undefined) {
    return;
  }
  const bad =
    !Array.isArray(declared) || declared.some((d) => typeof d !== 'string' || d.trim() === '') ? declared : undefined;
  if (bad !== undefined) {
    throw new Error(
      `${path}: tools.asmlift.cacheInputs must be a list of non-empty paths (got ${JSON.stringify(bad)}). ` +
        `It is the candidate-object cache's contract — every file and directory the compile command reads, ` +
        `relative to this decomp.yaml. An empty list ([]) is a valid declaration; omitting the key turns the ` +
        `cache off for this project.`,
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
