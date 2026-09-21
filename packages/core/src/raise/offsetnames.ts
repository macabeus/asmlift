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
// nothing downstream can compute `addr(S) + K` at all. The address-keyed map exists only at the
// lift boundary, which is where this pass runs.
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
// WHAT REFUSES is `OFFSET_NAME_GATES` below, and every rejection leaves the arithmetic exactly as
// the frontend emitted it — the spelling that is valid under any declaration.
//
// WHICH GATE BOUNDS THE CORPUS PATH, off `offsetNameRefusals` over every row of both tiers that
// lifts with a map. Twenty sites, and only two rules decide any of them:
//
//   NAMED             7 sites, 3 rows   kleod `DeleteAllSaveData` (×3),
//                                       `ButtonConfigurationScreenInit` (×3), `sub_0804E708`
//   interior-offset  12 sites, 5 rows   `pokeemerald:TrySetCantSelectMoveBattleScript` (×4),
//                                       `synthetic:sbscope` (×3), `marioparty3:GWBoardRecordGet`
//                                       (×2), `pokeemerald:Cmd_tryconversiontypechange`,
//                                       `kleod:sub_08045F68`'s `gSineTable+128`
//   base-unsized      1 site,  1 row    `snowboardkids2:func_80014440_15040`'s
//                                       `gDefaultFontPalette+2`
//
// The other four rules refuse NOTHING in this corpus and are pinned by `offset-names.test.ts`
// alone. They are the sound ones — a code address at either end, a store onto a `const` name, a
// base the map places twice — so the path is bounded by the two heuristics and guarded by four
// rules with no measured reach. Say so rather than letting the table read as though all seven
// were load-bearing here.
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
}

/** The refusals. FIRST rejection is what `offsetNameRefusals` reports, so the order is the
 *  attribution order: the three rules about what the map can say about the BASE come before the
 *  four about what sits at the offset. The two that are not `sound` are about OWNERSHIP and
 *  ABSENCE rather than correctness — an interior address is the field and element machinery's to
 *  spell, and where no symbol sits there the arithmetic is simply the only name available. */
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
  {
    id: 'base-unsized',
    why: 'the base declares no size, so nothing here can tell its own interior from a neighbour',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `base-unsized` an unsized base is walked off as though it ended',
    rejects: (c) => c.base.size === undefined,
  },
  {
    id: 'interior-offset',
    why: 'the address lands inside the base object, which the field and element spellings own',
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
  {
    id: 'const-target-store',
    why: 'a store through a const-declared name does not compile',
    sound: true,
    guardedBy: 'offset-names.test.ts: without `const-target-store` the store walks onto a const-declared name',
    rejects: (c) => c.written && c.target?.const === true,
  },
];

/** Every name the map carries, with the FIRST address it sits at and whether it sits at more than
 *  one. The reverse of the address-keyed map, which is the direction `addr(S) + K` needs and the
 *  only direction `SymbolMap` does not already have. */
function addressesByName(symbols: SymbolMap): Map<string, { addr: number; info: SymbolInfo; twice: boolean }> {
  const out = new Map<string, { addr: number; info: SymbolInfo; twice: boolean }>();
  for (const [addr, infos] of symbols) {
    for (const info of infos) {
      const prev = out.get(info.name);
      if (prev === undefined) {
        out.set(info.name, { addr, info, twice: false });
      } else {
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
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'store' || op.opcode === 'astore') {
        written.add(op.operands[0]);
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

/** Which rule refused each offset site this function builds, keyed by `<base>+<offset>`, or null
 *  where the site was named — the attribution `firstRejection` exists for. NOT on the shipped
 *  path: a caller instrumenting a refusal asks here instead of re-deriving the predicates. */
export function offsetNameRefusals(
  fn: Fn,
  symbols: SymbolMap,
  gates: readonly Gate<OffsetAddress>[] = OFFSET_NAME_GATES,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const s of offsetSites(fn, symbols)) {
    out.set(`${s.sym}${s.addr.offset < 0 ? '-' : '+'}${Math.abs(s.addr.offset)}`, firstRejection(gates, s.addr));
  }
  return out;
}
