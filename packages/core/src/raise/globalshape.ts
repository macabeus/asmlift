// asmlift — ARRAY SHAPE FOR A GLOBAL NO SYMBOL MAP DESCRIBES, derived from the assembly's own
// stride evidence.
//
// WHAT IS MISSING WITHOUT THIS. asmlift can already spell a named global's element access two
// ways: `((u16 *)&gTbl)[i]` (always available, valid under any declaration) and the bare
// `gTbl[i]` (only when a SYMBOL MAP declares `gTbl` an array — structure/globalaccess.ts
// `bareArrayElement`). Map-less, only the first exists. On agbcc the two are DIFFERENT OBJECTS,
// and the difference is visible in the input assembly:
//
//     gTbl[i]            ldr r1, .L3 ; lsl r0, r0, #1 ; add r0, r0, r1 ; ldrh   <- BASE first
//     ((u16 *)gTbl)[i]   lsl r0, r0, #1 ; ldr r1, .L3 ; add r0, r0, r1 ; ldrh   <- INDEX first
//
// The mechanism is agbcc's own `build_array_ref` (gcc/c-typeck.c), which forks on
// `TREE_CODE (TREE_TYPE (array)) == ARRAY_TYPE && TREE_CODE (array) != INDIRECT_REF`: an
// array-typed OBJECT expands its base ahead of the subscript, every other base takes the pointer
// path and is expanded last. So the instruction order is EVIDENCE about how the source spelled
// the base, and this module reads it.
//
// THE LICENCE IS THE ASSEMBLY, NEVER A PREFERENCE. Deriving a shape here changes the DEFAULT
// spelling of every access to that symbol (it does not add a candidate), so a shape is minted
// only where the asm says the source subscripted a declared array, and the fallback everywhere
// else is the cast form — byte-identical under any declaration. Two independent kinds of
// evidence license it, and they answer at different element widths:
//
//   ORDER — the pool load precedes every scaling of the index, in EVERY access of the name. agbcc
//     CSEs the pool word, so a function that subscripts one global twice has ONE `ldr` and both
//     accesses are ordered against it; the earliest scaling is what decides, which is why one
//     index-first access refuses the whole symbol (`index-materialized-first`). Compiled, that is
//     the right reading: `gTbl[i] + ((u16 *)gTbl)[j]` is the SAME object as `gTbl[i] + gTbl[j]`,
//     while `((u16 *)gTbl)[i] + ((u16 *)gTbl)[j]` is a different one — so a mixed function is
//     decided by its first access and nothing after it is observable
//     (cli/test/matching/array-shape-licence.test.ts compiles all three).
//
//     Observable only at element width > 1: at width 1 there is nothing to scale, so the base
//     `ldr` comes first whatever the source wrote — measured, `extern u8 g[]; g[i]` and
//     `((u8 *)g)[i]` are byte-identical — and the order says nothing.
//   A CONSTANT ON THE INDEX — the address adds a constant to the INDEX at run time while the
//     pool word's relocation addend stays zero. agbcc folds a constant added to any pointer or
//     cast base into that addend (`gcc/explow.c plus_constant_wide`, and gcc/thumb.h's
//     `LEGITIMIZE_ADDRESS` is empty, so nothing splits it back), so a runtime `add` against a bare
//     `.word gSym` is a shape only the array subscript produces. Available at every width.
//
// THE ORDER LICENCE HAS TWO CONSUMERS, and they are asking different questions of the same fact.
// `inferGlobalArrays` asks "how is this name DECLARED", which needs the order licence AND a
// whole-element subscript to spell. `orderLicensedGlobals` (bottom of this file) asks only "was the
// base materialized before the index was scaled", which is what decides whether the address has a
// HOME — a pointer local `T *p = (T *)&gSym; p[i]` — or is re-derived inline at each access.
//
// THE TWO CONSUMERS DO NOT SHARE A MECHANISM, and the first cut of this paragraph said they did
// ("the SAME `build_array_ref` fork: an array-typed object and a pointer local both expand their
// base ahead of the subscript"). That is FALSE for the pointer local, and one more compile settles
// it. Through the benchmark's own agbcc command, at element width 2:
//
//     A  extern u16 gTbl[];  return gTbl[i];               ldr / lsl / add   base first
//     B  u16 *p = (u16 *)&gTbl; return p[i];               ldr / lsl / add   base first
//     C  return ((u16 *)&gTbl)[i];                         lsl / ldr / add   INDEX first
//     F  u16 *p; return (p = (u16 *)&gTbl)[i];             lsl / ldr / add   INDEX first
//
// F is the discriminator. `build_array_ref` takes the same pointer branch for `p` in B and in F —
// the two differ only in whether the assignment is a SEPARATE STATEMENT — and only B is base-first.
// So the fork explains A against C, and STATEMENT ORDERING explains B: the initializer is a
// statement of its own, evaluated before the subscript, and on a compiler with no instruction
// scheduler that ordering survives into the object. Both roads lead to the same observable, which
// is why one licence serves both consumers, and the observable is what the licence reads. Two
// consequences follow and are stated rather than hidden: the opt-in datum this module reads
// (`compilerBehaviors.arrayShapeFromStride`, whose own doc in target.ts describes the FORK and is
// correct about it) is narrower than the second consumer's mechanism, so the home axis is denied to
// compilers that have the statement ordering without the fork — under-reach, unmeasured, and a
// datum of its own is what would fix it; and `index-materialized-first` is SOUND for the
// declaration (index-first ⇒ not a declared array, which F does not touch) and only a heuristic for
// the home (F is a home that compiles index-first), which is why `ORDER_SHAPE_GATES` below owns its
// rules instead of selecting that one.
//
// So the order half licenses the HOME on its own, for every name the declaration half refuses for a
// reason that is NOT about the order. Censused over the artifact's 370 agbcc rows in BOTH symbol-map
// arms — the arms differ, so both numbers are quoted rather than one labelled as if it were both:
//
//     map-less   8 rows, 10 keys — 9 a STRUCT ELEMENT's cast base, 1 a plain scalar leaf
//     map-ful   10 rows, 12 keys — 10 cast bases, 2 plain scalar leaves
//
// `interior-or-non-access` refuses both shapes. The STRUCT ELEMENT has no `intType` and reads its
// members at a displacement. The plain scalar leaf is an element of a symbol the function ALSO
// reads at a displacement somewhere else — `kleod:UpdateCameraScroll`'s `gSineTable` in both arms,
// and `pokeemerald:Sin2`'s `gSineDegreeTable` only in the map-ful one. Neither says any less about
// the order than a clean access does. `ADDRESS_GATES` below is therefore two halves: the ELEMENT
// rules, which both consumers ask, and the DECLARATION rule, which only the first does.
//
// WHAT REFUSES — and the list is DOWN THERE, not here. The refusals are two `Gate<Ctx>` tables
// (`ADDRESS_GATES` and `SHAPE_GATES`, below), each rule carrying its own `why` and the test that
// fails without it, because an enumeration in a header is prose that nothing re-checks and a
// refusal's attribution has to be asked of `arrayShapeRefusals`. Every rejection falls back to
// today's cast spelling rather than guessing.
//
// One thing about them belongs here rather than on a table entry, because it is about the pair.
// THE ELEMENT HALF AND THE RANK HALF ARE ONE DERIVATION, not two commits: a multi-stride address
// spelled through a rank-1 declaration is a FLAT subscript, and compiled against `tblrank2`'s
// target the flat spelling scores 4 (the other operand order 6) where the declared rank scores 0
// and the cast form it would replace scores 3. So a shape is minted with every dimension it needs
// or not at all. On that row a SECOND, independent gate also refuses the flat form —
// `elementIndex` (structure/globalaccess.ts) divides a residual into elements only when it is
// already one scaled term, never a sum — so `strides-do-not-nest` is the rule stated where the
// shape is decided, not the only thing standing between that row and the worse spelling.
//
// WHAT THE DERIVATION GIVES UP, stated because it is the fallback's whole value. `((T *)&gSym)[i]`
// reproduces the target's bytes under ANY declaration of `gSym`; the bare `gSym[i]` means what the
// declaration says it means. asmlift's answer is therefore the source PLUS the declaration it
// derived, and the two are only right together — which is why the shape travels out of every entry
// path (`DecompileResult.assumedSymbols`, `TraceReport.assumedSymbols`, the cli's `[assumed]` and
// `[declared]` blocks) rather than being applied and forgotten.
//
// The element WIDTH is forced by the evidence: a wrong width would have strided differently in the
// asm, and at width 1 `relocation-addend` covers the remaining case. The element SIGNEDNESS is NOT — it is a
// PICK, and the two readings are the same object. Compiled through the benchmark's own agbcc
// command (`-mthumb-interwork -Wimplicit -O2 -fhex-asm -fprologue-bugfix`):
//
//     u32 f(s32 i) { return (u16)gS[i]; }   over  extern const s16 gS[];   ldr / lsl / add / ldrh
//     u32 f(s32 i) { return gS[i]; }        over  extern const u16 gS[];   ldr / lsl / add / ldrh
//
// — byte-identical objects. So a project whose own header says `s16` compiles this module's bare
// spelling to `ldrsh` and gets different bytes, while the cast form it replaced would have been
// right beside either header. `pokeemerald:Sin2` and `sa3:sa2__sub_8083504` are two real benchmark
// rows in exactly that position. This is a fitted declaration in declare.ts's sense — a sound
// ARTIFACT (the decls and the source really do compile to those bytes) and an unsound CLAIM if the
// decls are hidden — so it is minted, and it is never hidden. What travels out is the narrower
// set `assumedShapes` (bottom of this file) computes rather than everything derived here: a shape
// the structurer did not spell bare, and a name the caller's own map described, are not
// obligations the reader has — see that function for the two corpus rows that prove each half.
//
// LEVEL. L1-derived, L2-shaped, L3-consumed: it runs on the LIFTED function, because the fact it
// needs — the order the compiler materialized the base in — is destroyed by the raising tower
// (array LEGALIZATION — `recognizeArrays`, raise/arrays.ts, run as pre-recovery.ts's `arrays`
// step, and NOT the patterns-as-data idiom fold, which cannot state the `1 << shiftImm ==
// accessWidth` relation the match needs — rewrites `gaddr; shl; add; load` into one `aload` and
// the two orders become the same IR; `harr` and `arrcast` lift to different IR and recover to
// byte-identical IR, which is why this cannot live any later). Its output is a name-keyed
// `SymbolInfo` map, the same shape a symbol map supplies, consumed by
// `StructureOptions.inferredSymbols` and by the declaration synthesis — and it NEVER claims a
// name a real map describes, which knows more.
// That precedence is enforced TWICE, and both are needed: `structure()` asks the map first, and
// rank.ts DELETES a map-known name from this map before structuring, because the `/raw-globals`
// arm structures with no map and declares with one (see the filter's own note there).
//
// PER-COMPILER. The fork above is agbcc's. Whether ido/kmc/mwcc distinguish the two spellings at
// all was not measured, so the gate is a `compilerBehaviors` opt-in rather than a universal:
// a compiler earns it by showing the same compiled divergence.
import { type Fn, type Op, type Value, defOpMap } from '../ir/core';
import type { SFn } from '../l3/ast';
import { type Gate, firstRejection } from '../l3/gates';
import type { SymbolInfo } from '../symbols';
import type { TargetDescription } from '../target';

/** One additive term of an address residual: `v` scaled by `scale`, or a pure constant.
 *  `scaleOp` is the op that DID the scaling (a `shl`/`mul`), which is what carries the position
 *  the order licence reads; a term at scale 1 has none. */
interface Term {
  scale: number;
  /** null ⇒ a constant term, whose value is `konst` */
  v: Value | null;
  konst: number;
  scaleOp: Op | null;
}

/** One access of a global's address: the byte residual's terms plus how the cell was read.
 *  `signed` is the extension the BARE spelling would have to carry — a load's own signedness, and
 *  `false` for a store, which is what structure.ts passes when it asks whether the bare form is
 *  spellable. Keeping the store's answer in the same set is what makes "every access of this
 *  symbol spells bare" a single `size === 1` test. */
interface Access {
  /** The width of the ELEMENT this access reads whole, or `null` for an INTERIOR access — one at a
   *  non-zero displacement, which the order consumer records (`interiorIsEvidence`) and the
   *  declaration consumer never sees. Nullable rather than "the load's width" because the two are
   *  not the same fact: a `ldrh [r1, #0x10]` two bytes into a 28-byte element evidences the order
   *  and nothing whatever about the element, and a rule that read `2` out of it would be reading a
   *  fabricated element width. Any rule that wants a width has to spell the null case, which is
   *  what keeps a future widening of `ORDER_SHAPE_GATES` a refusal instead of a wrong answer. */
  elementWidth: number | null;
  signed: boolean;
  isLoad: boolean;
  terms: Term[];
  gaddr: Op;
}

// ── the refusals, as DATA ────────────────────────────────────────────────────────────────────
//
// Two tables, because the decision has two stages with different subjects. `ADDRESS_GATES` runs
// per USE of the symbol's address and answers "is this an element address at all"; one rejection
// there refuses the WHOLE symbol, because what is being derived is a DECLARATION. `SHAPE_GATES`
// then runs once over everything the surviving accesses evidence and answers "does one array
// declaration describe them all". Both are `Gate<Ctx>` tables (l3/gates.ts) rather than an `||`
// chain for the reason that file exists: a refusal a pass's soundness rests on has to be
// ABLATABLE — `without(GATES, id)` re-runs the real predicate on real input — and attributable,
// so `firstRejection` names the one rule that decided rather than the set that co-occurred.
//
// THAT DISTINCTION IS NOT COSMETIC HERE, and the three readings of "what is this rule worth" pull
// apart. Instrumented over the 359 benchmark agbcc target functions that lift (7 of which derive a
// shape), per rule: how many symbols it would reject ON ITS OWN, how many it is the FIRST to
// reject, and how many functions' derived maps change when it alone is removed from the table —
//
//     address-escapes            141    137    0
//     interior-or-non-access      33     24    1
//     relocation-addend           27     17    0
//     stride-is-not-the-element    25      0    0
//     no-positive-evidence         23     10    8
//     no-subscript                 21      0    0
//     residual-not-a-sum            3      2    0
//     mixed-access-width            2      0    0
//     index-materialized-first      1      1    0
//     (the other five)              0      0    0
//
// — so twelve of the fourteen rules change nothing on this corpus when removed, and the rule the
// first column nominates loudest is one of them: `address-escapes` rejects 141 symbols, is FIRST
// for 137, and moves NOTHING. On this corpus the uses it rejects are the symbol's only ones, so
// with the rule gone they simply contribute no access and the name ends with nothing to shape —
// same outcome, and the rule's value there is the ATTRIBUTION. It is still `sound`, because a
// symbol that has a good access ALONGSIDE an escaping one does derive without it, which is a wrong
// answer and is the fixture the ablation test uses. Co-occurrence is not reach either:
// `no-subscript` would reject 21 symbols and is first for none of them. That does NOT make the twelve
// decoration — each is right about a shape, and the ablation test beside this module gives all
// thirteen rules that any input reaches a fixture that DOES reach them (`address-unused` is the
// fourteenth and has none), where NINE are the only thing standing between their fixture and a
// derivation. What it does mean is that "which refusal protects which row" is a question for
// `arrayShapeRefusals`, never for a comment.

/** One USE of a symbol's address, reduced to the facts `ADDRESS_GATES` decide over. */
interface AddressUse {
  /** the use is the `add` that forms an element address */
  readonly isAdd: boolean;
  /** the add's other operand is a constant — the relocation addend, which the frontend's pool
   *  grammar spells out as `add(gaddr, const)` */
  readonly addendIsConst: boolean;
  /** the residual's additive terms, or null when the tree is not a plain sum this walk can read */
  readonly terms: Term[] | null;
  /** every consumer of the computed address: whether each is a whole-element load/store at
   *  displacement 0 */
  readonly consumers: readonly { readonly isElementAccess: boolean }[];
}

/** Is this use of `&gSym` an ELEMENT ADDRESS at all — does the base own every byte the address
 *  adds, is the residual readable as a sum, and does anything read the result? The half that asks
 *  about the ADDRESS, which is the half BOTH consumers of this module need (see THE ORDER LICENCE
 *  HAS TWO CONSUMERS in the header). Order is the attribution: the first rejection is the rule that
 *  decided.
 *
 *  THESE RULE OBJECTS ARE SHARED BY BOTH CONSUMERS, unlike `ORDER_SHAPE_GATES`', and the reason
 *  they may be is that the question really is identical: "does the base own these bytes" has one
 *  answer whether the caller goes on to declare an array or to home a pointer. What does NOT carry
 *  across is a `sound: true` here — soundness is a claim about the DECLARATION, and for the licence
 *  an over-admission costs a candidate. `address-escapes` and `interior-or-non-access` are the two
 *  sound entries in this file's address half, and only the second is in the declaration half, so
 *  the one shared sound rule is `address-escapes`.
 *
 *  A SHARED RULE OBJECT IS NOT SHARED COVERAGE, and this table went one branch with none: every
 *  `guardedBy` below names a test in the DECLARATION's suite, and the sweep that prices those rules
 *  by ablation runs `inferGlobalArrays` — which measures what a rule is worth to the declaration
 *  and says nothing about the licence. Measured rather than
 *  argued, `address-escapes` is uniquely load-bearing for the licence too — on its own fixture
 *  `orderLicensedGlobals` returns nothing and returns `gTbl` with the rule removed — so the hole
 *  was real, and the `arrbias` case an earlier revision of this comment claimed as the order
 *  consumer's coverage is not coverage at all: it contains no ablation, and ablating EVERY rule in
 *  both halves still licenses nothing there, because the addend `add`'s only consumer is the index
 *  `add`, so that fixture records no access to license. The coverage is now the licence's own
 *  per-rule ablation sweep beside this module ('the order licence: which rule decides…'), which
 *  runs `orderLicensedGlobals` with one rule removed on a fixture that REACHES the licence — for
 *  the two address rules that means a clean base-first access beside the rejected use, the same
 *  "the fixture is part of the claim" the declaration sweep already states. All five rules any
 *  input reaches measure uniquely load-bearing there; `address-unused` is the sixth and has no
 *  reaching fixture in either consumer. */
export const ELEMENT_ADDRESS_GATES: readonly Gate<AddressUse>[] = [
  {
    id: 'address-escapes',
    why: 'the address is used as something other than the base of one element-address add',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: the address escaping to a callee refuses the whole symbol',
    rejects: (u) => !u.isAdd,
  },
  {
    // ATTRIBUTING, NOT UNIQUELY LOAD-BEARING: with this rule removed, `interior-or-non-access`
    // refuses the same symbol (measured on its fixture — the addend `add`'s result feeds the index
    // `add`, which is not an element access). It is FIRST because it names the real cause — this
    // is the `arrbias` control, whose pool word is `.word gTbl+0x1`.
    id: 'relocation-addend',
    why: 'a constant added straight to the address IS the relocation addend, and belongs to the base',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: a non-zero relocation addend refuses the symbol outright',
    rejects: (u) => u.addendIsConst,
  },
  {
    // Attributing: with it removed the walk stops at the `sub` and records no non-constant term,
    // so `no-subscript` refuses the same symbol (measured on its fixture).
    id: 'residual-not-a-sum',
    why: 'a `sub` makes a term’s sign depend on the walk, and a negative stride is not a subscript',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: a subtracted term in the residual refuses',
    rejects: (u) => u.isAdd && u.terms === null,
  },
  {
    id: 'address-unused',
    why: 'a computed element address nothing reads evidences nothing either way',
    sound: false,
    rejects: (u) => u.isAdd && u.consumers.length === 0,
  },
];

/** …and does a WHOLE-ELEMENT SUBSCRIPT spell what the address reaches? The half that is about the
 *  DECLARATION, so only `inferGlobalArrays` asks it: `orderLicensedGlobals` is deciding where the
 *  base was materialized, a question an interior read answers exactly as well as a whole-element
 *  one. */
export const DECLARATION_ADDRESS_GATES: readonly Gate<AddressUse>[] = [
  {
    // THIS is the rule that decides the `bgarr` shape — a 28-byte element read 2 bytes at a time.
    // It is uniquely load-bearing only where the symbol ALSO has a clean access: with an interior read alone,
    // removing the rule records no access at all (an interior read is not evidence, and is
    // filtered out) and the symbol is refused anyway, while beside a clean access removing it
    // derives an element type off a name the function reads at a displacement.
    // `kleod:UpdateCameraScroll` is that shape on the corpus — `gSineTable` derives `elemSize 2`
    // without this rule — which is why its fixture carries both accesses.
    id: 'interior-or-non-access',
    why: 'a non-zero displacement reads an INTERIOR of the element, which a whole-element subscript cannot spell',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: an element read at a displacement INSIDE it keeps the cast spelling',
    rejects: (u) => u.consumers.some((c) => !c.isElementAccess),
  },
];

/** The two halves in the order they were always asked, so the shape derivation's attribution is
 *  rule-for-rule what it was before the split. */
export const ADDRESS_GATES: readonly Gate<AddressUse>[] = [...ELEMENT_ADDRESS_GATES, ...DECLARATION_ADDRESS_GATES];

/** Everything one symbol's surviving accesses evidence, reduced to the facts `SHAPE_GATES` decide
 *  over. Per-access fields stay per-access on purpose: a rank is a property of ONE address
 *  expression, never of the union of several (see `ranks-disagree`). */
interface ShapeEvidence {
  /** Distinct ELEMENT widths under this name — `null` among them where an access reads an interior
   *  of the element and so evidences no element width at all (`Access.elementWidth`). Every rule
   *  below that reads a width spells that case, and spells it as a REFUSAL.
   *
   *  A RULE MUST NOT ASK THIS SET POSITIONALLY. `widths[0] === null` is not "no access has an
   *  element width" — it is "the FIRST recorded access has none", and the two come apart the
   *  moment a clean access is recorded before an interior one, which is `interior-or-non-access`'s
   *  own fixture. Measured on it, three width rules composed onto `ORDER_SHAPE_GATES` read the
   *  clean access's 2, applied it to the access that has no element width, and ADMITTED. So the
   *  null case is spelled over the whole set (`widths.includes(null)`) or, where the rule is
   *  really about one address, off that access's own `elementWidth` below.
   *
   *  THE SHAPE HAS A CORPUS INHABITANT, and it is not the one the fix's own first draft named.
   *  Instrumented over the artifact's 370 agbcc rows on BOTH symbol-map arms, three licensed
   *  symbols record a clean access and an interior one under one name — `kleod:EntityDeathAnimation`'s
   *  `gEntityArray` (`widths` `[null, 2]`), `kleod:EntityItemDrop`'s `gEntity` (`[null, 2, 1]`) and
   *  `kleod:TransformSingleEntityToScreen`'s `gUnk_03002920` (`[2, null]`). Only the third records
   *  the clean access FIRST, so it alone is the shape the positional read got wrong.
   *  `kleod:UpdateCameraScroll` is NOT one of them: it is the DECLARATION half's worked example
   *  (`interior-or-non-access` ablated derives `elemSize 2` there), and in the order consumer its
   *  `gSineTable` records no interior access at all — every width rule composed onto the licence,
   *  `mixed-access-width` included, still admits it.
   *
   *  The invariant is about rules that read a width VALUE. `mixed-access-width` reads only this
   *  set's shape (`length !== 1`), and on a symbol read ONLY at interiors — `[null]` — it admits,
   *  correctly: "one name, two element types" is not what that symbol violates, and every rule
   *  that would then go on to read the null refuses. */
  readonly widths: (number | null)[];
  /** distinct extensions, a store's implicit `false` included */
  readonly signs: boolean[];
  readonly perAccess: readonly {
    /** THIS access's element width, or null for an interior read — the per-address counterpart of
     *  `widths`, so a rule about one address never reads another's. */
    readonly elementWidth: number | null;
    /** ascending distinct strides of the non-constant terms; `[]` = the address names no subscript */
    readonly strides: number[];
    /** the inner extents those strides nest into, or null when they do not nest */
    readonly extents: number[] | null;
    /** a constant term that is not a whole number of elements — a mid-element displacement */
    readonly midElementConst: boolean;
    /** the order licence for this access (see `baseFirst`) */
    readonly baseFirst: boolean | undefined;
  }[];
  /** some access adds a non-zero constant on the INDEX side */
  readonly constOnIndex: boolean;
}

/** THE TWO ORDER PREDICATES, shared by the declaration table below and by `ORDER_SHAPE_GATES`.
 *  Shared as FUNCTIONS rather than as rule OBJECTS: the predicate really is the same question in
 *  both places, while `sound`, `why` and the guard are not — see `ORDER_SHAPE_GATES`, where the
 *  first cut of that table shared the objects and inherited a disjunct that is not about the
 *  order at all. */
const anIndexFirstAccess = (e: ShapeEvidence): boolean => e.perAccess.some((a) => a.baseFirst === false);
const noOrderEvidence = (e: ShapeEvidence): boolean => !e.perAccess.some((a) => a.baseFirst === true);

/** Does ONE array declaration describe every access of this name? Each rejection falls back to
 *  `((T *)&gSym)[i]`, which is byte-identical under any declaration. */
export const SHAPE_GATES: readonly Gate<ShapeEvidence>[] = [
  {
    // Attributing on the fixture below: with it removed the width collapses to the first access's
    // and `mixed-extension` refuses the same symbol (measured). It is first because "one name, two
    // element types" is the reason and the extension disagreement is a symptom of it.
    id: 'mixed-access-width',
    why: 'two widths under one name have no single element type to declare',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: two access widths under one name refuse',
    rejects: (e) => e.widths.length !== 1,
  },
  {
    // Asked only where it CHANGES the emitted bytes. A 4-byte element extends nothing, so
    // `bareArrayElement` ignores signedness there and a width-4 array both read and written would
    // otherwise refuse for a distinction the compiler cannot see.
    id: 'mixed-extension',
    why: 'the declared element type is the only thing in the emitted C saying how a sub-word read fills',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: one name read signed and unsigned refuses',
    rejects: (e) => e.widths.includes(null) || (e.widths.some((w) => w !== null && w < 4) && e.signs.length !== 1),
  },
  {
    // Attributing: an address with no variable term also has no stride, so
    // `stride-is-not-the-element` refuses it (measured on its fixture). It is stated separately
    // because "there is no subscript here at all" and "the subscript scales by the wrong thing"
    // are different facts.
    id: 'no-subscript',
    why: 'an address with no variable term names no element, so it evidences no array',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: an access with no variable term refuses',
    rejects: (e) => e.perAccess.some((a) => a.strides.length === 0),
  },
  {
    id: 'stride-is-not-the-element',
    why: 'the innermost stride must BE the element the access reads whole, or the subscript scales by the wrong thing',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: an index pre-scaled past the element refuses',
    rejects: (e) => e.perAccess.some((a) => a.elementWidth === null || a.strides[0] !== a.elementWidth),
  },
  {
    id: 'strides-do-not-nest',
    why: 'strides that are not whole multiples of one another are not a declared rank at all',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: a stride that is not a whole multiple of the element refuses entirely',
    rejects: (e) => e.perAccess.some((a) => a.extents === null),
  },
  {
    // `build_array_ref` recurses once per subscript WITHIN one access, so nesting is a property of
    // a single address. Two accesses at strides 4 and 16 on a flat `extern s32 g[]` (`g[i]` and
    // `g[j * 4]`) are not a rank; unioning them declares `extern s32 g[][4]` and spells `g[0][i]`,
    // a positive claim about the object that the assembly does not make and that no longer
    // compiles against the project's own header.
    id: 'ranks-disagree',
    why: 'a rank is read off ONE address expression; two accesses must agree or there is no one declaration',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: two accesses at different strides are not a rank',
    rejects: (e) => new Set(e.perAccess.map((a) => JSON.stringify(a.extents))).size > 1,
  },
  {
    id: 'mid-element-constant',
    why: 'a constant that is not a whole number of elements is a displacement no subscript spells',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: a constant that is not a whole element refuses',
    rejects: (e) => e.perAccess.some((a) => a.midElementConst),
  },
  {
    // ONE index-first access refuses the WHOLE symbol, and that is where this rule is uniquely
    // load-bearing: on a single-access function `no-positive-evidence` would refuse anyway, but a
    // function that subscripts the name twice with only ONE of them index-first has positive
    // evidence and still must not derive. "Index-first" means what `baseFirst` can SEE — a
    // scaling before the pool load in the pool load's own block; a scaling in another block is
    // not an index-first access, it is no evidence, and it belongs to the rule below.
    // Compiled: `gTbl[i] + gTbl[j]` and
    // `gTbl[i] + ((u16 *)gTbl)[j]` are the SAME object, while `((u16 *)gTbl)[i] + ((u16 *)gTbl)[j]`
    // is a different one — and agbcc CSEs the pool word, so the first access's order is the only
    // place that difference shows.
    id: 'index-materialized-first',
    why: 'a scaling of the index precedes the pool load IN ITS OWN BLOCK — the pointer path, which is the cast spelling',
    sound: true,
    // Its SECOND reaching fixture is the compiler-shaped one: `…and the same function cast-spelled
    // still refuses, on the access that CAN be compared` runs the real agbcc output for a function
    // that subscripts the name once outside a loop and once inside it. It is not named in
    // `guardedBy` because that field is matched against a single test title (gate-contract.ts).
    guardedBy: 'global-array-shape.test.ts: one index-first access refuses a symbol the others license',
    rejects: anIndexFirstAccess,
  },
  {
    id: 'no-positive-evidence',
    why: 'no order fact and no index-side constant: the two spellings are the same object, so a shape would be a guess',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: no evidence at all — width 1, no constant — claims nothing',
    rejects: (e) => noOrderEvidence(e) && !e.constOnIndex,
  },
];

/** The rules that decide the ORDER LICENCE — `orderLicensedGlobals`' shape half.
 *
 *  ITS OWN TWO RULES, sharing the PREDICATES above and nothing else, because the first cut of this
 *  table selected `SHAPE_GATES`' pair by id and that was a real over-admission rather than a style
 *  point. `no-positive-evidence` is a DISJUNCTION — an order fact OR a constant on the index — and
 *  only the first disjunct is about the order. A constant on the index evidences a SUBSCRIPT (see
 *  the header: agbcc folds a constant added to a pointer or cast base into the relocation addend,
 *  so a runtime `add` against a bare `.word gSym` is a shape only the array form produces); it says
 *  nothing whatever about where the base was materialized, and the inline cast `((u16 *)&g)[i + 1]`
 *  scales that constant exactly as `g[i + 1]` does. Compiled through the benchmark's own agbcc
 *  command, `extern u8 gTbl[]; s8 *p = (s8 *)gTbl; return gTbl[i + 1] + p[j];` has no scaling
 *  anywhere — every access is width 1 — so `baseFirst` is `undefined` at every access, and the
 *  selected table licensed `gTbl` on the constant alone, handing `/orderbase` a home the assembly
 *  never evidenced. Over the artifact's 370 agbcc rows the shipped difference is ONE name
 *  (`synthetic:harridx`'s `gTbl`, licensed with no access whose `baseFirst` is `true`, and shaped
 *  there so the structurer spells it bare); the compiled counterexample is what says the class is
 *  not that one row.
 *
 *  SHARING RULE OBJECTS DOES NOT SHARE PREMISES, and `sound` is where the two consumers part
 *  company. In `SHAPE_GATES` both rules are sound: what is derived there is a DECLARATION, and a
 *  wrong one changes the meaning of every access to the name. Here nothing is declared — the
 *  licence only OFFERS `/orderbase` a candidate beside the inline spelling, which the differ then
 *  referees — so an over-licensed name costs fan and a tie-break, never meaning, and these two are
 *  heuristics. Under-licensing is a lost candidate for the same reason, and this table really does
 *  under-license: a pointer local whose initializer is NOT a separate statement,
 *  `u16 *p; return (p = (u16 *)&gTbl)[i];`, compiles INDEX-first (measured, same command), so
 *  `order-index-first` declines a home that is really there. That is the direction the table is
 *  allowed to be wrong in, and it is why neither rule is `sound` here.
 *
 *  What IS shared is the predicate, so an edit to either reaches both consumers — while each rule
 *  object carries its own `sound`, `why` and `guardedBy`, so the guard the contract test checks is
 *  one that ablates the rule against THIS consumer rather than against the declaration. */
export const ORDER_SHAPE_GATES: readonly Gate<ShapeEvidence>[] = [
  {
    // ITS GUARD HAS TO BE THE MIXED SHAPE, and naming the minimal pair instead was a guard that
    // priced nothing: on BOTH halves of `base-first licenses, index-first does not` this rule can
    // be removed and the licence is unchanged, because on the index-first half the single access
    // has `baseFirst === false` and `no-order-evidence` — which wants ONE access that says `true` —
    // refuses anyway. The input where the two rules come apart is a name with one index-first
    // access AND one base-first access: there `no-order-evidence` is satisfied and only this rule
    // refuses. Over the artifact's 370 agbcc rows (359 lift) that shape has no inhabitant, and both
    // readings of "no inhabitant" were measured on BOTH symbol-map arms rather than one inferred
    // from the other: of the 33 symbols that reach this table, 1 has an index-first access and 0
    // have accesses in both orders, and this rule alone blocks 0 names where `no-order-evidence`
    // blocks 13. So it is kept for the class rather than for a row, and the fixture is what shows
    // the class is real: compiled through the benchmark's own agbcc command,
    // `((u16 *)gTbl)[i] + gTbl[j]` is a different object from `gTbl[i] + gTbl[j]` (and the same one
    // as `((u16 *)gTbl)[i] + ((u16 *)gTbl)[j]`), so the first access's order really does decide.
    id: 'order-index-first',
    why: 'a scaling of the index precedes the pool load in its own block — the inline pointer path, which has no home',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: one index-first access refuses a name the licence would otherwise grant',
    rejects: anIndexFirstAccess,
  },
  {
    id: 'no-order-evidence',
    why: 'no access materialized the base before scaling the index, so nothing here says the base had a home',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: a constant on the index is not an order fact',
    rejects: noOrderEvidence,
  },
];

/** The two tables together, so a caller ablates one rule by name without knowing which stage owns
 *  it. Defaulted on `inferGlobalArrays`; a test passes an ablated pair. */
export interface ArrayShapeGates {
  readonly address: readonly Gate<AddressUse>[];
  readonly shape: readonly Gate<ShapeEvidence>[];
}
export const ARRAY_SHAPE_GATES: ArrayShapeGates = { address: ADDRESS_GATES, shape: SHAPE_GATES };

/** The same pair for the ORDER half alone: the address rules that are about the address, and the
 *  shape rules that read `baseFirst`. Both halves are the shipped rule OBJECTS, so this table
 *  cannot drift from the one `inferGlobalArrays` asks. */
export const ORDER_LICENCE_GATES: ArrayShapeGates = { address: ELEMENT_ADDRESS_GATES, shape: ORDER_SHAPE_GATES };

/** Op → (block index, op index), for the order comparison. */
function positions(fn: Fn): Map<Op, { b: number; i: number }> {
  const pos = new Map<Op, { b: number; i: number }>();
  fn.blocks.forEach((blk, b) => blk.ops.forEach((op, i) => pos.set(op, { b, i })));
  return pos;
}

/** Every op that reads `v` as an operand. Successor arguments count as uses too — a value handed
 *  across an edge leaves this function's address arithmetic, which `address-escapes` covers. */
function useIndex(fn: Fn): Map<Value, Op[]> {
  const uses = new Map<Value, Op[]>();
  const add = (v: Value, op: Op): void => {
    uses.set(v, [...(uses.get(v) ?? []), op]);
  };
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.operands.forEach((o) => add(o, op));
      op.successors.forEach((s) => s.args.forEach((a) => add(a, op)));
    }
  }
  return uses;
}

/** `x * K` / `x << k` read as a scale, or scale 1 for anything else. A CONSTANT operand makes the
 *  whole term constant instead (`const << 2` is a displacement, not a subscript). */
function scaleOf(v: Value, defs: Map<Value, Op>): Term {
  const d = defs.get(v);
  const constOf = (x: Value): number | null => {
    const dx = defs.get(x);
    return dx?.opcode === 'const' ? (dx.attrs.value as number) : null;
  };
  if (d?.opcode === 'const') {
    return { scale: 0, v: null, konst: d.attrs.value as number, scaleOp: null };
  }
  if (d?.opcode === 'shl' && d.operands.length === 1 && typeof d.attrs.imm === 'number') {
    const k = d.attrs.imm;
    const inner = constOf(d.operands[0]);
    if (inner !== null) {
      return { scale: 0, v: null, konst: inner << k, scaleOp: null };
    }
    return k > 0 && k < 31
      ? { scale: 1 << k, v: d.operands[0], konst: 0, scaleOp: d }
      : { scale: 1, v, konst: 0, scaleOp: null };
  }
  if (d?.opcode === 'mul') {
    for (const [a, b] of [
      [d.operands[0], d.operands[1]],
      [d.operands[1], d.operands[0]],
    ] as const) {
      const k = constOf(b);
      if (k !== null && k > 0 && constOf(a) === null) {
        return { scale: k, v: a, konst: 0, scaleOp: d };
      }
    }
  }
  return { scale: 1, v, konst: 0, scaleOp: null };
}

/** The additive terms of a byte residual. Only `add` is opened: a `sub` at the top of the tree
 *  makes a term's sign depend on the walk, and a NEGATIVE stride is not an array subscript this
 *  spelling can express, so it refuses rather than dropping the sign. */
function residualTerms(root: Value, defs: Map<Value, Op>): Term[] | null {
  const out: Term[] = [];
  const walk = (v: Value, depth: number): boolean => {
    if (depth > 16) {
      return false; // a pathological address tree: refuse rather than walk it
    }
    const d = defs.get(v);
    if (d?.opcode === 'sub') {
      return false;
    }
    if (d?.opcode === 'add') {
      return walk(d.operands[0], depth + 1) && walk(d.operands[1], depth + 1);
    }
    out.push(scaleOf(v, defs));
    return true;
  };
  return walk(root, 0) ? out : null;
}

/** Every access of every named data global in `fn`, keyed by symbol — or, for a symbol any of
 *  whose uses `ADDRESS_GATES` rejects, the ID OF THE RULE that rejected it. The rejection is per
 *  SYMBOL and never withdrawn: what is being derived is a DECLARATION, and one use this spelling
 *  does not model makes the name keep the cast form everywhere. The id is carried rather than a
 *  bare null so a census asks which rule decided instead of re-deriving the predicates.
 *
 *  `interiorIsEvidence` is the second consumer's half of the filter below: an access at a non-zero
 *  displacement says nothing about the ELEMENT (its width is the sub-word read's, not the
 *  element's) and everything about the ORDER (its terms and its `gaddr` are the same ones). The
 *  declaration derivation keeps the default and never sees one. */
function accessesBySymbol(
  fn: Fn,
  gates: readonly Gate<AddressUse>[],
  interiorIsEvidence = false,
): Map<string, Access[] | { refusedBy: string }> {
  const defs = defOpMap(fn);
  const uses = useIndex(fn);
  const out = new Map<string, Access[] | { refusedBy: string }>();
  const refuse = (sym: string, id: string): void => void out.set(sym, { refusedBy: id });
  const record = (sym: string, a: Access): void => {
    const cur = out.get(sym);
    if (cur !== undefined && !Array.isArray(cur)) {
      return; // already refused: a refusal is per SYMBOL and never withdrawn
    }
    out.set(sym, [...(cur ?? []), a]);
  };
  for (const b of fn.blocks) {
    for (const g of b.ops) {
      if (g.opcode !== 'gaddr' || typeof g.attrs.sym !== 'string' || g.attrs.code === true) {
        continue;
      }
      const sym = g.attrs.sym;
      const base = g.results[0];
      const gUses = uses.get(base) ?? [];
      if (gUses.length === 0) {
        continue; // a dead address: no evidence either way, and nothing to spell
      }
      for (const u of gUses) {
        const isAdd = u.opcode === 'add';
        const other = isAdd ? (u.operands[0] === base ? u.operands[1] : u.operands[0]) : undefined;
        const terms = other === undefined ? null : residualTerms(other, defs);
        const consumers = (isAdd ? (uses.get(u.results[0]) ?? []) : []).map((m) => {
          const isLoad = m.opcode === 'load' && m.operands[0] === u.results[0];
          const isStore = m.opcode === 'store' && m.operands[0] === u.results[0];
          return { m, isLoad, isStore, isElementAccess: (isLoad || isStore) && (m.attrs.off as number) === 0 };
        });
        const use: AddressUse = {
          isAdd,
          addendIsConst: other !== undefined && defs.get(other)?.opcode === 'const',
          terms,
          consumers,
        };
        const rejected = firstRejection(gates, use);
        if (rejected !== null) {
          refuse(sym, rejected);
          break;
        }
        // WHICH ACCESSES ARE EVIDENCE, and it is a different set per consumer. The DECLARATION
        // takes the whole-element ones only — filtered rather than assumed, because with
        // `interior-or-non-access` ABLATED (a test does exactly that) an interior read would
        // otherwise join the evidence and an ablation must remove a REFUSAL, never manufacture a
        // fact. The ORDER consumer passes `interiorIsEvidence` and takes every load and store,
        // because a read two bytes into the element says exactly as much about where the base was
        // materialized as a whole-element one does — and says nothing about the element, which is
        // why it is recorded with `elementWidth: null` rather than with the load's own width.
        for (const c of consumers.filter((x) => (interiorIsEvidence ? x.isLoad || x.isStore : x.isElementAccess))) {
          record(sym, {
            elementWidth: c.isElementAccess ? (c.m.attrs.width as number) : null,
            signed: c.isLoad && (c.m.attrs.signed as boolean) === true,
            isLoad: c.isLoad,
            terms: terms ?? [],
            gaddr: g,
          });
        }
      }
    }
  }
  return out;
}

/** The distinct STRIDES of an access's non-constant terms, ascending. EMPTY when the access has
 *  no non-constant term (a pure constant address — `&gSym + K` — which names no subscript);
 *  `no-subscript` is the gate that reads that. Deduped and sorted, which is the precondition
 *  `extentsOf` relies on. */
function stridesOf(a: Access): number[] {
  return [...new Set(a.terms.filter((t) => t.v !== null).map((t) => t.scale))].sort((x, y) => x - y);
}

/** THE ORDER LICENCE for one access, as a three-valued answer — and the third value is the point.
 *
 *  `true` = every scaling of the index this walk CAN compare happens after the base was
 *  materialized (the array-subscript shape); `false` = at least one comparable scaling happens
 *  BEFORE it (the pointer shape, which is the cast spelling); `undefined` = there is nothing to
 *  compare, so the order says nothing at all and the symbol must find its licence elsewhere.
 *
 *  ONLY A SCALING IN THE SAME BLOCK AS THE POOL LOAD IS COMPARABLE, and that is a statement about
 *  agbcc rather than a convenience. One `ldr` is SHARED by every access of the name and it is
 *  hoisted out of loops — both visible in the fixtures beside this rule — so once the load and a
 *  scaling sit in different blocks at least one of them has been MOVED relative to the expression
 *  that wrote it, and the function's instruction order no longer records `build_array_ref`'s
 *  expansion order. Compiled, that is exactly what happens — a loop whose
 *  only subscript is in the body hoists the `ldr` into the preheader and the two spellings
 *
 *      for (i = 0; i < n; i++) s += gTbl[p[i]];
 *      for (i = 0; i < n; i++) s += ((u16 *)gTbl)[p[i]];
 *
 *  become ONE object, byte-identical `.s` included. So a cross-block scaling gets `undefined`
 *  rather than `false`: answering `false` there would be the positive claim "the index was scaled
 *  first" about an access that makes no claim either way, and the symbol belongs to
 *  `no-positive-evidence`, which is what "this says nothing" is called in that table — a refusal
 *  either way, but the true one.
 *
 *  The discrimination the rule exists for is untouched, because it lives in the SAME-BLOCK
 *  accesses: compiled, a function that subscripts once outside a loop and once inside it is a
 *  different object under the two spellings, and the difference is at the access outside. */
function baseFirst(a: Access, pos: Map<Op, { b: number; i: number }>): boolean | undefined {
  const g = pos.get(a.gaddr);
  if (g === undefined) {
    return undefined;
  }
  const comparable = a.terms
    .map((t) => (t.scaleOp === null ? undefined : pos.get(t.scaleOp)))
    .filter((p): p is { b: number; i: number } => p !== undefined && p.b === g.b);
  return comparable.length === 0 ? undefined : comparable.every((p) => p.i > g.i);
}

/** The shape one symbol's accesses evidence, or null where `SHAPE_GATES` rejects. Decided over
 *  ALL of the symbol's accesses at once, because what is being derived is a DECLARATION: one
 *  element type and one rank for the name, or none.
 *
 *  The ELEMENT SIGNEDNESS this returns is a PICK, not a reading — see the module note's compiled
 *  pair. Where the source ends up resting on it, it travels out as an assumption
 *  (`assumedShapes` → `DecompileResult.assumedSymbols`) rather than being applied silently. */
function evidenceOf(accs: Access[], pos: Map<Op, { b: number; i: number }>): ShapeEvidence {
  const perAccess = accs.map((a) => {
    const strides = stridesOf(a);
    // THIS access's own width, never the first one's. Reading `accs[0]` was safe only behind
    // `mixed-access-width`, which is in the declaration table and NOT in the order table — so on
    // the second consumer a clean access recorded ahead of an interior one lent the interior one
    // its width, and a mid-element test against a fabricated element is a lie in the licence's
    // favour. Null — an interior access, which only the order consumer records — is no element
    // width, so there is no whole number of elements for a constant to be, and the answer is the
    // refusal.
    const width = a.elementWidth;
    return {
      elementWidth: width,
      strides,
      extents: extentsOf(strides),
      midElementConst: width === null || a.terms.some((t) => t.v === null && t.konst % width !== 0),
      baseFirst: baseFirst(a, pos),
    };
  });
  return {
    widths: [...new Set(accs.map((a) => a.elementWidth))],
    signs: [...new Set(accs.map((a) => a.signed))],
    perAccess,
    constOnIndex: accs.some((a) => a.terms.some((t) => t.v === null && t.konst !== 0)),
  };
}

function shapeOf(
  accs: Access[],
  pos: Map<Op, { b: number; i: number }>,
  gates: readonly Gate<ShapeEvidence>[],
): SymbolInfo | null {
  if (accs.length === 0 || firstRejection(gates, evidenceOf(accs, pos)) !== null) {
    return null;
  }
  const perAccess = evidenceOf(accs, pos).perAccess;
  // The DECLARED signedness is the loads' — a store extends nothing, and `mixed-extension` has
  // already refused a name whose loads disagree at a width where it shows.
  const loadSigns = new Set(accs.filter((a) => a.isLoad).map((a) => a.signed));
  const dims = perAccess[0].extents ?? [];
  const elemSize = accs[0].elementWidth;
  if (elemSize === null) {
    // Unreachable on the shipped declaration path — `interior-or-non-access` refuses every symbol
    // with an interior access, and only the ORDER consumer passes `interiorIsEvidence`, which does
    // not call this function. Spelled anyway rather than asserted away, because the alternative is
    // a declaration carrying a sub-word read's width as if it were the element's.
    return null;
  }
  return {
    name: (accs[0].gaddr.attrs.sym as string) ?? '',
    kind: 'data',
    shape: 'array',
    elemSize,
    elemSigned: loadSigns.size === 1 ? [...loadSigns][0] : false,
    ...(dims.length ? { dims: [null, ...dims] } : {}),
  };
}

/** The INNER extents of a declared rank, read out of ascending strides: each stride must be a
 *  whole multiple — at least 2× — of the one below it, or two positions in the array would be
 *  indistinguishable and the split would be a guess. Rank 1 is `[]`. */
function extentsOf(strides: number[]): number[] | null {
  const extents: number[] = [];
  for (let i = 1; i < strides.length; i++) {
    const k = strides[i] / strides[i - 1];
    // NOT AN INTEGER is the live half; `k < 2` is belt-and-braces on a precondition `stridesOf`
    // already establishes (it dedups through a Set and sorts, so consecutive strides are strictly
    // ascending and an integer ratio is at least 2). Kept as an assertion of what this function
    // needs from its caller, not as a rule with an inhabitant — an extent of 1 would make two
    // positions in the array name one cell.
    if (!Number.isInteger(k) || k < 2) {
      return null;
    }
    extents.unshift(k);
  }
  return extents;
}

/** Do two `SymbolInfo`s say the same thing about the ONE question the bare subscript asks — which
 *  object the name denotes, cell by cell? Every field `bareArrayElement` / `bareArrayLead` /
 *  `declaredSubscripts` (structure/globalaccess.ts) and the array branch of the declaration
 *  renderer (declare.ts) read, and nothing else: two entries agreeing here spell and declare the
 *  same addresses whichever one a consumer picked up.
 *
 *  This exists because the SPELLING and the DECLARATION are decided from different derivations —
 *  rank.ts derives the declaration dictionary once off the probe's lift and the spelling per
 *  symbol variant off that variant's own — and a candidate that spells from one and declares from
 *  the other addresses a different object than the assembly did, compiling either way. */
export function sameDerivedShape(a: SymbolInfo | undefined, b: SymbolInfo | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const dims = (i: SymbolInfo): string => JSON.stringify(i.shape === 'array' ? (i.dims ?? null) : null);
  return (
    a.shape === b.shape &&
    a.elemSize === b.elemSize &&
    (a.elemSigned ?? false) === (b.elemSigned ?? false) &&
    dims(a) === dims(b)
  );
}

/** The array shapes `fn`'s own assembly evidences for the globals it names, keyed by name.
 *
 *  Runs on the LIFTED function (see the module note: the raising tower destroys the order the
 *  licence reads). Empty for every target that has not opted in, and empty where nothing is
 *  evidenced — never a partial guess. */
export function inferGlobalArrays(
  fn: Fn,
  target: TargetDescription,
  gates: ArrayShapeGates = ARRAY_SHAPE_GATES,
): Map<string, SymbolInfo> {
  const out = new Map<string, SymbolInfo>();
  if (target.compilerBehaviors.arrayShapeFromStride !== true) {
    return out;
  }
  const pos = positions(fn);
  for (const [sym, accs] of accessesBySymbol(fn, gates.address)) {
    const si = Array.isArray(accs) ? shapeOf(accs, pos, gates.shape) : null;
    if (si !== null) {
      out.set(sym, si);
    }
  }
  return out;
}

/** The globals whose address `fn`'s assembly materialized BEFORE it scaled the index — the ORDER
 *  half of the licence, on its own (see THE ORDER LICENCE HAS TWO CONSUMERS in the header).
 *
 *  A SUPERSET of the names `inferGlobalArrays` shapes: a name that one shapes has no interior
 *  consumer at all (`interior-or-non-access` refused every symbol that does), so both derivations
 *  see the identical accesses and this one asks strictly fewer rules of them. The difference is the
 *  point — a name read at a DISPLACEMENT, a struct element among them, is licensed here and refused
 *  there. What this set is NOT is a declaration: it travels through no honesty channel, because a
 *  pointer local over `&gSym` reproduces the bytes under any declaration of `gSym`, exactly as the
 *  cast spelling it re-homes does.
 *
 *  A GENERATOR, never a classifier. Its consumer (`l3/basecse.ts`'s `order-licensed`, reached from
 *  rank's `/orderbase` roster row) uses it to OFFER a candidate beside the inline spelling, which
 *  the differ then referees — so an over-licensed name costs fan and a tie-break, never meaning.
 *  Empty for every target that has not opted in. */
export function orderLicensedGlobals(
  fn: Fn,
  target: TargetDescription,
  gates: ArrayShapeGates = ORDER_LICENCE_GATES,
): ReadonlySet<string> {
  const out = new Set<string>();
  if (target.compilerBehaviors.arrayShapeFromStride !== true) {
    return out;
  }
  const pos = positions(fn);
  for (const [sym, accs] of accessesBySymbol(fn, gates.address, true)) {
    if (Array.isArray(accs) && accs.length > 0 && firstRejection(gates.shape, evidenceOf(accs, pos)) === null) {
      out.add(sym);
    }
  }
  return out;
}

/** Which rule refused each name this function's pool spells, or null where a shape was derived —
 *  the attribution `firstRejection` exists for. NOT on the shipped path: a caller instrumenting a
 *  refusal (a census, a plan that needs the FIRST guard rather than the co-occurring set) asks
 *  here instead of re-deriving the predicates — the one place an attribution is measured rather
 *  than asserted. */
export function arrayShapeRefusals(
  fn: Fn,
  target: TargetDescription,
  gates: ArrayShapeGates = ARRAY_SHAPE_GATES,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (target.compilerBehaviors.arrayShapeFromStride !== true) {
    return out;
  }
  const pos = positions(fn);
  for (const [sym, accs] of accessesBySymbol(fn, gates.address)) {
    out.set(
      sym,
      Array.isArray(accs)
        ? accs.length === 0
          ? 'no-accesses'
          : firstRejection(gates.shape, evidenceOf(accs, pos))
        : accs.refusedBy,
    );
  }
  return out;
}

/** THE SHAPES THE EMITTED SOURCE ACTUALLY RESTS ON — which is a strictly smaller set than the
 *  shapes this module DERIVED, and the difference is the whole reason the two are separate
 *  functions rather than one.
 *
 *  `inferGlobalArrays` answers "what does this assembly evidence". The honesty channel
 *  (`DecompileResult.assumedSymbols`, `TraceReport.assumedSymbols`, the cli's `[assumed]` block,
 *  the playground's panel) answers a different question: which declarations is the reader obliged
 *  to check, because the source in front of them is right only beside those declarations. A
 *  derived shape earns that obligation only where BOTH of these hold, and a shape can fail either
 *  one:
 *
 *  1. THE STRUCTURER ACTUALLY SPELLED THE NAME BARE. A derivation reaching a symbol does not
 *     make the source depend on it — every consumer of a shape can still refuse, and then the
 *     access keeps `((T *)&gSym)[i]`, which reproduces the bytes under ANY declaration and
 *     therefore assumes nothing. `kleod:SetupBG3WindowOverlay` is that case on the corpus: the
 *     `gBgInfo` shape derives (element 4) and `arrayAccess` declines it (the access carries a
 *     field offset), so the emitted source casts and the reader has nothing to check.
 *  2. NO SYMBOL MAP DESCRIBED THE NAME. `structure()` asks the project's map FIRST, so on a
 *     map-ful function the spelling is the MAP's and the derived shape never reached the source
 *     — including when the map CONTRADICTS it, which is the sharp case (`sa3:sa2__sub_8083504`
 *     derives `elemSigned: false` off its own `ldrh` while the vendored map declares
 *     `const s16 gSineTable[1280]`). Publishing the derivation there tells the reader to check a
 *     declaration against headers that already answered, and answered differently. Where the map
 *     AGREES the name may well be spelled bare — but then it is the MAP's declaration the source
 *     rests on, supplied by the caller, and nothing was assumed.
 *
 *  `SFn.globals` IS test (1): `structure()` populates it through `noteGlobal`, which is called at
 *  exactly the three declaration-dependent bare-array spellings (structure.ts — `bareArrayLead` on
 *  each of the byte-address and element-index paths, and `declaredSubscripts`) and nowhere else.
 *  A fourth caller would have to be added to this list too, which is why the coupling is stated
 *  here rather than left to be rediscovered. */
export function assumedShapes(
  inferred: Map<string, SymbolInfo>,
  sfn: SFn,
  mapSymbols?: { has(name: string): boolean },
): SymbolInfo[] {
  const spelledBare = new Set((sfn.globals ?? []).map((g) => g.name));
  return [...inferred.values()].filter((i) => spelledBare.has(i.name) && mapSymbols?.has(i.name) !== true);
}
