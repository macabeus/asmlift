// asmlift structurer — POINTER/INTEGER SPELLING: whether a value the asm did arithmetic on, or
// assigned into a temp or a pointer cell, is written as a pointer or as an integer, and through
// which cast. A global's C type is the project header's, which this pass cannot read, so each
// rule spells the asm's bytes under every declaration that header may carry; its doc names the
// declarations it covers and its known gaps.
//
// The factory takes its dependencies EXPLICITLY (`PointerSpellingDeps`), the switch-recover
// pattern. `varType` is captured as a LIVE reference: the naming pipeline is still declaring
// temps when the factory is created, and every rule types an expression over the declarations
// that exist at call time.
import { Op } from '../ir/core';
import { type IrType, T, typeEquals } from '../ir/types';
import { BinOp, Expr } from '../l3/ast';
import { exprCType, ptrElemBytes } from '../l3/typing';
import { type DeclaredField, type SymbolInfo, isPtrField, isScalarCellSize, scalarCellType } from '../symbols';

/** The slice of structure.ts's symbol-map rendering context these rules read. */
export interface PointerSpellingSymCtx {
  info(name: string): SymbolInfo | undefined;
  fieldsOf(name: string): DeclaredField[] | null;
}

/** The map member a `field` node NAMES, or null when it names none — THE one resolver for "what
 *  does the declaration say about this member", for rules that must reason about a member's type
 *  after the access rules have already spelled it. Both named spellings resolve, through the same
 *  shared gate their spelling passed: `gSym.member` off a struct global's {@link declaredFields},
 *  `gPtr->member` off the pointee's ({@link pointeeFields}). A synthesized `field_K` — the
 *  recovered-struct spelling, which no map declares — resolves to null, and so does any base that
 *  is not a map-shaped global, which is what makes every caller refuse rather than guess.
 *
 *  The pointee arm reaches only what the MAP lets it: `pointeeAccess` gates every `gPtr->member`
 *  spelling on `spellsAccessType(f.signed, …)`, so a pointer field declaring no signedness — which
 *  is every one in the corpus's vendored maps — is never named, and a pointer read one indirection
 *  down spells `((s32 *)gQ)[1]`. That is a fact about those maps, not about this code: `SymbolMap`
 *  is a caller-supplied input, and one field flips it (`signed: true` on a 4-byte pointer member
 *  of a pointee yields `(u8 *)gQ->pInner`, cast and all, pinned in pointer-members.test.ts). So
 *  the arm is live and tested, and the byte-arithmetic rule that reads this answer is correct for
 *  it — where resolving a pointee member to null would reopen the double-scaling hole silently. */
function declaredMemberOf(x: Expr, sym: PointerSpellingSymCtx | undefined): DeclaredField | null {
  if (x.k !== 'field' || x.base.k !== 'var' || sym === undefined) {
    return null;
  }
  return sym.fieldsOf(x.base.name)?.find((f) => f.name === x.name) ?? null;
}

/** The map member a `field` node names when the declaration makes it a POINTER — {@link
 *  isPtrField} being the shared two-fact test, so this and the synthesized declaration cannot
 *  disagree about what a member is. */
export function ptrMemberDecl(x: Expr, sym: PointerSpellingSymCtx | undefined): DeclaredField | null {
  const f = declaredMemberOf(x, sym);
  return f !== null && isPtrField(f) ? f : null;
}

export interface PointerSpellingDeps {
  /** absent ⇒ no map. */
  sym: PointerSpellingSymCtx | undefined;
  /** the globals the map declares pointers, for a structuring that does not spell from the map
   *  (the `pointerGlobals` structure option). */
  pointerGlobals: ReadonlySet<string> | undefined;
  /** the scalar globals the IR loads as a pointer at least once (structure.ts). */
  pointerLoadedGlobals: ReadonlySet<string>;
  /** the scalar globals the IR loads as a word (structure.ts). */
  wordLoadedGlobals: ReadonlySet<string>;
  /** each declared variable's type — LIVE, read at call time. */
  varType: ReadonlyMap<string, IrType>;
}

/** An integer arithmetic op's operands as spelled, and the pointer type the sum of them is cast
 *  back to, if any. */
export interface ArithSpelling {
  l: Expr;
  r: Expr;
  restoreTo: IrType | undefined;
}

export interface PointerSpelling {
  needsIntSpelling(x: Expr): boolean;
  intoDeclaredTemp(name: string, value: Expr): Expr;
  intoPtrCell(lval: Expr, value: Expr): Expr;
  ptrGlobalSide(x: Expr, sum: Op): boolean;
  arith(d: Op, op: BinOp, l: Expr, r: Expr): ArithSpelling;
}

export function makePointerSpelling(deps: PointerSpellingDeps): PointerSpelling {
  const { sym, pointerGlobals, pointerLoadedGlobals, wordLoadedGlobals, varType } = deps;
  const ctype = (e0: Expr): IrType | undefined => exprCType(e0, (n) => varType.get(n));

  /** The declared shape of a global as the pointer-value rules below read it: the map's, or a
   *  pointer the map declares to a structuring that does not spell from it (`pointerGlobals`). */
  const declaredShape = (name: string): SymbolInfo['shape'] =>
    sym?.info(name)?.shape ?? (pointerGlobals?.has(name) ? 'pointer' : undefined);
  /** Whether no declaration a spelling folds from types the global: the map's is the only one.
   *  The operand-order rules read this, not declaredShape: a declared pointer keeps `x + (u8 *)p`
   *  for the element and field spellings to read, and a `pointerGlobals` name has no pointee for
   *  them, so its sum is spelled in the asm's order like any other undeclared global's. */
  const mapUndeclared = (name: string): boolean => sym?.info(name)?.shape === undefined;

  /** A POINTER VALUE whose type the project's header owns: a bare `gSym` naming a pointer global
   *  (the VALUE of a pointer cell), or a named MEMBER whose declaration is a pointer (`gSym.pBuf`,
   *  `gPtr->pBuf`). Load, store and compare of such a 4-byte cell are identical for any
   *  object-pointer type, so the declared pointee never matters to THEM; arithmetic on the loaded
   *  value is the opposite case, where the pointee's size scales what is added and every stride
   *  must therefore be made explicit (`(u8 *)gPtr + K`). `ctype` cannot see any of this: it types
   *  only params/locals, so both spellings render `undefined` there.
   *
   *  A bare global is one when its declared shape is `'pointer'` (declaredShape), or when no
   *  declaration this pass can read says anything (no map, a symtab-only name, entries that
   *  disagree and were dropped to the bare name, a name the map lacks) and the IR loads it as a
   *  pointer at least once. The project still declares it, typically `struct S *`. A map
   *  `shape:'scalar'` is a declaration and is excluded; so is a global the IR never loads as a
   *  pointer (`gCount + 1`, or the `u8` index in `gIdx + gItems`), where casting would make a
   *  pointer of an integer the source added as one. */
  const isPtrValue = (x: Expr): boolean => {
    if (x.k !== 'var') {
      return ptrMemberDecl(x, sym) !== null;
    }
    const shape = declaredShape(x.name);
    return shape === 'pointer' || (shape === undefined && pointerLoadedGlobals.has(x.name));
  };

  /** A global's word VALUE that no declaration this pass can read types, whatever the IR loaded it
   *  as. */
  const isUndeclaredGlobalValue = (x: Expr): boolean =>
    x.k === 'var' && wordLoadedGlobals.has(x.name) && declaredShape(x.name) === undefined;

  /** A pointer value or a global's word as the integer the asm added. A global no declaration
   *  types and the IR never loads as a pointer may be declared a float, whose value `(u32)g`
   *  converts, so it goes through `(u8 *)` first: `(u32)(u8 *)g` is `(u32)g`'s bytes under every
   *  integer and pointer declaration, and no C under a float one. KNOWN GAP: under an array or a
   *  function declaration `g` decays to its address, which this spells with no diagnostic; only a
   *  pun reads the word there, and intoDeclaredTemp's KNOWN GAP says why none is spelled. */
  const globalWord = (x: Expr): Expr => ({
    k: 'cast',
    to: T.u(32),
    e:
      x.k === 'var' && declaredShape(x.name) === undefined && !pointerLoadedGlobals.has(x.name)
        ? { k: 'cast', to: T.ptr(T.u(8)), e: x }
        : x,
  });

  /** An integer operand with every undeclared global it adds or subtracts made a word as well:
   *  bare, `a0 + g` is pointer arithmetic under a pointer declaration of g. Other operators reject
   *  a pointer operand, and a load or a cast types its own value. */
  const intWords = (x: Expr): Expr =>
    isUndeclaredGlobalValue(x)
      ? globalWord(x)
      : x.k === 'bin' && (x.op === '+' || x.op === '-')
        ? { ...x, l: intWords(x.l), r: intWords(x.r) }
        : x;

  /** A byte sum the pointer-value arithmetic rule below made of a global's value (`(u8 *)g + K`),
   *  and the same sum as the integer it also is (`(u32)g + K`), which an integer added in front of
   *  it takes. KNOWN GAP: an integer READER of the byte sum converts a pointer to an integer. The
   *  backend casts it where the reader's type is known (an assignment, a store through a typed
   *  slot, a return: cfamily `legalizePointerWrites`), and a compare against an integer compares
   *  it as a `u32`. A call argument and a global no declaration types keep the pointer, which agbcc
   *  and KMC gcc warn about and CodeWarrior rejects; only a pointer cell's sum passed to a parameter
   *  the prototype declares an integer is converted (l3/ptrcell.ts). The integer sum is no fix: gcc
   *  orders a pointer sum's operands and an integer sum's differently, so the bytes differ. */
  const castGlobal = (x: Expr, undeclared = false): x is Extract<Expr, { k: 'cast' }> =>
    x.k === 'cast' &&
    typeEquals(x.to, T.ptr(T.u(8))) &&
    x.e.k === 'var' &&
    (isPtrValue(x.e) || isUndeclaredGlobalValue(x.e)) &&
    (!undeclared || mapUndeclared(x.e.name));
  /** The integer sum the rule spells in the asm's order instead (`(u32)g + x`), cast back to the
   *  byte pointer it stands for: `(u8 *)((u32)g + x)`. A byte sum converted whole (byteSumAsInt's
   *  `(u32)((u8 *)g + x - gB)`) is one of its words. */
  const intGlobalWord = (x: Expr, undeclared: boolean): boolean =>
    x.k === 'cast' &&
    typeEquals(x.to, T.u(32)) &&
    (castGlobal(x.e, undeclared) ||
      (x.e.k === 'bin' && isByteGlobalSum(x.e, undeclared)) ||
      (x.e.k === 'var' &&
        (isPtrValue(x.e) || isUndeclaredGlobalValue(x.e)) &&
        (!undeclared || mapUndeclared(x.e.name))));
  const isIntGlobalSum = (x: Expr, undeclared: boolean): boolean =>
    x.k === 'bin' &&
    (x.op === '+' || x.op === '-') &&
    (intGlobalWord(x.l, undeclared) ||
      intGlobalWord(x.r, undeclared) ||
      isIntGlobalSum(x.l, undeclared) ||
      isIntGlobalSum(x.r, undeclared));
  const restoredIntSum = (x: Expr, undeclared: boolean): Expr | undefined =>
    x.k === 'cast' && typeEquals(x.to, T.ptr(T.u(8))) && isIntGlobalSum(x.e, undeclared) ? x.e : undefined;
  const isByteGlobalSum = (x: Expr, undeclared = false): boolean =>
    restoredIntSum(x, undeclared) !== undefined ||
    (x.k === 'bin' &&
      (x.op === '+' || x.op === '-') &&
      (castGlobal(x.l, undeclared) ||
        castGlobal(x.r, undeclared) ||
        isByteGlobalSum(x.l, undeclared) ||
        isByteGlobalSum(x.r, undeclared)));
  /** The integer a byte sum is. Every global it adds bare goes a word with it. A lone global it
   *  subtracts stays the pointer difference, `(u32)((u8 *)g + x - gB)`: the asm's integer under an
   *  integer or a byte-pointer declaration of `gB`, and no C under a wider pointer or array, a
   *  function or a float one, where the word `(u32)(u8 *)gB` would subtract an address. Under a byte
   *  array it subtracts the array's address: globalWord's KNOWN GAP. A difference has one operand
   *  order, so the asm's needs no integer sum. A sum of globals it subtracts goes words: bare,
   *  `gB2 - gB3` is an element count under a wider pointer declaration. */
  const byteSumAsInt = (x: Expr): Expr =>
    restoredIntSum(x, false) ??
    (castGlobal(x)
      ? globalWord(x.e)
      : x.k === 'bin' && isByteGlobalSum(x)
        ? x.op === '-' && isUndeclaredGlobalValue(x.r)
          ? { k: 'cast', to: T.u(32), e: x }
          : { ...x, l: byteSumAsInt(x.l), r: byteSumAsInt(x.r) }
        : intWords(x));

  /** Operands `-`/`~` cannot take as spelled: a rendered pointer, a bare `&gSym`, a pointer
   *  global's value. All three are ill-formed C under a unary arithmetic operator — the asm did
   *  32-bit integer math on the address, so that is what gets spelled. */
  const needsIntSpelling = (x: Expr): boolean => ctype(x)?.kind === 'ptr' || x.k === 'addr' || isPtrValue(x);

  /** A value assigned into a TEMP THIS PASS DECLARES, spelled so the assignment is legal against
   *  that declaration. Two inhabitants, one argument: the value's type comes from somewhere this
   *  pass does not control, and the temp's comes from here.
   *
   *  `&gSym` assigned to a `T *` local: the address of an AGGREGATE is not a pointer to its
   *  element. `&gArr` is `T (*)[n]`, `&gStruct` is `struct S *`, and neither is assignable to
   *  `T *` — yet the IR's `gaddr` value legitimately has type `T *`, because that is what the asm
   *  loaded. The bare spelling therefore states a type the project's own header contradicts.
   *
   *  It survived because agbcc only WARNS ("assignment from incompatible pointer type") and
   *  computes the right address anyway. That leniency is not something to rely on: the Klonoa
   *  project's own build template treats these as fatal, so the row's emitted C does not build
   *  where its author would put it. The cast is the always-valid spelling — the same fallback
   *  `bareArrayLead` documents for the indexed form — and it is byte-identical, so no benchmark row
   *  moves either way and the rule that decides it is pinned in test/deref-typing.test.ts instead.
   *
   *  The test is whether `&gSym`'s rendered type PROVABLY equals the destination's, not whether the
   *  symbol looks like an aggregate. A SHAPE ENUMERATION MISSES THREE WAYS, each real:
   *  `shape:'pointer'` declares a pointer cell (`void *gSym`, or `struct Tag *gSym` when the pointee
   *  has a declarable layout), so `&gSym` is a pointer-to-pointer either way; a `shape:'scalar'`
   *  whose width differs from the destination's pointee gives `s32 *` for a `u16 *` slot; and a
   *  NAME-ONLY symbol is synthesized as `extern u32 gSym;` (declare.ts), which is `u32 *`. So the
   *  default is to CAST, and the cast is omitted only
   *  where the declared cell type is known and matches exactly. Byte-identical either way, so the
   *  cost of casting one time too many is a redundant `(T *)`, never a wrong address. */
  const intoDeclaredTemp = (name: string, value: Expr): Expr => {
    const t = varType.get(name);
    if (t === undefined) {
      return value;
    }
    // ── pointer values whose type this side of the program does not own ────────────────────────
    // A `gaddr` at least states a type the IR knows. `gSym.pBuf` and a pointer global's own value
    // (isPtrValue) state one only the project's header knows, and `ctype` — which types params and
    // locals — reads them as `undefined`, so the test above cannot see them at all. Assigning one
    // bare declares that the temp's type and the project's declaration of that pointer are the
    // same type, which nothing here established: the project's header says
    // `struct Unk_03005284 *` where the recovered temp says `struct Struct0 *`, and `-Werror` makes
    // the mismatch fatal in the tree the source is pasted into. The destination's type is the one
    // this pass DID choose, so unlike the map-declared cells below it can be named exactly rather
    // than defused through `void *`. That holds for an INTEGER temp too, and there the diagnostic
    // is the mirror one, `assignment makes integer from pointer without a cast` — same site, same
    // argument, same `(T)` answer.
    //
    // A value that RENDERS a pointer of another type is the same assignment with its type in plain
    // sight: the byte arithmetic below spells `(u8 *)gPtr + 3544` and `(u8 *)a0 + 2` for the
    // address alone, and a `u16 *` or `s32 *` temp takes neither without the cast.
    //
    // KNOWN GAP: a global no declaration types, read at offset 0 only, may be declared an ARRAY
    // (`u16 *gArr[4]`, the asm reading `gArr[0]`). Its value spelling is then the array's address,
    // and this cast compiles that wrong value with no diagnostic, where the bare value keeps
    // agbcc's `incompatible pointer type`, fatal under -Werror. The cast is load-bearing all the
    // same: a substitution variation (`/unmerge`) carries the temp's value into the arithmetic it
    // feeds, and bare, that arithmetic scales by the declared pointee. A pun, `*(T *)&gArr`, is no
    // fix: where the declaration is not exactly T it loses gcc's fold of the read (agbcc
    // c-typeck.c), it drops a `volatile` declaration's qualifier, and agbcc's strict aliasing at
    // -O2 moves it past a store through the declared type.
    const vt = ctype(value);
    if (isPtrValue(value) || (vt?.kind === 'ptr' && !typeEquals(vt, t))) {
      return { k: 'cast', to: t, e: value };
    }
    if (t.kind !== 'ptr' || value.k !== 'addr') {
      return value;
    }
    // The only provably-redundant case: a NON-VOLATILE scalar cell whose DECLARED type is the
    // destination's pointee, where `&gSym` already denotes exactly `T *`.
    //
    // `scalarCellType` and not `scalarTypeForAccess`: the latter answers what an ACCESS of that
    // width reads and collapses every 4-byte access to `s32`, so it called a `u32` cell equal to an
    // `s32 *` destination and let the incompatible assignment through. And a `volatile` cell makes
    // `&gSym` a `volatile T *`, so omitting the cast would DISCARD the qualifier — the same class of
    // fatal-under-a-strict-build defect this rule exists to remove.
    const si = sym?.info(value.name);
    if (si?.shape === 'scalar' && !si.volatile && isScalarCellSize(si.size)) {
      if (typeEquals(scalarCellType(si.size, si.signed), t.to)) {
        return value;
      }
    }
    return { k: 'cast', to: t, e: value };
  };

  /** A pointer VALUE assigned into a pointer CELL (isPtrValue), spelled so the assignment is legal
   *  against ANY pointer declaration of that cell. The byte-arithmetic guard renders such a
   *  right-hand side `(u8 *)gS.pBuf + K` — the right ADDRESS in every world, which is the whole
   *  point of it, and a `u8 *` where the declaration says `u16 *`. READING one is fine (C converts
   *  an object pointer freely under a deref, a call argument or a compare); ASSIGNING one is
   *  `warning: assignment from incompatible pointer type`, and this project's own `-Werror`
   *  compiler template makes that FATAL — so a source that scores clean here fails to build in the
   *  tree a user pastes it into, which no score gate can observe.
   *
   *  `void *`, NOT the map's declared pointee: it is the one target assignment-compatible with any
   *  object-pointer declaration, the same "same answer in every world" property the guard that
   *  made the `u8 *` exists for. Trusting the map's pointee would put the spelling back in one
   *  world. It costs nothing: agbcc compiles `p = (void *)((u8 *)p + 4)` and the warning-carrying
   *  `p = (u8 *)p + 4` to BYTE-IDENTICAL objects (`-mthumb-interwork -Wimplicit -O2 -fhex-asm
   *  -fprologue-bugfix`), so the fix is invisible to the differ and visible to the compiler.
   *
   *  A project may still declare a cell no map types an INTEGER (`u32 gSym;`), where `(void *)`
   *  makes an integer from a pointer: agbcc warns, CodeWarrior rejects it. The candidate's own world
   *  declares the cell `void *` (l3/symbol-refs.ts), and `/int-cell` (l3/intcell.ts) spells the
   *  integer declaration's source, published only at a byte-exact score. */
  const intoPtrCell = (lval: Expr, value: Expr): Expr => {
    if (!isPtrValue(lval)) {
      return value;
    }
    const vt = ctype(value);
    // BOTH ways a pointer value reaches here. `ctype` types params and locals, so it sees the
    // guard's own `(u8 *)…` and nothing else: a bare `gSym.pBuf` or a pointer global's value —
    // the population this rule exists for — reads `undefined` there. An already-`void *` value is
    // assignable as it stands.
    const isPtr = isPtrValue(value) || (vt?.kind === 'ptr' && vt.to.kind !== 'void');
    return isPtr ? { k: 'cast', to: T.ptr(T.void()), e: value } : value;
  };

  /** A global's value the arithmetic rule below spells as a base in the sum `sum` computes,
   *  though `ctype` types no global: a value no map declaration types that the IR loads as a
   *  pointer, or as a word into a sum the IR types a pointer. That rule keeps the add's operand
   *  order, so an operand-order rule asks this before it swaps. */
  const ptrGlobalSide = (x: Expr, sum: Op): boolean =>
    x.k === 'var' &&
    mapUndeclared(x.name) &&
    (pointerLoadedGlobals.has(x.name) || (sum.results[0]?.type.kind === 'ptr' && wordLoadedGlobals.has(x.name)));

  /** The operands of `d`, an integer arithmetic op rendered as `op`, spelled for the address the
   *  asm computed, and the pointer type their sum is cast back to. */
  const arith = (d: Op, op: BinOp, l0: Expr, r0: Expr): ArithSpelling => {
    let l = l0;
    let r = r0;
    // Pointer stride: C pointer arithmetic is ELEMENT-scaled, but the asm added a BYTE
    // constant — `addi p,4` on an `s32*` walks 1 element, yet C `p + 4` walks 4. Divide the byte
    // constant by the pointee size so the walk recompiles to the same address math.
    //
    // Keyed on the operand's RENDERED C type, never the IR value's recovered type: C scales by
    // the type of the expression it actually sees, and the two diverge exactly like memAccess's
    // deref bases (a value recovered `s32*` can render as an int-typed tree — C then does NO
    // element scaling, so pre-dividing the constant would bake in a WRONG address that the
    // deref cast downstream turns into silently-wrong bytes).
    // An int-rendered walk keeps its raw byte constant and derefs through the access-width cast.
    // Fires only for a rendered pointer whose element size (>1) DIVIDES the constant exactly;
    // otherwise raw (a misaligned/struct-array stride is left as-is; a `u8*` is size 1 so
    // unchanged). Since C `(K/es) + p == p + (K/es)`, scaling the const on whichever side it
    // sits fixes the bytes: `add` is commutative so the pointer may be either operand; `sub` is
    // not, so only operand[0] (the minuend) may be the pointer.
    // A rendered pointer that CANNOT express the byte constant as a whole number of elements —
    // an inexact residual, or a pointee whose size is not knowable here (a struct) — has no
    // scaled spelling at all, and leaving the raw byte count is the silent wrongness the
    // pointer-global rule below refuses in the same words: C multiplies it back, so `p + 62` on
    // an `s32 *` addresses byte 248 and `p + 38` on a `struct S *` addresses byte 38 * sizeof(S).
    // Same answer as there — CAST THEN ADD, `(u8 *)p + 62`, the same address in every world.
    const bytePtr = (x: Expr): Expr => ({ k: 'cast', to: T.ptr(T.u(8)), e: x });
    // Set when a byte-pointer cast was applied for the ADDRESS math alone: the sum is cast back
    // to the pointer type it started as, so the walk changes the arithmetic and nothing else. A
    // bare `u8 *` sum would be a different C type from the slot it lands in (`v4 = (u8 *)a0 +
    // (v1 << 2)` into an `s32 *` — an mwcc error) and from the bases the deref rules read.
    let restoreTo: IrType | undefined;
    const walk = (base: Expr, c: Extract<Expr, { k: 'const' }>): { base: Expr; off: Expr } => {
      const t = ctype(base);
      if (t?.kind !== 'ptr') {
        return { base, off: c }; // an int-rendered walk: C scales nothing, the bytes are right
      }
      const es = ptrElemBytes(t.to);
      if (es === 1) {
        return { base, off: c }; // already a byte pointer
      }
      return es > 1 && c.value % es === 0
        ? { base, off: { k: 'const', value: c.value / es } }
        : { base: bytePtr(base), off: c };
    };
    // A RUNTIME byte offset has no element spelling at all — not even an inexact one to reject,
    // since the residual is unknown until the program runs. The asm added bytes, so the same
    // answer as the inexact constant above: cast then add. Without it a `u16 *` walked by a
    // computed offset addresses TWICE the intended byte, and nothing downstream can see the
    // error — in the sa3 decomp that address is what a `CpuSet` call writes THROUGH.
    //
    // `ptr - ptr` is C's ELEMENT difference, where the asm subtracted bytes: agbcc compiles `(q -
    // p) + m` on an `int *` to `sub; asr #2; add`, and spelled `(v0 - a0) >> 2` the lift divided
    // by 4 twice. Both sides go byte pointers, `(u8 *)v0 - (u8 *)a0`, the byte count in every
    // world — unless both already are.
    //
    // The inexact-CONSTANT branch above casts its base and does not cast the sum back: a deref
    // supplies its own cast, and a temp of another pointer type takes the sum through
    // intoDeclaredTemp's cast.
    const walkVar = (x: Expr): IrType | undefined => {
      const t = ctype(x);
      return t?.kind === 'ptr' && ptrElemBytes(t.to) !== 1 ? t : undefined;
    };
    if ((d.opcode === 'add' || d.opcode === 'sub') && r.k === 'const') {
      ({ base: l, off: r } = walk(l, r));
    } else if (d.opcode === 'add' && d.operands.length === 2 && l.k === 'const') {
      ({ base: r, off: l } = walk(r, l)); // commuted `const + ptr`
    } else if (d.opcode === 'add' || d.opcode === 'sub') {
      // ONE side only. `ptr - ptr` is C's element difference and `ptr + ptr` is not C at all;
      // both are the intify rules' business below, and casting both operands here would hide
      // the shape from them.
      const lp = ctype(l)?.kind === 'ptr';
      const rp = d.operands.length === 2 && ctype(r)?.kind === 'ptr';
      if (lp && rp && d.opcode === 'sub') {
        if (walkVar(l) || walkVar(r)) {
          l = bytePtr(l);
          r = bytePtr(r);
        }
      } else if (lp && !rp) {
        restoreTo = walkVar(l);
        l = restoreTo ? bytePtr(l) : l;
      } else if (rp && !lp && d.opcode === 'add') {
        restoreTo = walkVar(r);
        r = restoreTo ? bytePtr(r) : r;
      }
    }
    // C rejects a pointer operand outright under the non-additive operators (& | ^ << >> * / %),
    // under `ptr + ptr`, and as the subtrahend of `int - ptr` — the asm just does 32-bit integer
    // math on the address, so the honest spelling is the value cast to its integer self. Only a
    // DEFINITELY-pointer rendering is cast (same conservative direction as memAccess); the
    // additive ops keep C's legal pointer arithmetic untouched.
    const intify = (x: Expr): Expr =>
      restoredIntSum(x, false) ?? (ctype(x)?.kind === 'ptr' ? { k: 'cast', to: T.s(32), e: x } : x);
    if (!['+', '-', '&&', '||'].includes(op)) {
      l = intify(l);
      r = intify(r);
    } else if (op === '+' && ctype(l)?.kind === 'ptr' && ctype(r)?.kind === 'ptr') {
      // ptr + ptr is not C; ptr + (s32)ptr is, and C scales it by the left pointee. So the left
      // side is the base, and the sum goes back to its type as the walk's does.
      r = intify(r);
      if (!restoreTo) {
        restoreTo = walkVar(l);
        l = restoreTo ? bytePtr(l) : l;
      }
    } else if (op === '-' && ctype(l)?.kind !== 'ptr' && ctype(r)?.kind === 'ptr') {
      // int - ptr is not C. A byte sum this rule made integer leaves a global it is taken from a
      // pointer under a pointer declaration, which the integer would scale; a word, it is the
      // asm's under any integer or pointer one.
      if (restoredIntSum(r, false) !== undefined) {
        l = intWords(l);
      }
      r = intify(r);
    }
    // A bare global address `&gSym` under ANY of these operators is never emitted as-is: its C
    // type comes from the PROJECT's own declaration (unknowable here — exprCType types `addr`
    // undefined, so the ptr-keyed intify above never fires on it), which makes `&gSym + K`
    // byte-INEXACT (C scales K by sizeof(gSym)) and `&gSym & K` ill-formed. The honest spelling
    // is integer math on the address — `(u32)&gSym + K`, exactly the arithmetic the asm did.
    // The deref folds (globalOf / globalConstByte, via addrIn) look through this cast, so every
    // access that CAN spell a named element/field still does; only a genuine value-context
    // escape (a call argument, a stored address, a compare) keeps it — previously such an
    // escape tripped assertDerefsTyped's interior-pointer rule and declined the whole function.
    const intifyAddr = (x: Expr): Expr => (x.k === 'addr' ? { k: 'cast', to: T.u(32), e: x } : x);
    l = intifyAddr(l);
    r = intifyAddr(r);
    // The SAME hazard one level down, for a pointer VALUE (`gPtr`, `gSym.pBuf` — isPtrValue):
    // C scales `gPtr + K` by sizeof(*gPtr) — 1 under the map's synthesized `void *`, but
    // whatever the PROJECT's header declares (a `u16 *` member, a 0x5C-byte struct) in the
    // world a user actually recompiles in. The asm added BYTES, so the honest
    // spelling makes the stride explicit: CAST-THEN-ADD, `(u8 *)gPtr + K`, the same address in
    // EVERY world. Add-then-cast (`(u8 *)(gPtr + K)`, what the backend's deref legalization
    // would otherwise produce) is byte-correct in exactly one of them — a silent wrongness, the
    // class this project refuses. A MEMBER is the case with no world in which the raw spelling
    // is right: the map declares the pointee width, so `bytes + gSym.pBuf` on a `u16 *` scales
    // the residual a SECOND time and addresses twice the byte the asm did.
    // NOT foldable into the deref index either: `((u8 *)gPtr)[K + off]` re-scales K by the
    // ACCESS width, a different address whenever that width is not 1.
    // Under the non-additive operators C rejects a pointer outright, so there the honest
    // spelling is integer math on the cell — exactly intifyAddr's `(u32)&gSym` rule.
    const intifyPtrValue = globalWord;
    if (op === '+' || op === '-') {
      // `ptr ± int` and `ptr - ptr` are byte arithmetic once both sides are byte pointers;
      // `ptr + ptr` and `int - ptr` are not C at all, so the second pointer goes integer. The
      // other side is a pointer when it is a pointer value too or when it already renders one
      // (a pointer temp, the walk's `(u8 *)v1`), and then the global's value is the side that
      // goes integer.
      //
      // A global's value no declaration types, added to an integer, is a pointer value too
      // when the IR types the SUM a pointer: `(u8 *)g + x` is the asm's address under every
      // declaration of `g` once `x` renders an integer, whichever operand the source held as
      // the pointer. An integer side that IS an address (`(u32)&gArr + gIdx`) says the address
      // is the base and the global its index, so that sum stays as it is. An address under a
      // load (`((u16 *)&gTbl)[a0]`) is a loaded value, and that side is an integer. A global
      // that is no pointer value renders an integer too, though `ctype` types no global.
      const isAddr = (x: Expr): boolean =>
        x.k === 'addr' ||
        (x.k === 'cast' && isAddr(x.e)) ||
        (x.k === 'bin' && (x.op === '+' || x.op === '-') && (isAddr(x.l) || isAddr(x.r)));
      const intSide = (x: Expr): boolean =>
        !isAddr(x) && (ctype(x)?.kind === 'int' || (x.k === 'var' && ctype(x) === undefined && !isPtrValue(x)));
      const sumBase =
        d.results[0]?.type.kind === 'ptr' && !isPtrValue(l) && !isPtrValue(r)
          ? isUndeclaredGlobalValue(l) && intSide(r)
            ? l
            : op === '+' && isUndeclaredGlobalValue(r) && intSide(l)
              ? r
              : undefined
          : undefined;
      const ptrValue = (x: Expr): boolean => isPtrValue(x) || x === sumBase;
      // A global no declaration types in the base's partner is added as an integer, which it is
      // under an integer declaration and a pointer one alike.
      if (sumBase !== undefined) {
        l = l !== sumBase ? intWords(l) : l;
        r = r !== sumBase ? intWords(r) : r;
      }
      const rendersPtr = (x: Expr): boolean => ptrValue(x) || ctype(x)?.kind === 'ptr';
      const bothPtr = rendersPtr(l) && rendersPtr(r);
      // `x + (u8 *)g` is pointer arithmetic, and gcc makes the pointer the first operand of the
      // add, which swaps the asm's. So under an integer left side, the value of a global no
      // declaration types, or a byte sum this rule made of one, is added as an integer in the
      // asm's order, and the cast keeps the sum the byte pointer it would have been. A declared
      // pointer keeps `x + (u8 *)p`, the operand the element and field spellings read.
      const undeclaredPtr = (x: Expr): boolean => x.k === 'var' && mapUndeclared(x.name);
      // The same global LEFT of a runtime offset is added as an integer too: CodeWarrior at -O4
      // puts the index first in every pointer sum, where an integer sum keeps the source's
      // order, so `(u8 *)g + x` is the asm's order on agbcc, KMC gcc and IDO only. The partner
      // goes integer with it, or a pointer partner would scale the sum. A constant offset folds
      // into the access and keeps `(u8 *)g + K`.
      const constValued = (x: Expr): boolean =>
        x.k === 'const' ||
        (x.k === 'cast' && constValued(x.e)) ||
        (x.k === 'bin' && constValued(x.l) && constValued(x.r));
      const intSum = op === '+' && !constValued(r) && ptrValue(l) && undeclaredPtr(l);
      if (intSum) {
        l = intifyPtrValue(l);
        r = ptrValue(r)
          ? intifyPtrValue(r)
          : ctype(r)?.kind === 'ptr'
            ? isByteGlobalSum(r)
              ? byteSumAsInt(r)
              : { k: 'cast', to: T.u(32), e: r }
            : intWords(r);
        restoreTo ??= T.ptr(T.u(8));
      } else if (ptrValue(l)) {
        l = op === '+' && bothPtr && !ptrValue(r) ? intifyPtrValue(l) : bytePtr(l);
      }
      if (intSum) {
        // both operands are integers now
      } else if (
        op === '+' &&
        !bothPtr &&
        !restoreTo &&
        ((ptrValue(r) && undeclaredPtr(r)) || (ctype(r)?.kind === 'ptr' && isByteGlobalSum(r, true)))
      ) {
        r = ptrValue(r) ? intifyPtrValue(r) : byteSumAsInt(r);
        // A left global no declaration types may be a pointer in the project's header, which
        // would scale the integer sum; as an integer it is the asm's word under any declaration.
        l = intWords(l);
        restoreTo = T.ptr(T.u(8));
      } else if (ptrValue(r)) {
        r = bothPtr && op === '-' ? bytePtr(r) : op === '+' && !bothPtr ? bytePtr(r) : intifyPtrValue(r);
      }
      // A byte sum less an integer sum of globals no declaration types: bare, `gB2 - gB3` is an
      // element count under a wider pointer declaration of them, where the asm subtracted bytes.
      if (op === '-' && r.k === 'bin' && !rendersPtr(r) && isByteGlobalSum(l)) {
        r = intWords(r);
      }
      if (op === '-' && ctype(l)?.kind === 'ptr' && ctype(r)?.kind === 'ptr') {
        restoreTo = undefined; // a byte pointer less a byte pointer is the byte count, an integer
      }
    } else if (op !== '&&' && op !== '||') {
      // (`&&`/`||` take a pointer operand legally — a truth test, no arithmetic.)
      l = isPtrValue(l) ? intifyPtrValue(l) : l;
      r = isPtrValue(r) ? intifyPtrValue(r) : r;
    }
    // SCOPE: this and intifyAddr cover the ARITHMETIC escapes. A pointer value under a
    // COMPARISON (`gPtr < K`, `(u8 *)gPtr + K < a0`) needs nothing here: an icmp_s* pins every
    // operand that does not provably render signed, a pointer included (structure.ts pinSigned).
    return { l, r, restoreTo };
  };

  return { needsIntSpelling, intoDeclaredTemp, intoPtrCell, ptrGlobalSide, arith };
}
