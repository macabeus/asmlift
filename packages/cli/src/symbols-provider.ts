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
// `variableShape` is @gba-kit/debug-info ≥0.4; on an older package the provider degrades to
// names-only exactly like a missing sidecar.
import type { SymbolInfo, SymbolMap } from '@asmlift/core/symbols';
import { readFileSync } from 'node:fs';

/** `variableShape` result (@gba-kit/debug-info ≥0.4) — declared structurally so this package
 *  keeps compiling against 0.3.x, where the method (and the runtime feature) simply degrade. */
type DwarfShape =
  | { kind: 'scalar'; size: number | null; signed: boolean | null }
  | { kind: 'pointer' }
  | { kind: 'array'; elemSize: number | null; elemSigned: boolean | null; length: number | null }
  | { kind: 'struct'; structName: string | null; size: number | null };
type ShapeCapable = { variableShape?: (name: string) => DwarfShape | null };

/** `sub_08xxxxxx` / `_08xxxxxx`-style placeholder names — real symbols, but names no header
 *  declares; emitting one produces non-compiling output, so they never win the canonical pick. */
const PLACEHOLDER = /^(?:sub_|_)[0-9A-Fa-f]{6,8}$/;

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
        info.declared = true;
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
          const layout = sh.structName ? di.struct(sh.structName) : null;
          if (layout) {
            // bitfield members are excluded: their read width never equals a field size, so
            // they must fall through to the honest cast spelling, never a wrong field name
            info.layout = layout.members
              .filter((m) => m.bitWidth === undefined)
              .map((m) => ({ name: m.name, offset: m.offset, size: m.size }));
          }
        } else if (sh.kind === 'pointer') {
          info.shape = 'pointer';
        } else {
          info.shape = 'scalar';
          if (sh.size !== null) {
            info.size = sh.size;
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

/** declared-first, placeholders-last, then name — a deterministic canonical pick. */
function canonicalOrder(a: SymbolInfo, b: SymbolInfo): number {
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
