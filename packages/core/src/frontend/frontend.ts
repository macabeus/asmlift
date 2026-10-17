// asmlift — the ISA-frontend seam. A Frontend turns one function's assembly text into an L1
// Fn (block-argument SSA); everything downstream (recover, structure, backends) is ISA-
// neutral and consumes the Fn without knowing which frontend produced it. See registry.ts
// for target→frontend dispatch.
import type { Fn } from '../ir/core';
import type { Prototypes } from '../proto';
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
 *  ignores the whole bag. */
export interface LiftOptions {
  /** MIPS: keep the slot of a `b`/`j` whose slot is the last word of a common tail its two arms
   *  both spell (`sll; b T; sra` against `sll; sra; T:`), rather than retarget it to the copy at
   *  T-4 and merge the arms. The default retargets (frontend/mips.ts `normaliseBranchLikely`). */
  keepTailSlots?: boolean;
  /** Called when the lift met such a slot, whichever way it answered: what rank.ts asks before
   *  enumerating `/kept-slot` at all. */
  onTailSlot?: () => void;
}
