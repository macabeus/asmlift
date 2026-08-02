import type { SymbolMap } from './symbols';

// asmlift — function prototypes: the single carrier for the caller-supplied facts a
// matching-decomp project reads from its headers (arg counts, void-ness). One `Prototypes`
// map, keyed by symbol, is threaded through every entry point and resolved at the point of
// use — a callee's `params` gives its call-site arity, a function's own entry gives its
// `returnsVoid`. It also keeps the frontend seam honest: a frontend receives prototypes,
// not a grab-bag of ISA-specific options.

/** One declared parameter, as its C type text (`"u8"`, `"s32"`, `"void *"`). asmlift consumes
 *  only the COUNT today (call-site arity), but a project's header extraction naturally produces
 *  the typed list, and keeping it lets a later pass pin an argument's width/signedness. */
export type ParamType = string;

/** What the headers know about one function. All fields optional: a partial table (only
 *  callee arities, or only the current function's void-ness) is the common case. */
export interface FnProto {
  /** declared parameters — either a bare arity COUNT or the typed parameter list a header
   *  extraction produces (`["u8", "s32"]`). BOTH forms yield the call-site arity via
   *  `protoArity`; omit to let the frontend fall back to its contiguous-arg-register heuristic. */
  params?: number | ParamType[];
  /** the declared return type is `void`, so a trailing `bx lr` leaves a meaningless
   *  return register that must not surface as a `return` value. */
  returnsVoid?: boolean;
}

/** symbol → prototype. The function under decompilation and its callees share one table. */
export type Prototypes = Record<string, FnProto>;

/** The call-site arity a proto declares, normalizing the count form (`2`) and the typed-list
 *  form (`["u8", "s32"]`) to one number. `undefined` when `params` is omitted — the caller then
 *  falls back to its arg-register heuristic. Reading a typed list as its length is what lets a
 *  header-derived proto (`params: ["u8"]`) recover its argument instead of silently dropping it. */
export function protoArity(p: FnProto | undefined): number | undefined {
  if (typeof p?.params === 'number') {
    return p.params;
  }
  if (Array.isArray(p?.params)) {
    return p.params.length;
  }
  // Omitted OR malformed (e.g. a bare `"u8"` string reaching the untyped CLI `--proto` JSON):
  // fall back to the frontend's arg-register heuristic rather than misread a string's `.length`.
  return undefined;
}

/** The C type spelling for one declared parameter/return, or null when the facts do not
 *  determine one. A pointer is `void *` — address-identical to any object pointer, and asmlift
 *  makes every stride explicit — so nothing is guessed about what it points at. */
function typeSpelling(t: { size: number | null; signed: boolean | null; pointer?: boolean }): ParamType | null {
  if (t.pointer) {
    return 'void *';
  }
  if (t.size === 1 || t.size === 2 || t.size === 4) {
    // A signless 4-byte type is the C89 enum idiom (int); a signless NARROW one has no honest
    // spelling, and the width alone would not fix its load, so it is refused.
    if (t.signed === null) {
      return t.size === 4 ? 's32' : null;
    }
    return `${t.signed ? 's' : 'u'}${t.size * 8}`;
  }
  return null;
}

/**
 * Prototypes the project's own DWARF states, merged UNDER the caller's.
 *
 * A caller-supplied proto always wins: it comes from the user's headers or the benchmark
 * manifest, and it is the thing a real user actually has for the function they are decompiling.
 * The map fills the rest — in practice the CALLEES, since a function still written in assembly
 * has no signature in its project's ELF (see SymbolSignature).
 *
 * Every parameter must spell faithfully or the whole entry is dropped: a partly-typed list would
 * be read for its LENGTH and give the right arity with the wrong widths, which is worse than the
 * arg-register heuristic it would replace.
 */
export function prototypesFromSymbols(symbols: SymbolMap | undefined, base: Prototypes = {}): Prototypes {
  if (!symbols) {
    return base;
  }
  const out: Prototypes = { ...base };
  for (const infos of symbols.values()) {
    for (const info of infos) {
      if (info.kind !== 'code' || !info.signature || out[info.name] !== undefined) {
        continue;
      }
      const params = info.signature.params.map(typeSpelling);
      if (params.some((p) => p === null)) {
        continue;
      }
      out[info.name] = {
        params: params as ParamType[],
        ...(info.signature.returns === null ? { returnsVoid: true } : {}),
      };
    }
  }
  return out;
}
