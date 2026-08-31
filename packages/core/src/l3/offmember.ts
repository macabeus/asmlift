// L3 re-spelling: spell a leaf base's constant subscript as a struct MEMBER, so the offset stays
// in the instruction's displacement instead of folding into the address the compiler materializes.
//
// THE COMPILER FACT this exists for is the one `l3/basecse.ts`'s header states in the imperative
// and cannot act on: on a target that declares `compilerBehaviors.foldsConstAddrOffset`, a
// constant SUBSCRIPT folds into the literal the address materializes, while an aggregate MEMBER
// offset stays in the memory operand.
//
//   ((u16 *)0x3003468)[7]          →  .word 0x3003476  +  ldrh r0, [r0]
//   ((struct S *)0x3003468)->m14   →  .word 0x3003468  +  ldrh r0, [r0, #0xe]
//
// Both denote the same cell. Which one the source wrote is not derivable from the C, but the ASM
// says which one the compiler was given: an offset that reached the load's own displacement got
// there because nothing folded it, and only a member (or a named base — that is `/basefold`'s
// spelling) leaves it there. `l3/ast.ts`'s `index.operandOff` carries that displacement down from
// the lift, because the fold at L3 (`idx = idxVal + off / width`, structure/structure.ts) makes
// the two indistinguishable afterwards.
//
// THE ROSTER ALREADY OFFERS THE OTHER SOURCE OF THE SAME SHAPE. `/basefold` reads the identical
// evidence and answers it with a NAMED BASE (`u16 *p = (u16 *)C; p[7]`), which also keeps the
// displacement. The member is the second source and was in no fan; the two are different C and
// different register pressure, so both ride and the differ referees.
//
// SCOPE — a LEAF base only (a bare `addr` or a bare `const`), which is `l3/basecse.ts`'s
// `isHoistableBase` population. A computed base (`((u16 *)v0)[8]`) is out: the address is already
// held somewhere, so nothing folded into a literal and the evidence says nothing — that shape is
// `/addr-home`'s (structure/analysis.ts). It is a GATE rather than a collection filter so the
// refusal is attributable: `firstRejection` names it.
//
// NOT AN EXTENSION OF raise/struct-arrays.ts. That pass mints an element struct off the `mul`/`shl`
// STRIDE idiom in the machine code, and this shape has no scale at all — the subscript is a
// constant and the base is a leaf, so there is no stride to read. It is a SPELLING of a tree
// structuring already produced, which is what puts it in `l3/` beside the other re-spellings.
//
// SOUNDNESS. The member offset is `idx * width`, the access's own byte offset from the base — never
// `operandOff`, which is EVIDENCE about where the offset travelled and is only part of it when the
// address carried the rest. So the respelled node addresses the same cell by construction, and the
// one way it could not is a layout C cannot reproduce — a member C would seat somewhere other than
// where the asm read it. `unspellable-layout` refuses that, and it is the table's only sound gate.
//
// REFUSAL. `spellOperandMembers` returns `null` when no base was admitted, so a function with no
// eligible site contributes no candidate and costs nothing. A base with ANY ineligible access is
// refused WHOLE rather than half-respelled: the declared struct is then a complete description of
// every access through that address, which is what makes it self-describing.
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn, StructType } from './ast';
import { mapExprChildren, mapStmtExprs, walkExprs } from './ast';
import { type Gate, firstRejection } from './gates';

/** One observed constant-subscript access through a base. */
interface Site {
  /** the member's byte offset from the base — `idx * width`, the address the node denotes */
  off: number;
  width: number;
  signed: boolean;
  /** the displacement the instruction carried, when it carried one (l3/ast.ts `operandOff`) */
  operandOff?: number;
}

/** The identity of an access's base, for grouping. Leaf bases key by value; everything else keys
 *  by its printed shape, so a non-leaf base still reaches the table and is refused by NAME. */
const baseKey = (e: Expr): string =>
  e.k === 'addr' ? `a:${e.name}` : e.k === 'const' ? `c:${e.value}` : `x:${JSON.stringify(e)}`;

/** What the gates judge: one base and every constant-subscript access through it. */
export interface OffmemberBase {
  key: string;
  /** the base is a bare `addr`/`const` — the population whose address the compiler materializes */
  leafBase: boolean;
  /** some access through this base carries no memory-operand displacement, so nothing says its
   *  offset was ever anywhere but the address */
  missingOperandOff: boolean;
  /** some access's subscript is WIDER than the displacement the instruction carried — the address
   *  expression held the rest, and how that split maps back onto one member is not measured */
  indexCarriesMore: boolean;
  /** the accesses cannot be declared as a plain C struct seating each at its own offset */
  unspellableLayout: boolean;
}

export const OFFMEMBER_GATES: readonly Gate<OffmemberBase>[] = [
  {
    id: 'non-leaf-base',
    why: 'a computed base is already held somewhere, so nothing folded into a literal',
    sound: false,
    rejects: (c) => !c.leafBase,
  },
  {
    id: 'no-operand-off',
    why: 'an offset that never reached the instruction is not evidence of a member',
    sound: false,
    rejects: (c) => c.missingOperandOff,
  },
  {
    id: 'index-carries-more',
    why: 'the address carried part of the offset, and that decomposition is unmeasured',
    sound: false,
    rejects: (c) => c.indexCarriesMore,
  },
  {
    id: 'unspellable-layout',
    why: 'a struct C cannot seat at the observed offsets would address different bytes',
    sound: true,
    guardedBy: 'offmember.test.ts: a base whose accesses no plain struct can seat is refused',
    rejects: (c) => c.unspellableLayout,
  },
];

/** The members this base is spelled through: one field per distinct offset, a load's signed view
 *  preferred over a store's. Shared by the seating PREDICATE and the layout BUILDER so the two
 *  cannot judge one field set and declare another. */
function membersOf(sites: readonly Site[]): Site[] {
  const byOff = new Map<number, Site>();
  for (const s of sites) {
    const prev = byOff.get(s.off);
    if (!prev || (s.signed && !prev.signed)) {
      byOff.set(s.off, s);
    }
  }
  return [...byOff.values()].sort((a, b) => a.off - b.off);
}

/** Can plain C seat every member at the offset the asm read it at?
 *
 *  Three ways it cannot, and all three are the same defect — a field the declaration would place
 *  somewhere other than where the access reads: a NEGATIVE offset, which no member has; two views
 *  of ONE offset at different widths (a union); and two offsets whose byte ranges collide.
 *
 *  Natural ALIGNMENT is not among them, and that is an invariant rather than an omission: a
 *  member's offset here is the node's own `idx * width`, so it is a multiple of its width by
 *  construction and C's own alignment can always place it. A clause for it would have no
 *  inhabitant.
 *
 *  This is what `unspellable-layout` asks, and the gate is the ONLY refusal — `layoutFor` below
 *  builds whatever it is handed, so ablating the gate really does emit the mislaid struct rather
 *  than quietly declining beside it. */
function seatable(sites: readonly Site[]): boolean {
  let cursor = 0;
  const widths = new Map<number, number>();
  for (const s of sites) {
    const w = widths.get(s.off);
    if (w !== undefined && w !== s.width) {
      return false;
    }
    widths.set(s.off, s.width);
  }
  for (const m of membersOf(sites)) {
    if (m.off < cursor) {
      return false;
    }
    cursor = m.off + m.width;
  }
  return true;
}

/** The struct declaration for a base: each member at its own offset, gaps filled with an explicit
 *  `u8[N]` pad so the declaration reproduces the observed offsets on its own — the discipline
 *  raise/structs.ts and raise/struct-arrays.ts share. No trailing pad and no `size`: the spelling
 *  is `->m`, so `sizeof` is never taken. */
function layoutFor(name: string, sites: readonly Site[]): StructType {
  const fields: StructType['fields'] = [];
  let cursor = 0;
  let pad = 0;
  for (const m of membersOf(sites)) {
    if (cursor < m.off) {
      fields.push({ off: cursor, type: T.array(T.u(8), m.off - cursor), name: `_pad${pad++}` });
    }
    fields.push({ off: m.off, type: scalarTypeForAccess(m.width, m.signed), name: `m${m.off}` });
    cursor = m.off + m.width;
  }
  return { name, fields };
}

/** Every constant-subscript `index` access, grouped by base, in first-appearance order. */
function collect(sfn: SFn): { order: string[]; sites: Map<string, Site[]> } {
  const order: string[] = [];
  const sites = new Map<string, Site[]>();
  for (const e of walkExprs(sfn.body)) {
    if (e.k !== 'index' || e.idx.k !== 'const' || e.lead !== undefined) {
      continue;
    }
    const k = baseKey(e.base);
    if (!sites.has(k)) {
      order.push(k);
      sites.set(k, []);
    }
    sites.get(k)!.push({ off: e.idx.value * e.width, width: e.width, signed: e.signed, operandOff: e.operandOff });
  }
  return { order, sites };
}

/** The keys `gates` admits, with the struct each one is spelled through. */
function admit(
  sfn: SFn,
  gates: readonly Gate<OffmemberBase>[],
  firstName: number,
): Map<string, { struct: StructType; type: IrType }> {
  const { order, sites } = collect(sfn);
  const out = new Map<string, { struct: StructType; type: IrType }>();
  let n = firstName;
  for (const key of order) {
    const list = sites.get(key)!;
    const rejected = firstRejection(gates, {
      key,
      leafBase: key.startsWith('a:') || key.startsWith('c:'),
      missingOperandOff: list.some((s) => s.operandOff === undefined),
      indexCarriesMore: list.some((s) => s.operandOff !== undefined && s.operandOff !== s.off),
      unspellableLayout: !seatable(list),
    });
    if (rejected === null) {
      const struct = layoutFor(`Off${n}`, list);
      out.set(key, { struct, type: T.ptr(T.struct(struct.name, struct.fields)) });
      n++;
    }
  }
  return out;
}

/** The census without the rewrite, for a caller comparing what two tables would admit. */
export function offmemberBases(sfn: SFn, gates: readonly Gate<OffmemberBase>[] = OFFMEMBER_GATES): readonly string[] {
  return [...admit(sfn, gates, 0).keys()];
}

/** Re-spell every admitted base's constant subscripts as members of a synthesized struct.
 *  `null` when nothing is admitted — the axis then contributes no candidate. */
export function spellOperandMembers(sfn: SFn, gates: readonly Gate<OffmemberBase>[] = OFFMEMBER_GATES): SFn | null {
  // Seeded past the names the tree already carries: raise/structs.ts mints `Struct<N>` and
  // raise/struct-arrays.ts `Elem<N>`, so the prefix alone keeps this pass clear of both — but a
  // second `/offmember` over one tree would not be, and a collision declares one layout under a
  // name another access reads.
  const taken = new Set((sfn.structs ?? []).map((s) => s.name));
  let seed = 0;
  while (taken.has(`Off${seed}`)) {
    seed++;
  }
  const admitted = admit(sfn, gates, seed);
  if (admitted.size === 0) {
    return null;
  }
  const rewrite = (e: Expr): Expr => {
    if (e.k === 'index' && e.idx.k === 'const' && e.lead === undefined) {
      const hit = admitted.get(baseKey(e.base));
      if (hit) {
        return { k: 'field', base: { k: 'cast', to: hit.type, e: e.base }, name: `m${e.idx.value * e.width}` };
      }
    }
    return mapExprChildren(e, rewrite);
  };
  const structs = [...(sfn.structs ?? []), ...[...admitted.values()].map((a) => a.struct)].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  // `mapStmtExprs` recurses into nested statement lists, so one call per top-level statement
  // covers the whole body.
  return { ...sfn, structs, body: sfn.body.map((st) => mapStmtExprs(st, rewrite)) };
}
