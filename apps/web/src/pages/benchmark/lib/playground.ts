// "Open in playground" — a benchmark row's exact decompiler input (toolchain, symbol, targetAsm)
// as a playground ShareState. The Benchmark and Playground are one app, so this is an
// in-memory hand-off (the shell switches views and seeds the editor), not a cross-app URL. The
// ShareState shape is owned by src/shared/utils/permalink.ts; a contract test
// (benchmark-link.test.ts) pins it.
//
// Real-tier rows ran with prototypes context the playground cannot carry yet, so their repro is
// context-free (synthetic rows reproduce faithfully) — the UI labels the hand-off accordingly.
import type { FunctionResult } from '@asmlift/bench-schema';

import type { ShareState } from '../../../shared/utils/permalink';

// The playground's TARGETS keys — identical to the benchmark toolchain ids by construction.
const PLAYGROUND_TARGETS = new Set(['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81']);
// Past this the editor state gets unwieldy (and a shared permalink would break); refuse instead.
const MAX_ASM_CHARS = 30_000;

export function canOpenInPlayground(fn: FunctionResult): boolean {
  return PLAYGROUND_TARGETS.has(fn.toolchain) && fn.targetAsm.length <= MAX_ASM_CHARS;
}

/** The playground state that reproduces this row, or null when ineligible. */
export function playgroundShare(fn: FunctionResult): ShareState | null {
  if (!canOpenInPlayground(fn)) {
    return null;
  }
  return { target: fn.toolchain, backend: 'c', name: fn.sym, asm: fn.targetAsm };
}
