// asmlift — declaration SYNTHESIS for self-declaring candidates
// (research/self-declaring-candidates-2026-07-26.md).
//
// A scored candidate that names map-derived symbols must compile WITHOUT the project's headers:
// this module renders the declaration block for exactly the symbols the candidate's tree
// references in a value context (Candidate.symbolRefs — derived from the candidate's final
// tree at enumeration, l3/symbol-refs.ts). It is a SCORING-LAYER
// concern only — backends never print declarations (a project user compiles asmlift output
// against their own headers, where a second declaration would collide).
//
// LIVES IN CORE (browser-pure, no Node imports) because BOTH scorers prepend it: the cli's
// Node/objdiff path (which re-exports this module unchanged) and the webapp's wasm scorer
// (score-wasm.ts) — one renderer, so the two scoring worlds cannot drift.
//
// Fidelity rules (each empirically verified against agbcc — see the research doc):
//   • struct decls are rebuilt from the map layout with explicit `u8 pad[]` gap fields — the
//     padded synthesis is byte-identical to the real header declaration;
//   • member/scalar SIGNEDNESS drives u8/s8/u16/s16/u32/s32 — an s8 field read is
//     ldrb+lsl+asr where u8 is ldrb alone, so a guessed signedness is a wrong-bytes decl;
//   • `volatile` is load-bearing (a non-volatile MMIO decl lets the compiler fold/reorder
//     accesses), `const` is the ROM-table spelling;
//   • code symbols get `void Name(void);` ONLY when value-referenced — call targets are never
//     in `symbolRefs` (core excludes them: prototyping a called symbol is C89 poison);
//   • nothing guesses, with TWO documented exceptions: a SHAPED symbol without the facts to
//     declare faithfully is SKIPPED — the candidate then fails to compile LOUDLY and is
//     dropped by rankBy. Exception one is the 4-byte signless-non-pointer cell (see
//     ENUM_IS_SIGNED): spelled s32 on the C89 enum=int rule. For a true enum that is the header
//     truth; the residual mis-spell class (a 4-byte nested-struct member word-read via a dot
//     field) can only LOSE score — the target bytes derive from the truth decls, so a
//     divergent compile can never false-match. Exception two is the NAME-ONLY data symbol
//     (`extern u32 name;` — see the default case): required to reproduce symtab-only map
//     rows outside project headers.
//
// WHERE THE ONLY-LOSES-SCORE ARGUMENT STOPS, because it was over-stated once already. It rests
// on the target bytes coming from the project's own TRUTH declarations, so a divergent decl
// compiles to different bytes and simply scores worse. That holds for every MAP-derived ref. It
// does NOT hold for a ref marked `synthesized` (rank.ts bareGlobalSymbols): there the name came
// out of the candidate's own asm and — through `access` — so did its width and signedness, so
// the declaration is FITTED to the bytes it is scored against and can only manufacture
// agreement. That is a sound artifact (decls + source really do compile to those bytes) and an
// unsound CLAIM if the decls are hidden, so a consumer publishing a verdict must show the block
// beside the source. Measured against the benchmark's own vendored maps, which this path never
// sees: of 28 fitted NARROW declarations over the 126 rankable agbcc rows, 26 agree with the
// project's real declaration and 2 do not.
import { type StructFieldDecl, renderStructDecl } from './backend/cfamily';
import { T } from './ir/types';
import type { SymbolRef } from './l3/symbol-refs';
import {
  ENUM_IS_SIGNED,
  type SymbolInfo,
  type SymbolStructField,
  arrayInnerExtents,
  declaredFields,
  pointeeFields,
  symbolFieldType,
} from './symbols';
import { C_TYPEDEFS } from './target';

/** The u8/s8/u16/s16/u32/s32 spelling for a 1/2/4-byte cell, or null (no faithful narrow type). */
function intType(size: number, signed: boolean): string | null {
  const base = size === 1 ? '8' : size === 2 ? '16' : size === 4 ? '32' : null;
  return base === null ? null : `${signed ? 's' : 'u'}${base}`;
}

/** `volatile const ` qualifier prefix (either may be absent). */
function quals(info: SymbolInfo): string {
  return `${info.volatile ? 'volatile ' : ''}${info.const ? 'const ' : ''}`;
}

/** One struct field's type, seated at its exact offset by the caller's pad discipline — THE shared
 *  map-field typing (symbols.ts `symbolFieldType`, which core's own legalization env also reads,
 *  so the declaration and the type the emitter reasoned against cannot drift). Member volatility
 *  is kept on the field decl here (`vu16 field;` — dropping it lets the compiler fold repeated
 *  reads), being a decl-only fact. */
const fieldType = symbolFieldType;

/** The padded `struct Tag { ... };` declaration for a layout: fields seated at exact offsets,
 *  gaps as explicit u8 pad arrays, rendered by THE shared struct renderer (core
 *  backend/cfamily.ts renderStructDecl — the same spelling the backend's recovered-struct
 *  decls use, so the two cannot drift). Returns null when the layout cannot be reproduced
 *  faithfully (an unsized member). */
function structDecl(tag: string, layout: SymbolStructField[] | undefined, size: number | undefined): string | null {
  // THE shared spellability predicate (symbols.ts): which members exist, and whether the layout
  // can be reproduced at all. Core's access rules gate on the SAME call, so a member this
  // declaration omits — an unsizable layout declined whole, a union alias dropped for its first
  // view — is a member no emitted expression can name.
  const members = declaredFields(layout);
  if (members === null) {
    return null;
  }
  const fields: StructFieldDecl[] = [];
  // The cursor is in BITS (declaredFields' own discipline) so bitfield members seat exactly.
  // Gaps pad as the u8 arrays they always were when both ends are byte-aligned, and as named
  // `u32 asmlift_pad_N : k` bitfields otherwise — split at 32-bit unit boundaries, matching the
  // no-straddle allocation rule declaredFields verified each kept member against. For a
  // bitfield-free layout every gap is byte-aligned, so the emitted text is unchanged.
  let bitCursor = 0;
  let pad = 0;
  const padTo = (lo: number): void => {
    while (bitCursor < lo) {
      // asmlift_-prefixed so a REAL member named pad_N (a decomp-header idiom) never collides
      const name = `asmlift_pad_${pad++}`;
      if (bitCursor % 8 === 0 && lo % 8 === 0) {
        fields.push({ name, type: T.array(T.u(8), (lo - bitCursor) / 8) });
        bitCursor = lo;
      } else {
        const k = Math.min(lo - bitCursor, 32 - (bitCursor % 32));
        fields.push({ name, type: T.u(32), bits: k });
        bitCursor += k;
      }
    }
  };
  for (const m of members) {
    const bits = m.bitWidth !== undefined;
    const lo = m.offset * 8 + (bits ? m.bitOffset! : 0);
    padTo(lo);
    fields.push({
      name: m.name,
      type: fieldType(m),
      ...(m.volatile ? { volatile: true } : {}),
      ...(bits ? { bits: m.bitWidth } : {}),
    });
    bitCursor = bits ? lo + m.bitWidth! : (m.offset + m.size) * 8;
  }
  if (size !== undefined) {
    padTo(size * 8); // tail padding to the declared size
  }
  return renderStructDecl(tag, fields);
}

/**
 * Render the declaration block for a candidate's recorded symbol references. Deterministic
 * (refs arrive name-sorted from core; struct decls dedupe by tag). The block is prepended by
 * the candidate compiler AFTER the typedef prelude — it spells types as u8/s16/… — and only in
 * the self-declared world (the probe in compile-command.ts arbitrates; in the headers world
 * both prelude and declarations are dropped, headers own everything).
 */
export function renderDeclarations(refs: SymbolRef[]): string {
  const lines: string[] = [];
  const declaredTags = new Set<string>();
  for (const { name, info, access } of refs) {
    // An address-cast macro declares itself: the header's own body, verbatim. It must NOT become
    // an `extern` — that is the whole point of the fact (an extern emits a relocated pool word
    // where the macro emits the numeric one the target shows).
    if (info.macroBody !== undefined) {
      lines.push(`#define ${name} ${info.macroBody}`);
      continue;
    }
    if (info.kind === 'code') {
      // value-referenced code symbol ((u32)Func): any prototype makes the name visible, and
      // the address is arity-independent. Call targets never reach this module (core excludes
      // them from symbolRefs — see collectSymbolRefs).
      lines.push(`void ${name}(void);`);
      continue;
    }
    switch (info.shape) {
      case 'scalar': {
        // Signedness default: absent + 4 bytes is the enum idiom (int ⇒ s32); absent + narrow
        // has no honest spelling — skip (loud, see module note).
        const t =
          info.size !== undefined
            ? intType(info.size, info.signed ?? (info.size === 4 ? ENUM_IS_SIGNED : false))
            : null;
        if (t !== null && (info.signed !== undefined || info.size === 4)) {
          lines.push(`extern ${quals(info)}${t} ${name};`);
        }
        break;
      }
      case 'array': {
        // Element type mirrors core's bare `gSym[i]` env typing exactly (elemSigned ?? false).
        // A non-1/2/4 element width is never bare-indexed by core (only &gSym cast forms), so
        // an unsized u8[] decl is codegen-identical for every spelling core emits.
        const elem = info.elemSize !== undefined ? intType(info.elemSize, info.elemSigned ?? false) : null;
        // The RANK must be reproduced, or the declaration disagrees with the access core spells:
        // a `gSym[0][i]` needs a 2-D declaration to be an element rather than a type error. The
        // OUTERMOST extent is always left unsized — it is the one C lets a declaration omit, and
        // omitting it keeps this decl compatible with the project's real one whatever its size
        // (the same reason the rank-1 form has always been `[]`). Inner extents are load-bearing:
        // they are what scales each leading subscript, so they are spelled exactly.
        const rank = (arrayInnerExtents(info) ?? []).map((d) => `[${d}]`).join('');
        lines.push(`extern ${quals(info)}${elem ?? 'u8'} ${name}[]${rank};`);
        break;
      }
      case 'struct': {
        // With a layout: the padded struct decl + a typed extern (the `gSym.field` spelling
        // compiles against it). Without one, every core spelling is &gSym-based (a struct
        // global never spells bare), so an unsized u8[] extern is codegen-identical.
        const tag = info.structName ?? `Asmlift_${name}`;
        const decl = structDecl(tag, info.layout, info.size);
        if (decl !== null) {
          if (!declaredTags.has(tag)) {
            declaredTags.add(tag);
            lines.push(decl);
          }
          lines.push(`extern ${quals(info)}struct ${tag} ${name};`);
        } else {
          lines.push(`extern ${quals(info)}u8 ${name}[];`);
        }
        break;
      }
      case 'pointer': {
        // With a POINTEE layout the emitter may spell an interior as `gPtr->member`, which only
        // compiles against a pointer to that struct — so the pointee is declared here (the same
        // padded synthesis a struct global gets) and the extern is typed. The declared pointee
        // never changes bytes: the cell is 4 bytes whatever it addresses, and core's own lowering
        // makes every arithmetic stride EXPLICIT (`(u8 *)gPtr + K` / `(u32)gPtr`), so no emitted
        // expression is scaled by this type.
        // Without one, pointee fidelity is unnecessary — load/store/compare of the cell are
        // identical for any object-pointer type, and the output then never derefs through the
        // decl's pointee.
        // THE shared gate (symbols.ts pointeeFields): the typed extern is emitted on exactly
        // the condition under which core may spell `gPtr->member`, so the two cannot disagree.
        const tag = info.pointee?.structName;
        const decl =
          pointeeFields(info.pointee) !== null ? structDecl(tag!, info.pointee!.layout, info.pointee!.size) : null;
        if (decl !== null && !declaredTags.has(tag!)) {
          declaredTags.add(tag!);
          lines.push(decl);
        }
        // The POINTEE's own qualifiers bind to the pointed-at type (`volatile struct S *g`); the
        // cell's bind to the VARIABLE (`struct S *volatile g`). They are independent declarations
        // of two different objects, and the synthesis reproduces each on its own side of the `*`.
        const pointeeQuals = `${info.pointee?.volatile ? 'volatile ' : ''}${info.pointee?.const ? 'const ' : ''}`;
        const pointeeType = decl !== null ? `${pointeeQuals}struct ${tag} *` : `${pointeeQuals}void *`;
        lines.push(`extern ${pointeeType}${info.volatile ? 'volatile ' : ''}${info.const ? 'const ' : ''}${name};`);
        break;
      }
      default: {
        // Name-only (no sidecar shape) — the second documented exception (see the module note;
        // the first is the 4-byte signless enum cell). Skipping here was the original rule, but
        // it made every named-spelling row of a symtab-only map project (marioparty3: names
        // with no DWARF shapes) unreproducible in the self-declared world — the benchmark
        // compiled those candidates inside the project headers, which declare the symbol.
        // The width authority is the candidate's OWN IR (ref.access, rank.ts
        // bareGlobalAccessFacts): a bare `name = v` / `x = name` compiles to the access the
        // tree performed only under a decl of that exact width (`extern u16 g;` is `sh` where
        // a guessed u32 is `sw`). Without a bare off-0 access fact, every core spelling goes
        // through `&name` casts, where any object decl is address-identical — u32 is the
        // fallback cell.
        // For a MAP-derived name-only symbol (symtab-only projects) the only-loses-score
        // argument applies. For a `synthesized` one it does not — the width came from the
        // target's own asm, so this line is a hypothesis fitted to the bytes; see the module
        // note's "WHERE THE ONLY-LOSES-SCORE ARGUMENT STOPS".
        const t = access ? intType(access.width, access.signed) : null;
        lines.push(`extern ${quals(info)}${t ?? 'u32'} ${name};`);
        break;
      }
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** The object-like `#define`s out of a rendered declaration block.
 *
 *  Address-cast macro defines are the one part of a synthesized block that must survive into the
 *  HEADERS world too. Everything else there is owned by the injected headers (a duplicate typedef
 *  or struct definition is a C89 hard error), but a duplicate `#define` with an identical body is
 *  legal — and a PREPROCESSED project context has no macros left at all, so dropping these turns a
 *  macro-named candidate into an `undeclared identifier` rather than a spelling choice. */
export function macroDefinesOf(declarations: string | undefined): string {
  if (!declarations) {
    return '';
  }
  const lines = declarations.split('\n').filter((l) => l.startsWith('#define '));
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** THE self-declared world's compilation context: asmlift's typedef prelude followed by this
 *  candidate's declaration block. One composition with two callers — the cli's compile seam
 *  (compile-command.ts, whose probe decides whether the world is self-declared at all) and the
 *  webapp's wasm scorer, which is ALWAYS in it — because two hand-rolled copies of
 *  `C_TYPEDEFS + decls` is exactly how the two scoring worlds come to disagree about what a
 *  candidate was compiled in. */
export function selfDeclaredContext(declarations: string | undefined): string {
  return C_TYPEDEFS + (declarations ?? '');
}

/** The same context straight from a candidate's refs — what a scorer holding `Candidate`s (the
 *  webapp) needs, and the one place that decides an empty ref list renders no block at all. */
export function selfDeclaredContextFor(refs: SymbolRef[] | undefined): string {
  return selfDeclaredContext(refs?.length ? renderDeclarations(refs) : undefined);
}
