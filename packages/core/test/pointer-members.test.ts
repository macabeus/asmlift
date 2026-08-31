// POINTER-typed MEMBERS from the symbol map: `gBgPtrs.pMap`, `gPtr->pMap`. A member the map
// declares a pointer is a POINTER in the emitted C, so every byte the asm added to it is scaled a
// second time by the declared pointee width — `bytes + gBgPtrs.pMap` on a `u16 *` addresses twice
// the byte the machine did, and no cast downstream can see it. The guard is the one the pointer
// GLOBAL rule already uses and states in the same words: CAST THEN ADD.
//
// The refusals are what keep it a declaration fact rather than a guess: a member the map does not
// declare a pointer, and a synthesized `field_K` no declaration carries at all, keep their
// spelling byte-for-byte.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { type SymbolInfo, type SymbolMap, type SymbolStructField } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

// The kleod BgDataPtrs shape: a `void *` tiles pointer, then a `u16 *` tilemap pointer.
const LAYOUT: SymbolStructField[] = [
  { name: 'pTiles', offset: 0, size: 4, pointer: true },
  { name: 'pMap', offset: 4, size: 4, pointer: true, pointeeSize: 2, pointeeSigned: false },
  { name: 'count', offset: 8, size: 4, signed: true },
];
const ptrsInfo = (over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  name: 'gBgPtrs',
  kind: 'data',
  declared: true,
  shape: 'struct',
  structName: 'BgPtrs',
  size: 12,
  layout: LAYOUT,
  ...over,
});
const mapWith = (info: SymbolInfo): SymbolMap => new Map([[0x03004790, [info]]]);

// The kleod tilemap-copy shape verbatim: load the member, add a runtime byte offset (`a0 << 1`),
// then add a constant the load's own immediate cannot hold (`0x9d << 1`), then read a halfword.
// The trailing constant is what keeps the access on the ARITHMETIC path — a bare `member + index`
// feeding the load is claimed by the array-index recovery instead, and spells an element.
const MEMBER_PLUS_BYTES = (off: number) =>
  `f:\n\tldr\tr1, .L1\n\tldr\tr1, [r1, #${off}]\n\tlsl\tr0, r0, #1\n\tadd\tr0, r0, r1\n` +
  `\tmov\tr2, #0x9d\n\tlsl\tr2, r2, #1\n\tadd\tr0, r0, r2\n` +
  `\tldrh\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n`;

const run = (asm: string, info: SymbolInfo = ptrsInfo()) =>
  decompile('f', asm, ARMV4T_AGBCC, { symbols: mapWith(info) }).source;

describe('arithmetic on a pointer-declared member', () => {
  test('a byte offset added to a `u16 *` member casts the MEMBER, not the sum', () => {
    const src = run(MEMBER_PLUS_BYTES(4));
    // `(a0 << 1) + (u8 *)gBgPtrs.pMap` is that byte under any declaration; without the cast C
    // scales the residual by 2 again and the emitted C reads a different address than the asm.
    expect(src).toContain('(u8 *)gBgPtrs.pMap');
    expect(src).not.toMatch(/\+ gBgPtrs\.pMap/);
  });

  test("a `void *` member is cast too — the pointee width is the PROJECT's, not the map's guess", () => {
    // the map spells an unsized pointee `void *`, where the project header may declare anything;
    // the cast is what makes the address the same in both worlds
    const src = run(MEMBER_PLUS_BYTES(0));
    expect(src).toContain('(u8 *)gBgPtrs.pTiles');
  });

  test('a pointer member under a NON-ADDITIVE operator spells integer math on the cell', () => {
    // C rejects a pointer operand of `&` outright; the asm did 32-bit math on the address
    const asm =
      'f:\n\tldr\tr1, .L1\n\tldr\tr1, [r1, #0x4]\n\tmov\tr2, #0x3\n\tbic\tr1, r2\n' +
      '\tldrh\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n';
    expect(run(asm)).toContain('(u32)gBgPtrs.pMap');
  });
});

describe('refusals — anything the map does not declare a pointer keeps its spelling', () => {
  test('a member declared a plain scalar is left alone', () => {
    // `count` is an s32 member: the asm added bytes to an integer, and so does the emitted C
    const src = run(MEMBER_PLUS_BYTES(8));
    expect(src).toContain('gBgPtrs.count');
    expect(src).not.toContain('(u8 *)gBgPtrs.count');
  });

  test('a member the layout does not seat is not named, so nothing is cast', () => {
    // an UNSIZED member declines the whole layout (symbols.ts declaredFields), so the access falls
    // back to the cast forms and there is no member for the pointer rule to resolve
    const layout = LAYOUT.map((f) => (f.name === 'pMap' ? { ...f, size: null } : f));
    const src = run(MEMBER_PLUS_BYTES(4), ptrsInfo({ layout: layout as SymbolStructField[] }));
    expect(src).not.toContain('pMap');
    expect(src).not.toContain('(u8 *)');
  });

  test('with NO symbol map at all the spelling is byte-identical to today', () => {
    const src = decompile('f', MEMBER_PLUS_BYTES(4), ARMV4T_AGBCC).source;
    expect(src).not.toContain('gBgPtrs');
    expect(src).not.toContain('(u8 *)');
  });
});
