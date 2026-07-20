// asmlift — STRUCT RECOVERY (L1 → typed struct pointers).
//
// THE PROBLEM. A struct-field read and an array-element read are the SAME load: `s->c` and
// `arr[2]` both lower to `lw v0, 8(a0)` — byte-identical AND representation-ambiguous, so the
// objdiff score cannot referee between them; there is no supplied layout yet (DWARF is future
// work). What DOES distinguish them is the ACCESS-PATTERN SHAPE on a given base: a homogeneous
// array produces uniform-width, uniform-stride accesses; a struct produces heterogeneous ones
// (mixed widths, or an offset no single element size can index).
//
// THE DISCRIMINATOR (evidence, not guess). A base's accesses form a valid homogeneous array iff
// there is a single width `w` with EVERY access of width `w` AND EVERY offset a multiple of `w`.
// If so → leave it as the array `base[idx]` (structure.ts). Otherwise → it is a struct: recover
// one field per distinct offset (type from the access width/signedness) and type the base
// `struct S *`, so structuring emits `base->field_<off>`.
//
//   base @ {off0 w1, off4 w4}  -> struct { u8 field_0; s32 field_4; }   (mixed width)
//   base @ {off2 w2, off4 w4}  -> struct { u8 _pad0[2]; s16 field_2; s32 field_4; }  (leading/
//                                gap fields the compiler had but this function never touched)
//   base @ {off2 w4}           -> LOUD decline (a 4-byte field at offset 2 is not 4-aligned —
//                                natural C alignment cannot place it there)
//   base @ {off0 w4, off4 w4}  -> array  (uniform stride — untouched)
//   base @ {off8 w4}           -> array  (single aligned access — no struct evidence)
//   base @ aload(index)        -> array  (variable index — untouched)
//
// This recovery is BYTE-NEUTRAL — `->field_N` and `[idx]` compile identically, so it is a
// representation upgrade driven by access evidence, not a scored lever. GAPS between accessed
// offsets (unaccessed leading/interior fields) are filled with `u8[N]` PAD fields so the declared
// struct reproduces the observed offsets byte-for-byte and is self-describing (the same
// discipline raise/struct-arrays.ts withPadding uses). Each accessed field must still be
// naturally aligned to ITS OWN width (`off % width === 0`) — a genuinely packed layout (a field
// at an offset natural C alignment could not place it at) is rejected LOUD, as is an
// overlap/union.
import { Fn, Op, Value } from '../ir/core';
import { IrType, StructField, T, scalarTypeForAccess } from '../ir/types';
import type { StructType } from '../l3/ast';
import { RaiseUnsupportedError } from './errors';

// A single observed access to a base: byte offset, access width (bytes), signedness (loads only).
interface Access {
  off: number;
  width: number;
  signed: boolean;
}

// Natural C size/alignment of a recovered scalar field type (all fields here are int/ptr ≤ 4 bytes,
// where size === align). Used to check that a plain struct decl reproduces the observed offsets.
//
// NOTE the deliberate divergence from raise/struct-arrays.ts withPadding, which looks similar but
// is a DIFFERENT operation: this pass is ALIGNMENT-AWARE (no explicit pad when C's own inter-field
// padding already lands the field) and carries NO trailing pad / struct `size` (a recovered struct
// here is only ever a `struct S *` pointee accessed by named field — never an array element or a
// by-value param, so sizeof is never taken). If the two are ever unified, PARAMETERIZE those axes
// — a naive merge would break the natural-alignment golden or silently mislay a struct that later
// becomes an element / ABI value.
const sizeAlign = (width: number): number => width;
const roundUp = (n: number, a: number) => Math.ceil(n / a) * a;

/** Does this access set describe a homogeneous array (uniform width, all offsets multiples of it)? */
function isArray(accesses: Access[]): boolean {
  const w = accesses[0].width;
  return accesses.every((a) => a.width === w && a.off % w === 0);
}

/** Build the struct type for a base whose accesses are NOT array-shaped. Unaccessed leading/
 *  interior gaps are FILLED with `u8[N]` pads so the declared struct reproduces the observed
 *  offsets. Throws LOUD only on a layout natural C alignment cannot reproduce: two accesses
 *  overlapping in bytes (a union — same offset with differing widths, OR distinct offsets whose
 *  ranges collide), or a field at an offset its own natural alignment could not place it at (a
 *  PACKED layout). */
function buildStruct(name: string, accesses: Access[]): IrType {
  // One field per distinct offset; a load's signedness wins over a store's (more information).
  const byOff = new Map<number, Access>();
  for (const a of accesses) {
    const prev = byOff.get(a.off);
    if (!prev) {
      byOff.set(a.off, a);
      continue;
    }
    if (prev.width !== a.width) {
      throw new RaiseUnsupportedError(
        `cannot recover struct '${name}': overlapping fields at offset ${a.off} (widths ${prev.width} and ${a.width}) — unions not modelled`,
      );
    }
    if (a.signed && !prev.signed) {
      byOff.set(a.off, a);
    } // prefer the signed (load-derived) view
  }
  const dataFields: StructField[] = [...byOff.values()]
    .sort((x, y) => x.off - y.off)
    .map((a) => ({ off: a.off, type: scalarTypeForAccess(a.width, a.signed), name: `field_${a.off}` }));
  // Each accessed field must be NATURALLY ALIGNED to its own width — a field the compiler would
  // have placed at a different offset under natural C alignment is a packed layout this recovery
  // cannot reproduce, so it is rejected LOUD (never a silently-wrong struct). The GAP before a
  // field (an unaccessed leading/interior member) is legal: it is filled with a `u8[N]` pad below.
  for (const f of dataFields) {
    const sz = accessWidth(f);
    if (f.off % sizeAlign(sz) !== 0) {
      throw new RaiseUnsupportedError(
        `cannot recover struct '${name}': field at offset ${f.off} (width ${sz}) is not naturally aligned — packed layout not modelled`,
      );
    }
  }
  // Place fields under natural C alignment, inserting an explicit `u8[N]` PAD only for a gap the
  // alignment itself does NOT already cover (the same self-describing discipline as
  // raise/struct-arrays.ts withPadding). For each field, `aligned` = where natural C alignment
  // would put it after the running cursor:
  //   • aligned === off  — natural padding lands it exactly (`{s8@0, s32@4}`): no explicit pad,
  //     C's own inter-field alignment reproduces the layout.
  //   • aligned  <  off  — a leading/interior gap alignment can't fill (`{s16@2, s32@4}`, byte 0–1
  //     never read): insert a `u8[off - cursor]` pad so the field lands exactly.
  //   • aligned  >  off  — the field's offset precedes where alignment would force it: it OVERLAPS
  //     the prior field (`{s32@0, s16@2}` — a union view the same-offset byOff check cannot see):
  //     reject LOUD, never a silently-mislaid field.
  const fields: StructField[] = [];
  let cursor = 0;
  let pad = 0;
  for (const f of dataFields) {
    const aligned = roundUp(cursor, sizeAlign(accessWidth(f)));
    if (aligned > f.off) {
      throw new RaiseUnsupportedError(
        `cannot recover struct '${name}': field at offset ${f.off} overlaps the prior field (aligned to ${aligned}) — unions not modelled`,
      );
    }
    if (aligned < f.off) {
      fields.push({ off: cursor, type: T.array(T.u(8), f.off - cursor), name: `_pad${pad++}` });
    }
    fields.push(f);
    cursor = f.off + accessWidth(f);
  }
  return T.struct(name, fields);
}

// Width in bytes of a recovered field's type (int width/8; pointer is word-sized 4).
function accessWidth(f: StructField): number {
  return f.type.kind === 'int' ? f.type.width / 8 : 4;
}

/** Recover struct-pointer types from access-pattern evidence. Runs after array legalization and
 *  before type recovery, so `recoverTypes` sees the base already typed and does not flatten it to a
 *  plain pointer. Returns the number of bases recovered as structs. */
export function recognizeStructs(fn: Fn): number {
  // Collect each base's constant-offset accesses, and the set of bases that are ALSO array bases
  // (used by a variable-index aload/astore) — those are arrays, excluded from struct recovery.
  const accessesOf = new Map<Value, Access[]>();
  const arrayBases = new Set<Value>();
  const order: Value[] = []; // first-appearance order → deterministic struct names
  const note = (base: Value, a: Access) => {
    let list = accessesOf.get(base);
    if (!list) {
      list = [];
      accessesOf.set(base, list);
      order.push(base);
    }
    list.push(a);
  };
  for (const b of fn.blocks) {
    for (const op of b.ops as Op[]) {
      switch (op.opcode) {
        case 'load':
          note(op.operands[0], {
            off: op.attrs.off as number,
            width: op.attrs.width as number,
            signed: op.attrs.signed as boolean,
          });
          break;
        case 'store':
          note(op.operands[0], {
            off: op.attrs.off as number,
            width: op.attrs.width as number,
            signed: (op.attrs.width as number) === 4,
          });
          break;
        case 'aload':
        case 'astore':
          arrayBases.add(op.operands[0]);
          break;
      }
    }
  }

  let count = 0;
  for (const base of order) {
    if (arrayBases.has(base)) {
      continue;
    } // a variable-index array base — leave it
    if (base.type.kind !== 'unknown') {
      continue;
    } // already typed (not a bare recovery target)
    const accesses = accessesOf.get(base)!;
    if (isArray(accesses)) {
      continue;
    } // uniform stride / single aligned access → array
    base.type = T.ptr(buildStruct(`Struct${count}`, accesses));
    count++;
  }
  return count;
}

/** The distinct struct types this function references (unwrapping struct pointers on every value),
 *  deduped by name and sorted, for the backend to declare above the function. */
export function collectStructs(fn: Fn): StructType[] {
  const seen = new Map<string, StructType>();
  const consider = (t: IrType) => {
    const s = t.kind === 'ptr' && t.to.kind === 'struct' ? t.to : t.kind === 'struct' ? t : null;
    if (s && s.kind === 'struct' && !seen.has(s.name)) {
      seen.set(s.name, { name: s.name, fields: s.fields, size: s.size });
    }
  };
  for (const b of fn.blocks) {
    for (const p of b.params) {
      consider(p.type);
    }
    for (const op of b.ops as Op[]) {
      for (const v of op.operands) {
        consider(v.type);
      }
      for (const v of op.results) {
        consider(v.type);
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
