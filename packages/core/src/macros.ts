// asmlift — address-cast macros: the OTHER way a project names a fixed RAM cell.
//
// Some decomp projects declare `extern u16 gCounter;` and let the linker place it; others write
// `#define gCounter (*(u16 *)0x03001234)`. Both read the same cell, but they are NOT
// interchangeable in the bytes an old compiler emits: an `extern` produces a RELOCATED literal-pool
// word (`.word gCounter`), the macro a NUMERIC one (`.word 0x3001234`). A target that shows the
// numeric word can therefore only be matched by the macro spelling — a symtab name will not do,
// and no `.symtab` carries these names in the first place (a macro is not a symbol).
//
// This module is the PURE recognizer over preprocessor output (`cpp -dD`). Everything it accepts is
// a fact it can name exactly; everything else is refused, because a wrong width or a dropped
// `volatile` is the plausible-but-wrong class — see the guards on {@link addressCastMacros}.

/** One recognized address-cast macro. */
export interface AddressMacro {
  name: string;
  /** the cell's address — the map key this macro names */
  address: number;
  /** the macro body VERBATIM, as the declaration must reproduce it */
  body: string;
  /** the cast's byte width */
  size: number;
  /** the cast type's signedness */
  signed: boolean;
}

/** The scalar type spellings a cast may use, and what each one means. Deliberately a CLOSED table:
 *  an unrecognized spelling (a project typedef, an enum, a struct) is refused rather than guessed,
 *  and every `volatile` alias is absent so it can never be silently dropped — the qualifier changes
 *  whether repeated reads may be folded, which is both a byte and a semantic difference. */
const SCALAR_TYPES: Record<string, { size: number; signed: boolean }> = {
  u8: { size: 1, signed: false },
  s8: { size: 1, signed: true },
  u16: { size: 2, signed: false },
  s16: { size: 2, signed: true },
  u32: { size: 4, signed: false },
  s32: { size: 4, signed: true },
};

/** `#define NAME (*(TYPE *)0xADDR)` — the ONE shape recognized. Anything else (a two-level
 *  indirection, an offset expression, a function-like macro, a bare integer constant) does not
 *  match and is therefore refused by construction. */
const ADDRESS_CAST = /^\s*#define\s+([A-Za-z_]\w*)\s+(\(\s*\*\s*\(\s*(\w+)\s*\*\s*\)\s*(0[xX][0-9A-Fa-f]+)\s*\))\s*$/;

/**
 * Recognize the address-cast macros in `cpp -dD` output, keyed by the address each names.
 *
 * REFUSALS, all of them because the alternative is a plausible-but-wrong spelling:
 *  - a cast type outside {@link SCALAR_TYPES} — including every `volatile` alias (`vu16`), whose
 *    qualifier must not be silently dropped;
 *  - two macros naming the SAME address (`REG_VCOUNT`/`REG_VCOUNT_L`/`REG_VCOUNT_H` at 0x04000006
 *    differ in width, and picking wrong turns an `ldrh` into an `ldrb`) — both are dropped;
 *  - one name defined at two addresses, which no correct spelling can disambiguate.
 */
export function addressCastMacros(cppOutput: string): Map<number, AddressMacro> {
  return addressCastMacrosFrom(cppOutput.split('\n'));
}

/** The same recognizer over already-split `#define NAME body` lines — what a DWARF
 *  `.debug_macinfo` reader produces once each definition is re-spelled as a directive. */
export function addressCastMacrosFrom(defineLines: readonly string[]): Map<number, AddressMacro> {
  const byAddress = new Map<number, AddressMacro>();
  const collided = new Set<number>();
  const seenNames = new Map<string, number>();
  for (const line of defineLines) {
    const m = ADDRESS_CAST.exec(line);
    if (!m) {
      continue;
    }
    const [, name, body, typeName, addrText] = m;
    const type = SCALAR_TYPES[typeName];
    if (!type) {
      continue; // unknown or volatile-qualified spelling — refuse
    }
    const address = Number.parseInt(addrText, 16);
    if (!Number.isFinite(address)) {
      continue;
    }
    const priorAddr = seenNames.get(name);
    if (priorAddr !== undefined && priorAddr !== address) {
      collided.add(priorAddr);
      collided.add(address);
      continue;
    }
    seenNames.set(name, address);
    const prior = byAddress.get(address);
    if (prior && prior.name !== name) {
      collided.add(address);
      continue;
    }
    byAddress.set(address, { name, address, body, size: type.size, signed: type.signed });
  }
  for (const addr of collided) {
    byAddress.delete(addr);
  }
  return byAddress;
}

/**
 * The `#define` lines for every address-cast macro in `symbols` that `source` actually names.
 *
 * A published source that spells `gCollisionMapPtr` only compiles where that macro is defined —
 * and a REPRODUCTION of it must therefore carry the definition, or the script the benchmark
 * publishes cannot build the very source it publishes. Selected by the names the source uses
 * rather than by the whole map, so a reproduction context stays the size of what it needs.
 *
 * Name-sorted and deduplicated: the materialized context must be byte-stable across machines.
 */
export function macroDefinesUsedBy(
  symbols: Map<number, { name: string; macroBody?: string }[]>,
  source: string,
): string {
  const used = new Map<string, string>();
  for (const infos of symbols.values()) {
    for (const info of infos) {
      if (info.macroBody === undefined || used.has(info.name)) {
        continue;
      }
      if (new RegExp(`\\b${info.name}\\b`).test(source)) {
        used.set(info.name, info.macroBody);
      }
    }
  }
  const names = [...used.keys()].sort();
  return names.length ? names.map((n) => `#define ${n} ${used.get(n)}`).join('\n') + '\n' : '';
}
