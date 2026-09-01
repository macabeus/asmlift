// The Symbols pane's parser: user-pasted JSON in the vendored-map format (hex-address keys →
// SymbolInfo[]) → a core SymbolMap. Validation is structural and LOUD in the pane but INERT to
// the run: a bad map yields { error } and the decompile proceeds WITHOUT it — degrade, never
// block (the same optionality contract as core's `symbols` option itself).
//
// The structural check itself lives in CORE (`parseSymbolMapJson`), because the cli's
// `tools.asmlift.symbols` needs exactly the same one and two hand-rolled copies is how the two
// readers of this format come to disagree about what a map is. What stays here is the pane's own
// policy, which the cli's is the opposite of: an empty pane is `null` rather than an error, and a
// rejected map degrades instead of exiting.
import { type SymbolMap, parseSymbolMapJson } from '@asmlift/core/symbols';

/** `null` for an empty pane; `{ map }` for a well-formed map; `{ error }` (never a throw) for
 *  anything else. Only the load-bearing minimum is validated — hex keys, non-empty arrays,
 *  string `name`, `kind` ∈ code|data — the shape fields are typed by core and fail soft there. */
export function parseSymbolsJson(text: string): { map: SymbolMap } | { error: string } | null {
  if (!text.trim()) {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { error: `not valid JSON — ${e instanceof Error ? e.message : String(e)}` };
  }
  return parseSymbolMapJson(obj);
}
