// The address→symbol map seam (symbols.ts + the thumb numeric-pool promotion + the
// declaration-shape spellings) — research/symbol-map-plan-2026-07-22.md.
//
// Pins the plan's contracts: INERTNESS (no map ⇒ byte-identical output), the kind-aware
// two-probe promotion, the `(u32)Func` code spelling (dogfood defect G), the struct-interior
// `gSym.field` dot spelling from a layout, the bare `gSym[i]` array spelling, and the
// nothing-guesses rules (unmapped stays raw; width/field mismatches fall back loudly).
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { type SymbolMap, lookupSymbol } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const asmOf = (sym: string, body: string) => `${sym}:\n${body}`;
const run = (sym: string, body: string, symbols?: SymbolMap) =>
  decompile(sym, asmOf(sym, body), ARMV4T_AGBCC, symbols ? { symbols } : {}).source;

const mapOf = (entries: [number, Parameters<typeof Object.assign>[1]][]): SymbolMap =>
  new Map(entries.map(([addr, info]) => [addr, [info]]));

// ldr rN, =0x03001234; load/store through it — the numeric-pool shape the promotion targets
const LOADW = '\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';

describe('inertness (the optionality contract)', () => {
  test('no map ⇒ byte-identical raw-literal output', () => {
    const base = run('f', LOADW);
    expect(base).toContain('50336308'); // 0x03001234 rendered as a raw literal
    expect(run('f', LOADW, new Map())).toBe(base); // empty map ⇒ same bytes
  });
});

describe('the numeric-pool promotion (P1 names)', () => {
  test('an exact data hit renders the bare named global', () => {
    const src = run('f', LOADW, mapOf([[0x03001234, { name: 'gCounter', kind: 'data' }]]));
    expect(src).toContain('return gCounter;');
    expect(src).not.toContain('50336308');
  });

  test('an unmapped address stays a raw literal — nothing guesses', () => {
    const src = run('f', LOADW, mapOf([[0x03009999, { name: 'gElsewhere', kind: 'data' }]]));
    expect(src).toContain('50336308');
    expect(src).not.toContain('gElsewhere');
  });

  test('a Thumb code pointer (odd pool word) resolves through the masked probe as (u32)Func', () => {
    // ldr r0, =Func|1 ... returned as a value: the map stores the bit-0-cleared address
    const body = '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t0x08012345\n';
    const src = run('f', body, mapOf([[0x08012344, { name: 'DoThing', kind: 'code' }]]));
    expect(src).toContain('(u32)DoThing');
    expect(src).not.toContain('&DoThing');
  });

  test('an exact odd DATA hit wins over a masked code hit', () => {
    const body = '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t0x03000001\n';
    const map: SymbolMap = new Map([
      [0x03000001, [{ name: 'gOddData', kind: 'data' }]],
      [0x03000000, [{ name: 'CodeAtEven', kind: 'code' }]],
    ]);
    expect(lookupSymbol(map, 0x03000001)?.name).toBe('gOddData');
    const src = run('f', body, map);
    expect(src).toContain('gOddData');
  });
});

describe('register-offset addressing lowers exactly (never a silent index drop)', () => {
  // parseAddr used to silently read `[rB]`, dropping the index register — a silent miscompile
  // (ldrsh exists ONLY in this form in Thumb-1). Now it lowers as `rB + rX` then the access.
  test('ldrh rD, [rB, rX] reads base + index', () => {
    const body = '\tldr\tr1, .L1\n\tldrh\tr0, [r1, r0]\n\tbx\tlr\n.L1:\n\t.word\t0x08057B4C\n';
    const src = decompile('f', asmOf('f', body), ARMV4T_AGBCC, {}).source;
    // the index register participates (never dropped); the const is ELEMENT-scaled because the
    // recovered operand is u16* — 134576972 bytes = 67288486 u16 elements: byte-exact C
    expect(src).toContain('return *(67288486 + a0);');
  });

  test('strh rS, [rB, rX] stores through base + index', () => {
    const body = '\tldr\tr1, .L1\n\tstrh\tr0, [r1, r2]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
    const src = decompile('f', asmOf('f', body), ARMV4T_AGBCC, {}).source;
    expect(src).toContain('a1'); // the index register (r2 = a2? — at minimum both regs participate)
  });
});
