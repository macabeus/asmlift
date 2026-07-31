// asmlift — the ISA-frontend seam. A Frontend turns one function's assembly text into an L1
// Fn (block-argument SSA); everything downstream (recover, structure, backends) is ISA-
// neutral and consumes the Fn without knowing which frontend produced it. See registry.ts
// for target→frontend dispatch.
import type { Fn } from '../ir/core';
import type { Prototypes } from '../proto';
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
   *  (symbols.ts); today only the Thumb frontend consumes it (numeric-pool promotion) — the
   *  MIPS/PPC objdump dialect already carries symbol names in the asm text. */
  lift(
    name: string,
    asm: string,
    target: TargetDescription,
    prototypes: Prototypes,
    asmData?: AsmData,
    symbols?: SymbolMap,
  ): Fn;
}
