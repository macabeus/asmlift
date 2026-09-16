// The Playground's Flags field, read the way the CLI reads `--cflags`: shell words, parsed by core into
// the profile the decompile resolves and the words every ranked candidate compiles with. Pure, so it is
// testable without the editor or the wasm compiler.
import { UnreadableLevelError, optLevel, shellJoinFlags, tokenizeFlags } from '@asmlift/core/codegen-flags';
import {
  type CanonicalToolchainId,
  type ResolvedTarget,
  TOOLCHAIN_TARGETS,
  type ToolchainId,
  isToolchainId,
  targetFor,
} from '@asmlift/core/target';

export type FlagsReading =
  | {
      argv: string[];
      resolved: ResolvedTarget;
      /** the optimisation level the compiler acts on, or null when the flags name none */
      level: string | null;
      /** what a later word overrode, and what the compiler reads other than as spelled */
      notes: readonly string[];
    }
  | { error: string };

/** A toolchain's canonical flags as the field spells them. The ⟲ button restores them, so the
 *  Playground only offers toolchains that HAVE them — a real-only one has nothing to restore. */
export function canonicalFlagsText(toolchain: CanonicalToolchainId): string {
  return shellJoinFlags(TOOLCHAIN_TARGETS[toolchain].canonicalFlags);
}

/** The field's text for `toolchain`: its words, the target they resolve, and their level, or the
 *  sentence that refuses them (an unterminated quote, a level the family cannot read, no words). A level
 *  another family spells names the Toolchain choices that read it by `labels`, the names the page shows. */
export function readFlags(
  toolchain: ToolchainId,
  text: string,
  labels: Readonly<Partial<Record<ToolchainId, string>>>,
): FlagsReading {
  try {
    const argv = tokenizeFlags(text);
    if (argv.length === 0) {
      return { error: `no flags given; ⟲ canonical restores ${toolchain}'s` };
    }
    const resolved = targetFor(toolchain, argv);
    return {
      argv,
      resolved,
      level: optLevel(TOOLCHAIN_TARGETS[toolchain].family, argv),
      notes: [...resolved.profile.overrides, ...resolved.profile.implied],
    };
  } catch (e) {
    if (e instanceof UnreadableLevelError && e.spelledBy !== undefined) {
      const choices = Object.keys(TOOLCHAIN_TARGETS)
        .filter(isToolchainId)
        .filter((id) => TOOLCHAIN_TARGETS[id].family === e.spelledBy)
        .flatMap((id) => labels[id] ?? []);
      return {
        error: choices.length === 0 ? e.message : `${e.message}; choose ${choices.join(' or ')} under Toolchain`,
      };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
