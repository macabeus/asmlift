/** THE FRAME-OBJECT AUDIT, over finished IR and the frame partition a frontend measured.
 *
 *  NOTHING HERE DECODES. A frontend lowers each address it can name as a frame offset to an
 *  `laddr` (Thumb: `mov rD, sp`, `add rD, sp, #k`, a capture moved by a constant) and hands over
 *  what only it can measure — the frame partition, as the same two ranges its `LiveInModel`
 *  carries, the offsets its slot model keyed, the one licence it grants on the text
 *  (`capturedObjectIsTheWholeFrame`), and the captures it moved. The rules that decide whether
 *  those `laddr`s are objects the emitted C can declare are asked of the IR here, the same for
 *  every ISA — the level-tower split for this frame model: the frontend supplies the PARTITION,
 *  the shared pass applies the rule. Messages name the frame base `sp`.
 *
 *  Thumb is the only caller today; the worked examples below are agbcc's, because agbcc is the
 *  compiler every rule was measured against. */
import { returnsWithoutHiddenPointer } from '../aggregate';
import { type Block, type Op, type Value, mkOp, mkValue } from '../ir/core';
import { type IrType, T, typeEquals, typeToString } from '../ir/types';
import type { Gate } from '../l3/gates';
import type { Prototypes } from '../proto';
import type { SymbolMap } from '../symbols';
import { type TargetDescription, blockTransferRead } from '../target';
import { FrontendUnsupportedError } from './errors';
import { type LiveInModel, slotKeyOffset } from './ssa';

export interface FrameObjectAudit {
  name: string;
  irBlocks: Block[];
  /** the frame this function owns (`LiveInModel.ownedLocals`): every local lies inside it, and
   *  every word of it is an object, a slot, or storage nothing here describes */
  ownedLocals: NonNullable<LiveInModel['ownedLocals']>;
  /** where its locals are declared (`LiveInModel.declaredLocals`): `ownedLocals` less the outgoing
   *  stack-argument block staged at its bottom, which is where an untyped object claims to start */
  declaredLocals: NonNullable<LiveInModel['declaredLocals']>;
  usedSlotOffsets: ReadonlySet<number>;
  capturedObjectIsTheWholeFrame: boolean;
  /** every capture the add arm re-minted at a constant offset from it */
  movedCaptures: ReadonlySet<Value>;
  prototypes: Prototypes;
  symbols: SymbolMap | undefined;
  target: TargetDescription;
  /** the retraction rules an escape is judged by; `FRAME_ESCAPE_GATES` when absent, and a
   *  census or an ablation hands in its own (`FRAME_OBJECT_AUDIT`) */
  gates?: readonly Gate<FrameEscape>[];
  /** the bytes a first audit asked to have kept as ONE object in memory (`FrameObjectRelift`):
   *  the frontend routes every access inside them through an `laddr`, and the audit declares
   *  them one object rather than judging each offset on its own */
  oneObject?: FrameRange;
}

export interface FrameRange {
  readonly from: number;
  readonly to: number;
}

/** What an audit answers instead of a refusal when a device may read the frame without bound: lift
 *  again with `oneObject` set to these bytes. */
export interface FrameObjectRelift {
  readonly oneObject: FrameRange;
}

/** One escaped object, as the rules an escape retracts read it: what it may reach, `[lo, hi)`
 *  from its own offset, whether it may write, and the first other object, keyed slot and
 *  unaccounted frame word inside that reach — so a refusal names the fact its gate tested. */
export interface FrameEscape {
  readonly off: number;
  readonly lo: number;
  readonly hi: number;
  readonly writes: boolean;
  /** how the address left, as the refusal words it */
  readonly how: string;
  readonly objectReached: number | undefined;
  readonly slotReached: { readonly slot: number; readonly above: boolean } | undefined;
  /** the function holds an `undef` of a frame slot */
  readonly frameUndef: boolean;
  /** the lowest owned word inside that reach that no object and no slot accounts for */
  readonly unaccountedWord: number | undefined;
}

// WHAT AN ESCAPE COSTS. The audit bounds what WE access through an object, never what a callee
// does with the address it was handed — and a callee may write any offset from it. So an escape
// retracts four claims, each function-wide because one address reaches the whole frame. They are
// a table (`l3/gates.ts`), taken as `FrameObjectAudit.gates` so a census or an ablation can reach
// them; the rest of the audit — the split, the use classification, the
// premise re-check, the shape and overlap checks — decides what the objects ARE, and stays inline.
export const FRAME_ESCAPE_GATES: readonly Gate<FrameEscape>[] = [
  // The first is that the other ADDRESS-TAKEN objects are private, and it keys on the REACH, not
  // on `mayWrite`. Its argument is about LAYOUT, and layout is symmetric: two objects are two
  // separate C locals with no guaranteed adjacency, so a device that READS past the one it was
  // given is as wrong as a callee that writes past it. `DmaCopy` with a count of two halfwords
  // off `&sp0` transfers `[sp,#2]` too, and the emitted source transfers whatever the recompiler
  // put after `sp0`, and the second object's own store is whatever the recompiler made of it.
  // Marking both volatile would not repair that: the locals are still placed independently. A
  // read the control word bounds to the object's own bytes reaches no neighbour, whatever its
  // placement: two fixed-source DMA fills in one function, each off its own `volatile` local.
  //
  // It counts `laddr` objects. A neighbour SPILLED to an SSA slot is the slot rule's below.
  {
    id: 'reaches-another-object',
    why: 'two locals have no guaranteed adjacency, so a reach past one lands on whatever the recompile put there',
    sound: true,
    guardedBy: 'thumb-frontend.test.ts: an incrementing fill reads the object above its own',
    rejects: (e) => e.objectReached !== undefined,
  },
  // The second is `undef`, which rests on this function's own stores being the ONLY writer of
  // its frame. A wider real object (`struct P p; g(&p);` where only `p.x` is read here) has its
  // later words written by `g` and read back at a slot no store of ours reaches — declaring
  // those uninitialised spells the callee's value as garbage. The extents here are inferred
  // from OUR accesses, which is the number that is too small in this shape.
  //
  // On an escape and not on "a laddr exists": an address dereferenced only in-function cannot
  // be written by anyone else, and the audit's overlap checks cover its aliasing.
  //
  // FRAME undefs only. A register-keyed one says a local lives in a register the ABI does not
  // pass arguments in, and no address reaches a register — the escape this retraction is about
  // cannot touch it, and counting it would refuse the whole function for an unrelated escape.
  {
    id: 'writer-over-undef',
    why: 'an unstored frame slot is uninitialised only while this function is its sole writer',
    sound: true,
    guardedBy: 'thumb-frontend.test.ts: an ESCAPED frame address retracts the undef argument',
    rejects: (e) => e.writes && e.frameUndef,
  },
  // …and the SLOT MODEL is the third claim an escape retracts — the undef rule's argument
  // taken one step further. The audit's extents are inferred from OUR accesses, so an object
  // wider in the SOURCE than the bytes this function touches has its later words written by
  // the callee — and any of those modelled as an SSA slot is a value the slot model forwards
  // ACROSS the call that overwrote it.
  //
  // The object has to be reached ONLY through the captured pointer (an `[sp,#0]` access of its own collides with the slot model and
  // declines at the overlap check), which is what four corpus functions do:
  //
  //     mov r2, sp / str r0, [r2]   @ the object, written through the captured address
  //     str r1, [sp, #0x4]          @ a word the slot model keys
  //     mov r0, r2 / bl g           @ the base escapes; `g` may write [sp,#4]
  //     ldr r0, [sp, #0x4]          @ …and the machine RELOADS it after the call
  //
  // and lifted, the reload is the value from BEFORE the call, the callee's write dropped, no
  // diagnostic. Exactly the silent-wrong-answer trade the sp guards exist to prevent, so it refuses.
  //
  // WHAT IT COSTS: it refuses every word slot the escape may reach, which is blunter than the
  // hazard it names. Narrowing it needs the object's real extent, and this model does not carry
  // one: `extent` is a single width from a single access. The asm sometimes cannot
  // supply it either — the compiled twin at `capturedObjectIsTheWholeFrame` is exactly this
  // rule's shape, a slot THIS FUNCTION stores and reloads, undecidable between a spill and a
  // member.
  //
  // A callee is not the only writer. `struct M { u8 b; u8 pad[3]; s32 t; }; gp = &m; g2();
  // use2(m.t);` PUBLISHES the base to an ordinary global and the machine reloads [sp,#4] after
  // `bl g2` — `g2` writes through `gp`, which points here: the same hazard as the call shape, one
  // escape over.
  //
  // …and a writer is not the only hazard, so the rule keys on `escaped`, not `mayWrite`. A
  // device that only READS through the address reads the slot's bytes from memory, where the
  // slot model never put them: `struct P { u32 a, b; } s; s.a = x; s.b = y; REG_DMA3SAD =
  // (u32)&s;` above an outgoing block is `str r4, [sp, #0x4] / str r5, [sp, #0x8] / add r1, sp,
  // #0x4 / str r1, [DMA3SAD]`, where the slot model would keep `s.b` in a register and drop its
  // store as dead while the DMA reads that word. The asm cannot tell that second word from a
  // neighbour spilled beside the object, so what bounds the read is the transfer's own control
  // word, `readWindow`.
  //
  // …and BELOW the object as well as above it. A C object extends upward from its base, but a
  // captured address need not BE a base: `add r0, sp, #0x4` is `&buf[1]` as readily as `&b`, and
  // `buf[0]` at [sp,#0] is then read or written through `p[-1]`. Only down to the outgoing
  // block, whose words are the callee's arguments and never part of a local.
  {
    id: 'reaches-a-slot',
    why: 'the slot model keeps a slot in a register, so a write or read through the frame misses it',
    sound: true,
    guardedBy: 'thumb-frontend.test.ts: above: a word a device may read past the object',
    rejects: (e) => e.slotReached !== undefined,
  },
  // …and the FOURTH claim an escape retracts is the object's TOP, which the three rules above
  // leave to whatever this function happened to touch. `extent` is one width from one access,
  // so an object wider in the SOURCE than those bytes is declared too small — and a callee
  // holding its address writes frame bytes the emitted C never allocated. Compiled:
  //
  //     u8 buf[12]; buf[0] = x; garr(buf); use2(buf[0]);
  //       → add sp,sp,#-0xc / mov r1,sp / strb r0,[r1] / mov r0,sp / bl garr
  //
  // lifted as `u8 sp0; garr(&sp0); use2(sp0)` — a 12-byte object declared one byte, in a frame
  // the recompile makes 4 bytes wide, with `garr` writing the other 8 into the caller's. The
  // three rules above all pass it: one object, no `undef` op, no slot above it.
  //
  // What licenses an answer is the frame being ACCOUNTED FOR, word by word. Every word of the
  // reserved local area has to be an object this audit modelled or a slot the slot model keys;
  // a word that is neither is storage nothing here describes, so the emitted C reserves less
  // than the machine did and the writer reaches past what it allocated. A writer reaches the
  // whole local area and not only the words above the object: a word below it is still frame
  // the declaration has to account for. Word granularity, not byte — the stack is word-aligned, so a halfword object
  // owns its word and the padding beside it is not a second local.
  //
  // …and on a READER as far as it reads, since a read past the object copies frame bytes the
  // source reserved and the recompile does not. `u16 buf[8]; buf[0] = x; CpuSet(buf, gDst, 8);`
  // reads the sixteen bytes its control word names, and a DMA copy incrementing from `buf` reads
  // every word above it; lifted as `u16 sp0`, the recompile's frame is four bytes wide and the
  // transfer copies the saved `lr` and the caller's frame out with it. A read unbounded both ways
  // meets this rule only beside a writer, which reaches the same word: alone, the audit keeps the
  // local area as one object instead (`oneObjectOnOffer`).
  //
  // WHAT IT LEAVES, since this is the extent question the gate comment above is about: an escape
  // is accepted only where the modelled objects and the keyed slots tile the reserved area it
  // reaches — a word above the object is a slot (refused above), a second object (refused above),
  // or unaccounted (refused here). That is not a wider extent model; it is the same one-scalar
  // `extent`, made to say when it does not fit. An object of two words cannot be built here at
  // all — the second access that would reach it is a `[+4]` the `scalar()` guard refuses — so no
  // widening of the frame licence admits a shape this rule would then have to judge.
  //
  // AND IT IS THE SCALAR ARM THIS BOUNDS. An UNTYPED object is the whole reserved area by
  // construction — `notTheWholeArea` accepts nothing else — so it accounts for every word this
  // walk then asks about, and no input makes the rule fire on that path. What bounds THAT path
  // is `notTheWholeArea`'s own live clauses: a second object, a slot inside the area, an address
  // that reaches memory rather than a callee, and the callee's declared return.
  {
    id: 'reaches-an-unaccounted-word',
    why: 'an escape reaching a frame word no declaration covers reaches past what the recompile allocates',
    sound: true,
    guardedBy: 'thumb-frontend.test.ts: an array whose top nothing bounds declines rather than shrinking the frame',
    rejects: (e) => e.unaccountedWord !== undefined,
  },
];

/** FRAME-OBJECT AUDIT. Every `laddr` the frontend emitted is only a CLAIM that the address it
 *  names is used as "the address of one local object"; this proves it, over the finished function,
 *  the same boundary-total style as the slot-escape assert in finish(). The address may flow
 *  anywhere as a VALUE — into an MMIO register (the DMA-fill idiom), a call, a phi — and it is
 *  judged in one of two models, chosen before any shape is:
 *   - PER OBJECT, the default: every MEMORY access through it must be at offset 0, with one agreed
 *     width and one agreed extension, or a byte read or written through a runtime index into
 *     storage nothing else types, and its bytes must belong to nothing else in the frame;
 *   - ONE OBJECT, where every escape only reads and a device reads without bound (`oneObject`,
 *     which this answers and the frontend lifts again with): the local area is one `u8` array in
 *     memory, every fixed-offset access in it is a member at its own offset, a runtime index may
 *     reach a byte of it, and two widths at one byte refuse.
 *  Any use the audit cannot vouch for declines the whole function loudly. Nothing here guesses: a
 *  scalar's declared type is exactly the access type the machine used, and an object NO access
 *  reaches is sized by the frame reservation and left untyped.
 *
 *  Takes its inputs explicitly rather than closing over `lift`. Every one of them is READ, none is
 *  reassigned, and the only mutations are to the ops reachable through `irBlocks`: an `add` of a
 *  capture and a constant is re-minted as the `laddr` it names, a moved-from capture nothing reads
 *  is dropped, a capture addressed through at fixed offsets is split into the objects its accesses
 *  name, and each surviving `laddr` is stamped with its width, signedness, count and `volatile`.
 *  One object mutates more: every access through a member is re-based onto one minted `laddr`,
 *  the member `laddr`s are deleted or re-minted as that one moved by a `const`, and every device
 *  load and store of the function — through no `laddr` at all — is marked `volatile`. Per object,
 *  only the device stores a later store in their own block overwrites are marked. */
export function auditFrameObjects({
  name,
  irBlocks,
  ownedLocals: owned,
  declaredLocals: declared,
  usedSlotOffsets,
  capturedObjectIsTheWholeFrame,
  movedCaptures,
  prototypes,
  symbols,
  target,
  gates = FRAME_ESCAPE_GATES,
  oneObject,
}: FrameObjectAudit): FrameObjectRelift | undefined {
  // A CAPTURE MOVED BY A CONSTANT IS THE CAPTURE AT THE SUM, and here the constant is exact: an
  // `add` of a `laddr` and a `const` — a register the lift could not see through, `mov r0, sp /
  // movs r2, #0 / ldrsh r1, [r0, r2]`, or a move the pre-lift walk does not follow — is re-minted
  // as the `laddr` it names. The walk still decides which `[sp,#k]` words are routed to an object
  // rather than keyed as slots, so a fold it did not make is remembered: an object it lands on a
  // keyed slot is refused as the move, the capability that is missing (`failIfSlotKeysIt`).
  const moved = new Set<Value>(movedCaptures);
  const foldedHere = new Set<Op>();
  {
    const constOf = new Map<Value, number>();
    const laddrOf = new Map<Value, Op>();
    for (const blk of irBlocks) {
      for (const op of blk.ops) {
        if (op.opcode === 'const') {
          constOf.set(op.results[0], op.attrs.value as number);
        } else if (op.opcode === 'laddr') {
          laddrOf.set(op.results[0], op);
        }
      }
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const blk of irBlocks) {
        blk.ops = blk.ops.map((op) => {
          const [x, y] = op.operands;
          const base = laddrOf.get(x) ?? laddrOf.get(y);
          const by = constOf.get(laddrOf.has(x) ? y : x);
          if (op.opcode !== 'add' || op.operands.length !== 2 || base === undefined || by === undefined) {
            return op;
          }
          const off = ((base.attrs.off as number) + by) | 0;
          const object = mkOp('laddr', { results: op.results, attrs: { off } });
          laddrOf.set(op.results[0], object);
          moved.add(base.results[0]);
          foldedHere.add(object);
          changed = true;
          return object;
        });
      }
    }
  }
  // A capture MOVED by a constant and nothing else reads names no object — the moved one does —
  // so it is dropped rather than judged as an object with no use, and so is a fold nothing reads:
  // the write-back of `stmia r1!, {r2, r3, r4}` through a capture is `add r1, r1, #12`, a pointer
  // to the end of what was copied that the machine never uses. Only those: an unused `mov rD, sp`
  // of the machine's own is still a capture, and is judged.
  const read = new Set<Value>();
  for (const blk of irBlocks) {
    for (const op of blk.ops) {
      op.operands.forEach((v) => read.add(v));
      (op.successors ?? []).forEach((s) => s.args.forEach((v) => read.add(v)));
    }
  }
  let laddrs: Op[] = [];
  for (const blk of irBlocks) {
    blk.ops = blk.ops.filter(
      (op) => op.opcode !== 'laddr' || read.has(op.results[0]) || !(moved.has(op.results[0]) || foldedHere.has(op)),
    );
    for (const op of blk.ops) {
      if (op.opcode === 'laddr') {
        laddrs.push(op);
      }
    }
  }
  // …and it runs for a licensed acceptance with no object at all, so the premise re-check below
  // is total rather than resting on "the capture always survives into the IR".
  if (laddrs.length > 0 || capturedObjectIsTheWholeFrame) {
    const readOnlySinks = new Set(target.capabilities.readOnlyAddressSinks ?? []);
    const defOf = new Map<Value, Op>();
    for (const blk of irBlocks) {
      for (const op of blk.ops) {
        for (const res of op.results) {
          defOf.set(res, op);
        }
      }
    }
    // A NAME IS NOT AN ADDRESS. The same symbol name can sit at two addresses — a symbol map is
    // free to carry one — and a `gaddr`'s `sym` can also come straight from the assembly text
    // (`.word REG_DMA3SAD`), where nothing looked it up at all. So names resolve to an address
    // here or they resolve to nothing: a name at more than one address vouches for neither.
    const addrOfName = new Map<string, number | null>();
    for (const [addr, infos] of symbols ?? []) {
      for (const si of infos) {
        addrOfName.set(si.name, addrOfName.has(si.name) ? null : addr);
      }
    }
    // The literal address a value denotes, or undefined when this cannot say. `const` is the
    // bare pool word, `gaddr` is the same word after the symbol map named it, a constant shifted
    // by a constant is the word agbcc builds without a pool (`mov r0, #0x80; lsl r0, #0x13` is
    // 0x04000000), and `add` or `sub` of a constant, on either side, is the base+displacement
    // form an interior attribution or a member access produces — spellings of one address, which
    // is the point: the answer must not turn on which one the assembly happened to use. A runtime
    // index is not a constant, and neither is a pointer loaded from memory, a parameter or a phi.
    const literalAddrOf = (v: Value, depth = 0): number | undefined => {
      const d = defOf.get(v);
      if (d === undefined || depth > 8) {
        return undefined;
      }
      if (d.opcode === 'const') {
        return d.attrs.value as number;
      }
      if (d.opcode === 'gaddr') {
        return addrOfName.get(d.attrs.sym as string) ?? undefined;
      }
      if (d.opcode === 'shl') {
        const shifted = constOfValue(d.operands[0]);
        const by = d.operands.length === 1 ? (d.attrs.imm as number | undefined) : constOfValue(d.operands[1]);
        return shifted === undefined || by === undefined || by < 0 || by > 31 ? undefined : (shifted << by) >>> 0;
      }
      if ((d.opcode === 'add' || d.opcode === 'sub') && d.operands.length === 2) {
        const [x, y] = d.operands;
        const cy = constOfValue(y);
        if (cy !== undefined) {
          const base = literalAddrOf(x, depth + 1);
          return base === undefined ? undefined : d.opcode === 'add' ? base + cy : base - cy;
        }
        const cx = d.opcode === 'add' ? constOfValue(x) : undefined;
        if (cx !== undefined) {
          const base = literalAddrOf(y, depth + 1);
          return base === undefined ? undefined : base + cx;
        }
      }
      return undefined;
    };
    // The register this store hands the WHOLE address to, when it is one a device only reads
    // through, else undefined. Word stores only: a `strh` to a source register hands over half an
    // address, so the device's source is not this object. A base this cannot resolve — computed,
    // register-offset, merged by a phi — is the conservative answer.
    const readsThrough = (op: Op): number | undefined => {
      if (readOnlySinks.size === 0 || (op.attrs.width as number) !== 4) {
        return undefined;
      }
      const base = literalAddrOf(op.operands[0]);
      const at = base === undefined ? undefined : base + (op.attrs.off as number);
      return at !== undefined && readOnlySinks.has(at) ? at : undefined;
    };
    const constOfValue = (v: Value): number | undefined => {
      const d = defOf.get(v);
      return d?.opcode === 'const' ? (d.attrs.value as number) : undefined;
    };
    const fail = (why: string): never => {
      throw new FrontendUnsupportedError(`cannot lift '${name}': address-taken stack local — ${why}`);
    };
    // A FRAME BASE ADDRESSED THROUGH IS NOT A CAPTURE. Thumb-1 gives `ldr`/`str` an `[sp,#imm]`
    // encoding and gives the sub-word forms none, so a byte or halfword spill can only be spelled
    // by copying sp into a register and addressing through the copy:
    //
    //     mov  r2, sp
    //     strh r3, [r2, #0x30]
    //
    // That is an ADDRESSING MODE. The copy never becomes a value, and the access is the
    // `[sp,#0x30]` the instruction set cannot spell — so what the machine named is one object at
    // frame offset 48, not a `[+48]` reach through the frame base.
    //
    // A captured address whose every use is a fixed-offset sub-word ACCESS is that shape, and
    // each of its accesses names its own object: re-root them onto a `laddr` at their own offset,
    // read at 0, and the rest of this audit judges the objects. A capture with ANY other use is a
    // real capture and keeps the frame base.
    //
    // What makes that judgement total is that the walk below enumerates every ROLE a value can
    // appear in — every operand of every op, and every edge argument — instead of asking what an
    // instruction looks like. One instruction can hold two roles: `str rD, [rD, #k]` stores the
    // frame address through itself, a base use AND an escape, and the escape is what stops the
    // split.
    // Why a capture was NOT split, when the reason is one no later message carries — the
    // `slotsOffReason` idiom: a refusal reported as the wrong capability sends the improvement
    // loop to build the wrong thing. Per CAPTURE and not per offset: every direct `[sp,#k]` word
    // access is a capture of its own at k, refused here for its width, and a different capture at
    // k whose access is refused for another reason must not be handed that one.
    const splitRefusal = new Map<Value, string>();
    {
      const uses = new Map<Value, { op: Op; idx: number; blk: Block }[]>();
      const record = (v: Value, op: Op, idx: number, blk: Block) =>
        (uses.get(v) ?? uses.set(v, []).get(v)!).push({ op, idx, blk });
      for (const blk of irBlocks) {
        for (const op of blk.ops) {
          op.operands.forEach((v, idx) => record(v, op, idx, blk));
          // An EDGE ARGUMENT is a use role too, and never an access: a capture that reaches a
          // block parameter is live past this block, so the taint closure below is what judges
          // it. Recorded at index -1 so it can never be counted as an access — a split there
          // would delete a capture the successor argument still names.
          for (const succ of op.successors ?? []) {
            for (const a of succ.args) {
              record(a, op, -1, blk);
            }
          }
        }
      }
      const minted: Op[] = [];
      const consumed = new Set<Op>();
      for (const capture of laddrs) {
        const at = uses.get(capture.results[0]) ?? [];
        const accesses = at.filter((u) => (u.op.opcode === 'load' || u.op.opcode === 'store') && u.idx === 0);
        // SUB-WORD ONLY, because that is the whole of what the encoding gap forces: `ldr`/`str` DO
        // have an `[sp,#imm]` form, so a WORD access through a copy is some other shape and must
        // not be read as this one. It is also what keeps the outgoing-argument area safe — that
        // guard reads `[sp,#k]` accesses (spMemAccess), which an access through a copy is not, and
        // agbcc stages arguments 5+ there with `str`.
        const subWord = accesses.every((u) => (u.op.attrs.width as number) < 4);
        // A use that is not an access leaves the capture naming the frame base, and the judgement
        // below reports that use itself — an escape, a phi, arithmetic — so it needs no reason
        // here. The WIDTH does: nothing downstream mentions it, so a refused word access would be
        // reported as "a store at [+4]" and the histogram would be asked for the wrong capability.
        if (at.length === 0 || accesses.length !== at.length) {
          continue;
        }
        if (!subWord) {
          splitRefusal.set(
            capture.results[0],
            'a WORD access through the copy, and `ldr`/`str` have an `[sp,#imm]` form',
          );
          continue;
        }
        // Nothing to split when the capture already names ONE object: every access at offset 0 is
        // the frame base itself, which is what the DMA-fill idiom captures.
        if (accesses.every((u) => u.op.attrs.off === 0)) {
          continue;
        }
        for (const u of accesses) {
          const res = mkValue(T.unk(32));
          const at = (capture.attrs.off as number) + (u.op.attrs.off as number);
          const object = mkOp('laddr', { results: [res], attrs: { off: at } });
          u.blk.ops.splice(u.blk.ops.indexOf(u.op), 0, object);
          minted.push(object);
          if (foldedHere.has(capture)) {
            foldedHere.add(object);
          }
          // The ADDRESS operand only — the stored value (operand 1) is passed through
          // untouched, so no slot home moves (ir/core.ts `SlotHomes`). These accesses go through
          // a COPY of `sp` rather than the `[sp,#k]` keys the stamp reads, so none of them
          // carried one to begin with.
          u.op.operands = [res, ...u.op.operands.slice(1)];
          u.op.attrs = { ...u.op.attrs, off: 0 };
        }
        consumed.add(capture);
      }
      if (consumed.size > 0) {
        for (const blk of irBlocks) {
          blk.ops = blk.ops.filter((op) => !consumed.has(op));
        }
        laddrs = [...laddrs.filter((op) => !consumed.has(op)), ...minted];
      }
    }
    // ONE OBJECT PER FRAME OFFSET. Two `laddr` at the same offset name the same storage; two at
    // different offsets are different objects, so width, signedness, escape and the overlap
    // window are decided per offset — one width shared by every capture in the function would
    // declare a halfword spill and a word spill as one object.
    const objects = new Map<number, Op[]>();
    for (const op of laddrs) {
      const off = op.attrs.off as number;
      (objects.get(off) ?? objects.set(off, []).get(off)!).push(op);
    }
    // A LOCAL STARTS INSIDE THE RESERVED AREA. Above it are the registers the prologue saved and
    // then the caller's outgoing block, so an address there is an incoming stack argument's or a
    // saved register's — `g(&e)` for a fifth parameter `e` is `add r0, sp, #0x8` over a one-word
    // local area — and no rule below is about that gap. The TOP itself is also C's one-past-the-end
    // pointer, `g(buf, buf + 8)` over an 8-byte array, and the refusal names both readings.
    for (const off of objects.keys()) {
      if (off === owned.to) {
        fail(
          `the captured address at [sp,#${off}) is the top of the reserved local area of ${owned.to - owned.from} bytes — ` +
            'one past the end of a local array, or an incoming stack argument, neither of which is modelled',
        );
      }
      if (off > owned.to) {
        fail(
          `the captured address at [sp,#${off}) is above the reserved local area of ${owned.to - owned.from} bytes — ` +
            'an incoming stack argument or a saved register, whose address is not modelled',
        );
      }
    }
    // Taint maps a value to the OBJECT whose address it may hold, closed over phis: a tainted
    // edge arg taints the receiving block param. A phi that merges two objects has no single
    // answer, and picking one would put an access on the wrong storage: `get(c ? &a : &b)` is
    // `add r0, sp, #0x4 / beq / add r0, sp, #0x8 / bl get`, and refuses here.
    const taint = new Map<Value, number>();
    for (const [off, ops] of objects) {
      for (const op of ops) {
        taint.set(op.results[0], off);
      }
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const blk of irBlocks) {
        for (const op of blk.ops) {
          for (const s of op.successors ?? []) {
            s.args.forEach((arg, i) => {
              const from = taint.get(arg);
              const param = s.block.params[i];
              if (from === undefined || param === undefined) {
                return;
              }
              const had = taint.get(param);
              if (had === from) {
                return;
              }
              if (had !== undefined) {
                fail(`a phi merges the frame objects at [sp,#${had}] and [sp,#${from}] — one value, two objects`);
              }
              taint.set(param, from);
              changed = true;
            });
          }
        }
      }
    }
    // …and the values that hold a frame address on EVERY path, where `taint` answers "on some
    // path": a `laddr`, a phi whose every incoming value is one, or one of those moved by a
    // constant. `p = cnt ? cnt : &o` is tainted and not in here: it may be `cnt`, which may be
    // anything, and reading it as this frame is how a store through it goes unseen.
    const frameOnEveryPath = new Set<Value>(taint.keys());
    {
      const incoming = new Map<Value, Value[]>();
      for (const blk of irBlocks) {
        for (const op of blk.ops) {
          if (
            op.opcode === 'add' &&
            op.operands.length === 2 &&
            op.operands.some((v) => constOfValue(v) !== undefined)
          ) {
            frameOnEveryPath.add(op.results[0]);
          }
          for (const s of op.successors ?? []) {
            s.args.forEach((arg, i) => {
              const param = s.block.params[i];
              if (param !== undefined) {
                (incoming.get(param) ?? incoming.set(param, []).get(param)!).push(arg);
              }
            });
          }
        }
      }
      const objectValues = new Set([...objects.values()].flat().map((op) => op.results[0]));
      const holdsFrame = (v: Value): boolean => {
        const d = defOf.get(v);
        if (objectValues.has(v)) {
          return true;
        }
        if (d?.opcode === 'add') {
          return d.operands.some((x) => constOfValue(x) === undefined && frameOnEveryPath.has(x));
        }
        const ins = incoming.get(v);
        return d === undefined && ins !== undefined && ins.every((a) => frameOnEveryPath.has(a));
      };
      for (let changed = true; changed;) {
        changed = false;
        for (const v of frameOnEveryPath) {
          if (!holdsFrame(v)) {
            frameOnEveryPath.delete(v);
            changed = true;
          }
        }
      }
    }
    // Judge every use of a tainted value, against the object it names.
    const accesses = new Map<number, { width: number; signed: boolean; isLoad: boolean }[]>();
    const escaped = new Set<number>();
    // TWO QUESTIONS, not one. `escaped` asks whether the address LEFT the function, which is what
    // decides `volatile`. `mayWrite` asks whether it reached something that could write the frame
    // BACK, which is what every "a callee may write any frame offset" refusal below rests on. A
    // store into a device's SOURCE register answers yes to the first and no to the second: the
    // hardware reads the object, and the DMA-fill idiom this capability was built for
    // (`vu16 tmp; DmaSet(n, &tmp, …)`) is exactly that shape.
    const mayWrite = new Set<number>();
    // …and for the others, the stores that handed the address to a source register, which is
    // where `readWindow` below reads how far the device reads
    const sourceStores = new Map<number, { op: Op; sink: number }[]>();
    // …and a CALL that only reads is the same answer: the address handed to a block transfer
    // (`blockTransferCalls`) as its source, with a literal control word, is read `[lo, hi)` from
    // the object and written by nobody. `CPU_FILL`'s `vu32 tmp = v; CpuSet(&tmp, dest, …)` is the
    // shape. A control word this cannot read, or any other argument position, is a callee that
    // may write, as before.
    const calleeReads = new Map<number, { lo: number; hi: number }>();
    // …and of those, the objects a transfer FILLS from — a fixed source, the `tmp` of every fill
    // macro — which the `volatile` stamp below keys on beside `published`
    const filledFrom = new Set<number>();
    const transferRead = (op: Op, idx: number, off: number): { lo: number; hi: number; fill: boolean } | undefined => {
      const callee = op.attrs.target;
      const calls = target.capabilities.blockTransferCalls;
      const call = typeof callee === 'string' && calls && Object.hasOwn(calls, callee) ? calls[callee] : undefined;
      const control = call === undefined || idx !== call.source ? undefined : op.operands[call.control];
      const word = control === undefined ? undefined : constOfValue(control);
      if (call === undefined || word === undefined) {
        return undefined;
      }
      // the machine reads in whole units, from the unit-aligned address at or below the object's
      const { unit, bytes } = blockTransferRead(call, word);
      return { lo: -(off % unit), hi: bytes, fill: (word & call.fixedBit) !== 0 };
    };
    // …and the two escapes SPLIT, because each decides something the other does not.
    // `passedToCallee` is the address handed to a callee as an argument — the one escape whose
    // writer this frontend can name, which is what the struct-return premise re-check below rests
    // on, and what tells a refusal message which escape it is talking about. `published` is the
    // address WRITTEN TO MEMORY, how the DMA idiom hands the object to hardware, and what
    // `volatile` at the stamp keys on. Reading either off `escaped` gets the other one wrong.
    const passedToCallee = new Set<number>();
    const published = new Set<number>();
    // …and `published` SPLITS AGAIN, because it answers two questions of different strengths and
    // the weaker one may not be read as the stronger. "Did the address reach memory at all" is
    // what `volatile` keys on: a halfword of it written anywhere is still a write this function
    // does not own, and the qualifier has to survive it. "Did the address reach memory OUTSIDE
    // this frame, whole" is what the licence below is re-proven against, and it is strictly
    // narrower — a store back into the object's own bytes publishes the address to nobody, and
    // half an address is not the address. The pre-lift scan that grants the licence
    // (`frameBasePublishedToMemory`) admits exactly the narrow one, so the re-proof must too: an
    // audit that re-proves a WEAKER premise than the licence it audits is not a containment, it
    // is a second, wider door into the same acceptance.
    const publishedOutward = new Set<number>();
    // …and WHICH CALLEE took it at ARGUMENT 0, because that is the one position a hidden
    // struct-return pointer can occupy and that callee's declared RETURN TYPE is the one fact that
    // tells an out-parameter from one. A `call`'s operand index IS the argument index here (the
    // `bl` arm reads r0..r<argc-1> in order), so an address that appears in no entry of this map
    // was handed over at r1 or above every time — an argument the source wrote. `null` is the
    // narrowing of an unstamped `target` attr — the `bl`/`blx` lowering always stamps one — and
    // reads as a callee nothing can be declared about, so it refuses.
    const arg0Callees = new Map<number, Set<string | null>>();
    // …except where the call's own declaration says argument 0 IS the hidden pointer (the frontend
    // stamps `sret` on a call to a callee declared to return a struct through memory): that object
    // is the callee's return storage, a local of the declared type. `uses` counts every use of each
    // object, so a return temp this function does anything else with is told apart.
    const returnTemps = new Map<number, Op[]>();
    const uses = new Map<number, number>();
    // The accesses through a runtime-indexed address, per object — kept apart from `accesses`,
    // which types the object at its own offset: `a[i]` says what one ELEMENT is, not what sits at
    // `a`.
    const indexed = new Map<number, { width: number; signed: boolean }[]>();
    const indexedAccess = (off: number, sum: Value): void => {
      const got = indexed.get(off) ?? indexed.set(off, []).get(off)!;
      for (const blk of irBlocks) {
        for (const op of blk.ops) {
          const roles = [
            ...op.operands.flatMap((v, i) => (v === sum ? [i] : [])),
            ...(op.successors ?? []).flatMap((s) => (s.args.includes(sum) ? [-1] : [])),
          ];
          for (const i of roles) {
            if ((op.opcode !== 'load' && op.opcode !== 'store') || i !== 0 || (op.attrs.off as number) !== 0) {
              fail(
                `a runtime index into the object at [sp,#${off}) flows into \`${i === -1 ? 'a phi' : op.opcode}\` — ` +
                  'only a load or store at the indexed address is modelled',
              );
            }
            got.push({ width: op.attrs.width as number, signed: op.opcode === 'load' && op.attrs.signed === true });
          }
        }
      }
    };
    for (const off of objects.keys()) {
      accesses.set(off, []);
    }
    // …and with `oneObject`, every fixed-offset access as the frame bytes it touches, since then an
    // access at [+k] through a capture is a member of the one object rather than a second object
    const members: { at: number; width: number }[] = [];
    // …and without it, the first such access, which the per-object model refuses once the model is
    // chosen (below)
    let memberRefusal: string | undefined;
    for (const blk of irBlocks) {
      for (const op of blk.ops) {
        op.operands.forEach((v, idx) => {
          const off = taint.get(v);
          if (off === undefined) {
            return;
          }
          uses.set(off, (uses.get(off) ?? 0) + 1);
          const scalar = (kind: string) => {
            if (oneObject !== undefined) {
              members.push({ at: off + (op.attrs.off as number), width: op.attrs.width as number });
              return;
            }
            if ((op.attrs.off as number) !== 0) {
              memberRefusal ??=
                `a ${kind} at [+${op.attrs.off}] through the captured address — ` +
                (splitRefusal.get(v) ?? 'only a scalar at the captured address is modelled');
            }
          };
          if (op.opcode === 'load' && idx === 0) {
            scalar('load');
            accesses.get(off)!.push({
              width: op.attrs.width as number,
              signed: (op.attrs.signed as boolean) ?? false,
              isLoad: true,
            });
            return;
          }
          if (op.opcode === 'store' && idx === 0) {
            scalar('store');
            accesses.get(off)!.push({ width: op.attrs.width as number, signed: false, isLoad: false });
            return;
          }
          if ((op.opcode === 'store' && idx === 1) || op.opcode === 'call') {
            escaped.add(off); // the address ESCAPES as a value — the point of the capability
            const sink = op.opcode === 'store' ? readsThrough(op) : undefined;
            const read = op.opcode === 'call' ? transferRead(op, idx, off) : undefined;
            if (read !== undefined) {
              const had = calleeReads.get(off) ?? read;
              calleeReads.set(off, { lo: Math.min(had.lo, read.lo), hi: Math.max(had.hi, read.hi) });
              if (read.fill) {
                filledFrom.add(off);
              }
            } else if (sink === undefined) {
              mayWrite.add(off);
            } else {
              (sourceStores.get(off) ?? sourceStores.set(off, []).get(off)!).push({ op, sink });
            }
            if (op.opcode === 'call') {
              passedToCallee.add(off);
              if (idx === 0 && op.attrs.sret === true) {
                (returnTemps.get(off) ?? returnTemps.set(off, []).get(off)!).push(op);
              } else if (idx === 0) {
                const t = op.attrs.target;
                const cs = arg0Callees.get(off) ?? new Set<string | null>();
                cs.add(typeof t === 'string' ? t : null);
                arg0Callees.set(off, cs);
              }
            } else {
              published.add(off); // written to memory — the DMA idiom's `*dmaReg = &tmp`
              // The licence's two conditions, asked of the IR: the WHOLE address (a word), and a
              // destination that is not this frame. `taint` answers the second exactly — it holds
              // every value that may carry one of this function's frame addresses, which is both
              // spellings the pre-lift scan excludes by name (`str rS, [sp]` and a store through
              // another held capture, since at a one-word frame [sp,#0] IS the object).
              if ((op.attrs.width as number) === 4 && taint.get(op.operands[0]) === undefined) {
                publishedOutward.add(off);
              }
            }
            return;
          }
          // A RUNTIME INDEX into the object: `mov r1, sp / add r0, r1, r4 / ldrb r0, [r0]` is
          // agbcc's `a[i]` on a `u8 a[n]` local. The sum names no fixed offset, so it is not a
          // capture of its own; what it may do is judged here, whole, and the object it indexes is
          // judged below with the rest.
          const other = op.opcode === 'add' && op.operands.length === 2 ? op.operands[1 - idx] : undefined;
          if (other !== undefined && taint.get(other) === undefined && defOf.get(other)?.opcode !== 'const') {
            indexedAccess(off, op.results[0]);
            return;
          }
          // A CONSTANT move left after the fold above moves a capture a phi carried. When the phi
          // also carries a pointer from outside the frame — `if (!info) info = &local; info->x` —
          // the missing capability is that merge, not a walk through the frame.
          if (other !== undefined && defOf.get(other)?.opcode === 'const' && !frameOnEveryPath.has(v)) {
            fail(
              `the captured address at [sp,#${off}) reaches a phi that merges it with a pointer from outside the ` +
                'frame, and is then moved by a constant — a field of what may or may not be a local is not modelled',
            );
          }
          // …and when every value the phi carries is this frame's, it is a pointer stepped through
          // the frame, which names a different object on each trip.
          if (other !== undefined && defOf.get(other)?.opcode === 'const') {
            fail(
              `the captured address at [sp,#${off}) reaches a phi and is then moved by a constant — ` +
                'a pointer stepped through the frame names no one object',
            );
          }
          fail(`the captured address flows into \`${op.opcode}\` — not an access, an escape, or a phi`);
        });
      }
    }

    // THE BYTES AN ESCAPE MAY REACH, as `[lo, hi)` relative to the object's own offset. Anything
    // that may write, and anything this cannot bound, reaches the whole frame. A device that only
    // reads is bounded by its channel's control halfword (`readSourceControl`), per TRANSFER: the
    // device reads the object on every arm of the channel from the store that handed it the
    // address until a later word store to the same source register replaces it, so the control
    // stores that bound it are the ones reachable in between. Each has to be a literal the target
    // decodes. A store through a pointer this cannot resolve — one that is this frame's on only
    // some paths included (`frameOnEveryPath`) — may BE the control halfword, so it leaves the
    // read unbounded — as does a transfer never armed here at all. An unbounded device read says
    // which of those it met (`why`): each is a different capability to build. A block transfer
    // that took the address as its source adds the bytes its control word reads (`calleeReads`).
    //
    // A NAMED SYMBOL PLUS A CONSTANT IS RESOLVED WHERE THE SYMBOL MAP PLACES THE NAME, and then
    // exactly, by the overlap test below. agbcc's alias model never lets a C identifier plus a
    // constant meet a literal address (alias.c:812-819, 1064-1068), but nothing in the asm says a
    // name is a C identifier: a disassembly spells an I/O register the way it spells a global
    // (`.word REG_VCOUNT`). So a name the map does not place is an unresolved pointer here.
    //
    // THE PREMISE, stated once and not checkable from one function: a callee or an interrupt
    // handler arms only a transfer it set up itself, source register first. So a call on the path
    // does not unbound the read, and neither does an interrupt at any instruction: whatever re-arms
    // the channel with this frame's address still in the source register is this function's own
    // store, and the walk sees every one of those.
    const at = new Map<Op, { blk: Block; i: number }>();
    for (const blk of irBlocks) {
      blk.ops.forEach((op, i) => at.set(op, { blk, i }));
    }
    const unbounded = (why: string) => ({ lo: -Infinity, hi: Infinity, why });
    const readWindow = (off: number): { lo: number; hi: number; why: string } => {
      // a callee handed only its own return storage writes the struct it returns and nothing else
      const temps = returnTemps.get(off);
      if (temps !== undefined && uses.get(off) === temps.length) {
        return { lo: 0, hi: returnedSize(temps[0]), why: 'that returns its struct into it' };
      }
      const control = target.capabilities.readSourceControl;
      const stores = sourceStores.get(off);
      const called = calleeReads.get(off);
      if (!mayWrite.has(off) && stores === undefined && called !== undefined) {
        return { lo: called.lo, hi: called.hi, why: 'that reads through it' };
      }
      if (mayWrite.has(off) || stores === undefined || control === undefined) {
        return unbounded('that reads through it');
      }
      const little = target.capabilities.endianness === 'little';
      const halves: number[] = [];
      for (const { op: handed, sink } of stores) {
        const cnt = sink + control.offset;
        let armed = false;
        const entered = new Set<Block>();
        const work: [Block, number][] = [[at.get(handed)!.blk, at.get(handed)!.i + 1]];
        walk: while (work.length > 0) {
          const [blk, from] = work.pop()!;
          for (let i = from; i < blk.ops.length; i++) {
            const op = blk.ops[i];
            if (op.opcode !== 'store') {
              continue;
            }
            const base = literalAddrOf(op.operands[0]);
            if (base === undefined) {
              if (!frameOnEveryPath.has(op.operands[0])) {
                return unbounded('a later store through an unresolved pointer may re-arm');
              }
              continue;
            }
            const a = base + (op.attrs.off as number);
            const w = op.attrs.width as number;
            if (a === sink && w === 4) {
              continue walk;
            }
            if (a + w <= cnt || a >= cnt + 2) {
              continue;
            }
            const v = defOf.get(op.operands[1]);
            if (v?.opcode !== 'const' || a > cnt || a + w < cnt + 2) {
              return unbounded('whose control word is not a literal');
            }
            const shift = 8 * (little ? cnt - a : a + w - cnt - 2);
            halves.push(((v.attrs.value as number) >>> shift) & 0xffff);
            armed = true;
          }
          for (const s of blk.ops[blk.ops.length - 1]?.successors ?? []) {
            if (!entered.has(s.block)) {
              entered.add(s.block);
              work.push([s.block, 0]);
            }
          }
        }
        if (!armed) {
          return unbounded('this function never arms');
        }
      }
      let { lo, hi } = called ?? { lo: 0, hi: 0 };
      for (const h of halves) {
        const unit = control.units[(h & control.wideBit) !== 0 ? 1 : 0];
        const mode = control.modes[(h >> control.modeShift) & (control.modes.length - 1)];
        if (mode === null || mode === undefined) {
          return unbounded('whose control word bounds nothing');
        }
        // A device may force the address down to a unit boundary — the GBA's does — so a 32-bit
        // read of the halfword at [sp,#2] reads from [sp,#0], and the object below shares its
        // unit. The frame base is at least unit-aligned, so the offset says how far down.
        lo = Math.min(lo, mode === 'decrement' ? -Infinity : -(off % unit));
        hi = Math.max(hi, mode === 'increment' ? Infinity : unit);
      }
      return { lo, hi, why: 'that reads through it' };
    };
    // THE MODEL IS CHOSEN BEFORE ANY SHAPE IS JUDGED. Where every escape only reads and one reads
    // without bound, the one-object answer below is on offer, and the shapes the per-object model
    // refuses are ones it can hold: a member at [+k] through a capture, two widths or two
    // signednesses at one address, a runtime index, overlapping objects, an object over a slot. So
    // there each of those refusals asks for that answer instead of declining (`shapeRefused`), and
    // the second audit judges the bytes as one object by its own rules — two types at one byte
    // still refuse there. Where the answer is not on offer, each refuses where it stands.
    const windowOf = new Map([...escaped].map((off) => [off, readWindow(off)] as const));
    const oneObjectOnOffer =
      oneObject === undefined &&
      mayWrite.size === 0 &&
      [...windowOf.values()].some((w) => w.lo === -Infinity && w.hi === Infinity);
    let perObjectRefused = false;
    const shapeRefused = (why: string): void => {
      if (!oneObjectOnOffer) {
        fail(why);
      }
      perObjectRefused = true;
    };
    if (memberRefusal !== undefined) {
      shapeRefused(memberRefusal);
    }

    // THE ACCEPTANCE'S PREMISE, RE-ASKED OF THE IR. `capturedObjectIsTheWholeFrame` is a reading
    // of the TEXT and it is the one thing in this file that switches a refusal OFF, so the two
    // facts it claims are re-proven here, where they are exact, rather than left to the
    // approximation that licensed them. Neither is a second opinion on the same evidence: the
    // scan asks what a REGISTER holds at a `bl`; this asks what the finished function does with
    // the OBJECT.
    //
    // THE ADDRESS ESCAPED. The whole licence is "something outside this function is holding the
    // address of this frame", and the pre-lift scan can say that of a register whose value never
    // reaches a call operand or a store — a declared arity trims it away, or the register is dead
    // by the time the call is built. When it does, [sp,#0] has been re-modelled as an addressable
    // object on no evidence at all, and the outgoing argument that really lived there is gone
    // from the call. EITHER escape re-proves it, because either one licensed it: a call taking
    // the address, or a store publishing it outward. They are asked as one question because they
    // license one thing.
    //
    // AND EACH ARM IS AT MOST AS WIDE AS THE LICENCE IT RE-PROVES, which is what makes this a
    // containment rather than a second door. The callee arm is narrower for free — a `call`
    // operand is the address reaching a callee, which is what the scan approximated. The publish
    // arm is `publishedOutward` and not `published` for the same reason spelled out there: read
    // off the wider set, this re-proof accepts a halfword store and a store back into the
    // object's own bytes, both of which the licence refuses by name — so a frame the pre-lift
    // scan would never have licensed passes the check that exists to re-prove the licence.
    //
    // THE CONTAINMENT IS STRICT AND THE SLACK IS ON THIS SIDE. `taint` is whole-function where the
    // pre-lift walk is block-local, so a base captured in an earlier block is refused HERE and
    // accepted THERE. That is the only direction the two can differ in without a wrong answer
    // reaching a caller, and it is structural rather than lucky: this set is built from a superset
    // of the facts the walk has. `packages/core/test/thumb-frontend.test.ts` carries the input.
    //
    // NOT A STRUCT-RETURN TEMP. A one-word frame rules out agbcc's block-copy bases (each needs
    // two words) but NOT the hidden return pointer of a <=4-byte non-integer-like struct, which is
    // exactly one word: `struct S4 { char a,b,c,d; }; struct S4 s = mk(x);` compiles to `add
    // sp,#-4 / mov r0,sp / bl mk / ldr r0,[sp]`, instruction for instruction an out-parameter
    // call. Left alone that lifted as `mk(&sp0, a0)` — a call the real prototype rejects.
    //
    // TWO facts rule it out and either will do, because a return temp is storage the CALLEE owns
    // outright: it is written only by the callee, and the callee RETURNS the struct THROUGH IT.
    // So a store of our own says the object is one this function fills; and a callee whose RETURN
    // is known to need no hidden pointer says the same by the ABI — a function that returns
    // nothing, or returns in a register, has no such pointer to be given, whatever sits in r0.
    //
    // AND THE QUESTION IS PER-CALL, which is what bounds how far it has to be asked: the pointer
    // is argument 0, always (compiled — `struct S4 mk3(int,int,int)` puts sp in r0 and shifts all
    // three real arguments up), so an address NO call takes at argument 0 cannot be one, whatever
    // else the function does with it. That is the whole of `hiddenReturnPointerStands` below and
    // it is why the block-copy idiom `memcpy(dst, buf, sizeof buf)` — buffer at argument 1 — needs
    // no declaration at all. Per-call and not per-object: an address handed over at argument 1
    // somewhere leaves the call that takes it at argument 0 exactly as ambiguous as before, so
    // position acquits a call rather than an object.
    //
    // THE THIRD IS A DECLARATION, NOT AN INFERENCE, and so is its converse: a callee declared to
    // return a struct through memory, whose call the frontend stamps `sret`, makes the object that
    // call's return storage (`returnTemps`). Those two are the only answers here read off something
    // other than the instruction stream. `returnsWithoutHiddenPointer` (aggregate.ts) is where the
    // third is answered, from the project's own `returnsVoid`, from a struct its declaration returns
    // that the target hands back in a register, or from the `returns` of a signature the C standard
    // fixes — the same table whose `params` this file already trusts to decide a call's arity. It is
    // asked of EVERY callee that took the address at argument 0, because the object gets one
    // decision: one callee about whose return nothing is known leaves the ambiguity standing and the
    // refusal fires.
    //
    // AN ARITY CANNOT ANSWER IT, which is worth saying because the count is right there and looks
    // like evidence: a hidden pointer does set one argument register more than the callee
    // declares, but the register count is what the machine WROTE, and a register already holding
    // this function's own incoming parameter is written by nobody. Compiled: `void f(const void
    // *a, const void *b){ struct Blob64 s = makeblob(b); }` emits `add sp,#-0x40 / mov r0,sp /
    // bl makeblob` — one written register against one declared parameter — so counting registers
    // reads a real struct return as an out-parameter and declares the callee's own storage as a
    // local. The question is about the RETURN and only a statement about the return decides it.
    //
    // WHAT IT COSTS WHEN THE DECLARATION IS WRONG, measured rather than compared. On the `sret`
    // shape above, with `mk` (which really returns `struct S4`) declared `params: 1,
    // returnsVoid: true`, the lift succeeds and emits `s32 sret(s32 a0) { s32 sp0; mk(&sp0);
    // return (u8)sp0; }` — a compiling, plausible, WRONG program with the real argument dropped,
    // where a loud decline stood. Not a smaller cost than a wrong ARITY, either: the same entry
    // supplies both facts, so a wrong `returnsVoid` drops the argument too, and the frame re-model
    // is the silent half. The trade is accepted because there IS no other discriminator: compiled
    // through
    // the benchmark's own agbcc command, the hidden struct return and the out-parameter emit the
    // same instructions in the same order, the slot is read back at a scalar width in both, and
    // in both the value read back is what the function returns — so an asm-side corroboration
    // would be a rule with no discriminating input. The mitigation is that under-declaring is the
    // safe direction (a callee whose return nothing describes still declines) and that `FnProto`
    // says so at the field.
    //
    // The residual cost is stated rather than hidden: an OUTPUT-only parameter taken at argument
    // 0 of a callee the project has NOT declared is still byte-for-byte a struct return, and
    // still declines with it.
    //
    // ONE SOURCE FOR THE DECISION AND ITS REASON, because both arms of this audit ask it and a
    // predicate beside a message is two things that can disagree. Returns why the pointer is not
    // ruled out — the caller frames it for its own arm — or null.
    const hiddenReturnPointerStands = (off: number): string | null => {
      const cs = arg0Callees.get(off);
      if (cs === undefined || cs.size === 0) {
        return null;
      }
      const unknown = [...cs].filter((c) => c === null || !returnsWithoutHiddenPointer(c, prototypes, target));
      if (unknown.length === 0) {
        return null;
      }
      return (
        `\`${unknown.map((c) => c ?? '?').join('`, `')}\` takes it at argument 0 and nothing says ` +
        'what that callee returns — a struct returned through a hidden pointer is handed this same frame'
      );
    };
    if (capturedObjectIsTheWholeFrame) {
      if (!passedToCallee.has(0) && !publishedOutward.has(0)) {
        fail(
          'the one-word-frame proof licensed this lift on the frame base escaping, and in the ' +
            'lifted function no call takes it and no word store publishes it outside this frame — ' +
            'so nothing rules out an outgoing stack argument at [sp,#0]',
        );
      }
      const writtenHere = accesses.get(0)?.some((a) => !a.isLoad) === true;
      const whyItStands = writtenHere ? null : hiddenReturnPointerStands(0);
      if (whyItStands !== null) {
        fail(`the one-word frame is never written here, and ${whyItStands}`);
      }
    }

    // TWO MODELS FOR ONE BYTE is a silent disagreement: the slot model keeps an SSA slot in a
    // register, so a store through an object over the same bytes would never be seen there.
    const overlaps = (a: number, aw: number, b: number, bw: number) => a < b + bw && b < a + aw;
    const failIfSlotKeysIt = (off: number, width: number): void => {
      for (const slot of usedSlotOffsets) {
        if (overlaps(off, width, slot, 4)) {
          fail(
            objects.get(off)?.some((op) => foldedHere.has(op))
              ? `the capture moved by a constant to [sp,#${off}) is a move the pre-lift walk does not follow, ` +
                  `so the slot model keys [sp,#${slot}] too — one byte, two models`
              : `the object at [sp,#${off}) overlaps the SSA slot at [sp,#${slot}] — one byte, two models`,
          );
        }
      }
    };

    // EVERY DEVICE ACCESS OF A FUNCTION KEPT AS ONE OBJECT (below) IS MARKED `volatile`, as the
    // source's `REG_*` and `vu32 *dmaRegs` spell them — store and load alike, because agbcc drops
    // or moves either when it is plain:
    //   • a plain store to an address a later store overwrites, with nothing between that may alias
    //     it, is deleted (flow.c:2041-2052), and at -O2 a store of another type does not alias
    //     (strict aliasing, toplev.c:3616) — so of two transfers armed back to back through one
    //     channel, with only a `u16` member store between, the first one's source, destination and
    //     control stores go and that transfer never runs; `REG_IME = 0; … REG_IME = saved;` loses
    //     its first store the same way;
    //   • a plain load in a loop that stores nothing it may alias is invariant, so
    //     `while (REG_VCOUNT != 160);` is hoisted into a loop that never reads the register again.
    // The address may be a literal, a literal plus a runtime index — `(vu32 *)(0x40000B0 + ch*12)`,
    // a channel chosen at run time — or a phi each of whose incoming values is one of those: every
    // way the lift names a device register and not a pointer loaded, passed or computed from
    // nothing it can place. Over-reach costs a spelling and never an access: `volatile` keeps the
    // accesses the machine made, and a marked read is placed once, as a call is
    // (structure/analysis.ts), so the qualifier adds none. The window is the target's
    // `deviceRegisters`, which has to cover every register a source reaches — an address outside
    // it stays plain; without one, it is the channels handed a frame address.
    //
    // A FUNCTION ACCEPTED OBJECT BY OBJECT pins every device read, and of its device stores only
    // those of the first kind (`overwritten`). A read is pinned because a plain one is lost either
    // way: nothing uses the `dmaRegs[2];` that ends a DMA macro, so the lift drops it outright, and
    // a poll is hoisted as above. The stores pinned are those a later store in their own block
    // overwrites, with no call between to clear flow.c's list of pending stores (flow.c:1962). A
    // plain read of its bytes between does not always keep it: one agbcc forwards the stored value
    // to (cse.c) leaves the store dead, and one of another type does not alias. A read it does not
    // forward — a `char` read, or one it extends — keeps it, and pinning a store agbcc keeps costs
    // a spelling. Two fills through one channel back to back is the shape, and plain, the first
    // transfer is gone. Its other device stores stay plain, their qualified spelling left to
    // `/vol-store`'s candidate (l3/volstore.ts): pinned in the structured tree they are pinned in
    // every variation, and the ones that home the base or un-reduce a loop refuse a qualified
    // base, which costs `synthetic:dmastride` and `synthetic:dmaptrsrc` their matches.
    const overwritten = (op: Op, blk: Block, at: number): boolean => {
      if (op.opcode !== 'store') {
        return false;
      }
      const addressOf = (x: Op): number | undefined => {
        const lit = literalAddrOf(x.operands[0]);
        return lit === undefined ? undefined : lit + (x.attrs.off as number);
      };
      // Where `x` starts relative to `op`, when both name their bytes the same way.
      const startOf = (x: Op): { from: number; by: number } | undefined => {
        const sameBase = x.operands[0] === op.operands[0];
        const from = sameBase ? (op.attrs.off as number) : addressOf(op);
        const by = sameBase ? (x.attrs.off as number) : addressOf(x);
        return from === undefined || by === undefined ? undefined : { from, by };
      };
      const width = op.attrs.width as number;
      for (const later of blk.ops.slice(at + 1)) {
        if (later.opcode === 'call') {
          return false;
        }
        const s = later.opcode === 'store' ? startOf(later) : undefined;
        if (s !== undefined && s.by <= s.from && s.by + (later.attrs.width as number) >= s.from + width) {
          return true;
        }
      }
      return false;
    };
    const pinDeviceAccesses = (pins: (op: Op, blk: Block, at: number) => boolean): void => {
      const sinks = [...new Set([...sourceStores.values()].flat().map((s) => s.sink))];
      if (sinks.length === 0) {
        return;
      }
      const reach = (target.capabilities.readSourceControl?.offset ?? 2) + 2;
      const window = target.capabilities.deviceRegisters;
      const isDevice = (a: number, w: number): boolean =>
        window !== undefined ? a >= window[0] && a + w <= window[1] : sinks.some((s) => a < s + reach && a + w > s);
      const incoming = new Map<Value, Value[]>();
      for (const blk of irBlocks) {
        for (const op of blk.ops) {
          for (const sx of op.successors ?? []) {
            sx.args.forEach((arg, i) => {
              const param = sx.block.params[i];
              if (param !== undefined) {
                (incoming.get(param) ?? incoming.set(param, []).get(param)!).push(arg);
              }
            });
          }
        }
      }
      // The literal a pointer is a device register plus a runtime index from. `'cycle'` is a phi
      // already on the walk — a pointer stepped around a loop — which contradicts nothing, so a phi
      // is placed by the incoming values that are not its own back edge.
      const placed = (v: Value, onWalk: Set<Value>, depth = 0): number | 'cycle' | undefined => {
        const lit = literalAddrOf(v);
        if (lit !== undefined || depth > 8) {
          return lit;
        }
        const d = defOf.get(v);
        if (d?.opcode === 'add' && d.operands.length === 2) {
          const [x, y] = d.operands.map((o) => placed(o, onWalk, depth + 1));
          return typeof x === 'number' ? x : typeof y === 'number' ? y : (x ?? y);
        }
        const ins = d === undefined ? incoming.get(v) : undefined;
        if (ins === undefined || onWalk.has(v)) {
          return ins === undefined ? undefined : 'cycle';
        }
        onWalk.add(v);
        const each = ins.map((a) => placed(a, onWalk, depth + 1));
        onWalk.delete(v);
        if (each.some((a) => a === undefined || (typeof a === 'number' && !isDevice(a, 1)))) {
          return undefined;
        }
        return each.find((a) => typeof a === 'number') ?? 'cycle';
      };
      for (const blk of irBlocks) {
        blk.ops.forEach((op, at) => {
          if (op.opcode !== 'store' && op.opcode !== 'load') {
            return;
          }
          const base = placed(op.operands[0], new Set());
          if (
            typeof base === 'number' &&
            isDevice(base + (op.attrs.off as number), op.attrs.width as number) &&
            pins(op, blk, at)
          ) {
            op.attrs = { ...op.attrs, volatile: true };
          }
        });
      }
    };

    // ONE OBJECT IN MEMORY, the answer a device read nothing bounds is given instead of a refusal
    // (`oneObject`, requested below where the escapes are judged). Every byte of `[from, to)` is
    // declared one `u8` array whose address the device holds, and every access inside it is a
    // cast-spelled access to that array — so each store the machine made there is a store the
    // recompile makes too. That is what agbcc does for an object whose address escaped: it keeps
    // every store to it, in order (flow.c deletes a memory store only when an identical later
    // store in the same block overwrites it). And it is right whichever the source had there: a
    // member of the escaped object, which the device may read, or a spill, which no one reads —
    // the asm spells both as a store and a reload, and keeping a spill in memory changes no value.
    if (oneObject !== undefined) {
      const { from, to } = oneObject;
      const kept = `the bytes [sp,#${from}) to [sp,#${to}) kept as one object`;
      for (const off of objects.keys()) {
        if (off < from || off >= to) {
          fail(`the object at [sp,#${off}) lies outside ${kept}`);
        }
      }
      for (const slot of usedSlotOffsets) {
        if (overlaps(slot, 4, from, to - from)) {
          fail(`the SSA slot at [sp,#${slot}] lies inside ${kept} — one byte, two models`);
        }
      }
      // A writer is not what this keeps: a callee handed an address inside the object may write
      // any byte of the frame, and the object's extent says nothing about how far.
      if (mayWrite.size > 0) {
        fail(
          `${kept} are reached by an address a callee or a store may write through, not only by a device that reads`,
        );
      }
      // A runtime index names no byte, so no access type can be checked against the others at the
      // bytes it reaches — except a byte access, which needs none: character types alias every type.
      if ([...indexed.values()].some((xs) => xs.some((x) => x.width !== 1))) {
        fail(
          `a runtime index into ${kept} accesses more than a byte, and names no byte whose type it can be checked against`,
        );
      }
      // ONE TYPE PER BYTE. agbcc at -O2 turns on type-based alias analysis (toplev.c:3616), and
      // compiled, a `u32` read through a cast is served the earlier `u32` store straight past a
      // `u16` store to the same bytes — a stale value. So a byte two accesses of different widths
      // reach cannot be spelled through casts. A byte access is exempt, since character types
      // alias everything, and so is a signedness difference, since the signed and unsigned types
      // of one width share an alias set (c-common.c:1962-1974). The first audit asks for this
      // answer rather than refusing two widths — an object read at both, or a `strh` member through
      // the captured address over a word the slot model had — so this is where they refuse.
      const widthAt = new Map<number, number>();
      for (const m of members) {
        if (m.at < from || m.at + m.width > to) {
          fail(`an access of ${m.width} bytes at [sp,#${m.at}) reaches past ${kept}`);
        }
        if (m.width === 1) {
          continue;
        }
        for (let b = m.at; b < m.at + m.width; b++) {
          const had = widthAt.get(b);
          if (had !== undefined && had !== m.width) {
            fail(
              `the byte at [sp,#${b}] of ${kept} is accessed ${had} and ${m.width} bytes wide, and agbcc at -O2 ` +
                'lets a read of one type pass a store of the other (strict aliasing) — a cast spelling would read stale',
            );
          }
          widthAt.set(b, m.width);
        }
      }
      // Rewritten onto one `laddr` at `from`: an access through a member at `k` becomes an access
      // at `k - from` off the object, and a member address used any other way becomes the object's
      // address moved by that constant.
      const object = mkOp('laddr', {
        results: [mkValue(T.unk(32))],
        attrs: {
          off: from,
          width: 1,
          signed: false,
          count: to - from,
          ...(published.size > 0 || filledFrom.size > 0 ? { volatile: true } : {}),
        },
      });
      const base = object.results[0];
      const memberAt = new Map<Value, number>();
      for (const op of [...objects.values()].flat()) {
        memberAt.set(op.results[0], op.attrs.off as number);
      }
      const stillUsed = new Set<Value>();
      for (const blk of irBlocks) {
        for (const op of blk.ops) {
          const at = memberAt.get(op.operands[0]);
          if ((op.opcode === 'load' || op.opcode === 'store') && at !== undefined) {
            op.operands = [base, ...op.operands.slice(1)];
            op.attrs = { ...op.attrs, off: (op.attrs.off as number) + at - from };
          }
          op.operands.forEach((v) => memberAt.has(v) && stillUsed.add(v));
          (op.successors ?? []).forEach((sx) => sx.args.forEach((v) => memberAt.has(v) && stillUsed.add(v)));
        }
      }
      const atBase = (v: Value): Value => (memberAt.get(v) === from ? base : v);
      for (const blk of irBlocks) {
        blk.ops = blk.ops.flatMap((op) => {
          const at = op.opcode === 'laddr' ? memberAt.get(op.results[0]) : undefined;
          if (at === undefined) {
            op.operands = op.operands.map(atBase);
            (op.successors ?? []).forEach((sx) => (sx.args = sx.args.map(atBase)));
            return [op];
          }
          if (!stillUsed.has(op.results[0]) || at === from) {
            return [];
          }
          const by = mkValue(T.unk(32));
          return [
            mkOp('const', { results: [by], attrs: { value: at - from } }),
            mkOp('add', { operands: [base, by], results: op.results }),
          ];
        });
      }
      irBlocks[0].ops.unshift(object);
      pinDeviceAccesses(() => true);
      return undefined;
    }

    // THE FRAME RESERVATION IS AN EXTENT, when the reserved area is provably one object's alone.
    // `add sp, sp, #-0x10` reserves sixteen bytes; if exactly one address-taken object sits at the
    // bottom of them, the slot model keys none of them, and no outgoing argument block is staged
    // in them, then there is nothing else those bytes can be — a compiler does not reserve frame
    // for nothing. That is the frame-accounting equation the escape rules below already solve word
    // by word, asked in the other direction: they check that the objects and slots TILE the
    // reserved area, this reads the area off as the one object's size.
    //
    // Returns why it does not apply, or null. Every clause refuses in its own words: the reason an
    // acceptance did not fire is as much an attribution as the reason a lift declined, and one
    // sentence covering all of them is how several gaps come to look like one.
    //
    // FIVE CLAUSES BOUND THIS PATH — a second object, a slot inside the area, an object that does
    // not start at the bottom of it, an address that reaches memory rather than a callee, and the
    // callee's declared return — and each has a test that fails without it. The precautionary
    // ones are marked where they sit.
    //
    // The last two are about an ESCAPE, and they are asked only of an object that escapes or that
    // nothing in this function addresses. An object this function indexes and never lets go of is
    // written and read by its own indexed accesses alone, so the reservation is all there is to
    // size it by: `u8 a[8]; for (j = 0; j < 8; j++) a[j] = tbl[j]; return a[i];`.
    const notTheWholeArea = (off: number, indexedHere: boolean): string | null => {
      if (objects.size !== 1) {
        return 'another address-taken object shares the frame, so the reservation is not this one alone';
      }
      if (usedSlotOffsets.size > 0) {
        const lowest = [...usedSlotOffsets].sort((a, b) => a - b)[0];
        return `the slot model keys [sp,#${lowest}], so part of the reserved area is not this object`;
      }
      // PRECAUTIONARY, and each names why nothing reaches it — so the next reader does not read
      // two dead lines as live rules, and knows what would wake each one. They are kept
      // because every one of them guards a SILENT wrong answer: storage declared over bytes the
      // object does not own is a frame the recompile lays out differently, with no diagnostic.
      //   • An outgoing block is staged at the BOTTOM of the reserved area, exactly where this
      //     object claims to start, and neither way in reaches: a block stored on every path keys
      //     its offsets as slots at the call, so the slot clause above fires first, and a block
      //     NOT stored on every path is `analyzeOutgoingArgs`'s own blocker, which turns the slot
      //     model OFF — and no untyped object survives that, because every `laddr` mint is behind
      //     `slotsOk`. The second half is also why nothing here asks whether the analysis LICENSED
      //     the block: an `laddr` exists only in a function where it did, by construction.
      //   • An address that neither accesses nor escapes already declines where the audit
      //     classifies its uses ("flows into `ret`"), so it never arrives here unescaped.
      if (declared.from > owned.from) {
        return `[sp,#${owned.from}) to [sp,#${declared.from}) stages outgoing stack arguments, which belong to the callee`;
      }
      if (off !== declared.from || declared.to <= declared.from) {
        return 'the object does not start at the bottom of the reserved area, so something below it is unaccounted for';
      }
      if (!escaped.has(off)) {
        return indexedHere
          ? null
          : 'the address never leaves this function, so there is no writer of the storage to size it for';
      }
      if (!passedToCallee.has(off)) {
        return 'the address is published rather than passed as an argument, and nothing declares what reads it';
      }
      // The frame's SIZE changes nothing about whose storage it is, so the hidden-pointer question
      // is the one the one-word arm asks, asked here of the same callees.
      return hiddenReturnPointerStands(off);
    };

    // The SHAPE of each object — `count` elements of `width` bytes, spanning `width * count` —
    // and then that its bytes belong to nothing else.
    //
    // AN OBJECT OVER A SLOT IS REFUSED LAST, after the one-object answer below is asked: that
    // answer routes every word of the local area through `laddr`, so no slot is left for the
    // object to overlap, and refusing first would decline exactly the frames it exists for — an
    // object at [sp,#0] whose first member is a word stored `str rN, [sp]`. The other per-object
    // refusals here go through `shapeRefused`, for the same reason.
    const extent = new Map<number, { width: number; count: number }>();
    // the declared struct each return temp is, by offset
    const aggregateAt = new Map<number, IrType>();
    const overSlot: [number, number][] = [];
    const slotKeys = (off: number, width: number): boolean =>
      [...usedSlotOffsets].some((slot) => overlaps(off, width, slot, 4));
    for (const [off, acc] of accesses) {
      const byIndex = indexed.get(off) ?? [];
      const temps = returnTemps.get(off);
      if (temps !== undefined) {
        // The callee writes the whole struct and this function names it once, as the call's
        // destination. A read of a member, or any other use of the address, is not modelled —
        // and most such reads never arrive here: the Thumb slot model refuses a word of the temp
        // read at a constant offset first ("stack pointer used as data"), a copy of the whole
        // struct into a global (`gS8 = mk8(x)`, which agbcc stages through the temp) included. So
        // modelling member reads starts with the slot model handing this audit a read return temp.
        const callee = temps[0].attrs.target as string;
        const type = temps[0].results[0].type;
        const spelling = type.kind === 'struct' ? (type.declared ?? `struct ${type.name}`) : typeToString(type);
        if (temps.some((t) => !typeEquals(t.results[0].type, type))) {
          fail(`the object at [sp,#${off}) is the struct-return storage of calls declared to return different types`);
        }
        if (acc.length > 0 || byIndex.length > 0) {
          fail(
            `the object at [sp,#${off}) is where \`${callee}\` returns ${spelling}, and this function also reads or ` +
              'writes it — a member of a returned struct is not modelled',
          );
        }
        if (uses.get(off) !== temps.length) {
          fail(
            `the object at [sp,#${off}) is where \`${callee}\` returns ${spelling}, and its address is also used ` +
              'another way — only the call it is returned by is modelled',
          );
        }
        extent.set(off, { width: 1, count: returnedSize(temps[0]) });
        aggregateAt.set(off, type);
        continue;
      }
      if (acc.length === 0) {
        // An object with no access of its own has no declared type and no extent, and the two
        // ways it gets there are two different gaps. Its bytes may already be keyed by the slot
        // model, which one byte is enough to decide; otherwise nothing in-function pins it at
        // all, and a guessed declaration is the plausible-but-wrong class.
        if (slotKeys(off, 1)) {
          overSlot.push([off, 1]);
          continue;
        }
        const why = notTheWholeArea(off, byIndex.length > 0);
        if (why !== null) {
          shapeRefused(
            (byIndex.length > 0
              ? 'the captured address is addressed only through a runtime index'
              : 'the captured address is never dereferenced in this function') +
              `, so nothing pins the local object type — and ${why}`,
          );
        }
        // An indexed access reads ONE ELEMENT of the storage declared below, so it must be one:
        // an unsigned byte. A wider element is a different array over the same bytes, and a
        // sign-extending read is not what `u8` spells.
        for (const a of byIndex) {
          if (a.width !== 1) {
            shapeRefused(
              `a runtime index into the object at [sp,#${off}) accesses ${a.width} bytes, and the storage ` +
                'nothing else types is declared as bytes — only a byte element is modelled',
            );
          }
          if (a.signed) {
            shapeRefused(
              `a runtime index into the object at [sp,#${off}) sign-extends, and the storage is declared unsigned`,
            );
          }
        }
        // STORAGE, NOT A TYPE. The reservation says how many bytes the frame holds and the
        // conjuncts above say they are all this object's, so the declaration commits to an EXTENT
        // and to nothing else: `u8 name[n]` over the declared range, unsigned bytes because no
        // access named an element type and inventing one is the guess this refuses everywhere else.
        //
        // THE EXTENT IS A ROUNDED ONE, stated because it is not a defect. agbcc reserves the
        // local area in whole words, so a source object of 13, 14, 15 or 16 bytes all reserve
        // sixteen — compiled and diffed at the row's own flags, `u8 x[0xD]` and `u8 x[0x10]`
        // reach the same object where `u8 x[0xC]` and `u8 x[0x11]` do not. What is declared is
        // the RESERVATION, which is the thing the asm carries; every source extent inside one
        // word of it emits the same object, so no member of that class is more right than this.
        //
        // NO COMPILER TERM, unlike `capturedObjectIsTheWholeFrame`, whose one-word reading is a
        // fact about what agbcc puts in a four-byte frame. This argument needs only that the
        // reservation ROUNDS UP to some granularity, which is a property of every stack ABI, and
        // it declares the reservation rather than a guess inside it — so a coarser rounding makes
        // the declared extent coarser too, never wrong about the bytes the machine reserved.
        extent.set(off, { width: 1, count: declared.to - declared.from });
        continue;
      }
      if (byIndex.length > 0) {
        shapeRefused(
          `a runtime index into the object at [sp,#${off}), which an access of its own types as one ` +
            'scalar — only the untyped storage of the whole reserved area is indexed',
        );
      }
      const widths = new Set(acc.map((a) => a.width));
      if (widths.size > 1) {
        shapeRefused(`the accesses through the captured address disagree on width (${[...widths].join(' vs ')})`);
      }
      // …and on SIGNEDNESS, over the loads, for the same reason: one declared type extends one
      // way, so an object read by both `ldrsb` and `ldrb` has no faithful declaration —
      // `sp4 - sp4` would fold to 0 where the machine computes sext(b) - zext(b). Loads only: a
      // store extends nothing, and `strb` beside `ldrsb` is not a disagreement.
      const signs = new Set(acc.filter((a) => a.isLoad).map((a) => a.signed));
      if (signs.size > 1) {
        shapeRefused(
          'the loads through the captured address disagree on signedness — one declared type extends one way',
        );
      }
      // …and a scalar this function only READS is the callee's to fill, which is what a struct
      // return's hidden temp is: agbcc spells `s = mk(x)` above an outgoing block as `add r0, sp,
      // #0x4 / bl mk / ldr r0, [sp, #0x4]`, instruction for instruction an out-parameter call. The
      // question the whole-frame and untyped arms ask, asked of every object.
      const whyItStands = acc.some((a) => !a.isLoad) ? null : hiddenReturnPointerStands(off);
      if (whyItStands !== null) {
        fail(`the object at [sp,#${off}) is never written here, and ${whyItStands}`);
      }
      extent.set(off, { width: acc[0].width, count: 1 });
    }
    // Each object must own its bytes outright: inside the reserved local area, clear of every SSA
    // slot (`overSlot`, refused below), and clear of every other object.
    const objs = [...extent].sort((x, y) => x[0] - y[0]);
    const span = (o: { width: number; count: number }) => o.width * o.count;
    for (const [off, obj] of objs) {
      if (off < owned.from || off + span(obj) > owned.to) {
        fail(`the object at [sp,#${off}) of width ${span(obj)} lies outside the reserved local area`);
      }
      if (slotKeys(off, span(obj))) {
        overSlot.push([off, span(obj)]);
      }
    }
    for (let i = 1; i < objs.length; i++) {
      const [off, obj] = objs[i];
      const [prev, prevObj] = objs[i - 1];
      if (overlaps(prev, span(prevObj), off, span(obj))) {
        shapeRefused(`the objects at [sp,#${prev}) and [sp,#${off}) overlap — one byte, two models`);
      }
    }
    // …computed ONCE, with whether the escape may write and how it left, and read by every rule an
    // escape retracts (`FRAME_ESCAPE_GATES`), so a new bound — a callee's declared extent — has one
    // place to go.
    const frameUndef = irBlocks.some((blk) =>
      blk.ops.some((op) => op.opcode === 'undef' && slotKeyOffset(op.attrs.key as string) !== null),
    );
    const accountedWords = new Set<number>();
    for (const [off, obj] of extent) {
      for (let w = off - (off % 4); w < off + span(obj); w += 4) {
        accountedWords.add(w);
      }
    }
    for (const slot of usedSlotOffsets) {
      accountedWords.add(slot - (slot % 4));
    }
    const unaccountedIn = (lo: number, hi: number): number | undefined => {
      for (let w = owned.from; w < owned.to; w += 4) {
        if (!accountedWords.has(w) && w < hi && w + 4 > lo) {
          return w;
        }
      }
      return undefined;
    };
    const escapes: FrameEscape[] = [...escaped].map((off) => {
      const { lo, hi, why } = windowOf.get(off)!;
      const writes = mayWrite.has(off);
      const objectReached = [...extent].find(([o, obj]) => o !== off && o < off + hi && off + lo < o + span(obj));
      let slotReached: FrameEscape['slotReached'];
      for (const slot of usedSlotOffsets) {
        if (slot > off && slot < off + hi) {
          slotReached = { slot, above: true };
          break;
        }
        if (slot < off && slot >= declared.from && slot + 4 > off + lo) {
          slotReached = { slot, above: false };
          break;
        }
      }
      return {
        off,
        lo,
        hi,
        writes,
        how: passedToCallee.has(off)
          ? 'is passed to a callee'
          : writes
            ? 'is stored to memory'
            : `is handed to a device ${why}`,
        objectReached: objectReached?.[0],
        slotReached,
        frameUndef,
        unaccountedWord: unaccountedIn(off + lo, off + hi),
      };
    });
    const escapeRefusal = (id: string, e: FrameEscape): string => {
      const at = `the captured address at [sp,#${e.off}) ${e.how}`;
      switch (id) {
        case 'reaches-another-object':
          return e.lo === -Infinity && e.hi === Infinity
            ? 'the captured address escapes, so something outside this function reaches the whole frame — including another object'
            : `${at}, which may read the object at [sp,#${e.objectReached})`;
        case 'writer-over-undef':
          return 'the captured address escapes, so a callee may write any frame offset and an unstored slot is not provably uninitialised';
        case 'reaches-a-slot':
          return !e.slotReached!.above
            ? `${at}, and it may point INTO an object that starts lower — the slot at [sp,#${e.slotReached!.slot}] below it is kept in a register, not the frame`
            : e.writes
              ? `${at}, which may write the slot at [sp,#${e.slotReached!.slot}] — this function's own store there would be forwarded past the write`
              : `${at}, which may read the slot at [sp,#${e.slotReached!.slot}] — this function's own store there is kept in a register, not the frame`;
        default:
          return (
            `the word at [sp,#${e.unaccountedWord}] is neither an object this lift models nor a slot it keys, ` +
            `and the captured address reaches something that may ${e.writes ? 'write' : 'read'} it — nothing accounts for the ` +
            "rest of the frame, so nothing bounds the captured object's extent"
          );
      }
    };
    // …unless the one-object answer is on offer (every escape only READS and one of them reads
    // without bound) and the per-object model does not describe the frame: it refused a shape, an
    // object sits over a slot, or the unbounded read reaches another object, a slot or a word
    // nothing accounts for. Then what
    // the device may read is kept rather than refused: lift again with the local area as one object
    // in memory (`oneObject` above). Below the local area are the outgoing arguments and above it
    // the saved registers, neither of them an object. Where the per-object model does describe the
    // frame — one object and nothing else in reach — it stands, and the object keeps its own type.
    if (
      oneObjectOnOffer &&
      (perObjectRefused ||
        overSlot.length > 0 ||
        escapes.some(
          (e) =>
            e.lo === -Infinity &&
            e.hi === Infinity &&
            (e.objectReached !== undefined || e.slotReached !== undefined || e.unaccountedWord !== undefined),
        ))
    ) {
      return { oneObject: { from: declared.from, to: declared.to } };
    }
    for (const [off, width] of overSlot) {
      failIfSlotKeysIt(off, width);
    }
    // RULE-MAJOR, not escape-major: every escape is asked a rule before any is asked the next, so
    // the refusal a function reports does not turn on the order its escapes were found in.
    for (const gate of gates) {
      const hit = escapes.find((e) => gate.rejects(e));
      if (hit !== undefined) {
        fail(escapeRefusal(gate.id, hit));
      }
    }
    // Proven. Stamp the MACHINE FACTS the audit established — width and signedness are what the
    // accesses used, so the declaration downstream is a fact, not a guess. The C-level NAME is
    // deliberately NOT chosen here: identifiers live in the structurer's namespace (params,
    // locals, globals, the symbol map), which the frontend cannot see — a frontend-chosen `sp0`
    // silently shadowed a project global of the same name.
    // `volatile` iff the address is PUBLISHED — written to memory, rather than handed to a
    // callee. That is the DMA idiom this rule was written for and it IS the source's own
    // spelling there: klonoa's `DMA_FILL` writes `vu##bit tmp` outright, sa3's does under
    // `PLATFORM_GBA`, pokeemerald's inside `DMA_FILL_UNCHECKED`, and the address goes to a device
    // register through a store. Reproducing that source means reproducing the qualifier.
    //
    // …and iff it is the FIXED source of a block transfer (`filledFrom`), the same idiom through a
    // BIOS call: every fill macro writes `vu##bit tmp = value; CpuSet((void *)&tmp, …)` (sa3's
    // cpuset_macros.h, pokeemerald's macro.h). Compiled, the plain spelling is not the same
    // program: a `u16` parameter stored to a plain `u16 tmp` loses its `lsl`/`lsr` pair, and the
    // pool loads around the call reorder.
    //
    // NOT on an ordinary `&local` ARGUMENT, where no source in the corpus writes one and the
    // qualifier is not free. `void f(u32 i){ s32 w; w = gEnts[i].h; use(&w); four(w,w,w,w); }`
    // compiles to one `ldr` reloaded into four registers by copies; the structurer emits one C
    // read per USE rather than per machine load, so `volatile` forbids the CSE and makes it four
    // `ldr`s — a byte-exact candidate turned into a four-instruction nonmatch (compiled, agbcc
    // 2.9-arm-000512, `-O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix`). It is free
    // only where the object is read at most once, which is all the rows that first shipped it
    // did. agbcc also warns `discards qualifiers` at every such call.
    //
    // NOT because gcc would otherwise delete the store. That claim was here for several releases
    // and does not reproduce: taking `&tmp` makes the local addressable, so gcc-2.9 keeps the
    // store with or without the qualifier, measured on store-then-escape, publish-then-fill, and
    // a loop that stores and escapes each iteration. What the qualifier does change is register
    // ALLOCATION — the same function compiled `vu16` and `u16` is 98 instructions either way and
    // differs in three register assignments — which is why it still has to be right. asmlift's
    // OWN dead-store pass keys on address-taken, not on the qualifier (l3/dce.ts), so dropping the
    // qualifier here cannot cost a store.
    //
    // An object whose address never leaves the function needs no volatile and must not pay it.
    //
    // AN UNTYPED OBJECT REACHES THIS RULE TOO, where the address is both published and handed to
    // a callee whose return is declared. It cannot pay the price above — that price is a read the
    // compiler may no longer fold, and an object with no access in this function has none —
    // compiled at the corpus's flags, the qualified and plain spellings are byte-identical and
    // differ in two `discards qualifiers` warnings. So the rule is the same rule, and the reason
    // it is free here is not the reason it is free on a scalar read once.
    for (const [off, ops] of objects) {
      const { width, count } = extent.get(off)!;
      const signed = accesses.get(off)!.some((a) => a.signed);
      const aggregate = aggregateAt.get(off);
      for (const op of ops) {
        const qualified = published.has(off) || filledFrom.has(off);
        op.attrs = {
          ...op.attrs,
          width,
          signed,
          count,
          ...(qualified ? { volatile: true } : {}),
          ...(aggregate !== undefined ? { aggregate: true } : {}),
        };
        // a return temp's address points at the struct the call returns
        if (aggregate !== undefined) {
          op.results[0].type = T.ptr(aggregate);
        }
      }
    }
    pinDeviceAccesses((op, blk, at) => op.opcode === 'load' || overwritten(op, blk, at));
  }
  return undefined;
}

/** The size of the struct a call stamped `sret` returns through its argument 0 (frontend/thumb.ts
 *  types the call's result as that struct). */
function returnedSize(call: Op): number {
  const t = call.results[0].type;
  if (t.kind !== 'struct' || t.size === undefined) {
    throw new Error(`a call stamped sret returns ${typeToString(t)}, not a laid-out struct`);
  }
  return t.size;
}

/** THE CALLER-SIDE SEAM. A frontend calls the audit THROUGH this record rather than through the
 *  binding above, so a process outside core can put a wrapped `gates` table in front of a real
 *  lift (`pnpm bench gates --pass frame-objects`): a module-namespace binding is read-only and
 *  cannot be swapped (`apps/benchmark/src/run/gate-census.ts`, WHAT PUTS A PASS IN THE REGISTRY). */
export const FRAME_OBJECT_AUDIT: { run: (audit: FrameObjectAudit) => FrameObjectRelift | undefined } = {
  run: (audit) => auditFrameObjects(audit),
};
