// Test-only builders the suites share. Not a `.test.ts`, so vitest's `include` never collects it
// and `offline-list.test.ts`'s `suites()` never counts it as a suite.
//
// What belongs here is a helper that was already spelled IDENTICALLY in several files — an
// expression constructor, a substring tally, the seeded PRNG. What does NOT belong here is a
// SEED: three fuzz sweeps sharing one would sample the same programs and stop being three
// independent sweeps, so every seed stays at its call site.
import type { Expr } from '../src/l3/ast';

/** `{ k: 'var' }` — the leaf every tree-building test needs most. */
export const v = (name: string): Expr => ({ k: 'var', name });

/** `{ k: 'const' }`, the other leaf. */
export const c = (value: number): Expr => ({ k: 'const', value });

/** A signed 32-bit scalar, as the `locals`/`params` records spell it. */
export const s32 = { kind: 'int', width: 32, signed: true } as const;

/** How many times `needle` occurs in `s` — the emitted-source tally the value-home suites count
 *  spellings with. */
export const count = (s: string, needle: string): number => s.split(needle).length - 1;

/** Deterministic PRNG (mulberry32). The repo treats nondeterminism as hostile, so a fuzz sweep
 *  seeds this rather than reaching for `Math.random`, and a failing seed is a reproduction on its
 *  own.
 *
 *  ONE SPELLING serves every sweep, the `| 0` variant included: `(x + k) | 0` and
 *  `(x + k) >>> 0` differ only in how the 32-bit pattern is signed, and every operator downstream
 *  (`Math.imul`, `>>>`, `|`, `^`) reads the pattern rather than the sign. Checked draw for draw,
 *  10,000 draws on six seeds including `contract-invariant.test.ts`'s 0xa5c1f70d: no
 *  disagreement. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
