// asmlift — the DECLARATION half of candidate enumeration, split out of rank.ts. A candidate's
// source names globals its own asm named, and outside the project's headers those names need
// declarations or every candidate fails to compile. This module answers three questions about
// them and nothing else: what the tree's own IR says about a bare global's ACCESS
// (`bareGlobalAccessFacts`), which names exist at all (`bareGlobalSymbols`), and which of them a
// declaration must REFUSE to claim (`makeRefCollector`, via `RefusedDeclarationReason`).
//
// It knows nothing about axes, levers or ranking: the enumeration driver hands it a dictionary and
// asks each emitted tree for its references. A SIBLING MODULE, never a `rank/` directory — see the
// same note on rank-axes.ts.
import { type Fn, type Value, defOpMap } from './ir/core';
import type { SFn } from './l3/ast';
import { type SymbolRef, collectSymbolRefs } from './l3/symbol-refs';
import type { SymbolInfo } from './symbols';
import { C_TYPEDEFS } from './target';

/** Bare-global ACCESS FACTS for name-only map symbols — the width/signedness authority the
 *  declaration synthesis (declare.ts) uses when the map has no shape. The map knows only the
 *  NAME (symtab-only projects: marioparty3); the candidate's own IR knows exactly how the cell
 *  is accessed, and the bare `gSym = v` / `x = gSym` spelling compiles to those bytes only
 *  under a decl of that exact width (`extern u16 g;` is `sh` where a guessed u32 is `sw`).
 *  Mirrors structure()'s scalar-global rule: a fact is recorded only for a symbol accessed
 *  EXCLUSIVELY at offset 0 with ONE width and ONE load signedness — anything else (interior
 *  offsets, address arithmetic, width or sign conflicts) records nothing, because those
 *  spellings go through `&gSym` casts where every object decl is address-identical. */
export function bareGlobalAccessFacts(fn: Fn): Map<string, { width: number; signed: boolean }> {
  const defs = defOpMap(fn);
  const symOf = (v: Value): string | null => {
    const d = defs.get(v);
    return d?.opcode === 'gaddr' && d.attrs.code !== true ? (d.attrs.sym as string) : null;
  };
  const acc = new Map<string, { widths: Set<number>; signs: Set<boolean>; interior: boolean }>();
  const get = (s: string) => acc.get(s) ?? acc.set(s, { widths: new Set(), signs: new Set(), interior: false }).get(s)!;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'load' || op.opcode === 'store') {
        const s = symOf(op.operands[0]);
        if (s) {
          const a = get(s);
          if ((op.attrs.off as number) !== 0) {
            a.interior = true;
          } else {
            a.widths.add(op.attrs.width as number);
            if (op.opcode === 'load') {
              a.signs.add(((op.attrs.signed as boolean) ?? false) && (op.attrs.width as number) < 4);
            }
          }
        }
      } else if (op.opcode === 'aload' || op.opcode === 'astore') {
        const s = symOf(op.operands[0]);
        if (s) {
          get(s).interior = true;
        }
      } else {
        // any other use of the address (arithmetic, a call arg, a comparison) is interior/escape
        for (const o of op.operands) {
          const s = symOf(o);
          if (s) {
            get(s).interior = true;
          }
        }
      }
    }
  }
  const out = new Map<string, { width: number; signed: boolean }>();
  for (const [s, a] of acc) {
    if (!a.interior && a.widths.size === 1 && a.signs.size <= 1) {
      out.set(s, { width: [...a.widths][0], signed: a.signs.has(true) });
    }
  }
  return out;
}

/** Names a declaration must never claim, because `extern u32 <name>;` is not a declaration of
 *  `<name>` at all for them. Four groups, and only the first two are guessed:
 *
 *    1. the prelude's own typedef names, derived FROM `C_TYPEDEFS` rather than re-listed (a
 *       prelude that grows a name grows this set) — `extern u32 u16;` redefines the type the
 *       declaration is written in;
 *    2. the C89 keywords;
 *    3. the gnu89 keywords gcc-2.9 REJECTS in this position, and the two library objects it
 *       refuses to have redeclared. MEASURED against the pinned agbcc — 72 plausible pool names
 *       compiled as `extern u32 <name>;` at file scope, 18 exited non-zero: `syntax error before
 *       'asm'` for the keyword class, ``'exit' redeclared as different kind of symbol`` for the
 *       two built-ins;
 *    4. the gnu89 declaration SPECIFIERS that PARSE and thereby declare nothing — `inline`,
 *       `__const`, `__volatile__`, … are `warning: useless keyword or type name in empty
 *       declaration`, exit 0, and the name is still undeclared. Emitting the line would be a
 *       declaration that is not one.
 *
 *  WHAT REFUSING BUYS is less than a plain `'<name>' undeclared`, and the difference is the
 *  reason the refusal is REPORTED rather than trusted to the compiler. A hard error in the block
 *  kills that candidate's whole TU (its own — every candidate compiles alone) for a name it
 *  merely mentioned, so refusing is right. But for a KEYWORD the body spells the same token
 *  anyway and the candidate still fails: the refusal only moves the diagnostic. And for the two
 *  BUILT-INS nothing fails — agbcc reads `&exit` as the address of its own builtin, exit 0 with
 *  `warning: built-in function 'exit' used without declaration`, where the declaration would have
 *  been exit 1. There the refusal trades a candidate that cannot build for one that builds
 *  against the wrong object, which is the better half of a bad choice only because a target
 *  naming a global `exit` has no honest spelling either way. */
const DECL_RESERVED = new Set<string>([
  ...[...C_TYPEDEFS.matchAll(/(\w+)\s*;/g)].map((m) => m[1]),
  ...(
    'auto break case char const continue default do double else enum extern float for goto if int long ' +
    'register return short signed sizeof static struct switch typedef union unsigned void volatile while'
  ).split(' '),
  // group 3 — measured hard errors (agbcc, `extern u32 <name>;` at file scope)
  ...(
    'asm __asm __asm__ typeof __typeof __typeof__ __attribute __attribute__ __extension__ __label__ ' +
    '__alignof __alignof__ __real__ __imag__ __func__ __FUNCTION__ exit abort'
  ).split(' '),
  // group 4 — measured "useless keyword ... in empty declaration": parses, declares nothing
  ...(
    'inline __inline __inline__ __const __const__ __signed __signed__ __volatile __volatile__ ' +
    '__restrict __restrict__ __complex__'
  ).split(' '),
]);

/** The emitter's own NAME GRAMMAR for storage it invents: parameters `a0, a1, …` (structure.ts
 *  names them positionally, so no rename can move one) and coalesced/temp locals `v0…`/`t0…`
 *  (structure.ts's `localNames` accepts exactly `/^[vt]\d+$/`). A pool or map symbol with one of
 *  these names cannot be declared beside the C that spells it — see the refusal in `refsOf`, which
 *  is the one that kills the spelling rather than the line.
 *
 *  Checked as a grammar IN ADDITION to the tree's own bound names, because the collision that
 *  matters is the one the tree cannot show: `localNames` DROPS a local whose name a written
 *  global already claims, so where the global is stored `tree.locals` is silent about it. The
 *  price is refusing a real global that happens to be named `v3` in a function that never mints
 *  one — measured at zero: over the benchmark corpus, in each row's own symbol world, no candidate
 *  references such a name, and no vendored symbol map on that sweep's checkouts contained one. The
 *  map's own name total is deliberately not quoted — it is a property of the checkouts the sweep
 *  ran over rather than of this repo, so nothing here can re-derive it. */
const EMITTER_NAME = /^[avt]\d+$/;

/** Why a name the candidate's tree references got NO declaration. Reported rather than silently
 *  applied, because an undeclared name and a REFUSED one produce the same `'x' undeclared` from
 *  the compiler and only the second one is asmlift's own decision. Same argument as `onLeverError`
 *  one screen down: a refusal nobody can see is indistinguishable from a capability that was
 *  never there.
 *
 *  ALL FIVE ARE DECIDED AT ONE POINT (`refsOf`), over the names the collector actually returns
 *  and AFTER the map/pool union — so the report and the rendered block are one list read two
 *  ways. A test applied where a name ENTERS can be undone by the other half of the union, and
 *  then the report contradicts the block beside it. */
export type RefusedDeclarationReason =
  | 'not-an-identifier' // a relocation name like `$L1` / `.rodata.str1`
  | 'reserved' // a name `extern u32 <name>;` cannot declare (DECL_RESERVED)
  | 'call-target' // the name is some call's target: `void F(void);` hard-errors over args
  | 'self-name' // the function's own name — its definition already declares it
  | 'emitter-name'; // a name the emitted C uses for its OWN locals and parameters

/** The globals a candidate names because its own asm named them, as name-only `SymbolInfo`s —
 *  half of the declaration-synthesis dictionary (the symbol map, where there is one, is the other).
 *
 *  asmlift does not need a map to EMIT a symbol name: the Thumb frontend reads it out of the
 *  `.s` file's own literal pool (`.word gBgTilemapBufs` → `gaddr`, thumb.ts's pool grammar) and
 *  the MIPS frontend out of an object relocation, and structure() spells such a `gaddr` as
 *  `&gSym`. So the invariant "a candidate's source only names symbols the map knows" is FALSE,
 *  and a consumer that compiles candidates OUTSIDE the project's own headers (the playground)
 *  needs these declarations or every candidate fails with "`gSym' undeclared".
 *
 *  `kind: 'data'` unconditionally: `code: true` is set only where a symbol MAP said so
 *  (frontend/thumb.ts), so map-less the IR cannot tell a function pointer from a data address —
 *  and it does not need to. structure() spells a `code`-less `gaddr` as `&Name`, and `&Name`
 *  under `extern u32 Name;` is the relocated address whatever Name really is.
 *
 *  NOTHING IS REFUSED HERE, deliberately: a name this walk drops is a name the union above it
 *  could put straight back. Every refusal is decided once, over the collector's output, in
 *  `refsOf` (see `RefusedDeclarationReason`).
 *
 *  A declaration built from this half is a HYPOTHESIS, and where `bareGlobalAccessFacts` gives it
 *  a width that width came out of the asm the candidate is scored against. The marker is
 *  `SymbolRef.synthesized`; the argument, and its price against the vendored maps, is declare.ts's
 *  module note. */
export function bareGlobalSymbols(fn: Fn): Map<string, SymbolInfo> {
  const out = new Map<string, SymbolInfo>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'gaddr' && typeof op.attrs.sym === 'string') {
        out.set(op.attrs.sym, { name: op.attrs.sym, kind: 'data' });
      }
    }
  }
  return out;
}

/** The reference collector one enumeration uses, over ONE dictionary. A factory rather than a
 *  free function because all four of its inputs are per-enumeration constants that must not vary
 *  per tree — naming them here is what keeps a caller from passing a different dictionary to two
 *  spellings of the same row.
 *
 *  ALL FIVE REFUSALS ARE DECIDED AT THIS ONE POINT, over the names the collector actually returns
 *  and AFTER the map/pool union — so the report and the rendered declaration block are one list
 *  read two ways. A test applied where a name ENTERS can be undone by the other half of the union,
 *  and then the report contradicts the block beside it. */
export function makeRefCollector(ctx: {
  /** the union the declarations are synthesized from: pool/reloc names, the shapes the asm
   *  evidences for them, and the project map — in increasing authority */
  declSymbols: Map<string, SymbolInfo>;
  /** the IR-derived width/signedness authority for a name-only symbol's declaration */
  accessFacts: ReadonlyMap<string, { width: number; signed: boolean }>;
  /** the project map alone — a name it does NOT know makes the ref a `synthesized` hypothesis */
  mapSymbols: ReadonlyMap<string, SymbolInfo> | undefined;
  /** reports a refusal at most once per (name, reason); the caller owns the dedup */
  refuse: (name: string, reason: RefusedDeclarationReason) => void;
}): (tree: SFn) => { symbolRefs?: SymbolRef[] } {
  const { declSymbols, accessFacts, mapSymbols, refuse } = ctx;
  return (tree: SFn): { symbolRefs?: SymbolRef[] } => {
    // The names THIS tree binds. Computed per tree because the emitter mints local names per
    // spelling — but the test below is NOT `bound` alone, and the difference is a wrong answer.
    const bound = new Set<string>([...tree.params.map((p) => p.name), ...tree.locals.map((l) => l.name)]);
    const refs = collectSymbolRefs(tree.body, declSymbols, tree.name, refuse).flatMap((r) => {
      // THE ONE REFUSAL THAT IS NOT A REFUSAL — a name the emitted C uses for its OWN storage
      // kills the SPELLING, because no declaration makes that candidate right and no declaration
      // makes it fail either. Two shapes, and the second is why the test is the emitter's whole
      // NAME GRAMMAR rather than this tree's bound set:
      //   READ — the tree binds `v0` and also spells `&v0` for the pool global. The local
      //     shadows the extern, so the candidate takes a stack address where the asm takes a
      //     relocated one. Withholding the declaration does not stop it compiling: its SIBLING
      //     names still get theirs, and the TU builds.
      //   WRITE — structure.ts drops a local whose name a WRITTEN global already claims
      //     (`localNames`, filtered by `globalNames`), so the collision is INVISIBLE in
      //     `tree.locals`: every use of the emitter's local binds the extern instead, and the
      //     loop pointer it was holding becomes a store to that global once per iteration.
      // Both compile, both are wrong, and a compiling wrong answer is the one outcome this
      // project trades nothing for — so the spelling dies here and `fanOut`'s catch reports it.
      // If every spelling of every tree dies, the row declines LOUDLY naming the collision.
      if (bound.has(r.name) || EMITTER_NAME.test(r.name)) {
        refuse(r.name, 'emitter-name');
        throw new Error(
          `cannot spell '${tree.name}': the target names a global '${r.name}', which is a name the ` +
            `emitted C uses for its own locals and parameters — no declaration can bind it`,
        );
      }
      // Applied to the UNION, not to the pool half on its way in: a map can supply `$LC0` or
      // `abort` as readily as a relocation can, and `extern u32 abort;` is the same hard error
      // whichever half it came from.
      if (!/^[A-Za-z_]\w*$/.test(r.name)) {
        refuse(r.name, 'not-an-identifier');
        return [];
      }
      if (DECL_RESERVED.has(r.name)) {
        refuse(r.name, 'reserved');
        return [];
      }
      // name-only symbols carry the IR-derived access facts — the width authority
      // for their synthesized declaration (shaped symbols keep the map's truth)
      const access = r.info.shape === undefined ? accessFacts.get(r.name) : undefined;
      // A ref no MAP accounts for is a hypothesis read out of the target asm, and it is marked
      // as one all the way to the consumer (SymbolRef.synthesized).
      const synthesized = mapSymbols?.has(r.name) ? {} : { synthesized: true as const };
      return [{ ...r, ...(access ? { access } : {}), ...synthesized }];
    });
    return refs.length ? { symbolRefs: refs } : {};
  };
}
