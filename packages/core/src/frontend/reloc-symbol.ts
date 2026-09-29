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
// Consumed by frontend/ppc.ts, which refuses before it recovers, and by frontend/thumb.ts's
// literal-pool reader. A function-scope static is the one kind neither refuses by name: the
// function DEFINES it, so both read its definition out of the target (frontend/local-object.ts) and
// the lift writes it in the body under `localStaticSourceName`, refusing only where the definition
// cannot be read. Thumb asks about that kind alone rather than taking `unspellableReason`'s answer
// for every kind, because a pool word is not a relocation: agbcc packs `.L` labels into pools, and
// this policy calls a leading dot `section-local` — an offset into a section, not an object — which
// is false about a code label in the same file.
//
// A kind is listed only when it behaves differently: the decomp projects' generated labels
// (`lbl_1_bss_2464`, `fn_1_458`) are ordinary identifiers that the project's own headers declare
// and its own sources spell, so they are `plain` and get no entry of their own.
//
// THE SCOPE OF THIS POLICY IS THE NAME, AND ONLY ON A DATA RELOCATION.
//  • Not the TYPE. A name this passes is still rendered at the width the asm implies, which is a
//    different seam and fails loud in the compiler (docs/symbol-naming-policy.md).
//  • Not the LINKAGE. A file-scope `static` and an `extern` of the same name compile to the same
//    object under mwcc — same bytes, same named relocation — so the minted `extern` asserts
//    nothing the reference did not already assert (measured; see the doc).
//  • Not a `bl` CALLEE. Those reach the emitter through the call path and are NOT classified here:
//    a C++ row's candidate is compiled inside an `extern \"C\"` block, where a mangled name written
//    verbatim denotes exactly that symbol (apps/benchmark/src/compile/real.ts `candidateLinkage`),
//    so a callee needs no policy the way a global that must be DECLARED does.
//
// The evidence, the counts and the corpus behind every rule are in docs/symbol-naming-policy.md.

/** What sort of name a relocation carries. Everything but `plain` is unspellable in C. */
export type RelocSymbolKind =
  | 'plain'
  | 'anon-pool'
  | 'section-local'
  | 'local-static'
  | 'inline-local-static'
  | 'cpp-vtable'
  | 'cpp-mangled'
  | 'not-an-identifier';

/** `ident$N` (mwcc) or `ident.N` (gcc, and so agbcc): a static declared inside a function, whose
 *  SOURCE name is `ident`. Anchored whole, one numeric suffix: see the ordering note in
 *  {@link classifyRelocSymbol}. */
const LOCAL_STATIC = /^([A-Za-z_][A-Za-z0-9_]*)[.$](\d+)$/;

/** Classify a relocation's symbol by its spelling. Order matters twice over. The shapes that ARE
 *  valid C identifiers (`__vt__…`, a mangled class-scoped name) or contain characters a C
 *  identifier may not (`@`, `.`, `$`) are each recognised before the general identifier test, so
 *  the catch-all below can be exactly "a name of no kind this policy knows, and not an identifier
 *  either". And among themselves, the tests that look at a PREFIX come before the one that looks
 *  at a SUFFIX: a compiler is free to hang its static counter off a name of any other kind, and
 *  the kind is what picks the refusal sentence. */
export function classifyRelocSymbol(sym: string): RelocSymbolKind {
  if (sym.startsWith('@')) {
    return 'anon-pool'; // `@193` — mwcc's anonymous string/constant pool entries
  }
  if (sym.startsWith('.')) {
    return 'section-local'; // `...bss.0`, `.rodata` — an offset into a section
  }
  if (sym.startsWith('__vt__')) {
    return 'cpp-vtable'; // `__vt__6System` — a compiler-emitted virtual table
  }
  // mwcc names a static of an inlined HEADER function `<name>$localstatic<N>$<function>`
  // (`_half$localstatic3$sqrtf`, `…$sqrtf__Ff` in C++; weak, in every Animal Crossing target that
  // includes the libm header). The object belongs to the inline function's definition, not to the
  // function referencing it, so it is its own kind, and asked before the class-scope marker: the
  // trailing function name is the one part of the symbol that may carry a mangling.
  if (/^[A-Za-z_]\w*\$localstatic\d+\$/.test(sym)) {
    return 'inline-local-static';
  }
  // mwcc mangles a class-scoped name as `<name>__<length><Class>` (`statbuff__9CmdStream`) or,
  // for a nested scope, `<name>__Q<depth><…>` (`__ct__Q26Action5ChildFv`). The marker is the `__`
  // followed by that LENGTH or `Q<depth>`, never a double underscore on its own: a rule that fired
  // on `__` would refuse ordinary C globals like `g_my__table` and `__initialised`.
  //
  // THE MARKER IS THE SCOPE, NOT THE MANGLING, and the difference is deliberate. A free function's
  // parameter mangle (`makeObjectBoss__Fv`, `ARAMFinish__FUl` — 89 of the 24,236 distinct symbols a
  // data relocation names across the three checkouts) is `plain`: what this kind refuses is the
  // missing DECLARATION, and a free function has no class scope for the symbol map to suppress one
  // through. 0 of the 4,663 lifted functions in the same sweep emit such a name, so the line is
  // documented rather than moved; docs/symbol-naming-policy.md names the two measurements that
  // would have to come first.
  if (/__(?:\d|Q\d)/.test(sym)) {
    return 'cpp-mangled';
  }
  // A function-scope static plus the counter its compiler assigned: `sprHideTbl$797` (mwcc),
  // `tide.3` / `zeroes.13` (gcc, and so agbcc). Both counters are TRANSLATION-UNIT-wide rather
  // than per-function, which is why neither is reconstructible from the source: three functions in
  // one TU, compiled by this project's agbcc, give `pa.3`, `pb.7`, `pc.11` and `pc2.12` — the
  // number counts declarations across the whole unit and skips.
  //
  // LAST of the named kinds, and anchored to a WHOLE identifier plus ONE numeric suffix, because
  // `[.$]\d+$` alone is a suffix test and every other kind here can wear that suffix. Unanchored
  // and placed first it claimed `__vt__6System.1` and `statbuff__9CmdStream.0` — each then refused
  // with a sentence about a counter, for a name whose real problem is the class definition it
  // comes from — and it claimed gcc's IPA clones (`foo.isra.0`, `foo.part.0`, `foo.cold.1`), which
  // are not statics at all and fall to `not-an-identifier` where they belong. A `$` name of any
  // other shape (`$L1`) is not a static either.
  if (LOCAL_STATIC.test(sym)) {
    return 'local-static';
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
        `the compiler assigned, so no declaration elsewhere names the object; only its definition can`
      );
    case 'inline-local-static':
      return (
        `names a function-scope static of an inlined function ('${sym}') — the object belongs to ` +
        `that function's definition, which a source reaches by calling it, never by naming the object`
      );
    case 'cpp-vtable':
      return (
        `names a C++ virtual table ('${sym}') — the compiler emits it from a class definition, so ` +
        `no source spells it (and declaring it anyway would compile, which is why this refuses)`
      );
    case 'cpp-mangled':
      return (
        `names a C++ class-scoped symbol ('${sym}') — a reference spelled this way reaches exactly ` +
        `that symbol, but nothing here can DECLARE it: the row's own unit declares the member under ` +
        `its class scope, which this frontend does not decode, and the candidate would name an ` +
        `identifier no declaration introduces`
      );
    case 'not-an-identifier':
      return `names '${sym}', which is not a C identifier`;
  }
}

/** A function-scope static's linker name taken apart: the name the source wrote, and the counter
 *  the compiler appended (`tide.3` → `tide`, 3; `sprHideTbl$797` → `sprHideTbl`, 797) — or null
 *  for a name of any other kind, a static of an inlined function among them.
 *
 *  The counter is file-wide and counts DECLARATIONS, so within one function it is the order the
 *  source declared its statics in. agbcc names and emits each static in one call, made while it
 *  parses the declaration (toplev.c:2515-2529 `rest_of_decl_compilation`: varasm.c:690-698
 *  `make_decl_rtl` takes `var_labelno++`, then `assemble_variable` writes the data); mwcc numbers
 *  `z$4 a$5` in declaration order whatever order the code first reads them in (compiled). */
export function localStaticName(sym: string): { name: string; counter: number } | null {
  if (classifyRelocSymbol(sym) !== 'local-static') {
    return null;
  }
  const m = sym.match(LOCAL_STATIC)!;
  return { name: m[1], counter: Number(m[2]) };
}
