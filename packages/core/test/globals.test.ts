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

  // A pool word's addend may be NEGATIVE, and agbcc spells it `+-`: `&arr[i - k]` folds the bias
  // into the word rather than emitting a subtract, and under `-fhex-asm` the hex printer emits the
  // `+` operator then a constant carrying its own sign. Compiled, not supposed — at the
  // benchmark's canonical agbcc flags `&gTab[i-1]` emits `.word gTab+-0x4` and `&gElems[i-1]` over
  // an 8-byte struct `.word gElems+-0x8`.
  //
  // The VALUES below are the assembler's, read back out of `.data` after assembling each spelling
  // with this project's `as`: the sign is the PRODUCT of the whole run. Reading one wrong yields a
  // wrong ADDRESS, which compiles and scores, so the spellings are pinned here.
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
  // decide stays the loud decline, because the wrong answer here is a wrong address that compiles
  // and scores. None of these is a shape a compiler in the corpus emits, which is why they are
  // pinned — a refusal with no inhabitant is a refusal nobody can check.
  //
  // `.Ltab` is here for a different reason, and it is the one the symbol pattern's comment leans
  // on. A `.L` word is a CODE label, not a global, so naming one would spell `&.Ltab`, and the
  // population is not hypothetical: 32,144 `.word .L…` operand occurrences across the nine
  // benchmark checkouts, counted through this frontend's own line reader (peel a label sharing the
  // line, then cut at `@`) — a count that skips the peel misses one. The symbol class admits no
  // leading dot, so the word is refused before the `.L` guard is reached and that guard is a proven
  // no-op; these two fixtures are what a mutant widening the class would kill.
  test('a pool word the parser cannot decide still declines loudly', () => {
    const word = (w: string) => () => thumb('back', `\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t${w}\n`);
    for (const w of ['gTab+gOther', 'gTab+0x4+0x8', 'gTab*0x8', 'gTab+0x8y', 'gTab+', '.Ltab', '.Ltab+0x4']) {
      expect(word(w), w).toThrow(`pool word '${w}' is not a symbol, symbol±offset, or number`);
    }
  });

  // The magnitude, from the other direction. `Number()` answers for digit strings the assembler
  // reads differently or not at all, and its answer reached the emitted C: `gTab+010` came out as
  // the addend 10 against the assembler's 8, and `gTab+99999999999999999999999` as the DOUBLE
  // `1e+23`, which is not an address. This project's `as`, read back out of `.data`: `010` is 8,
  // `-010` is -8, and every magnitude past 32 bits is 0, since a pool word is 32 bits and `as`
  // reduces modulo 2^32. A truncation is not something to reproduce from a guess, so both shapes
  // refuse — and each says which one it is, since "not a number" is false about `010`.
  test('a pool magnitude this reader cannot decide declines, and says which kind it is', () => {
    const word = (w: string) => () => thumb('back', `\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t${w}\n`);
    for (const w of ['gTab+0x100000000', 'gTab+4294967296', 'gTab+99999999999999999999999']) {
      expect(word(w), w).toThrow('carries an addend that is not a 32-bit value');
    }
    expect(word('0x100000000'), '0x100000000').toThrow("word '0x100000000' is not a 32-bit value");
    for (const w of ['010', '-010', 'gTab+010']) {
      expect(word(w), w).toThrow('leading-zero magnitude, which is octal to the assembler');
    }
    // The controls, on both sides of each refusal: the widest addend a 32-bit word can carry still
    // reads, a hex magnitude whose digits start with a zero is not an octal one, and the hex
    // PREFIX is case-insensitive because gas is — `.word 0X8` assembles to 8, the same as
    // `.word 0x8`, read back out of `.data`.
    expect(word('gTab+0xffffffff')()).toContain('(u32)&gTab + 4294967295');
    expect(word('gTab+0x08')()).toContain('(u32)&gTab + 8');
    expect(word('gTab+0X8')()).toContain('(u32)&gTab + 8');
    expect(word('gTab-0X8')()).toContain('(u32)&gTab + -8');
    expect(word('0X8')()).toContain('return 8;');
  });

  // A POOL ADDEND AND A MATERIALISED ADD ARE THE SAME VALUE, and this is what says so. The addend
  // reaches a typed-pointer INDEX where it divides the access width, which is where a
  // rendered-vs-value confusion would show up as a fractional or multiplied element. It cannot,
  // because the renderer is the one the register-materialised `ldr rN,=gSym; add rN,#k` shape goes
  // through too. Pinning the PAIR is the point: a change that moved one and not the other is the
  // drift, and each alone would still look right.
  test('a pool addend and a materialised add render the same, including where neither scales', () => {
    const pool = (addend: string) =>
      thumb('back', `\tldr\tr1, .L1\n\tldr\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\tgTab+${addend}\n`);
    const reg = (k: string) =>
      thumb('back', `\tldr\tr1, .L1\n\tadd\tr1, r1, #${k}\n\tldr\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\tgTab\n`);
    expect(pool('0x8')).toContain('((s32 *)&gTab)[2]');
    expect(reg('8')).toContain('((s32 *)&gTab)[2]');
    expect(pool('0x6')).toContain('*(s32 *)((u32)&gTab + 6)');
    expect(reg('6')).toContain('*(s32 *)((u32)&gTab + 6)');
    // The negative side scales too, and exactly: `-8` over a 4-byte access is `[-2]`, never a
    // fraction, and `-6` falls back the same way the positive one does.
    expect(pool('-0x8')).toContain('((s32 *)&gTab)[-2]');
    expect(pool('-0x6')).toContain('*(s32 *)((u32)&gTab + -6)');
  });

  test('a pool word whose ADDEND refuses still names its symbol, and still vetoes promotion', () => {
    // The refusal is about the VALUE, and the two readers ask different questions of the same
    // word: `poolNamesASymbol` asks only whether anything external is named here. A word whose
    // addend does not fit still names `gTab`, so the veto must still fire — answering "not a
    // symbol" would lose the witness and spell `gPromoted`. The bad word is never LOADED here.
    const symbols: SymbolMap = new Map([[0x3000010, [{ name: 'gPromoted', kind: 'data' }]]]);
    const asm =
      'mix:\n\tldr\tr1, .L1+0x4\n\tldrh\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\tgTab+0x100000000\n\t.word\t0x3000010\n';
    const src = decompile('mix', asm, ARMV4T_AGBCC, { symbols }).source;
    expect(src).toContain('*(u16 *)50331664');
    expect(src).not.toContain('gPromoted');
  });

  // …and for every word the expression grammar REJECTS, not only for the shapes it matches. Each
  // of these names `gTab` as plainly as the word above does. Asking the whole-word grammar a
  // question that is only about the leading name answers null for all of them, the witness is
  // lost, and the numeric word beside them is spelt `gPromoted` — a name the source never used.
  // That failure is quieter than a wrong addend, not louder: the ADDRESS stays right and only the
  // spelling is invented, so nothing downstream refuses it and no object differ can see it.
  test('a word the expression grammar REJECTS still names its symbol, and still vetoes promotion', () => {
    const symbols: SymbolMap = new Map([[0x3000010, [{ name: 'gPromoted', kind: 'data' }]]]);
    const mix = (w: string) =>
      decompile(
        'mix',
        `mix:\n\tldr\tr1, .L1+0x4\n\tldrh\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\t${w}\n\t.word\t0x3000010\n`,
        ARMV4T_AGBCC,
        { symbols },
      ).source;
    for (const w of ['gTab+010', 'gTab+0777', 'gTab+gOther', 'gTab*0x8', 'gTab+', 'gTab+0x4+0x8']) {
      expect(mix(w), w).toContain('*(u16 *)50331664');
      expect(mix(w), w).not.toContain('gPromoted');
    }
    // The control, and it makes this a witness test rather than a no-promotion test: a pool naming
    // nothing external is a disassembly whose relocations are gone, and there the map's name is
    // all there is. `.Ltab` is a CODE label in this same asm, so it witnesses nothing.
    expect(mix('.Ltab'), '.Ltab').toContain('gPromoted');
  });

  // The same rule one level up, in the pool's OPERAND rather than in its words. `poolRef` has two
  // ways to say no and they are not interchangeable: `null` means "this operand is not a pool" and
  // hands the load to the ordinary memory path, where the label becomes a phantom pointer
  // parameter. An operand that DOES name a pool, at an offset the reader cannot read, has to be
  // the loud decline instead. `+0x4` is the control: the offset shape that IS read keeps reading.
  test('a pool loaded at an offset the reader cannot read declines, never a phantom param', () => {
    const load = (op: string) => () => thumb('back', `\tldr\tr0, ${op}\n\tbx\tlr\n.L1:\n\t.word\tgA\n\t.word\tgB\n`);
    expect(load('.L1+0x4')()).toContain('return &gB;');
    // The hex prefix's case is the assembler's, not a spelling: `ldr r0, .L1+0X4` assembles to the
    // same load as `+0x4`, measured.
    expect(load('.L1+0X4')()).toContain('return &gB;');
    for (const op of ['.L1+-0x4', '.L1-0x4', '.L1++0x4']) {
      expect(load(op), op).toThrow("into pool '.L1' is not a '+N' byte offset");
    }
    // …and the radix gets its own message here too, because `+010` IS a `+N` byte offset and
    // saying otherwise invites the one answer that would take octal — widening the magnitude,
    // which now stands behind three patterns at once.
    for (const op of ['.L1+010', '.L1+04']) {
      expect(load(op), op).toThrow('has a leading-zero magnitude, which is octal to the assembler');
    }
  });

  test('a pool whose only symbolic word carries a negative addend still VETOES numeric promotion', () => {
    // The numeric-promotion veto (poolNamesASymbol) asks whether THIS asm's pool names anything
    // external: if it does, agbcc would have emitted the numeric word symbolically too had the
    // source named it, so promoting that word spells a name the source did not use. A `+-` word
    // names `gTab` as surely as a bare one does; read by a narrower grammar this pool would
    // witness NOTHING and `gPromoted` would be spelled here.
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
