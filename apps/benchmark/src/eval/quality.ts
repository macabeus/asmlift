// Deterministic readability heuristic (0..100, higher = more readable). Readability is subjective,
// so this is a transparent proxy — every penalty is counted and reported, and the webapp shows the
// code side-by-side so a human can judge. Penalized signals:
//   • undecompiled glue  — M2C_ERROR / M2C_UNK / unknown-type `? (` / opaque  (strongest signal)
//   • goto / labels      — structured control flow lost
//   • raw memory casts   — `*(T*)(p + N)` instead of `p->field` / `p[i]` (no type recovery)
//   • excess casts       — noise (project-idiom ADDRESS casts exempt — see below)
//
// FAIRNESS: m2c's `var_X`/`temp_X` and asmlift's `a0`/`v0` are each decompiler's normal
// generic-local idiom (neither recovers real names without context) — NOT penalized. Only genuine
// failure markers count as glue.
import type { QualityScore } from '@asmlift/bench-schema';

const GLUE_PATTERNS = [
  /M2C_ERROR/g,
  /M2C_UNK/g,
  /\/\* Decompilation failure/g,
  /ASMLIFT_ERROR/g, // asmlift annotate-mode gap marker
  /\bopaque[A-Za-z0-9_]*/g,
  /\?\s*\(\s*\*+/g, // `? (*fn)` — m2c unknown type
  /unknown instruction/g,
];

function countAll(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

// Project-idiom ADDRESS casts are EXEMPT from the casts count: `(u32)&gSym` / `(s32)&gSym`
// (core's addr-intify — integer arithmetic/compares on a link-time address) and `(u32)Func`
// (a code address stored as an integer) are the CORRECT source spelling of that construct,
// not cast noise — the decomp projects themselves write them. Textual discipline for the
// bare-identifier form: the identifier must not be a generic LOCAL (asmlift's a0/v0, m2c's
// var_X/temp_X/phi_X/argN/spN) — a u32 cast of a local is a value truncation, still noise —
// and must not be a call (`(u32)F(x)` casts the RESULT, not the address). The `&` forms are
// address spellings by construction, exempt for any identifier.
const ADDR_CAST_EXEMPT = /\(\s*[us]32\s*\)\s*&\s*[A-Za-z_]\w*|\(\s*u32\s*\)\s*([A-Za-z_]\w*)(?!\w)(?!\s*\()/g;
const GENERIC_LOCAL = /^(?:[av]\d+|arg\d+|sp\d*|var_\w+|temp_\w+|phi_\w+)$/;

/** How many of the counted casts are exempt address spellings (always a subset of the casts
 *  regex's matches — each starts with a `(u32)`/`(s32)` that regex counts). */
function countAddrCastExemptions(src: string): number {
  let n = 0;
  for (const m of src.matchAll(ADDR_CAST_EXEMPT)) {
    if (m[1] === undefined || !GENERIC_LOCAL.test(m[1])) {
      n++;
    }
  }
  return n;
}

export function assessQuality(src: string): QualityScore {
  const lines = src.split('\n').filter((l) => l.trim().length > 0).length;
  const gotos = countAll(src, /\bgoto\b/g);
  const labels = countAll(src, /^\s*[A-Za-z_]\w*:\s*$/gm);
  const casts =
    countAll(
      src,
      /\(\s*(?:un)?signed\b[^)]*\)|\((?:u8|u16|u32|s8|s16|s32|int|char|short|long|void|float|double)\s*\**\s*\)/g,
    ) - countAddrCastExemptions(src);
  const rawMem = countAll(src, /\*\(\s*[A-Za-z_][\w ]*\*+\s*\)\s*\(/g); // *(T*)( ... )
  // *(T*)0xADDR — an absolute-address deref (typically MMIO): the symbol/global was not
  // recovered. Counted for the report but NOT score-penalized (the score formula is pinned).
  const addrDeref = countAll(src, /\*\s*\(\s*[A-Za-z_][\w ]*\*+\s*\)\s*0[xX][0-9a-fA-F]+/g);
  const unkGlue = GLUE_PATTERNS.reduce((n, re) => n + countAll(src, re), 0);

  let score = 100;
  if (unkGlue) {
    score -= Math.min(50, unkGlue * 12);
  }
  if (gotos) {
    score -= Math.min(24, gotos * 8);
  }
  if (labels) {
    score -= Math.min(12, labels * 4);
  }
  if (rawMem) {
    score -= Math.min(20, rawMem * 4);
  }
  if (casts > 2) {
    score -= Math.min(12, (casts - 2) * 2);
  }
  score = Math.max(0, Math.min(100, score));

  return { score, lines, gotos, casts, unkGlue, rawMem, addrDeref };
}
