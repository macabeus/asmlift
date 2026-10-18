// asmlift — the ISA-frontend seam. A Frontend turns one function's assembly text into an L1
// Fn (block-argument SSA); everything downstream (recover, structure, backends) is ISA-
// neutral and consumes the Fn without knowing which frontend produced it. See registry.ts
// for target→frontend dispatch.
import type { Fn } from '../ir/core';
import type { FnProto, Prototypes } from '../proto';
import type { ContextGlobals } from '../proto-context';
import type { SymbolMap } from '../symbols';
import type { TargetDescription } from '../target';
import type { AsmData } from './asmdata';
import type { AsmTextFormat } from './format';

export interface Frontend {
  /** stable id, e.g. "thumb", "mips" — for diagnostics/reporting, not dispatch */
  id: string;
  /** the one input-text format this frontend reads; a positive mismatch declines at the
   *  lift boundary (format.ts) instead of failing confusingly deep in decode */
  inputFormat: AsmTextFormat;
  /** decode one function's assembly into an L1 Fn. `prototypes` supplies callee arities
   *  (and any other header facts the frontend needs); an empty map is valid. `asmData` is the
   *  OPTIONAL Regime-B side-table (data-section jump tables + relocations); absent ⇒ a
   *  dense-switch dispatch declines/loud-fails. `symbols` is the OPTIONAL address→symbol map
   *  (symbols.ts): the Thumb frontend promotes a numeric pool word through it — the
   *  MIPS/PPC objdump dialect already carries symbol names in the asm text — and every frontend
   *  hands it, with the OPTIONAL declaration `context`, to the dead-read pin, which reads a global's
   *  declaration there (frontend/dead-reads.ts `declared-plain`). */
  lift(
    name: string,
    asm: string,
    target: TargetDescription,
    prototypes: Prototypes,
    asmData?: AsmData,
    symbols?: SymbolMap,
    context?: ContextGlobals,
    options?: LiftOptions,
  ): Fn;
}

/** A question the asm leaves open that a frontend answers one way by default and, asked, the other
 *  way: the LIFT variations of rank.ts that live in the frontend. A frontend with no such question
 *  ignores the whole bag. One input rides beside them that no variation sets, the context's
 *  own-entry bound (`contextOwnWords`). */
/** THE FUNCTION'S OWN DECLARATION, as a call lowering reads it (frontend/call-plan.ts
 *  `callDeclarations`): a stated entry, which `proves`, or the declaration context's
 *  (`LiftOptions.contextOwnProto`). */
export interface OwnDeclaration {
  readonly proto: FnProto;
  /** whether it may rule a reading OUT (a hole, a shadow, a float) as well as refuse one */
  readonly proves: boolean;
}

/** The own declaration of `name`: the stated entry in `prototypes`, else the context's. */
export function ownDeclarationOf(
  name: string,
  prototypes: Prototypes,
  context: OwnDeclaration | undefined,
): OwnDeclaration | undefined {
  return Object.hasOwn(prototypes, name) ? { proto: prototypes[name], proves: true } : context;
}

export interface LiftOptions {
  /** The argument words the declaration context's own entry for the function fills, where no
   *  stated entry does (pipeline.ts `liftWithinContextBound`, which raises it past a register the
   *  lift reads, and lifts without it where it refuses), so a frontend given it reads it in place
   *  of the stated entry's words (frontend/ssa.ts `registerLiveIns`). Every frontend reads it; PowerPC,
   *  as with a stated entry, only for a body a compiler wrote. */
  contextOwnWords?: number;
  /** The declaration context's own entry itself, where no stated entry binds the body. Read where
   *  the TYPES of the own parameters decide something the word count cannot (frontend/call-plan.ts
   *  `decideGap`). `proves` says whether it may serve as positive proof as well. It holds only where
   *  the lift is bounded by exactly the entry's words, or the entry fills every argument register,
   *  and never once the bound was raised past a register the body reads or the lift fell back to
   *  no bound, which says the entry is wrong. Without `proves`, it only refuses. */
  contextOwnProto?: OwnDeclaration;
  /** The size in bytes of a struct the function's own declaration returns through a hidden pointer
   *  (pipeline.ts `liftStamped`), and where to hand a refusal that declaration may answer: one about
   *  the RETURN's width that such a struct explains, which the frontend then defers instead of
   *  throwing, as the function that throws it. The pipeline calls that after all unless the lift
   *  proves the pointer is that struct's storage (frontend/own-struct-return.ts), handing it why the
   *  proof failed, which the refusal then says. Thumb only: agbcc's interworking epilogue sizes an
   *  8-byte struct returned through memory as it sizes a `long long` (`eightByteReturnScratch`). */
  ownMemoryReturn?: { bytes: number; defer(refuse: (unproved: string) => never): void };
  /** MIPS: keep the slot of a `b`/`j` whose slot is the last word of a common tail its two arms
   *  both spell (`sll; b T; sra` against `sll; sra; T:`), rather than retarget it to the copy at
   *  T-4 and merge the arms. The default retargets (frontend/mips.ts `normaliseBranchLikely`). An
   *  IDO question: GCC 2.7.2 and KMC cross-jump such a tail into one copy before filling a slot, so
   *  on their output the slot is never a tail written twice. */
  keepTailSlots?: boolean;
  /** Called when the lift met such a slot, whichever way it answered: what rank.ts asks before
   *  enumerating `/kept-slot` at all. */
  onTailSlot?: () => void;
}
