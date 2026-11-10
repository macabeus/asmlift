/** THE END OF ONE LIFT, shared by the Thumb, MIPS and PPC frontends: what runs on the finished SSA
 *  once each frontend's own refusals have been asked. The call objects are folded and named, the
 *  frame-object audit judges every `laddr` (and may ask for the relift, `liftWithRelift`), the
 *  device and dead-read pins are stamped, and the entry parameters are put in ABI order.
 *
 *  ONE SEQUENCE, ONE ORDER. The three `liftOnce`s ran these steps by hand, in this order, and had
 *  drifted: PPC skipped three of them (no-ops there, as its caller says), and each handed the audit and the dead-read pin its own
 *  record. Every difference is now a named field of `LiftFinish` that each caller states, with the
 *  reason beside the caller's value; a change to the tail is made here once. What comes before —
 *  the stale-idiom refusal, the argument-slot holes and `ssa.finish()` — is the same calls in the
 *  same order too, but each frontend asks refusals of its own between them (PPC's `computedPairHalf`
 *  sits between the holes and `finish`), so those stay in the callers.
 *
 *  NOTHING HERE DECODES, and nothing here refuses by itself: every refusal is a shared pass's
 *  (frontend/frame-objects.ts, frontend/dead-reads.ts) or a caller's hook (`refuseBeforeAudit`,
 *  `refuseLast`), each at the place in the sequence its frontend asked it before. */
import type { Fn } from '../ir/core';
import type { FnProto } from '../proto';
import type { ContextGlobals } from '../proto-context';
import type { SymbolMap } from '../symbols';
import type { TargetDescription } from '../target';
import { type CallDeclarations, foldByValueArgs } from './call-plan';
import { type DeadReadFacts, pinDeadReads } from './dead-reads';
import { pinDeviceAccesses } from './device-pins';
import {
  FRAME_OBJECT_AUDIT,
  type FrameObjectAudit,
  type FrameObjectRelift,
  type FrameRange,
  nameMergedSretObjects,
  refuseSretOutsideFrame,
} from './frame-objects';
import type { LocalStatics } from './local-object';
import { type ArgSlots, type SsaBuilder, abiSortEntryParams } from './ssa';

/** What only the frontend measures of its frame, for the audit: the partition, the slots it keyed
 *  and the captures it moved (`FrameObjectAudit`). The fields every frontend hands over the same
 *  way — the function, its target, its declarations and the relift's object — `finishLift` fills. */
export type FrameAuditFacts = Omit<
  FrameObjectAudit,
  'name' | 'irBlocks' | 'returnsWithoutHiddenPointer' | 'symbols' | 'target' | 'oneObject' | 'gates' | 'reliftGates'
>;

/** What the dead-read pin reads that differs by frontend (`DeadReadFacts`); the function's name, its
 *  own declaration, the values held at an undeclared call, the frame writes and the declarations
 *  are the same on every one, and `finishLift` fills them. */
export type DeadReadIsaFacts = Pick<DeadReadFacts, 'atWordReturn' | 'compared' | 'discarded'>;

export interface LiftFinish {
  name: string;
  target: TargetDescription;
  ssa: Pick<SsaBuilder, 'fn' | 'irBlocks' | 'paramReg' | 'frameWrites'>;
  /** the function's own declaration, as the dead-read pin reads it (`prototypes[name]`) */
  own: FnProto | undefined;
  calls: Pick<CallDeclarations, 'declaredCall' | 'returnsWithoutHiddenPointer' | 'heldAtUndeclaredCall'>;
  symbols: SymbolMap | undefined;
  context: ContextGlobals | undefined;
  /** the bytes the first audit asked to be kept as one object, on the relift */
  oneObject: FrameRange | undefined;
  /** whether the entry block is a branch target (`mintArgSlotHoles`, `abiSortEntryParams`) */
  entryHasPreds: boolean;
  argSlots: ArgSlots;
  /** whether a call's lowering can hand a struct over BY VALUE, in argument words
   *  (`foldByValueArgs`, run ahead of the audit) */
  foldsByValueArgs: boolean;
  /** whether a call's lowering passes a hidden struct-return pointer (`CallLowering.memoryReturn`):
   *  the merged pointer is named ahead of the audit (`nameMergedSretObjects`) and one that is no
   *  frame object refuses after it (`refuseSretOutsideFrame`) */
  memoryReturn: boolean;
  /** the frame the audit judges, read at the audit (so a fact the frontend computes from the folded
   *  IR is computed there); undefined where the function has no frame for it to judge, and then no
   *  audit runs and no device access is pinned */
  frame: (() => FrameAuditFacts) | undefined;
  /** a refusal asked after the fold and before the audit, where `frame` is defined */
  refuseBeforeAudit?: () => void;
  /** whether the audit and the device pin resolve a global's address through `symbols` */
  auditReadsSymbols: boolean;
  /** the dead-read facts that differ by frontend, read at the pin */
  deadReads: () => DeadReadIsaFacts;
  /** a refusal asked once everything else lifted, before the entry parameters are sorted */
  refuseLast?: () => void;
  /** the function-scope statics the lift recorded, set on the Fn last; undefined where the frontend
   *  records none, and the Fn's own field is then left as the builder made it */
  statics: LocalStatics | undefined;
}

/** Run the end of a lift on its finished SSA (see the module comment): the Fn, or the audit's ask
 *  for a relift. */
export function finishLift(f: LiftFinish): Fn | FrameObjectRelift {
  const { name, target, ssa, calls, symbols, context, oneObject } = f;
  const { fn, irBlocks } = ssa;
  // A struct passed by value becomes the one object its words hold (call-plan.ts `foldByValueArgs`)
  // before the audit judges the frame objects, that one among them.
  if (f.foldsByValueArgs) {
    foldByValueArgs(name, irBlocks, calls, { symbols, context });
  }
  if (f.memoryReturn) {
    nameMergedSretObjects(irBlocks);
  }

  // Prove every `laddr` this function emitted really does name storage of this function's own, at
  // a shape the machine states, or decline (auditFrameObjects); an accepted function then gets the
  // device pin the audit answers (pinDeviceAccesses).
  if (f.frame !== undefined) {
    f.refuseBeforeAudit?.();
    const auditSymbols = f.auditReadsSymbols ? symbols : undefined;
    const verdict = FRAME_OBJECT_AUDIT.run({
      name,
      irBlocks,
      ...f.frame(),
      returnsWithoutHiddenPointer: calls.returnsWithoutHiddenPointer,
      symbols: auditSymbols,
      target,
      oneObject,
    });
    if (verdict !== undefined && 'oneObject' in verdict) {
      return verdict;
    }
    if (verdict !== undefined) {
      pinDeviceAccesses(irBlocks, verdict, target, auditSymbols);
    }
  }
  if (f.memoryReturn) {
    refuseSretOutsideFrame(name, irBlocks, target);
  }
  pinDeadReads(irBlocks, target, {
    name,
    own: f.own,
    atUndeclaredCall: calls.heldAtUndeclaredCall,
    spilled: ssa.frameWrites,
    declarations: { symbols, context },
    ...f.deadReads(),
  });

  f.refuseLast?.();
  abiSortEntryParams(irBlocks[0], f.entryHasPreds, ssa.paramReg, f.argSlots);
  if (f.statics !== undefined) {
    fn.localObjects = f.statics.finish();
  }
  return fn;
}
