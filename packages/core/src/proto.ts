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
