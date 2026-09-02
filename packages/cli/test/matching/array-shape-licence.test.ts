// THE TWO COMPILER CLAIMS `raise/globalshape.ts` RESTS ON, compiled rather than asserted in prose.
//
// The derivation changes the DEFAULT spelling of a map-less indexed global from `((T *)&gSym)[i]`
// to the bare `gSym[i]`, on the strength of two facts about agbcc:
//
//   ORDER — an array-typed base expands AHEAD of the subscript (`gcc/c-typeck.c`'s
//     `build_array_ref` forks on `TREE_CODE (TREE_TYPE (array)) == ARRAY_TYPE`), every other base
//     takes the pointer path and is expanded last. So the instruction order is evidence about how
//     the source spelled the base.
//   THE ADDEND — a constant added to a pointer or cast base is absorbed into the relocation addend
//     (`gcc/explow.c`'s `plus_constant_wide`, with `gcc/thumb.h`'s `LEGITIMIZE_ADDRESS` empty, so
//     nothing splits it back). A RUNTIME add against a bare `.word gSym` is therefore a shape only
//     the array subscript produces — the converse of the claim, and the half nothing compiled.
//
// A default is only right where the mapping is a function, so the SAME test has to show where the
// two spellings COLLAPSE — those are the shapes the derivation must refuse, and one of them
// (a symbol subscripted twice, agbcc CSEing the pool word) is the reason the order rule is asked of
// every access rather than of the first.
//
// This repo's idiom for a load-bearing compiler fact is a pinned test (array-rank-axis.test.ts,
// decl-scope-axis.test.ts, core/test/sign-axis.test.ts), and `pnpm test:matching` is in neither CI
// nor the benchmark — so a claim that is not here is a claim nothing re-checks.
//
// GATE: needs the bench-owned klonoa checkout (`pnpm bench setup --project kleod --build`) plus
// arm-none-eabi-objcopy. Missing pieces skip GREEN, checkout-gate.ts style.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

import { compileFromCommand } from '../../src/compile-command';
import { loadDecompConfig } from '../../src/config';
import { KLEOD_CHECKOUT as CHECKOUT, kleodCheckoutGate } from './checkout-gate';

const HAVE = kleodCheckoutGate(
  'array-shape-licence',
  ['decomp.yaml', 'tools/agbcc/bin/agbcc'],
  ['arm-none-eabi-objcopy'],
);

// Both spellings of every pair reference the SAME symbol, so the literal pool is equal on both
// sides and each comparison is about the address arithmetic alone.
const DECLS = `extern u16 gTbl[];
extern u8 gBytes[];
extern const s16 gSigned[];
`;

// ── the ORDER claim, at element width 2 where the scaling is observable ──────────────────────
const BARE = `${DECLS}u32 f(s32 i) { return gTbl[i]; }\n`;
const CAST = `${DECLS}u32 f(s32 i) { return ((u16 *)gTbl)[i]; }\n`;
// A pointer LOCAL initialised from the array — the spelling the derivation displaces on a
// multi-access function. It decays, so it takes the pointer path at every use…
const PTR_LOCAL = `${DECLS}u32 f(s32 i, s32 j) { u16 *p = gTbl; return p[i] + p[j]; }\n`;
const BARE_TWICE = `${DECLS}u32 f(s32 i, s32 j) { return gTbl[i] + gTbl[j]; }\n`;
// …and the two MIXED shapes, which is where a per-access reading and a per-pool-load reading come
// apart: agbcc CSEs the pool word, so only the FIRST access's order is visible.
const MIXED_BARE_FIRST = `${DECLS}u32 f(s32 i, s32 j) { return gTbl[i] + ((u16 *)gTbl)[j]; }\n`;
const BOTH_CAST = `${DECLS}u32 f(s32 i, s32 j) { return ((u16 *)gTbl)[i] + ((u16 *)gTbl)[j]; }\n`;

// ── the ADDEND claim, at element width 1 where the order says nothing ────────────────────────
const IDX_CONST = `${DECLS}u32 f(s32 i) { return gBytes[i + 1]; }\n`;
const CAST_CONST = `${DECLS}u32 f(s32 i) { return ((u8 *)gBytes)[i + 1]; }\n`;
// The same address with the constant unambiguously IN THE BASE — a pointer to element 1. If the
// cast spelling above folds, it is byte-for-byte this.
const BASE_FOLDED = `${DECLS}u32 f(s32 i) { const u8 *p = &gBytes[1]; return p[i]; }\n`;

// ── the SIGNEDNESS the derivation picks and cannot read ──────────────────────────────────────
const SIGNED_CAST = `${DECLS}u32 f(s32 i) { return (u16)gSigned[i]; }\n`;
const UNSIGNED_BARE = `${DECLS}u32 f(s32 i) { return gTbl[i]; }\n`;

describe.runIf(HAVE)('the ARRAY-SHAPE licence, compiled (checkout-gated)', () => {
  const hex = new Map<string, string>();
  const SOURCES = [
    ['bare', BARE],
    ['cast', CAST],
    ['ptr-local', PTR_LOCAL],
    ['bare-twice', BARE_TWICE],
    ['mixed-bare-first', MIXED_BARE_FIRST],
    ['both-cast', BOTH_CAST],
    ['idx-const', IDX_CONST],
    ['cast-const', CAST_CONST],
    ['base-folded', BASE_FOLDED],
    ['signed-cast', SIGNED_CAST],
    ['unsigned-bare', UNSIGNED_BARE],
  ] as const;

  beforeAll(() => {
    const cfg = loadDecompConfig(join(CHECKOUT, 'decomp.yaml'));
    const template = cfg?.config.tools?.asmlift?.compiler;
    if (!template) {
      throw new Error('klonoa decomp.yaml lost its tools.asmlift.compiler key');
    }
    const compile = compileFromCommand(template, { cwd: CHECKOUT });
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-arrayshape-'));
    for (const [name, src] of SOURCES) {
      const obj = compile(src, 'f', 'c');
      const bin = join(dir, `${name}.bin`);
      const r = spawnSync('arm-none-eabi-objcopy', ['-O', 'binary', obj, bin], { encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error(`objcopy failed for ${name}: ${r.stderr}`);
      }
      hex.set(name, readFileSync(bin).toString('hex'));
    }
  }, 240_000);

  test('every spelling really compiled — the pairs below are not comparing two undefineds', () => {
    for (const [name] of SOURCES) {
      expect(hex.get(name), name).toMatch(/^[0-9a-f]{16,}$/);
    }
  });

  test('ORDER: the bare subscript and the cast are DIFFERENT objects', () => {
    // The whole capability. An array-typed base expands first; a cast base is reassociated and
    // expanded last, so the `ldr` of the pool word moves across the index `lsl`.
    expect(hex.get('bare')).not.toBe(hex.get('cast'));
  });

  test('ADDEND: a constant on the index is a different object from the same constant on the base', () => {
    // At width 1 there is nothing to scale, so the order says nothing and this is the only
    // evidence there is. THE CONVERSE, which is what the derivation actually uses: `cast-const`
    // must fold its `+ 1` into the relocation addend, so a RUNTIME add against a bare `.word` is
    // array-only. Asserted here as a byte difference AND as the absence of a runtime add below.
    expect(hex.get('idx-const')).not.toBe(hex.get('cast-const'));
  });

  test('the cast+constant really folds into the base — the same object as a pointer to element 1', () => {
    // THE CONVERSE, pinned. If it did not fold, both spellings would emit a runtime `add` and the
    // width-1 licence would admit a cast base — which is the `arrbias` over-fire. `-O binary`
    // drops relocations, so this compares .text: the cast spelling emits the SAME instructions as
    // a pointer that has the constant in its base, and the bare subscript emits different ones.
    expect(hex.get('cast-const')).toBe(hex.get('base-folded'));
    expect(hex.get('idx-const')).not.toBe(hex.get('base-folded'));
  });

  test('WHERE THE TWO SPELLINGS COLLAPSE — a pointer local decays to the bare subscript', () => {
    // The spelling the derivation displaces on a multi-access function. It is not a candidate the
    // change deleted: it is the SAME object, so nothing referees a choice between them.
    expect(hex.get('ptr-local')).toBe(hex.get('bare-twice'));
  });

  test('…and a MIXED function is decided by the FIRST access, which is why one index-first refuses all', () => {
    // agbcc CSEs the pool word, so the second access is ordered against the same `ldr`. Bare-first
    // and mixed are the same object — a bare subscript there is right either way — while both-cast
    // is a different one. So the licence is per POOL LOAD, the earliest scaling decides it, and one
    // index-first access must refuse the whole symbol (`index-materialized-first`).
    expect(hex.get('mixed-bare-first')).toBe(hex.get('bare-twice'));
    expect(hex.get('both-cast')).not.toBe(hex.get('bare-twice'));
  });

  test('SIGNEDNESS is a pick, not a reading: the two declarations are the SAME object', () => {
    // `(u16)gSigned[i]` over `extern const s16 gSigned[]` and `gTbl[i]` over `extern u16 gTbl[]`
    // compile identically. So the assembly cannot say which the source wrote, the derivation picks
    // `unsigned`, and the emitted bare spelling is right only beside the declaration it derived —
    // which is why that declaration travels with the source (`DecompileResult.assumedSymbols`,
    // the cli's `[assumed]` / `[declared]` blocks) instead of being applied silently.
    expect(hex.get('signed-cast')).toBe(hex.get('unsigned-bare'));
  });
});
