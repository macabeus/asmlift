// The Symbols pane's parser: user-pasted JSON in the vendored-map format (hex-address keys →
// SymbolInfo[]) → a core SymbolMap. Validation is structural and LOUD in the pane but INERT to
// the run: a bad map yields { error } and the decompile proceeds WITHOUT it — degrade, never
// block (the same optionality contract as core's `symbols` option itself).
import { type SymbolInfo, type SymbolMap, symbolMapFromJson } from '@asmlift/core/symbols';

const HEX_KEY = /^(0x)?[0-9a-fA-F]+$/;

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
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return {
      error: 'expected an object of hex addresses, e.g. {"0x03001234": [{"name": "gCounter", "kind": "data"}]}',
    };
  }
  for (const [key, infos] of Object.entries(obj)) {
    if (!HEX_KEY.test(key)) {
      return { error: `"${key}" is not a hex address key (e.g. "0x03001234")` };
    }
    if (!Array.isArray(infos) || infos.length === 0) {
      return { error: `"${key}" must map to a non-empty array of symbols` };
    }
    for (const info of infos as unknown[]) {
      const s = info as Partial<SymbolInfo> | null;
      if (
        typeof s !== 'object' ||
        s === null ||
        typeof s.name !== 'string' ||
        (s.kind !== 'code' && s.kind !== 'data')
      ) {
        return { error: `"${key}": every symbol needs a string "name" and "kind": "code" | "data"` };
      }
    }
  }
  return { map: symbolMapFromJson(obj as Record<string, SymbolInfo[]>) };
}
