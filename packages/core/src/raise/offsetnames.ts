// asmlift — A NAME FOR AN ADDRESS THE MACHINE BUILT BY ARITHMETIC, read off the same symbol map
// the pool-word promotion reads.
//
// WHAT IS MISSING WITHOUT THIS. frontend/thumb.ts promotes a POOL-LOADED word to `gaddr sym` by
// asking the address-keyed map what lives at that address, and its own note records the boundary:
// "Only pool-loaded words promote (an address built by arithmetic never reaches here)". A
// compiler that has several neighbouring cells to touch does not load a pool word per cell — it
// loads one and walks:
//
//     ldr  r1, .L4          @ .word 0x40000ba   -> gaddr REG_DMA0CNT_H
//     strh r2, [r1]
//     adds r1, #12
//     strh r3, [r1]         @ 0x40000c6 — REG_DMA1CNT_H, and the map says so
//
// so the map is never asked about the second cell, and the second store spells an offset walk off
// the first name. That is not merely a longer spelling. `structure.ts` classifies a symbol whose
// address is ever an `add`/`sub` operand as AGGREGATE, which drops it from `scalarGlobals`, and
// the bare-name spelling and the `volatile` qualifier both hang off that set — so one walked store
// de-names the symbol at EVERY site in the function, including the off-0 ones, and silently casts
// the `volatile` away. Observable in the object: with the cast form agbcc CSEs a read the target
// re-reads.
//
// It is also a REPRESENTATION gap and not merely a missed call. `SymbolInfo` carries no address
// and `structure()` receives the map NAME-keyed, so once the frontend has emitted `gaddr S`
// nothing downstream can compute `addr(S) + K` at all. That puts the pass anywhere BEFORE
// `structure()`, and it sits at the top of that window for one reason: `raise/arrays.ts`,
// `raise/struct-arrays.ts` and `raise/memberarrays.ts` match the same `add(gaddr, K)` shape this
// pass consumes, and `interior-offset` below cedes the in-object case back to them — so the
// question "is this address an object of its own?" is answered first and what it refuses is handed
// on untouched. THE CORPUS DOES NOT REFEREE THE SEAT: run instead from `raiseRecovered`'s
// `beforeRecover` hook, after every recognizer, and `pnpm bench gates --pass offsetnames` reports
// the identical counts on all six rows that refuse or name anything, with
// `kleod:DeleteAllSaveData:agbcc` the same winner at the same 0/81. The argument is about which
// pass sees a shape first, not about a row.
//
// WHAT IT DOES. Over the lifted L1 fn: resolve every `add`/`sub` whose operand tree bottoms out
// at a `gaddr` plus constants, and where the map holds a symbol EXACTLY at the resulting address,
// rewrite that op into `gaddr` for it. No opcode, no representation and no level is introduced —
// `gaddr` and `add` both already exist, and everything downstream is the named-global machinery
// the pool path already feeds.
//
// NAMING IS NOT A FIDELITY LOSS HERE, and that is compiled rather than assumed: the same four
// `REG_DMA*CNT_H` stores spelled as four independent named volatile MMIO stores compile back to
// `ldr r1 / strh / adds r1,#12 / strh / …` — agbcc re-derives the walk itself from the four
// literal addresses. Whether the compiler will re-derive it for an `extern`-shaped name it has to
// relocate is a SCORE question the ranker referees, not a correctness one; the address this pass
// spells is the address the machine computed, by the map's own arithmetic.
//
// SO WHY A DEFAULT AND NOT A VARIATION. The usual test is whether the asm UNDERDETERMINES the
// source, and here it does: the `adds r1,#12` chain is what agbcc emits for the walk AND for four
// independent named stores. What settles it the other way is that the two spellings are not peers.
// The named one is address-identical by construction and restores the `volatile` the cast form
// erases (see the AGGREGATE note above); the walk is reachable from `/raw-globals`, which is the
// arm that drops every map name at once. The price is measured and real — a default rewrite
// removes the walk spelling from the fan at every admitted site, shrinking
// `ButtonConfigurationScreenInit`'s to 0.95x and `sub_0804E708`'s to 0.88x — and it buys 0 lost
// rows. A per-site variation would be the third answer, and nothing in the corpus asks for it yet.
//
// WHY THERE IS NO SYNTHETIC ROW, measured rather than conceded. A walk only happens where the
// compiler saw LITERAL addresses — spelled as `extern`s the pool words are relocations, agbcc
// cannot see two cells are adjacent, and it loads one word per cell — and a literal address is
// exactly what `/raw-globals` spells with no map at all. So a row built on the walk alone always
// carries a map-less candidate with the same bytes. Two reductions were built and both scored the
// broken candidate exactly as they scored the right one: three MMIO stores twelve bytes apart is
// 0/13 with this pass and 0/13 with it ablated, and so is the version that re-reads the walked-to
// cell, whose `/raw-globals` sibling wins at 0/13 either way. The capability is row-visible only
// where the function ALSO needs something the map provides, which is what
// `kleod:DeleteAllSaveData:agbcc` is — ablate the pass there and it goes MATCH -> 20/82 while its
// best `/raw-globals` candidate is 72/97. The unit tests below carry the rest.
//
// WHAT REFUSES is `OFFSET_NAME_GATES` below, and every rejection leaves the arithmetic exactly as
// the frontend emitted it — the spelling that is valid under any declaration.
//
// WHICH GATE BOUNDS THE CORPUS PATH — `pnpm bench gates --pass offsetnames`, plus one run per real
// project (`--only <project>:`), counting a refusal per EVALUATION rather than per site (a row
// lifts more than once, which that command's own footer states):
//
//   interior-offset   25   pokeemerald 13, synthetic `sbscope` 6, marioparty3 4, kleod 2
//   base-unsized       1   snowboardkids2 `func_80014440_15040`'s `gDefaultFontPalette+2`
//   everything else    0
//
// Two of the three heuristics decide the whole path — `no-symbol-at-offset` fires nowhere. The
// SOUND rules — a code address at either end, a width the map does not state, a width that
// disagrees with the access, an access this census cannot see, a store onto a `const` name, a base
// the map places twice — refuse NOTHING here and are pinned by `offset-names.test.ts` alone. Say so
// rather than letting the table read as though all ten were load-bearing.
import { type Fn, type Op, type Value, defOpMap } from '../ir/core';
import { verify } from '../ir/verify';
import { type Gate, firstRejection } from '../l3/gates';
import { dce } from '../pattern/engine';
import { type SymbolInfo, type SymbolMap, lookupSymbol } from '../symbols';

/** One `add`/`sub` whose address the gates judge. Built only for an op that already resolves to a
 *  named base plus a NON-ZERO constant — a zero offset names the base itself, which the pool path
 *  spelled already, so there is nothing to judge. */
export interface OffsetAddress {
  /** the base symbol's own entry, read at the FIRST address the map carries the name at */
  readonly base: SymbolInfo;
  /** the map carries the base name at more than one address, so `target` stands on an arbitrary
   *  pick — the one thing `base-address-ambiguous` is there to refuse */
  readonly ambiguous: boolean;
  /** the base `gaddr` carries the frontend's `code` attr (a function address) */
  readonly baseIsCode: boolean;
  /** the constant the machine added to the base address (signed) */
  readonly offset: number;
  /** what the map holds EXACTLY at `addr(base) + offset` */
  readonly target: SymbolInfo | null;
  /** some use of this value is the base operand of a store */
  readonly written: boolean;
  /** some use of this value is a successor's block argument, so the accesses made through it are
   *  made through a block PARAMETER — a value with no def, which the walk below stops at. The two
   *  access sets are therefore incomplete rather than empty, and the three rules that read them
   *  would pass on nothing. */
  readonly crossesMerge: boolean;
  /** the width of every OFF-0 access through this address, and the load signedness of the narrow
   *  ones — the same facts `rank-declare.ts`'s `bareGlobalAccessFacts` reads for a bare name, taken
   *  at this one address. An access at a non-zero offset is spelled through a cast that carries its
   *  own width, so it states nothing about the name's declaration and is not collected. Empty where
   *  the value is only an address: the next link of the walk, a call argument. */
  readonly accessWidths: ReadonlySet<number>;
  readonly accessSigns: ReadonlySet<boolean>;
}

/** The access the walked-to name's own declaration produces: the width `gSym = v` writes, and the
 *  signedness `x = gSym` loads with. `null` where the map states no width — a name-only entry, or a
 *  struct whose interior the field spelling owns. A 4-byte unit has no signedness in the
 *  instruction, which is the normalization the access side makes too. */
function accessUnit(info: SymbolInfo): { width: number; signed: boolean } | null {
  const [width, signed] =
    info.shape === 'scalar'
      ? [info.size, info.signed === true]
      : info.shape === 'array'
        ? [info.elemSize, info.elemSigned === true]
        : info.shape === 'pointer'
          ? [4, false]
          : [undefined, false];
  return width === undefined ? null : { width, signed: signed && width < 4 };
}

/** The refusals. FIRST rejection is what `offsetNameRefusals` reports, so the order is the
 *  attribution order: the three rules about what the map can say about the BASE, then what sits at
 *  the offset, then the two about the ACCESS made through it. The two that are not `sound` are
 *  about OWNERSHIP and ABSENCE rather than correctness — an interior address is the field and
 *  element machinery's to spell, and where no symbol sits there the arithmetic is simply the only
 *  name available.
 *
 *  THE ADDRESS IS NOT THE WHOLE QUESTION, and the last two rules are what says so. Naming an
 *  address the map holds is address-exact by construction; what a bare name ALSO decides is the
 *  instruction, because `gSym = v` writes whatever `gSym` was declared as. A halfword store walked
 *  onto a word-wide neighbour compiles to `str` where the target says `strh` — the same four bytes
 *  of address, four bytes written instead of two — and a name the map has no width for reaches
 *  declaration synthesis with no width authority at all (rank-declare.ts's `bareGlobalAccessFacts`
 *  keys off the pool-loaded `gaddr` defs of a lift this pass has not run on), so it falls back to
 *  `extern u32`. Both refuse here, where the map's own width is in hand. */
export const OFFSET_NAME_GATES: readonly Gate<OffsetAddress>[] = [
  {
    id: 'base-address-ambiguous',
    why: 'the map carries the base name at more than one address, so the offset names nothing definite',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `base-address-ambiguous` a doubly-mapped name picks one of its addresses',
    rejects: (c) => c.ambiguous,
  },
  {
    id: 'base-is-code',
    why: 'an offset into a function is not an object C can name',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `base-is-code` an offset into a function becomes a data name',
    rejects: (c) => c.baseIsCode || c.base.kind === 'code',
  },
  // NOT sound, for the same reason `interior-offset` is not: the address it refuses is one the map
  // holds a name at exactly, so the spelling it costs is address-identical and the access rules
  // below check its width. What it buys is OWNERSHIP — an unsized base may span the cell, and
  // naming the cell by a neighbour then re-attributes an access to an object the base's own
  // spelling covers.
  {
    id: 'base-unsized',
    why: 'the base declares no size, so nothing here can tell its own interior from a neighbour',
    sound: false,
    rejects: (c) => c.base.size === undefined,
  },
  // The `why` claims ownership rather than a handover, because the handover is not what happens:
  // `pokeemerald:TrySetCantSelectMoveBattleScript`'s interior sites emit
  // `((struct Elem7 *)((u32)&gBattleBufferB + 2))[i].field_0` — the element and field machinery
  // indexes off the base, and the interior offset itself stays raw arithmetic.
  {
    id: 'interior-offset',
    why: 'the address lands inside the base object, so the name at it labels a part of something the base already spells',
    sound: false,
    rejects: (c) => c.offset > 0 && c.offset < (c.base.size ?? 0),
  },
  {
    id: 'no-symbol-at-offset',
    why: 'no symbol sits exactly at the computed address, so the arithmetic is the only honest spelling',
    sound: false,
    rejects: (c) => c.target === null,
  },
  {
    id: 'target-is-code',
    why: 'a walked-to function address is a relocation this spelling cannot reproduce',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `target-is-code` the walk names a function',
    rejects: (c) => c.target?.kind === 'code',
  },
  // FIRST of the access rules, because it is the reason the other three can have nothing to
  // judge. An address merged from two predecessors reaches its store through the successor's
  // block parameter, and `offsetSites` counts accesses against the site's OWN value — so without
  // this the three rules below are asked about an empty set and pass, and the merge the
  // structurer then collapses hands the bare name straight to the access they exist to check.
  {
    id: 'access-behind-merge',
    why: 'a use of this address is a block argument, so the accesses made through it are not this census to count',
    sound: true,
    guardedBy:
      'offset-names.test.ts: without `access-behind-merge` a word store behind a merge names a halfword cell',
    rejects: (c) => c.crossesMerge,
  },
  {
    id: 'target-unsized',
    why: 'the map states no width for the walked-to name, so a declaration synthesized for it would guess one',
    sound: true,
    guardedBy:
      'offset-names.test.ts: without `target-unsized` a name-only neighbour is stored through at the guessed width',
    rejects: (c) => c.target !== null && c.accessWidths.size > 0 && accessUnit(c.target) === null,
  },
  {
    id: 'access-unlike-target',
    why: 'the access through this address is not the one the walked-to name declares, so the bare spelling is a different instruction',
    sound: true,
    guardedBy:
      'offset-names.test.ts: without `access-unlike-target` a halfword store onto a word-wide name becomes `str`',
    rejects: (c) => {
      const unit = c.target === null ? null : accessUnit(c.target);
      return (
        unit !== null &&
        ([...c.accessWidths].some((w) => w !== unit.width) || [...c.accessSigns].some((s) => s !== unit.signed))
      );
    },
  },
  // How hard the constraint violation fails is per compiler, so the rule states the constraint
  // rather than a verdict: the same `gRomTable[i] = 1;` is `warning: assignment of read-only
  // location` and exit 0 on agbcc, and `cfe: Error: Change value for constant variable.` and exit 1
  // on IDO 7.1.
  {
    id: 'const-target-store',
    why: 'a store through a const-declared name is a constraint violation, and these compilers range from a warning to a hard error',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `const-target-store` the store walks onto a const-declared name',
    rejects: (c) => c.written && c.target?.const === true,
  },
];

/** Every name the map carries, with the FIRST address it sits at and whether it sits at more than
 *  one. The reverse of the address-keyed map, which is the direction `addr(S) + K` needs and the
 *  only direction `SymbolMap` does not already have.
 *
 *  `twice` is about two ADDRESSES, not two entries: `SymbolMap` holds a `SymbolInfo[]` per address
 *  precisely because one address legitimately carries several (aliases, typed views of one RAM
 *  region), and a name repeated inside one of those lists still says where it is. */
function addressesByName(symbols: SymbolMap): Map<string, { addr: number; info: SymbolInfo; twice: boolean }> {
  const out = new Map<string, { addr: number; info: SymbolInfo; twice: boolean }>();
  for (const [addr, infos] of symbols) {
    for (const info of infos) {
      const prev = out.get(info.name);
      if (prev === undefined) {
        out.set(info.name, { addr, info, twice: false });
      } else if (prev.addr !== addr) {
        out.set(info.name, { ...prev, twice: true });
      }
    }
  }
  return out;
}

/** The named base an address value stands on, following `add`/`sub` chains through constants —
 *  the `adds r1,#12` walk is a chain of them, and each link is its own candidate. Stops at
 *  anything else, block parameters included (they have no def, so a loop-carried pointer
 *  induction never resolves). */
function namedBase(v: Value, defOf: Map<Value, Op>): { sym: string; code: boolean; offset: number } | null {
  const d = defOf.get(v);
  if (d === undefined) {
    return null;
  }
  if (d.opcode === 'gaddr') {
    return { sym: d.attrs.sym as string, code: d.attrs.code === true, offset: 0 };
  }
  if (d.opcode !== 'add' && d.opcode !== 'sub') {
    return null;
  }
  const [a, b] = d.operands;
  const ka = defOf.get(a)?.opcode === 'const' ? (defOf.get(a)!.attrs.value as number) : null;
  const kb = defOf.get(b)?.opcode === 'const' ? (defOf.get(b)!.attrs.value as number) : null;
  // `sub` is not commutative: only `base - K` is an offset off the base.
  if (kb !== null) {
    const base = namedBase(a, defOf);
    return base && { ...base, offset: base.offset + (d.opcode === 'sub' ? -kb : kb) };
  }
  if (ka !== null && d.opcode === 'add') {
    const base = namedBase(b, defOf);
    return base && { ...base, offset: base.offset + ka };
  }
  return null;
}

/** Every `add`/`sub` in `fn` that resolves to a named base plus a non-zero constant, with the
 *  context the gates judge. Shared by the rewrite and by `offsetNameRefusals` so the two cannot
 *  disagree about which sites exist. */
function offsetSites(fn: Fn, symbols: SymbolMap): { op: Op; sym: string; addr: OffsetAddress }[] {
  const defOf = defOpMap(fn);
  const byName = addressesByName(symbols);
  const written = new Set<Value>();
  // Through the address arithmetic, not just at it: `gRom[i] = v` stores through an `add` of the
  // walked address and a scaled index, so the value the gates judge is one level up from the
  // store's own base operand. Without the walk the const rule fires or not depending on whether an
  // index happens to sit in between.
  //
  // A CONSTANT displacement ends the closure, because it is the link that names its own cell: on
  // `&g + 12 + 12` the store goes through the second link, and descending past it would report
  // the first as written too — a `const` two cells back would then refuse a site nothing stores
  // through, and `offsetNameRefusals` would publish that as this site's reason.
  const markWritten = (v: Value): void => {
    if (written.has(v)) {
      return;
    }
    written.add(v);
    const d = defOf.get(v);
    if (d?.opcode !== 'add' && d?.opcode !== 'sub') {
      return;
    }
    if (d.operands.some((o) => defOf.get(o)?.opcode === 'const')) {
      return;
    }
    d.operands.forEach(markWritten);
  };
  const access = new Map<Value, { widths: Set<number>; signs: Set<boolean> }>();
  const accessOf = (v: Value) => access.get(v) ?? access.set(v, { widths: new Set(), signs: new Set() }).get(v)!;
  const blockArgs = new Set<Value>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        s.args.forEach((a) => blockArgs.add(a));
      }
      if (op.opcode === 'store' || op.opcode === 'astore') {
        markWritten(op.operands[0]);
      }
      if ((op.opcode === 'load' || op.opcode === 'store') && (op.attrs.off as number) === 0) {
        const a = accessOf(op.operands[0]);
        const w = op.attrs.width as number;
        a.widths.add(w);
        if (op.opcode === 'load') {
          a.signs.add((op.attrs.signed as boolean) === true && w < 4);
        }
      } else if (op.opcode === 'aload' || op.opcode === 'astore') {
        const a = accessOf(op.operands[0]);
        const w = op.attrs.elemSize as number;
        a.widths.add(w);
        if (op.opcode === 'aload') {
          a.signs.add((op.attrs.signed as boolean) === true && w < 4);
        }
      }
    }
  }
  const out: { op: Op; sym: string; addr: OffsetAddress }[] = [];
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode !== 'add' && op.opcode !== 'sub') {
        continue;
      }
      const r = op.results[0];
      if (r === undefined) {
        continue;
      }
      const base = namedBase(r, defOf);
      if (base === null || base.offset === 0) {
        continue;
      }
      const at = byName.get(base.sym);
      if (at === undefined) {
        continue; // the base name reached the IR from somewhere other than this map
      }
      out.push({
        op,
        sym: base.sym,
        addr: {
          base: at.info,
          ambiguous: at.twice,
          baseIsCode: base.code,
          offset: base.offset,
          target: lookupSymbol(symbols, at.addr + base.offset),
          written: written.has(r),
          crossesMerge: blockArgs.has(r),
          accessWidths: access.get(r)?.widths ?? new Set(),
          accessSigns: access.get(r)?.signs ?? new Set(),
        },
      });
    }
  }
  return out;
}

/** Rewrite every admitted site into the `gaddr` the map names, in place. Returns how many. */
export function nameOffsetAddresses(
  fn: Fn,
  symbols: SymbolMap,
  gates: readonly Gate<OffsetAddress>[] = OFFSET_NAME_GATES,
): number {
  // Every site is judged against the PRE-REWRITE defs, so a chain's later links resolve through
  // the base they were lifted from and the answer does not depend on the order links are visited.
  const admitted = offsetSites(fn, symbols).filter((s) => firstRejection(gates, s.addr) === null);
  for (const s of admitted) {
    s.op.opcode = 'gaddr';
    s.op.operands = [];
    s.op.attrs = { sym: s.addr.target!.name };
  }
  if (admitted.length > 0) {
    dce(fn); // the constants and the walked-off base the rewrite just orphaned
    verify(fn);
  }
  return admitted.length;
}

/** Which rule refused each offset site this function builds — one entry per SITE, in block order,
 *  as `[<base>+<offset>, reason]` with `null` where the site was named. The attribution
 *  `firstRejection` exists for. NOT on the shipped path: a caller instrumenting a refusal asks
 *  here instead of re-deriving the predicates.
 *
 *  A LIST and not a map keyed by address: two `add` ops can resolve to one address — the arms of
 *  a merge do exactly that — and a map reports the pair as one entry, which under-reports the
 *  refusals the caller came to count. */
export function offsetNameRefusals(
  fn: Fn,
  symbols: SymbolMap,
  gates: readonly Gate<OffsetAddress>[] = OFFSET_NAME_GATES,
): readonly (readonly [string, string | null])[] {
  return offsetSites(fn, symbols).map(
    (s) =>
      [`${s.sym}${s.addr.offset < 0 ? '-' : '+'}${Math.abs(s.addr.offset)}`, firstRejection(gates, s.addr)] as const,
  );
}

/** THE CALLER-SIDE SEAM. The three drivers — pipeline's `runTower`, rank's `enumerateCandidates`,
 *  report's `traceTower` — call the pass THROUGH this record rather than through the binding above,
 *  which is what lets `pnpm bench gates --pass offsetnames` put a wrapped table in front of a real
 *  enumeration: a module-namespace binding is read-only and cannot be swapped, so a tabled pass
 *  whose only reachable name is its import is not censusable at all
 *  (`apps/benchmark/src/run/gate-census.ts`, WHAT PUTS A PASS IN THE REGISTRY). It is not a pass
 *  LIST because the ordering question a list answers is already answered here: this pass has one
 *  seat, stated above. */
export const OFFSET_NAME_PASS: { run: (fn: Fn, symbols: SymbolMap) => number } = {
  run: (fn, symbols) => nameOffsetAddresses(fn, symbols),
};
