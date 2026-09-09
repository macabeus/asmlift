// WHICH errors are the pipeline REFUSING TO GUESS, and which are a bug.
//
// The distinction is the whole of asmlift's failure contract: a decline names a construct the
// decompiler does not model, and is a fact about the ROW; anything else is a fact about the
// TOOL. Both exit 1 from the CLI, so the only thing that separates them for a reader is the
// prefix the surface prints — and a surface that guesses the prefix from which call site caught
// prints a confident wrong sentence, which is worse than the crash it replaced (`bench fan`
// shipped exactly that: `--force` on a declined row reported it as `noncompile`).
//
// It lives in its own leaf, and not in `main.ts` where it was born, because there are now TWO
// surfaces that must agree about it — the CLI's `[declined]`/`[internal error]` prefix and the
// benchmark's `bench fan`, which has to tell a row with no fan apart from a broken harness. A
// per-surface copy of this list is a per-surface answer to the same question.
import { ContractError } from '@asmlift/core/contracts';
import { FrontendUnsupportedError } from '@asmlift/core/frontend/errors';
import { VerifyError } from '@asmlift/core/ir/verify';
import { RaiseUnsupportedError } from '@asmlift/core/raise/errors';
import { StructureError } from '@asmlift/core/structure/structure';

/** The principled declines, in pipeline order. Nothing else in this list is a decline: an error
 *  class not named here is a defect until someone adds it here on purpose. */
export const DECLINE_ERRORS = [
  FrontendUnsupportedError,
  RaiseUnsupportedError,
  StructureError,
  ContractError,
  VerifyError,
] as const;

export const isDecline = (e: unknown): boolean => DECLINE_ERRORS.some((c) => e instanceof c);
