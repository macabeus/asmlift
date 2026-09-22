// asmlift — A NARROW READ OF A WIDER FIELD, which the struct recognizers see as a second field at
// the same offset.
//
// WHAT IS MISSING WITHOUT THIS. A compiler asked for the low byte of a halfword member emits a byte
// load at the halfword's own address:
//
//     BlendPalette(..., task->data[6], ...)      // data[] is s16, the parameter is u8
//     ldrh r0, [r4, #0xc]        @ the member, read whole
//     ldrb r2, [r4, #0xc]        @ the same member, narrowed for the call
//
// The pass that groups a base's constant-offset accesses reads that as ONE OFFSET AT TWO WIDTHS and
// refuses: `raise/structs.ts`'s `buildStruct` throws "overlapping fields ... unions not modelled".
// The refusal is right about the SHAPE and wrong about the CAUSE — there is no second object here,
// only a cast — so a function carrying one declines whole. (`raise/memberarrays.ts`'s
// same-sounding `member-conflict` judges VARIABLE-INDEX accesses, `aload`/`astore`, and a base with
// any constant-offset load is already outside that pass by `direct-access`. It is a different shape
// and this fold does not reach it.)
//
// THE ASM DOES NOT SAY WHICH IT IS, and that is the point: a union, a cast, a bitfield and two
// adjacent bytes the compiler fused all produce the same two instructions. What this pass claims is
// narrower than any of those readings. `(u8)x` and a byte load of `x`'s low-order byte denote THE
// SAME BYTES AND THE SAME VALUE, so rewriting one into the other invents no type and loses no
// fidelity; what the struct recognizers then do with a base carrying one width instead of two is
// their existing job, refereed by the differ as before.
//
// MEASURED, not argued, on the row that motivated it
// (`pokeemerald:AnimTask_FlashHealthboxOnLevelUp_Step:agbcc`): the reference source declares ONE
// `s16` member at offset 12 and passes it to a `u8` parameter, and agbcc compiles that to the
// `ldrh`/`ldrb` pair above — `.text` sha256 `e0524eb341119a21`, 204 bytes, byte-identical to the
// target object. So the single-field layout this pass makes reachable is the layout the ROM was
// built from.
//
// WHAT IT DOES. Over the L1 fn, for every base with constant-offset accesses: a LOAD whose byte
// range is the LOW-ORDER END of a strictly wider access's range at the same base becomes a
// `zext`/`sext` — matching the narrow load's own signedness — of a fresh load at the wider range.
// No opcode, no representation, no level: `zext`/`sext` with a `width` attr already exist
// (`ir/opcodes.ts`), they already print as a C cast, and the backend already recompiles that cast
// to the narrow instruction on the compilers that emit it.
//
// THE FOLD WIDENS A READ, which is the one thing worth arguing about, and the two rules that bound
// it are `fixed-cell` and `covering-dominates` below. Neither is a restatement of what
// raise/structs.ts already claims, and the difference is what makes them rules rather than
// decoration: that pass declares a SINGLE LAYOUT covering every offset the function touches, which
// is a claim the compiler reads and no instruction executes, while this one emits a DEREFERENCE.
// Widening a read where the covering access is on the other arm of a branch would have the emitted
// program load bytes that no execution reaching that point ever loaded — a compile-time claim
// escalated into a runtime one. Widening a read of a cell at a constant address would change the
// event a device sees. So the range this fold widens to must be a range some access at the same
// base read ON THIS PATH, at a cell whose declaration cannot make its access width observable.
//
// LOW-ORDER END IS AN ENDIANNESS QUESTION, read off `capabilities.endianness` rather than assumed:
// the low bytes of a big-endian field sit at its TOP address (`lw 20(a0)` covering `lhu 22(a0)`),
// the low bytes of a little-endian one at its base. Both directions have a corpus inhabitant and
// the benchmark's `unitrunc` row carries both.
//
// WHICH GATE BOUNDS THE CORPUS PATH — `pnpm bench gates --pass truncload`, and the answer is the
// SOUND ones, per population. Over the synthetic tier on agbcc (322 rows) the census reads
// `covering-store 2, covering-dominates 2, fixed-cell 1`; on ido7.1 (166 rows) and gcc2.7.2kmc
// (171) `covering-store 2, high-order-read 2, fixed-cell 1`, the big-endian rows reaching the
// skew rule because `utag`'s union members are read at the field's TOP; on mwcc_242_81 (178)
// `covering-store 2, fixed-cell 1`. `high-order-read` is STARVED on agbcc — not because nothing
// skews there, but because `synthetic:uhalf`'s skewed read sits on a base whose widest access is
// the `u->w = v` STORE, so the earlier rule answers first. Real rows show two of them alone:
// `--only sa3:sub_804DC38:agbcc` reads `high-order-read 4`, an `ldrb` at byte 5 of a word at 4,
// and `--only kleod:WorldMapScreenUnlockNewWorld:agbcc` reads `fixed-cell 90` — a named global's
// cells, which is the same shape a named hardware register has. Two rules are UNINHABITED and say
// so rather than being left to look load-bearing: `unresolved-base` and `cast-width` are refusals
// no corpus row reaches, and both are pinned by a hand-written shape in the unit tests instead.
//
// A THIRD SHAPE IS ADMITTED AND SAYS SO RATHER THAN BEING CLAIMED SOUND: a cell reached at a
// RUNTIME index from a literal or a named base — `((vu16 *)0x4000000)[i]`, the GBA palette and DMA
// loops. `fixed-cell` does not fire there, because no constant address exists to read, and nothing
// else can: the IR for that loop and the IR for an element of an ordinary global array are the
// SAME IR, so refusing it would refuse every indexed access into a named object — including the
// map-less spelling of the row this pass was written for. It is a residue, it is unpriced, and the
// place it would be settled is the symbol map, not this pass.
//
// A NARROW STORE IS NOT A CANDIDATE AT ALL — the refusal is in the candidate builder below rather
// than in the gate table, and this is the table's named residue. Widening a write clobbers the
// bytes past it, and no cast spelling expresses a partial write: `(u8)p->f = v` is not C. A base
// whose conflict is a narrow STORE therefore keeps both widths and declines exactly as it did.
//
// THE SECOND RESIDUE, and it is the one that costs a row. A union read through members of three
// widths on three arms of a `switch` (`synthetic:utag`) is refused by `covering-dominates`, and
// the honest spelling for it is a `union` — a type this pass deliberately does not introduce, and
// which the corpus does not pin, since the asm cannot tell a union from a cast. So that row keeps
// declining. Widening its reads DOES compile byte-exactly on agbcc, which is exactly why the rule
// has to be a rule: the differ scores the sound and the unsound spelling the same, so nothing
// downstream would ever refuse it. A raise-level seam that enumerated both spellings and let the
// differ pick is the shape that could take this back; it is priced here and not built.
import { constAddressOf, globalCellOf } from '../ir/alias';
import { type Block, type Fn, type Op, type Value, defOpMap, dominators, mkOp, mkValue } from '../ir/core';
import { CAST_WIDTHS } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';
import { type Access, constOffsetAccesses } from './structs';

/** Ops through which a base address is still the SAME address question — the arithmetic a lift
 *  produces between a root and a load's operand. Anything else (a `load`, a `call`, a `laddr`) is
 *  a value the function obtained, which ENDS the walk: a pointer it was handed is an object the
 *  source declared, and there is nothing further to resolve. */
const ADDRESS_ARITHMETIC: ReadonlySet<string> = new Set(['add', 'sub', 'or', 'and', 'xor', 'shl', 'shr_u', 'shr_s']);

/** Does this base's origin RESOLVE — does the walk above reach a root it can name on every branch?
 *  An entry parameter, a literal, a named global and a loaded pointer all resolve; a block param
 *  joining two edges and an `undef` do not.
 *
 *  It answers ONE question and `fixed-cell` answers the other: whether the cell is at a constant
 *  address is asked of the resolved base, and a base that never resolved cannot be asked at all.
 *  WHY THE WALK IS HERE rather than composed out of ir/alias.ts's `constAddressOf` /
 *  `globalBaseOf`: both of those return null for "not one of these" AND for "cannot tell", so a
 *  caller composing them cannot separate a parameter from a join — and the join is the case that
 *  has to refuse. */
function baseResolves(defs: Map<Value, Op>, entryParams: ReadonlySet<Value>, v: Value): boolean {
  const d = defs.get(v);
  if (!d) {
    return entryParams.has(v);
  }
  if (d.opcode === 'undef') {
    return false;
  }
  return !ADDRESS_ARITHMETIC.has(d.opcode) || d.operands.every((o) => baseResolves(defs, entryParams, o));
}

/** What the gates below judge: one narrow LOAD and the access at its base that covers it. */
export interface TruncatedLoad {
  /** the narrow load reads a cell at a COMPILE-TIME CONSTANT address */
  fixedCell: boolean;
  /** the base's origin resolves — it is not a join the walk could not finish */
  resolvedBase: boolean;
  /** the covering access is a LOAD, so its signedness is read rather than invented */
  coveringLoad: boolean;
  /** the narrow bytes are the low-order end of the covering range on THIS target's endianness */
  lowOrderEnd: boolean;
  /** the covering access runs, on EVERY path that reaches the narrow load, before it */
  coveringDominates: boolean;
  /** the width in BITS the cast would carry */
  castWidth: number;
}

export const TRUNC_LOAD_GATES: readonly Gate<TruncatedLoad>[] = [
  {
    // SOUND, and it is the ACCESS WIDTH that is at stake rather than the value: a hardware register
    // answers a byte read and a halfword read differently, so reading two bytes where the machine
    // read one is an event the device sees. A memory-mapped register is a FIXED cell, and both
    // spellings a source has for one land here: the bare cast of a number (`*(vu16 *)0x4000004`)
    // through `constAddressOf`, and the named register (`REG_DISPSTAT`) through `globalCellOf`,
    // whose `volatile` is a declaration in the project's headers that no raise pass can read.
    // The two helpers are ir/alias.ts's, and they are the SAME pair structure.ts's
    // `volatileQualifiable` asks — so a load this rule admits is one that predicate answers no to,
    // by construction rather than by measurement.
    //
    // NOT `capabilities.deviceRegisters`. That window is documented as a question about SPELLING
    // and may be approximate (target.ts), so a soundness rule may not rest on it; asking whether
    // the address is constant at all is wider and needs nothing approximate.
    id: 'fixed-cell',
    why: 'a cell at a constant address can be a hardware register, where the access WIDTH is itself observable',
    sound: true,
    guardedBy: 'truncload.test.ts: a cell at a constant address is not narrowed',
    rejects: (c) => c.fixedCell,
  },
  {
    // SOUND, and the residue of the rule above rather than a rule of its own: a base that joins two
    // edges has no definition to walk, so `fixed-cell` cannot ask its question and the honest
    // answer is that this pass does not know what the base is. An `undef` base is the same shape —
    // storage nothing was entitled to write.
    id: 'unresolved-base',
    why: 'a base whose origin does not resolve cannot be shown not to be a device cell',
    sound: true,
    guardedBy: 'truncload.test.ts: a base joined on two edges is not narrowed',
    rejects: (c) => !c.resolvedBase,
  },
  {
    // The sibling narrowing passes' rule, under the sibling name (raise/paramwidth.ts,
    // raise/narrowlocal.ts): a width `CAST_WIDTHS` does not carry has no C cast to spell it, so the
    // fold would mint a `zext` the backend can only gap on. No corpus row reaches it today — every
    // frontend load is 1, 2 or 4 bytes — and it costs a line rather than an argument about which
    // widths a frontend may acquire.
    id: 'cast-width',
    why: 'only 8 and 16 are widths a `zext`/`sext` — and so a C declaration — carries',
    sound: true,
    guardedBy: 'truncload.test.ts: a width no C type spells is refused',
    rejects: (c) => !CAST_WIDTHS.has(c.castWidth),
  },
  {
    // A covering STORE fixes the bytes but not the field's signedness, and the fold has to put one
    // on the load it synthesizes. Not sound — the bytes are the same either way, so the worst case
    // is a field declared `u16` where the source wrote `s16` — but inventing a fact the asm did not
    // carry is not how a default spelling is chosen, and the differ never sees this one because the
    // synthesized load is not enumerated.
    id: 'covering-store',
    why: 'a covering store carries no signedness, so the field type would be invented rather than read',
    sound: false,
    rejects: (c) => !c.coveringLoad,
  },
  {
    // SOUND: a read of bytes ABOVE the field's low-order end is `(u16)(x >> 16)`, not `(u16)x`.
    // The cast spelling would read the field's other half — a different value from the one the
    // machine loaded, silently. The shifted form is expressible, but it is not what the narrow
    // instruction spells and nothing would recompile to it, so the honest answer is to leave the
    // base declining.
    id: 'high-order-read',
    why: 'bytes above the low-order end of a field are a shift, and a plain cast would read the wrong ones',
    sound: true,
    guardedBy: 'truncload.test.ts: a read above the low-order end is not narrowed',
    rejects: (c) => !c.lowOrderEnd,
  },
  {
    // SOUND, and the rule that separates this fold from the layout claim it feeds. Widening the
    // read puts a WIDER ACCESS at the point where the machine executed a narrower one, so the bytes
    // past the narrow range have to be bytes this execution already read — not merely bytes the
    // FUNCTION reads somewhere. raise/structs.ts declares one layout per base across the whole
    // function, which is a claim about the object's TYPE and costs no instruction; this fold emits
    // a dereference, so the same function-wide reasoning would have the program read three bytes it
    // never read on the path it is on. Dominance is what makes the two claims different sizes.
    id: 'covering-dominates',
    why: 'the bytes past the narrow read must be bytes this execution already read, not bytes some other path reads',
    sound: true,
    guardedBy: 'truncload.test.ts: a cover on the other arm of a branch is not narrowed',
    rejects: (c) => !c.coveringDominates,
  },
];

/** One admitted-or-refused fold: the narrow load, the access it truncates, and what the gates see. */
export interface TruncLoadCandidate {
  narrow: Access;
  covering: Access;
  c: TruncatedLoad;
}

/** Every narrow load an access at the same base covers, in program order.
 *
 *  WHICH COVER, when several cover the same narrow read: the pick is a TOTAL ORDER over facts, not
 *  a reduction over the order the accesses happen to be emitted in. A cover the sound rules can
 *  admit outranks one they cannot — `{w4@8, w4@6, w1@8}` folds whichever of the two wide reads was
 *  emitted first otherwise, so an identical access set would admit or refuse on instruction
 *  scheduling alone. After that the WIDEST wins, because a base read at 4, 2 and 1 bytes from one
 *  offset collapses to ONE field in a single pass that way where the closest cover would need a
 *  fixpoint; then a load over a store; then the earlier access. A cover is never itself a
 *  candidate, since a candidate is strictly narrower than its own cover. */
export function truncatedLoadCandidates(fn: Fn, littleEndian: boolean): TruncLoadCandidate[] {
  const { accessesOf } = constOffsetAccesses(fn);
  const defs = defOpMap(fn);
  const entryParams = new Set(fn.blocks[0].params);
  const dom = dominators(fn);
  const blockDominates = (a: number, b: number): boolean => dom.get(fn.blocks[b] as Block)!.has(fn.blocks[a] as Block);
  const runsBefore = (a: Access, b: Access): boolean =>
    a.block === b.block ? a.at < b.at : blockDominates(a.block, b.block);
  const isLowOrderEnd = (narrow: Access, cover: Access): boolean =>
    littleEndian ? narrow.off === cover.off : narrow.off + narrow.width === cover.off + cover.width;

  const out: TruncLoadCandidate[] = [];
  for (const b of fn.blocks) {
    for (const op of b.ops as Op[]) {
      if (op.opcode !== 'load') {
        continue;
      }
      const base = op.operands[0];
      const all = accessesOf.get(base)!;
      const narrow = all.find((a) => a.op === op)!;
      const covers = all.filter(
        (a) => a.width > narrow.width && a.off <= narrow.off && a.off + a.width >= narrow.off + narrow.width,
      );
      if (covers.length === 0) {
        continue;
      }
      const preference = (a: Access): number[] => [
        isLowOrderEnd(narrow, a) ? 1 : 0,
        runsBefore(a, narrow) ? 1 : 0,
        a.width,
        a.isLoad ? 1 : 0,
      ];
      const covering = covers.reduce((best, a) => {
        const [x, y] = [preference(a), preference(best)];
        const i = x.findIndex((v, k) => v !== y[k]);
        return i >= 0 && x[i] > y[i] ? a : best;
      });
      out.push({
        narrow,
        covering,
        c: {
          fixedCell: constAddressOf(defs, base, narrow.off) !== null || globalCellOf(defs, base, narrow.off) !== null,
          resolvedBase: baseResolves(defs, entryParams, base),
          coveringLoad: covering.isLoad,
          lowOrderEnd: isLowOrderEnd(narrow, covering),
          coveringDominates: runsBefore(covering, narrow),
          castWidth: narrow.width * 8,
        },
      });
    }
  }
  return out;
}

/** Rewrite every admitted narrow load into a cast of a wider one. Returns the number of rewrites.
 *
 *  `gates` is a REQUIRED argument, not an option with a default: the table is how the refusals are
 *  ablated, and a second caller that could omit it would switch the channel off silently. */
export function foldTruncatedLoads(fn: Fn, littleEndian: boolean, gates: readonly Gate<TruncatedLoad>[]): number {
  const admitted = truncatedLoadCandidates(fn, littleEndian).filter((k) => firstRejection(gates, k.c) === null);
  if (admitted.length === 0) {
    return 0;
  }
  const byBlock = new Map<number, TruncLoadCandidate[]>();
  for (const k of admitted) {
    const list = byBlock.get(k.narrow.block);
    if (list) {
      list.push(k);
    } else {
      byBlock.set(k.narrow.block, [k]);
    }
  }
  for (const [block, ks] of byBlock) {
    const b = fn.blocks[block];
    const inserted = new Map<number, Op>();
    for (const k of ks) {
      const wide = mkOp('load', {
        operands: [k.narrow.op.operands[0]],
        results: [mkValue(T.unk(32))],
        attrs: { off: k.covering.off, width: k.covering.width, signed: k.covering.signed },
      });
      inserted.set(k.narrow.at, wide);
      // REWRITTEN IN PLACE, so the result `Value` identity survives and every existing use — and
      // any slot home stamped on it (`ir/core.ts` SlotHomes) — keeps reading the same value. The
      // operand it drops is the base, which the fresh load above still reads, so nothing is
      // orphaned and the pass declares `dce: false`.
      k.narrow.op.opcode = k.narrow.signed ? 'sext' : 'zext';
      k.narrow.op.operands = [wide.results[0]];
      k.narrow.op.attrs = { width: k.narrow.width * 8 };
    }
    b.ops = b.ops.flatMap((op, at) => {
      const wide = inserted.get(at);
      return wide ? [wide, op] : [op];
    });
  }
  return admitted.length;
}
