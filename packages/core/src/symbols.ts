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
  /** the field's resolved type is a pointer — synthesis must spell it `void *`, or relational
   *  compares of the loaded value flip signedness (s32 `blt` vs the pointer truth's `bcc`) */
  pointer?: boolean;
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

export interface SymbolInfo {
  name: string;
  kind: 'code' | 'data';
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
}

/** address → symbols at that address; `[0]` is the provider's canonical pick. */
export type SymbolMap = Map<number, SymbolInfo[]>;

/** THE one test for "is this field an array". The PRESENCE of `elemSize` is what marks one (see
 *  the field doc) — `length` is a separate fact that a flexible array member legitimately lacks,
 *  so testing it instead silently reclassifies such a member as a scalar cell. */
export function isArrayField(f: SymbolStructField): boolean {
  return f.elemSize !== undefined;
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
  return (
    typeof m.name === 'string' &&
    typeof m.offset === 'number' &&
    Number.isFinite(m.offset) &&
    (m.size === null || (typeof m.size === 'number' && Number.isFinite(m.size) && m.size >= 0))
  );
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
  const members = [...layout].sort((a, b) => (a as SymbolStructField).offset - (b as SymbolStructField).offset);
  const out: DeclaredField[] = [];
  let cursor = 0;
  for (const m of members) {
    if (!wellFormedField(m)) {
      return null;
    }
    if (m.size === null) {
      return null;
    }
    if (isArrayField(m) && m.length !== undefined && m.elemSize! * m.length !== m.size) {
      return null;
    }
    if (m.offset < cursor) {
      continue; // an overlapping (union) member: the first view is declared, the alias is not
    }
    out.push(m as DeclaredField);
    cursor = m.offset + m.size;
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
    return T.ptr(T.void());
  }
  if (f.size === 1 || f.size === 2 || f.size === 4) {
    return T.int(f.size * 8, f.signed ?? (f.size === 4 ? ENUM_IS_SIGNED : false));
  }
  return T.array(T.u(8), f.size);
}
/** A 4-byte member/scalar with NO base-type signedness is the enum idiom — C89 says int. */
export const ENUM_IS_SIGNED = true;

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

/** NAME-keyed view over every symbol in the map — what the structurer consumes (it sees gaddr
 *  symbol names, not addresses). Aliases at one address each appear under their own name. */
export function symbolsByName(map: SymbolMap): Map<string, SymbolInfo> {
  const byName = new Map<string, SymbolInfo>();
  for (const infos of map.values()) {
    for (const info of infos) {
      byName.set(info.name, info);
    }
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
