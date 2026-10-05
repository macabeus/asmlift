// asmlift — `tools.asmlift`, the block asmlift reads from a project's decomp.yaml, and target
// resolution. @match-kit/decomp-yaml finds and reads the file.
//
// One deliberate choice: on an ambiguous platform (n64 ⇒ ido7.1, gcc2.7.2kmc or gcc2.7.2;
// gc/gamecube/wii ⇒ one of three CodeWarrior builds) asmlift DECLINES naming the candidates instead
// of falling back to a generic default — per the cardinal rule, a guessed compiler mis-scores
// candidates.
import type { FlagFamily } from '@asmlift/core/codegen-flags';
import { TOOLCHAIN_TARGETS, type ToolchainId } from '@asmlift/core/target';
import { type LoadedConfig, toolBlock } from '@match-kit/decomp-yaml';
import * as z from 'zod';

/** asmlift's payload inside `tools.asmlift`. A key it does not name is an error, so a misspelt
 *  setting is refused instead of silently doing nothing. */
const ASMLIFT_TOOL = z.strictObject({
  /** the asmlift target key (agbcc | ido7.1 | gcc2.7.2kmc | gcc2.7.2 | mwcc_242_81 | mwcc_233_163n |
   *  mwcc_247_107) — disambiguates platforms that map to several compilers */
  target: z.string().optional(),
  /** candidate-compile command template ({{inputPath}}/{{outputPath}}/{{symbol}}) — the
   *  project's own toolchain */
  compiler: z.string().optional(),
  /** host objdump binary for object-file input (overrides the built-in per-target choice) */
  objdump: z.string().optional(),
  /** the project's built ELF (relative to this decomp.yaml) — the address→symbol source:
   *  names from `.symtab`, declaration shapes from the linked-in DWARF types-sidecar when
   *  present. Absent ⇒ no symbol map. */
  elf: z.string().optional(),
  /** a symbol map already DERIVED, as JSON (the `symbolMapToJson` shape: hex address →
   *  SymbolInfo[]), relative to this decomp.yaml. The `elf` key is the ordinary source —
   *  a project has a built ELF and asmlift derives the map from it — and this key is for the
   *  case where there is no ELF to derive from and the map is authored: the benchmark's
   *  synthetic rows hand-write one, and a published reproduction script has to feed the CLI the
   *  same map or it reproduces a different answer. Mutually exclusive with `elf`: two sources
   *  for one map is a silent precedence question, so declaring both is a loud input error. */
  symbols: z.string().optional(),
});

export type AsmliftToolConfig = z.output<typeof ASMLIFT_TOOL>;

/** `tools.asmlift` of `loaded`, checked; `undefined` when there is no config or no block. Throws
 *  `DecompYamlError` naming each key of the wrong type and each key asmlift does not know. */
export function asmliftBlock(loaded: LoadedConfig | null): AsmliftToolConfig | undefined {
  return toolBlock(loaded, 'asmlift', ASMLIFT_TOOL);
}

/** The registry's target keys in one compiler family — so a platform's candidate list is read off
 *  the registry rather than transcribed beside it. A toolchain added to a family asmlift already
 *  compiles for lands in its platform's list on its own, and a platform that thereby names several
 *  compilers starts declining, which is the only safe direction for that change to go. */
const familyTargets = (...families: readonly FlagFamily[]): string[] =>
  Object.keys(TOOLCHAIN_TARGETS).filter((id) => families.includes(TOOLCHAIN_TARGETS[id as ToolchainId].family));

// decomp_settings platform → asmlift target keys. A platform naming SEVERAL compilers needs
// `tools.asmlift.target` to disambiguate (resolveTarget declines, listing these). GameCube and Wii
// name THREE CodeWarrior builds, which differ in codegen: the platform cannot pick between them,
// and picking wrong is a well-formed object that simply does not match the ROM.
const PLATFORM_TARGETS: Record<string, string[]> = {
  gba: familyTargets('agbcc'),
  n64: familyTargets('ido', 'gcc'),
  gc: familyTargets('mwcc'),
  gamecube: familyTargets('mwcc'),
  wii: familyTargets('mwcc'),
};

/** The decomp.yaml setting that makes `targetKey` the target: its platform, where that platform names no
 *  other compiler, else `tools.asmlift.target`. */
export function targetSetting(targetKey: string): string {
  const platform = Object.keys(PLATFORM_TARGETS).find(
    (p) => PLATFORM_TARGETS[p].length === 1 && PLATFORM_TARGETS[p][0] === targetKey,
  );
  return platform === undefined ? `tools.asmlift.target: ${targetKey}` : `platform: ${platform}`;
}

export type TargetResolution = { targetKey: string; trace: string } | { error: string };

/** Resolve the target key: `--target` flag > `tools.asmlift.target` > platform inference.
 *  Returns a trace of HOW it resolved; ambiguity or an
 *  unknown platform is an error naming the candidates, never a guess. */
export function resolveTarget(
  flag: string | undefined,
  loaded: LoadedConfig | null,
  tool: AsmliftToolConfig | undefined,
): TargetResolution {
  if (flag) {
    return { targetKey: flag, trace: '--target flag' };
  }
  if (!loaded) {
    return { error: 'no --target, and no decomp.yaml was found' };
  }
  if (tool?.target) {
    return { targetKey: tool.target, trace: `tools.asmlift.target in ${loaded.path}` };
  }
  const { platform } = loaded.config;
  const candidates = PLATFORM_TARGETS[platform];
  if (!candidates) {
    return {
      error: `platform '${platform}' (${loaded.path}) has no asmlift target mapping — pass --target or set tools.asmlift.target`,
    };
  }
  if (candidates.length > 1) {
    return {
      error: `platform '${platform}' is ambiguous (${candidates.join(' or ')}) — set tools.asmlift.target in ${loaded.path}`,
    };
  }
  return { targetKey: candidates[0], trace: `platform '${platform}' in ${loaded.path}` };
}
