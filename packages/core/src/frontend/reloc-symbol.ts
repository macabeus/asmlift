// asmlift — the symbol-naming policy for relocations, as data.
//
// A relocation hands the frontend a LINKER's name, and a linker's namespace is strictly larger than
// C's: it holds anonymous constant pools, section-relative labels, C++ vtables and mangled
// function-scope statics, none of which any C or C++ source can spell. Recovering an address is
// only half the job — the other half is deciding, per KIND of name, whether the recovered global
// can be written down at all.
//
// The failure this exists to prevent is the one m2c shipped as `unksp0` for years: a gap rendered
// as an ordinary-looking identifier. `__vt__6System` is the sharpest case — `extern u32
// __vt__6System;` COMPILES, so nothing downstream would ever complain; the candidate would simply
// be wrong in a way that reads as right. So the decision is made here, once, by the shape of the
// name, and every refusing kind gets its own sentence naming what was seen.
//
// Consumed by frontend/ppc.ts, which refuses before it recovers. A kind is listed only when it
// behaves differently: the decomp projects' generated labels (`lbl_1_bss_2464`, `fn_1_458`) are
// ordinary identifiers that the project's own headers declare and its own sources spell, so they
// are `plain` and get no entry of their own.

/** What sort of name a relocation carries. Everything but `plain` is unspellable in C. */
export type RelocSymbolKind =
  'plain' | 'anon-pool' | 'section-local' | 'local-static' | 'cpp-vtable' | 'not-an-identifier';

/** Classify a relocation's symbol by its spelling. Order matters: the three shapes that ARE valid
 *  C identifiers (`__vt__…`) or contain characters a C identifier may not (`@`, `.`, `$`) are each
 *  recognised before the general identifier test, so the catch-all below can be exactly "a name of
 *  no kind this policy knows, and not an identifier either". */
export function classifyRelocSymbol(sym: string): RelocSymbolKind {
  if (sym.startsWith('@')) {
    return 'anon-pool'; // `@193` — mwcc's anonymous string/constant pool entries
  }
  if (sym.startsWith('.')) {
    return 'section-local'; // `...bss.0`, `.rodata` — an offset into a section
  }
  if (sym.includes('$')) {
    return 'local-static'; // `sprHideTbl$797` — a function-scope static plus mwcc's TU-wide counter
  }
  if (sym.startsWith('__vt__')) {
    return 'cpp-vtable'; // `__vt__6System` — a compiler-emitted virtual table
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(sym) ? 'plain' : 'not-an-identifier';
}

/** Why a symbol of this kind cannot be written into a candidate, as the tail of a refusal sentence
 *  — or null for the one kind that can. The caller prefixes the function, mnemonic and address, so
 *  a reader of the artifact learns the kind without re-deriving it from the name. */
export function unspellableReason(sym: string): string | null {
  switch (classifyRelocSymbol(sym)) {
    case 'plain':
      return null;
    case 'anon-pool':
      return (
        `names an anonymous constant pool entry ('${sym}') — the compiler generated that name for a ` +
        `literal it has no declaration for, so no C source can refer to it`
      );
    case 'section-local':
      return (
        `names a section-relative label ('${sym}') — it denotes an offset into a section, not an ` +
        `object, so there is nothing to declare`
      );
    case 'local-static':
      return (
        `names a function-scope static ('${sym}') — the suffix is a translation-unit-wide counter ` +
        `the compiler assigned, which no source can spell`
      );
    case 'cpp-vtable':
      return (
        `names a C++ virtual table ('${sym}') — the compiler emits it from a class definition, so ` +
        `no source spells it (and declaring it anyway would compile, which is why this refuses)`
      );
    case 'not-an-identifier':
      return `names '${sym}', which is not a C identifier`;
  }
}
