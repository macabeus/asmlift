// asmlift structurer — BITFIELD MEMBER SPELLING off a symbol map. Precomputes, for one function,
// which extracts read a declared bitfield and which stores write one; structure.ts renders from
// the three products and never re-derives them. Everything here is a REFUSAL machine: any fact
// that does not hold exactly leaves the honest shift/mask spelling in place.
//
// ── BITFIELD member READS ────────────────────────────────────────────────────────────────────
// The `(x << a) >> b` extract of a struct global's loaded bytes IS a bitfield access when the
// map declares a bitfield at exactly those bits: spelled `gSym.field`, the source form, whose
// declared `u32 field : n` then makes C's own integer promotion reproduce the signedness every
// downstream operator compiled with (a 7-bit unsigned field promotes to signed int — sdiv
// renders `/` and recompiles to __divsi3, where the raw-shift spelling stays u32).
//
// Semantically EXACT, never approximate: the window must lie inside the loaded bytes (so the
// load's extension bits cannot reach it), the field's position, width and signedness must all
// match the extract (a logical shift is an unsigned read, an arithmetic one a signed read —
// a signless field never matches), and the member must be nameable at all (memberQualsAllow;
// the map only carries bitfield facts for little-endian ELFs — see SymbolStructField). Any
// mismatch keeps the honest shift spelling.
//
// Precomputed over the ops (not folded during rendering) for the load's sake: a load whose
// EVERY use is a spelled extract chain must not also emit its materialized `v = *(u16 *)&g;`
// temp — the compiler CSEs the repeated member reads back to one load, but the leftover temp
// would be a second one. A VOLATILE container refuses the whole fold: N member reads are N
// volatile accesses where the asm did one load. (Byte-level residual, differ-refereed: a load
// only PARTIALLY absorbed — one extract spelled, another use kept — emits both the temp and
// the named reads, one load more than the asm; semantics hold, the score decides.)
//
// ORDERING GATE: the named spelling replaces a
// REGISTER value — the bits captured at the load's program position — with a fresh memory
// read at each render position. Every other memory read in this file goes through the
// materialization model (analysis.ts) for exactly that hazard, so the fold clears the SAME
// bar with the SAME machinery: `emitPos` resolves where each extract actually renders
// (transitively through its inlining consumers — an unresolvable position refuses), and
// `memWriteBetween` walks every def-avoiding load→render path for a call, an opaque, or a
// store not provably to a DIFFERENT named global. PATH-BASED, never a linear scan over the op
// list: `fn.blocks` is in ADDRESS order, not topological order, so a block laid out after the
// render can still execute between the load and the render on the taken path.
import { type GlobalCell, globalCellOf, mayWriteGlobal } from '../ir/alias';
import { type BitsCtx, constMask, provableBits } from '../ir/bits';
import { Block, Fn, Op, Value } from '../ir/core';
import { type DeclaredField, type SymbolInfo, type SymbolStructField, declaredFields } from '../symbols';

/** The slice of structure.ts's symbol-map rendering context this fold reads. Structural on purpose:
 *  the owner of that context stays in structure.ts, and nothing here can reach the rest of it. */
export interface BitfieldSymCtx {
  info(name: string): SymbolInfo | undefined;
  fieldsOf(name: string): DeclaredField[] | null;
}

export interface BitfieldDeps {
  fn: Fn;
  defs: Map<Value, Op>;
  /** defs that emit as named temps at their own position (structure/analysis.ts). READ ONLY here:
   *  a materialized op is what several of the refusals below test for. */
  materialize: Set<Op>;
  useSitesOf: Map<Value, { op: Op }[]>;
  opBlock: Map<Op, Block>;
  opIndex: Map<Op, number>;
  /** where an op's expression ultimately renders, transitively through its inlining consumers;
   *  null when there is no single such position. */
  emitPos: (op: Op) => { blk: Block; idx: number } | null;
  /** does any op matching `isWrite` lie on a def-avoiding path from `def` to `render`? */
  memWriteBetween: (def: Op, render: { blk: Block; idx: number }, isWrite: (x: Op) => boolean) => boolean;
  /** absent ⇒ no map, and then nothing here fires. */
  sym: BitfieldSymCtx | undefined;
  /** the map only carries bitfield facts for little-endian ELFs (see SymbolStructField). */
  littleEndian: boolean;
  /** `spellBitfieldMembers`, already normalized against the PROJECT map by the caller. */
  enabled: boolean;
  /** may a member be NAMED by an access of this direction, given its declared qualifiers? Taken as
   *  a dependency rather than duplicated: structure.ts owns the one statement of that rule, and
   *  both of its named-member spellings pass through the same predicate. */
  memberQualsAllow: (f: SymbolStructField, containerConst: boolean | undefined, isStore: boolean) => boolean;
}

export interface BitfieldSpellings {
  /** extract op → the `gSym.field` read it spells */
  spelling: Map<Op, { global: string; field: string }>;
  /** store op → the `gSym.field = value` write it spells */
  stores: Map<Op, { global: string; field: string; value: Value }>;
  /** loads whose EVERY use is a spelled extract: the fold emits no temp for these */
  absorbed: Set<Op>;
}

export function makeBitfieldSpelling(deps: BitfieldDeps): BitfieldSpellings {
  const {
    fn,
    defs,
    materialize,
    useSitesOf,
    opBlock,
    opIndex,
    emitPos,
    memWriteBetween,
    sym: symCtx,
    littleEndian,
    enabled: spellBitfieldMembers,
    memberQualsAllow,
  } = deps;
  // the READ side: an extract op → the `gSym.field` it spells. Every rule and every refusal behind
  // it is in this module's header.
  const bitfieldSpelling = new Map<Op, { global: string; field: string }>();
  // …and the WRITE side: a store the mask-and-insert idiom recognized (see the block below), with
  // the value the source assigned. THE SECOND inhabitant of "a precomputed member spelling", which
  // is what makes the shape shared rather than anticipated.
  const bitfieldStore = new Map<Op, { global: string; field: string; value: Value }>();
  const absorbedLoads = new Set<Op>();
  if (symCtx && littleEndian && spellBitfieldMembers) {
    // the (name, byte) of a load's address when it resolves through defs alone — `gaddr` or
    // `add(gaddr, const)`; anything else (a materialized base, a variable index) declines. THE
    // shared L2 disjointness query (ir/alias.ts), which the materialization model consults with
    // the same rule, so the fold and the model cannot disagree about what a store can reach.
    const loadTargets = new Map<Op, GlobalCell>();
    const addrOf = (v: Value, off: number): GlobalCell | null => globalCellOf(defs, v, off);
    // A write for the fold's purposes: calls and opaques always; a store/astore unless its base
    // resolves to a global PROVABLY different from the folded one.
    const mayWrite = (sym: string) => mayWriteGlobal(defs, sym);
    for (const blk of fn.blocks) {
      for (const op of blk.ops) {
        if ((op.opcode !== 'shr_u' && op.opcode !== 'shr_s') || op.operands.length !== 1) {
          continue;
        }
        const b = op.attrs.imm as number | undefined;
        const inner = defs.get(op.operands[0]);
        if (typeof b !== 'number' || b <= 0 || b >= 32 || inner?.opcode !== 'shl' || inner.operands.length !== 1) {
          continue;
        }
        const a = inner.attrs.imm as number | undefined;
        if (typeof a !== 'number' || a < 0 || b < a) {
          continue;
        }
        const w = 32 - b; // extract width
        const lo = b - a; // low bit within the loaded value
        const load = defs.get(inner.operands[0]);
        if (load?.opcode !== 'load' || lo + w > (load.attrs.width as number) * 8) {
          continue;
        }
        // a materialized shl would still emit its `v = x << a` temp reading the load — the fold
        // would then ADD member reads on top of it; rare, refuse
        if (materialize.has(inner)) {
          continue;
        }
        const gb = addrOf(load.operands[0], load.attrs.off as number);
        const si = gb ? symCtx.info(gb.name) : undefined;
        if (!gb || si?.shape !== 'struct' || si.volatile) {
          continue;
        }
        // where does the member read RENDER? at the extract's own position when materialized,
        // else wherever each of its consumers ultimately renders (emitPos, transitively —
        // unresolvable refuses); every load→render path must be write-free
        const renders = materialize.has(op)
          ? [{ blk: opBlock.get(op)!, idx: opIndex.get(op)! }]
          : [...new Set((useSitesOf.get(op.results[0]) ?? []).map((s) => s.op))].map((c) => emitPos(c));
        const writes = mayWrite(gb.name);
        if (renders.some((r) => r === null) || renders.some((r) => memWriteBetween(load, r!, writes))) {
          continue;
        }
        const signedRead = op.opcode === 'shr_s';
        const fld = declaredFields(si.layout)?.find(
          (f) => f.bitWidth === w && f.offset * 8 + f.bitOffset! === gb.byte * 8 + lo && f.signed === signedRead,
        );
        if (fld && memberQualsAllow(fld, si.const, false)) {
          bitfieldSpelling.set(op, { global: gb.name, field: fld.name });
          loadTargets.set(load, gb);
        }
      }
    }
    // a load is ABSORBED when every use is an shl whose every use is a spelled extract
    for (const load of loadTargets.keys()) {
      const shls = useSitesOf.get(load.results[0]) ?? [];
      const absorbed =
        shls.length > 0 &&
        shls.every(
          (u) =>
            u.op.opcode === 'shl' && (useSitesOf.get(u.op.results[0]) ?? []).every((v) => bitfieldSpelling.has(v.op)),
        );
      if (absorbed) {
        absorbedLoads.add(load);
      }
    }

    // ── BITFIELD member WRITES: the mask-and-insert idiom ───────────────────────────────────
    // `store(A, or(and(load(A), ~W), v << lo))` over a struct global's cell IS an assignment to
    // the declared bitfield at bits W — `gSym.field = v;`, one statement where the recovered
    // spelling is a read, a mask, a shift, an or and a store.
    //
    // EXACT, never approximate. The cleared bits must be exactly one declared field's window; the
    // load must address the SAME cell at the same width; the insert must be that value shifted to
    // the window's own position; and the load, the mask, the `and` and the `or` must each be
    // single-use and unmaterialized, because the fold DELETES all of them — a second reader would
    // keep the temp and the emitted C would do the work twice.
    //
    // TRUNCATION is what makes an UNMASKED insert legal, and only sometimes: C truncates the
    // assigned value to the field width, while the asm's `or` writes every bit of `v << lo` that
    // the STORE keeps. The two agree when the field ends the stored cell — bits above it are
    // dropped by the store either way — or when `v` provably has no more bits than the field.
    // Anything else keeps the honest mask spelling.
    //
    // ORDERING is NOT this fold's to police, and the difference from the read fold above is the
    // reason. That fold MOVES a read: its extract renders at the consumer, so a write in between
    // changes what the extract sees. This one moves nothing — the spelling it replaces is a single
    // statement AT THE STORE (`*(u8 *)&gS = v | *(u8 *)&gS & ~W;`), which reads the cell in exactly
    // the position `gS.field = v` does. What keeps that read honest is the MATERIALIZATION model,
    // and it is byte-granular where a symbol-wide alias query is not: a call, or a store this load
    // may alias, forces the load to its own temp at its own position, and `!materialize.has(load)`
    // below then refuses. A store to a DISJOINT byte of the same cell's symbol materializes
    // nothing, and refusing there bought no ordering — it only spelled the same read as arithmetic.

    // THE KNOWN-BITS QUESTION IS L2 AND LIVES THERE (ir/bits.ts) — this fold only supplies the
    // one fact that layer cannot see: a bitfield READ this pass has already recognized, whose
    // bound comes from the DECLARATION. And it supplies it signedness-first, because a signed
    // field's read is sign-extended and carries all 32 bits however few bits the declaration
    // allots it — bounding one by its own `bitWidth` folds `gS.dest = gS.delta` over a value whose
    // high bits the asm's `or` writes and C's truncation does not.
    const bits: BitsCtx = {
      defs,
      materialize,
      bound: (d) => {
        const bf = bitfieldSpelling.get(d);
        if (!bf) {
          return null;
        }
        const f = symCtx.fieldsOf(bf.global)?.find((x) => x.name === bf.field);
        return f?.signed === false ? (f.bitWidth ?? 32) : 32;
      },
    };
    const maskConst = (v: Value): number | null => constMask(bits, v);
    /** The other operand of a 2-operand commutative op, or null when there is none — a
     *  1-operand op carries its constant as `attrs.imm`, which is not a Value the caller can
     *  read a mask off, so the caller falls through to `attrs.imm` itself. */
    const otherOperand = (d: Op, keep: Value): Value | null =>
      d.operands.length === 2 ? (d.operands[0] === keep ? d.operands[1] : d.operands[0]) : null;

    for (const blk of fn.blocks) {
      for (const op of blk.ops) {
        if (op.opcode !== 'store') {
          continue;
        }
        const width = op.attrs.width as number;
        const cell = globalCellOf(defs, op.operands[0], op.attrs.off as number);
        const si = cell ? symCtx.info(cell.name) : undefined;
        const orOp = defs.get(op.operands[1]);
        if (
          !cell ||
          si?.shape !== 'struct' ||
          si.volatile ||
          orOp?.opcode !== 'or' ||
          orOp.operands.length !== 2 ||
          materialize.has(orOp) ||
          (useSitesOf.get(orOp.results[0]) ?? []).length !== 1
        ) {
          continue;
        }
        const cellBits = width * 8;
        const cellMask = width >= 4 ? -1 : (1 << cellBits) - 1;
        for (const [keepV, insV] of [
          [orOp.operands[0], orOp.operands[1]],
          [orOp.operands[1], orOp.operands[0]],
        ] as const) {
          const andOp = defs.get(keepV);
          if (
            andOp?.opcode !== 'and' ||
            materialize.has(andOp) ||
            (useSitesOf.get(andOp.results[0]) ?? []).length !== 1
          ) {
            continue;
          }
          // `and` is commutative and may carry its constant as an immediate: find the operand that
          // is the SAME cell's load, and read the mask off whatever is left.
          const loadV = andOp.operands.find((o) => {
            const l = defs.get(o);
            const c = l?.opcode === 'load' ? globalCellOf(defs, l.operands[0], l.attrs.off as number) : null;
            return c !== null && c.name === cell.name && c.byte === cell.byte && l!.attrs.width === width;
          });
          const load = loadV === undefined ? undefined : defs.get(loadV)!;
          const maskV = loadV === undefined ? null : otherOperand(andOp, loadV);
          const mask =
            maskV !== null
              ? maskConst(maskV)
              : typeof andOp.attrs.imm === 'number'
                ? (andOp.attrs.imm as number) | 0
                : null;
          if (
            load === undefined ||
            mask === null ||
            materialize.has(load) ||
            (useSitesOf.get(load.results[0]) ?? []).length !== 1
          ) {
            continue;
          }
          // The cleared bits must be ONE contiguous window inside the stored cell.
          const clear = ~mask & cellMask;
          if (clear === 0) {
            continue;
          }
          const lo = 31 - Math.clz32(clear & -clear);
          const w = 32 - Math.clz32(clear >>> lo);
          if ((((w >= 32 ? -1 : (1 << w) - 1) << lo) & cellMask) !== clear) {
            continue;
          }
          // …and the insert must be exactly that value seated at `lo`.
          const shifted = defs.get(insV);
          const value =
            lo === 0
              ? insV
              : shifted?.opcode === 'shl' && shifted.operands.length === 1 && shifted.attrs.imm === lo
                ? shifted.operands[0]
                : null;
          if (
            value === null ||
            (lo !== 0 && (materialize.has(shifted!) || (useSitesOf.get(insV) ?? []).length !== 1))
          ) {
            continue;
          }
          if (lo + w !== cellBits && provableBits(bits, value) > w) {
            continue; // C would truncate bits the asm's `or` writes
          }
          const fld = symCtx
            .fieldsOf(cell.name)
            ?.find(
              (f) => f.bitWidth === w && f.offset * 8 + f.bitOffset! === cell.byte * 8 + lo && f.signed !== undefined,
            );
          if (fld && memberQualsAllow(fld, si.const, true)) {
            bitfieldStore.set(op, { global: cell.name, field: fld.name, value });
          }
          break;
        }
      }
    }
  }
  return { spelling: bitfieldSpelling, stores: bitfieldStore, absorbed: absorbedLoads };
}
