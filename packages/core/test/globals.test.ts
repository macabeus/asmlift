// Global-variable recovery (F9): an agbcc `ldr rD, .Lpool` whose pool word is `.word gSym`
// recovers as the ADDRESS of a named global (frontend `gaddr` op → L3 `addr` node). A load/store
// through it at offset 0 collapses to the bare global `gSym` / `gSym = v` (never a phantom-pointer
// param); `*(&gSym + i)` is the global array `gSym[i]`. The global's type comes from project
// headers, so it is referenced by name, never declared as a local. agbcc emissions verified
// byte-exact against the real toolchain before the decode landed (SeedRng/EepromTimerIntr match).
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { type SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const thumb = (sym: string, body: string) => decompile(sym, `${sym}:\n${body}`, ARMV4T_AGBCC).source;

describe('global-variable recovery', () => {
  test('a store through a pool symbol is a bare global write, no phantom param', () => {
    // ldr r2, .L(gSym); str r0, [r2]  →  gSym = a0
    const src = thumb('setg', '\tldr\tr2, .L1\n\tstr\tr0, [r2]\n\tbx\tlr\n.L1:\n\t.word\tgSym\n');
    expect(src).toContain('gSym = a0;');
    expect(src).toContain('setg(s32 a0)'); // ONE real param — NO phantom pointer param for the global
    expect(src).not.toContain('a1'); // the global is not a parameter
  });

  test('a load through a pool symbol is a bare global read', () => {
    const src = thumb('getg', '\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\tgCounter\n');
    expect(src).toContain('return gCounter;');
    expect(src).not.toContain('*'); // no deref — the global is named directly
  });

  test('one pool address serving a read AND a write recovers both to the same global', () => {
    // the RNG shape: ldr r2,.L; ldr r1,[r2]; add r1,#1; str r1,[r2]
    const src = thumb(
      'bump',
      '\tldr\tr2, .L1\n\tldr\tr1, [r2]\n\tadd\tr1, r1, #0x1\n\tstr\tr1, [r2]\n\tbx\tlr\n.L1:\n\t.word\tgSeed\n',
    );
    expect(src).toContain('gSeed = gSeed + 1;');
    expect(src).not.toMatch(/\*a\d/); // no phantom deref anywhere
  });

  test('a global ARRAY element `*(&gSym + i)` recovers as (&gSym)[i] (u8, unscaled residual)', () => {
    // ldr r1,.L(gTable); ldrb r0,[r1, r0] would be add(r0,gaddr) → gTable[r0]; use the add form
    const src = thumb('idx', '\tldr\tr1, .L1\n\tadd\tr0, r0, r1\n\tldrb\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\tgTable\n');
    // An AGGREGATE global (indexed, never a bare off-0 scalar) is spelled through its ADDRESS
    // `&gTable`, not the bare name: a struct global does not decay, so `((u8 *)gTable)[a0]` is
    // invalid C for a struct while `((u8 *)&gTable)[a0]` is valid for BOTH array and struct and
    // compiles to the identical byte load. We cannot tell array from struct at this layer, so the
    // universally-valid `&` form is emitted. See scalarGlobals in structure.ts.
    expect(src).toContain('((u8 *)&gTable)[a0]');
  });

  // A pool word's addend may be NEGATIVE, and agbcc spells it `+-`. `&arr[i - k]` folds the bias
  // into the word rather than emitting a subtract, and under `-fhex-asm` — which every agbcc GBA
  // decomp builds with — the hex printer emits the `+` operator and then a constant carrying its
  // own sign. Compiled, not supposed: at the benchmark's canonical agbcc flags,
  // `int *f(int i){ return &gTab[i-1]; }` emits `.word gTab+-0x4` and
  // `struct E *f(int i){ return &gElems[i-1]; }` emits `.word gElems+-0x8`.
  //
  // The VALUES below are the assembler's, read back out of `.data` after assembling each spelling
  // with this project's `as`: the sign is the PRODUCT of the whole run, so `gSym+-0x8` is -8 and
  // `gSym--0x8` is +8. Reading one of these wrong yields a wrong ADDRESS, which compiles and
  // scores — the object differ cannot referee it — so the spellings are pinned here.
  test('a NEGATIVE pool addend `gSym+-0xN` is the address minus N', () => {
    const src = thumb('back', '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\tgTab+-0x8\n');
    expect(src).toContain('(u32)&gTab + -8');
  });

  test('a pool addend reads the sign of its whole run, as the assembler does', () => {
    const word = (w: string) => thumb('back', `\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t${w}\n`);
    expect(word('gTab+-8')).toContain('(u32)&gTab + -8');
    expect(word('gTab-+0x8')).toContain('(u32)&gTab + -8');
    expect(word('gTab--0x8')).toContain('(u32)&gTab + 8');
    expect(word('gTab++0x8')).toContain('(u32)&gTab + 8');
    expect(word('gTab-0x8')).toContain('(u32)&gTab + -8');
  });

  // The loose side. A widened addend parser must not start GUESSING a value: a word it cannot
  // decide has to stay the loud decline it is today, because the wrong answer here is a wrong
  // address that compiles and scores. None of these is a shape any compiler in the corpus emits —
  // that is the point, a refusal with no inhabitant is a refusal nobody can check.
  test('a pool word the parser cannot decide still declines loudly', () => {
    const word = (w: string) => () => thumb('back', `\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t${w}\n`);
    for (const w of ['gTab+gOther', 'gTab+0x4+0x8', 'gTab*0x8', 'gTab+0x8y', 'gTab+']) {
      expect(word(w), w).toThrow(`pool word '${w}' is not a symbol, symbol±offset, or number`);
    }
  });

  test('a pool whose only symbolic word carries a negative addend still VETOES numeric promotion', () => {
    // The numeric-promotion veto (poolNamesASymbol) asks whether THIS asm's pool names anything
    // external: if it does, agbcc would have emitted the numeric word symbolically too had the
    // source named it, so promoting that word spells a name the source did not use. A `+-` word
    // names `gTab` as surely as a bare word does. Read by a narrower grammar than the one
    // poolRef uses, this pool would witness NOTHING and `gPromoted` would be spelled here — the
    // exact drift between the two readers that POOL_WORD_SYMBOL exists to prevent.
    const symbols: SymbolMap = new Map([[0x3000010, [{ name: 'gPromoted', kind: 'data' }]]]);
    const asm =
      'mix:\n\tldr\tr0, .L1\n\tldr\tr1, .L1+0x4\n\tldrh\tr1, [r1]\n\tadd\tr0, r0, r1\n\tbx\tlr\n.L1:\n\t.word\tgTab+-0x8\n\t.word\t0x3000010\n';
    const src = decompile('mix', asm, ARMV4T_AGBCC, { symbols }).source;
    expect(src).toContain('(u32)&gTab + -8');
    expect(src).toContain('*(u16 *)50331664'); // the numeric word stays the constant the target shows
    expect(src).not.toContain('gPromoted');
  });

  test('a NUMERIC pool word stays a constant (MMIO address), not a global', () => {
    // ldr r0, .L(0x4000130); ldrh r0,[r0]  →  *(u16 *)0x4000130 (REG_KEYINPUT), NOT a symbol
    const src = thumb('mmio', '\tldr\tr0, .L1\n\tldrh\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x4000130\n');
    expect(src).toContain('*(u16 *)67109168'); // the numeric-const path is unchanged
  });
});
