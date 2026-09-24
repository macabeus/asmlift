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
//   base @ {off0 w4, off2 w2}  -> struct { union { s32 word; s16 half[2]; } field_0; }  (the same
//                                bytes at two widths — `buildUnionStruct`)
//   base @ {off0 w4, off4 w4}  -> array  (uniform stride — untouched)
//   base @ {off8 w4}           -> array  (single aligned access — no struct evidence)
//   base @ aload(index)        -> array  (variable index — untouched)
//
// This recovery is USUALLY BYTE-NEUTRAL — `->field_N` and `[idx]` mostly compile identically, so it
// is a representation upgrade driven by access evidence rather than a scored variation. TWO
// MEASUREMENTS SAY "USUALLY" IS THE RIGHT WORD, and both were made on agbcc against a real target
// object, each pair differing in ONE token:
//   • THE SPELLING. `synthetic:dmanest`'s reference compiles from `((struct Elem0 *)K)[a1].field_4`
//     to a byte-exact match and from `((s32 *)((a1 << 3) + K))[1]` to a 2-point diff — a
//     COMPONENT_REF keeps the offset in the load displacement, an index folds it into the pool
//     literal. The row's own dataset entry carries the reproduction.
//   • THE FIELD TYPE, which this file assigns from the ACCESS WIDTH alone. A word field declared
//     `void *` rather than `s32` changes agbcc's alias set and lets a loop-invariant load leave the
//     loop: `synthetic:dmaptrsrc` matches with the pointer declaration and diffs by 35 without it
//     (its own fan: `/vol-store/unreduce/ptr-field` 0, `/vol-store/unreduce` 35).
//     That is what `l3/ptrfield.ts` offers as a differ-ranked variation.
// So the neutrality claim is CONDITIONAL, and nothing here says on what. Until it does, read it as
// "no candidate is enumerated for this question", not as "the differ could not referee one" — the
// second reading is the one both measurements above falsify. GAPS between accessed
// offsets (unaccessed leading/interior fields) are filled with `u8[N]` PAD fields so the declared
// struct reproduces the observed offsets byte-for-byte and is self-describing (the same
// discipline raise/struct-arrays.ts withPadding uses). Each accessed field must still be
// naturally aligned to ITS OWN width (`off % width === 0`) — a genuinely packed layout (a field
// at an offset natural C alignment could not place it at) is rejected LOUD. An overlap is a union
// member on a base whose layout only this function's accesses describe, and no struct at all on
// one whose address is declared elsewhere (`recognizeStructs`).
import { constAddressOf, globalCellOf } from '../ir/alias';
import { Fn, Op, Value, defOpMap } from '../ir/core';
import { nextStructIndex } from '../ir/struct-names';
import { IrType, StructField, T, scalarTypeForAccess } from '../ir/types';
import type { StructType } from '../l3/ast';
import { RaiseUnsupportedError, StructOverlapError } from './errors';

/** A single observed constant-offset access to a base: the op itself and its program point, its
 *  byte offset, its access width (bytes), and the signedness a recovered field would take from it.
 *
 *  SHARED WITH raise/truncload.ts, which folds a narrow read into a cast of a wider one before this
 *  pass runs. The two ask the same question of a function — "what does this base's access set look
 *  like" — and a second copy of the walk would let them come to disagree about the answer while
 *  each looked right on its own.
 *
 *  SIGNEDNESS ON THE STORE HALF IS A POLICY, not a reading: a store carries none, and a word store
 *  makes an `s32` field where a narrower one makes an unsigned one. `buildStruct` then prefers a
 *  LOAD's own signedness at the same offset, which is the reading. raise/truncload.ts never sees
 *  this field — its `covering-store` rule refuses a store cover before the signedness is used. */
export interface Access {
  op: Op;
  /** index into `fn.blocks`, for the dominance question raise/truncload.ts asks. */
  block: number;
  /** index into that block's `ops`, as they stood when this was collected. */
  at: number;
  off: number;
  width: number;
  signed: boolean;
  isLoad: boolean;
}

/** What one walk of a function yields about its constant-offset memory accesses. */
export interface ConstOffsetAccesses {
  /** every base's constant-offset accesses, in program order. */
  accessesOf: Map<Value, Access[]>;
  /** the bases, in FIRST-APPEARANCE order → deterministic struct names. */
  order: Value[];
  /** bases a VARIABLE-index access also reaches (`aload`/`astore`) — arrays, never struct-recovered. */
  arrayBases: Set<Value>;
}

/** Collect every base's constant-offset accesses, plus the bases a variable-index access reaches.
 *  ONE walk, two consumers: `recognizeStructs` below and raise/truncload.ts. */
export function constOffsetAccesses(fn: Fn): ConstOffsetAccesses {
  const accessesOf = new Map<Value, Access[]>();
  const arrayBases = new Set<Value>();
  const order: Value[] = [];
  const note = (base: Value, a: Access) => {
    let list = accessesOf.get(base);
    if (!list) {
      list = [];
      accessesOf.set(base, list);
      order.push(base);
    }
    list.push(a);
  };
  fn.blocks.forEach((b, block) => {
    (b.ops as Op[]).forEach((op, at) => {
      switch (op.opcode) {
        case 'load':
          note(op.operands[0], {
            op,
            block,
            at,
            off: op.attrs.off as number,
            width: op.attrs.width as number,
            signed: op.attrs.signed as boolean,
            isLoad: true,
          });
          break;
        case 'store':
          note(op.operands[0], {
            op,
            block,
            at,
            off: op.attrs.off as number,
            width: op.attrs.width as number,
            signed: (op.attrs.width as number) === 4,
            isLoad: false,
          });
          break;
        case 'aload':
        case 'astore':
          arrayBases.add(op.operands[0]);
          break;
      }
    });
  });
  return { accessesOf, order, arrayBases };
}

// Natural C size/alignment of a recovered scalar field type (all fields here are int/ptr ≤ 4 bytes,
// where size === align). Used to check that a plain struct decl reproduces the observed offsets.
//
// NOTE the deliberate divergence from raise/struct-arrays.ts withPadding, which looks similar but
// is a DIFFERENT operation: this pass is ALIGNMENT-AWARE (no explicit pad when C's own inter-field
// padding already lands the field) and carries NO trailing pad / struct `size` (a recovered struct
// here is only ever a `struct S *` pointee accessed by named field — never an array element or a
// by-value param, so sizeof is never taken). If the two are ever unified, PARAMETERIZE those dimensions
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
 *  offsets. Throws LOUD only on a layout no plain struct reproduces: two accesses overlapping in
 *  bytes (same offset with differing widths, OR distinct offsets whose ranges collide), or a field
 *  at an offset its own natural alignment could not place it at (a PACKED layout).
 *
 *  ONE CLASS OF OVERLAP NEVER REACHES HERE: a narrow LOAD covering the low-order end of a wider
 *  access that ran before it on every path is a cast of that access rather than a second field, and
 *  raise/truncload.ts folds it into one before this pass runs. What is left is what the asm does
 *  not settle — a narrow STORE, a read above the low-order end, a cell at a constant address, and a
 *  cover on a path the narrow read does not run — and every one of them throws here.
 *
 *  A THROW IS NOT THE FUNCTION'S VERDICT, AND WHICH THROW IT IS DECIDES THAT. Three throw sites
 *  below reject a layout and they fall into two CLASSES, which is the split a caller reads:
 *    • `StructOverlapError` — two accesses whose byte ranges collide. TWO of the three sites raise
 *      it, and they carry the same "unions not modelled" text at different offsets: a second access
 *      at an offset already taken with a different width, and one whose range straddles the field
 *      before it (the `aligned > f.off` arm, which is the only one that can see `{s32@0, s16@2}`).
 *      Each access alone is spellable at its own offset and width, so a base whose ADDRESS is
 *      declared outside this function's access set can keep its untyped spelling and lift
 *      (`recognizeStructs` below). There is no struct to synthesize, and nothing is lost by not
 *      synthesizing one. Any other base is declared with a union member (`buildUnionStruct`).
 *    • `RaiseUnsupportedError` — a field at an offset its own natural alignment could not place it
 *      at. This one has NO per-access spelling downstream: an access at `off` under a wider access's
 *      width folds to the element index `off / width` (structure/structure.ts), which for a
 *      misaligned pair is a FRACTION and not C. It declines whatever the base is. */
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
      throw new StructOverlapError(
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
    refusePacked(name, f.off, fieldSize(f.type));
  }
  return placeFields(name, dataFields);
}

function refusePacked(name: string, off: number, size: number): void {
  if (off % sizeAlign(size) !== 0) {
    throw new RaiseUnsupportedError(
      `cannot recover struct '${name}': field at offset ${off} (width ${size}) is not naturally aligned — packed layout not modelled`,
    );
  }
}

/** Seat `dataFields` (sorted by offset) under natural C alignment, inserting an explicit `u8[N]`
 *  PAD only for a gap the alignment itself does NOT already cover (the same self-describing
 *  discipline as raise/struct-arrays.ts withPadding). For each field, `aligned` = where natural C
 *  alignment would put it after the running cursor:
 *    • aligned === off  — natural padding lands it exactly (`{s8@0, s32@4}`): no explicit pad,
 *      C's own inter-field alignment reproduces the layout.
 *    • aligned  <  off  — a leading/interior gap alignment can't fill (`{s16@2, s32@4}`, byte 0–1
 *      never read): insert a `u8[off - cursor]` pad so the field lands exactly.
 *    • aligned  >  off  — the field's offset precedes where alignment would force it: it OVERLAPS
 *      the prior field (`{s32@0, s16@2}` — a union view the same-offset byOff check cannot see):
 *      reject LOUD, never a silently-mislaid field. */
function placeFields(name: string, dataFields: StructField[]): IrType {
  const fields: StructField[] = [];
  let cursor = 0;
  let pad = 0;
  for (const f of dataFields) {
    const aligned = roundUp(cursor, sizeAlign(fieldSize(f.type)));
    if (aligned > f.off) {
      throw new StructOverlapError(
        `cannot recover struct '${name}': field at offset ${f.off} overlaps the prior field (aligned to ${aligned}) — unions not modelled`,
      );
    }
    if (aligned < f.off) {
      fields.push({ off: cursor, type: T.array(T.u(8), f.off - cursor), name: `_pad${pad++}` });
    }
    fields.push(f);
    cursor = f.off + fieldSize(f.type);
  }
  return T.struct(name, fields);
}

/** The member name of each view a union holds, by access width. A width with no entry has no view
 *  (the deref contract admits no other scalar width either), and its overlap still declines. */
const VIEW_NAMES: Readonly<Record<number, string>> = { 1: 'byte', 2: 'half', 4: 'word' };

/** The struct for a base whose accesses OVERLAP — `buildStruct` refused it with
 *  `StructOverlapError` — with each overlap declared as a UNION member: the same bytes read or
 *  written at more than one width are views of one cell, and a union is the C that says so.
 *
 *  NOT A CAST, and the compiler is why. `((u16 *)p)[k]` beside `*p` spells the same two accesses,
 *  but a cast-punned access is outside C's aliasing rules and agbcc (-O2) applies them: a narrow
 *  read, a word store and the same narrow read again compiles, through casts, to ONE `ldrh` whose
 *  value is reused, where the union spelling reloads after the `str` — as the asm the union was
 *  compiled from does (`synthetic:ureread`). gcc2.7.2kmc, ido7.1 and mwcc_242_81 reload for both.
 *  The direction is one-way: a union access aliases every view of its cell, so the union spelling
 *  keeps every access the asm performed and the cast cannot be the better candidate — which is why
 *  this is the default and not a variation.
 *
 *  THE LAYOUT. Every access must be naturally aligned (a packed one declines, as in
 *  `buildStruct`), and access widths are powers of two, so an aligned access never straddles the
 *  boundary of a wider aligned one: two accesses overlap only when the wider CONTAINS the narrower.
 *  A cell is therefore one widest access and every access inside it, and it gets a VIEW per width —
 *  `word`, `half`, `byte` — and, for a narrow width LOADED with both extensions, per extension —
 *  `uhalf` and `shalf` — because a view's type IS its extension and one view for both reads one of
 *  them wrong. A store carries no extension and writes through its width's only view, or the
 *  unsigned one where there are two. A view that holds
 *  one element at the cell's start is a scalar; any other is an array reaching the furthest
 *  element accessed (`u16 half[2]` for the halfword at +2). A cell with ONE view is a plain field;
 *  any other is a member `field_<off>` holding a union of its views — including a single-width cell
 *  loaded both ways. KNOWN GAP: on a base with no overlap anywhere, `buildStruct` never hands over,
 *  and that same cell there is one field typed by its signed load (as on main before this pass had
 *  unions), so its unsigned read is spelled sign-extended.
 *
 *  THE COMPILER DECIDES THE UNION'S SIZE, not its widest view. `aggregateBoundary` is the size it
 *  aligns and rounds every struct and union to (target.ts `compilerBehaviors.aggregateBoundary`):
 *  agbcc makes `union { u16 h; u8 b; }` four bytes, four-aligned, where the other compilers make
 *  it two. A union that boundary would move — seated off it, or with the next field inside its
 *  rounded size — declines rather than mislaying every access at or after it. An UNMEASURED
 *  compiler (undefined) declines every union, since no boundary is safe to assume: one too small
 *  mislays the fields after the union on agbcc, one too large drops the pad in front of them
 *  everywhere else.
 *
 *  A cell at a width no view is named for declines; the frontends emit none. */
function buildUnionStruct(structName: string, accesses: Access[], aggregateBoundary: number | undefined): IrType {
  for (const a of accesses) {
    refusePacked(structName, a.off, a.width);
  }
  const clusters: Access[][] = [];
  for (const a of [...accesses].sort((x, y) => x.off - y.off || y.width - x.width)) {
    const cur = clusters.at(-1);
    if (cur !== undefined && a.off < cur[0].off + cur[0].width) {
      cur.push(a);
    } else {
      clusters.push([a]);
    }
  }
  const dataFields = clusters.map((c): StructField => {
    const start = c[0].off;
    const members = [...new Set(c.map((a) => a.width))].flatMap((width): StructField[] => {
      const group = c.filter((a) => a.width === width);
      const name = VIEW_NAMES[width];
      if (name === undefined) {
        throw new RaiseUnsupportedError(
          `cannot recover struct '${structName}': no union view for a ${width}-byte access at offset ${group[0].off}`,
        );
      }
      // The extensions this width is LOADED with, unsigned first; a word has one type whatever its
      // loads say, and a width only stored gets the unsigned view.
      const loaded = new Set(group.filter((a) => a.isLoad).map((a) => a.signed));
      const signs = width === 4 ? [true] : [false, true].filter((sg) => loaded.has(sg));
      const views = signs.length === 0 ? [false] : signs;
      const viewOf = (a: Access): boolean => (views.length === 1 ? views[0] : a.isLoad ? a.signed : false);
      return views.map((signed): StructField => {
        const reads = group.filter((a) => viewOf(a) === signed);
        const count = Math.max(...reads.map((a) => a.off - start)) / width + 1;
        const elem = scalarTypeForAccess(width, signed);
        const viewName = views.length > 1 ? `${signed ? 's' : 'u'}${name}` : name;
        return { off: 0, type: count === 1 ? elem : T.array(elem, count), name: viewName };
      });
    });
    if (members.length === 1) {
      return { off: start, type: members[0].type, name: `field_${start}` };
    }
    if (aggregateBoundary === undefined) {
      throw new RaiseUnsupportedError(
        `cannot recover struct '${structName}': the union at offset ${start} needs this compiler's aggregate boundary, which is unmeasured`,
      );
    }
    return { off: start, type: T.union(members, aggregateBoundary), name: `field_${start}` };
  });
  dataFields.forEach((f, i) => {
    if (f.type.kind !== 'union') {
      return;
    }
    const next = dataFields[i + 1];
    if (f.off % f.type.size !== 0 || (next !== undefined && next.off < f.off + f.type.size)) {
      throw new RaiseUnsupportedError(
        `cannot recover struct '${structName}': the union at offset ${f.off} does not fit this compiler's ${aggregateBoundary}-byte aggregate boundary`,
      );
    }
  });
  return placeFields(structName, dataFields);
}

/** Size in bytes of a recovered field's type (int width/8; pointer is word-sized 4; a union the
 *  size its compiler gives it). */
function fieldSize(t: IrType): number {
  switch (t.kind) {
    case 'int':
      return t.width / 8;
    case 'array':
      return t.count * fieldSize(t.elem);
    case 'union':
      return t.size;
    default:
      return 4;
  }
}

/** Recover struct-pointer types from access-pattern evidence. Runs after array legalization and
 *  before type recovery, so `recoverTypes` sees the base already typed and does not flatten it to a
 *  plain pointer. Returns the number of bases recovered as structs. `aggregateBoundary` is the
 *  compiler's struct/union size boundary, undefined where nobody measured it (`buildUnionStruct`). */
export function recognizeStructs(fn: Fn, aggregateBoundary: number | undefined): number {
  const { accessesOf, order, arrayBases } = constOffsetAccesses(fn);

  // Does this base's address have a source of truth OUTSIDE this function's access set? Consulted
  // only when synthesis refuses an OVERLAP: see the caller below. Two kinds qualify, and both are
  // read with the helpers raise/truncload.ts asks the same question with — one concept, one
  // reading, and `globalCellOf` is the whole of that reading: it answers for `&gSym + K` as well as
  // for the bare `&gSym`, and an interior address is its own base here (`constOffsetAccesses` keys
  // on the operand Value), so a narrower opcode test would decline the shape `fixed-cell` admits.
  const defs = defOpMap(fn);
  const addressDeclaredElsewhere = (base: Value): boolean =>
    globalCellOf(defs, base, 0) !== null || constAddressOf(defs, base, 0) !== null;

  // The NAME counter is seeded from the names already in the graph, not from this pass's own
  // success count: raise/memberarrays.ts runs first and mints `Struct<N>` types of its own, and two
  // different layouts under one name would leave `collectStructs` declaring only one of them.
  let name = firstFreeStructIndex(fn);
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
    try {
      base.type = T.ptr(buildStruct(`Struct${name}`, accesses));
    } catch (e) {
      // A base whose ADDRESS is already declared somewhere other than this function's access set is
      // not a struct this pass has to synthesize, so failing to synthesize one for it is not a
      // reason to decline the function — PROVIDED the refusal is the OVERLAP one (its own class,
      // never a substring of the message), whose residue is per-access spellings that stand on their
      // own. Two kinds of base qualify:
      //   • a NAMED global (`globalCellOf`) — its declaration belongs to the project's own headers,
      //     and its constant-offset accesses render at L3 through the symbol context (member
      //     spelling when the map knows the layout, the honest cast spelling when it does not). The
      //     inhabitant is agbcc FUSING two adjacent u8 compares into one ldrh — `s.level == 8 &&
      //     s.world == 6` reads offset 12 at widths 1 AND 2, which is not a union, just two
      //     spellings of declared bytes.
      //   • a LITERAL ADDRESS (`constAddressOf`) — a cell the hardware placed, which L3 renders as
      //     a cast at each access's OWN width (`*(u16 *)0x4000004`). There is no layout to
      //     reconcile: two widths at one literal address are two casts of one address, which is
      //     what the source wrote. The inhabitant is a memory-mapped I/O register the source writes
      //     as a halfword and as a word (`sa3:Sio32MultiLoadMain`, `synthetic:unidev`).
      // This is the DUAL of raise/truncload.ts's `fixed-cell` gate, not a relaxation of it: that
      // gate refuses to FOLD the two accesses into one cast of a wider load, because a device read
      // is not a read of the bytes around it. Both readings agree that the two accesses stay two.
      //
      // THE PACKED REFUSAL IS NOT FORGIVEN FOR ANY BASE. Its residue is not two spellings: a
      // misaligned access renders through the element index `off / width`, which is a fraction and
      // not C, so forgiving it would trade a loud decline for an uncompilable candidate. THIS layer
      // is the one that can name the layout, which is why the refusal a reader sees is this one.
      // structure/structure.ts `displacementIndex` refuses the fraction a second time where it
      // would be computed, for the bases that never reach this pass at all (already typed, or a
      // forgiven overlap); that message can only describe the access, not the layout.
      //
      // An ANONYMOUS base (a loaded pointer, a parameter) has no other source of truth: its layout
      // is what this function's accesses say, and an overlap there says UNION. It is declared as
      // one (`buildUnionStruct`), which declines in turn on what it cannot lay out. The two
      // declared kinds above keep their casts although `buildUnionStruct`'s aliasing argument
      // applies to them too: no row re-reads across a store there, and a union is the wrong
      // declaration for both inhabitants (docs/level-tower.md, "A union").
      if (!(e instanceof StructOverlapError)) {
        throw e;
      }
      if (addressDeclaredElsewhere(base)) {
        continue;
      }
      base.type = T.ptr(buildUnionStruct(`Struct${name}`, accesses, aggregateBoundary));
    }
    name++;
    count++;
  }
  return count;
}

/** The next `Struct<N>` index past every one this function's graph already uses — the shared name
 *  allocator for the two passes that synthesize a struct pointee. The scan itself is
 *  `ir/struct-names.ts`, which the three struct minters share; this names the prefix. */
export function firstFreeStructIndex(fn: Fn): number {
  return nextStructIndex(
    [...collectStructs(fn)].map((s) => s.name),
    'Struct',
  );
}

/** The distinct struct types this function's L2 GRAPH mentions (unwrapping struct pointers on every
 *  value), deduped by name and sorted, for the backend to declare above the function.
 *
 *  "Mentions", not "references": this walks `fn.blocks` at the moment structuring runs, and the
 *  result is CACHED on the SFn (`structure.ts`) and carried by every later `{...sfn}` pass, so a
 *  struct whose last use a subsequent L3 pass removed would still be declared. Sibling `locals` is
 *  reference-pruned after dead-store elimination (`l3/dce.ts`) for exactly that reason; this list is
 *  not. No pass drops such a use today — the IR-level DCE runs long before recognition, and l3/dce's
 *  `mustKeep` never drops a `field`/`index` — so the staleness is LATENT, not live, which is why it
 *  is recorded here rather than fixed speculatively. The fix, if a pass ever makes it reachable, is
 *  the one l3/symbol-refs.ts already applies to symbol references: derive at the consumption point
 *  (`backend/cfamily.ts` structDecls) instead of caching. */
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
