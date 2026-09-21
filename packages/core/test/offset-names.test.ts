// A NAME FOR AN ADDRESS THE MACHINE BUILT BY ARITHMETIC (raise/offsetnames.ts).
//
// The frontend asks the symbol map what lives at a POOL-LOADED word. A compiler with several
// neighbouring cells to touch loads one pool word and walks — `adds r1, #12` — so every cell after
// the first is reached by arithmetic and the map is never asked about it. This file pins both
// halves: the walk resolves to the name the map holds at that exact address, and every refusal
// leaves the arithmetic the frontend emitted.
//
// The refusals carry the weight, because this changes the DEFAULT spelling rather than adding a
// candidate: naming a cell the map does not hold there is a silently wrong address with no second
// opinion.
import { describe, expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { without } from '../src/l3/gates';
import { decompile } from '../src/pipeline';
import { OFFSET_NAME_GATES, nameOffsetAddresses, offsetNameRefusals } from '../src/raise/offsetnames';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

/** A Thumb leaf function, in the exact shape agbcc emits one: body, then an aligned pool. */
const thumb = (name: string, body: string, pool: string): string =>
  `	.code	16
.text
	.align	2, 0
	.globl	${name}
	.type	 ${name},function
	.thumb_func
${name}:
${body}
	bx	lr
.L4:
	.align	2, 0
.L3:
	${pool}
.Lfe1:
	.size	 ${name},.Lfe1-${name}
`;

/** The GBA DMA control halfwords, twelve bytes apart — the shape agbcc walks. Address-cast macros,
 *  as the project's own headers declare them. */
const reg = (name: string): SymbolInfo => ({
  name,
  kind: 'data',
  shape: 'scalar',
  size: 2,
  signed: false,
  volatile: true,
});
const DMA: SymbolMap = new Map([
  [0x040000ba, [reg('REG_DMA0CNT_H')]],
  [0x040000c6, [reg('REG_DMA1CNT_H')]],
  [0x040000d2, [reg('REG_DMA2CNT_H')]],
]);

/** Store 1 into the pool-loaded cell, then into the two cells the walk reaches. */
const WALK = thumb(
  'walk',
  `	ldr	r1, .L3
	movs	r2, #1
	strh	r2, [r1]
	adds	r1, #12
	strh	r2, [r1]
	adds	r1, #12
	strh	r2, [r1]`,
  '.word	0x40000ba',
);

/** The same cell reached from two arms, so the store's base operand is the block PARAMETER the
 *  merge binds — and the `str` writes four bytes where the map declares two. */
const MERGED = thumb(
  'walk',
  `	ldr	r1, .L3
	movs	r2, #1
	cmp	r0, #0
	beq	.L2
	adds	r1, #12
	b	.L5
.L2:
	adds	r1, #12
.L5:
	str	r2, [r1]`,
  '.word	0x40000ba',
);

const lift = (name: string, asm: string, symbols?: SymbolMap) =>
  frontendFor(ARMV4T_AGBCC).lift(name, asm, ARMV4T_AGBCC, {}, undefined, symbols);

const src = (name: string, asm: string, symbols: SymbolMap) => decompile(name, asm, ARMV4T_AGBCC, { symbols }).source;

/** WHICH RULE decided, per `<base>+<offset>` site — the attribution `firstRejection` exists for. */
const refusals = (name: string, asm: string, symbols: SymbolMap) => [
  ...offsetNameRefusals(lift(name, asm, symbols), symbols),
];

describe('a walked-to address the map names', () => {
  test('every cell of the walk is the name the map holds at its address', () => {
    const out = src('walk', WALK, DMA);
    expect(out).toContain('REG_DMA0CNT_H = 1;');
    expect(out).toContain('REG_DMA1CNT_H = 1;');
    expect(out).toContain('REG_DMA2CNT_H = 1;');
    // the walk is gone: no cast off the base, and no address arithmetic left to spell
    expect(out).not.toContain('&REG_DMA0CNT_H');
    expect(refusals('walk', WALK, DMA)).toEqual([
      ['REG_DMA0CNT_H+12', null],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('a negative offset walks backwards to the name the map holds there', () => {
    const back = thumb(
      'back',
      `	ldr	r1, .L3
	movs	r2, #1
	subs	r1, #12
	strh	r2, [r1]`,
      '.word	0x40000c6',
    );
    expect(src('back', back, DMA)).toContain('REG_DMA0CNT_H = 1;');
    expect(refusals('back', back, DMA)).toEqual([['REG_DMA1CNT_H-12', null]]);
  });
});

describe('what refuses', () => {
  /** The same walk, judged against a map that differs in one fact. */
  const judged = (symbols: SymbolMap, asm = WALK) => refusals('walk', asm, symbols);

  test('no-symbol-at-offset — nothing sits there, so the arithmetic stands', () => {
    const lone: SymbolMap = new Map([[0x040000ba, [reg('REG_DMA0CNT_H')]]]);
    expect(judged(lone)).toEqual([
      ['REG_DMA0CNT_H+12', 'no-symbol-at-offset'],
      ['REG_DMA0CNT_H+24', 'no-symbol-at-offset'],
    ]);
    expect(src('walk', WALK, lone)).toContain('&REG_DMA0CNT_H');
  });

  test('base-unsized — an unsized base cannot tell its own interior from a neighbour', () => {
    const unsized: SymbolMap = new Map([
      [0x040000ba, [{ name: 'gPalette', kind: 'data' as const, shape: 'array' as const, elemSize: 2 }]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(unsized)).toEqual([
      ['gPalette+12', 'base-unsized'],
      ['gPalette+24', 'base-unsized'],
    ]);
  });

  test('interior-offset — the address lands inside the base object', () => {
    const big: SymbolMap = new Map([
      [0x040000ba, [{ name: 'gTable', kind: 'data' as const, shape: 'array' as const, size: 64, elemSize: 2 }]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(big)).toEqual([
      ['gTable+12', 'interior-offset'],
      ['gTable+24', 'interior-offset'],
    ]);
  });

  test('base-address-ambiguous — the map carries the base name at two addresses', () => {
    const twice: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x030000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(twice)).toEqual([
      ['REG_DMA0CNT_H+12', 'base-address-ambiguous'],
      ['REG_DMA0CNT_H+24', 'base-address-ambiguous'],
    ]);
  });

  test('target-address-ambiguous — the map gives the walked-to address two names', () => {
    const aliased: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gDmaAlias' }, reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(aliased)).toEqual([
      ['REG_DMA0CNT_H+12', 'target-address-ambiguous'],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('two entries at the walked-to address that agree on everything spelled are one answer', () => {
    const twin: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [reg('REG_DMA1CNT_H'), { ...reg('REG_DMA1CNT_H'), volatile: false }]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(twin)).toEqual([
      ['REG_DMA0CNT_H+12', null],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('target-is-code — a walked-to function address is a relocation this cannot reproduce', () => {
    const code: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ name: 'DoTheThing', kind: 'code' as const }]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(code)).toEqual([
      ['REG_DMA0CNT_H+12', 'target-is-code'],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('base-is-code — an offset into a function is not an object C can name', () => {
    const fromCode: SymbolMap = new Map([
      [0x040000ba, [{ name: 'DoTheThing', kind: 'code' as const, size: 4 }]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(fromCode)).toEqual([
      ['DoTheThing+12', 'base-is-code'],
      ['DoTheThing+24', 'base-is-code'],
    ]);
  });

  test('const-target-store — a store through a const-declared name does not compile', () => {
    const rom: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gRomWord', const: true }]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(rom)).toEqual([
      ['REG_DMA0CNT_H+12', 'const-target-store'],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('access-unlike-target — a halfword store walked onto a word-wide name', () => {
    const wide: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gWord', size: 4 }]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(wide)).toEqual([
      ['REG_DMA0CNT_H+12', 'access-unlike-target'],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('access-unlike-target — an unsigned halfword load walked onto a signed name', () => {
    const readWalk = thumb(
      'walk',
      `	ldr	r1, .L3
	adds	r1, #12
	ldrh	r0, [r1]`,
      '.word	0x40000ba',
    );
    const signed: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gSigned', signed: true }]],
    ]);
    expect(judged(signed, readWalk)).toEqual([['REG_DMA0CNT_H+12', 'access-unlike-target']]);
  });

  // Compiled, agbcc at its canonical flags: the arithmetic this refusal leaves is
  // `ldr r2,.L3 / mov r1,#0x1 / str r1,[r2]` over `.word REG_DMA0CNT_H+0xc` — the target's own
  // four-byte store at its own address. The name the gate refuses, `REG_DMA1CNT_H = 1;`, is
  // `strh` over a two-byte declaration.
  test('access-behind-merge — the access hangs off the block parameter, not off this value', () => {
    // ONE address, TWO sites: each arm's `adds` is its own `add` op, and each is refused.
    expect(judged(DMA, MERGED)).toEqual([
      ['REG_DMA0CNT_H+12', 'access-behind-merge'],
      ['REG_DMA0CNT_H+12', 'access-behind-merge'],
    ]);
    const out = src('walk', MERGED, DMA);
    expect(out).not.toContain('REG_DMA1CNT_H');
    expect(out).toContain('&REG_DMA0CNT_H');
  });

  test('target-unsized — the map names the neighbour but states no width for it', () => {
    const nameOnly: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ name: 'gNeighbour', kind: 'data' as const }]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(nameOnly)).toEqual([
      ['REG_DMA0CNT_H+12', 'target-unsized'],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('a name the map states no width for is still named where nothing accesses it', () => {
    const handOut = thumb(
      'walk',
      `	ldr	r1, .L3
	adds	r1, #12
	adds	r0, r1, #0`,
      '.word	0x40000ba',
    );
    const nameOnly: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ name: 'gNeighbour', kind: 'data' as const }]],
    ]);
    expect(judged(nameOnly, handOut)).toEqual([['REG_DMA0CNT_H+12', null]]);
  });

  test('one name listed twice at ONE address is not two addresses', () => {
    const aliased: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H'), reg('REG_DMA0CNT_H')]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(aliased)).toEqual([
      ['REG_DMA0CNT_H+12', null],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('const-target-store fires through the index between the walk and the store', () => {
    const indexed = thumb(
      'walk',
      `	ldr	r1, .L3
	movs	r2, #1
	adds	r1, #12
	lsls	r3, r0, #1
	adds	r3, r3, r1
	strh	r2, [r3]`,
      '.word	0x40000ba',
    );
    const rom: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [
        0x040000c6,
        [{ name: 'gRomTable', kind: 'data' as const, shape: 'array' as const, elemSize: 2, size: 32, const: true }],
      ],
    ]);
    expect(judged(rom, indexed)).toEqual([['REG_DMA0CNT_H+12', 'const-target-store']]);
  });

  test('an earlier link of the walk is not written by a store through a later one', () => {
    const twoLinks = thumb(
      'walk',
      `	ldr	r1, .L3
	movs	r2, #1
	adds	r1, #12
	adds	r1, #12
	strh	r2, [r1]`,
      '.word	0x40000ba',
    );
    const rom: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gRomMid', const: true }]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(judged(rom, twoLinks)).toEqual([
      ['REG_DMA0CNT_H+12', null],
      ['REG_DMA0CNT_H+24', null],
    ]);
  });

  test('a const-declared cell the walk only READS is named — the refusal is about the store', () => {
    const readWalk = thumb(
      'walk',
      `	ldr	r1, .L3
	adds	r1, #12
	ldrh	r0, [r1]`,
      '.word	0x40000ba',
    );
    const rom: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gRomWord', const: true }]],
    ]);
    expect(judged(rom, readWalk)).toEqual([['REG_DMA0CNT_H+12', null]]);
  });
});

describe('the gates are load-bearing', () => {
  /** The pass with ONE named rule removed — the real predicate, on real input, no test-only
   *  branch in the shipped path. */
  const namedWithout = (id: string, symbols: SymbolMap, asm = WALK): string[] => {
    const fn = lift('walk', asm, symbols);
    nameOffsetAddresses(fn, symbols, without(OFFSET_NAME_GATES, id));
    return fn.blocks.flatMap((b) => b.ops.filter((op) => op.opcode === 'gaddr').map((op) => op.attrs.sym as string));
  };

  test('without `interior-offset` the walk names a cell inside the base object', () => {
    const big: SymbolMap = new Map([
      [0x040000ba, [{ name: 'gTable', kind: 'data' as const, shape: 'array' as const, size: 64, elemSize: 2 }]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(namedWithout('interior-offset', big)).toContain('REG_DMA1CNT_H');
  });

  // `base-unsized` is a COST gate, so this one records the spelling it costs rather than a guard.
  test('without `base-unsized` an unsized base is walked off as though it ended', () => {
    const unsized: SymbolMap = new Map([
      [0x040000ba, [{ name: 'gPalette', kind: 'data' as const, shape: 'array' as const, elemSize: 2 }]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(namedWithout('base-unsized', unsized)).toContain('REG_DMA1CNT_H');
  });

  test('without `base-address-ambiguous` a doubly-mapped name picks one of its addresses', () => {
    const twice: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x030000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(namedWithout('base-address-ambiguous', twice)).toContain('REG_DMA1CNT_H');
  });

  test('without `target-address-ambiguous` the walk spells one of two names at the address', () => {
    const aliased: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gDmaAlias' }, reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(namedWithout('target-address-ambiguous', aliased)).toContain('gDmaAlias');
  });

  test('without `target-is-code` the walk names a function', () => {
    // A walk that only carries the address out — a store through it would be refused by
    // `target-unsized` first, since a function symbol declares no access width.
    const handOut = thumb(
      'walk',
      `	ldr	r1, .L3
	adds	r1, #12
	adds	r0, r1, #0`,
      '.word	0x40000ba',
    );
    const code: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ name: 'DoTheThing', kind: 'code' as const }]],
    ]);
    expect(namedWithout('target-is-code', code, handOut)).toContain('DoTheThing');
  });

  test('without `base-is-code` an offset into a function becomes a data name', () => {
    const fromCode: SymbolMap = new Map([
      [0x040000ba, [{ name: 'DoTheThing', kind: 'code' as const, size: 4 }]],
      [0x040000c6, [reg('REG_DMA1CNT_H')]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(namedWithout('base-is-code', fromCode)).toContain('REG_DMA1CNT_H');
  });

  test('without `access-unlike-target` a halfword store onto a word-wide name becomes `str`', () => {
    const wide: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gWord', size: 4 }]],
    ]);
    expect(namedWithout('access-unlike-target', wide)).toContain('gWord');
  });

  test('without `target-unsized` a name-only neighbour is stored through at the guessed width', () => {
    const nameOnly: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ name: 'gNeighbour', kind: 'data' as const }]],
    ]);
    expect(namedWithout('target-unsized', nameOnly)).toContain('gNeighbour');
  });

  test('without `access-behind-merge` a word store behind a merge names a halfword cell', () => {
    expect(namedWithout('access-behind-merge', DMA, MERGED)).toContain('REG_DMA1CNT_H');
  });

  test('without `const-target-store` the store walks onto a const-declared name', () => {
    const rom: SymbolMap = new Map([
      [0x040000ba, [reg('REG_DMA0CNT_H')]],
      [0x040000c6, [{ ...reg('REG_DMA1CNT_H'), name: 'gRomWord', const: true }]],
      [0x040000d2, [reg('REG_DMA2CNT_H')]],
    ]);
    expect(namedWithout('const-target-store', rom)).toContain('gRomWord');
  });
});
