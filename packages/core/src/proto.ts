import type { SymbolMap } from './symbols';

// asmlift — function prototypes: the single carrier for the caller-supplied facts a
// matching-decomp project reads from its headers (arg counts, parameter widths, void-ness). One
// `Prototypes` map, keyed by symbol, is threaded through every entry point and resolved at the
// point of use — a callee's `params` gives its call-site arity, a function's own entry gives its
// `returnsVoid` and the widths raise/paramwidth.ts checks against. It also keeps the frontend seam
// honest: a frontend receives prototypes, not a grab-bag of ISA-specific options.

/** One declared parameter, as its C type text (`"u8"`, `"s32"`, `"void *"`, `"int"`). Two facts
 *  are read off it: the list's LENGTH is the call-site arity (`protoArity`), and one entry's WIDTH
 *  (`declaredWidth`) is what raise/paramwidth.ts checks its inference against.
 *
 *  A DECLARED WIDTH ONLY VETOES, never pins. Where the asm carries a prologue extension the
 *  declaration contradicts, the declaration wins — it is a fact from the project's headers, where
 *  the extension is an inference off an encoding two different C sources produce. Where the asm
 *  carries no extension, this list is NOT consulted: pinning there would type every parameter of
 *  every row from the declaration, and a declared `u32` kills rank.ts's signed arm before the
 *  differ ever sees it. That half is an axis question and is not answered here. */
export type ParamType = string;

/** What the headers know about one function. All fields optional: a partial table (only
 *  callee arities, or only the current function's void-ness) is the common case. */
export interface FnProto {
  /** declared parameters — either a bare arity COUNT or the typed parameter list a header
   *  extraction produces (`["u8", "s32"]`). BOTH forms yield the call-site arity via
   *  `protoArity`; only the typed form carries a width. Omit to let the frontend fall back to its
   *  contiguous-arg-register heuristic. */
  params?: number | ParamType[];
  /** The declared return type is `void`. Read for the function under decompilation, where a
   *  trailing `bx lr` leaves a meaningless return register that must not surface as a `return`
   *  value — and, since the out-parameter path landed, for a CALLEE, where it is the only thing
   *  that tells an out-parameter frame from a hidden struct-return pointer.
   *
   *  THAT SECOND READER IS LOAD-BEARING AND THE FIELD IS UNCHECKED DATA, which is worth knowing
   *  before authoring one. `validatePrototypes` type-checks the boolean and can check no more:
   *  nothing in the assembly distinguishes the two frames, which is why the refusal exists. So a
   *  callee wrongly declared `void` turns a loud decline into a compiling, plausible, wrong
   *  program — measured on the shape the guard is for, `struct S4 mk(int); struct S4 s = mk(x);`
   *  lifts as `mk(&sp0); return (u8)sp0;` when `mk` is declared `returnsVoid` — where a callee
   *  wrongly declared NON-void, or left undeclared, only costs the lift. Under-declaring is the
   *  safe direction and this project has already shipped one wrong entry (a dataset row declaring
   *  `returnsVoid: true` for a function whose own reference returns `void *`).
   *
   *  Both readers see one field through two trust levels: caller-supplied on `--proto`, and
   *  machine-derived from DWARF through `prototypesFromSymbols`. Neither is distinguished here. */
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

/** Bit width per C89 base type on every target asmlift lifts (all ILP32). `long` is 32 here and
 *  would not be on an LP64 host, so it is a target fact rather than a language one. */
const BASE_WIDTHS: ReadonlyMap<string, number> = new Map([
  ['char', 8],
  ['short', 16],
  ['short int', 16],
  ['int', 32],
  ['long', 32],
  ['long int', 32],
]);

/** The bit width one declared parameter type spells, or `undefined` for a spelling this does not
 *  read — a project typedef, a struct, a `float`. UNDEFINED IS "NO OPINION", never "wide": the one
 *  consumer treats a width it can read as authority and a width it cannot as absence, so an
 *  unrecognized spelling leaves the asm's own inference standing.
 *
 *  A pointer is register-wide whatever it points at, which is the fact the `*` test carries. */
export function declaredWidth(t: ParamType): number | undefined {
  const s = t
    .replace(/\b(?:const|volatile)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (s.endsWith('*')) {
    return 32;
  }
  const own = /^([su])(8|16|32)$/.exec(s);
  if (own) {
    return Number(own[2]);
  }
  // `unsigned`/`signed` alone is `unsigned int`/`signed int`; the signedness itself is not a width.
  const base = s
    .replace(/\b(?:signed|unsigned)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return BASE_WIDTHS.get(base === '' && s !== '' ? 'int' : base);
}

/** Problems with a HAND-WRITTEN prototype table — empty when it is well formed.
 *
 *  `protoArity` above falls back to the arg-register heuristic on a `params` it cannot read, which
 *  is right when `params` is omitted and silent when it is mistyped: `params: "2"` then decompiles
 *  at a guessed arity, and a misspelled `returnsVoid` does nothing at all. Neither is visible in
 *  the output, so a table that came from outside is checked before it reaches either. */
export function validatePrototypes(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['must be an object mapping a symbol name to its prototype'];
  }
  const problems: string[] = [];
  for (const [sym, proto] of Object.entries(value)) {
    if (typeof proto !== 'object' || proto === null || Array.isArray(proto)) {
      problems.push(`${sym}: must be an object, e.g. {"params": 2}`);
      continue;
    }
    for (const key of Object.keys(proto)) {
      if (key !== 'params' && key !== 'returnsVoid') {
        problems.push(`${sym}: unknown key "${key}" (expected "params" or "returnsVoid")`);
      }
    }
    const { params, returnsVoid } = proto as { params?: unknown; returnsVoid?: unknown };
    if (params !== undefined) {
      const countOk = typeof params === 'number' && Number.isInteger(params) && params >= 0;
      const listOk = Array.isArray(params) && params.every((t) => typeof t === 'string');
      if (!countOk && !listOk) {
        problems.push(`${sym}: "params" must be a non-negative integer or a list of type strings`);
      }
    }
    if (returnsVoid !== undefined && typeof returnsVoid !== 'boolean') {
      problems.push(`${sym}: "returnsVoid" must be a boolean`);
    }
  }
  return problems;
}

/** The C type spelling for one declared parameter/return, or null when the facts do not
 *  determine one. A pointer is `void *` — address-identical to any object pointer, and asmlift
 *  makes every stride explicit — so nothing is guessed about what it points at. A richer spelling
 *  would also be INERT: `declaredWidth` answers 32 for every `*`, and a CALLEE's parameter types
 *  are read for the list's length alone (test/param-pointee-axis.test.ts). */
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
