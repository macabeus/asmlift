// A NAME FOR AN ADDRESS THE MACHINE BUILT BY ARITHMETIC (raise/offsetnames.ts).
//
// The frontend asks the symbol map what lives at a POOL-LOADED word. A compiler with several
// neighbouring cells to touch loads one pool word and walks — `adds r1, #12` — so every cell after
// the first is reached by arithmetic and the map is never asked about it. This file pins the
// walk resolving to the name the map holds at that exact address, every refusal leaving the
// arithmetic the frontend emitted, the names the result publishes for what it reached that way,
// and the hand-wired seat — the pass has a record and no list, so nothing but a test says all
// three drivers still call it.
//
// The refusals carry the weight, because this changes the DEFAULT spelling rather than adding a
// candidate: naming a cell the map does not hold there is a silently wrong address with no second
// opinion.
import { describe, expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { without } from '../src/l3/gates';
import { decompile, offsetNameBehaviorsFor, stampBehaviorsFor } from '../src/pipeline';
import { RaiseUnsupportedError } from '../src/raise/errors';
import {
  NUMERIC_RESPELL_GATES,
  OFFSET_NAME_GATES,
  OFFSET_NAME_PASS,
  cellSpelledTwice,
  nameOffsetAddresses,
  numericRespellRefusals,
  offsetNameRefusals,
} from '../src/raise/offsetnames';
import { enumerateCandidates } from '../src/rank';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, TOOLCHAIN_TARGETS, targetFor } from '../src/target';
import { decompileTraced } from '../src/trace';

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

// THE SEAT IS HAND-WIRED, so this is what keeps the three copies in step. `OFFSET_NAME_PASS` is a
// record and not an entry in `PRE_RECOVERY_PASSES`, so nothing adds the pass to a driver that
// forgets it: delete the call in any one of the three and every other suite here stays green while
// that driver silently spells the walk as arithmetic.
test('every driver reaches the pass through its record', () => {
  const restore = OFFSET_NAME_PASS.run;
  const seen: string[] = [];
  const run = (label: string, f: () => unknown): void => {
    OFFSET_NAME_PASS.run = (fn, symbols, behaviors) => {
      seen.push(label);
      return restore(fn, symbols, behaviors);
    };
    try {
      f();
    } finally {
      OFFSET_NAME_PASS.run = restore;
    }
  };
  run('pipeline', () => decompile('walk', WALK, ARMV4T_AGBCC, { symbols: DMA }));
  run('trace', () =>
    decompileTraced('walk', WALK, targetFor('agbcc', TOOLCHAIN_TARGETS.agbcc.canonicalFlags), { symbols: DMA }),
  );
  run('rank', () => enumerateCandidates('walk', WALK, ARMV4T_AGBCC, { symbols: DMA }));
  expect(new Set(seen)).toEqual(new Set(['pipeline', 'trace', 'rank']));
});

describe('what the result says about it', () => {
  test('the walked-to names travel with the source', () => {
    expect(decompile('walk', WALK, ARMV4T_AGBCC, { symbols: DMA }).walkedNames).toEqual([
      'REG_DMA1CNT_H',
      'REG_DMA2CNT_H',
    ]);
  });

  test('a run with no symbol map walked to nothing', () => {
    expect(decompile('walk', WALK, ARMV4T_AGBCC, {}).walkedNames).toEqual([]);
  });

  test('a refused site is not reported as walked to', () => {
    const lone: SymbolMap = new Map([[0x040000ba, [reg('REG_DMA0CNT_H')]]]);
    expect(decompile('walk', WALK, ARMV4T_AGBCC, { symbols: lone }).walkedNames).toEqual([]);
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

  test('const-target-store — a store through a const-declared name violates the constraint', () => {
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
    nameOffsetAddresses(fn, symbols, stampBehaviorsFor(ARMV4T_AGBCC, undefined), without(OFFSET_NAME_GATES, id));
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
    // A walk that only carries the address out — with this rule removed a store through it would
    // be refused by `target-unsized` instead, since a function symbol declares no access width.
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

// ONE SPELLING PER CELL (`cellSpelledTwice`). Every probe stores 5 to a word, stores 7 to one of
// its bytes, and reads the word back, so the asm returns the 7 through memory. Spelled through two
// names — or a name and a numeric address — the C is two objects to the compiler, and agbcc
// (`-O2 -mthumb-interwork`) and gcc 2.7.2 compile the read to the forwarded `5`. Checked by
// compiling each shape quoted below.
describe('one spelling per cell', () => {
  const probe = (word: string, byte: string, byteStore = 'strb\tr0, [r2]'): string =>
    `f:\n\tldr\tr1, .L1\n\tldr\tr2, .L2\n\tmovs\tr0, #5\n\tstr\tr0, [r1]\n\tmovs\tr0, #7\n\t${byteStore}\n` +
    `\tldr\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\t${word}\n.L2:\n\t.word\t${byte}\n`;
  const lifted = (asm: string, symbols: SymbolMap): string => decompile('f', asm, ARMV4T_AGBCC, { symbols }).source;
  const sRandCount: SymbolInfo = {
    name: 'sRandCount',
    kind: 'data',
    size: 4,
    declared: true,
    shape: 'scalar',
    signed: false,
  };
  // pokeemerald EWRAM as vendored now: `sUnknown` is random.c's `static u8` at its own st_size
  const perAddress: SymbolMap = new Map([
    [0x020249bc, [{ name: 'sUnknown', kind: 'data', size: 1 }]],
    [0x020249c0, [sRandCount]],
  ]);

  test('a byte the map places inside one name is spelled through that name alone', () => {
    // agbcc: `strb r0, [r1, #0x1]; ldr r0, [r1]` — the read goes back to memory
    const out = lifted(probe('0x020249c0', '0x020249c1'), perAddress);
    expect(out).toContain('sRandCount');
    expect(out).not.toContain('sUnknown');
    expect(out).not.toMatch(/33704385|0x20249c1/i);
  });

  test('a map that lays one object over another declines the byte both cover', () => {
    // a map that joins a multi-address name's DWARF shape by name: EWRAM `sUnknown` takes
    // berry_powder.c's 8-byte ROM `sUnknown[2]`, and the byte is `((u8 *)&sUnknown)[5]` beside
    // `sRandCount`
    const overlapping: SymbolMap = new Map([
      [0x020249bc, [{ name: 'sUnknown', kind: 'data', size: 8, shape: 'array', elemSize: 4, dims: [2] }]],
      [0x020249c0, [sRandCount]],
    ]);
    expect(() => lifted(probe('0x020249c0', '0x020249c1'), overlapping)).toThrow(RaiseUnsupportedError);
    expect(() => lifted(probe('0x020249c0', '0x020249c1'), overlapping)).toThrow(
      /byte 0x20249c1 is reached as 'sRandCount' and as 'sUnknown'/,
    );
    // …but the overlap in the MAP is not the defect: a function reaching the cell one way lifts
    const single = 'f:\n\tldr\tr1, .L1\n\tldr\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\t0x020249c0\n';
    expect(lifted(single, overlapping)).toContain('return sRandCount;');
  });

  test('a displacement walked past the base object into its neighbour declines', () => {
    // `strb r0, [r1, #4]` off `sUnknown` (1 byte) lands on `sRandCount`; the walk gates refuse the
    // byte-wide name, and the arithmetic they leave spelled `((u8 *)&sUnknown)[4]` beside it
    for (const k of [4, 5]) {
      expect(() => lifted(probe('0x020249c0', '0x020249bc', `strb\tr0, [r2, #${k}]`), perAddress)).toThrow(
        new RegExp(`byte 0x${(0x020249c0 + k - 4).toString(16)} is reached as 'sRandCount' and as 'sUnknown'`),
      );
    }
  });

  test('a numeric address beside a name for the same byte is spelled through the name', () => {
    // kleod's pointer-shaped `gUnk_030007C8` carries no size, so the frontend leaves the byte a raw
    // constant, and as the lift reaches it the C would be `gUnk_030007C8 = 5; *(u8 *)50333641 = 7;
    // return gUnk_030007C8;` — which agbcc compiles to the forwarded `mov r0, #0x5`
    const unsized: SymbolMap = new Map([[0x030007c8, [{ name: 'gUnk_030007C8', kind: 'data' }]]]);
    expect(cellSpelledTwice(lift('f', probe('0x030007c8', '0x030007c9'), unsized), unsized)).toMatch(
      /byte 0x30007c9 is reached as 'gUnk_030007C8' and as a numeric address/,
    );
    // …so the byte is spelled through the name instead (respellNumericThroughName): one object,
    // which agbcc -O2 compiles to `str r0, [r1]; strb r0, [r1, #0x1]; ldr r0, [r1]`, the reload
    // the asm has
    const out = lifted(probe('0x030007c8', '0x030007c9'), unsized);
    expect(out).toContain('((u8 *)&gUnk_030007C8)[1] = 7;');
    expect(out).toContain('return *(s32 *)&gUnk_030007C8;');
    expect(out).not.toMatch(/50333641|0x30007c9/i);
  });

  test('two spellings that only READ the byte lift: there is no store to forward', () => {
    const unsized: SymbolMap = new Map([[0x030007c8, [{ name: 'gUnk_030007C8', kind: 'data' }]]]);
    const reads =
      'f:\n\tldr\tr1, .L1\n\tldr\tr2, .L2\n\tldr\tr0, [r1]\n\tldrb\tr3, [r2]\n\tadds\tr0, r0, r3\n\tbx\tlr\n' +
      '.L1:\n\t.word\t0x030007c8\n.L2:\n\t.word\t0x030007c9\n';
    expect(lifted(reads, unsized)).toContain('gUnk_030007C8');
  });

  // gcc 2.7.2 -O2 compiles `D_80100004 = 5; ((u8 *)0x80100000)[5] = 7; return D_80100004;` to
  // `sb v0, 5(at); jr ra; li v0, 5`; the literal is the negative constant the frontend builds.
  const mips = (walk: string, word: string, byteOff: number, moveByte = ''): string => `glabel f
    /* 0 80000200 3C010000 */  lui        $at, %hi(D_80100000)
    /* 4 80000204 24210000 */  addiu      $at, $at, %lo(D_80100000)
${walk}    /* C 8000020C 24080005 */  addiu      $t0, $zero, 5
    /* 10 80000210 AC280000 */  sw         $t0, ${word}($at)
    /* 14 80000214 3C098010 */  lui        $t1, 0x8010
${moveByte}    /* 18 80000218 240A0007 */  addiu      $t2, $zero, 7
    /* 1C 8000021C A12A0005 */  sb         $t2, ${byteOff}($t1)
    /* 20 80000220 8C220000 */  lw         $v0, ${word}($at)
    /* 24 80000224 03E00008 */  jr         $ra
    /* 28 80000228 00000000 */   nop
endlabel f
`;
  const twoWords: SymbolMap = new Map([
    [0x80100000, [{ name: 'D_80100000', kind: 'data', size: 4, shape: 'scalar' }]],
    [0x80100004, [{ name: 'D_80100004', kind: 'data', size: 4, shape: 'scalar', signed: true }]],
  ]);

  test('on MIPS, a numeric byte beside a walk the map names is spelled through that name', () => {
    // `addiu $at, $at, 4` off `D_80100000` is named `D_80100004` by this pass — asmlift's spelling
    // — and the numeric byte store inside it is spelled through it in turn: gcc 2.7.2 -O2 compiles
    // the two-spelling C to the forwarded `li v0, 5`, and one name to `sb v0, D+1; lw v0, D`
    const walked = mips('    /* 8 80000208 24210004 */  addiu      $at, $at, 4\n', '0', 5);
    const gcc = decompile('f', walked, MIPS_GCC, { symbols: twoWords }).source;
    expect(gcc).toContain('((u8 *)&D_80100004)[1] = 7;');
    expect(gcc).toContain('return *(s32 *)&D_80100004;');
    // …and lifts where it reloads: IDO 7.1 -O2 compiles the same C to `sw t6, 0(v1); sb t7,
    // 5(t8); jr ra; lw v0, 0(v1)`, whoever chose the name
    const ido = decompile('f', walked, MIPS_IDO, { symbols: twoWords }).source;
    expect(ido).toContain('D_80100004 = 5;');
    expect(ido).toContain('[5] = 7;');
    expect(ido).toContain('return D_80100004;');
  });

  test('a byte the ASM spells two ways lifts as-is where the compiler reloads, through one name where it forwards', () => {
    // nothing here was read off the map. IDO 7.1 -O2 reloads the word (`sb t7, 1(t8); jr ra; lw
    // v0, 0(v1)`), so the source's own two spellings made this asm; gcc 2.7.2 compiles the same C
    // to `sb v0, -2146435071; jr ra; li v0, 5`, so an asm that reloads was not those two spellings
    const own = mips('', '0', 1);
    const ido = decompile('f', own, MIPS_IDO, { symbols: twoWords }).source;
    expect(ido).toContain('D_80100000 = 5;');
    expect(ido).toContain('((u8 *)-2146435072)[1] = 7;');
    expect(cellSpelledTwice(frontendFor(MIPS_GCC).lift('f', own, MIPS_GCC, {}, undefined, twoWords), twoWords)).toMatch(
      /byte 0x80100001 is reached as 'D_80100000' and as a numeric address/,
    );
    // …and where it forwards the byte is spelled through the name: gcc 2.7.2 and KMC -O2 compile
    // `*(s32 *)&D_80100000 = 5; ((u8 *)&D_80100000)[1] = 7; return *(s32 *)&D_80100000;` to
    // `sw; sb v0, D_80100000+1; lw v0, D_80100000`, the reload the asm has
    const gcc = decompile('f', own, MIPS_GCC, { symbols: twoWords }).source;
    expect(gcc).toContain('((u8 *)&D_80100000)[1] = 7;');
    expect(gcc).toContain('return *(s32 *)&D_80100000;');
  });

  test('on IDO, a read placed BEFORE a store through another spelling declines: IDO sinks it past the store', () => {
    // IDO 7.1 -O2 compiles `v0 = D_80100004; ((u8 *)&D_80100000)[5] = 7; return v0;` (and the
    // `D_80100005 = 7;` form) to `sb t6, 5(at); jr ra; lw v0, 0(v1)`: the C returns the word with
    // byte 5 already 7, where this asm returns the word as it was before the store
    const loadFirst = (byteStore: string, head = ''): string => `glabel f
${head}    /* 0 80000200 3C010000 */  lui        $at, %hi(D_80100000)
    /* 4 80000204 24210000 */  addiu      $at, $at, %lo(D_80100000)
    /* 8 80000208 242B0004 */  addiu      $t3, $at, 4
    /* C 8000020C 8D620000 */  lw         $v0, 0($t3)
    /* 10 80000210 240A0007 */  addiu      $t2, $zero, 7
${byteStore}    /* 1C 8000021C 03E00008 */  jr         $ra
    /* 20 80000220 00000000 */   nop
endlabel f
`;
    const withByte: SymbolMap = new Map([
      ...twoWords,
      [0x80100005, [{ name: 'D_80100005', kind: 'data', size: 1, shape: 'scalar' }]],
    ]);
    const displaced = '    /* 14 80000214 A02A0005 */  sb         $t2, 5($at)\n';
    const named =
      '    /* 14 80000214 24290005 */  addiu      $t1, $at, 5\n    /* 18 80000218 A12A0000 */  sb         $t2, 0($t1)\n';
    for (const [store, spelled] of [
      [displaced, /byte 0x80100005 is reached as 'D_80100004' and as 'D_80100000'/],
      [named, /byte 0x80100005 is reached as 'D_80100004' and as 'D_80100005'/],
    ] as const) {
      expect(() => decompile('f', loadFirst(store), MIPS_IDO, { symbols: withByte })).toThrow(spelled);
      expect(() => decompile('f', loadFirst(store), MIPS_GCC, { symbols: withByte })).toThrow(RaiseUnsupportedError);
    }
    // the asm's own two relocations in that order are the same pair
    const ownLoadFirst = `glabel f
    /* 0 80000200 3C030000 */  lui        $v1, %hi(D_80100004)
    /* 4 80000204 8C620000 */  lw         $v0, %lo(D_80100004)($v1)
    /* 8 80000208 3C010000 */  lui        $at, %hi(D_80100005)
    /* C 8000020C 240A0007 */  addiu      $t2, $zero, 7
    /* 10 80000210 03E00008 */  jr         $ra
    /* 14 80000214 A02A0000 */   sb        $t2, %lo(D_80100005)($at)
endlabel f
`;
    expect(() => decompile('f', ownLoadFirst, MIPS_IDO, { symbols: withByte })).toThrow(
      /byte 0x80100005 is reached as 'D_80100004' and as 'D_80100005'/,
    );
  });

  // The address reaches the byte store through a JOIN, which the raising tower merges into the name
  // (or into a pointer local whose only base is it), and agbcc tracks the base across the join:
  // `sRandCount = 5; ((u8 *)&sUnknown)[5] = 7; return sRandCount;` and the `v0 = (u8 *)&sUnknown`
  // form both compile to `mov r0, #0x5`.
  const joined = (word: string, byte: string, arm: string, byteStore: string): string =>
    `f:\n\tldr\tr1, .L1\n\tmovs\tr3, #5\n\tstr\tr3, [r1]\n${arm}` +
    `.Lb:\n\tmovs\tr3, #7\n\t${byteStore}\n\tldr\tr0, [r1]\n\tbx\tlr\n` +
    `.L1:\n\t.word\t${word}\n.L2:\n\t.word\t${byte}\n`;
  const twoLoads = '\tcmp\tr0, #0\n\tbeq\t.La\n\tldr\tr2, .L2\n\tb\t.Lb\n.La:\n\tldr\tr2, .L2\n';
  const loadAndCopy = '\tldr\tr2, .L2\n\tcmp\tr0, #0\n\tbeq\t.Lb\n\tadds\tr2, #0\n';

  test('an address that reaches the access through a join is placed as the join spells it', () => {
    for (const arm of [twoLoads, loadAndCopy]) {
      expect(() => lifted(joined('0x020249c0', '0x020249bc', arm, 'strb\tr3, [r2, #5]'), perAddress)).toThrow(
        /byte 0x20249c1 is reached as 'sRandCount' and as 'sUnknown'/,
      );
    }
    // a name and a raw constant through the same join: `v0 = (u8 *)50333641; *v0 = 7;` — placed,
    // and then spelled through the name, the join's two loads of the one literal folding to it
    const unsized: SymbolMap = new Map([[0x030007c8, [{ name: 'gUnk_030007C8', kind: 'data' }]]]);
    const viaJoin = joined('0x030007c8', '0x030007c9', twoLoads, 'strb\tr3, [r2]');
    expect(cellSpelledTwice(lift('f', viaJoin, unsized), unsized)).toMatch(
      /byte 0x30007c9 is reached as 'gUnk_030007C8' and as a numeric address/,
    );
    expect(lifted(viaJoin, unsized)).not.toMatch(/50333641/);
    // …and a join that reaches nothing the word is spelled through lifts
    expect(lifted(joined('0x020249c0', '0x020249bc', twoLoads, 'strb\tr3, [r2]'), perAddress)).toContain(
      'sUnknown = 7;',
    );
  });

  test('a constant built in several steps is placed as the C compiler folds it', () => {
    // the index or displacement reaches the access as `add(add(c, c), …)`, `shl(c, #0)` or two
    // pool words summed, not as one `const`. The emitted C folds each (`((u8 *)&sUnknown)[5]`,
    // `*(u8 *)33704385`), and agbcc forwards the 5 past it (`strb r0, [r1]; mov r0, #0x5`)
    const head = '\tldr\tr3, .L1\n\tmovs\tr0, #5\n\tstr\tr0, [r3]\n';
    const tail = '\tldr\tr0, [r3]\n\tbx\tlr\n.L1:\n\t.word\t0x020249c0\n.L2:\n\t.word\t0x020249bc\n';
    const steps = '\tldr\tr1, .L2\n\tmovs\tr2, #2\n\tadds\tr2, #3\n\tmovs\tr0, #7\n';
    for (const [body, name] of [
      [`${steps}\tstrb\tr0, [r1, r2]\n`, 'an index of two adds'],
      [`${steps}\tadds\tr1, r1, r2\n\tstrb\tr0, [r1]\n`, 'a displacement of two adds'],
      ['\tldr\tr1, .L2\n\tmovs\tr2, #5\n\tlsls\tr2, r2, #0\n\tmovs\tr0, #7\n\tstrb\tr0, [r1, r2]\n', 'a shifted index'],
    ]) {
      expect(() => lifted(`f:\n${head}${body}${tail}`, perAddress), name).toThrow(
        /byte 0x20249c1 is reached as 'sRandCount' and as 'sUnknown'/,
      );
    }
    const rawSum =
      `f:\n${head}\tldr\tr1, .L2\n\tldr\tr2, .L3\n\tadds\tr1, r1, r2\n\tadds\tr1, #1\n\tmovs\tr0, #7\n` +
      '\tstrb\tr0, [r1]\n\tldr\tr0, [r3]\n\tbx\tlr\n' +
      '.L1:\n\t.word\t0x020249c0\n.L2:\n\t.word\t0x01000000\n.L3:\n\t.word\t0x010249c0\n';
    expect(cellSpelledTwice(lift('f', rawSum, perAddress), perAddress)).toMatch(
      /byte 0x20249c1 is reached as 'sRandCount' and as a numeric address/,
    );
    // gcc 2.7.2: a literal moved up and back down still names the byte the plain pin declines on
    const movedBack = mips(
      '',
      '0',
      1,
      '    /* 16 80000216 25290010 */  addiu      $t1, $t1, 0x10\n' +
        '    /* 17 80000217 2529FFF0 */  addiu      $t1, $t1, -0x10\n',
    );
    expect(
      cellSpelledTwice(frontendFor(MIPS_GCC).lift('f', movedBack, MIPS_GCC, {}, undefined, twoWords), twoWords),
    ).toMatch(/byte 0x80100001 is reached as 'D_80100000' and as a numeric address/);
  });

  test('one name read off the map at two of its addresses declines', () => {
    // two EWRAM file statics both called `sFiller`: `sFiller = 5; return sFiller;` would read back
    // the stored cell, where the asm reads the other one
    const filler: SymbolInfo = { name: 'sFiller', kind: 'data', size: 4, shape: 'scalar' };
    const twoStatics: SymbolMap = new Map([
      [0x02037344, [filler]],
      [0x02037fe0, [filler]],
    ]);
    const asm = (a: string, b: string): string =>
      `f:\n\tldr\tr1, .L1\n\tldr\tr2, .L2\n\tmovs\tr0, #5\n\tstr\tr0, [r1]\n\tldr\tr0, [r2]\n\tbx\tlr\n` +
      `.L1:\n\t.word\t${a}\n.L2:\n\t.word\t${b}\n`;
    expect(() => lifted(asm('0x02037344', '0x02037fe0'), twoStatics)).toThrow(
      /'sFiller' names two of the cells the map places it at/,
    );
    // the same one of the two, reached twice, is one object
    expect(lifted(asm('0x02037344', '0x02037344'), twoStatics)).toContain('return sFiller;');
  });

  test('an address-cast macro is a numeric spelling, so it shares a byte with a raw constant', () => {
    // `REG_W` expands to the literal it names: to the compiler both stores are numeric addresses
    const macro: SymbolMap = new Map([
      [0x040000b8, [{ name: 'REG_W', kind: 'data', size: 4, macroBody: '(*(vu32 *)0x40000b8)' }]],
    ]);
    const fn = lift('f', probe('0x040000b8', '0x040000b9'), macro);
    expect(fn.blocks.flatMap((b) => b.ops).some((op) => op.opcode === 'gaddr' && op.attrs.sym === 'REG_W')).toBe(true);
    expect(cellSpelledTwice(fn, macro)).toBeNull();
    // the same entry as an ordinary (unsized, so the byte stays raw) name is a second spelling
    const named: SymbolMap = new Map([[0x040000b8, [{ name: 'gW', kind: 'data' }]]]);
    expect(cellSpelledTwice(lift('f', probe('0x040000b8', '0x040000b9'), named), named)).toMatch(
      /'gW' and as a numeric address/,
    );
  });
});

// A NUMERIC ADDRESS THE SAME FUNCTION ALSO REACHES THROUGH A NAME (`respellNumericThroughName`).
// agbcc -O2 compiles `((u8 *)&g)[0x39]`, `(u8 *)&g + 0x39` and a held `u8 *p = &g.f39` to the
// relocated pool word `.word g+0x39`, and `g.f39` to `.word g` plus `add #0x39`; a disassembly that
// prints `name+offset` only inside a SIZED entry writes the first as a plain number beside the bare
// `g` (kl2dct's `.4byte 0x03005259` beside `gUnk_03005220`). Spelled through one name the C is one
// object, which every compiler here orders and reloads as memory requires — agbcc `g = 5; ((u8
// *)&g)[1] = 7; return g;` is `str; strb [r1, #1]; ldr r0, [r1]`, gcc 2.7.2 and KMC `sw; sb v0,
// g+1; lw v0, g` — where the two-spelling C is the forwarded 5 on all three.
describe('a numeric address the function also reaches through a name', () => {
  // agbcc -O2 -mthumb-interwork, verbatim, of `if (a != 0) { if (gUnk_03005220.f39 <= 0x14) h(a); }
  // else { ((u8 *)&gUnk_03005220)[0x39] = 1; }` (struct S { u32 w; u8 pad[0x35]; u8 f39; }), its
  // `.word gUnk_03005220+0x39` written as the number the ROM disassembly prints
  const E5 = (word = '0x3005259', store = 'strb\tr0, [r1]'): string =>
    'e5:\n\tpush\t{lr}\n\tadd\tr1, r0, #0\n\tcmp\tr1, #0\n\tbeq\t.L3\n\tldr\tr0, .L6\n\tadd\tr0, r0, #0x39\n' +
    '\tldrb\tr0, [r0]\n\tcmp\tr0, #0x14\n\tbhi\t.L5\n\tadd\tr0, r1, #0\n\tbl\th\n\tb\t.L5\n.L7:\n\t.align\t2, 0\n' +
    `.L6:\n\t.word\tgUnk_03005220\n.L3:\n\tldr\tr1, .L8\n\tmov\tr0, #0x1\n\t${store}\n.L5:\n\tpop\t{r0}\n\tbx\tr0\n` +
    `.L9:\n\t.align\t2, 0\n.L8:\n\t.word\t${word}\n`;
  const unsized: SymbolMap = new Map([[0x03005220, [{ name: 'gUnk_03005220', kind: 'data' }]]]);
  const h = { prototypes: { h: { params: 1, returnsVoid: true } } };
  const lifted = (asm: string, symbols: SymbolMap): string =>
    decompile('e5', asm, ARMV4T_AGBCC, { ...h, symbols }).source;
  const judged = (asm: string, symbols: SymbolMap) => [
    ...numericRespellRefusals(lift('e5', asm, symbols), symbols, offsetNameBehaviorsFor(ARMV4T_AGBCC, undefined)),
  ];

  test('the numeric pool word is spelled through the name the function walks to', () => {
    // the frontend keeps the word raw (the pool names `gUnk_03005220`), so as lifted the store and
    // the walked read are two spellings of byte 0x3005259
    expect(cellSpelledTwice(lift('e5', E5(), unsized), unsized)).toMatch(
      /byte 0x3005259 is reached as 'gUnk_03005220' and as a numeric address/,
    );
    expect(judged(E5(), unsized)).toEqual([['0x3005259', null]]);
    const out = lifted(E5(), unsized);
    expect(out).toContain('((u8 *)&gUnk_03005220)[57] = 1;');
    expect(out).not.toMatch(/50352729|0x3005259/i);
    // the name is reported as one a number was respelled through, and not as one walked to: no
    // arithmetic reached it, so its base address is not what to check
    const r = decompile('e5', E5(), ARMV4T_AGBCC, { ...h, symbols: unsized });
    expect(r.respelledNames).toEqual(['gUnk_03005220']);
    expect(r.walkedNames).toEqual([]);
  });

  test('the literal is spelled once where it also feeds a call', () => {
    // the asm loads ONE pool word for the store and the argument (`mov r0, r1; bl h`), and the C
    // spells it once so the compiler loads it once
    const asm = E5('0x3005259', 'strb\tr0, [r1]\n\tadd\tr0, r1, #0\n\tbl\th');
    const out = lifted(asm, unsized);
    expect(out).toContain('((u8 *)&gUnk_03005220)[57] = 1;');
    expect(out).toContain('h((u32)&gUnk_03005220 + 57)');
    expect(out).not.toMatch(/50352729/);
  });

  test('a sibling access off the literal is judged at its own bytes before the literal is renamed', () => {
    // agbcc -O2 of `u8 *p = (u8 *)0x03005259; p[0] = 1; p[4] = 1;`: one pool word for both stores.
    // Renaming the literal would spell p[4] through gUnk_03005220, past its size, in gNext's byte
    const sized: SymbolMap = new Map([
      [0x03005220, [{ name: 'gUnk_03005220', kind: 'data', size: 0x3c }]],
      [0x0300525c, [{ name: 'gNext', kind: 'data', size: 4 }]],
    ]);
    const out = lifted(E5('0x3005259', 'strb\tr0, [r1]\n\tstrb\tr0, [r1, #4]'), sized);
    expect(out).toContain('((u8 *)&gUnk_03005220)[57] = 1;');
    expect(out).not.toContain('((u8 *)&gUnk_03005220)[61]');
    expect(out).toContain('((u8 *)50352729)[4] = 1;');
    // a sibling inside the name still takes the literal path
    expect(lifted(E5('0x3005259', 'strb\tr0, [r1]\n\tstrb\tr0, [r1, #1]'), sized)).toContain(
      '((u8 *)&gUnk_03005220)[58] = 1;',
    );
    // a device-register store reached off the literal through a constant added to it
    // (`ldr r2, =0xffada7; add r1, r1, r2` lands on 0x04000000) keeps its numeric address
    const io = `${E5('0x3005259', 'strb\tr0, [r1]\n\tldr\tr2, .L8+4\n\tadd\tr1, r1, r2\n\tstrh\tr0, [r1]')}\t.word\t0xffada7\n`;
    const ioOut = lifted(io, unsized);
    expect(ioOut).toContain('((u8 *)&gUnk_03005220)[57] = 1;');
    expect(ioOut).toContain('*(u16 *)67108864 = 1;');
  });

  test('the accesses one literal reaches are judged against each other as renamed together', () => {
    // agbcc -O2 -mthumb-interwork, verbatim, of `s32 v0 = gUnk.f39; vu32 *p = (vu32 *)0x03005258;
    // *p = 5; ((vu16 *)p)[1] = 7; return v0 + *p;`. Renaming the one pool word spells the word
    // store, the u16 store and the word reload through gUnk together, which agbcc compiles to
    // `str; strh; add r0, r0, #0x5`: the reload forwarded past a store of another alias set
    const pun = (narrow: string): string =>
      'f:\n\tldr\tr0, .L3\n\tadd\tr0, r0, #0x39\n\tldrb\tr0, [r0]\n\tldr\tr2, .L3+0x4\n\tmov\tr1, #0x5\n' +
      `\tstr\tr1, [r2]\n\tmov\tr1, #0x7\n\t${narrow}\n\tldr\tr1, [r2]\n\tadd\tr0, r0, r1\n\tbx\tlr\n` +
      '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgUnk\n\t.word\t0x3005258\n';
    const g: SymbolMap = new Map([[0x03005220, [{ name: 'gUnk', kind: 'data' }]]]);
    expect(() => decompile('f', pun('strh\tr1, [r2, #0x2]'), ARMV4T_AGBCC, { symbols: g })).toThrow(
      /as a numeric address/,
    );
    // a byte store is char-wide, alias set 0, and two word casts the rewrite writes are one type,
    // so the three still take the name (that C through agbcc reloads: `strb; ldr r1, [r2, #0x38]`)
    const out = decompile('f', pun('strb\tr1, [r2, #0x2]'), ARMV4T_AGBCC, { symbols: g }).source;
    expect(out).toContain('((s32 *)&gUnk)[14] = 5;');
    expect(out).toContain('return v0 + ((s32 *)&gUnk)[14];');
    expect(out).not.toMatch(/50352728/);
  });

  test('two names over the byte decline', () => {
    // `gW`, the asm's own relocation, reads the word the byte sits in: a second name the walk does
    // not reach it by
    const asm = `${E5('0x3005259', 'strb\tr0, [r1]\n\tldr\tr2, .L8+4\n\tldr\tr0, [r2]')}\t.word\tgW\n`;
    const two: SymbolMap = new Map([...unsized, [0x03005258, [{ name: 'gW', kind: 'data' }]]]);
    expect(judged(asm, two)).toEqual([['0x3005259', 'two-names-reach-the-byte']]);
    expect(() => lifted(asm, two)).toThrow(RaiseUnsupportedError);
  });

  test('a byte the map gives another name declines', () => {
    const named: SymbolMap = new Map([...unsized, [0x03005259, [{ name: 'gFlag', kind: 'data', size: 1 }]]]);
    expect(judged(E5(), named)).toEqual([['0x3005259', 'map-names-another-object']]);
    expect(() => lifted(E5(), named)).toThrow(/byte 0x3005259 is reached as 'gUnk_03005220' and as a numeric address/);
  });

  test('a name the map places at two addresses declines', () => {
    const twice: SymbolMap = new Map([...unsized, [0x02000000, [{ name: 'gUnk_03005220', kind: 'data' }]]]);
    expect(judged(E5(), twice)).toEqual([['0x3005259', 'name-placed-at-several']]);
    expect(() => lifted(E5(), twice)).toThrow(RaiseUnsupportedError);
  });

  test('a store is not spelled through a const name', () => {
    const ro: SymbolMap = new Map([[0x03005220, [{ name: 'gUnk_03005220', kind: 'data', const: true }]]]);
    expect(judged(E5(), ro)).toEqual([['0x3005259', 'name-not-plain-data']]);
  });

  test('a byte past the name declared size declines', () => {
    const small: SymbolMap = new Map([[0x03005220, [{ name: 'gUnk_03005220', kind: 'data', size: 0x20 }]]]);
    expect(judged(E5(), small)).toEqual([['0x3005259', 'outside-the-name']]);
  });

  // the probe of `one spelling per cell`: a word stored and reloaded through the name, one cell of
  // it stored through a numeric address
  const probe = (byte: string, byteStore: string): string =>
    `f:\n\tldr\tr1, .L1\n\tldr\tr2, .L2\n\tmovs\tr0, #5\n\tstr\tr0, [r1]\n\tmovs\tr0, #7\n\t${byteStore}\n` +
    `\tldr\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\t0x030007c8\n.L2:\n\t.word\t${byte}\n`;
  const gUnk: SymbolMap = new Map([[0x030007c8, [{ name: 'gUnk_030007C8', kind: 'data' }]]]);
  /** The pass on the frontend's lift with one respell rule removed: the names it spelled. */
  const respelledWithout = (id: string, asm: string, symbols: SymbolMap): string[] =>
    nameOffsetAddresses(
      lift('f', asm, symbols),
      symbols,
      offsetNameBehaviorsFor(ARMV4T_AGBCC, undefined),
      OFFSET_NAME_GATES,
      without(NUMERIC_RESPELL_GATES, id),
    ).respelled;

  test('without `alias-sets-may-differ` a halfword store is respelled beside a word', () => {
    // agbcc -O2 compiles `*(s32 *)&g = 5; ((u16 *)&g)[1] = 7; return *(s32 *)&g;` to `str; strh
    // r1, [r0, #0x2]; mov r0, #0x5` — a u16 store is another alias set than the word, on one object
    const asm = probe('0x030007ca', 'strh\tr0, [r2]');
    expect(judged(asm.replace('f:', 'e5:'), gUnk)).toEqual([['0x30007ca', 'alias-sets-may-differ']]);
    expect(() => lifted(asm.replace('f:', 'e5:'), gUnk)).toThrow(/as a numeric address/);
    expect(respelledWithout('alias-sets-may-differ', asm, gUnk)).toEqual(['gUnk_030007C8']);
    // a byte store is char-wide, alias set 0, and is respelled
    expect(lifted(probe('0x030007ca', 'strb\tr0, [r2]').replace('f:', 'e5:'), gUnk)).toContain(
      '((u8 *)&gUnk_030007C8)[2] = 7;',
    );
  });

  test('without `device-or-volatile` a device register store is respelled through a name', () => {
    // a numeric store inside the GBA I/O window may be a `REG_*` macro's volatile access, which a
    // name the map holds there carries no qualifier for
    const io: SymbolMap = new Map([[0x04000200, [{ name: 'gIo', kind: 'data' }]]]);
    const asm = probe('0x04000201', 'strb\tr0, [r2]').replace('0x030007c8', '0x04000200');
    expect(judged(asm.replace('f:', 'e5:'), io)).toEqual([['0x4000201', 'device-or-volatile']]);
    expect(() => lifted(asm.replace('f:', 'e5:'), io)).toThrow(/as a numeric address/);
    expect(respelledWithout('device-or-volatile', asm, io)).toEqual(['gIo']);
  });

  test('without `not-one-literal-access` an access through a join of two literals is respelled', () => {
    // the store's address is `c ? 0x030007c9 : 0x030007ca`: two cells, and a respell to one of them
    // drops the other
    const asm =
      'f:\n\tldr\tr1, .L1\n\tmovs\tr3, #5\n\tstr\tr3, [r1]\n\tcmp\tr0, #0\n\tbeq\t.La\n\tldr\tr2, .L2\n\tb\t.Lb\n' +
      '.La:\n\tldr\tr2, .L3\n.Lb:\n\tmovs\tr3, #7\n\tstrb\tr3, [r2]\n\tldr\tr0, [r1]\n\tbx\tlr\n' +
      '.L1:\n\t.word\t0x030007c8\n.L2:\n\t.word\t0x030007c9\n.L3:\n\t.word\t0x030007ca\n';
    expect(judged(asm, gUnk).map(([, why]) => why)).toEqual(['not-one-literal-access']);
    expect(() => decompile('f', asm, ARMV4T_AGBCC, { symbols: gUnk })).toThrow(/as a numeric address/);
    expect(respelledWithout('not-one-literal-access', asm, gUnk)).toEqual(['gUnk_030007C8']);
  });

  test('on MIPS, the numeric byte of a named word is spelled through it on gcc 2.7.2', () => {
    // gcc 2.7.2 -O2, of `if (a) { if (g.f39 <= 0x14) h(a); } else { *(u8 *)0x80100039 = 1; }`
    // shaped by hand: the name read through `%lo`, the byte stored through `lui 0x8010`
    const asm = `glabel f
    /* 0 80000200 10800006 */  beqz       $a0, .L80000220
    /* 4 80000204 3C020000 */   lui       $v0, %hi(D_80100000)
    /* 8 80000208 90420039 */  lbu        $v0, %lo(D_80100000+0x39)($v0)
    /* C 8000020C 00000000 */  nop
    /* 10 80000210 2C420015 */  sltiu      $v0, $v0, 0x15
    /* 14 80000214 03E00008 */  jr         $ra
    /* 18 80000218 00000000 */   nop
    /* 1C 8000021C 00000000 */  nop
.L80000220:
    /* 20 80000220 3C038010 */  lui        $v1, 0x8010
    /* 24 80000224 24020001 */  addiu      $v0, $zero, 1
    /* 28 80000228 03E00008 */  jr         $ra
    /* 2C 8000022C A0620039 */   sb        $v0, 0x39($v1)
endlabel f
`;
    const d: SymbolMap = new Map([[0x80100000, [{ name: 'D_80100000', kind: 'data' }]]]);
    expect(cellSpelledTwice(frontendFor(MIPS_GCC).lift('f', asm, MIPS_GCC, {}, undefined, d), d)).toMatch(
      /byte 0x80100039 is reached as 'D_80100000' and as a numeric address/,
    );
    const out = decompile('f', asm, MIPS_GCC, { symbols: d }).source;
    expect(out).toContain('((u8 *)&D_80100000)[57] = 1;');
    expect(out).not.toMatch(/-2146435015|0x80100039/i);
  });
});
