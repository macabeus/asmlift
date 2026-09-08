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
/** the SAME keep (`~3` = -4), materialised the way agbcc actually emits it: compiled with the
 *  pinned agbcc, `gF.a = 1;` on a `u8 a : 2` container is `mov r0,#0x4; neg r0,r0; and; orr`.
 *  agbcc emits no `bic` for this idiom; the `bic` clears in this file reach the fold through the
 *  Thumb frontend's `and(Rd, ~Rm)` lowering, legal input but not this compiler's. */
const CLEAR_LOW2_NEG = '\tmov\tr3, #0x4\n\tneg\tr3, r3\n\tand\tr2, r3\n';
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

  test('the mask materialisation agbcc ACTUALLY emits folds too — `mov;neg`, not `bic`', () => {
    // This suite builds its clears with `bic`, which agbcc does not emit here, so this row pins
    // the measured lowering. It also pins that the zero form's 32-bit-complement rule has not
    // leaked into the `or` form: `-4` satisfies that rule, and the `gState.top` rows do not.
    const src = runW(RMW(NARROW, CLEAR_LOW2_NEG));
    expect(src).toContain('gState.hearts = (u32)(a0 << 30) >> 30;');
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

// ── the ALL-ZERO form: agbcc emits no `or` at all ────────────────────────────────────────────
// `expmed.c` skips the insert when the assigned value is 0 (`:557-558`, `:606-608`), so
// `gState.low = 0;` lowers to `store(A, and(load(A), ~W))`. What decides whether that shape may be
// NAMED is the keep mask's MATERIALISATION, not the value: a declared store complements in the
// 32-bit domain (`~0xF` = -16, which no Thumb `mov` encodes, hence `mov #0x10; neg`), where a raw
// byte-domain spelling of the same clear narrows to one encodable `mov #0xF0`. Where the two
// spellings are the same object there is no evidence, and the fold refuses.

/** `gState.<window> = 0` as agbcc lowers it: clear the window, store the cleared load back. */
const ZERO = (keep: string, byte = 8) =>
  `f:\n\tldr\tr1, .L1\n\tldrb\tr2, [r1, #${byte}]\n${keep}\tstrb\tr2, [r1, #${byte}]\n` +
  `\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n`;
/** ~0xF built in the 32-bit domain — the materialisation only a DECLARED store produces. */
const KEEP_NEG16 = '\tmov\tr3, #0x10\n\tneg\tr3, r3\n\tand\tr2, r3\n';

describe('the all-zero bitfield store', () => {
  test('a keep mask with bits OUTSIDE the cell spells the assignment of 0', () => {
    const src = runW(ZERO(KEEP_NEG16));
    expect(src).toContain('gState.low = 0;');
    // the mask constant and the cast-spelled load are both gone
    expect(src).not.toContain('-16');
    expect(src).not.toContain('(u8 *)');
  });

  test('REFUSES a keep mask that fits the stored cell — the raw spelling is the same object', () => {
    // `mov #0xF0` clears the same window and is what a byte-domain source spelling compiles to,
    // so naming the member here would be a default with no byte evidence behind it.
    const src = runW(ZERO('\tmov\tr3, #0xf0\n\tand\tr2, r3\n'));
    expect(src).not.toContain('gState.low');
    expect(src).toContain('240');
  });

  test('REFUSES the HIGH nibble, whose two spellings agbcc compiles identically', () => {
    // `gState.top = 0;` and `0xF & *(u8 *)&gState[8]` are one object (`mov r0,#0xf` on both
    // sides): the complement fits a byte, so no materialisation distinguishes them.
    const src = runW(ZERO('\tmov\tr3, #0xf\n\tand\tr2, r3\n'));
    expect(src).not.toContain('gState.top');
  });

  test('REFUSES a WORD cell — a word-wide keep can never carry bits outside its own cell', () => {
    const word =
      'f:\n\tldr\tr1, .L1\n\tldr\tr2, [r1, #0x4]\n\tmov\tr3, #0x10\n\tneg\tr3, r3\n\tand\tr2, r3\n' +
      '\tstr\tr2, [r1, #0x4]\n\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    const layout: SymbolStructField[] = [
      ...WRITE_LAYOUT.filter((f) => f.offset !== 4),
      { name: 'wlow', offset: 4, size: 4, signed: false, bitWidth: 4, bitOffset: 0 },
    ];
    expect(runW(word, writeInfo({ layout }))).not.toContain('wlow = 0');
  });

  test('ACCEPTS a keep mask agbcc built from the POOL — the evidence is the value, not the `neg`', () => {
    // The near-miss this row exists to refuse: "the mask must be defined by a `neg`". Compiled
    // with the pinned agbcc, `gA.a = 0;` for `u16 a : 12` is `ldrh; ldr r0, .L3+4; and; strh`
    // with the pool word `-0x1000` — the SAME 32-bit complement, materialised without a `neg`.
    // A rule keyed on the defining op would refuse this; the mask-value rule admits it.
    const pool =
      'f:\n\tldr\tr1, .L1\n\tldrh\tr2, [r1, #0x4]\n\tldr\tr3, .L2\n\tand\tr2, r3\n' +
      '\tstrh\tr2, [r1, #0x4]\n\tmov\tr0, #0x0\n\tbx\tlr\n' +
      '.L1:\n\t.word\t0x03005220\n.L2:\n\t.word\t-0x1000\n';
    const layout: SymbolStructField[] = [
      ...WRITE_LAYOUT.filter((f) => f.offset !== 4),
      { name: 'wide', offset: 4, size: 2, signed: false, bitWidth: 12, bitOffset: 0 },
    ];
    expect(runW(pool, writeInfo({ layout }))).toContain('gState.wide = 0;');
  });

  test("REFUSES a mask that is not the window's 32-bit complement — the clear is a coincidence", () => {
    // `0xFFFF00F0` clears the same low nibble of byte 8 and carries bits outside the cell, so the
    // outside-bits test alone admits it. But a declared store complements in `int`: every bit
    // above the cell is SET. This word zeroes bits 8-15, so it is some other function of the
    // cell, and nothing says its low nibble came from a member assignment.
    const odd =
      'f:\n\tldr\tr1, .L1\n\tldrb\tr2, [r1, #0x8]\n\tldr\tr3, .L2\n\tand\tr2, r3\n' +
      '\tstrb\tr2, [r1, #0x8]\n\tmov\tr0, #0x0\n\tbx\tlr\n' +
      '.L1:\n\t.word\t0x03005220\n.L2:\n\t.word\t0xFFFF00F0\n';
    expect(runW(odd)).not.toContain('gState.low');
  });

  test('REFUSES a clear of the WHOLE cell — agbcc emits no load there, so there is nothing to fold', () => {
    // A field filling its own byte: the keep mask keeps NONE of the stored cell, so this is not a
    // read-modify-write. Compiled, `gE.f8 = 0;` is `mov #0x0; strb` — no load, no `and` — so the
    // candidate could never reproduce the bytes it was recognized from.
    const whole =
      'f:\n\tldr\tr1, .L1\n\tldrb\tr2, [r1, #0x4]\n\tldr\tr3, .L2\n\tand\tr2, r3\n' +
      '\tstrb\tr2, [r1, #0x4]\n\tmov\tr0, #0x0\n\tbx\tlr\n' +
      '.L1:\n\t.word\t0x03005220\n.L2:\n\t.word\t0xFFFFFF00\n';
    const layout: SymbolStructField[] = [
      ...WRITE_LAYOUT.filter((f) => f.offset !== 4),
      { name: 'byte4', offset: 4, size: 1, signed: false, bitWidth: 8, bitOffset: 0 },
    ];
    expect(runW(whole, writeInfo({ layout }))).not.toContain('gState.byte4');
  });

  test("REFUSES a store WIDER than the window needs — those are not the member's bytes", () => {
    // `hearts` is two bits inside byte 0, so the narrowest aligned cell holding it is a BYTE;
    // this is a HALFWORD read-modify-write of the same two bits. Compiled, a 2-bit field in a
    // `u16` container is `ldrb`/`strb` — agbcc picks the access from the field's BITS — so a
    // `strh` here names bytes the member does not. The second assertion pins that the rule reads
    // the window and not `size`: `size: 4` is what a producer reporting the storage unit rather
    // than the byte span would author, and it must not re-admit this store.
    const wide =
      'f:\n\tldr\tr1, .L1\n\tldrh\tr2, [r1]\n\tmov\tr3, #0x4\n\tneg\tr3, r3\n\tand\tr2, r3\n' +
      '\tstrh\tr2, [r1]\n\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    expect(runW(wide)).not.toContain('gState.hearts');
    const storageUnit = WRITE_LAYOUT.map((f) => (f.name === 'hearts' ? { ...f, size: 4 } : f));
    expect(runW(wide, writeInfo({ layout: storageUnit }))).not.toContain('gState.hearts');
  });

  // THE OR FORM'S HALF OF THE SAME RULE. The width test binds both forms, and every other write
  // row in this file runs at `width === 1`, so without these three the or-form arm has no
  // inhabitant at all.
  describe('the store width is the narrowest ALIGNED cell holding the window, in the `or` form too', () => {
    /** a word read-modify-write at byte 4: `and` the insert, `and` the pool keep, `orr`, `str`. */
    const WORD_RMW = (insMask: number, shift: string, keep: number) =>
      `f:\n\tldr\tr3, .L1\n\tldr\tr2, .L3\n\tand\tr2, r0\n${shift}\tldr\tr0, [r3, #0x4]\n` +
      `\tldr\tr1, .L2\n\tand\tr0, r1\n\torr\tr0, r2\n\tstr\tr0, [r3, #0x4]\n\tmov\tr0, #0x0\n\tbx\tlr\n` +
      `.L1:\n\t.word\t0x03005220\n.L2:\n\t.word\t${keep}\n.L3:\n\t.word\t${insMask}\n`;

    test('ACCEPTS a WORD store over a field that STRADDLES a byte pair — agbcc has no other access', () => {
      // Compiled, pinned agbcc: `struct M { u32 p:12; u32 x:8; u32 q:12; }; gM.x = v;` is
      //   `mov #0xff; and; lsl #0xc; ldr [r3]; ldr .word -0xff001; and; orr; str [r3]`
      // — a WORD read-modify-write over a field whose bits (12-19) touch two bytes and whose byte
      // SPAN is 2. No halfword access holds bits 12-19, so the compiler had to widen; a rule
      // bounded by the span refuses the only spelling that reproduces these bytes.
      const layout: SymbolStructField[] = [
        ...WRITE_LAYOUT.filter((f) => f.offset !== 4),
        { name: 'p', offset: 4, size: 2, signed: false, bitWidth: 12, bitOffset: 0 },
        { name: 'x', offset: 5, size: 2, signed: false, bitWidth: 8, bitOffset: 4 },
        { name: 'q', offset: 6, size: 2, signed: false, bitWidth: 12, bitOffset: 4 },
      ];
      const src = runW(WORD_RMW(255, '\tlsl\tr2, r2, #0xc\n', -0xff001), writeInfo({ layout }));
      expect(src).toContain('gState.x = 255 & a0;');
      expect(src).not.toContain('(s32 *)');
      // and again with `size` authored as the storage unit — the rule reads neither
      const unit = layout.map((f) => (f.bitWidth === undefined ? f : { ...f, size: 4 }));
      expect(runW(WORD_RMW(255, '\tlsl\tr2, r2, #0xc\n', -0xff001), writeInfo({ layout: unit }))).toContain(
        'gState.x = 255 & a0;',
      );
    });

    test('ACCEPTS a WORD store over a 3-byte-span field — no machine has a 3-byte access', () => {
      // Compiled, pinned agbcc: `struct S { u32 pad0; u32 a:20; u32 b:12; }; gS.a = v;` is
      //   `ldr .word 0xfffff; and; ldr [r3,#4]; ldr .word -0x100000; and; orr; str [r3,#4]`
      // `u32 a : 17` is the same. The span is 3, so ANY bound expressed in the span refuses a
      // whole band of fields — 17 to 24 bits wide — the compiler can only reach by word.
      const layout: SymbolStructField[] = [
        ...WRITE_LAYOUT.filter((f) => f.offset !== 4),
        { name: 'a', offset: 4, size: 3, signed: false, bitWidth: 20, bitOffset: 0 },
        { name: 'b', offset: 6, size: 2, signed: false, bitWidth: 12, bitOffset: 4 },
      ];
      const src = runW(WORD_RMW(0xfffff, '', -0x100000), writeInfo({ layout }));
      expect(src).toContain('gState.a = 1048575 & a0;');
      expect(src).not.toContain('(s32 *)');
    });

    test('REFUSES a HALFWORD store over a one-byte window in the `or` form too', () => {
      // the twin of the `hearts` zero-form refusal, with an insert: the narrowest cell holding
      // bits 0-1 is a byte, and this stores a halfword.
      const wide =
        'f:\n\tldr\tr1, .L1\n\tmov\tr3, #0x3\n\tand\tr0, r3\n\tldrh\tr2, [r1]\n' +
        '\tmov\tr3, #0x4\n\tneg\tr3, r3\n\tand\tr2, r3\n\torr\tr0, r2\n\tstrh\tr0, [r1]\n' +
        '\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
      expect(runW(wide)).not.toContain('gState.hearts');
    });
  });

  test('the clearing `and` must be consumed HERE — a second reader keeps the honest spelling', () => {
    // the fold deletes the load and the `and`; a second use would make the emitted C do the work
    // twice, so the store keeps the raw mask instead
    const twoReaders =
      'f:\n\tldr\tr1, .L1\n\tldrb\tr2, [r1, #0x8]\n\tmov\tr3, #0x10\n\tneg\tr3, r3\n\tand\tr2, r3\n' +
      '\tstrb\tr2, [r1, #0x8]\n\tstrb\tr2, [r1, #0x9]\n\tbx\tlr\n.L1:\n\t.word\t0x03005220\n';
    expect(runW(twoReaders)).not.toContain('gState.low = 0');
  });
});
