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
import { decompile, stampBehaviorsFor } from '../src/pipeline';
import { RaiseUnsupportedError } from '../src/raise/errors';
import {
  OFFSET_NAME_GATES,
  OFFSET_NAME_PASS,
  cellSpelledTwice,
  nameOffsetAddresses,
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
    // the map this repository vendored until the provider stopped joining a multi-address name's
    // DWARF shape: EWRAM `sUnknown` took berry_powder.c's 8-byte ROM `sUnknown[2]`, and the byte
    // was `((u8 *)&sUnknown)[5]` beside `sRandCount`
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

  test('a numeric address beside a name for the same byte declines', () => {
    // kleod's pointer-shaped `gUnk_030007C8` carries no size, so the byte stays a raw constant:
    // `gUnk_030007C8 = 5; *(u8 *)50333641 = 7; return gUnk_030007C8;`
    const unsized: SymbolMap = new Map([[0x030007c8, [{ name: 'gUnk_030007C8', kind: 'data' }]]]);
    expect(() => lifted(probe('0x030007c8', '0x030007c9'), unsized)).toThrow(
      /byte 0x30007c9 is reached as 'gUnk_030007C8' and as a numeric address/,
    );
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

  test('on MIPS, a walk the map names beside a numeric address declines where the compiler forwards', () => {
    // `addiu $at, $at, 4` off `D_80100000` is named `D_80100004` by this pass — asmlift's spelling
    const walked = mips('    /* 8 80000208 24210004 */  addiu      $at, $at, 4\n', '0', 5);
    expect(() => decompile('f', walked, MIPS_GCC, { symbols: twoWords })).toThrow(
      /byte 0x80100005 is reached as 'D_80100004' and as a numeric address/,
    );
    // …and lifts where it reloads: IDO 7.1 -O2 compiles the same C to `sw t6, 0(v1); sb t7,
    // 5(t8); jr ra; lw v0, 0(v1)`, whoever chose the name
    const ido = decompile('f', walked, MIPS_IDO, { symbols: twoWords }).source;
    expect(ido).toContain('D_80100004 = 5;');
    expect(ido).toContain('[5] = 7;');
    expect(ido).toContain('return D_80100004;');
  });

  test('a byte the ASM spells two ways lifts where the compiler reloads, and declines where it forwards', () => {
    // nothing here was read off the map. IDO 7.1 -O2 reloads the word (`sb t7, 1(t8); jr ra; lw
    // v0, 0(v1)`), so the source's own two spellings made this asm; gcc 2.7.2 compiles the same C
    // to `sb v0, -2146435071; jr ra; li v0, 5`, so an asm that reloads was not those two spellings
    const own = mips('', '0', 1);
    const ido = decompile('f', own, MIPS_IDO, { symbols: twoWords }).source;
    expect(ido).toContain('D_80100000 = 5;');
    expect(ido).toContain('[1] = 7;');
    expect(() => decompile('f', own, MIPS_GCC, { symbols: twoWords })).toThrow(
      /byte 0x80100001 is reached as 'D_80100000' and as a numeric address/,
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
    // a name and a raw constant through the same join: `v0 = (u8 *)50333641; *v0 = 7;`
    const unsized: SymbolMap = new Map([[0x030007c8, [{ name: 'gUnk_030007C8', kind: 'data' }]]]);
    expect(() => lifted(joined('0x030007c8', '0x030007c9', twoLoads, 'strb\tr3, [r2]'), unsized)).toThrow(
      /byte 0x30007c9 is reached as 'gUnk_030007C8' and as a numeric address/,
    );
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
    expect(() => lifted(rawSum, perAddress)).toThrow(
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
    expect(() => decompile('f', movedBack, MIPS_GCC, { symbols: twoWords })).toThrow(
      /byte 0x80100001 is reached as 'D_80100000' and as a numeric address/,
    );
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
