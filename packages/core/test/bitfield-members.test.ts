// BITFIELD members from the symbol map: `(x << a) >> b` over a struct global's loaded bytes
// spells the declared field (`gState.dreamStones`), whose `u32 f : n` declaration then makes C's
// own promotion reproduce the signedness downstream operators compiled with. Built for
// kleod:UpdateHUDCounterDisplay (the __udivsi3-for-__divsi3 family); the refusal conditions are
// what keep it exact rather than approximate, so they are what these tests pin hardest.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { renderDeclarations } from '../src/declare';
import { frontendFor } from '../src/frontend/registry';
import { verify } from '../src/ir/verify';
import { applyIdiomPatterns, decompile, raiseRecovered } from '../src/pipeline';
import { structure } from '../src/structure/structure';
import { type SymbolInfo, type SymbolMap, type SymbolStructField, declaredFields, symbolsByName } from '../src/symbols';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

// gState's first u16 packs three unsigned bitfields (the kleod Unk_03005220 shape): hearts
// bits 0-1, stars bits 2-4, dreamStones bits 5-11; a plain u32 follows at byte 4.
const LAYOUT: SymbolStructField[] = [
  { name: 'hearts', offset: 0, size: 1, signed: false, bitWidth: 2, bitOffset: 0 },
  { name: 'stars', offset: 0, size: 1, signed: false, bitWidth: 3, bitOffset: 2 },
  { name: 'dreamStones', offset: 0, size: 2, signed: false, bitWidth: 7, bitOffset: 5 },
  { name: 'unk4', offset: 4, size: 4, signed: false },
];
const stateInfo = (over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  name: 'gState',
  kind: 'data',
  declared: true,
  shape: 'struct',
  structName: 'State',
  size: 8,
  layout: LAYOUT,
  ...over,
});
const mapWith = (info: SymbolInfo): SymbolMap => new Map([[0x03005220, [info]]]);

// ldrh gState; lsl #20; lsr #25 — the unsigned extract of bits [11:5] = dreamStones
const EXTRACT = (shr: 'lsr' | 'asr') =>
  `f:\n\tldr\tr1, .L1\n\tldrh\tr0, [r1]\n\tlsl\tr0, r0, #20\n\t${shr}\tr0, r0, #25\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n`;

const run = (asm: string, info: SymbolInfo = stateInfo()) =>
  decompile('f', asm, ARMV4T_AGBCC, { symbols: mapWith(info) }).source;

describe('the extract spells the member', () => {
  test('an unsigned extract at the field bits reads gState.dreamStones', () => {
    const src = run(EXTRACT('lsr'));
    expect(src).toContain('return gState.dreamStones;');
    expect(src).not.toContain('<< 20');
  });

  test('every extract of a multi-read load spells the member, and the load temp is ABSORBED', () => {
    // one ldrh feeding two extracts: both spell members, and no `*(u16 *)&gState` temp remains —
    // the compiler CSEs the member reads back to one load; a leftover temp would be a second one
    const asm =
      'f:\n\tldr\tr2, .L1\n\tldrh\tr1, [r2]\n\tlsl\tr0, r1, #20\n\tlsr\tr0, r0, #25\n' +
      '\tlsl\tr1, r1, #30\n\tlsr\tr1, r1, #30\n\tadd\tr0, r0, r1\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    const src = run(asm);
    expect(src).toContain('gState.dreamStones');
    expect(src).toContain('gState.hearts');
    expect(src).not.toContain('(u16 *)');
  });
});

describe('refusals — any mismatch keeps the honest shift spelling', () => {
  test('an ARITHMETIC extract does not match an unsigned field', () => {
    const src = run(EXTRACT('asr'));
    expect(src).not.toContain('dreamStones');
    expect(src).toContain('>> 25');
  });

  test('a width mismatch does not match', () => {
    const asm = EXTRACT('lsr').replace('#25', '#26'); // width 6 — no 6-bit field at those bits
    const src = run(asm);
    expect(src).not.toContain('dreamStones');
    expect(src).toContain('>> 26');
  });

  test('a signless field never matches', () => {
    const layout = LAYOUT.map((f) => (f.name === 'dreamStones' ? { ...f, signed: undefined } : f));
    const src = run(EXTRACT('lsr'), stateInfo({ layout: layout as SymbolStructField[] }));
    expect(src).not.toContain('dreamStones');
  });

  test('a VOLATILE container refuses the whole fold — N member reads are not one load', () => {
    const src = run(EXTRACT('lsr'), stateInfo({ volatile: true }));
    expect(src).not.toContain('dreamStones');
  });

  test('a STORE to the folded global between load and extract refuses — the read must not move past it', () => {
    // adversarial round, CRITICAL 1: `g.field` re-reads memory at the render position, but the
    // asm captured the bits BEFORE the store; the honest capture-in-a-temp spelling stays
    const asm =
      'f:\n\tldr\tr1, .L1\n\tldrh\tr0, [r1]\n\tmovs\tr2, #0\n\tstrh\tr2, [r1]\n' +
      '\tlsl\tr0, r0, #20\n\tlsr\tr0, r0, #25\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    const src = run(asm);
    expect(src).not.toContain('dreamStones');
    expect(src).toContain('>> 25');
  });

  test('a store on the PATH but laid out AFTER the render still refuses — block order is not path order', () => {
    // second audit pass: .Lstore sits at a higher address than .Ljoin (where the extract renders)
    // but executes between the ldrh and the render on the taken path; a linear-position scan
    // missed it, the path-based gate must not
    const asm =
      'f:\n\tldr\tr3, .L9\n\tldrh\tr2, [r3]\n\tlsl\tr0, r2, #20\n\tlsr\tr0, r0, #25\n' +
      '\tcmp\tr1, #0\n\tbeq\t.Lstore\n.Ljoin:\n\tbx\tlr\n.Lstore:\n\tmovs\tr2, #0\n' +
      '\tstrh\tr2, [r3]\n\tb\t.Ljoin\n.L9:\n\t.word\t0x03005220\n';
    const src = run(asm);
    expect(src).not.toContain('dreamStones');
    expect(src).toContain('>> 25');
  });

  test('a CALL between load and extract refuses — the callee may write the global', () => {
    const asm =
      'f:\n\tpush\t{r4, lr}\n\tldr\tr4, .L1\n\tldrh\tr4, [r4]\n\tbl\tg\n' +
      '\tlsl\tr0, r4, #20\n\tlsr\tr0, r0, #25\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x03005220\n';
    const src = run(asm);
    expect(src).not.toContain('dreamStones');
    expect(src).toContain('>> 25');
  });

  test('a width-8 bit-0 extract is CAST_PATTERNS territory — folded to (u8), never a member name', () => {
    // engine.ts folds equal-immediate shift pairs (widths 8/16) at the idiom stage, before the
    // recognizer ever sees them — the documented shadowing: honest cast output at those widths
    const layout: SymbolStructField[] = [
      { name: 'octet', offset: 0, size: 1, signed: false, bitWidth: 8, bitOffset: 0 },
    ];
    const asm =
      'f:\n\tldr\tr1, .L1\n\tldrh\tr0, [r1]\n\tlsl\tr0, r0, #24\n\tlsr\tr0, r0, #24\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    const src = run(asm, stateInfo({ layout }));
    expect(src).not.toContain('octet');
    expect(src).toContain('(u8)');
  });

  test('a PLAIN u16 read of the bitfield bytes never names a bitfield', () => {
    // exact (offset,size) would match dreamStones (size 2 at offset 0) — a 7-bit lvalue for a
    // 16-bit access
    const asm = 'f:\n\tldr\tr1, .L1\n\tldrh\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    const src = run(asm);
    expect(src).not.toContain('dreamStones');
    expect(src).not.toContain('hearts');
  });
});

describe('declaredFields — bitfields seat by BIT cursor', () => {
  test('co-located bitfields are all declared, not union aliases', () => {
    expect(declaredFields(LAYOUT)?.map((f) => f.name)).toEqual(['hearts', 'stars', 'dreamStones', 'unk4']);
  });

  test('a bitfield STRADDLING a 32-bit unit is not declared (its bits pad), later members keep seating', () => {
    const layout: SymbolStructField[] = [
      { name: 'a', offset: 3, size: 1, signed: false, bitWidth: 4, bitOffset: 0 }, // bits 24-27
      { name: 'straddle', offset: 3, size: 2, signed: false, bitWidth: 8, bitOffset: 4 }, // bits 28-35
      { name: 'after', offset: 8, size: 4, signed: false },
    ];
    expect(declaredFields(layout)?.map((f) => f.name)).toEqual(['a', 'after']);
  });

  test('a bitfield with malformed facts declines the whole layout', () => {
    const bad = [{ name: 'x', offset: 0, size: 1, signed: false, bitWidth: 12, bitOffset: 0 }]; // 12 bits in 1 byte
    expect(declaredFields(bad as SymbolStructField[])).toBeNull();
  });

  test('a plain member tied with bitfields at one offset stays the first view — the pre-bitfield behavior', () => {
    // the union-of-raw-and-bitfields idiom: before bitfields were carried at all, the plain view
    // was the one declared, so it keeps winning the tie and the bitfields are the aliases
    const layout: SymbolStructField[] = [
      { name: 'lo', offset: 0, size: 1, signed: false, bitWidth: 6, bitOffset: 0 },
      { name: 'raw', offset: 0, size: 2, signed: false },
    ];
    expect(declaredFields(layout)?.map((f) => f.name)).toEqual(['raw']);
  });
});

describe('the option is inert without a map — the `/no-bitfield` decline rests on this', () => {
  // rank.ts does not enumerate `/no-bitfield` on the `/raw-globals` variant, because with no map
  // both arms structure the IDENTICAL tree. structure() makes that true for every reader of the
  // option rather than for the one that happens to sit inside `if (symCtx && …)` today: with
  // `symbols` absent the option is normalized to false at the boundary. These two tests are the
  // check on that normalization — a claim about this file, tested here rather than asserted in a
  // comment over there.
  const bothWays = (asm: string, symbols?: SymbolMap) => {
    const fn = () => {
      const lifted = frontendFor(ARMV4T_AGBCC).lift('f', asm, ARMV4T_AGBCC, {}, undefined, symbols);
      verify(lifted);
      applyIdiomPatterns(lifted, ARMV4T_AGBCC);
      raiseRecovered(lifted, ARMV4T_AGBCC);
      return lifted;
    };
    const opts = {
      ...structureOptionsFor(ARMV4T_AGBCC, false),
      ...(symbols ? { symbols: symbolsByName(symbols) } : {}),
    };
    return [true, false].map((spellBitfieldMembers) =>
      cBackend.emit(structure(fn(), { ...opts, spellBitfieldMembers })),
    );
  };

  test('with no symbol map both spellings structure the same function', () => {
    const [on, off] = bothWays(EXTRACT('lsr'));
    expect(on).toBe(off);
    expect(on).not.toContain('dreamStones'); // and it really is the shift spelling, not a no-op fixture
  });

  test('WITH the map they differ — so the test above is not passing for want of a fold', () => {
    const [on, off] = bothWays(EXTRACT('lsr'), mapWith(stateInfo()));
    expect(on).toContain('gState.dreamStones');
    expect(off).not.toContain('dreamStones');
  });
});

describe('declaration synthesis', () => {
  test('bitfields render `u32 f : n` with bit padding to the next seated member', () => {
    const refs = [{ name: 'gState', info: stateInfo() }];
    const decl = renderDeclarations(refs);
    expect(decl).toContain(
      'struct State { u32 hearts : 2; u32 stars : 3; u32 dreamStones : 7; u32 asmlift_pad_0 : 20; u32 unk4; };',
    );
    expect(decl).toContain('extern struct State gState;');
  });

  test('a signed bitfield declares s32', () => {
    const layout: SymbolStructField[] = [
      { name: 'delta', offset: 0, size: 1, signed: true, bitWidth: 5, bitOffset: 0 },
    ];
    const decl = renderDeclarations([{ name: 'gS', info: stateInfo({ structName: 'S2', layout, size: 4 }) }]);
    expect(decl).toContain('struct S2 { s32 delta : 5; u32 asmlift_pad_0 : 27; };');
  });
});

// ── the WRITE side: the mask-and-insert idiom ───────────────────────────────────────────────
// `store(A, or(and(load(A), ~W), v << lo))` is `gState.field = v;`. What makes it exact rather
// than approximate is the truncation rule: C truncates the assigned value to the field width,
// while the asm's `or` writes every bit of `v << lo` the STORE keeps — so an unmasked insert is
// only legal where the field ENDS the stored cell, or where the value provably fits.
const WRITE_LAYOUT: SymbolStructField[] = [
  ...LAYOUT,
  { name: 'low', offset: 8, size: 1, signed: false, bitWidth: 4, bitOffset: 0 },
  { name: 'top', offset: 8, size: 1, signed: false, bitWidth: 4, bitOffset: 4 },
  // a SIGNED and an UNSIGNED source field of the same width, for the truncation bound below
  { name: 'sdelta', offset: 9, size: 1, signed: true, bitWidth: 4, bitOffset: 0 },
  { name: 'udelta', offset: 10, size: 1, signed: false, bitWidth: 4, bitOffset: 0 },
];
const writeInfo = (over: Partial<SymbolInfo> = {}) => stateInfo({ size: 12, layout: WRITE_LAYOUT, ...over });
const runW = (asm: string, info: SymbolInfo = writeInfo()) => run(asm, info);

/** `gState.<window> = <value>` as agbcc lowers it: clear the window, or the insert in, store back.
 *  `pre` computes the value in r0; `keep` is the mask of the bits NOT written. */
const RMW = (pre: string, keep: string, byte = 0) =>
  `f:\n\tldr\tr1, .L1\n${pre}\tldrb\tr2, [r1, #${byte}]\n${keep}\torr\tr0, r2\n` +
  `\tstrb\tr0, [r1, #${byte}]\n\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n`;
const NARROW = '\tlsl\tr0, r0, #30\n\tlsr\tr0, r0, #30\n'; // a provably 2-bit value
const CLEAR_LOW2 = '\tmov\tr3, #0x3\n\tbic\tr2, r3\n';
const CLEAR_LOW4 = '\tmov\tr3, #0xf\n\tbic\tr2, r3\n';
/** the read fold's own 4-bit extract of the field at `byte`, signed (`asr`) or not (`lsr`). */
const READ4 = (shr: 'lsr' | 'asr', byte: number) =>
  `\tldrb\tr0, [r1, #${byte}]\n\tlsl\tr0, r0, #28\n\t${shr}\tr0, r0, #28\n`;

describe('the mask-and-insert idiom spells the member assignment', () => {
  test('a provably narrow value inserted at a declared window is one assignment', () => {
    const src = runW(RMW(NARROW, CLEAR_LOW2));
    expect(src).toContain('gState.hearts = (u32)(a0 << 30) >> 30;');
    expect(src).not.toContain('|'); // the read, the mask and the or are all gone
  });

  test('a field that ENDS the stored cell takes an unbounded value — the store truncates either way', () => {
    // the kleod `gUnk_030034B0.unk6_4 = gUnk_03004C20.level` shape: `level` is a whole u8, and its
    // bits above the window are dropped by the byte store exactly as C's own truncation drops them
    const src = runW(RMW('\tlsl\tr0, r0, #4\n', '\tmov\tr3, #0xf\n\tand\tr2, r3\n', 8));
    expect(src).toContain('gState.top = a0;');
    expect(src).not.toContain('<< 4');
  });
});

describe('refusals — the honest mask spelling stays', () => {
  test('an unbounded value into a window the cell does NOT end refuses', () => {
    // THE truncation rule, from the other side: C would write `a0 & 3` where the asm ors in every
    // bit of `a0` the byte store keeps
    const src = runW(RMW('', CLEAR_LOW2));
    expect(src).not.toContain('gState.hearts');
    expect(src).toContain('~3');
  });

  test('a SIGNED bitfield read does not fit its own width — it is sign-extended to 32 bits', () => {
    // `s32 sdelta : 4` reading -1 is 0xFFFFFFFF: the asm's `or` writes every bit the byte store
    // keeps (bits 4-7 of `top` clobbered), where `gState.low = gState.sdelta` truncates to the
    // 4-bit window and PRESERVES them. Different bytes, plausible C — so the bound refuses it.
    const src = runW(RMW(READ4('asr', 9), CLEAR_LOW4, 8));
    expect(src).not.toContain('gState.low =');
    expect(src).toContain('~15');
    // …and the identical function reading the UNSIGNED twin DOES fold, so the refusal is the
    // sign extension's and not the shape's
    expect(runW(RMW(READ4('lsr', 10), CLEAR_LOW4, 8))).toContain('gState.low = gState.udelta;');
  });

  test('a SIGNED read into a window that ENDS the cell still folds — the store truncates it', () => {
    // the bound is only consulted mid-cell: at bits 4-7 the byte store drops everything above the
    // window on BOTH sides, so sign extension changes nothing
    const src = runW(RMW(READ4('asr', 9) + '\tlsl\tr0, r0, #4\n', '\tmov\tr3, #0xf\n\tand\tr2, r3\n', 8));
    expect(src).toContain('gState.top = gState.sdelta;');
  });

  test('a mask that clears MORE bits than any declared field refuses', () => {
    // bits 0-2 cleared: `hearts` is 2 bits and `stars` starts at bit 2, so the window names nothing
    const src = runW(RMW(NARROW, '\tmov\tr3, #0x7\n\tbic\tr2, r3\n'));
    expect(src).not.toContain('gState.hearts');
    expect(src).not.toContain('gState.stars');
  });

  test('a NON-CONTIGUOUS cleared window is not a bitfield at all', () => {
    const src = runW(RMW(NARROW, '\tmov\tr3, #0x9\n\tbic\tr2, r3\n'));
    expect(src).not.toContain('gState.');
  });

  test('a VOLATILE container refuses — N named accesses are not one read-modify-write', () => {
    expect(runW(RMW(NARROW, CLEAR_LOW2), writeInfo({ volatile: true }))).not.toContain('gState.hearts');
  });

  test('a CONST container refuses a STORE — the cast form it replaces only cast the qualifier away', () => {
    expect(runW(RMW(NARROW, CLEAR_LOW2), writeInfo({ const: true }))).not.toContain('gState.hearts =');
  });

  test('a load of a DIFFERENT cell is not this cell being modified', () => {
    // the mask preserves byte 8's bits and the result is stored to byte 0 — two cells, no RMW
    const asm =
      'f:\n\tldr\tr1, .L1\n\tlsl\tr0, r0, #30\n\tlsr\tr0, r0, #30\n\tldrb\tr2, [r1, #0x8]\n' +
      '\tmov\tr3, #0x3\n\tbic\tr2, r3\n\torr\tr0, r2\n\tstrb\tr0, [r1]\n\tmov\tr0, #0x0\n\tbx\tlr\n' +
      '.L1:\n\t.word\t0x03005220\n';
    expect(runW(asm)).not.toContain('gState.hearts =');
  });

  test('a CALL between the load and the store refuses, and the MATERIALIZED temp is why', () => {
    // The asm captured the bits BEFORE the call. What refuses is not a rule of this fold: the call
    // forces the load to its own temp at its own position, and a materialized load is one this
    // fold may not delete. Asserting the temp is what pins that mechanism; a bare refusal
    // assertion passes for any reason at all.
    const withCall =
      'f:\n\tpush\t{r4, r5, r6, lr}\n\tldr\tr5, .L1\n\tlsl\tr6, r0, #30\n\tlsr\tr6, r6, #30\n' +
      '\tldrb\tr2, [r5]\n\tmov\tr3, #0x3\n\tbic\tr2, r3\n\tmov\tr4, r2\n\tbl\tSideEffect\n' +
      '\torr\tr6, r4\n\tstrb\tr6, [r5]\n\tmov\tr0, #0x0\n\tpop\t{r4, r5, r6}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L1:\n\t.word\t0x03005220\n';
    const src = runW(withCall);
    expect(src).not.toContain('gState.hearts =');
    expect(src).toMatch(/v\d+ = \*\(u8 \*\)&gState;[\s\S]*SideEffect/);
    // …and the same function without the call DOES fold, so the refusal is the call's
    expect(runW(withCall.replace('\tbl\tSideEffect\n', ''))).toContain('gState.hearts =');
  });

  test('a store that may ALIAS the cell refuses, by the same materialized temp', () => {
    // a byte store to the very cell, between the load and the store: the load may not sink past it
    const alias =
      'f:\n\tldr\tr1, .L1\n\tlsl\tr0, r0, #30\n\tlsr\tr0, r0, #30\n\tldrb\tr2, [r1]\n' +
      '\tmov\tr3, #0x3\n\tbic\tr2, r3\n\tmov\tr4, #0x7\n\tstrb\tr4, [r1]\n' +
      '\torr\tr0, r2\n\tstrb\tr0, [r1]\n\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    const src = runW(alias);
    expect(src).not.toContain('gState.hearts =');
    expect(src).toMatch(/v\d+ = \*\(u8 \*\)&gState;/);
  });
});

describe('what this fold does NOT police', () => {
  test('a store to a DISJOINT byte of the same symbol folds — it moves no read', () => {
    // The spelling this replaces reads the cell inline AT THE STORE, exactly where the named
    // member assignment reads it, so a write in between that the load may not alias changes
    // neither one. A symbol-wide alias query would refuse here and buy no ordering.
    const disjoint =
      'f:\n\tldr\tr1, .L1\n\tlsl\tr0, r0, #30\n\tlsr\tr0, r0, #30\n\tldrb\tr2, [r1]\n' +
      '\tmov\tr3, #0x3\n\tbic\tr2, r3\n\tmov\tr4, #0x7\n\tstrb\tr4, [r1, #0x5]\n' +
      '\torr\tr0, r2\n\tstrb\tr0, [r1]\n\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    const src = runW(disjoint);
    expect(src).toContain('gState.hearts = (u32)(a0 << 30) >> 30;');
    expect(src).toContain('((u8 *)&gState)[5] = 7;');
  });
});
