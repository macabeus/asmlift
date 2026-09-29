/** THE FRAME-OBJECT AUDIT, over finished IR and the frame partition a frontend measured.
 *
 *  NOTHING HERE DECODES. A frontend lowers each address it can name as a frame offset to an
 *  `laddr` (Thumb: `mov rD, sp`, `add rD, sp, #k`, a capture moved by a constant) and hands over
 *  what only it can measure — the reserved local area, the outgoing-argument block at its bottom,
 *  the offsets its slot model keyed, the one licence it grants on the text
 *  (`capturedObjectIsTheWholeFrame`), and the captures it moved. The rules that decide whether
 *  those `laddr`s are objects the emitted C can declare are asked of the IR here, the same for
 *  every ISA — the level-tower split for this frame model: the frontend supplies the PARTITION,
 *  the shared pass applies the rule. Messages name the frame base `sp`.
 *
 *  Thumb is the only caller today; the worked examples below are agbcc's, because agbcc is the
 *  compiler every rule was measured against. */
import { type Block, type Op, type Value, mkOp, mkValue } from '../ir/core';
import { T } from '../ir/types';
import { type Prototypes, returnsWithoutHiddenPointer } from '../proto';
import type { SymbolMap } from '../symbols';
import type { TargetDescription } from '../target';
import { FrontendUnsupportedError } from './errors';
import { slotKeyOffset } from './ssa';

export interface FrameObjectAudit {
  name: string;
  irBlocks: Block[];
  localArea: number;
  usedSlotOffsets: ReadonlySet<number>;
  /** the outgoing stack-argument area the frame stages at [0, area) — the bottom of the reserved
   *  area, which is where an untyped object claims to start */
  outgoingArea: number;
  capturedObjectIsTheWholeFrame: boolean;
  /** every capture the add arm re-minted at a constant offset from it */
  movedCaptures: ReadonlySet<Value>;
  prototypes: Prototypes;
  symbols: SymbolMap | undefined;
  target: TargetDescription;
}

/** FRAME-OBJECT AUDIT. Every `laddr` the frontend emitted is only a CLAIM that the address it
 *  names is used as "the address of one local object"; this proves it, over the finished function,
 *  the same boundary-total style as the slot-escape assert in finish(). The address may flow
 *  anywhere as a VALUE — into an MMIO register (the DMA-fill idiom), a call, a phi — but every
 *  MEMORY access through it must be at offset 0, with one agreed width and one agreed extension,
 *  its bytes must belong to nothing else in the frame, and any use the audit cannot vouch for declines the whole function
 *  loudly. Nothing here guesses: a scalar's declared type is exactly the access type the machine
 *  used, and an object NO access reaches is sized by the frame reservation and left untyped.
 *
 *  Takes its inputs explicitly rather than closing over `lift`. Every one of them is READ, none is
 *  reassigned, and the only mutations are to the ops reachable through `irBlocks`: a moved-from
 *  capture nothing reads is dropped, a capture addressed through at fixed offsets is split into
 *  the objects its accesses name, and each surviving `laddr` is stamped with its width,
 *  signedness, count and `volatile`. */
export function auditFrameObjects({
  name,
  irBlocks,
  localArea,
  usedSlotOffsets,
  outgoingArea,
  capturedObjectIsTheWholeFrame,
  movedCaptures,
  prototypes,
  symbols,
  target,
}: FrameObjectAudit): void {
  // A capture the add arm MOVED by a constant and nothing else reads names no object — the moved
  // one does — so it is dropped rather than judged as an object with no use. Only those: an
  // unused `mov rD, sp` of the machine's own is still a capture, and is judged.
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
      (op) => op.opcode !== 'laddr' || read.has(op.results[0]) || !movedCaptures.has(op.results[0]),
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
    // bare pool word, `gaddr` is the same word after the symbol map named it, and `add` is the
    // base+displacement form an interior attribution produces — three spellings of one address,
    // which is the point: the answer must not turn on which one the assembly happened to use.
    const literalAddrOf = (v: Value, depth = 0): number | undefined => {
      const d = defOf.get(v);
      if (d === undefined || depth > 2) {
        return undefined;
      }
      if (d.opcode === 'const') {
        return d.attrs.value as number;
      }
      if (d.opcode === 'gaddr') {
        return addrOfName.get(d.attrs.sym as string) ?? undefined;
      }
      if (d.opcode === 'add' && d.operands.length === 2) {
        const base = literalAddrOf(d.operands[0], depth + 1);
        const disp = defOf.get(d.operands[1]);
        if (base !== undefined && disp?.opcode === 'const') {
          return base + (disp.attrs.value as number);
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
    // local area — and no rule below is about that gap.
    for (const off of objects.keys()) {
      if (off >= localArea) {
        fail(
          `the captured address at [sp,#${off}) is above the reserved local area of ${localArea} bytes — ` +
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
    // …and for the others, the source registers they reached, which is where `readWindow` below
    // reads how far the device reads
    const readerSinks = new Map<number, number[]>();
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
    for (const blk of irBlocks) {
      for (const op of blk.ops) {
        op.operands.forEach((v, idx) => {
          const off = taint.get(v);
          if (off === undefined) {
            return;
          }
          const scalar = (kind: string) => {
            if ((op.attrs.off as number) !== 0) {
              fail(
                `a ${kind} at [+${op.attrs.off}] through the captured address — ` +
                  (splitRefusal.get(v) ?? 'only a scalar at the captured address is modelled'),
              );
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
            if (sink === undefined) {
              mayWrite.add(off);
            } else {
              (readerSinks.get(off) ?? readerSinks.set(off, []).get(off)!).push(sink);
            }
            if (op.opcode === 'call') {
              passedToCallee.add(off);
              if (idx === 0) {
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
          // A CONSTANT move the lift did not fold is one `heldFrameWalk` could not follow — made in
          // another block than the capture, after a call, or by a constant held in a register — so
          // no frame word was keyed to the offset it names, and saying so is the attribution.
          if (other !== undefined && defOf.get(other)?.opcode === 'const') {
            fail(
              `the captured address at [sp,#${off}) is moved by a constant the pre-lift walk does not follow ` +
                "(it follows a move by an immediate in the capture's own block, with no call between)",
            );
          }
          fail(`the captured address flows into \`${op.opcode}\` — not an access, an escape, or a phi`);
        });
      }
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
    // THE THIRD IS A DECLARATION, NOT AN INFERENCE, and it is the ONLY refusal this frontend
    // switches off on something other than the instruction stream. `returnsWithoutHiddenPointer`
    // (proto.ts) is where it is answered, from the project's own `returnsVoid` or from the
    // `returns` of a signature the C standard fixes — the same table whose `params` this file
    // already trusts to decide a call's arity. It is asked of EVERY callee that took the address
    // at argument 0, because the object gets one decision: one callee about whose return nothing
    // is known leaves the ambiguity standing and the refusal fires.
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
      const unknown = [...cs].filter((c) => c === null || !returnsWithoutHiddenPointer(c, prototypes));
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
          fail(`the object at [sp,#${off}) overlaps the SSA slot at [sp,#${slot}] — one byte, two models`);
        }
      }
    };

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
    // callee's declared return — and each has a test that fails without it. The precautionary ones are marked where they sit.
    const notTheWholeArea = (off: number): string | null => {
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
      if (outgoingArea > 0) {
        return `[sp,#0) to [sp,#${outgoingArea}) stages outgoing stack arguments, which belong to the callee`;
      }
      if (off !== 0 || localArea <= 0) {
        return 'the object does not start at the bottom of the reserved area, so something below it is unaccounted for';
      }
      if (!escaped.has(off)) {
        return 'the address never leaves this function, so there is no writer of the storage to size it for';
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
    const extent = new Map<number, { width: number; count: number }>();
    for (const [off, acc] of accesses) {
      const byIndex = indexed.get(off) ?? [];
      if (acc.length === 0) {
        // An object with no access of its own has no declared type and no extent, and the two
        // ways it gets there are two different gaps. Its bytes may already be keyed by the slot
        // model, which one byte is enough to decide; otherwise nothing in-function pins it at
        // all, and a guessed declaration is the plausible-but-wrong class.
        failIfSlotKeysIt(off, 1);
        const why = notTheWholeArea(off);
        if (why !== null) {
          fail(
            (byIndex.length > 0
              ? 'the captured address is read only through a runtime index'
              : 'the captured address is never dereferenced in this function') +
              `, so nothing pins the local object type — and ${why}`,
          );
        }
        // An indexed access reads ONE ELEMENT of the storage declared below, so it must be one:
        // an unsigned byte. A wider element is a different array over the same bytes, and a
        // sign-extending read is not what `u8` spells.
        for (const a of byIndex) {
          if (a.width !== 1) {
            fail(
              `a runtime index into the object at [sp,#${off}) accesses ${a.width} bytes, and the storage ` +
                'nothing else types is declared as bytes — only a byte element is modelled',
            );
          }
          if (a.signed) {
            fail(`a runtime index into the object at [sp,#${off}) sign-extends, and the storage is declared unsigned`);
          }
        }
        // STORAGE, NOT A TYPE. The reservation says how many bytes the frame holds and the
        // conjuncts above say they are all this object's, so the declaration commits to an EXTENT
        // and to nothing else: `u8 name[localArea]`, unsigned bytes because no access named an
        // element type and inventing one is the guess this refuses everywhere else.
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
        extent.set(off, { width: 1, count: localArea });
        continue;
      }
      if (byIndex.length > 0) {
        fail(
          `a runtime index into the object at [sp,#${off}), which an access of its own types as one ` +
            'scalar — only the untyped storage of the whole reserved area is indexed',
        );
      }
      const widths = new Set(acc.map((a) => a.width));
      if (widths.size > 1) {
        fail(`the accesses through the captured address disagree on width (${[...widths].join(' vs ')})`);
      }
      // …and on SIGNEDNESS, over the loads, for the same reason: one declared type extends one
      // way, so an object read by both `ldrsb` and `ldrb` has no faithful declaration —
      // `sp4 - sp4` would fold to 0 where the machine computes sext(b) - zext(b). Loads only: a
      // store extends nothing, and `strb` beside `ldrsb` is not a disagreement.
      const signs = new Set(acc.filter((a) => a.isLoad).map((a) => a.signed));
      if (signs.size > 1) {
        fail('the loads through the captured address disagree on signedness — one declared type extends one way');
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
    // slot, and clear of every other object.
    const objs = [...extent].sort((x, y) => x[0] - y[0]);
    const span = (o: { width: number; count: number }) => o.width * o.count;
    for (const [off, obj] of objs) {
      if (off < 0 || off + span(obj) > localArea) {
        fail(`the object at [sp,#${off}) of width ${span(obj)} lies outside the reserved local area`);
      }
      failIfSlotKeysIt(off, span(obj));
    }
    for (let i = 1; i < objs.length; i++) {
      const [off, obj] = objs[i];
      const [prev, prevObj] = objs[i - 1];
      if (overlaps(prev, span(prevObj), off, span(obj))) {
        fail(`the objects at [sp,#${prev}) and [sp,#${off}) overlap — one byte, two models`);
      }
    }
    // WHAT AN ESCAPE COSTS. The audit bounds what WE access through an object, never what a callee
    // does with the address it was handed — and a callee may write any offset from it. So an
    // escape retracts two claims, both of them function-wide because one address reaches the
    // whole frame.
    //
    // The first is that the other ADDRESS-TAKEN objects are private, and it keys on ANY escape —
    // this is the rule `mayWrite` does NOT narrow. Its argument is about LAYOUT, and layout is
    // symmetric: two objects are two separate C locals with no guaranteed adjacency, so a device
    // that READS past the one it was given is as wrong as a callee that writes past it. `DmaCopy`
    // with a count of two halfwords off `&sp0` transfers `[sp,#2]` too, and the emitted source
    // transfers whatever the recompiler put after `sp0`, and the second object's own store is
    // whatever the recompiler made of it. Marking both volatile would not repair that: the locals
    // are still placed independently.
    //
    // It counts `laddr` objects. A neighbour SPILLED to an SSA slot is the slot rule's below,
    // which bounds a device's read by its control word; this rule does not, since two objects
    // are two placements whatever reads them.
    if (escaped.size > 0 && objects.size > 1) {
      fail(
        'the captured address escapes, so something outside this function reaches the whole ' +
          'frame — including another object',
      );
    }
    // The second is `undef`, which rests on this function's own stores being the ONLY writer of
    // its frame. A wider real object (`struct P p; g(&p);` where only `p.x` is read here) has its
    // later words written by `g` and read back at a slot no store of ours reaches — declaring
    // those uninitialised spells the callee's value as garbage. The extents here are inferred
    // from OUR accesses, which is the number that is too small in this shape.
    //
    // On an escape and not on "a laddr exists": an address dereferenced only in-function cannot
    // be written by anyone else, and the overlap checks above cover its aliasing.
    //
    // FRAME undefs only. A register-keyed one says a local lives in a register the ABI does not
    // pass arguments in, and no address reaches a register — the escape this retraction is about
    // cannot touch it, and counting it would refuse the whole function for an unrelated escape.
    const undefSlots = irBlocks.some((blk) =>
      blk.ops.some((op) => op.opcode === 'undef' && slotKeyOffset(op.attrs.key as string) !== null),
    );
    if (mayWrite.size > 0 && undefSlots) {
      fail(
        'the captured address escapes, so a callee may write any frame offset and an unstored slot is not provably uninitialised',
      );
    }

    // THE BYTES AN ESCAPE MAY REACH, as `[lo, hi)` relative to the object's own offset. Anything
    // that may write, and anything this cannot bound, reaches the whole frame. A device that only
    // reads is bounded by its channel's control halfword (`readSourceControl`), when every store
    // to it that this function makes is a literal: fixed re-reads one unit, increment reads
    // upward only, decrement downward only. A store to that halfword through a pointer this
    // cannot resolve is not seen — the residue `readsThrough` already carries for the source
    // register itself.
    const readWindow = (off: number): readonly [number, number] => {
      const control = target.capabilities.readSourceControl;
      const sinks = readerSinks.get(off);
      if (mayWrite.has(off) || sinks === undefined || control === undefined) {
        return [-Infinity, Infinity];
      }
      const halves: number[] = [];
      for (const sink of new Set(sinks)) {
        const at = sink + control.offset;
        let seen = false;
        for (const blk of irBlocks) {
          for (const op of blk.ops) {
            const base = op.opcode === 'store' ? literalAddrOf(op.operands[0]) : undefined;
            if (base === undefined) {
              continue;
            }
            const a = base + (op.attrs.off as number);
            const w = op.attrs.width as number;
            // the channel's count and control halfwords, [at - 2, at + 2)
            if (a + w <= at - 2 || a >= at + 2 || (a === at - 2 && w === 2)) {
              continue;
            }
            const v = defOf.get(op.operands[1]);
            const whole = a === at - 2 && w === 4 && target.capabilities.endianness === 'little';
            if (v?.opcode !== 'const' || !(whole || (a === at && w === 2))) {
              return [-Infinity, Infinity];
            }
            halves.push(((v.attrs.value as number) >>> (whole ? 16 : 0)) & 0xffff);
            seen = true;
          }
        }
        if (!seen) {
          return [-Infinity, Infinity];
        }
      }
      let [lo, hi] = [0, 0];
      for (const h of halves) {
        const unit = (h & control.wideBit) !== 0 ? 4 : 2;
        const mode = (h >> control.modeShift) & 3;
        if (mode === 3) {
          return [-Infinity, Infinity];
        }
        lo = Math.min(lo, mode === 1 ? -Infinity : 0);
        hi = Math.max(hi, mode === 0 ? Infinity : unit);
      }
      return [lo, hi];
    };

    // …and the SLOT MODEL is the third claim an escape retracts — the undef rule's argument
    // taken one step further. The extents above are inferred from OUR accesses, so an object
    // wider in the SOURCE than the bytes this function touches has its later words written by
    // the callee — and any of those modelled as an SSA slot is a value the slot model forwards
    // ACROSS the call that overwrote it.
    //
    // Not a hypothetical, and not new with the outgoing-argument gate above either: this shape
    // reached the old capture path and lifted wrongly. The object has to be reached ONLY through
    // the captured pointer (an `[sp,#0]` access of its own collides with the slot model and
    // declines at the overlap check), which is what four corpus functions do:
    //
    //     mov r2, sp / str r0, [r2]   @ the object, written through the captured address
    //     str r1, [sp, #0x4]          @ a word the slot model keys
    //     mov r0, r2 / bl g           @ the base escapes; `g` may write [sp,#4]
    //     ldr r0, [sp, #0x4]          @ …and the machine RELOADS it after the call
    //
    // and the lift emitted `use2(a1)` — the reload replaced by the value from BEFORE the call,
    // the callee's write dropped, no diagnostic. Exactly the silent-wrong-answer trade the sp
    // guards exist to prevent, so it refuses.
    //
    // WHAT IT COSTS, stated because the benchmark cannot see it: it refuses every word slot the
    // escape may reach, which is blunter than the hazard it names — four corpus functions decline
    // on it (sa3 `sub_809C274`, `UpdateAnimations`, `sub_801C4A0`, `sub_8062CFC`), none of them a
    // benchmark row. Narrowing it needs the object's real extent, and this model does
    // not carry one: `extent` is a single width from a single access. The asm sometimes cannot
    // supply it either — the compiled twin at `capturedObjectIsTheWholeFrame` is exactly this
    // rule's shape, a slot THIS FUNCTION stores and reloads, undecidable between a spill and a
    // member.
    //
    // A callee is not the only writer. `struct M { u8 b; u8 pad[3]; s32 t; }; gp = &m; g2();
    // use2(m.t);` PUBLISHES the base to an ordinary global and the machine reloads [sp,#4] after
    // `bl g2` — `g2` writes through `gp`, which points here. Keyed on `passedToCallee` that lifted
    // as `use2(v0)`: the same silent wrong answer as the call shape, one escape over.
    //
    // …and a writer is not the only hazard, so the rule keys on `escaped`, not `mayWrite`. A
    // device that only READS through the address reads the slot's bytes from memory, where the
    // slot model never put them: `struct P { u32 a, b; } s; s.a = x; s.b = y; REG_DMA3SAD =
    // (u32)&s;` above an outgoing block is `str r4, [sp, #0x4] / str r5, [sp, #0x8] / add r1, sp,
    // #0x4 / str r1, [DMA3SAD]`, and keyed on `mayWrite` it lifted with `s.b = y` dropped as a
    // dead def — the DMA transferring a word nothing wrote. The asm cannot tell that second word
    // from a neighbour spilled beside the object, so what bounds the read is the transfer's own
    // control word, `readWindow`.
    //
    // …and BELOW the object as well as above it. A C object extends upward from its base, but a
    // captured address need not BE a base: `add r0, sp, #0x4` is `&buf[1]` as readily as `&b`, and
    // `buf[0]` at [sp,#0] is then read or written through `p[-1]`. Only down to the outgoing
    // block, whose words are the callee's arguments and never part of a local.
    for (const off of escaped) {
      const [lo, hi] = readWindow(off);
      const how = passedToCallee.has(off)
        ? 'is passed to a callee'
        : mayWrite.has(off)
          ? 'is stored to memory'
          : 'is handed to a device that reads through it';
      for (const slot of usedSlotOffsets) {
        if (slot > off && slot < off + hi) {
          fail(
            mayWrite.has(off)
              ? `the captured address at [sp,#${off}) ${how}, which may write the slot at [sp,#${slot}] — ` +
                  "this function's own store there would be forwarded past the write"
              : `the captured address at [sp,#${off}) ${how}, which may read the slot at [sp,#${slot}] — ` +
                  "this function's own store there is kept in a register, not the frame",
          );
        }
        if (slot < off && slot >= outgoingArea && slot + 4 > off + lo) {
          fail(
            `the captured address at [sp,#${off}) ${how}, and it may point INTO an object that starts ` +
              `lower — the slot at [sp,#${slot}] below it is kept in a register, not the frame`,
          );
        }
      }
    }
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
    // than the machine did and the writer reaches past what it allocated. Whole local area and
    // not only the words above the object: a word below it is still frame the declaration has to
    // account for. Word granularity, not byte — the stack is word-aligned, so a halfword object
    // owns its word and the padding beside it is not a second local.
    //
    // `mayWrite`, the predicate the undef rule takes: a device SOURCE register reads through the
    // address and cannot write the frame back, and an unwritten word it reads holds nothing.
    //
    // WHAT IT LEAVES, since this is the extent question the gate comment above is about: a
    // `mayWrite` escape is accepted only where the modelled objects and the keyed slots tile the
    // reserved area between them — a word above the object is a slot (refused above), a second
    // object (refused above), or unaccounted (refused here). That is not a wider extent model; it
    // is the same one-scalar `extent`, made to say when it does not fit. An object of two words
    // cannot be built here at all — the second access that would reach it is a `[+4]` the
    // `scalar()` guard refuses — so no widening of the frame licence admits a shape this rule
    // would then have to judge.
    //
    // AND IT IS THE SCALAR ARM THIS BOUNDS. An UNTYPED object is the whole reserved area by
    // construction — `notTheWholeArea` accepts nothing else — so it accounts for every word this
    // walk then asks about, and no input makes the rule fire on that path. What bounds THAT path
    // is `notTheWholeArea`'s own live clauses: a second object, a slot inside the area, an address
    // that reaches memory rather than a callee, and the callee's declared return.
    if (mayWrite.size > 0) {
      const accountedWords = new Set<number>();
      for (const [off, obj] of extent) {
        for (let w = off - (off % 4); w < off + obj.width * obj.count; w += 4) {
          accountedWords.add(w);
        }
      }
      for (const slot of usedSlotOffsets) {
        accountedWords.add(slot - (slot % 4));
      }
      for (let w = 0; w < localArea; w += 4) {
        if (!accountedWords.has(w)) {
          fail(
            `the word at [sp,#${w}] is neither an object this lift models nor a slot it keys, ` +
              `and the captured address reaches something that may write it — nothing accounts for the ` +
              `rest of the frame, so nothing bounds the captured object's extent`,
          );
        }
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
    // OWN dead-store pass used to key on it; it keys on address-taken now (l3/dce.ts), so
    // dropping the qualifier here cannot cost a store.
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
      for (const op of ops) {
        op.attrs = { ...op.attrs, width, signed, count, ...(published.has(off) ? { volatile: true } : {}) };
      }
    }
  }
}
