// asmlift — the address→symbol map seam (research/symbol-map-plan-2026-07-22.md).
//
// A `SymbolMap` tells the pipeline what the project knows about its absolute addresses: the
// name (from the ELF `.symtab`), and optionally the byte-sensitive declaration shape (from the
// project's DWARF types-sidecar). Core only consumes the VALUE — providers that read files live
// in @asmlift/cli; tests and the webapp hand-build maps. Absent map ⇒ behavior byte-identical
// (the `prototypes`/`asmData` optionality contract).
//
// An address legitimately carries SEVERAL symbols in real projects (ldscript aliases, rename
// leftovers, deliberate typed views of one RAM region), hence `SymbolInfo[]` per address with
// the provider's canonical pick at index 0.
import { type IrType, T } from './ir/types';

/** One field of a struct-shaped global, from the sidecar DWARF layout. */
export interface SymbolStructField {
  name: string;
  /** byte offset from the struct start */
  offset: number;
  /** bytes read at `offset` (null for flexible/unknown members) */
  size: number | null;
  /** the field type's base-type signedness (absent = not a base type / unknown) — drives the
   *  u8-vs-s8 spelling of a SYNTHESIZED field decl (an s8 read is ldrb+lsl+asr, u8 is ldrb) */
  signed?: boolean;
  /** the field's resolved type is a pointer — synthesis must spell it as one, or relational
   *  compares of the loaded value flip signedness (s32 `blt` vs the pointer truth's `bcc`) */
  pointer?: boolean;
  /** POINTER field only: the byte width of what it points AT, when that is a base type
   *  (`u16 *p` → 2). The cell is 4 bytes whatever it addresses; this is the OTHER end, and it is
   *  byte-load-bearing because POINTER ARITHMETIC SCALES BY IT — `p - 4` through a `u16 *` and
   *  through a `void *` address different memory. Absent ⇒ the target is not a base type
   *  (`void *`, `struct S *`) and `void *` remains the honest spelling. */
  pointeeSize?: number;
  /** POINTER field only: signedness of the pointed-at base type, on the same terms as
   *  {@link pointeeSize} — it types the LOAD through the pointer (`s8` is ldrsb, `u8` ldrb). */
  pointeeSigned?: boolean;
  /** the field's type chain is volatile-qualified (the `vu16 field;` MMIO idiom) — a decl that
   *  drops it lets the compiler fold repeated reads (wrong bytes AND wrong semantics) */
  volatile?: boolean;
  /** the field's type chain is const-qualified — a STORE through the member's name is a hard
   *  error where the cast spelling it replaces only warned, so a named store declines on it */
  const?: boolean;
  /** ARRAY field only: the byte size of ONE element — `size` above is the WHOLE member (`u8
   *  x[16]` → 16), so this is the stride an indexed `field[i]` spelling needs. Its PRESENCE is
   *  what marks a field an array, which the exact-match field rules must exclude: a one-element
   *  array (`u8 x[1]`, size 1) would otherwise match a byte access and spell `->x`, which is not
   *  an lvalue of that width. */
  elemSize?: number;
  /** ARRAY field only: the ELEMENT's base-type signedness (absent = not a base type) — the same
   *  u8-vs-s8 fact `signed` carries for a scalar field, and the guard an indexed spelling needs
   *  (an s8 element read is ldrb+lsl+asr where u8 is ldrb alone) */
  elemSigned?: boolean;
  /** ARRAY field only: the element count (absent for a flexible array member, which declares a
   *  stride but no bound) — types the synthesized `T name[n];` field decl */
  length?: number;
  /** BITFIELD field only: the field's width in BITS. Its PRESENCE is what marks a field a
   *  bitfield — `size` above stays the byte span its bits touch (the read width the compiler
   *  uses), which is why the exact (offset,size) scalar-field rules must exclude it. The
   *  provider only emits these for LITTLE-ENDIAN ELFs: both the extract equation the access
   *  recognizer solves and the `u32 name : n` layout model the synthesis verifies are LE-GCC
   *  semantics, so a big-endian map carries no bitfield members at all (today's behavior). */
  bitWidth?: number;
  /** BITFIELD field only: the bit position of the field's LOW bit within the byte at `offset`
   *  (LSB-first) — the field's absolute low bit is `offset*8 + bitOffset`. Required alongside
   *  `bitWidth`; a bitfield missing it is malformed and declines the whole layout. */
  bitOffset?: number;
}

/** What a `shape:'pointer'` global POINTS AT, when the sidecar says its target is a struct/union.
 *  The pointer cell itself is 4 bytes whatever it addresses; this is about the OTHER end — it is
 *  what lets an access through the LOADED pointer spell `gPtr->field` instead of byte arithmetic
 *  on the cell's value. Absent when the target is not a struct (a scalar/pointer/function target). */
export interface SymbolPointee {
  /** the name the pointee type is declared under — a struct tag, or the typedef alias for the
   *  `typedef struct {…} T;` idiom (absent when the DWARF gives the target no name at all) */
  structName?: string;
  /** total byte size of the pointee type */
  size?: number;
  /** the pointee's fields — absent when the sidecar carries no layout for the named type, which
   *  is exactly when no field spelling may be attempted */
  layout?: SymbolStructField[];
  /** the POINTEE type is volatile-qualified (`volatile struct S *g`) — a fact about the OTHER end
   *  of the pointer, independent of the cell's own qualifiers (`struct S *volatile g`, which is
   *  `SymbolInfo.volatile`). Synthesis must reproduce it, and it forbids the named spelling
   *  outright: `gPtr->m` would be a volatile access where the cast form it replaces was plain */
  volatile?: boolean;
  /** the POINTEE type is const-qualified (`const struct S *g`) — same independence from the
   *  cell's own `const`. A STORE through a member's name is then a hard error */
  const?: boolean;
}

/** One declared type in a signature — width, signedness, pointer-ness. Deliberately the same
 *  vocabulary a struct member uses, so a parameter and a field of the same C type describe
 *  identically. `size: null` = the DWARF did not size it.
 *
 *  NO POINTEE, and the absence is UPSTREAM's rather than a shape asmlift dropped:
 *  `@gba-kit/debug-info`'s `TypeFacts` — what a `FunctionSignature`'s params are made of — is
 *  exactly these three fields. {@link SymbolInfo.pointee} exists only for a symbol AT AN ADDRESS.
 *  Widening this is priced in docs/level-tower.md and pinned in test/param-pointee-axis.test.ts. */
export interface SymbolTypeFacts {
  size: number | null;
  signed: boolean | null;
  pointer?: boolean;
}

/** A CODE symbol's declared signature, read from the project's own DWARF.
 *
 *  LEAKAGE WARNING, and it is the whole reason `asIfUndecompiled` exists: a compiler emits this
 *  only for a function it COMPILED. Every benchmark row is already decompiled, so the row's own
 *  signature is present there and absent for the user, who is decompiling the one function whose
 *  definition their project does not have. Only CALLEE signatures transfer. */
export interface SymbolSignature {
  /** the return type, or null for `void` */
  returns: SymbolTypeFacts | null;
  /** the definition's own parameter list — authoritative (a definition records what it takes) */
  params: SymbolTypeFacts[];
}

export interface SymbolInfo {
  name: string;
  kind: 'code' | 'data';
  /** `kind: 'code'` only — the declared signature from the project's DWARF. DEFINITION-DERIVED:
   *  see {@link SymbolSignature} and {@link asIfUndecompiled}. */
  signature?: SymbolSignature;
  /** a DWARF DIE exists for this name ⇒ the project headers declare it (safe to emit) */
  declared?: boolean;
  /** total byte size — complete-typed globals only; an unsized extern array has none */
  size?: number;
  /** the byte-sensitive declaration shape (drives P2 rendering; absent ⇒ name-only) */
  shape?: 'scalar' | 'array' | 'struct' | 'pointer';
  /** scalar signedness for `shape:'scalar'` (absent = not a base type, e.g. an enum) — types
   *  the synthesized `extern T name;` declaration */
  signed?: boolean;
  /** element byte width for `shape:'array'` — enables the bare `gSym[i]` spelling */
  elemSize?: number;
  /** element signedness for `shape:'array'` (default unsigned) — types the env entry */
  elemSigned?: boolean;
  /** ARRAY RANK for `shape:'array'` — the per-dimension extents, outermost first (`u16
   *  g[4][0x400]` → `[4, 1024]`), `null` for an unbounded one. It is NOT `size`/`elemSize`
   *  restated: those size the object, this says how many subscripts reach an ELEMENT. `gSym[i]`
   *  on a rank-2 array is a ROW — against the project's own header that is a type error, or,
   *  where the row address flows into an integer context, silently the wrong address. So the
   *  bare spelling needs the leading subscripts (`gSym[0][i]`), and its ABSENCE is what forbids
   *  the bare spelling from being attempted at all (see the provider's dims capability gate:
   *  a package that cannot report rank must not be read as "rank 1"). */
  dims?: (number | null)[];
  /** the real struct tag for `shape:'struct'` — names the synthesized struct declaration
   *  (absent ⇒ synthesis mints a placeholder tag; the tag is codegen-arbitrary) */
  structName?: string;
  /** the declaration is volatile-qualified — load-bearing for synthesis: a non-volatile decl
   *  of an MMIO global lets the compiler fold/reorder accesses (wrong bytes AND semantics) */
  volatile?: boolean;
  /** the declaration is const-qualified (ROM tables) — spelling fidelity */
  const?: boolean;
  /** field names/offsets for `shape:'struct'` — enables `gSym.field` interior spelling */
  layout?: SymbolStructField[];
  /** the pointee facts for `shape:'pointer'` — enables the `gPtr->field` interior spelling
   *  (absent ⇒ the target is not a struct, or the sidecar named no layout for it) */
  pointee?: SymbolPointee;
  /** This name is an ADDRESS-CAST MACRO, and this is its body verbatim from the project header
   *  (`(*(u32 *)0x03005290)`). Some projects name a fixed RAM cell that way instead of declaring
   *  an `extern` — and the two are not interchangeable in the bytes: an `extern` makes the
   *  compiler emit a RELOCATED pool word (`.word gSym`), while the macro expands to a literal
   *  address and emits a NUMERIC one (`.word 0x3005290`). Matching a target that shows the
   *  numeric word therefore requires the macro spelling, not merely a name.
   *
   *  Everything else about it is already the global machinery: the macro expands to an lvalue, so
   *  `gName`, `gName = v` and `&gName` all mean what they mean for an `extern`. Only the
   *  DECLARATION differs — `#define name body` instead of `extern T name;` — which is why the
   *  body is carried rather than reconstructed. */
  macroBody?: string;
}

/** THE one reading of {@link SymbolInfo.dims} for spelling C, shared by the access side
 *  (structure.ts's bare-name gate) and the declaration side (declare.ts) so the two cannot
 *  disagree about an array's shape.
 *
 *  Returns the INNER extents — every dimension but the outermost. The outermost is excluded
 *  because C lets a declaration omit it, and the inner ones are exactly what scales a leading
 *  subscript. `[]` is the rank-1 answer: one subscript, `extern T gSym[];`, the spelling this has
 *  always had.
 *
 *  An ABSENT `dims` also reads as rank 1, because that is what the author of such a map said: the
 *  ELF provider's capability gate refuses a @gba-kit/debug-info that cannot report rank, so
 *  absence here can only come from a hand-written map whose `shape:'array'` states a plain array.
 *  Absence never means "the package could not say" — that case fails loudly at load.
 *
 *  Null means NO consistent pair is available (a stated rank with an unknown inner extent, which
 *  neither a declaration nor a subscript can spell). Both sides honour it the same way: the access
 *  falls back to `((T *)&gSym)[i]`, the declaration to the flat `extern T gSym[];` — valid
 *  together under whatever the project's own header says. */
export function arrayInnerExtents(info: SymbolInfo): number[] | null {
  const dims = info.shape === 'array' ? info.dims : undefined;
  if (dims === undefined || dims.length <= 1) {
    return [];
  }
  const inner = dims.slice(1);
  return inner.every((d) => typeof d === 'number' && d > 0) ? (inner as number[]) : null;
}

/** address → symbols at that address; `[0]` is the provider's canonical pick. */
export type SymbolMap = Map<number, SymbolInfo[]>;

/** THE one test for "is this field an array". The PRESENCE of `elemSize` is what marks one (see
 *  the field doc) — `length` is a separate fact that a flexible array member legitimately lacks,
 *  so testing it instead silently reclassifies such a member as a scalar cell. */
export function isArrayField(f: SymbolStructField): boolean {
  return f.elemSize !== undefined;
}

/** THE one test for "is this field a POINTER", and it is a test of TWO facts. The flag alone is
 *  not enough: {@link symbolFieldType} declares a pointer only at `size === 4`, so a `pointer`
 *  member of any other size declares as a scalar cell or a byte array — and a consumer trusting
 *  the flag alone would spell pointer arithmetic on a value the very declaration beside it calls a
 *  `u16`. The two answers must be the SAME answer, for the same reason declaredFields and the
 *  synthesis must: core reasoning about a member as something the declaration does not declare is
 *  non-compiling C. */
export function isPtrField(f: SymbolStructField): boolean {
  return f.pointer === true && f.size === 4;
}

/** THE one test for "is this field a bitfield" — the PRESENCE of `bitWidth` (see the field doc).
 *  The exact (offset,size) scalar-field rules must exclude these: a 7-bit field whose bits span
 *  2 bytes carries `size: 2` and would otherwise match a plain u16 read at its offset. */
export function isBitfieldField(f: SymbolStructField): boolean {
  return f.bitWidth !== undefined;
}

/** A layout member that {@link declaredFields} passed: sizable, and seated at an offset no
 *  earlier member already covers. */
export type DeclaredField = SymbolStructField & { size: number };

/** Is `f` shaped like a layout member at all? `SymbolMap` is public API — a caller-supplied map
 *  (the webapp accepts one) must be DECLINED, never crash the pipeline. */
function wellFormedField(f: unknown): f is SymbolStructField {
  if (typeof f !== 'object' || f === null) {
    return false;
  }
  const m = f as Partial<SymbolStructField>;
  if (
    typeof m.name !== 'string' ||
    typeof m.offset !== 'number' ||
    !Number.isFinite(m.offset) ||
    !(m.size === null || (typeof m.size === 'number' && Number.isFinite(m.size) && m.size >= 0))
  ) {
    return false;
  }
  // A bitfield's two facts must be present TOGETHER and internally consistent — a bitWidth with
  // no bitOffset (or bits outside the byte span `size` claims) leaves the field unseatable, so
  // the member is malformed and the layout declines whole like any other malformed member.
  if (m.bitWidth !== undefined) {
    return (
      typeof m.bitWidth === 'number' &&
      Number.isInteger(m.bitWidth) &&
      m.bitWidth > 0 &&
      typeof m.bitOffset === 'number' &&
      Number.isInteger(m.bitOffset) &&
      m.bitOffset >= 0 &&
      typeof m.size === 'number' &&
      m.bitOffset + m.bitWidth <= m.size * 8
    );
  }
  return true;
}

/**
 * THE one definition of "which members of this layout exist", for every consumer: the declaration
 * SYNTHESIS that PRINTS them (declare.ts) and the access rules that NAME them (structure.ts).
 * Returns the members in offset order, or null when the layout cannot be reproduced faithfully at
 * all — and the two answers must be the same answer, because core naming a member that synthesis
 * does not declare is non-compiling C.
 *
 * Declines the WHOLE layout on an unsizable member (its successors' offsets are then unknowable,
 * so no member of it can be seated), on a malformed one, and on an array member whose
 * `elemSize * length` does not account for its `size` (the three facts contradict each other, so
 * none of them can be trusted). SELECTS by dropping a member an earlier one already covers — the
 * union-alias rule: `struct { u32 word; u16 half; }` at one offset declares the first view only,
 * so `half` is a name no declaration carries and no access may spell.
 */
export function declaredFields(layout: SymbolStructField[] | undefined): DeclaredField[] | null {
  if (!Array.isArray(layout)) {
    return null;
  }
  // Validate BEFORE sorting: the comparator reads `.offset`, so a malformed entry would throw
  // there rather than decline here — the crash this function exists to prevent.
  for (const m of layout) {
    if (!wellFormedField(m) || m.size === null) {
      return null;
    }
    if (isArrayField(m) && m.length !== undefined && m.elemSize! * m.length !== m.size) {
      return null;
    }
  }
  // The cursor is in BITS so co-located bitfields seat correctly: `u32 a:2; u32 b:3;` are two
  // members at byte offset 0, not a union alias. For plain members the arithmetic is the old
  // byte cursor times 8 — behavior-identical for every bitfield-free layout.
  const lowBitOf = (m: DeclaredField): number => m.offset * 8 + (m.bitWidth !== undefined ? m.bitOffset! : 0);
  const members = (layout as DeclaredField[])
    .slice()
    .sort((a, b) => lowBitOf(a) - lowBitOf(b) || (a.bitWidth ?? -1) - (b.bitWidth ?? -1));
  const out: DeclaredField[] = [];
  let bitCursor = 0;
  for (const m of members) {
    const lo = lowBitOf(m);
    if (lo < bitCursor) {
      continue; // an overlapping (union) member: the first view is declared, the alias is not
    }
    if (m.bitWidth !== undefined) {
      // The synthesis lays bitfields as LE-GCC `u32 name : n`, whose allocation never straddles
      // a 32-bit unit — a field that would cannot be reproduced, so it is not declared (its bits
      // pad instead) and no access may name it. The cursor does NOT advance: the bits stay a hole.
      if (Math.floor(lo / 32) !== Math.floor((lo + m.bitWidth - 1) / 32)) {
        continue;
      }
      out.push(m);
      bitCursor = lo + m.bitWidth;
    } else {
      out.push(m);
      bitCursor = (m.offset + m.size) * 8;
    }
  }
  return out;
}

/**
 * THE one copy of "what C type does a map field declare", consumed by the declaration SYNTHESIS
 * (declare.ts, which prints it). A per-consumer copy would let the emitted declaration and the
 * type a consumer reasoned against disagree about what a member is.
 *
 * An ARRAY field declares its own element type and length — spelling `u16 x[8]` as `u8 x[16]`
 * keeps the layout but makes `x[i]` index BYTES, a wrong address. That spelling is used ONLY when
 * the element is a 1/2/4-byte BASE type, `elemSigned` being the witness that it is one: an array
 * of 2-byte STRUCTS declared `u16 x[n]` acquires an alignment the real member does not have, and
 * at an odd offset the compiler then inserts padding that shifts every later member. Such a
 * member declares the byte array of its own size instead, which has no alignment to acquire.
 *
 * A POINTER field types `void *` (an integer guess flips relational compares of the loaded value).
 * Everything else is the 1/2/4 scalar cell at its declared signedness — with the 4-byte
 * no-base-type case (an enum member) spelled s32 on the C89 enum=int rule — or a `u8 name[size]`
 * byte array when it is no scalar cell at all (a nested struct, an 8-byte member).
 */
export function symbolFieldType(f: DeclaredField): IrType {
  if (isArrayField(f)) {
    const scalarElem = f.elemSigned !== undefined && (f.elemSize === 1 || f.elemSize === 2 || f.elemSize === 4);
    return scalarElem && f.length !== undefined && f.elemSize! * f.length === f.size
      ? T.array(T.int(f.elemSize! * 8, f.elemSigned!), f.length)
      : T.array(T.u(8), f.size);
  }
  if (f.pointer && f.size === 4) {
    // The pointee width is byte-load-bearing: arithmetic on the loaded pointer scales by it, so
    // `p - 4` through the header's `u16 *` and through a guessed `void *` reach different bytes.
    // Only a base-type target is spelled; anything else keeps `void *`, which is address-identical
    // for any object pointer and never derefs.
    const scalarPointee = f.pointeeSize === 1 || f.pointeeSize === 2 || f.pointeeSize === 4;
    return T.ptr(scalarPointee ? T.int(f.pointeeSize! * 8, f.pointeeSigned ?? false) : T.void());
  }
  if (isBitfieldField(f)) {
    // The BASE type of the synthesized `u32 name : n` — the `: n` itself is the declaration
    // renderer's job (StructFieldDecl.bits). 32-bit base always: that is the LE-GCC unit model
    // declaredFields verified the layout against. A signless bitfield declares unsigned — the
    // extract recognizer refuses to NAME one anyway, so the choice only types padding.
    return T.int(32, f.signed ?? false);
  }
  if (isScalarCellSize(f.size)) {
    return scalarCellType(f.size, f.signed);
  }
  return T.array(T.u(8), f.size);
}
/** A 4-byte member/scalar with NO base-type signedness is the enum idiom — C89 says int. */
export const ENUM_IS_SIGNED = true;

/** Is this byte size one a base type can spell? */
export function isScalarCellSize(size: number | undefined): size is 1 | 2 | 4 {
  return size === 1 || size === 2 || size === 4;
}

/** THE DECLARED type of a 1/2/4-byte scalar cell — what `extern T gSym;` synthesis writes, and
 *  therefore what `&gSym` actually points to.
 *
 *  Extracted because this rule had drifted into a fourth copy. It is NOT `scalarTypeForAccess`,
 *  which answers a different question — the type an ACCESS of that width reads — and collapses
 *  every 4-byte access to `s32` whatever the signedness. Using that one to decide "does `&gSym`
 *  already have the destination's type" silently answered YES for a `u32` cell reaching an
 *  `s32 *`, and the incompatible-pointer assignment survived. Declaration side and access side are
 *  separate facts; this is the declaration one. */
export function scalarCellType(size: 1 | 2 | 4, signed: boolean | undefined): IrType {
  return T.int(size * 8, signed ?? (size === 4 ? ENUM_IS_SIGNED : false));
}

/**
 * THE gate on every spelling through a POINTER global's value: the members a `gPtr->member`
 * spelling may name, or null when nothing may be named through this pointee at all. Null unless
 * the pointee is named (synthesis has no tag to declare it under otherwise), sized (the struct
 * type is incomplete otherwise), and its layout is declarable ({@link declaredFields}) — the same
 * three conditions declare.ts needs to emit `struct Tag *gPtr;` rather than falling back to
 * `extern void *gPtr;`. Both must decline together: core naming a member of an undeclared pointee
 * is non-compiling C.
 */
export function pointeeFields(pointee: SymbolPointee | undefined): DeclaredField[] | null {
  if (pointee?.structName === undefined || pointee.size === undefined) {
    return null;
  }
  return declaredFields(pointee.layout);
}

/** Kind-aware two-probe lookup for a pool-loaded 32-bit value. Exact match first (any kind);
 *  on miss, `value & ~1` — accepted ONLY when the hit is code, because ELF function addresses
 *  are stored with the Thumb bit cleared while a Thumb code pointer in a pool is odd. An exact
 *  odd-DATA hit therefore wins over a masked code hit (odd data addresses are real). */
export function lookupSymbol(map: SymbolMap, value: number): SymbolInfo | null {
  const exact = map.get(value)?.[0];
  if (exact) {
    return exact;
  }
  if ((value & 1) === 1) {
    const masked = map.get(value & ~1)?.[0];
    if (masked?.kind === 'code') {
      return masked;
    }
  }
  return null;
}

/** Interior attribution: the data symbol whose `[address, address+size)` range contains
 *  `value` strictly inside (offset > 0 — exact bases go through `lookupSymbol`). Only
 *  complete-typed globals carry a size, so unsized arrays never attribute. */
export function lookupInterior(map: SymbolMap, value: number): { info: SymbolInfo; offset: number } | null {
  for (const [addr, infos] of map) {
    const info = infos[0];
    if (info.kind !== 'data' || info.size === undefined) {
      continue;
    }
    if (value > addr && value < addr + info.size) {
      return { info, offset: value - addr };
    }
  }
  return null;
}

/** The `SymbolInfo` keys a project's DWARF can only carry because the symbol's DEFINITION was
 *  compiled from C. Everything else in the map survives a function that is still `INCLUDE_ASM`:
 *  its `.symtab` entry exists (the asm defines the label), and its globals are typed by the OTHER
 *  translation units that declare them. Listed here, once, so {@link asIfUndecompiled} and any
 *  later definition-derived fact (a signature, a local's type, a register location) stay in sync. */
const DEFINITION_DERIVED_KEYS = ['declared', 'signature'] as const satisfies readonly (keyof SymbolInfo)[];

/** The map a user actually has while decompiling `fn` — i.e. with `fn` still an `INCLUDE_ASM`
 *  stub in their project.
 *
 *  Every benchmark row is a function someone ALREADY decompiled, so the project ELF carries
 *  facts about it that exist only *because* the work is done. Scoring against those facts
 *  measures the harness, not the tool: it flatters any feature that reads them and transfers
 *  nothing to the user, who is decompiling the one function whose definition is absent. This
 *  rebuilds the map as that user's ELF would give it.
 *
 *  What it strips is the row's own DEFINITION-derived facts ({@link DEFINITION_DERIVED_KEYS}),
 *  NOT its name: an `INCLUDE_ASM` function still has a `.symtab` entry, so dropping the symbol
 *  outright would understate what a user has and make the map look worse than it is. Callee
 *  signatures, globals and struct layouts all stay — those are the transferable facts, and they
 *  are the point.
 *
 *  Address identity is preserved (aliases keep their order, `[0]` stays canonical) so a filtered
 *  map is a drop-in for the unfiltered one. */
export function asIfUndecompiled(map: SymbolMap, fn: string): SymbolMap {
  const leaks = (info: SymbolInfo): boolean =>
    info.kind === 'code' && info.name === fn && DEFINITION_DERIVED_KEYS.some((k) => info[k] !== undefined);
  // Return the SAME map when the row's own symbol carries no definition-derived fact — the common
  // case today, and it keeps the filter free to apply unconditionally on every row of a run.
  let any = false;
  for (const infos of map.values()) {
    if (infos.some(leaks)) {
      any = true;
      break;
    }
  }
  if (!any) {
    return map;
  }
  const out: SymbolMap = new Map();
  for (const [addr, infos] of map) {
    out.set(
      addr,
      infos.map((info) => {
        if (!leaks(info)) {
          return info;
        }
        const stripped = { ...info };
        for (const k of DEFINITION_DERIVED_KEYS) {
          delete stripped[k];
        }
        return stripped;
      }),
    );
  }
  return out;
}

/** Every fact but the name, canonically ordered — the equality a name collision is judged by. */
function factsOf(info: SymbolInfo): string {
  return JSON.stringify(
    Object.keys(info)
      .filter((k) => k !== 'name')
      .sort()
      .map((k) => [k, info[k as keyof SymbolInfo]]),
  );
}

/** NAME-keyed view over every symbol in the map — what the structurer consumes (it sees gaddr
 *  symbol names, not addresses). Aliases at one address each appear under their own name.
 *
 *  One name can sit at SEVERAL addresses in a real project (file-static `sMenu` in two
 *  translation units, a `.symtab` full of same-named locals). Where those entries agree on their
 *  facts the collision is harmless — `InitSprite` at 16 sa3 addresses is 16 identical name-only
 *  entries. Where they DISAGREE, silently keeping whichever the map iterated last would apply one
 *  address's declaration shape to another address's global: the same layout, the wrong struct.
 *
 *  So a disagreeing name degrades to NAME-ONLY rather than picking. The name survives (dropping it
 *  outright would leave the reference undeclarable in the self-declared scoring world, turning a
 *  spelling question into a compile failure); only the shape facts, which are what could be wrong,
 *  are withheld — the honest cast spellings take over. `kind` is kept: it never disagrees in the
 *  vendored maps, and it is settled address-side by `lookupSymbol` before a name is ever used. */
export function symbolsByName(map: SymbolMap): Map<string, SymbolInfo> {
  const byName = new Map<string, SymbolInfo>();
  const conflicted = new Set<string>();
  for (const infos of map.values()) {
    for (const info of infos) {
      const prev = byName.get(info.name);
      if (prev === undefined) {
        byName.set(info.name, info);
      } else if (factsOf(prev) !== factsOf(info)) {
        conflicted.add(info.name);
      }
    }
  }
  for (const name of conflicted) {
    byName.set(name, { name, kind: byName.get(name)!.kind });
  }
  return byName;
}

/** Serialize a SymbolMap to a byte-stable JSON object (hex keys, sorted; array order kept —
 *  `[0]` is the canonical pick). The benchmark vendors this; the ELF itself never leaves the
 *  project checkout. */
export function symbolMapToJson(map: SymbolMap): Record<string, SymbolInfo[]> {
  const out: Record<string, SymbolInfo[]> = {};
  for (const addr of [...map.keys()].sort((a, b) => a - b)) {
    out[`0x${addr.toString(16).padStart(8, '0')}`] = map.get(addr)!;
  }
  return out;
}

export function symbolMapFromJson(obj: Record<string, SymbolInfo[]>): SymbolMap {
  const map: SymbolMap = new Map();
  for (const [k, infos] of Object.entries(obj)) {
    map.set(Number.parseInt(k, 16), infos);
  }
  return map;
}
