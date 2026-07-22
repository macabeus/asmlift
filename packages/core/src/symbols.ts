// asmlift — the address→symbol map seam (research/symbol-map-plan-2026-07-22.md).
//
// A `SymbolMap` tells the pipeline what the project knows about its absolute addresses: the
// name (from the ELF `.symtab`), and optionally the byte-sensitive declaration shape (from the
// project's DWARF types-sidecar). Core only consumes the VALUE — providers that read files live
// in @asmlift/cli; tests and the webapp hand-build maps. Absent map ⇒ behavior byte-identical
// (the `prototypes`/`asmData` optionality contract).
//
// An address legitimately carries SEVERAL symbols in real projects (ldscript aliases, rename
// leftovers, deliberate typed views of one RAM region), hence `SymbolInfo[]` per address with
// the provider's canonical pick at index 0.

/** One field of a struct-shaped global, from the sidecar DWARF layout. */
export interface SymbolStructField {
  name: string;
  /** byte offset from the struct start */
  offset: number;
  /** bytes read at `offset` (null for flexible/unknown members) */
  size: number | null;
}

export interface SymbolInfo {
  name: string;
  kind: 'code' | 'data';
  /** a DWARF DIE exists for this name ⇒ the project headers declare it (safe to emit) */
  declared?: boolean;
  /** total byte size — complete-typed globals only; an unsized extern array has none */
  size?: number;
  /** the byte-sensitive declaration shape (drives P2 rendering; absent ⇒ name-only) */
  shape?: 'scalar' | 'array' | 'struct' | 'pointer';
  /** element byte width for `shape:'array'` — enables the bare `gSym[i]` spelling */
  elemSize?: number;
  /** element signedness for `shape:'array'` (default unsigned) — types the env entry */
  elemSigned?: boolean;
  /** field names/offsets for `shape:'struct'` — enables `gSym.field` interior spelling */
  layout?: SymbolStructField[];
}

/** address → symbols at that address; `[0]` is the provider's canonical pick. */
export type SymbolMap = Map<number, SymbolInfo[]>;

/** Kind-aware two-probe lookup for a pool-loaded 32-bit value. Exact match first (any kind);
 *  on miss, `value & ~1` — accepted ONLY when the hit is code, because ELF function addresses
 *  are stored with the Thumb bit cleared while a Thumb code pointer in a pool is odd. An exact
 *  odd-DATA hit therefore wins over a masked code hit (odd data addresses are real). */
export function lookupSymbol(map: SymbolMap, value: number): SymbolInfo | null {
  const exact = map.get(value)?.[0];
  if (exact) {
    return exact;
  }
  if ((value & 1) === 1) {
    const masked = map.get(value & ~1)?.[0];
    if (masked?.kind === 'code') {
      return masked;
    }
  }
  return null;
}

/** Interior attribution: the data symbol whose `[address, address+size)` range contains
 *  `value` strictly inside (offset > 0 — exact bases go through `lookupSymbol`). Only
 *  complete-typed globals carry a size, so unsized arrays never attribute. */
export function lookupInterior(map: SymbolMap, value: number): { info: SymbolInfo; offset: number } | null {
  for (const [addr, infos] of map) {
    const info = infos[0];
    if (info.kind !== 'data' || info.size === undefined) {
      continue;
    }
    if (value > addr && value < addr + info.size) {
      return { info, offset: value - addr };
    }
  }
  return null;
}

/** NAME-keyed view over every symbol in the map — what the structurer consumes (it sees gaddr
 *  symbol names, not addresses). Aliases at one address each appear under their own name. */
export function symbolsByName(map: SymbolMap): Map<string, SymbolInfo> {
  const byName = new Map<string, SymbolInfo>();
  for (const infos of map.values()) {
    for (const info of infos) {
      byName.set(info.name, info);
    }
  }
  return byName;
}
