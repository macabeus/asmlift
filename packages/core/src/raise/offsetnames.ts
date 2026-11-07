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
// on untouched. The passes on the OTHER side of the question are `l3/nearbase.ts` and
// `l3/basecse.ts`: they BUILD the one-base-many-cells form this one un-spells — `nearbase`'s own
// example is `add #72` / `add #74` off one pool word — which is why the walk stays reachable from
// `/raw-globals`, where no map name exists to replace it.
//
// THE CORPUS DOES NOT REFEREE THE SEAT: run instead from `raiseRecovered`'s
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
// removes the walk spelling from the fan at every admitted site, and `sub_0804E708`'s falls 8 -> 7
// against `origin/main` — and it buys 0 lost rows. A per-site variation would be the third answer,
// and nothing in the corpus asks for it yet.
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
// the frontend emitted it. That is a spelling whose BYTES are right under any declaration, and it
// is not a neutral one: the `add` it leaves behind is what makes `structure.ts` classify the base
// AGGREGATE, so a refusal here still de-names the symbol at its off-0 sites and drops the
// `volatile` (`gVolA = 0;` becomes `*(u16 *)&gVolA = 0;` the moment one refused walk stands beside
// it). The per-SITE classification that would answer it lives at `scalarGlobals`, three levels
// away and booked in `docs/level-tower.md`; a refusal here is the safe answer to the question this
// pass asks and not a cost-free one.
//
// WHICH GATE BOUNDS THE CORPUS PATH — `pnpm bench gates --pass offsetnames`, plus one run per real
// project (`--only <project>:`), counting a refusal per EVALUATION rather than per site (a row
// lifts more than once, which that command's own footer states):
//
//   interior-offset     25   pokeemerald 13, synthetic `sbscope` 6, marioparty3 4, kleod 2
//   access-behind-merge   1   kleod `ButtonConfigurationScreenInit`
//   base-unsized          1   snowboardkids2 `func_80014440_15040`'s `gDefaultFontPalette+2`
//   everything else       0
//
// Two of the three heuristics decide the whole path — `no-symbol-at-offset` fires nowhere. Of the
// SOUND rules exactly one refuses anything here, once: `access-behind-merge`, on the single site
// in `ButtonConfigurationScreenInit` whose address is merged from two arms. That row scores
// 107/212 whether the site is named or refused, and its fan moves 440 -> 446 against `origin/main`
// rather than the other way, because what a refusal leaves is arithmetic and the respell
// variations have something to apply to again. The rest — a code address at either end, an address
// the map spells two ways at either end, a width the map does not state, a width that disagrees
// with the access, a store onto a `const` name — refuse NOTHING here and are pinned by
// `offset-names.test.ts` alone.
//
// AND IT IS WHERE A LIFT'S NAMES BECOME FINAL, so it is also where `cellSpelledTwice` asks whether
// any byte is now reached under two spellings — the premise `ir/alias.ts` reads two names as two
// objects on — and declines the function when one is. A refusal above is one way to get there (a
// walk left as `base + K` past the base's end spells its neighbour's byte through the base's
// name), not the only one, which is why the question is asked of the accesses and not of the gates.
// Before it declines, a NUMERIC access in such a pair is respelled through the one name the
// function reaches its bytes by (`respellNumericThroughName`, gated by `NUMERIC_RESPELL_GATES`):
// a relocated `g+K` pool word a disassembly printed as a number, which one name makes exact.
import { constDisplacementOf } from '../ir/alias';
import { type Block, type Fn, type Op, type Value, defOpMap, mkOp, mkValue, successorsOf } from '../ir/core';
import { T } from '../ir/types';
import { verify } from '../ir/verify';
import { type Gate, firstRejection } from '../l3/gates';
import { dce } from '../pattern/engine';
import { type SymbolInfo, type SymbolMap, accessSignedness, lookupSymbol } from '../symbols';
import { type StampBehaviors, joinIncoming, stampDeclaredVolatileUnder } from './declared-volatile';
import { RaiseUnsupportedError } from './errors';

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
  /** the map holds several entries at that address and they do not all spell the same thing, so
   *  `target` is an arbitrary pick — the mirror of `ambiguous`, on the other end of the walk */
  readonly targetAmbiguous: boolean;
  /** some use of this value is the base operand of a store */
  readonly written: boolean;
  /** some use of this value is a successor's block argument, which is where the two access sets
   *  below stop being a complete answer — see `access-behind-merge` */
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
  return width === undefined ? null : { width, signed: accessSignedness(width, signed) };
}

/** Everything the gates below read off a `SymbolInfo` beyond its identity: the name they spell,
 *  the kind `target-is-code` refuses, the `const` qualifier `const-target-store` refuses, and the
 *  access the declaration produces. Two entries at one address agreeing on all four make the pick
 *  between them immaterial. */
function sameAuthority(a: SymbolInfo, b: SymbolInfo): boolean {
  const ua = accessUnit(a);
  const ub = accessUnit(b);
  return (
    a.name === b.name &&
    a.kind === b.kind &&
    (a.const === true) === (b.const === true) &&
    ua?.width === ub?.width &&
    ua?.signed === ub?.signed
  );
}

/** The refusals. FIRST rejection is what `offsetNameRefusals` reports, so the order is the
 *  attribution order: what the map can say about the BASE, then what sits at the offset, then the
 *  ACCESS made through it, and last the store. The rules that are not `sound` are about OWNERSHIP
 *  and ABSENCE rather than correctness — an interior address is the field and element machinery's
 *  to spell, and where no symbol sits there the arithmetic is simply the only name available.
 *
 *  THE ADDRESS IS NOT THE WHOLE QUESTION, and `target-unsized` and `access-unlike-target` are what
 *  say so. Naming an address the map holds is address-exact by construction; what a bare name ALSO
 *  decides is the instruction, because `gSym = v` writes whatever `gSym` was declared as. A
 *  halfword store walked onto a word-wide neighbour compiles to `str` where the target says `strh`
 *  — the same four bytes of address, four bytes written instead of two — and a name the map has no
 *  width for reaches declaration synthesis with no width authority at all (rank-declare.ts's
 *  `bareGlobalAccessFacts` keys off the pool-loaded `gaddr` defs of a lift this pass has not run
 *  on), so it falls back to `extern u32`. Both refuse here, where the map's own width is in hand. */
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
  // The mirror of `base-address-ambiguous`, and it is not the same question asked twice: that one
  // is one NAME the map places at two addresses, this one is one ADDRESS the map gives several
  // names — aliases, or typed views of one RAM region, which `SymbolMap`'s `SymbolInfo[]` exists
  // to carry. `lookupSymbol` answers with ONE of them — `objectAt`'s per-address pick, usually the
  // first, the sized object behind an unsized data marker otherwise — so the width the two access
  // rules check and the `const` the store rule checks would otherwise be read off whichever alias
  // that pick lands on. Passing this gate means every alias agrees with the first on all of them.
  {
    id: 'target-address-ambiguous',
    why: 'the map gives the walked-to address several names that do not agree, so which one this spells is arbitrary',
    sound: true,
    guardedBy:
      'offset-names.test.ts: without `target-address-ambiguous` the walk spells one of two names at the address',
    rejects: (c) => c.targetAmbiguous,
  },
  {
    id: 'target-is-code',
    why: 'a walked-to function address is a relocation this spelling cannot reproduce',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `target-is-code` the walk names a function',
    rejects: (c) => c.target?.kind === 'code',
  },
  // FIRST of the access rules, because it is the reason the ones below it can have nothing to
  // judge. An address merged from two predecessors reaches its store through the successor's
  // block parameter, and `offsetSites` counts accesses against the site's OWN value — so without
  // this the rules below are asked about an empty set and pass, and the merge the structurer then
  // collapses hands the bare name straight to the access they exist to check.
  {
    id: 'access-behind-merge',
    why: 'a use of this address is a block argument, so the accesses made through it are not this census to count',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `access-behind-merge` a word store behind a merge names a halfword cell',
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
 *  the `adds r1,#12` walk is a chain of them, and each link is its own candidate. The chain is
 *  ir/alias.ts `constDisplacementOf`, the reading raise/structs.ts shares; it stops at anything
 *  else, block parameters included (they have no def, so a loop-carried pointer induction never
 *  resolves). */
function namedBase(v: Value, defOf: Map<Value, Op>): { sym: string; code: boolean; offset: number } | null {
  const disp = constDisplacementOf(defOf, v);
  const d = defOf.get(disp?.root ?? v);
  return d?.opcode === 'gaddr'
    ? { sym: d.attrs.sym as string, code: d.attrs.code === true, offset: disp?.k ?? 0 }
    : null;
}

/** Every `add`/`sub` in `fn` that resolves to a named base plus a non-zero constant, with the
 *  context the gates judge. Shared by the rewrite and by `offsetNameRefusals` so the two cannot
 *  disagree about which sites exist. */
function offsetSites(fn: Fn, symbols: SymbolMap): { op: Op; sym: string; addr: OffsetAddress; at: number }[] {
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
          a.signs.add(accessSignedness(w, op.attrs.signed as boolean | undefined));
        }
      } else if (op.opcode === 'aload' || op.opcode === 'astore') {
        const a = accessOf(op.operands[0]);
        const w = op.attrs.elemSize as number;
        a.widths.add(w);
        if (op.opcode === 'aload') {
          a.signs.add(accessSignedness(w, op.attrs.signed as boolean | undefined));
        }
      }
    }
  }
  const out: { op: Op; sym: string; addr: OffsetAddress; at: number }[] = [];
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
      const entries = symbols.get(at.addr + base.offset) ?? [];
      out.push({
        op,
        sym: base.sym,
        at: at.addr + base.offset,
        addr: {
          base: at.info,
          ambiguous: at.twice,
          baseIsCode: base.code,
          offset: base.offset,
          target: lookupSymbol(symbols, at.addr + base.offset),
          targetAmbiguous: entries.length > 1 && entries.some((i) => !sameAuthority(i, entries[0])),
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

/** Every address the map carries a name at, and whether the name is a MACRO — an address-cast
 *  macro expands to the numeric literal, so to the compiler it is the same spelling as a raw
 *  constant address, not an object of its own. Cached per map (rebuilt when its entry count moves),
 *  because the pass runs once per lift setting of every row. */
interface Places {
  readonly addrs: number[];
  macro: boolean;
}
const placesCache = new WeakMap<SymbolMap, { entries: number; places: Map<string, Places> }>();

function placesByName(symbols: SymbolMap): Map<string, Places> {
  const cached = placesCache.get(symbols);
  if (cached && cached.entries === symbols.size) {
    return cached.places;
  }
  const places = new Map<string, Places>();
  for (const [addr, infos] of symbols) {
    for (const info of infos) {
      const p = places.get(info.name) ?? places.set(info.name, { addrs: [], macro: false }).get(info.name)!;
      if (!p.addrs.includes(addr)) {
        p.addrs.push(addr);
      }
      p.macro ||= info.macroBody !== undefined;
    }
  }
  placesCache.set(symbols, { entries: symbols.size, places });
  return places;
}

/** What one access's address may stand for: the SPELLING the emitted C reaches it through (a
 *  global's name, or `null` for a numeric address — a raw constant or a macro), the OBJECT
 *  addresses that spelling may denote, and the constant displacement off them. */
interface Spelled {
  readonly spelling: string | null;
  readonly objects: readonly number[];
  readonly k: number;
  /** the name is asmlift's reading of the map (`gaddr`'s `fromMap`), not the asm's own spelling —
   *  read by ONE CELL PER SPELLING only; whether two spellings forward is the compiler's fact */
  readonly fromMap: boolean;
}

/** One access whose bytes the map lets this pass place, under ONE of the spellings its address may
 *  stand for (an address that arrives through a join may stand for several, one entry each). */
interface PlacedAccess extends Spelled {
  /** the access, so a pair is never one op against itself */
  readonly op: Op;
  readonly ranges: readonly (readonly [lo: number, hi: number])[];
  readonly writes: boolean;
}

/** The 32-bit integer `v` denotes when every leaf under it is a constant, or null. Integer
 *  arithmetic over constants, and a join whose every in-edge brings one value, fold, because the C
 *  compiler folds them in the emitted C whatever this pipeline's own constant pass does: an index
 *  built in two steps (`movs r2, #2; adds r2, #3`), or `lsls r2, #0`, is `[5]` to agbcc.
 *  Memoised per call of {@link cellSpelledTwice}; a value met again on its own walk (a loop-carried
 *  join) does not fold. */
function constantFolder(defOf: Map<Value, Op>, incoming: Map<Value, Value[]>): (v: Value) => number | null {
  const memo = new Map<Value, number | null>();
  const onWalk = new Set<Value>();
  const fold = (v: Value): number | null => {
    const known = memo.get(v);
    if (known !== undefined || memo.has(v)) {
      return known ?? null;
    }
    if (onWalk.has(v)) {
      return null;
    }
    onWalk.add(v);
    const out = foldOnce(v);
    onWalk.delete(v);
    memo.set(v, out);
    return out;
  };
  const foldOnce = (v: Value): number | null => {
    const d = defOf.get(v);
    if (d === undefined) {
      const ins = [...new Set(incoming.get(v) ?? [])].filter((a) => a !== v);
      const each = ins.map(fold);
      return each.length > 0 && each.every((x) => x !== null && x === each[0]) ? each[0] : null;
    }
    if (d.opcode === 'const') {
      return typeof d.attrs.value === 'number' ? d.attrs.value >> 0 : null;
    }
    const a = d.operands.length > 0 ? fold(d.operands[0]) : null;
    if (a === null) {
      return null;
    }
    if (d.operands.length === 1) {
      const imm = d.attrs.imm;
      const w = d.attrs.width;
      switch (d.opcode) {
        case 'not':
          return ~a;
        case 'neg':
          return -a >> 0;
        case 'zext':
          return typeof w === 'number' && w < 32 ? (a & ((1 << w) - 1)) >>> 0 : a;
        case 'sext':
          return typeof w === 'number' && w < 32 ? (a << (32 - w)) >> (32 - w) : a;
      }
      if (typeof imm !== 'number') {
        return null;
      }
      return shift(d.opcode, a, imm);
    }
    const b = d.operands.length === 2 ? fold(d.operands[1]) : null;
    if (b === null) {
      return null;
    }
    switch (d.opcode) {
      case 'add':
        return (a + b) >> 0;
      case 'sub':
        return (a - b) >> 0;
      case 'mul':
        return Math.imul(a, b);
      case 'and':
        return a & b;
      case 'or':
        return a | b;
      case 'xor':
        return a ^ b;
    }
    return shift(d.opcode, a, b);
  };
  const shift = (opcode: string, a: number, n: number): number | null => {
    if (n < 0 || n > 31) {
      return null;
    }
    switch (opcode) {
      case 'shl':
        return a << n;
      case 'shr_u':
        return (a >>> n) >> 0;
      case 'shr_s':
        return a >> n;
    }
    return null;
  };
  return fold;
}

/** The spellings an address stands for, through defs and joins: a literal (or a literal plus
 *  constants) is a numeric address, a `gaddr` plus constants its name — at the one map address
 *  the name was read at (`mapAddr`), or at every address the map places it at — and a block
 *  parameter every in-edge's value, so an address the raising tower will merge across a join (two
 *  pool loads of one word, a load and its `adds #0` copy) is placed as the merge spells it. An
 *  in-edge that passes the parameter back unchanged adds nothing; one that passes it MOVED (a
 *  pointer stepped round a loop) reaches bytes no constant names. Null where any reaching value
 *  is not placed: a parameter, a frame slot, a runtime index, a name the map does not hold. Every
 *  constant here is read through `fold` ({@link constantFolder}), as the C compiler will read it. */
function spellingsOf(
  v: Value,
  defOf: Map<Value, Op>,
  incoming: Map<Value, Value[]>,
  places: Map<string, Places>,
  fold: (v: Value) => number | null,
): Spelled[] | null {
  // A parameter's answer is memoised per displacement once it is known not to lean on a parameter
  // still being walked (`open`), so a chain of joins is walked once, not once per path through it.
  const memo = new Map<Value, Map<number, Spelled[] | null>>();
  const onWalk = new Map<Value, number>();
  let open = false;
  const walk = (x: Value, k: number): Spelled[] | null => {
    // a literal however it was built, a join of one literal included
    const literal = fold(x);
    if (literal !== null) {
      return [{ spelling: null, objects: [(literal + k) >>> 0], k: 0, fromMap: false }];
    }
    const disp = constDisplacementOf(defOf, x, fold);
    const root = disp?.root ?? x;
    const kk = k + (disp?.k ?? 0);
    const d = defOf.get(root);
    if (d?.opcode === 'gaddr') {
      const sym = d.attrs.sym as string;
      const at = places.get(sym);
      if (at === undefined) {
        return null;
      }
      const objects = typeof d.attrs.mapAddr === 'number' ? [d.attrs.mapAddr] : at.addrs;
      return [{ spelling: at.macro ? null : sym, objects, k: kk, fromMap: d.attrs.fromMap === true }];
    }
    const ins = d === undefined ? incoming.get(root) : undefined;
    if (ins === undefined) {
      return null;
    }
    const known = memo.get(root)?.get(kk);
    if (known !== undefined) {
      return known;
    }
    const seenAt = onWalk.get(root);
    if (seenAt !== undefined) {
      open = true;
      return seenAt === kk ? [] : null;
    }
    const outerOpen = open;
    open = false;
    onWalk.set(root, kk);
    let out: Spelled[] | null = [];
    for (const a of new Set(ins)) {
      const each = walk(a, kk);
      if (each === null) {
        out = null;
        break;
      }
      out.push(...each);
    }
    onWalk.delete(root);
    if (!open) {
      (memo.get(root) ?? memo.set(root, new Map()).get(root)!).set(kk, out);
    }
    open ||= outerOpen;
    return out;
  };
  const all = walk(v, 0);
  return all === null || all.length === 0 ? null : all;
}

/** Every spelling one memory access may be placed under, with the byte range at each base that
 *  spelling may denote; empty where its address is not placed ({@link spellingsOf}). */
function placeAccess(
  op: Op,
  defOf: Map<Value, Op>,
  incoming: Map<Value, Value[]>,
  places: Map<string, Places>,
  fold: (v: Value) => number | null,
): PlacedAccess[] {
  let off: number;
  let width: number;
  if (op.opcode === 'load' || op.opcode === 'store') {
    off = op.attrs.off as number;
    width = op.attrs.width as number;
  } else if (op.opcode === 'aload' || op.opcode === 'astore') {
    const index = fold(op.operands[1]);
    if (index === null) {
      return [];
    }
    width = op.attrs.elemSize as number;
    off = index * width;
  } else {
    return [];
  }
  const writes = op.opcode === 'store' || op.opcode === 'astore';
  // A literal is compared as the UNSIGNED address the map keys by: MIPS and PPC materialize
  // `0x80100000` as a negative 32-bit constant (`spellingsOf` takes `>>> 0`).
  return (spellingsOf(op.operands[0], defOf, incoming, places, fold) ?? []).map((sp) => ({
    ...sp,
    op,
    writes,
    ranges: sp.objects.map((a) => [a + sp.k + off, a + sp.k + off + width] as const),
  }));
}

/** The behaviours the pass reads: the declared-volatile stamp's, and whether this compiler RELOADS
 *  a cell stored through one spelling and read through another (`compilerBehaviors`
 *  `reloadsAcrossSpellings`; absent ⇒ it forwards). */
export type OffsetNameBehaviors = StampBehaviors & {
  readonly reloadsAcrossSpellings?: boolean;
  /** the target's device-register window (`capabilities.deviceRegisters`): a numeric access into
   *  it may be a `volatile` register the source spelled by address, which no map name carries, so
   *  {@link respellNumericThroughName} leaves it as the asm has it */
  readonly deviceRegisters?: readonly [number, number];
};

/** ONE SPELLING PER CELL, AND ONE CELL PER SPELLING — the premise `ir/alias.ts` reads names on:
 *  the first pair of this function's accesses that breaks it, or null when none does.
 *
 *  ONE SPELLING PER CELL. Two different names are two objects to every C compiler, and so are a
 *  name and a numeric address: agbcc forwards a value stored through one past a store made
 *  through the other, where the machine code reads memory back (`sRandCount = 5; ((u8
 *  *)&sUnknown)[4] = 7; return sRandCount;` compiles to `mov r0, #5`). Several places decide a
 *  spelling — the pool promotion's per-address pick and its interior attribution, this pass's
 *  walk and the refusals that leave a walk as `base + K`, the raw constant where the map holds
 *  nothing — and none of them sees the others' accesses. So the question is asked once, after the
 *  last of them, over the BYTES each access touches rather than over the map's extents: a map that
 *  lays one object over another is harmless until two accesses spell one byte two ways, and an
 *  access walked past an object's declared end, or a raw constant beside an unsized name, reaches
 *  a byte twice with no overlap in the map at all. A pair declines when one of the two is a store
 *  (two LOADS leave no value to forward) and the compiler forwards across two spellings.
 *
 *  Which compilers forward is a compiler fact, not a property of who chose the spelling. agbcc and
 *  gcc 2.7.2 forward, so an asm that went back to memory proves the source was NOT those two
 *  spellings, and every such pair declines. IDO 7.1 reloads (`reloadsAcrossSpellings`) across a
 *  name and a literal, two externs, two statics and an array element alike — but only a read that
 *  FOLLOWS the store: it treats two names as two objects, so a read of one placed BEFORE a byte
 *  store through the other is sunk past it (`v0 = D_80100004; ((u8 *)&D_80100000)[5] = 7; return
 *  v0;` is `sb t6, 5(at); jr ra; lw v0, 0(v1)`, the word read with byte 5 already 7). So the pair
 *  lifts there only in an order the compiler is measured to keep ({@link keptInOrder}): both in
 *  one block outside any loop, the store first — whether the asm spelled both (two relocations, a
 *  relocation and a literal) or asmlift chose one off the map (a promoted pool word, an interior
 *  attribution, a named walk: `gaddr`'s `fromMap`). Any other order declines.
 *
 *  ONE CELL PER SPELLING. A name the map places at several addresses (one file static per unit)
 *  read off the map at two different ones is two objects the C would spell as one, which the
 *  compiler forwards across or reads once (`sFiller = 5; return sFiller;` where the asm reads
 *  another static's cell). It declines whenever one of the two is a map read — two relocations of
 *  one name are the asm's own one object — with or without a store.
 *
 *  An address is placed through defs and joins ({@link spellingsOf}); one that reaches an access
 *  under several spellings (`c ? &a : &b`) is placed under each, so a pair is asked of every one.
 *  What this cannot place it cannot enforce: a lift with no map, or a name the map does not hold,
 *  has no address to compare, and an address the compiler cannot place either — a pointer
 *  parameter, a frame slot, a runtime index — is one it assumes may alias (agbcc reloads
 *  `sRandCount` after `((u8 *)&sUnknown)[a0] = 7`). */
export function cellSpelledTwice(fn: Fn, symbols: SymbolMap, reloadsAcrossSpellings = false): string | null {
  for (const c of spellingConflicts(fn, symbols, reloadsAcrossSpellings)) {
    return c.why;
  }
  return null;
}

/** One pair of accesses {@link cellSpelledTwice} declines on, with the reason it gives. */
interface SpellingConflict {
  readonly x: PlacedAccess;
  readonly y: PlacedAccess;
  readonly why: string;
}

/** Every access of `fn` the map lets {@link placeAccess} place, with the folder that placed them. */
function placedAccesses(
  fn: Fn,
  symbols: SymbolMap,
): { placed: PlacedAccess[]; places: Map<string, Places>; fold: (v: Value) => number | null } {
  const defOf = defOpMap(fn);
  const incoming = joinIncoming(fn);
  const places = placesByName(symbols);
  const fold = constantFolder(defOf, incoming);
  const placed: PlacedAccess[] = [];
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      placed.push(...placeAccess(op, defOf, incoming, places, fold));
    }
  }
  return { placed, places, fold };
}

/** The pairs that break ONE SPELLING PER CELL or ONE CELL PER SPELLING, in the order
 *  {@link cellSpelledTwice} meets them — at most one per pair of placed accesses. */
function* spellingConflicts(fn: Fn, symbols: SymbolMap, reloadsAcrossSpellings: boolean): Generator<SpellingConflict> {
  const keptInOrder = reloadsAcrossSpellings ? keptInOrderOn(fn) : (): boolean => false;
  const { placed, places } = placedAccesses(fn, symbols);
  const spell = (s: string | null): string => (s === null ? 'a numeric address' : `'${s}'`);
  for (const [i, x] of placed.entries()) {
    for (const y of placed.slice(i + 1)) {
      if (x.op === y.op) {
        continue;
      }
      if (x.spelling !== null && x.spelling === y.spelling) {
        const oneObject = x.objects.length === 1 && y.objects.length === 1 && x.objects[0] === y.objects[0];
        const several = (places.get(x.spelling)?.addrs.length ?? 0) > 1;
        if (several && (x.fromMap || y.fromMap) && !oneObject) {
          yield { x, y, why: `'${x.spelling}' names two of the cells the map places it at` };
        }
        continue;
      }
      if (x.spelling === y.spelling || !(x.writes || y.writes)) {
        continue;
      }
      if (keptInOrder(x.op, y.op)) {
        continue;
      }
      overlap: for (const [xl, xh] of x.ranges) {
        for (const [yl, yh] of y.ranges) {
          if (xl < yh && yl < xh) {
            yield {
              x,
              y,
              why: `byte 0x${Math.max(xl, yl).toString(16)} is reached as ${spell(x.spelling)} and as ${spell(y.spelling)}`,
            };
            break overlap;
          }
        }
      }
    }
  }
}

/** Whether a compiler that reloads across two spellings (`reloadsAcrossSpellings`) keeps the pair
 *  `a`, `b` (at least one a store) in the order the asm has, so the C reads back what the asm read.
 *  MEASURED on IDO 7.1 -O2: a store then a read through another name reloads, and two stores keep
 *  their order; a read then a store through another name does NOT — the read is sunk past the
 *  store. So the pair holds only when both sit in ONE block, the store first (or both stores), and
 *  that block is on no cycle: across blocks, or in a loop whose next iteration reads before this
 *  one's store, nothing measured says the read stays where the asm put it. */
function keptInOrderOn(fn: Fn): (a: Op, b: Op) => boolean {
  const at = new Map<Op, { block: Block; index: number }>();
  for (const block of fn.blocks) {
    block.ops.forEach((op, index) => at.set(op, { block, index }));
  }
  const onCycle = (start: Block): boolean => {
    const seen = new Set<Block>();
    const work = successorsOf(start);
    for (let b = work.pop(); b !== undefined; b = work.pop()) {
      if (b === start) {
        return true;
      }
      if (!seen.has(b)) {
        seen.add(b);
        work.push(...successorsOf(b));
      }
    }
    return false;
  };
  const isStore = (op: Op): boolean => op.opcode === 'store' || op.opcode === 'astore';
  return (a, b) => {
    const pa = at.get(a);
    const pb = at.get(b);
    if (pa === undefined || pb === undefined || pa.block !== pb.block || onCycle(pa.block)) {
      return false;
    }
    // one of the two is a store, so the pair is in order exactly when the first one is
    return isStore(pa.index < pb.index ? a : b);
  };
}

/** A NUMERIC ADDRESS THE SAME FUNCTION ALSO REACHES THROUGH A NAME — one access
 *  {@link respellNumericThroughName} judges: a load or store whose address folds to a literal, and
 *  every access spelled through a map name whose bytes overlap it.
 *
 *  WHY THE NUMBER IS NO EVIDENCE OF A NUMERIC SOURCE. A disassembly that names only exact symbol
 *  STARTS prints a relocated interior word as a number: agbcc compiles `((u8 *)&g)[0x39]`,
 *  `(u8 *)&g + 0x39` and a held `u8 *p = &g.f39` alike to `.word g+0x39` (where `g.f39` is
 *  `.word g` plus `add #0x39`), and a ROM disassembler that prints `name+offset` only inside a
 *  sized entry prints that word as a plain number, `g`'s address plus 0x39, beside the bare `g`
 *  the rest of the pool holds. The lift keeps that word raw: for an unsized `g` because interior
 *  attribution needs a size (`symbols.ts` `lookupInterior`), for a sized one because the Thumb
 *  pool promotion's veto (frontend/thumb.ts `poolNamesASymbol`) reads a numeric word beside a
 *  symbolic one as the source's choice — a premise this disassembly breaks. The lift then reaches
 *  one byte as `g + 0x39` and as a numeric address, and {@link cellSpelledTwice} declines it,
 *  correctly: as two spellings the C is two objects to a compiler that forwards across them.
 *
 *  WHY ONE NAME IS EXACT. Spelled through ONE name, both accesses are one object to the compiler,
 *  which then orders and reloads them as the memory they share requires — agbcc `-O2` compiles
 *  `g.w = 5; ((u8 *)&g)[1] = 7; return g.w;` to `str; strb [r1, #1]; ldr r0, [r1]`, the reload the
 *  two-spelling C loses. So the respelled C reads what memory holds whichever spelling the source
 *  had; a source that did write the number costs a relocated pool word against a numeric one, a
 *  score and not a meaning. What one name does NOT make exact are the gates below. */
export interface NumericRespell {
  /** the numeric access */
  readonly op: Op;
  /** how many spellings {@link placeAccess} placed `op` under: a join of several literals is more
   *  than one, and no single address to rewrite */
  readonly placings: number;
  /** the bytes `op` touches */
  readonly lo: number;
  readonly hi: number;
  /** every name an overlapping access is spelled through, paired with a store */
  readonly names: ReadonlySet<string>;
  /** an overlapping named access stands for more than one object (a join of two names' addresses) */
  readonly partnerSeveral: boolean;
  /** the one name, or null when `names` is not one */
  readonly name: string | null;
  /** every address the map places `name` at */
  readonly addrs: readonly number[];
  /** the entries the map carries `name` under at its address */
  readonly infos: readonly SymbolInfo[];
  /** the map spells `name` as an address-cast macro */
  readonly macro: boolean;
  /** `op` is a store */
  readonly writes: boolean;
  /** another map entry covers one of `op`'s bytes */
  readonly otherName: string | null;
  /** the widths of `op` and of each overlapping access spelled `name`, one pair per access, where
   *  the pair holds a store — an access through `name` whose bytes the map cannot place (a runtime
   *  index off it) counted as overlapping, since nothing says it does not */
  readonly widthPairs: readonly (readonly [number, number])[];
  /** the widths of `op` and of each overlapping access renamed through `name` along with it, one
   *  pair per access, where the pair holds a store: both become casts the rewrite writes, whose
   *  type is the access's width (and a signedness twin shares its set) */
  readonly castPairs: readonly (readonly [number, number])[];
  /** the target's device-register window, if it has one */
  readonly device: readonly [number, number] | undefined;
}

/** The refusals, in attribution order: the access, then the name, then the bytes. Each leaves the
 *  numeric access as the asm has it, so {@link cellSpelledTwice} still declines the function. */
export const NUMERIC_RESPELL_GATES: readonly Gate<NumericRespell>[] = [
  {
    id: 'not-one-literal-access',
    why: 'only a plain load or store whose address is one literal has one address to respell',
    sound: true,
    guardedBy:
      'offset-names.test.ts: without `not-one-literal-access` an access through a join of two literals is respelled',
    rejects: (c) => (c.op.opcode !== 'load' && c.op.opcode !== 'store') || c.placings !== 1,
  },
  {
    id: 'device-or-volatile',
    why: 'a numeric access to a device register or a volatile cell may be a qualified spelling no map name carries',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `device-or-volatile` a device register store is respelled through a name',
    rejects: (c) =>
      c.op.attrs.volatile === true || (c.device !== undefined && c.lo < c.device[1] && c.hi > c.device[0]),
  },
  // NOT sound, and the four after it are not either: each refuses a respell the re-run of
  // `cellSpelledTwice` would decline anyway (a second name over the byte meets the one chosen), or
  // one whose address is still the machine's (a name the map places twice, one read off it at the
  // partner's own address; a byte past a name's size, a const name a store would not compile
  // through). What they buy is that the rewrite never PICKS an owner the map does not give. A name
  // placed twice is asked first: the asm's own relocation of it stands for every address it is
  // placed at, which is a second object to the rule after.
  {
    id: 'name-placed-at-several',
    why: 'the map places the name at several addresses, so it names no one object here',
    sound: false,
    rejects: (c) => c.name !== null && c.addrs.length !== 1,
  },
  {
    id: 'two-names-reach-the-byte',
    why: 'two different names reach the byte, so no one name is the object the access belongs to',
    sound: false,
    rejects: (c) => c.name === null || c.partnerSeveral,
  },
  {
    id: 'name-not-plain-data',
    why: 'a macro, a function or a const-declared name is not an object the access may be spelled through',
    sound: false,
    rejects: (c) =>
      c.macro || c.infos.length === 0 || c.infos.some((i) => i.kind === 'code' || (c.writes && i.const === true)),
  },
  {
    id: 'outside-the-name',
    why: 'the bytes lie before the name or past its declared size, so they are not its object',
    sound: false,
    rejects: (c) => {
      const at = c.addrs[0];
      const size = c.infos.find((i) => i.size !== undefined)?.size;
      return at === undefined || c.lo < at || (size !== undefined && c.hi > at + size);
    },
  },
  {
    id: 'map-names-another-object',
    why: 'the map places another name over the bytes, so the one this function walks to is not their only owner',
    sound: false,
    rejects: (c) => c.otherName !== null,
  },
  // agbcc gives each integer TYPE its own alias set (char is set 0, a type shares one with its
  // unsigned twin, each pointer type has its own), and reorders a load past a store of another
  // set even on one object. Spelled through one name, the respelled cast and the name's own access
  // need not share a set unless one is char-wide, or both are one halfword-or-narrower type: a
  // 4-byte cell may be declared a pointer, which a `u32` cast does not alias. An access through the
  // name at a runtime index is a partner of unknown bytes (agbcc forwards `((u32 *)&g)[i] = 5` past
  // `((u16 *)&g)[28] = 7` to the `[i]` reload). Asked on every compiler: agbcc's is the one
  // measured (`g = 5; ((u16 *)&g)[1] = 7; return g;` is `strh; mov r0, #0x5`), and a compiler that
  // keeps no alias sets only declines a pair it could have lifted.
  // Two accesses one literal renames TOGETHER are two casts the rewrite writes, so one width is one
  // integer type there and only different widths neither char-wide may differ.
  {
    id: 'alias-sets-may-differ',
    why: 'a store and an overlapping access of other widths may sit in different alias sets on one object',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `alias-sets-may-differ` a halfword store is respelled beside a word',
    rejects: (c) =>
      c.widthPairs.some(([a, b]) => a !== 1 && b !== 1 && (a !== b || a > 2)) ||
      c.castPairs.some(([a, b]) => a !== 1 && b !== 1 && a !== b),
  },
];

/** Respell each numeric access {@link cellSpelledTwice} declines on beside a name, through that
 *  name, where {@link NUMERIC_RESPELL_GATES} admits it ({@link NumericRespell} says why that is
 *  exact). In place, at the map's one address for the name, one of two ways:
 *
 *   • THE LITERAL ITSELF, where the access's address is one `const` (plus constant displacements)
 *     at or past the name's address: it becomes `gaddr name + K`, and every use of it with it — the
 *     asm loaded ONE pool word, which the C then spells once and the compiler loads once. Only when
 *     the gates admit, through that name and at its own bytes, EVERY access the literal reaches
 *     ({@link accessesReachedBy}), the ones in no pair included: renaming the literal renames them
 *     all, and a sibling past the name's size, under another map name or in the device window
 *     would otherwise take an owner the gates exist to refuse.
 *   • THE ACCESS, otherwise (an address folded from several literals, or one below the name): its
 *     address becomes `gaddr name + K` built beside it, its displacement folded into `K`, and what
 *     the literal fed elsewhere keeps its spelling.
 *
 *  Either way the value is the address the machine computed. Repeats until nothing more is
 *  admitted, because an access respelled may meet a second numeric one over a byte it now names.
 *  Returns the name once per respelled access.
 *
 *  It only ever rewrites an access in a pair {@link cellSpelledTwice} would decline on, so a
 *  function that lifts without it lifts without it unchanged; the caller asks
 *  {@link cellSpelledTwice} again afterwards, and any pair left — two names, a refused gate, a use
 *  of a respelled literal that now meets another spelling — still declines. */
export function respellNumericThroughName(
  fn: Fn,
  symbols: SymbolMap,
  behaviors: OffsetNameBehaviors,
  gates: readonly Gate<NumericRespell>[] = NUMERIC_RESPELL_GATES,
): string[] {
  const out: string[] = [];
  for (;;) {
    const judged = numericRespellSites(fn, symbols, behaviors).map((s) => ({ s, no: firstRejection(gates, s) }));
    const sites = judged.filter((j) => j.no === null).map((j) => j.s);
    if (sites.length === 0) {
      return out;
    }
    const refused = new Set(judged.filter((j) => j.no !== null).map((j) => j.s.op));
    const defOf = defOpMap(fn);
    const literalOf = (op: Op): Op | null => {
      const a = op.operands[0];
      const d = defOf.get(constDisplacementOf(defOf, a)?.root ?? a);
      return d?.opcode === 'const' && typeof d.attrs.value === 'number' ? d : null;
    };
    const census = respellCensus(fn, symbols, behaviors);
    // The accesses the literal reaches are renamed TOGETHER, so each is judged with the others
    // already spelled `name`: a pair among them (a word store, a halfword store and a word reload
    // off one pool word) is a pair of one object's accesses after the rewrite, and the alias-set
    // rule has to see it — the census alone holds them all numeric, and pairs none of them.
    const keepsLiteral = (lit: Op, name: string): boolean => {
      const reached = accessesReachedBy(fn, lit);
      const together = new Set(reached);
      return reached.some((a) => {
        if (refused.has(a) || a.opcode === 'aload' || a.opcode === 'astore') {
          return true;
        }
        const c = respellCase(a, name, census, together);
        return c === null || firstRejection(gates, c) !== null;
      });
    };
    const named = new Set<Op>();
    for (const s of sites) {
      const at = s.addrs[0];
      const gaddr = (g: Value): Op =>
        mkOp('gaddr', { results: [g], attrs: { sym: s.name!, fromMap: true, mapAddr: at >>> 0 } });
      const lit = literalOf(s.op);
      if (lit !== null && named.has(lit)) {
        // this round already spelled the literal through a name; the next round's
        // `cellSpelledTwice` pair says whether it was this one
        out.push(s.name!);
        continue;
      }
      const value = lit === null ? null : (lit.attrs.value as number) >>> 0;
      if (lit !== null && value !== null && value >= at && !keepsLiteral(lit, s.name!)) {
        named.add(lit);
        const block = fn.blocks.find((b) => b.ops.includes(lit))!;
        if (value === at) {
          lit.opcode = 'gaddr';
          lit.attrs = { sym: s.name!, fromMap: true, mapAddr: at >>> 0 };
        } else {
          const g = mkValue(T.unk(32));
          const k = mkValue(T.unk(32));
          block.ops.splice(
            block.ops.indexOf(lit),
            0,
            gaddr(g),
            mkOp('const', { results: [k], attrs: { value: value - at } }),
          );
          lit.opcode = 'add';
          lit.operands = [g, k];
          lit.attrs = {};
        }
        out.push(s.name!);
        continue;
      }
      const block = fn.blocks.find((b) => b.ops.includes(s.op))!;
      const g = mkValue(T.unk(32));
      const ops = [gaddr(g)];
      let addr = g;
      if (s.lo !== at) {
        const k = mkValue(T.unk(32));
        addr = mkValue(T.unk(32));
        ops.push(mkOp('const', { results: [k], attrs: { value: s.lo - at } }));
        ops.push(mkOp('add', { operands: [g, k], results: [addr] }));
      }
      block.ops.splice(block.ops.indexOf(s.op), 0, ...ops);
      s.op.operands = [addr, ...s.op.operands.slice(1)];
      s.op.attrs = { ...s.op.attrs, off: 0 };
      out.push(s.name!);
    }
  }
}

/** Every numeric access in a pair {@link cellSpelledTwice} declines on beside a name, with what
 *  the gates read — what the rewrite and {@link numericRespellRefusals} both judge. */
function numericRespellSites(fn: Fn, symbols: SymbolMap, behaviors: OffsetNameBehaviors): NumericRespell[] {
  const declined = new Set<Op>();
  for (const c of spellingConflicts(fn, symbols, behaviors.reloadsAcrossSpellings === true)) {
    if ((c.x.spelling === null) !== (c.y.spelling === null)) {
      declined.add((c.x.spelling === null ? c.x : c.y).op);
    }
  }
  if (declined.size === 0) {
    return [];
  }
  const census = respellCensus(fn, symbols, behaviors);
  return [...declined].map((op) => respellCase(op, undefined, census)!);
}

/** What {@link respellCase} reads off the whole function: its placed accesses, the map, and the
 *  accesses through a name the map cannot place (`unplacedThrough`). */
interface RespellCensus {
  readonly placed: readonly PlacedAccess[];
  readonly places: Map<string, Places>;
  readonly fold: (v: Value) => number | null;
  readonly symbols: SymbolMap;
  readonly behaviors: OffsetNameBehaviors;
  /** each access whose address a `gaddr` of `name` reaches ({@link accessesReachedBy}) and which
   *  {@link placeAccess} does not place — a runtime index off the name — with its width */
  readonly unplacedThrough: (name: string) => readonly { readonly width: number; readonly writes: boolean }[];
}

function respellCensus(fn: Fn, symbols: SymbolMap, behaviors: OffsetNameBehaviors): RespellCensus {
  const at = placedAccesses(fn, symbols);
  const placedOps = new Set(at.placed.map((p) => p.op));
  const memo = new Map<string, { width: number; writes: boolean }[]>();
  const unplacedThrough = (name: string): { width: number; writes: boolean }[] => {
    let out = memo.get(name);
    if (out === undefined) {
      const ops = new Set<Op>();
      for (const b of fn.blocks) {
        for (const op of b.ops) {
          if (op.opcode === 'gaddr' && op.attrs.sym === name) {
            for (const a of accessesReachedBy(fn, op)) {
              if (!placedOps.has(a)) {
                ops.add(a);
              }
            }
          }
        }
      }
      out = [...ops].map((a) => ({
        width: (a.opcode === 'load' || a.opcode === 'store' ? a.attrs.width : a.attrs.elemSize) as number,
        writes: a.opcode === 'store' || a.opcode === 'astore',
      }));
      memo.set(name, out);
    }
    return out;
  };
  return { ...at, symbols, behaviors, unplacedThrough };
}

/** The case the gates judge for the numeric access `op`, spelled through `through` — the name a
 *  site's overlapping accesses give it when `through` is undefined, or the name a literal the
 *  access shares with a site would give it ({@link accessesReachedBy}). `together` holds the
 *  accesses renamed through `through` along with `op`, each counted as spelled `through`. Null
 *  when the map does not place `op`. */
function respellCase(
  op: Op,
  through: string | undefined,
  census: RespellCensus,
  together: ReadonlySet<Op> = new Set(),
): NumericRespell | null {
  const { placed, places, symbols, behaviors } = census;
  const mine = placed.filter((p) => p.op === op);
  const x = mine[0];
  if (x === undefined) {
    return null;
  }
  const [lo, hi] = x.ranges[0];
  const spellingOf = (y: PlacedAccess): string | null =>
    y.spelling ?? (through !== undefined && together.has(y.op) ? through : null);
  const overlapping = placed.filter(
    (y) =>
      y.op !== op && spellingOf(y) !== null && (x.writes || y.writes) && y.ranges.some(([l, h]) => l < hi && lo < h),
  );
  const names = new Set(overlapping.map((y) => spellingOf(y)!));
  if (through !== undefined) {
    names.add(through);
  }
  const name = names.size === 1 ? [...names][0] : null;
  const addrs = name === null ? [] : (places.get(name)?.addrs ?? []);
  const infos = addrs.length === 1 ? (symbols.get(addrs[0]) ?? []).filter((i) => i.name === name) : [];
  let otherName: string | null = null;
  for (const [a, entries] of symbols) {
    for (const i of entries) {
      if (i.name !== name && a < hi && lo < a + (i.size ?? 1)) {
        otherName ??= i.name;
      }
    }
  }
  return {
    op,
    placings: mine.length,
    lo,
    hi,
    names,
    partnerSeveral: overlapping.some((y) => y.objects.length !== 1),
    name,
    addrs,
    infos,
    macro: name !== null && places.get(name)?.macro === true,
    writes: x.writes,
    otherName,
    widthPairs: [
      ...overlapping
        .filter((y) => y.spelling === name)
        .flatMap((y) => y.ranges.map(([l, h]) => [hi - lo, h - l] as const)),
      ...(name === null ? [] : census.unplacedThrough(name))
        .filter((u) => x.writes || u.writes)
        .map((u) => [hi - lo, u.width] as const),
    ],
    castPairs: overlapping
      .filter((y) => y.spelling === null)
      .flatMap((y) => y.ranges.map(([l, h]) => [hi - lo, h - l] as const)),
    device: behaviors.deviceRegisters,
  };
}

/** Every access whose address the value of the literal `lit` reaches through arithmetic and joins:
 *  what spelling the literal through a name respells along with it. One reached through a constant
 *  displacement — a constant added to a constant among them (`ldr r2, =K; add r1, r1, r2`) — is
 *  placed, and judged at its own bytes; one past a runtime index is not, and keeps the literal. A
 *  use that is no address (a call argument, a stored value) is the pointer's VALUE, which spelling
 *  it through the name does not move. */
function accessesReachedBy(fn: Fn, lit: Op): Op[] {
  const users = new Map<Value, Op[]>();
  const params = new Map<Value, Value[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const v of op.operands) {
        (users.get(v) ?? users.set(v, []).get(v)!).push(op);
      }
      for (const s of op.successors) {
        if (s.block !== fn.blocks[0]) {
          s.args.forEach((v, i) => {
            if (i < s.block.params.length) {
              (params.get(v) ?? params.set(v, []).get(v)!).push(s.block.params[i]);
            }
          });
        }
      }
    }
  }
  const out = new Set<Op>();
  const seen = new Set<Value>();
  const work = [...lit.results];
  for (let v = work.pop(); v !== undefined; v = work.pop()) {
    if (seen.has(v)) {
      continue;
    }
    seen.add(v);
    work.push(...(params.get(v) ?? []));
    for (const u of users.get(v) ?? []) {
      const access = u.opcode === 'load' || u.opcode === 'store' || u.opcode === 'aload' || u.opcode === 'astore';
      if (access && u.operands[0] === v) {
        out.add(u);
      } else if (!access && u.opcode !== 'call' && u.results.length === 1) {
        work.push(u.results[0]);
      }
    }
  }
  return [...out];
}

/** Which rule refused each numeric access {@link respellNumericThroughName} would judge in `fn`
 *  as it stands, as `[0x<first byte>, reason]` with `null` where it would be respelled. NOT on the
 *  shipped path: the attribution a test or a census asks for, off the same sites. */
export function numericRespellRefusals(
  fn: Fn,
  symbols: SymbolMap,
  behaviors: OffsetNameBehaviors = { contextGlobals: undefined },
  gates: readonly Gate<NumericRespell>[] = NUMERIC_RESPELL_GATES,
): readonly (readonly [string, string | null])[] {
  return numericRespellSites(fn, symbols, behaviors).map(
    (s) => [`0x${s.lo.toString(16)}`, firstRejection(gates, s)] as const,
  );
}

/** The names {@link nameOffsetAddresses} spelled that no pool word of the asm spelled, in two
 *  kinds because each rests on a different fact a reader checks. */
export interface OffsetNamesSpelled {
  /** reached by arithmetic: `addr(base) + K` landing on the map entry named, once per site in
   *  block order — the BASE's address in the map is load-bearing */
  readonly walked: string[];
  /** a numeric address respelled through the one name this function also reaches its bytes by
   *  ({@link respellNumericThroughName}), each name once — the name's address and size in the
   *  map are load-bearing, and so is the premise that the number was not the source's own */
  readonly respelled: string[];
}

/** Rewrite every admitted site into the `gaddr` the map names, in place. Returns THE NAMES it
 *  spelled — what a caller has to be told, because a name this pass produced does not rest on the
 *  map alone the way a pool-loaded one does ({@link OffsetNamesSpelled} says what each kind rests
 *  on). `DecompileResult.walkedNames` / `respelledNames` and the trace's `stage:offsetnames` carry
 *  them out; nothing else can tell from a result that a walk was named.
 *
 *  It is also where the lift's names become FINAL, so it declines a function whose accesses reach
 *  one byte under two spellings ({@link cellSpelledTwice}), whichever pass named them — after
 *  spelling a numeric access of such a pair through the name beside it where that is exact
 *  ({@link respellNumericThroughName}). */
export function nameOffsetAddresses(
  fn: Fn,
  symbols: SymbolMap,
  behaviors: OffsetNameBehaviors,
  gates: readonly Gate<OffsetAddress>[] = OFFSET_NAME_GATES,
  respellGates: readonly Gate<NumericRespell>[] = NUMERIC_RESPELL_GATES,
): OffsetNamesSpelled {
  // Every site is judged against the PRE-REWRITE defs, so a chain's later links resolve through
  // the base they were lifted from and the answer does not depend on the order links are visited.
  const admitted = offsetSites(fn, symbols).filter((s) => firstRejection(gates, s.addr) === null);
  for (const s of admitted) {
    s.op.opcode = 'gaddr';
    s.op.operands = [];
    s.op.attrs = { sym: s.addr.target!.name, fromMap: true, mapAddr: s.at >>> 0 };
  }
  if (admitted.length > 0) {
    // An access now names another object, so whether it reads one the map declares volatile is
    // asked again before anything is deleted.
    stampDeclaredVolatileUnder(fn, symbols, behaviors);
    dce(fn); // the constants and the walked-off base the rewrite just orphaned
    verify(fn);
  }
  const reloads = behaviors.reloadsAcrossSpellings === true;
  let twice = cellSpelledTwice(fn, symbols, reloads);
  const respelled = twice === null ? [] : respellNumericThroughName(fn, symbols, behaviors, respellGates);
  if (respelled.length > 0) {
    stampDeclaredVolatileUnder(fn, symbols, behaviors);
    dce(fn); // the literals no access reads any more
    verify(fn);
    twice = cellSpelledTwice(fn, symbols, reloads);
  }
  if (twice !== null) {
    throw new RaiseUnsupportedError(
      `cannot lift '${fn.name}': ${twice} in one function — C the compiler would read as ` +
        `${twice.startsWith('byte') ? 'two objects, forwarding a store through one past the other' : 'one object'}`,
    );
  }
  return { walked: admitted.map((s) => s.addr.target!.name), respelled: [...new Set(respelled)] };
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
 *  (`apps/benchmark/src/run/gate-census.ts`, WHAT PUTS A PASS IN THE REGISTRY).
 *
 *  A record and not a pass LIST: the ordering question a list answers is already answered above,
 *  this pass having one seat. What a list also carries is the invariant that every driver picks a
 *  pass up, which three hand-written calls do not — so `offset-names.test.ts` supplies it by
 *  wrapping this record and asserting all three reach it. */
export const OFFSET_NAME_PASS: {
  run: (fn: Fn, symbols: SymbolMap, behaviors: OffsetNameBehaviors) => OffsetNamesSpelled;
} = {
  run: (fn, symbols, behaviors) => nameOffsetAddresses(fn, symbols, behaviors),
};
