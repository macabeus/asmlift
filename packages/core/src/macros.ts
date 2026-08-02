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
  /** the cast type was volatile-qualified (`vu16`) — the MMIO idiom. Load-bearing: a
   *  non-volatile spelling lets the compiler fold or reorder repeated accesses. */
  volatile?: true;
}

/** The scalar type spellings a cast may use, and what each one means. Deliberately a CLOSED table:
 *  an unrecognized spelling (a project typedef, an enum, a struct) is refused rather than guessed,
 *  and every `volatile` alias is absent so it can never be silently dropped — the qualifier changes
 *  whether repeated reads may be folded, which is both a byte and a semantic difference. */
const SCALAR_TYPES: Record<string, { size: number; signed: boolean; volatile?: true }> = {
  u8: { size: 1, signed: false },
  s8: { size: 1, signed: true },
  u16: { size: 2, signed: false },
  s16: { size: 2, signed: true },
  u32: { size: 4, signed: false },
  s32: { size: 4, signed: true },
  // The `volatile` aliases. They were excluded so the qualifier could never be silently dropped;
  // it is now CARRIED instead (`volatile: true`, reproduced by every spelling this feeds), which
  // is the same guarantee without the cost — refusing them lost every MMIO register name a GBA
  // project has, since those are exactly the cells one declares volatile.
  vu8: { size: 1, signed: false, volatile: true },
  vs8: { size: 1, signed: true, volatile: true },
  vu16: { size: 2, signed: false, volatile: true },
  vs16: { size: 2, signed: true, volatile: true },
  vu32: { size: 4, signed: false, volatile: true },
  vs32: { size: 4, signed: true, volatile: true },
};

/** A pointer cast inside an address expression (`(void *)0x4000000`). The VALUE is the integer it
 *  wraps: these headers spell a register base as a `void *` and add a byte offset to it, which is
 *  GCC's byte-arithmetic extension, so the cast contributes nothing to the address.
 *
 *  BYTE-SIZED POINTEES ONLY, and that restriction is load-bearing rather than tidy. C pointer
 *  arithmetic SCALES by the pointee: `(vu16 *)0x4000000 + 5` is 0x400000A, not 0x4000005. Stripping
 *  a wider cast would fold the wrong address AND then republish it in a synthesized body that
 *  agrees with itself — so the candidate still byte-matches the numeric pool word it was looked up
 *  by, while naming a different register. A wrong name that survives the differ is the one failure
 *  this module cannot let through.
 *
 *  A wider pointee is REFUSED EXPLICITLY below, not left to fall out of the token grammar further
 *  down — the enforcing line belongs next to the rule it enforces. The cost is named rather than
 *  hidden: a wider cast with NO arithmetic after it would fold correctly and is refused anyway,
 *  because the hazard is cast-THEN-add and this cannot tell which it is looking at. */
const PTR_CAST_ANY = /\(\s*(\w+)\s*\*\s*\)/g;
const BYTE_POINTEE = new Set(['void', 'u8', 's8', 'vu8', 'vs8']);

/** `src` with byte-sized pointer casts removed, or null if any cast SCALES. */
function stripPointerCasts(src: string): string | null {
  let scaling = false;
  const out = src.replace(PTR_CAST_ANY, (_m, pointee: string) => {
    if (!BYTE_POINTEE.has(pointee)) {
      scaling = true;
    }
    return ' ';
  });
  return scaling ? null : out;
}

/** An object-like `#define NAME body`, for the expansion table the address evaluator resolves
 *  identifiers against. Function-like macros (`NAME(x)`) are deliberately excluded: an address
 *  expression that calls one is refused, not expanded. */
const OBJECT_DEFINE = /^\s*#define\s+([A-Za-z_]\w*)\s+(\S.*?)\s*$/;

/**
 * Evaluate a macro's ADDRESS operand to a number, or null when it is not a constant expression
 * this module can be sure of.
 *
 * Real decomp headers rarely write the address as a literal. The Klonoa headers spell every
 * register as `(*(vu16 *)REG_ADDR_BLDALPHA)` over `REG_ADDR_BLDALPHA = (REG_BASE +
 * REG_OFFSET_BLDALPHA)`, `REG_BASE = (void *)0x4000000`, `REG_OFFSET_BLDALPHA = 0x52` — so a
 * literal-only recognizer sees none of the 466 `REG_*` names, and reads every MMIO cell as a
 * decimal address instead.
 *
 * The accepted language is deliberately tiny — integer literals, `+`, `-`, parentheses, pointer
 * casts (see {@link PTR_CAST}), and identifiers that resolve to another object-like define. Any
 * other token, an unknown identifier, a function-like macro, a cycle, or a negative result refuses
 * the whole expression. Folding is done on the EXPANDED integer text, so an operand only ever
 * evaluates to a number every step of which this module recognized.
 */
function evalAddressExpr(
  src: string,
  defines: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
  memo: Map<string, number | null> = new Map(),
): number | null {
  if (seen.size > 12) {
    return null; // pathological nesting — refuse rather than walk further
  }
  const stripped = stripPointerCasts(src);
  if (stripped === null) {
    return null; // a scaling pointer cast — see PTR_CAST_ANY
  }
  const tokens = stripped.match(/[A-Za-z_]\w*|0[xX][0-9A-Fa-f]+|\d+|[()+-]/g);
  // every character must belong to a token — anything else (`*`, `<<`, a comma) is out of language
  if (!tokens || tokens.join('') !== stripped.replace(/\s+/g, '')) {
    return null;
  }
  const expanded: string[] = [];
  for (const tok of tokens) {
    if (/^[A-Za-z_]/.test(tok)) {
      const body = defines.get(tok);
      if (body === undefined || seen.has(tok)) {
        return null; // undefined name, or a cycle
      }
      // Memoized per NAME. The depth cap bounds nesting but not BRANCHING — a define mentioning k
      // others re-evaluates the whole subtree k times, so a deep, wide table costs exponentially.
      //
      // A name's result CAN depend on the path that reached it: both refusals below are
      // path-sensitive (already in `seen`; depth cap hit), so a cached `null` may be pessimistic
      // for a shorter path. Safe in ONE direction only — path-dependence can make this refuse
      // more, never fold a wrong address, which is the direction this module may be wrong in.
      //
      // The memo being PER TOP-LEVEL MACRO (the default parameter, fresh at each entry) is
      // load-bearing rather than incidental: hoisting it across macros to "go faster" would let
      // one deep macro poison a name for every macro after it, silently dropping recognized cells.
      let inner: number | null;
      if (memo.has(tok)) {
        inner = memo.get(tok)!;
      } else {
        inner = evalAddressExpr(body, defines, new Set([...seen, tok]), memo);
        memo.set(tok, inner);
      }
      if (inner === null) {
        return null;
      }
      expanded.push(`(${inner})`);
    } else if (/^0[xX]/.test(tok)) {
      expanded.push(String(Number.parseInt(tok, 16)));
    } else {
      expanded.push(tok);
    }
  }
  const folded = foldIntegerExpr(expanded.join(' '));
  return folded !== null && Number.isSafeInteger(folded) && folded >= 0 ? folded : null;
}

/** Fold a fully-expanded `+`/`-`/parenthesis integer expression. Written out rather than handed to
 *  an evaluator so nothing outside that grammar can ever be executed. */
function foldIntegerExpr(text: string): number | null {
  const toks = text.match(/\d+|[()+-]/g);
  if (!toks || toks.join('') !== text.replace(/\s+/g, '')) {
    return null;
  }
  let at = 0;
  const expr = (): number | null => {
    let acc = term();
    if (acc === null) {
      return null;
    }
    while (toks[at] === '+' || toks[at] === '-') {
      const op = toks[at++];
      const rhs = term();
      if (rhs === null) {
        return null;
      }
      acc = op === '+' ? acc + rhs : acc - rhs;
    }
    return acc;
  };
  const term = (): number | null => {
    if (toks[at] === '(') {
      at++;
      const inner = expr();
      if (inner === null || toks[at] !== ')') {
        return null;
      }
      at++;
      return inner;
    }
    if (toks[at] === '-') {
      at++;
      const v = term();
      return v === null ? null : -v;
    }
    const tok = toks[at];
    if (tok === undefined || !/^\d+$/.test(tok)) {
      return null;
    }
    at++;
    return Number(tok);
  };
  const value = expr();
  return value !== null && at === toks.length ? value : null;
}

/** `#define NAME (*(TYPE *)ADDR)` — the ONE shape recognized, where ADDR is any constant
 *  expression {@link evalAddressExpr} can be sure of (a literal, or names that resolve to one).
 *  Anything else — a two-level indirection `(*(T **)…)`, a function-like macro, a bare integer
 *  constant — does not match and is therefore refused by construction. */
const ADDRESS_CAST = /^\s*#define\s+([A-Za-z_]\w*)\s+(\(\s*\*\s*\(\s*(\w+)\s*\*\s*\)\s*(.+?)\s*\))\s*$/;

/** A bare hex literal — the operand form whose macro body is already self-contained. */
const HEX_LITERAL = /^0[xX][0-9A-Fa-f]+$/;

/**
 * Recognize the address-cast macros in `cpp -dD` output, keyed by the address each names.
 *
 * REFUSALS, all of them because the alternative is a plausible-but-wrong spelling:
 *  - a cast type outside {@link SCALAR_TYPES} — a project typedef, an enum, a struct;
 *  - an address expression {@link evalAddressExpr} cannot fold to a definite number;
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
  // Pass 1: every object-like define, so an address expression can resolve the names it mentions.
  // A macro's address is frequently spelled in terms of others (`REG_BASE + REG_OFFSET_X`), and
  // those helpers are not themselves address casts — they exist only to be expanded.
  //
  // LAST DEFINITION WINS, and `#undef` is not modelled: the record is a flat list with no scope, so
  // a name redefined differently across translation units resolves to whichever came last. Sound
  // for a project whose headers agree (the Klonoa ELF redefines no name with a differing body);
  // a project where they disagree would need per-CU scoping, which the record does not carry.
  const defines = new Map<string, string>();
  for (const line of defineLines) {
    const d = OBJECT_DEFINE.exec(line);
    if (d) {
      defines.set(d[1], d[2]);
    }
  }
  const byAddress = new Map<number, AddressMacro>();
  const collided = new Set<number>();
  const seenNames = new Map<string, number>();
  for (const line of defineLines) {
    const m = ADDRESS_CAST.exec(line);
    if (!m) {
      continue;
    }
    const [, name, rawBody, typeName, addrText] = m;
    const type = SCALAR_TYPES[typeName];
    if (!type) {
      continue; // a spelling outside the closed table — refuse
    }
    const address = evalAddressExpr(addrText, defines, new Set([name]));
    if (address === null) {
      continue; // an address expression this module cannot be sure of — refuse
    }
    // The body must be SELF-CONTAINED and COMPILABLE, because it is republished verbatim as the
    // definition a reproduction compiles against (macroDefinesUsedBy) — a body naming
    // `REG_ADDR_VCOUNT` would need that macro, and its two helpers, carried along with it. An
    // unqualified literal address keeps the project's own spelling; anything else is re-spelled at
    // the address it evaluated to, which is the same cell and the same type.
    // A VOLATILE body is re-spelled even when its address is already a literal: the alias it uses
    // (`vu8`) is a PROJECT typedef, and the prelude a candidate compiles against declares only
    // u8/u16/u32 + s8/s16/s32. Keeping such a body verbatim republishes a `#define` that does not
    // compile — latent, because it only bites in the self-declared world.
    const body =
      HEX_LITERAL.test(addrText) && !type.volatile
        ? rawBody
        : `(*(${type.volatile ? 'volatile ' : ''}${type.signed ? 's' : 'u'}${type.size * 8} *)0x${address.toString(16).toUpperCase()})`;
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
    byAddress.set(address, {
      name,
      address,
      body,
      size: type.size,
      signed: type.signed,
      ...(type.volatile ? { volatile: true as const } : {}),
    });
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
