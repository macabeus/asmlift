// POINTER-typed MEMBERS from the symbol map: `gBgPtrs.pMap`, `gPtr->pBuf`.
//
// Two rules, and the first is what makes the second safe. A member the map declares a pointer is a
// POINTER in the emitted C, so every byte the asm added to it is scaled a second time by the
// declared pointee width — `bytes + gBgPtrs.pMap` on a `u16 *` addresses twice the byte the
// machine did, and no cast downstream can see it; the guard is the one the pointer GLOBAL rule
// already uses and states in the same words, CAST THEN ADD. Where the residual IS a whole number
// of elements, the source had no byte arithmetic at all: it wrote `gBgPtrs.pMap[i]`, and so does
// asmlift.
//
// The refusals are what keep both declaration facts rather than guesses, so they are what these
// tests pin hardest: a member the map does not declare a pointer, a member with no declared
// pointee width, and every offset that does not land on an element boundary.
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

// The kleod tilemap-copy shape: load the member at `off`, add a runtime offset, then a constant
// the load's own immediate cannot hold (`0x9d << 1` = 314), then read a halfword. `scale` is the
// shift the asm applies to the runtime offset — `1` makes it a whole number of `u16` elements,
// `0` leaves it a raw byte count that lands mid-element for every odd value.
const MEMBER_WALK = (off: number, scale: 0 | 1 = 1, read = 'ldrh\tr0, [r0]') =>
  `f:\n\tldr\tr1, .L1\n\tldr\tr1, [r1, #${off}]\n${scale ? `\tlsl\tr0, r0, #${scale}\n` : ''}` +
  `\tadd\tr0, r0, r1\n\tmov\tr2, #0x9d\n\tlsl\tr2, r2, #1\n\tadd\tr0, r0, r2\n` +
  `\t${read}\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n`;

const run = (asm: string, info: SymbolInfo = ptrsInfo()) =>
  decompile('f', asm, ARMV4T_AGBCC, { symbols: mapWith(info) }).source;

describe('arithmetic on a pointer-declared member', () => {
  test('a byte offset added to a `u16 *` member casts the MEMBER, not the sum', () => {
    // `(a0 + (u8 *)gBgPtrs.pMap) + 314` is that byte under any declaration; without the cast C
    // scales the residual by 2 again and the emitted C reads a different address than the asm.
    const src = run(MEMBER_WALK(4, 0));
    expect(src).toContain('(u8 *)gBgPtrs.pMap');
    expect(src).not.toMatch(/\+ gBgPtrs\.pMap/);
  });

  test("a `void *` member is cast too — the pointee width is the PROJECT's, not the map's guess", () => {
    // the map spells an unsized pointee `void *`, where the project header may declare anything;
    // the cast is what makes the address the same in both worlds
    expect(run(MEMBER_WALK(0))).toContain('(u8 *)gBgPtrs.pTiles');
  });

  test('a pointer member under a NON-ADDITIVE operator spells integer math on the cell', () => {
    // C rejects a pointer operand of `&` outright; the asm did 32-bit math on the address
    const asm =
      'f:\n\tldr\tr1, .L1\n\tldr\tr1, [r1, #0x4]\n\tmov\tr2, #0x3\n\tbic\tr1, r2\n' +
      '\tldrh\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n';
    expect(run(asm)).toContain('(u32)gBgPtrs.pMap');
  });
});

// store the member back into its own cell after advancing it by 4 bytes
const ADVANCE = (off: number) =>
  `f:\n\tldr\tr1, .L1\n\tldr\tr0, [r1, #${off}]\n\tadd\tr0, r0, #0x4\n\tstr\tr0, [r1, #${off}]\n` +
  `\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n`;

describe('the guard casts for the ADDRESS and casts back for the ASSIGNMENT', () => {
  test('a pointer member advanced by bytes is assigned back through `void *`', () => {
    // `gBgPtrs.pMap = (u8 *)gBgPtrs.pMap + 4` is the right address and the wrong TYPE: agbcc says
    // `assignment from incompatible pointer type` and exits 1 under the `-Werror` template this
    // project's own compiler config uses. `void *` is assignment-compatible with any declaration
    // of the cell, and all three spellings compile to byte-identical objects.
    const src = run(ADVANCE(4));
    expect(src).toContain('gBgPtrs.pMap = (void *)((u8 *)gBgPtrs.pMap + 4);');
  });

  test('a pointer GLOBAL is restored the same way — one rule, both populations', () => {
    const info: SymbolInfo = {
      name: 'gPtr',
      kind: 'data',
      declared: true,
      shape: 'pointer',
      pointee: { structName: 'Inner', size: 8, volatile: false, const: false, layout: [] },
    };
    const asm = `f:\n\tldr\tr1, .L1\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x4\n\tstr\tr0, [r1]\n` +
      `\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n`;
    expect(decompile('f', asm, ARMV4T_AGBCC, { symbols: mapWith(info) }).source).toContain(
      'gPtr = (void *)((u8 *)gPtr + 4);',
    );
  });

  test('a NON-pointer cell taking the same value is left alone — the cast is the declaration\'s', () => {
    // `count` is an `s32`: nothing about the assignment is a pointer, so nothing is restored
    const asm = `f:\n\tldr\tr1, .L1\n\tldr\tr0, [r1, #0x8]\n\tadd\tr0, r0, #0x4\n\tstr\tr0, [r1, #0x8]\n` +
      `\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n`;
    expect(run(asm)).not.toContain('void *');
  });
});

describe('refusals — anything the map does not declare a pointer keeps its spelling', () => {
  test('a `pointer` flag at a size the DECLARATION does not declare a pointer is not one', () => {
    // isPtrField tests TWO facts. symbolFieldType declares a pointer only at size 4, so a
    // `pointer` member of size 2 declares `u16 p;` — and trusting the flag alone spelled
    // `gW.p = (u8 *)gW.p + 4`, pointer arithmetic on a value its own declaration calls an integer.
    const info: SymbolInfo = {
      name: 'gW',
      kind: 'data',
      declared: true,
      shape: 'struct',
      structName: 'W',
      size: 4,
      layout: [{ name: 'p', offset: 0, size: 2, signed: false, pointer: true, pointeeSize: 2 }],
    };
    const asm = `f:\n\tldr\tr1, .L1\n\tldrh\tr0, [r1]\n\tadd\tr0, r0, #0x4\n\tstrh\tr0, [r1]\n` +
      `\tmov\tr0, #0x0\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n`;
    const src = decompile('f', asm, ARMV4T_AGBCC, { symbols: mapWith(info) }).source;
    expect(src).toContain('gW.p = gW.p + 4;');
    expect(src).not.toContain('u8 *');
  });


  test('a member declared a plain scalar is left alone', () => {
    // `count` is an s32 member: the asm added bytes to an integer, and so does the emitted C
    const src = run(MEMBER_WALK(8, 0));
    expect(src).toContain('gBgPtrs.count');
    expect(src).not.toContain('(u8 *)gBgPtrs.count');
  });

  test('a member the layout does not seat is not named, so nothing is cast', () => {
    // an UNSIZED member declines the whole layout (symbols.ts declaredFields), so the access falls
    // back to the cast forms and there is no member for the pointer rules to resolve
    const layout = LAYOUT.map((f) => (f.name === 'pMap' ? { ...f, size: null } : f));
    const src = run(MEMBER_WALK(4, 0), ptrsInfo({ layout: layout as SymbolStructField[] }));
    expect(src).not.toContain('pMap');
    expect(src).not.toContain('(u8 *)');
  });

  test('with NO symbol map at all the spelling is byte-identical to today', () => {
    const src = decompile('f', MEMBER_WALK(4, 0), ARMV4T_AGBCC).source;
    expect(src).not.toContain('gBgPtrs');
    expect(src).not.toContain('(u8 *)');
  });
});

// The buffer a pointer member points AT is an ARRAY in the project's own header, so an access of
// the declared element width at a whole multiple of it is that array's i-th ELEMENT.
describe('an element-scaled offset through a pointer member is an ELEMENT of it', () => {
  test('the runtime index and the load displacement fold into ONE subscript', () => {
    const src = run(MEMBER_WALK(4));
    expect(src).toContain('((u16 *)gBgPtrs.pMap)[a0 + 157]');
    expect(src).not.toContain('(u8 *)gBgPtrs.pMap'); // the byte spelling it replaces
  });

  test('a STORE through the member spells the element too', () => {
    const asm =
      'f:\n\tldr\tr2, .L1\n\tldr\tr2, [r2, #0x4]\n\tlsl\tr0, r0, #1\n\tadd\tr0, r0, r2\n' +
      '\tmov\tr3, #0x9d\n\tlsl\tr3, r3, #1\n\tadd\tr0, r0, r3\n\tstrh\tr1, [r0]\n' +
      '\tmov\tr0, #0x0\n\tbx\tlr\n' +
      '.L1:\n\t.word\t0x03004790\n';
    expect(run(asm)).toContain('((u16 *)gBgPtrs.pMap)[a0 + 157] = a1;');
  });
});

describe('refusals — anything that does not land on an element boundary keeps the byte spelling', () => {
  test('an access WIDER than the declared element is not an element of it', () => {
    // a word read through a `u16 *`: `pMap[i]` reads 2 bytes, so no subscript expresses it
    const src = run(MEMBER_WALK(4, 1, 'ldr\tr0, [r0]'));
    expect(src).toContain('(u8 *)gBgPtrs.pMap');
    expect(src).not.toContain('gBgPtrs.pMap)[');
  });

  test('a residual that is not element-scaled addresses MID-ELEMENT and declines', () => {
    // the index is added in BYTES, so half of its values land inside an element
    expect(run(MEMBER_WALK(4, 0))).not.toContain('gBgPtrs.pMap)[');
  });

  test('an ODD constant addresses MID-ELEMENT and declines', () => {
    const asm = MEMBER_WALK(4).replace('\tmov\tr2, #0x9d\n\tlsl\tr2, r2, #1\n', '\tmov\tr2, #0x9d\n');
    const src = run(asm);
    expect(src).toContain('(u8 *)gBgPtrs.pMap');
    expect(src).not.toContain('gBgPtrs.pMap)[');
  });

  test('a member with NO declared pointee width is never indexed — `void *` sizes nothing', () => {
    const src = run(MEMBER_WALK(0));
    expect(src).toContain('(u8 *)gBgPtrs.pTiles');
    expect(src).not.toContain('gBgPtrs.pTiles)[');
  });

  test('a SIGNED sub-word access does not read a member declared to point at an unsigned one', () => {
    // the subscript carries no cast of its own in the source spelling, so the declared pointee is
    // the only thing saying how a sub-word read fills — the argument bareArrayLead makes
    const asm =
      'f:\n\tldr\tr1, .L1\n\tldr\tr1, [r1, #0x4]\n\tlsl\tr0, r0, #1\n\tadd\tr0, r0, r1\n' +
      '\tmov\tr2, #0x9d\n\tlsl\tr2, r2, #1\n\tadd\tr0, r0, r2\n\tmov\tr3, #0x0\n' +
      '\tldrsh\tr0, [r0, r3]\n\tbx\tlr\n.L1:\n\t.word\t0x03004790\n';
    expect(run(asm)).not.toContain('gBgPtrs.pMap)[');
  });
});
