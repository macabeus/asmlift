// asmlift structurer — the gate tables of SSA destruction's naming walk, each with the candidate it
// judges: whether a merge rooted in an entry parameter takes a home of its own
// (`FRESH_MERGE_GATES`, its enumeration gate `hasParamRootedMerge`), which name a block parameter
// may be spelled with (`CARRIER_NAME_GATES`), and when a loop carrier takes its enclosing loop's
// name (`ENCLOSING_CARRIER_GATES`). Data, so a test can drop one gate and run the real pass
// (`StructureHooks`); structure.ts's `canTakeName` and seeding are where they are asked.
import { Fn, Value } from '../ir/core';
import type { IrType } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';

/** One carrier offered to one merge slot, as `FRESH_MERGE_GATES` judges it. */
export interface FreshMergeCarrier {
  /** every in-edge passes the SAME value, so the merge is a pure alias of the carrier */
  readonly allSame: boolean;
  /** the carrier is an entry parameter, or a merge home this rule itself minted */
  readonly paramRooted: boolean;
}

/** `freshParamMerge`'s admission: may this merge take its OWN home instead of the carrier's name?
 *  Nothing here is `sound` — both spellings are ordinary C over the same values, so `rank.ts`
 *  enumerates the ON one as `/fresh-merge` and the differ referees it. What keeps them two
 *  SPELLINGS rather than two PROGRAMS is `canTakeName`'s carrier width/sign check, which runs on
 *  the same carrier one step earlier.
 *
 *  WHAT THE SPELLING BUYS: a parameter is live from entry, so its name pins the value to the
 *  register the ABI handed it; a fresh local is dead until its first arm, so the compiler may place
 *  the copy where the asm has it. Which merges actually needed a register of their own is not
 *  recoverable from the C, and the rule is ALL-OR-NOTHING over a function's param-rooted slots. On
 *  `max3` (agbcc -O2, scored against its own target) only the SECOND of the two chained merges is
 *  load-bearing: re-homing just the first is byte-identical to re-homing neither (score 5), and
 *  re-homing just the second is byte-identical to re-homing both (score 0, MATCH). Splitting the
 *  decision per slot would be a fan of 2^slots, so the variation offers the whole-function spelling.
 *
 *  `param-rooted` is a SCOPE, not a derivation. A chain rooted in an ordinary merge home is left
 *  alone, and widening to one is a different, unmeasured variation: 293 of 721 map-less corpus rows
 *  carry at least one conditional merge slot (925 slots), of which the param rooting admits 109 —
 *  `LoadBGTilemapData` is one of the other 184, which is why the variation has no reach there — a RECORD
 *  of a measurement, not a live check: that function is in no corpus row and no fixture here (its
 *  attribution evidence is docs/lbg-attribution.md), so it cannot be re-run from this repo.
 *
 *  The rooting is over carrier VALUES, and two shapes carry a parameter's value past it under
 *  another name, both reach-only: a redundant phi keeps the parameter's own name (`redundant-phi`)
 *  and its result is then an ordinary carrier, which fires on 0 of 721 lifted corpus rows; and the
 *  minted-home set records only merges that ended up FRESH, so a merge that refuses a parameter and
 *  then adopts an ordinary local is not recorded — 336 firings over 6 rows. */
export const FRESH_MERGE_GATES: readonly Gate<FreshMergeCarrier>[] = [
  {
    id: 'redundant-phi',
    why: 'a merge every edge feeds the same value overwrites nothing, so a local of its own only adds a copy',
    sound: false,
    guardedBy: 'fresh-merge.test.ts: a redundant phi over one parameter keeps the parameter',
    rejects: (c) => c.allSame,
  },
  {
    id: 'param-rooted',
    why: 'a merge fed by a chain that does not start at a parameter keeps its ordinary local',
    sound: false,
    guardedBy: 'fresh-merge.test.ts: a merge over ordinary locals is untouched',
    rejects: (c) => !c.paramRooted,
  },
];

/** Whether any merge slot could reach `FRESH_MERGE_GATES` at all: an in-edge argument list that
 *  differs and includes an entry parameter — what `rank.ts` gates enumeration of `/fresh-merge` on.
 *  An OVER-approximation, which is the safe direction for a gate that only decides whether to
 *  enumerate: the walk can still refuse
 *  the carrier (`carriesPreUpdate`, `canTakeName`), and a slot whose carrier is a home this rule
 *  mints is not visible here at all. */
export function hasParamRootedMerge(fn: Fn): boolean {
  const entryParams = new Set<Value>(fn.blocks[0].params);
  return fn.blocks.slice(1).some((b) =>
    b.params.some((_, i) => {
      const args = fn.blocks.flatMap((pr) =>
        pr.ops[pr.ops.length - 1].successors.filter((sx) => sx.block === b).map((sx) => sx.args[i]),
      );
      return args.some((a) => a !== args[0]) && args.some((a) => entryParams.has(a));
    }),
  );
}

/** True when the merge takes its own home. The table is a parameter so a test can drop one gate and
 *  re-run the real pass (`StructureHooks.freshMergeGates`). */
export function reHomesParamMerge(
  c: FreshMergeCarrier,
  gates: readonly Gate<FreshMergeCarrier>[] = FRESH_MERGE_GATES,
): boolean {
  return firstRejection(gates, c) === null;
}

/** One name offered to one block parameter, as `CARRIER_NAME_GATES` judges it.
 *
 *  THE FIELDS ARE LAZY, and that is a cost decision rather than a style one. `canTakeName` runs per
 *  merge slot per carrier over every named value in the function, and `NAME_COALESCE_GATES`' eager
 *  record is affordable only because its pass is an opt-in variation. Laziness changes nothing about
 *  BLAME: `firstRejection` reports the first gate in TABLE order that rejects, whichever fields
 *  were computed to get there. What it does mean is that the table's order also decides what runs,
 *  so the two whole-function walks sit at the bottom. */
export interface CarrierName {
  /** the merge is a pure alias — every in-edge hands it the same value */
  readonly pureAlias: boolean;
  /** the name offered is that value's OWN, not a loop variable's name offered through its back edge */
  readonly ownName: boolean;
  /** the name's declaration and the parameter disagree about carrier width */
  readonly widthDiffers: boolean;
  /** …or, at a sub-word width, about signedness — which at that width is part of the width */
  readonly signDiffers: boolean;
  /** another parameter of the SAME block already holds the name */
  readonly siblingHolds: boolean;
  /** a value under the name is still live where the parameter's in-edge copies land */
  readonly carrierLive: boolean;
  /** the name is written somewhere the parameter is still live — at a materialized definition
   *  under it, or at any block a predecessor of another parameter's block reaches, which is that
   *  block itself plus wherever a loop emitter could move the copy to */
  readonly carrierWritten: boolean;
  /** a value with no name of its own re-derives the name at a use past the copy */
  readonly reDerivesName: boolean;
  /** …or reads it through a loop's back-edge argument, which carries the loop variable's name
   *  (`backArgName`) and renders as that name past its loop */
  readonly backArgReadsName: boolean;
}

/** `canTakeName`'s admission: may this block parameter be SPELLED with a name that already exists,
 *  so the in-edge copies into it disappear? EVERY rule here is sound — a refusal costs one copy in
 *  the emitted C, and an admission this table gets wrong is a program that computes something else.
 *  The argument for each is in the block comment above `canTakeName`, which has room for it.
 *
 *  `carrier-write` carries the one approximation in the table. A loop emitter rotates the header's
 *  update copy to the BOTTOM of the body, where it also runs on the exiting iteration, so a write
 *  nominally on a back edge lands on the exit path too. Liveness cannot see a placement, so the
 *  rule takes the conservative union over every block the writing edge's predecessor reaches. */
export const CARRIER_NAME_GATES: readonly Gate<CarrierName>[] = [
  {
    id: 'carrier-width',
    why: 'the copies into the name are assignments through its declaration, which would truncate',
    sound: true,
    guardedBy: 'fresh-merge.test.ts: a merge WIDER than its parameter carrier takes a fresh home',
    rejects: (c) => c.widthDiffers,
  },
  {
    id: 'carrier-sign',
    why: 'a narrow declaration IS the extension it replaced, and u8 re-applies a different one',
    sound: true,
    guardedBy: 'carrier-name.test.ts: ablating carrier-sign reads an s8 carrier through a u8 name',
    rejects: (c) => c.signDiffers,
  },
  {
    id: 'sibling-param',
    why: 'two parameters of one block share every in-edge, so one edge would write the name twice',
    sound: true,
    guardedBy: 'carrier-name-fuzz.test.ts: every SOUND gate of CARRIER_NAME_GATES is load-bearing',
    rejects: (c) => c.siblingHolds,
  },
  {
    id: 'carrier-live',
    why: 'a value under the name still live here is what the in-edge copies would overwrite',
    sound: true,
    guardedBy: 'carrier-name-fuzz.test.ts: every SOUND gate of CARRIER_NAME_GATES is load-bearing',
    rejects: (c) => !c.pureAlias && c.carrierLive,
  },
  {
    id: 'carrier-write',
    why: 'the converse — the name must not be written anywhere the parameter is still live',
    sound: true,
    guardedBy: 'carrier-name.test.ts: ablating carrier-write reads a loop variable past its sunk update',
    rejects: (c) => c.carrierWritten,
  },
  {
    id: 're-derives',
    why: 'an unnamed live value is re-rendered at its use, and would read the name written here',
    sound: true,
    guardedBy: 'name-clobber.test.ts: the inlined difference keeps reading the value the asm computed it from',
    rejects: (c) => !c.pureAlias && c.reDerivesName,
  },
  {
    // A back-edge argument is in no `varName`: it takes the header's name unconditionally
    // (`seedLoopParams`), and the exit region's substitution renders it as that name after the loop.
    // So a merge there offered the same name overwrites it on every other in-edge. `int u; do { … u =
    // …; } while (--d > 0); return (c != 1 ? u : u + t) * u;` at mwcc: the merge took `u`'s name, and
    // its `else` copy overwrote the `u` the multiply still reads.
    id: 'back-arg-live',
    why: "a loop's back-edge value renders under the loop variable's name after the loop, and the copies would overwrite it",
    sound: true,
    guardedBy: 'name-clobber.test.ts: a back-edge argument live across a merge reads the name it carries',
    rejects: (c) => !c.pureAlias && c.backArgReadsName,
  },
  {
    // `carrier-live` and `re-derives` waive a pure alias because the alias and its value are equal on
    // every path under the value's own name. A loop variable's name holds the value only once the back
    // edge that carries it has run.
    id: 'alias-under-its-own-name',
    why: "a loop variable's name holds the value it is offered for only after the back edge that carries it",
    sound: true,
    guardedBy: 'carrier-name.test.ts: a redundant merge shares only its value’s own name, not a later loop variable’s',
    rejects: (c) => c.pureAlias && !c.ownName && (c.carrierLive || c.reDerivesName),
  },
];

/** A nested loop's header parameter offered its ENCLOSING loop's name, as
 *  `ENCLOSING_CARRIER_GATES` judges it — the admission `enclosingCarrierName` makes before
 *  `canTakeName` (`CARRIER_NAME_GATES`) is asked. `E` is the inner header's first forward
 *  predecessor and `a` the argument `E` hands the parameter.
 *
 *  Lazy for the same reason `CarrierName` is: `carriedByBoth` walks the in-edges of both headers,
 *  so it sits last and runs only when every cheaper rule admits. Every field is TOTAL — false when
 *  `E` or `a` does not exist — so a test can drop any one gate and the rest still answer. */
export interface EnclosingCarrier {
  /** every forward predecessor of the inner header is the one block `E`, and `E` is not the header */
  readonly oneForwardEntry: boolean;
  /** `E` heads a loop whose body holds the inner header */
  readonly entryEncloses: boolean;
  /** `a` is one of `E`'s own parameters — `E`'s loop-carried value, which `E` does not compute */
  readonly argIsEnclosingParam: boolean;
  /** the frontend measured `E`, and `E` wrote nothing into the parameter's key */
  readonly keyUnwritten: boolean;
  /** the value is carried by BOTH loops (`carriedByBothLoops`). False whenever `entryEncloses` or
   *  `argIsEnclosingParam` is, since it needs `E`'s loop and `a`'s slot in `E` — which is why no
   *  fixture can separate those two from this one. Independent of `keyUnwritten`, which no part of
   *  the walk consults */
  readonly carriedByBoth: boolean;
}

/** `enclosingCarrierName`'s own admission. The argument for each rule is the block comment above
 *  `enclosingCarrierName`; the ids are here so a refusal can be named and a rule dropped by a test.
 *
 *  ONE rule is sound, and it is the last. The four before it bound what the write-order record can
 *  be EVIDENCE for — a refusal keeps the two-variable spelling, which is correct by construction —
 *  so each is `sound: false`: dropping one spells a different, still-correct program (the fixtures
 *  in `nested-carrier.test.ts` show what each keeps). `carried-by-one-loop` is the collision
 *  `canTakeName` cannot see, and dropping it emits another program. */
export const ENCLOSING_CARRIER_GATES: readonly Gate<EnclosingCarrier>[] = [
  {
    id: 'one-forward-entry',
    why: 'the record is per predecessor, so it cannot vouch for a second edge into the inner header',
    sound: false,
    rejects: (c) => !c.oneForwardEntry,
  },
  {
    id: 'enclosing-header',
    why: 'only the enclosing header itself has a record that can say the entry copy was not made',
    sound: false,
    rejects: (c) => !c.entryEncloses,
  },
  {
    id: 'enclosing-param',
    why: 'only a value the enclosing header did not compute can have reached the inner loop uncopied',
    sound: false,
    rejects: (c) => !c.argIsEnclosingParam,
  },
  {
    id: 'key-written',
    why: 'the enclosing header wrote the key (or was not measured): the source spelled the copy',
    sound: false,
    rejects: (c) => !c.keyUnwritten,
  },
  {
    id: 'carried-by-one-loop',
    why: 'a value the outer back edge replaces would be overwritten under a name the inner loop reads',
    sound: true,
    guardedBy: 'nested-carrier.test.ts: ablating carried-by-one-loop lets the outer update clobber the inner value',
    rejects: (c) => !c.carriedByBoth,
  },
];

/** The two facts a merge carrier's declared type contributes to `canTakeName` — see the rule's own
 *  comment there for why the signedness half is part of the width at sub-word sizes. */
export function carrierWidth(t: IrType | undefined): number {
  return t?.kind === 'int' ? t.width : 32;
}
export function carrierSign(t: IrType | undefined): boolean | undefined {
  return t?.kind === 'int' && t.width < 32 ? t.signed : undefined;
}
