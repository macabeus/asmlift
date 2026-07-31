// asmlift — the ELF symbol-map provider (research/symbol-map-plan-2026-07-22.md).
//
// Reads the ONE file `tools.asmlift.elf` names and produces the core `SymbolMap`:
//   names+addresses+kind from `.symtab` (always), declaration shapes from the DWARF
//   types-sidecar the project links in (when present — `hasTypeInfo` is the detector; absent
//   ⇒ names-only, gracefully). The join is by NAME: the sidecar's variable DIEs carry
//   name→type (declarations, no addresses), the symtab carries name→address.
//
// Alias policy (addresses are NOT unique in real projects): every symbol at an address is
// kept, ordered so `[0]` is the canonical pick — header-declared (DIE-joined) names first,
// placeholder names (`sub_08xxxxxx` rename leftovers, declared in no header) last.
//
// CAPABILITY GATE (`assertShapeFactsPresent`): shape recovery needs @gba-kit/debug-info's 0.4
// facts — member signedness and the cv-qualifier flags. A 0.3-era package DOES export
// `variableShape`, so a method-existence check passes while the facts silently go missing, and
// the emitted map is PARTIAL: every `volatile` MMIO global loses its qualifier and every struct
// member loses its signedness, which are exactly the facts the declaration synthesis needs to
// spell bytes correctly. That is the plausible-but-wrong class this project refuses, so the
// provider REFUSES LOUDLY instead (the CLI converts the throw to exit 66). Probed by KEY
// PRESENCE, never by version string — the shipped package labelling is not a reliable witness
// of its own capability.
import type { SymbolInfo, SymbolMap } from '@asmlift/core/symbols';
import { readFileSync } from 'node:fs';

/** `variableShape` result — declared structurally so this package does not depend on
 *  @gba-kit/debug-info's exported types. The cv-qualifier flags are OPTIONAL at this boundary
 *  only because the type must describe both a qualified and an unqualified declaration; their
 *  runtime AVAILABILITY is asserted separately (assertShapeFactsPresent). */
type DwarfShape =
  | { kind: 'scalar'; size: number | null; signed: boolean | null; volatile?: boolean; const?: boolean }
  | { kind: 'pointer'; volatile?: boolean; const?: boolean }
  | {
      kind: 'array';
      elemSize: number | null;
      elemSigned: boolean | null;
      length: number | null;
      volatile?: boolean;
      const?: boolean;
    }
  | { kind: 'struct'; structName: string | null; size: number | null; volatile?: boolean; const?: boolean };
type ShapeCapable = { variableShape?: (name: string) => DwarfShape | null };

/** `sub_08xxxxxx` / `_08xxxxxx`-style placeholder names — real symbols, but names no header
 *  declares; emitting one produces non-compiling output, so they never win the canonical pick. */
export const PLACEHOLDER = /^(?:sub_|_)[0-9A-Fa-f]{6,8}$/;

const UPGRADE = 'upgrade @gba-kit/debug-info to >= 0.4.0 (or drop tools.asmlift.elf to run without a map)';

/** The cv-qualifier facts, probed on the first shaped variable. A 0.3-era package returns the
 *  same object KINDS from `variableShape` but never sets `volatile`/`const`, so a
 *  method-existence check passes while every volatile MMIO global silently loses the qualifier
 *  its correct declaration needs. Key presence is the only honest witness — the package labels
 *  itself 0.3.0 in builds that DO carry the facts, so a version comparison would be wrong in
 *  both directions. */
function assertShapeFactsPresent(sh: DwarfShape, elfPath: string): void {
  if (!('volatile' in sh)) {
    throw new Error(
      `cannot build a symbol map from ${elfPath}: the installed @gba-kit/debug-info reports no ` +
        `cv-qualifier facts (variableShape() result has no 'volatile' key), so every volatile ` +
        `global would silently lose its qualifier — ${UPGRADE}`,
    );
  }
}

/** The same probe for struct MEMBERS: without per-member signedness a synthesized member is
 *  declared at a guessed signedness, which changes the bytes a load compiles to. */
function assertMemberFactsPresent(m: object, elfPath: string): void {
  if (!('signed' in m)) {
    throw new Error(
      `cannot build a symbol map from ${elfPath}: the installed @gba-kit/debug-info reports no ` +
        `struct-member signedness (member has no 'signed' key), so synthesized struct fields ` +
        `would be declared at a guessed signedness — ${UPGRADE}`,
    );
  }
}

export async function loadSymbolMap(elfPath: string): Promise<SymbolMap> {
  const { DebugInfo, STT_FUNC } = await import('@gba-kit/debug-info');
  const di = DebugInfo.fromElf(readFileSync(elfPath));
  const types = di.types as unknown as ShapeCapable;
  const shapeOf =
    di.hasTypeInfo && typeof types.variableShape === 'function'
      ? (name: string) => types.variableShape!(name)
      : (): DwarfShape | null => null;

  const map: SymbolMap = new Map();
  for (const s of di.symbols.symbols) {
    // ARM mapping symbols ($t/$d/$a) and local labels are not project names
    if (!s.name || s.name.startsWith('$') || s.name.startsWith('.')) {
      continue;
    }
    const kind: SymbolInfo['kind'] = s.type === STT_FUNC ? 'code' : 'data';
    const info: SymbolInfo = { name: s.name, kind };
    if (kind === 'data') {
      // Sized symtabs (GC/Wii-class projects carry st_size on every object symbol) enable
      // interior attribution from the symtab alone; GBA ldscript ABS symbols are size-0 and
      // skip this — their sizes come from the sidecar DWARF below, which also overrides.
      if (s.size > 0) {
        info.size = s.size;
      }
      const sh = shapeOf(s.name);
      if (sh) {
        assertShapeFactsPresent(sh, elfPath);
        info.declared = true;
        // cv-qualifiers ride every shape (declaration-fidelity for the synthesis layer:
        // volatile is load-bearing for MMIO codegen, const is the ROM-table spelling)
        if (sh.volatile) {
          info.volatile = true;
        }
        if (sh.const) {
          info.const = true;
        }
        if (sh.kind === 'array') {
          info.shape = 'array';
          if (sh.elemSize !== null) {
            info.elemSize = sh.elemSize;
          }
          if (sh.elemSigned !== null) {
            info.elemSigned = sh.elemSigned;
          }
          if (sh.elemSize !== null && sh.length !== null) {
            info.size = sh.elemSize * sh.length;
          }
        } else if (sh.kind === 'struct') {
          info.shape = 'struct';
          if (sh.size !== null) {
            info.size = sh.size; // DWARF wins over st_size — it is the declaration's own size
          }
          if (sh.structName !== null) {
            info.structName = sh.structName; // the real tag, for a readable synthesized decl
          }
          const layout = sh.structName ? di.struct(sh.structName) : null;
          if (layout) {
            // bitfield members are excluded: their read width never equals a field size, so
            // they must fall through to the honest cast spelling, never a wrong field name.
            // `signed` must be REPORTED by the package (assertMemberFactsPresent); a reported
            // null value is a genuine "DWARF didn't say", and stays absent rather than guessed.
            // `pointer`/`volatile` are kept only when true, same rule.
            info.layout = layout.members
              .filter((m) => m.bitWidth === undefined)
              .map((m) => {
                assertMemberFactsPresent(m, elfPath);
                const facts = m as { signed?: boolean | null; pointer?: true; volatile?: true };
                return {
                  name: m.name,
                  offset: m.offset,
                  size: m.size,
                  ...(typeof facts.signed === 'boolean' ? { signed: facts.signed } : {}),
                  ...(facts.pointer === true ? { pointer: true } : {}),
                  ...(facts.volatile === true ? { volatile: true } : {}),
                };
              });
          }
        } else if (sh.kind === 'pointer') {
          info.shape = 'pointer';
        } else {
          info.shape = 'scalar';
          if (sh.size !== null) {
            info.size = sh.size;
          }
          if (sh.signed !== null) {
            info.signed = sh.signed; // types the synthesized `extern T name;` decl
          }
        }
      }
    }
    const at = map.get(s.address);
    if (at) {
      at.push(info);
    } else {
      map.set(s.address, [info]);
    }
  }
  for (const infos of map.values()) {
    infos.sort(canonicalOrder);
  }
  return map;
}

/** declared-first, placeholders-last, then name — a deterministic canonical pick. Exported so
 *  the alias policy is pinned by an offline test rather than only by the ELF path. */
export function canonicalOrder(a: SymbolInfo, b: SymbolInfo): number {
  const declared = Number(b.declared ?? false) - Number(a.declared ?? false);
  if (declared !== 0) {
    return declared;
  }
  const placeholder = Number(PLACEHOLDER.test(a.name)) - Number(PLACEHOLDER.test(b.name));
  if (placeholder !== 0) {
    return placeholder;
  }
  return a.name.localeCompare(b.name);
}
