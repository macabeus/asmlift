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
// THE FOLD WIDENS A READ, which is the one thing worth arguing about, and it adds NO assumption
// raise/structs.ts does not already make. The range it widens to is a range ANOTHER access at the
// same base already read, so the bytes are ones this function itself touches; and the pass this
// feeds declares a SINGLE layout covering every observed offset at that base, which is the same
// claim carried further. The case the asm genuinely cannot settle — one pointer reaching two
// different objects on two paths — is the case struct recovery is already wrong about, not one
// this fold introduces. Where the base could be something other than an object the source
// declared, `literal-base` below refuses it outright.
//
// LOW-ORDER END IS AN ENDIANNESS QUESTION, read off `capabilities.endianness` rather than assumed:
// the low bytes of a big-endian field sit at its TOP address (`lw 20(a0)` covering `lhu 22(a0)`),
// the low bytes of a little-endian one at its base. Both directions have a corpus inhabitant and
// the benchmark's `unitrunc` row carries both.
//
// WHICH GATE BOUNDS THE CORPUS PATH — `pnpm bench gates --pass truncload`, and the answer is the
// SOUND ones, per population. Over the synthetic tier on agbcc (322 rows) the census reads
// `covering-store 2, literal-base 1` and `high-order-read` is STARVED — not because nothing skews
// there, but because `synthetic:uhalf`'s skewed read sits on a base whose widest access is the
// `u->w = v` STORE, so the earlier rule answers first. On ido7.1 (166 rows) it reads
// `covering-store 2, high-order-read 2, literal-base 1`: the big-endian rows reach it because
// `utag`'s union members are read at the field's TOP. A real row shows it alone —
// `--only sa3:sub_804DC38:agbcc` reads `high-order-read 4`, an `ldrb` at byte 5 of a word at 4.
// So all three rules are inhabited, none of them is a cost gate, and the pass reaches what it
// reaches because the asm settles it.
//
// A NARROW STORE IS NOT A CANDIDATE AT ALL — the refusal is in the candidate builder below rather
// than in the gate table, and this is the table's named residue. Widening a write clobbers the
// bytes past it, and no cast spelling expresses a partial write: `(u8)p->f = v` is not C. A base
// whose conflict is a narrow STORE therefore keeps both widths and declines exactly as it did.
import { type Fn, type Op, type Value, defOpMap, mkOp, mkValue } from '../ir/core';
import { T } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';

/** One constant-offset access to a base, in first-appearance order. */
interface Access {
  op: Op;
  off: number;
  width: number;
  signed: boolean;
  isLoad: boolean;
}

/** What the gates below judge: one narrow LOAD and the widest access at its base that covers it. */
export interface TruncatedLoad {
  /** the base is a value the function computed, not a bare literal address */
  computedBase: boolean;
  /** the covering access is a LOAD, so its signedness is read rather than invented */
  coveringLoad: boolean;
  /** the narrow bytes are the low-order end of the covering range on THIS target's endianness */
  lowOrderEnd: boolean;
}

export const TRUNC_LOAD_GATES: readonly Gate<TruncatedLoad>[] = [
  {
    // SOUND, and it is the ACCESS WIDTH that is at stake rather than the value: a hardware register
    // answers a byte read and a halfword read differently, and reading two bytes where the machine
    // read one is an event the device sees. A literal address is how every target here spells one
    // (`*(vu16 *)0x4000004`), and a base the function COMPUTED — a parameter, a pool-loaded symbol,
    // an index into one — is an object the source declared. Refusing every literal base is wider
    // than the device window `capabilities.deviceRegisters` describes, deliberately: that window is
    // a question about SPELLING and says so, and a soundness rule may not rest on it.
    id: 'literal-base',
    why: 'a bare literal address can be a hardware register, where the access WIDTH is itself observable',
    sound: true,
    guardedBy: 'truncload.test.ts: a literal address is not narrowed',
    rejects: (c) => !c.computedBase,
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
];

/** One admitted-or-refused fold: the narrow load, the access it truncates, and what the gates see. */
export interface TruncLoadCandidate {
  block: number;
  at: number;
  narrow: Access;
  covering: Access;
  c: TruncatedLoad;
}

/** Every narrow load a strictly wider access at the same base covers, in program order.
 *
 *  THE COVERING ACCESS IS THE WIDEST one that covers, not the closest: a base read at 4, 2 and 1
 *  bytes from one offset collapses to ONE field in a single pass that way, where the closest cover
 *  would need a fixpoint to reach the same layout. It is never itself a candidate, because a
 *  candidate is strictly narrower than its own cover. */
export function truncatedLoadCandidates(fn: Fn, littleEndian: boolean): TruncLoadCandidate[] {
  const accessesOf = new Map<Value, Access[]>();
  const note = (base: Value, a: Access) => {
    const list = accessesOf.get(base);
    if (list) {
      list.push(a);
      return;
    }
    accessesOf.set(base, [a]);
  };
  for (const b of fn.blocks) {
    for (const op of b.ops as Op[]) {
      if (op.opcode === 'load') {
        note(op.operands[0], {
          op,
          off: op.attrs.off as number,
          width: op.attrs.width as number,
          signed: op.attrs.signed as boolean,
          isLoad: true,
        });
      } else if (op.opcode === 'store') {
        // Signedness is read off LOADS only — a store carries none, and `covering-store` above is
        // where that absence is decided rather than filled in.
        note(op.operands[0], {
          op,
          off: op.attrs.off as number,
          width: op.attrs.width as number,
          signed: false,
          isLoad: false,
        });
      }
    }
  }
  const defs = defOpMap(fn);
  const out: TruncLoadCandidate[] = [];
  fn.blocks.forEach((b, block) => {
    b.ops.forEach((op, at) => {
      if (op.opcode !== 'load') {
        return;
      }
      const base = op.operands[0];
      const all = accessesOf.get(base)!;
      const narrow = all.find((a) => a.op === op)!;
      const covers = all.filter(
        (a) => a.width > narrow.width && a.off <= narrow.off && a.off + a.width >= narrow.off + narrow.width,
      );
      if (covers.length === 0) {
        return;
      }
      // Deterministic pick: widest, then a load over a store, then the earlier access — so two
      // covers of the same width cannot make the fold depend on map iteration order.
      const covering = covers.reduce((best, a) =>
        a.width !== best.width ? (a.width > best.width ? a : best) : a.isLoad && !best.isLoad ? a : best,
      );
      out.push({
        block,
        at,
        narrow,
        covering,
        c: {
          computedBase: defs.get(base)?.opcode !== 'const',
          coveringLoad: covering.isLoad,
          lowOrderEnd: littleEndian
            ? narrow.off === covering.off
            : narrow.off + narrow.width === covering.off + covering.width,
        },
      });
    });
  });
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
    byBlock.set(k.block, [...(byBlock.get(k.block) ?? []), k]);
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
      inserted.set(k.at, wide);
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
