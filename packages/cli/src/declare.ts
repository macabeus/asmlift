// asmlift — declaration SYNTHESIS for self-declaring candidates
// (research/self-declaring-candidates-2026-07-26.md).
//
// A scored candidate that names map-derived symbols must compile WITHOUT the project's headers:
// this module renders the declaration block for exactly the symbols the candidate's tree
// references in a value context (SFn.symbolRefs → Candidate.symbolRefs). It is a SCORING-LAYER
// concern only — backends never print declarations (a project user compiles asmlift output
// against their own headers, where a second declaration would collide).
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
//   • nothing guesses, with ONE documented exception: a symbol without the facts to declare
//     faithfully is SKIPPED — the candidate then fails to compile LOUDLY and is dropped by
//     rankBy, while the '/raw-globals' sibling (which names nothing) still scores. The
//     exception is the 4-byte signless-non-pointer cell (see enumIsSigned): spelled s32 on the
//     C89 enum=int rule. For a true enum that is the header truth; the residual mis-spell class
//     (a 4-byte nested-struct member word-read via a dot field) can only LOSE score — the
//     target bytes derive from the truth decls, so a divergent compile can never false-match.
import type { SymbolRef } from '@asmlift/core/l3/ast';
import type { SymbolInfo, SymbolStructField } from '@asmlift/core/symbols';

/** The u8/s8/u16/s16/u32/s32 spelling for a 1/2/4-byte cell, or null (no faithful narrow type). */
function intType(size: number, signed: boolean): string | null {
  const base = size === 1 ? '8' : size === 2 ? '16' : size === 4 ? '32' : null;
  return base === null ? null : `${signed ? 's' : 'u'}${base}`;
}

/** `volatile const ` qualifier prefix (either may be absent). */
function quals(info: SymbolInfo): string {
  return `${info.volatile ? 'volatile ' : ''}${info.const ? 'const ' : ''}`;
}

/** One struct field line, seated at its exact offset by the caller's pad discipline. A POINTER
 *  member spells `void *` — an integer guess flips relational compares of the loaded value
 *  (s32 `blt` vs the pointer truth's `bcc`), the audit's confirmed wrong-bytes class. Member
 *  volatility is kept (`vu16 field;` — dropping it lets the compiler fold repeated reads).
 *  Fields whose size is not a 1/2/4 scalar cell (nested structs, char[N], 8-byte members)
 *  become `u8 name[size]` byte arrays — same bytes, and the layout's field-spelling gate in
 *  core only ever names exact (offset, width∈{1,2,4}) matches, so such a field is never
 *  dot-accessed. Signedness default mirrors core's env typing (`signed ?? false` — unsigned),
 *  EXCEPT the 4-byte no-base-type case (an enum member): C89 enums are int, so s32. */
function fieldDecl(f: SymbolStructField & { size: number }): string {
  const vol = f.volatile ? 'volatile ' : '';
  if (f.pointer && f.size === 4) {
    return `${vol}void *${f.name};`;
  }
  const t = intType(f.size, f.signed ?? (f.size === 4 ? enumIsSigned : false));
  return t !== null ? `${vol}${t} ${f.name};` : `${vol}u8 ${f.name}[${f.size}];`;
}
// A 4-byte member/scalar with NO base-type signedness is the enum idiom — C89 says int.
const enumIsSigned = true;

/** The padded `struct Tag { ... };` declaration for a layout — the backend structDecls idiom
 *  (fields seated at exact offsets, gaps as explicit u8 pad arrays), rebuilt from map facts.
 *  Returns null when the layout cannot be reproduced faithfully (an unsized member). */
function structDecl(tag: string, layout: SymbolStructField[], size: number | undefined): string | null {
  const fields: string[] = [];
  let cursor = 0;
  let pad = 0;
  const members = [...layout].sort((a, b) => a.offset - b.offset);
  for (const m of members) {
    if (m.size === null) {
      return null; // an unsizable member — no faithful layout, decline the whole struct
    }
    if (m.offset < cursor) {
      continue; // an overlapping (union) member: keep the first view, skip the alias
    }
    if (m.offset > cursor) {
      // asmlift_-prefixed so a REAL member named pad_N (a decomp-header idiom) never collides
      fields.push(`u8 asmlift_pad_${pad++}[${m.offset - cursor}];`);
    }
    fields.push(fieldDecl(m as SymbolStructField & { size: number }));
    cursor = m.offset + m.size;
  }
  if (size !== undefined && size > cursor) {
    fields.push(`u8 asmlift_pad_${pad}[${size - cursor}];`); // tail padding to the declared size
  }
  return `struct ${tag} { ${fields.join(' ')} };`;
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
  for (const { name, info } of refs) {
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
          info.size !== undefined ? intType(info.size, info.signed ?? (info.size === 4 ? enumIsSigned : false)) : null;
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
        lines.push(`extern ${quals(info)}${elem ?? 'u8'} ${name}[];`);
        break;
      }
      case 'struct': {
        // With a layout: the padded struct decl + a typed extern (the `gSym.field` spelling
        // compiles against it). Without one, every core spelling is &gSym-based (a struct
        // global never spells bare), so an unsized u8[] extern is codegen-identical.
        const tag = info.structName ?? `Asmlift_${name}`;
        const decl = info.layout ? structDecl(tag, info.layout, info.size) : null;
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
      case 'pointer':
        // Pointee fidelity is unnecessary: load/store/compare of the 4-byte cell are identical
        // for any object-pointer type, and asmlift's cast-heavy output never derefs through the
        // decl's pointee. Qualifiers bind to the VARIABLE (`void *volatile g`), matching the
        // top-level cv chain the provider collected.
        lines.push(`extern void *${info.volatile ? 'volatile ' : ''}${info.const ? 'const ' : ''}${name};`);
        break;
      default:
        // name-only (no sidecar shape): nothing guesses — skip; the candidate fails loud and
        // the '/raw-globals' sibling keeps scoring.
        break;
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
