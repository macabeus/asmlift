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
// NO DEVICE-REGISTER REFUSAL, which is a priced decision and not an omission. A base inside the
// target's declared `deviceRegisters` window is admitted like any other, so this pass will offer
// `((struct Off0 *)&REG_DMA3SAD)->m8` — a struct declared over the register file, carrying no
// qualifier. Three measurements say a refusal there buys nothing for that price.
//
//   REACH. Every device-window base reaching this table is already refused by `no-operand-off`
//   (49 of them map-less, 2 map-ful, over all four checkouts — 1417 structured functions map-less,
//   398 map-ful): the DMA idiom writes offset 0 as well as offset 8, and offset 0 leaves no
//   displacement. A window refusal removes ZERO further bases in either configuration.
//
//   PREMISE. It would be refusing a dropped qualifier, and there is none to drop: `/volatile`
//   wraps the base in a CAST that `non-leaf-base` refuses, so the two levers cannot compose and
//   the tree this pass is handed is unqualified in both configurations. Nor is a tie-break lost —
//   `deviceVolatileClaims` counts only qualifiers a tree already asserts, so an unqualified tree
//   scores zero whichever way it is spelled.
//
//   CONFIGURATION. A numeric window is read through `addrConst`, and a symbol map turns a device
//   address into a named `addr` no range can see. So such a refusal fires map-less and not
//   map-ful on the SAME function — and the real tier runs map-ful. A refusal a symbol map
//   switches off is not a refusal.
//
// What referees it instead is the differ, and `offmember.test.ts` pins the price on real compiled
// asm: on a DMACNT spin that never touches DMASAD — the one shape `no-operand-off` does not cover
// — the member spelling is offered and LOSES, 52 candidates, best
// `unsigned/derived-home/livebase/volatile: 4` against `/offmember`'s 5. A row where it WINS over
// MMIO is what would earn a gate here, together with a window reading that survives a symbol map.
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
// eligible site contributes no candidate and costs nothing.
//
// WHAT THE DECLARATION GOVERNS, and it is narrower than it looks: the CONSTANT SUBSCRIPTS this
// pass grouped under one base expression, and nothing else. A sibling
// access through the same address that this pass has no member spelling for — a variable
// subscript, a `lead`-prefixed one — is left exactly as it was, keeping its own cast, and a
// struct-array element off the same numeric constant reaches the address through a different base
// expression and so a different key entirely. So one address really can leave here spelled two
// ways, and `offmember.test.ts` emits exactly this pair rather than describing it:
// `((struct Off0 *)50345232)->m16` beside `((s32 *)50345232)[a0]`.
//
// THAT IS UGLY AND IT IS NOT UNSOUND, and only the second half is a gate's business. Every
// access carries its own cast, so no access reads a byte it did not read before; the seating check
// below judges the accesses the declaration is built FROM, which are exactly the accesses
// respelled through it, so its argument is over a total population of what it governs. The
// contradiction is between two FICTIONAL TYPES over one address, which is a readability claim —
// `quality`'s clientele, not a gate's.
//
// AND THE TIGHTER RULE IS PRICED, so it is not re-derived from scratch: refusing a base whose
// siblings this pass cannot spell removes `a:gCallbackQueue` from
// `kleod:ProcessInputAndUpdateEntities` and costs that row 284 → 306, while protecting no row on
// the 948-row bench. A gate needs a row it protects.
//
// ALL-OR-NOTHING PER FUNCTION, and that is a PRICE rather than a property. Every admitted base is
// respelled together in one candidate, so a function with two admitted bases where the target
// folded one and kept the other in the operand has no reachable spelling — the same coverage hole
// `l3/basecse.ts` states for its two admissions and `l3/ptrfield.ts` measures for its fields. The
// per-base fork is 2^n and the family's standing price for forking ten refusal sites per site was
// 1024x, so the subsets stay unreachable until a row demands one. Measured over klonoa's 69
// lifting functions (lift → idioms → raise → structure, one pass per configuration): 36 admitted
// bases over 25 functions map-less and 38 over 24 map-ful, so the multi-base functions really are
// the majority of the surplus and a missing subset has somewhere to live. The other three
// checkouts admit 32 bases over 32 functions (af), 10 over 10 (marioparty3) and 2 over 2
// (snowboardkids2), all map-less.
import { nextStructIndex } from '../ir/struct-names';
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
    // A REACH argument, which is why it claims no soundness and owes no guard — and it is the
    // only thing standing between this pass and a dropped qualifier, which the header's
    // no-device-refusal paragraph is the other half of. A `/volatile` base reaches L3 as a CAST
    // over the constant, so this gate excludes it as a side effect of excluding every computed
    // base, and the natural widening ("a cast of a leaf const is still a leaf") would respell a
    // qualified access as an unqualified member with no test failing. Nothing downstream would
    // object. So the widening is forbidden HERE, at this gate, and a round that wants it owes a
    // qualifier-preserving spelling first.
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

/** The members this base is spelled through: one field per distinct offset. Shared by the seating
 *  PREDICATE and the layout BUILDER so the two cannot judge one field set and declare another —
 *  and, since `seatable` now refuses an offset whose views disagree on width OR signedness, every
 *  surviving offset has exactly one view and the pick below is an identity on an admitted base.
 *  It is kept because this runs on ABLATED tables too, where the gate is gone and something still
 *  has to choose; preferring the signed view keeps that choice the widest one. */
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

/** Can plain C seat every member at the offset the asm read it at, AND does the member read the
 *  same value the access did?
 *
 *  FOUR ways it cannot, and the first three are the same defect — a field the declaration would
 *  place somewhere other than where the access reads: a NEGATIVE offset, which no member has; two
 *  views of ONE offset at different widths (a union); and two offsets whose byte ranges collide.
 *
 *  THE FOURTH IS NOT ABOUT PLACEMENT, and it is the easy one to leave out: two views of one
 *  offset at one width but
 *  DIFFERENT SIGNEDNESS (`ldrb` and `ldrsb` at the same address). One member has one type, so
 *  respelling both through it changes what one of the two READS — `scalarTypeForAccess` honours
 *  signedness at widths 1 and 2, so an unsigned read becomes sign-extending. That is a value
 *  change rather than a spelling change, and the differ can referee it only by luck: a masked or
 *  compared result compiles to the same bytes while the published C says something the asm does
 *  not. C spells it as a union, which is not a member, so it is refused exactly as the width union
 *  is. `l3/basecse.ts` keys `(base, width, signedness)` for the same reason, and `l3/typing.ts`
 *  states the rule in the imperative: signedness counts wherever the access extends.
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
  const views = new Map<number, Site>();
  for (const s of sites) {
    const v = views.get(s.off);
    if (v !== undefined && (v.width !== s.width || v.signed !== s.signed)) {
      return false;
    }
    views.set(s.off, s);
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

/** Every CONSTANT-SUBSCRIPT `index` access, grouped by base, in first-appearance order — the
 *  accesses this pass has a member spelling for, which are exactly the ones the declaration it
 *  builds will govern. A sibling with a variable subscript or a `lead` is not one of them and is
 *  not counted: it keeps its own cast and this pass never rewrites it (see the header's
 *  "WHAT THE DECLARATION GOVERNS"). */
function collect(sfn: SFn): { order: string[]; sites: Map<string, Site[]> } {
  const order: string[] = [];
  const sites = new Map<string, Site[]>();
  for (const e of walkExprs(sfn.body)) {
    if (e.k !== 'index' || e.idx.k !== 'const' || e.lead !== undefined) {
      continue;
    }
    const k = baseKey(e.base);
    let list = sites.get(k);
    if (!list) {
      order.push(k);
      list = [];
      sites.set(k, list);
    }
    list.push({ off: e.idx.value * e.width, width: e.width, signed: e.signed, operandOff: e.operandOff });
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

/** The gate table an ablation swaps out. Optional, so a caller gets the shipped table by default.
 *  The pass needs nothing else from the target: the fold this exists for is `foldsConstAddrOffset`
 *  and rank.ts asks that before offering the axis at all. */
export interface OffmemberOpts {
  readonly gates?: readonly Gate<OffmemberBase>[];
}

/** The census without the rewrite, for a caller comparing what two tables would admit. */
export function offmemberBases(sfn: SFn, opts: OffmemberOpts = {}): readonly string[] {
  return [...admit(sfn, opts.gates ?? OFFMEMBER_GATES, 0).keys()];
}

/** Re-spell every admitted base's constant subscripts as members of a synthesized struct.
 *  `null` when nothing is admitted — the axis then contributes no candidate. */
export function spellOperandMembers(sfn: SFn, opts: OffmemberOpts = {}): SFn | null {
  // Past EVERY `Off<N>` the tree already carries, never the first free one (`ir/struct-names.ts`,
  // shared with the other two minters, which also records that this scan returns 0 on every
  // corpus function). The prefix is what keeps this pass clear of raise/structs.ts's `Struct<N>`
  // and raise/struct-arrays.ts's `Elem<N>`; the monotone scan is what keeps it clear of itself.
  const seed = nextStructIndex(
    (sfn.structs ?? []).map((s) => s.name),
    'Off',
  );
  const admitted = admit(sfn, opts.gates ?? OFFMEMBER_GATES, seed);
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
