// ARRAY SHAPE DERIVED FROM STRIDE EVIDENCE (raise/globalshape.ts) — the licence, and every
// refusal that keeps it from becoming a preference.
//
// Map-less, asmlift has always spelled an indexed global as `((T *)&gSym)[i]`. On agbcc the bare
// `gSym[i]` is a DIFFERENT object, because `build_array_ref` expands an array-typed object's base
// ahead of the subscript and every other base last — so the input assembly's own instruction
// order says which spelling the source wrote. This file pins that reading in both directions: the
// two functions below differ by NOTHING but the order of `ldr` and `lsl`, and they must reach
// different C.
//
// The refusals matter more than the admission, because deriving a shape changes the DEFAULT
// spelling rather than adding a candidate: a wrong derivation is a silently wrong answer with no
// second opinion.
import { describe, expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { without } from '../src/l3/gates';
import { decompile } from '../src/pipeline';
import {
  ADDRESS_GATES,
  ARRAY_SHAPE_GATES,
  DECLARATION_ADDRESS_GATES,
  ELEMENT_ADDRESS_GATES,
  ORDER_SHAPE_GATES,
  SHAPE_GATES,
  arrayShapeRefusals,
  inferGlobalArrays,
  orderLicensedGlobals,
  sameDerivedShape,
} from '../src/raise/globalshape';
import { enumerateCandidates } from '../src/rank';
import { type SymbolInfo, type SymbolMap, arrayInnerExtents } from '../src/symbols';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';

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

const lift = (name: string, asm: string) =>
  frontendFor(ARMV4T_AGBCC).lift(name, asm, ARMV4T_AGBCC, {}, undefined, undefined);

const derive = (name: string, asm: string) => inferGlobalArrays(lift(name, asm), ARMV4T_AGBCC);

/** The ORDER half alone — the names a value HOME may be spelled over (raise/globalshape.ts). */
const licensed = (name: string, asm: string) => orderLicensedGlobals(lift(name, asm), ARMV4T_AGBCC);

/** WHICH RULE decided, per symbol — `firstRejection` over the two gate tables. The refusals are
 *  DATA (raise/globalshape.ts's `ADDRESS_GATES` / `SHAPE_GATES`) precisely so a test can assert the
 *  attribution rather than a reviewer reading one off a comment. */
const refusals = (name: string, asm: string) => [...arrayShapeRefusals(lift(name, asm), ARMV4T_AGBCC)];

/** The same derivation with ONE named rule removed — the real predicate on real input, no
 *  test-only branch in the shipped path. This is what makes a gate's price a measurement: a guard
 *  that admits the same thing with and without it is a guard that is not doing the work its
 *  `guardedBy` claims. */
const deriveWithout = (id: string, name: string, asm: string) =>
  inferGlobalArrays(lift(name, asm), ARMV4T_AGBCC, {
    address: ARRAY_SHAPE_GATES.address.some((g) => g.id === id)
      ? without(ARRAY_SHAPE_GATES.address, id)
      : ARRAY_SHAPE_GATES.address,
    shape: ARRAY_SHAPE_GATES.shape.some((g) => g.id === id)
      ? without(ARRAY_SHAPE_GATES.shape, id)
      : ARRAY_SHAPE_GATES.shape,
  });

const sourceOf = (name: string, asm: string) => decompile(name, asm, ARMV4T_AGBCC, {}).source;

// ── the minimal pair: one instruction's ORDER, two spellings ─────────────────────────────────

// `extern u16 gTbl[]; return gTbl[i];`  — the pool word loads BEFORE the index is scaled
const BASE_FIRST = thumb('f', '	ldr	r1, .L3\n	lsl	r0, r0, #0x1\n	add	r0, r0, r1\n	ldrh	r0, [r0]', '.word	gTbl');
// `return ((u16 *)gTbl)[i];`           — the index is scaled BEFORE the pool word loads
const INDEX_FIRST = thumb('f', '	lsl	r0, r0, #0x1\n	ldr	r1, .L3\n	add	r0, r0, r1\n	ldrh	r0, [r0]', '.word	gTbl');

describe('the order of the pool load licenses the bare array subscript', () => {
  test('base-first: the shape is derived and the access spells `gTbl[i]`', () => {
    expect(derive('f', BASE_FIRST).get('gTbl')).toEqual({
      name: 'gTbl',
      kind: 'data',
      shape: 'array',
      elemSize: 2,
      elemSigned: false,
    });
    expect(sourceOf('f', BASE_FIRST)).toContain('gTbl[a0]');
    expect(sourceOf('f', BASE_FIRST)).not.toContain('&gTbl');
  });

  test('index-first: NOTHING is derived and the cast spelling stands', () => {
    // The over-fire control. A rule that read "zero relocation addend, therefore base-first"
    // would fire here and emit a source that does not reproduce this assembly.
    expect(derive('f', INDEX_FIRST).size).toBe(0);
    expect(sourceOf('f', INDEX_FIRST)).toContain('((u16 *)&gTbl)[a0]');
  });

  test('one index-first access refuses a symbol the others license', () => {
    // WHY THE ORDER RULE IS ASKED OF EVERY ACCESS AND NOT JUST OF THE FIRST. agbcc CSEs the pool
    // word, so a function that subscripts one name twice has ONE `gaddr` and the second access is
    // ordered against the same load. Compiled through the benchmark's own agbcc command:
    //
    //   gTbl[i] + gTbl[j]                        \  the same object (md5 e5521e36…): a bare
    //   gTbl[i] + ((u16 *)gTbl)[j]               /   subscript here would be right either way
    //   ((u16 *)gTbl)[i] + ((u16 *)gTbl)[j]          a DIFFERENT object (md5 0c8ba2e7…)
    //
    // and only the third moves the first access's `lsl` ahead of the `ldr`. So the licence is
    // decided by the earliest scaling, and one index-first access refuses the whole symbol — even
    // though the LATER access is base-first and would satisfy `no-positive-evidence` on its own.
    // That second access is exactly what makes this rule uniquely load-bearing.
    const mixedOrder = thumb(
      'f',
      '\tlsl\tr0, r0, #0x1\n\tldr\tr2, .L3\n\tadd\tr0, r0, r2\n\tldrh\tr0, [r0]\n\tlsl\tr1, r1, #0x1\n' +
        '\tadd\tr1, r1, r2\n\tldrh\tr1, [r1]\n\tadd\tr0, r0, r1',
      '.word\tgTbl',
    );
    expect(refusals('f', mixedOrder)).toEqual([['gTbl', 'index-materialized-first']]);
    expect(derive('f', mixedOrder).size).toBe(0);
    expect(deriveWithout('index-materialized-first', 'f', mixedOrder).size).toBe(1);
  });

  test('the two lift to DIFFERENT IR and would otherwise recover to the same', () => {
    // Why the derivation has to run on the lifted fn: array legalization (`recognizeArrays`,
    // raise/arrays.ts, pre-recovery's `arrays` step — not the idiom fold) turns both into the
    // same `aload`, so anything downstream of it cannot tell them apart.
    const a = decompile('f', BASE_FIRST, ARMV4T_AGBCC, {});
    const b = decompile('f', INDEX_FIRST, ARMV4T_AGBCC, {});
    expect(a.ir.raw).not.toEqual(b.ir.raw);
    expect(a.ir.recovered).toEqual(b.ir.recovered);
  });
});

// ── the constant term: which SIDE of the address it sits on ──────────────────────────────────

// `extern u8 gTbl[]; return gTbl[i + 1];` — a bare `.word gTbl` plus a RUNTIME add. At width 1
// there is no scaling to order against, so the constant is the only evidence there is.
const CONST_ON_INDEX = thumb('f', '	ldr	r1, .L3\n	add	r0, r0, #0x1\n	add	r0, r0, r1\n	ldrb	r0, [r0]', '.word	gTbl');
// `const u8 *p = &gTbl[1]; return p[i];` — the constant is in the RELOCATION ADDEND instead.
const CONST_IN_ADDEND = thumb('f', '	ldr	r1, .L3\n	add	r0, r0, r1\n	ldrb	r0, [r0]', '.word	gTbl+0x1');

describe('a constant on the INDEX licenses it; a constant in the ADDEND refuses', () => {
  test('runtime add against a bare pool word: `gTbl[a0 + 1]`', () => {
    // agbcc folds a constant added to any pointer or cast base into the pool word, so a runtime
    // add against an un-addended word is a shape only the array subscript produces.
    expect(derive('f', CONST_ON_INDEX).get('gTbl')?.elemSize).toBe(1);
    expect(sourceOf('f', CONST_ON_INDEX)).toContain('gTbl[a0 + 1]');
  });

  test('a non-zero relocation addend refuses the symbol outright', () => {
    // The other over-fire control, and the one the frontend makes structural: `.word gTbl+0x1`
    // lifts as an explicit `add(gaddr, const)`. Spelling THIS as `gTbl[a0 + 1]` reproduces the
    // OTHER target's bytes — one symbol, two opposite right answers.
    expect(derive('f', CONST_IN_ADDEND).size).toBe(0);
    expect(sourceOf('f', CONST_IN_ADDEND)).not.toContain('gTbl[');
  });
});

// ── the declared rank ────────────────────────────────────────────────────────────────────────

// `extern s32 gPtrTbl[][2]; return gPtrTbl[i][j];` — two SEPARATE scales, 8 and 4
const RANK2 = thumb(
  'f',
  '	ldr	r2, .L3\n	lsl	r1, r1, #0x2\n	lsl	r0, r0, #0x3\n	add	r1, r1, r0\n	add	r1, r1, r2\n	ldr	r0, [r1]',
  '.word	gPtrTbl',
);

describe('nested strides recover the declared rank, and ship WITH the element half', () => {
  test('two strides give `dims` and the access spells `gPtrTbl[a0][a1]`', () => {
    expect(derive('f', RANK2).get('gPtrTbl')).toEqual({
      name: 'gPtrTbl',
      kind: 'data',
      shape: 'array',
      elemSize: 4,
      elemSigned: true,
      dims: [null, 2],
    });
    expect(sourceOf('f', RANK2)).toContain('gPtrTbl[a0][a1]');
  });

  test('a shape is minted with EVERY dimension or not at all', () => {
    // The additivity rule, as a property rather than as a comment: the element half alone over a
    // multidimensional array spells a FLAT subscript, which is a different object from the
    // declared-rank one and measures worse than the cast form it would replace. So a derived
    // rank-1 shape may never carry a second stride.
    const si = derive('f', RANK2).get('gPtrTbl')!;
    expect(si.dims?.length).toBe(2);
  });

  test('strides that do not nest refuse: an extent of 1 is indistinguishable', () => {
    // `lsl #0x2` twice — two terms at the SAME stride is rank 1 with a summed index, and a
    // stride equal to the one below it would make two positions name one cell.
    const flat = thumb(
      'f',
      '	ldr	r2, .L3\n	lsl	r1, r1, #0x2\n	lsl	r0, r0, #0x2\n	add	r1, r1, r0\n	add	r1, r1, r2\n	ldr	r0, [r1]',
      '.word	gPtrTbl',
    );
    expect(derive('f', flat).get('gPtrTbl')?.dims).toBeUndefined();
  });

  test('a stride that is not a whole multiple of the element refuses entirely', () => {
    // element 4, outer stride 6: no C declaration produces that pair, so nothing is claimed.
    const odd = thumb(
      'f',
      '	ldr	r2, .L3\n	lsl	r1, r1, #0x2\n	mov	r3, #0x6\n	mul	r0, r3\n	add	r1, r1, r0\n	add	r1, r1, r2\n	ldr	r0, [r1]',
      '.word	gPtrTbl',
    );
    expect(derive('f', odd).size).toBe(0);
  });
});

// ── the refusals, each attributed to the rule that decided ───────────────────────────────────
//
// ONE FIXTURE PER GATE, in one table, so the per-rule tests below and the whole-table measurement
// at the end cannot drift apart. Every test does two things: it asserts which rule FIRST rejected
// (`arrayShapeRefusals`, off the tables' own `firstRejection`), and — where that rule is the only
// thing standing between the fixture and a derivation — it ablates that one rule and shows the
// derivation then admits.
//
// Two of these are the kind of attribution only a measurement settles, and both are asserted
// below rather than described: `interior-or-non-access` — not the element-stride rule one step
// later — is what decides the `bgarr` shape, and `relocation-addend` fires first on `arrbias`
// while deciding nothing (`no-subscript` refuses the same symbol without it).
const GATE_FIXTURES: readonly (readonly [string, string])[] = [
  [
    // A declaration is per SYMBOL, not per access: one use this spelling does not model and the
    // name keeps the cast form everywhere.
    'address-escapes',
    `\t.code\t16
.text
\t.align\t2, 0
\t.globl\tf
\t.type\t f,function
\t.thumb_func
f:
\tpush\t{r4, lr}
\tldr\tr4, .L3
\tlsl\tr0, r0, #0x1
\tadd\tr0, r0, r4
\tldrh\tr0, [r0]
\tmov\tr0, r4
\tbl\tsink
\tpop\t{r4}
\tpop\t{r1}
\tbx\tr1
.L4:
\t.align\t2, 0
.L3:
\t.word\tgTbl
.Lfe1:
\t.size\t f,.Lfe1-f
`,
  ],
  // The `arrbias` control: the constant lives in the pool word, not on the index.
  ['relocation-addend', CONST_IN_ADDEND],
  // `i * 4 - i` is a stride of 3 spelled as a difference. Opening the `sub` would make each term's
  // sign depend on the walk, and a negative stride is not a subscript this spelling has.
  [
    'residual-not-a-sum',
    thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr1, r0, #0x2\n\tsub\tr1, r1, r0\n\tadd\tr1, r1, r2\n\tldrh\tr0, [r1]',
      '.word\tgTbl',
    ),
  ],
  // ONE INTERIOR READ REFUSES THE WHOLE SYMBOL, and the fixture has to carry a clean access
  // alongside it or the rule looks unnecessary: with an interior read alone, ablating the rule
  // records no access at all (an interior read is not evidence) and the symbol is refused anyway.
  // With a clean access beside it, ablating derives `elemSize 2` off a name the function also
  // reads at +4 — the wrong declaration. `kleod:UpdateCameraScroll` is that shape on the corpus.
  [
    'interior-or-non-access',
    thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr0, r0, #0x1\n\tadd\tr0, r0, r2\n\tldrh\tr0, [r0]\n\tlsl\tr1, r1, #0x1\n' +
        '\tadd\tr1, r1, r2\n\tldrh\tr1, [r1, #0x4]\n\tadd\tr0, r0, r1',
      '.word\tgTbl',
    ),
  ],
  [
    'mixed-access-width',
    thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr1, r0, #0x1\n\tadd\tr1, r1, r2\n\tldrh\tr1, [r1]\n\tlsl\tr0, r0, #0x2\n' +
        '\tadd\tr0, r0, r2\n\tldr\tr0, [r0]\n\tadd\tr0, r0, r1',
      '.word\tgTbl',
    ),
  ],
  // The bare spelling carries no cast, so the declared element type is the only thing in the
  // emitted C saying how a sub-word read fills — and this name is read both ways. The
  // register-offset form is not decoration: Thumb has no immediate-offset `ldrsh`, so the signed
  // narrow load's address IS the base add. Spelled with a separate index register the load's
  // operand is a second `add` and `interior-or-non-access` refuses one rule earlier, which is why
  // this gate first-rejects on none of the 359 benchmark target functions that lift.
  [
    'mixed-extension',
    thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr1, r0, #0x1\n\tadd\tr1, r1, r2\n\tldrh\tr1, [r1]\n\tlsl\tr0, r0, #0x1\n' +
        '\tldrsh\tr0, [r0, r2]\n\tadd\tr0, r0, r1',
      '.word\tgTbl',
    ),
  ],
  // `&gTbl + 4` reached through a scaled CONSTANT rather than through the relocation addend: there
  // is no subscript here to be right or wrong about.
  [
    'no-subscript',
    thumb(
      'f',
      '\tmov\tr0, #0x2\n\tlsl\tr0, r0, #0x1\n\tldr\tr1, .L3\n\tadd\tr0, r0, r1\n\tldrh\tr0, [r0]',
      '.word\tgTbl',
    ),
  ],
  // Base-first, `off=0`, one clean stride — and the stride is 4 where the load reads 2. This is
  // the shape the element-stride rule is actually for; nothing else in either table rejects it.
  [
    'stride-is-not-the-element',
    thumb('f', '\tldr\tr1, .L3\n\tlsl\tr0, r0, #0x2\n\tadd\tr0, r0, r1\n\tldrh\tr0, [r0]', '.word\tgTbl'),
  ],
  // element 4, outer stride 6: no C declaration produces that pair, so nothing is claimed.
  [
    'strides-do-not-nest',
    thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr1, r1, #0x2\n\tmov\tr3, #0x6\n\tmul\tr0, r3\n\tadd\tr1, r1, r0\n\tadd\tr1, r1, r2\n\tldr\tr0, [r1]',
      '.word\tgTbl',
    ),
  ],
  // One address at stride 4, one nesting 4 into 8. Unioning the strides ACROSS accesses would
  // declare `extern s32 gTbl[][2]` off a table nothing says is two-dimensional, and spell
  // `gTbl[0][i]` — which stops compiling against the project's own header.
  [
    'ranks-disagree',
    thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr0, r0, #0x2\n\tlsl\tr1, r1, #0x3\n\tadd\tr3, r1, r0\n\tadd\tr3, r3, r2\n' +
        '\tldr\tr3, [r3]\n\tadd\tr0, r0, r2\n\tldr\tr0, [r0]\n\tadd\tr0, r3, r0',
      '.word\tgTbl',
    ),
  ],
  // width 2 with `+ 1` on the index: a mid-element displacement, which no subscript spells.
  [
    'mid-element-constant',
    thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr0, r0, #0x1\n\tadd\tr0, r0, #0x1\n\tadd\tr0, r0, r2\n\tldrh\tr0, [r0]',
      '.word\tgTbl',
    ),
  ],
  // WHY THE ORDER RULE IS ASKED OF EVERY ACCESS AND NOT JUST OF THE FIRST. agbcc CSEs the pool
  // word, so a function that subscripts one name twice has ONE `gaddr` and both accesses are
  // ordered against the same load. Compiled through the benchmark's own agbcc command:
  //
  //   gTbl[i] + gTbl[j]                      \  the SAME object (md5 e5521e36…), so a bare
  //   gTbl[i] + ((u16 *)gTbl)[j]             /  subscript would be right either way
  //   ((u16 *)gTbl)[i] + ((u16 *)gTbl)[j]       a DIFFERENT object (md5 0c8ba2e7…)
  //
  // and only the third moves a `lsl` ahead of the `ldr`. So the licence is decided by the earliest
  // scaling, one index-first access refuses the whole symbol, and the SECOND (base-first) access
  // here is what makes this rule uniquely load-bearing — alone, `no-positive-evidence` would have
  // refused anyway.
  [
    'index-materialized-first',
    thumb(
      'f',
      '\tlsl\tr0, r0, #0x1\n\tldr\tr2, .L3\n\tadd\tr0, r0, r2\n\tldrh\tr0, [r0]\n\tlsl\tr1, r1, #0x1\n' +
        '\tadd\tr1, r1, r2\n\tldrh\tr1, [r1]\n\tadd\tr0, r0, r1',
      '.word\tgTbl',
    ),
  ],
  // Both spellings are byte-identical at width 1 with no constant, so there is nothing to win and
  // a derivation would be a guess. It stays the cast form.
  ['no-positive-evidence', thumb('f', '\tldr\tr1, .L3\n\tadd\tr0, r0, r1\n\tldrb\tr0, [r0]', '.word\tgTbl')],
];

const fixture = (id: string): string => GATE_FIXTURES.find(([g]) => g === id)![1];

describe('refusals: which rule decided, and what it is worth', () => {
  test.each(GATE_FIXTURES.map(([id]) => id))('%s is the rule that first rejects its own fixture', (id) => {
    const sym = fixture(id).includes('gBgInfo') ? 'gBgInfo' : 'gTbl';
    expect(refusals('f', fixture(id))).toEqual([[sym, id]]);
    expect(derive('f', fixture(id)).size).toBe(0);
  });

  test('an element read at a displacement INSIDE it keeps the cast spelling', () => {
    // The refusal's OUTPUT, not just its verdict: every rejection falls back to a form that is
    // byte-identical under any declaration. On the `bgarr` shape — a 28-byte element read 2 bytes
    // at a time (`gBgInfo[i].hLength`) — where a flat 16-bit subscript would be out of bounds
    // against the project's own header.
    const structElem = thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr1, r0, #0x3\n\tsub\tr1, r1, r0\n\tlsl\tr1, r1, #0x2\n\tadd\tr1, r1, r2\n\tldrh\tr0, [r1, #0x10]',
      '.word\tgBgInfo',
    );
    expect(refusals('f', structElem)).toEqual([['gBgInfo', 'interior-or-non-access']]);
    expect(derive('f', structElem).size).toBe(0);
    expect(sourceOf('f', structElem)).toContain('&gBgInfo');
  });

  test('two access widths under one name refuse', () => {
    expect(refusals('f', fixture('mixed-access-width'))).toEqual([['gTbl', 'mixed-access-width']]);
  });

  test('one name read signed and unsigned refuses', () => {
    expect(refusals('f', fixture('mixed-extension'))).toEqual([['gTbl', 'mixed-extension']]);
  });

  test('an access with no variable term refuses', () => {
    expect(refusals('f', fixture('no-subscript'))).toEqual([['gTbl', 'no-subscript']]);
  });

  test('a subtracted term in the residual refuses', () => {
    expect(refusals('f', fixture('residual-not-a-sum'))).toEqual([['gTbl', 'residual-not-a-sum']]);
  });

  test('an index pre-scaled past the element refuses', () => {
    expect(refusals('f', fixture('stride-is-not-the-element'))).toEqual([['gTbl', 'stride-is-not-the-element']]);
  });

  test('a constant that is not a whole element refuses', () => {
    expect(refusals('f', fixture('mid-element-constant'))).toEqual([['gTbl', 'mid-element-constant']]);
  });

  test('two accesses at different strides are not a rank', () => {
    // Ablated, the derivation takes the FIRST access's rank and publishes it for the name: a
    // `extern s32 gTbl[][2];` in the `[declared]` block off a table whose second access strides by
    // one element. The addresses still come out right — what is fabricated is the CLAIM about the
    // object, which is the half a project user compiling against their own header pays for.
    expect(deriveWithout('ranks-disagree', 'f', fixture('ranks-disagree')).get('gTbl')?.dims).toEqual([null, 2]);
  });

  test('one index-first access refuses a symbol the others license', () => {
    expect(refusals('f', fixture('index-materialized-first'))).toEqual([['gTbl', 'index-materialized-first']]);
  });

  test('the address escaping to a callee refuses the whole symbol', () => {
    expect(refusals('f', fixture('address-escapes'))).toEqual([['gTbl', 'address-escapes']]);
  });

  test('no evidence at all — width 1, no constant — claims nothing', () => {
    expect(refusals('f', fixture('no-positive-evidence'))).toEqual([['gTbl', 'no-positive-evidence']]);
  });
});

// ── a scaling in ANOTHER block is not evidence, in either direction ───────────────────────────
//
// The order licence can only read a scaling the pool load can be COMPARED to, and across a block
// boundary it cannot: agbcc CSEs the pool `ldr` and places it at the dominator of its uses, so a
// loop whose only subscript is in the body has the load in the preheader whatever the source
// wrote. Compiled through the benchmark's own agbcc command, LOOP_ONLY below is what BOTH of
//
//     for (i = 0; i < n; i++) s += gTbl[p[i]];
//     for (i = 0; i < n; i++) s += ((u16 *)gTbl)[p[i]];
//
// compile to — ONE object, byte-identical `.s` included. Recording that as `false` (the positive
// claim "the index was scaled first") is how this rule came to be the FIRST rejection of four
// corpus symbols whose base is materialized first: `kleod:CopyBGScrollTiles`,
// `kleod:SetupBG3WindowOverlay`, `sa3:VramGetTotalAllocatedTiles`, `sa3:VramMalloc`. All four now
// route to `no-positive-evidence`, which is what "this says nothing" is called; the derived map
// over the whole corpus is unchanged either way (9 shapes over 359 functions).
//
// MIX_* are the real agbcc output for one function that subscripts the name ONCE OUTSIDE the loop
// and once inside it. Those two ARE different objects, the difference is at the access outside,
// and scored against each other's targets the two spellings are 7 vs 9 in both directions — so
// the discrimination this rule exists for lives entirely in the same-block accesses and is
// untouched by the narrowing.
const LOOP_ONLY = `	.code	16
.text
	.align	2, 0
	.globl	pureloop
	.type	 pureloop,function
	.thumb_func
pureloop:
	push	{r4, lr}
	mov	r3, #0x0
	cmp	r3, r0
	bge	.L4	@cond_branch
	ldr	r4, .L8
	add	r2, r0, #0
.L6:
	ldmia	r1!, {r0}
	lsl	r0, r0, #0x1
	add	r0, r0, r4
	ldrh	r0, [r0]
	add	r3, r3, r0
	sub	r2, r2, #0x1
	cmp	r2, #0
	bne	.L6	@cond_branch
.L4:
	add	r0, r3, #0
	pop	{r4}
	pop	{r1}
	bx	r1
.L9:
	.align	2, 0
.L8:
	.word	gTbl
.Lfe1:
	.size	 pureloop,.Lfe1-pureloop
`;

/** `s = gTbl[k]; for (...) s += gTbl[p[i]];` — the pool load precedes the outside access's `lsl`
 *  in its own block, and the loop body's `lsl` is in another. */
const MIX_ARRAY = `	.code	16
.text
	.align	2, 0
	.globl	mix
	.type	 mix,function
	.thumb_func
mix:
	push	{r4, lr}
	ldr	r4, .L8
	lsl	r0, r0, #0x1
	add	r0, r0, r4
	ldrh	r3, [r0]
	cmp	r1, #0
	ble	.L4	@cond_branch
.L6:
	ldmia	r2!, {r0}
	lsl	r0, r0, #0x1
	add	r0, r0, r4
	ldrh	r0, [r0]
	add	r3, r3, r0
	sub	r1, r1, #0x1
	cmp	r1, #0
	bne	.L6	@cond_branch
.L4:
	add	r0, r3, #0
	pop	{r4}
	pop	{r1}
	bx	r1
.L9:
	.align	2, 0
.L8:
	.word	gTbl
.Lfe1:
	.size	 mix,.Lfe1-mix
`;

/** The same function with both accesses cast-spelled: the outside access scales BEFORE the pool
 *  load, in the same block. That is the observable difference, and it is the one that must refuse. */
const MIX_CAST = `	.code	16
.text
	.align	2, 0
	.globl	mix
	.type	 mix,function
	.thumb_func
mix:
	push	{r4, r5, lr}
	add	r4, r2, #0
	lsl	r0, r0, #0x1
	ldr	r2, .L8
	add	r0, r0, r2
	ldrh	r3, [r0]
	cmp	r1, #0
	ble	.L4	@cond_branch
	add	r5, r2, #0
	add	r2, r4, #0
.L6:
	ldmia	r2!, {r0}
	lsl	r0, r0, #0x1
	add	r0, r0, r5
	ldrh	r0, [r0]
	add	r3, r3, r0
	sub	r1, r1, #0x1
	cmp	r1, #0
	bne	.L6	@cond_branch
.L4:
	add	r0, r3, #0
	pop	{r4, r5}
	pop	{r1}
	bx	r1
.L9:
	.align	2, 0
.L8:
	.word	gTbl
.Lfe1:
	.size	 mix,.Lfe1-mix
`;

describe('the order licence reads only what it can compare', () => {
  test('a loop-only subscript says NOTHING, and says so under the right name', () => {
    // Not `index-materialized-first`: the base IS materialized first here, in an earlier block.
    // The honest verdict is that the two spellings are one object, so there is no evidence.
    expect(refusals('pureloop', LOOP_ONLY)).toEqual([['gTbl', 'no-positive-evidence']]);
    expect(derive('pureloop', LOOP_ONLY).size).toBe(0);
    expect(sourceOf('pureloop', LOOP_ONLY)).toContain('&gTbl');
  });

  test('one comparable base-first access licenses the symbol its loop body cannot speak for', () => {
    expect(refusals('mix', MIX_ARRAY)).toEqual([['gTbl', null]]);
    expect(derive('mix', MIX_ARRAY).get('gTbl')).toEqual({
      name: 'gTbl',
      kind: 'data',
      shape: 'array',
      elemSize: 2,
      elemSigned: false,
    });
    // both accesses take the bare form — the loop body's evidences nothing, and a declaration is
    // per SYMBOL, so a name licensed once is spelled bare everywhere it is reached
    expect(sourceOf('mix', MIX_ARRAY)).not.toContain('&gTbl');
  });

  test('…and the same function cast-spelled still refuses, on the access that CAN be compared', () => {
    expect(refusals('mix', MIX_CAST)).toEqual([['gTbl', 'index-materialized-first']]);
    expect(derive('mix', MIX_CAST).size).toBe(0);
  });
});

// ── which refusals actually DECIDE, as a committed measurement ────────────────────────────────
//
// The header's list of refusals is prose; this is the part a reviewer can check. For each rule:
// remove that ONE rule from the table and re-run the real derivation on the real fixture. Four are
// ATTRIBUTING — right about their shape, first because they name the real cause, subsumed by a
// later rule if removed — and nine are the only thing standing between their fixture and a
// derivation. `sound` records exactly that split, so the classification is re-measured on every
// run rather than asserted once in a comment.
//
// THE FIXTURE IS PART OF THE CLAIM, and `interior-or-non-access` is the worked example: its
// fixture has to carry a CLEAN access beside the interior one, because with the interior read
// alone removing the rule records no access and the symbol is refused anyway — a weaker question
// than the corpus asks, where `kleod:UpdateCameraScroll` derives an element type without the rule.
// A gate that measures as subsumed may simply have the wrong input.

describe('every gate: which rule decides, and whether it is uniquely load-bearing', () => {
  test('`sound` says exactly which rules nothing else would have caught', () => {
    const gates = [...ARRAY_SHAPE_GATES.address, ...ARRAY_SHAPE_GATES.shape];
    const measured = GATE_FIXTURES.map(([id, asm]) => [id, deriveWithout(id, 'f', asm).size > 0]);
    expect(measured).toEqual(GATE_FIXTURES.map(([id]) => [id, gates.find((g) => g.id === id)!.sound]));
    // …and the split is not degenerate in either direction
    expect(measured.filter(([, u]) => u === true).length).toBe(9);
    expect(measured.filter(([, u]) => u === false).length).toBe(4);
  });

  test('every gate in both tables has a fixture here', () => {
    // A rule with no reaching input is a rule nothing has shown to be about anything. The one
    // exception is stated rather than skipped.
    const covered = new Set(GATE_FIXTURES.map(([id]) => id));
    const missing = [...ARRAY_SHAPE_GATES.address, ...ARRAY_SHAPE_GATES.shape]
      .map((g) => g.id)
      .filter((id) => !covered.has(id));
    // `address-unused` rejects an element address with no reader; the lifted IR the derivation
    // runs on has none, so it is defensive and marked `sound: false`.
    expect(missing).toEqual(['address-unused']);
  });
});

// ── the map always wins, on BOTH symbol-variant arms ─────────────────────────────────────────

describe('a name the project map describes is never claimed by the derivation', () => {
  // The hazard is the `/raw-globals` arm, which STRUCTURES with no map and DECLARES with one:
  // rank.ts's declaration dictionary is map-last, so a derived shape read off THIS function's
  // strides could be spelled against a declaration carrying the PROJECT's — a subscript striding
  // by the wrong extent, or extending the wrong way, compiling either way.
  //
  // NOT HYPOTHETICAL. On the benchmark's `sa3:sa2__sub_8083504:agbcc` this derivation reads
  // `elemSigned: false` off the function's own `ldrh`, while the project's map declares
  // `const s16 gSineTable[1280]` — both readings are right about their own question, and a bare
  // `gSineTable[i]` spelled from the first against a declaration from the second is a signed load
  // where the structurer reasoned about an unsigned one. Measured before the filter existed, that
  // row's whole fan shifted and its published score moved 66 → 45 on candidates carrying that
  // disagreement; with the filter it stays at 66, which is the correct answer.
  const map: SymbolMap = new Map([
    [0x03000000, [{ name: 'gTbl', kind: 'data' as const, shape: 'array' as const, elemSize: 2, dims: [4, 64] }]],
  ]);

  test('every candidate spells the MAP rank, never a derived one', () => {
    const cands = enumerateCandidates('f', BASE_FIRST, ARMV4T_AGBCC, { symbols: map });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      // the map's rank-2 declaration reaches an element only through two subscripts
      expect(c.source).not.toMatch(/[^\]]\bgTbl\[a0\]/);
    }
    // …and the named arm does spell it, so the assertion above is not vacuous
    expect(cands.some((c) => c.source.includes('gTbl[0][a0]'))).toBe(true);
  });
});

describe('both symbol-variant arms agree about a name the map does NOT know', () => {
  // The declaration dictionary is derived ONCE, off the map-ful probe, and used by every
  // candidate — including the `/raw-globals` arm, which structures off its OWN map-less lift. For
  // a symbol the POOL spells (`.word gTbl`) the two lifts see the same `gaddr`, so the two
  // derivations must agree; if they did not, the raw arm could spell `gTbl[i]` against a scalar
  // `extern u32 gTbl;`. Measured rather than asserted.
  const otherMap: SymbolMap = new Map([[0x02000000, [{ name: 'gOther', kind: 'data' as const }]]]);

  test('the two lifts derive the SAME shape for a pool-spelled symbol', () => {
    const withMap = inferGlobalArrays(
      frontendFor(ARMV4T_AGBCC).lift('f', BASE_FIRST, ARMV4T_AGBCC, {}, undefined, otherMap),
      ARMV4T_AGBCC,
    );
    expect([...withMap]).toEqual([...derive('f', BASE_FIRST)]);
  });

  test('every candidate spells the subscript and carries the array declaration', () => {
    const cands = enumerateCandidates('f', BASE_FIRST, ARMV4T_AGBCC, { symbols: otherMap });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.source).toContain('gTbl[a0]');
      expect(c.symbolRefs?.find((r) => r.name === 'gTbl')?.info).toMatchObject({ shape: 'array', elemSize: 2 });
    }
  });
});

// ── the dims ↔ strides round trip ─────────────────────────────────────────────────────────────
//
// The conversion is written TWICE, in two files, in opposite directions: this module reads inner
// EXTENTS out of ascending strides (`extentsOf`), and `structure/globalaccess.ts`'s
// `declaredSubscripts` reconstructs the STRIDES from the extents to divide the residual back into
// subscripts (`inner.slice(p).reduce((a, b) => a * b, width)`). If the two ever disagree
// numerically, the emitted subscript addresses a different object than the assembly did — and the
// only inhabitant on the corpus is rank 2 with an inner extent of 2, which is the one case that is
// hard to get wrong. So the round trip is asserted over a range instead.

describe('the derived rank survives the round trip back into strides', () => {
  test('every rank asmlift can derive re-divides the residual into the same subscripts', () => {
    let derived = 0;
    for (const width of [1, 2, 4]) {
      for (const inner of [[2], [3], [8], [2, 2], [4, 3], [2, 8, 5]]) {
        // the strides a declaration `T g[][inner…]` produces, innermost first — the shape the asm
        // presents to `extentsOf`
        const strides = [width];
        for (let k = inner.length - 1; k >= 0; k--) {
          strides.push(strides[strides.length - 1] * inner[k]);
        }
        const asm = thumb(
          'f',
          `\tldr\tr7, .L3\n${strides
            .map((st, n) => `\tmov\tr6, #${st}\n\tmul\tr${n}, r6\n`)
            .join('')}\tmov\tr5, r0\n${strides
            .slice(1)
            .map((_, n) => `\tadd\tr5, r5, r${n + 1}\n`)
            .join('')}\tadd\tr5, r5, r7\n\tldr${width === 1 ? 'b' : width === 2 ? 'h' : ''}\tr0, [r5]`,
          '.word\tgTbl',
        );
        const si = derive('f', asm).get('gTbl');
        // Every generated shape is derivable here (the base loads first and every scale follows),
        // and the dims it carries must reproduce exactly the strides it was read from —
        // `arrayInnerExtents` is the shared reader both sides call. Ranks 1 through 3 at all three
        // element widths, which is 17 shapes more than the corpus has.
        expect([width, inner, si === undefined]).toEqual([width, inner, false]);
        derived++;
        const back = [width];
        for (const e of [...(arrayInnerExtents(si!) ?? [])].reverse()) {
          back.push(back[back.length - 1] * e);
        }
        expect([width, inner, back]).toEqual([width, inner, strides]);
      }
    }
    // …and the loop really ran: a property test whose population is empty asserts nothing.
    expect(derived).toBe(18);
  });

  test('…and the generator is not vacuous: at least one shape really derives', () => {
    // Otherwise the loop above asserts nothing, which is the failure mode a guarded property test
    // has and a plain one does not.
    expect(derive('f', RANK2).get('gPtrTbl')?.dims).toEqual([null, 2]);
    expect(arrayInnerExtents(derive('f', RANK2).get('gPtrTbl')!)).toEqual([2]);
  });
});

// ── the shape travels with the source ────────────────────────────────────────────────────────

describe('the assumed declaration is never hidden', () => {
  test('a source that spells a bare subscript reports the shape it assumes', () => {
    // `((T *)&gSym)[i]` reproduces the target's bytes under ANY declaration of the name; the bare
    // `gSym[i]` means what the declaration says it means. So the derived shape leaves every entry
    // path with the source, and a consumer showing one without the other is publishing a spelling
    // whose meaning it has not stated. The element SIGNEDNESS is the sharp case: compiled through
    // the benchmark's own agbcc command, `(u16)gS[i]` over `extern const s16 gS[]` and `gS[i]`
    // over `extern const u16 gS[]` are the SAME object, so this `elemSigned: false` is a pick.
    const r = decompile('f', BASE_FIRST, ARMV4T_AGBCC, {});
    expect(r.source).toContain('gTbl[a0]');
    expect(r.assumedSymbols).toEqual([{ name: 'gTbl', kind: 'data', shape: 'array', elemSize: 2, elemSigned: false }]);
  });

  test('a source that assumes nothing says so', () => {
    expect(decompile('f', INDEX_FIRST, ARMV4T_AGBCC, {}).assumedSymbols).toEqual([]);
  });

  // THE DERIVATION IS NOT THE ASSUMPTION, and the gap between them is where this channel was
  // wrong. `assumedSymbols` answers "which declarations is the reader obliged to check", and a
  // derived shape earns that obligation only where the STRUCTURER SPELLED THE NAME BARE and NO
  // MAP DESCRIBED IT. Both halves have real inhabitants on the corpus, and both published a false
  // sentence before this narrowing: the CLI told the reader the source spelled a name bare when
  // it had emitted the cast form, and handed them a declaration to check against the very headers
  // the map they supplied was built from.
  const MAP = (si: Partial<SymbolInfo>): SymbolMap =>
    new Map([[0x0800_0000, [{ name: 'gTbl', kind: 'data', shape: 'array', elemSize: 2, ...si } as SymbolInfo]]]);

  test('a map that CONTRADICTS the derivation: the map spells it, and nothing is assumed', () => {
    // `sa3:sa2__sub_8083504` is this row on the real corpus — the derivation reads
    // `elemSigned: false` off the function's own `ldrh` while the vendored map declares
    // `const s16 gSineTable[1280]`. structure() asks the map FIRST, so the emitted source is the
    // cast form and assumes nothing; publishing the derivation would send the reader to check
    // `extern u16 gTbl[];` against headers that already said `s16`.
    const r = decompile('f', BASE_FIRST, ARMV4T_AGBCC, { symbols: MAP({ elemSigned: true, dims: [4, 64] }) });
    expect(r.source).toContain('((u16 *)&gTbl)[a0]');
    expect(derive('f', BASE_FIRST).has('gTbl')).toBe(true); // the derivation still FIRES
    expect(r.assumedSymbols).toEqual([]); // …and is not what the source rests on
  });

  test('a map that AGREES: the name is spelled bare, and still nothing is ASSUMED', () => {
    // The subtler half. The bare subscript is emitted, but the declaration it means what it means
    // by is the CALLER'S OWN, supplied on the command line — nothing was assumed and there is
    // nothing to check.
    const r = decompile('f', BASE_FIRST, ARMV4T_AGBCC, { symbols: MAP({ elemSigned: false }) });
    expect(r.source).toContain('gTbl[a0]');
    expect(r.source).not.toContain('&gTbl');
    expect(r.assumedSymbols).toEqual([]);
  });

  // `a * 28` as agbcc spells it — `(a << 3) - a`, then the whole thing scaled by the ELEMENT.
  // The derivation reads the outer `lsl #0x2` as the scale and the multiply below it as one
  // opaque subscript, so it derives a 4-byte element quite correctly (`gBgInfo[a * 7]` is a
  // legitimate flat spelling of the same address). `recognizeStructArrays` then runs — AFTER
  // this derivation, which is taken on the LIFTED fn — and rewrites the access into a 28-byte
  // element with a field offset, which `arrayAccess` has no bare branch for.
  const STRUCT_ELEM = thumb(
    'f',
    '	ldr	r2, .L3\n	lsl	r1, r0, #0x3\n	sub	r1, r1, r0\n	lsl	r1, r1, #0x2\n	add	r1, r1, r2\n	ldr	r0, [r1]',
    '.word	gBgInfo',
  );

  test('a shape DERIVED but never SPELLED assumes nothing — no map involved', () => {
    // The other half, and it needs no symbol map at all: a derivation reaching a symbol does not
    // make the SOURCE depend on it. Every consumer of a shape can still refuse, and the access
    // then keeps `((T *)&gSym)[i]`, which reproduces the bytes under ANY declaration.
    // `kleod:SetupBG3WindowOverlay` is exactly this row on the real corpus (1 of the 7 map-less
    // agbcc rows the derivation reaches), and before this narrowing the CLI printed "the source
    // spells them BARE" beside a source that had emitted the cast form.
    expect(derive('f', STRUCT_ELEM).get('gBgInfo')?.elemSize).toBe(4);
    const r = decompile('f', STRUCT_ELEM, ARMV4T_AGBCC, {});
    expect(r.source).toContain('((struct Elem0 *)&gBgInfo)[a0].field_0');
    expect(r.sfn.globals ?? []).toEqual([]);
    expect(r.assumedSymbols).toEqual([]);
  });
});

// ── the spelling and the declaration are never derived from different lifts ───────────────────

describe('sameDerivedShape: what "the declaration will carry this" means', () => {
  // rank.ts spells from a per-variant derivation and declares from a probe-derived dictionary. The
  // `/raw-globals` arm structures with NO map and declares with one, so the two can be read off
  // different lifts — and a candidate that spells `gTbl[i][j]` beside `extern u32 gTbl[][8];`
  // addresses a different object than the assembly did, compiling either way. This is the
  // predicate that keeps the raw arm from spelling a shape its declaration will not carry.
  const arr = { name: 'gTbl', kind: 'data' as const, shape: 'array' as const, elemSize: 2, elemSigned: false };

  test('agrees on the fields the bare subscript reads, and only those', () => {
    expect(sameDerivedShape(arr, { ...arr })).toBe(true);
    // `elemSigned` absent defaults the same way `bareArrayElement` defaults it
    expect(sameDerivedShape(arr, { name: 'gTbl', kind: 'data', shape: 'array', elemSize: 2 })).toBe(true);
    // …and a different NAME is not a disagreement about the object: the caller keys by name
    expect(sameDerivedShape(arr, { ...arr, name: 'gOther' })).toBe(true);
  });

  test('disagrees on every field that moves an address', () => {
    expect(sameDerivedShape(arr, { ...arr, elemSize: 4 })).toBe(false);
    expect(sameDerivedShape(arr, { ...arr, elemSigned: true })).toBe(false);
    expect(sameDerivedShape(arr, { ...arr, dims: [null, 8] })).toBe(false);
    expect(sameDerivedShape(arr, { name: 'gTbl', kind: 'data' })).toBe(false);
    expect(sameDerivedShape(arr, undefined)).toBe(false);
    expect(sameDerivedShape(undefined, undefined)).toBe(true);
  });
});

// ── the axes the derived rank re-opens ───────────────────────────────────────────────────────

describe('a derived rank enumerates `/flat-rank`, exactly as a mapped one does', () => {
  // `/flat-rank` exists BECAUSE the asm underdetermines the choice between `g[r][i]` and the flat
  // byte arithmetic (matching/array-rank-axis.test.ts compiles the pair). Its enumeration gate
  // therefore asks the MAP OR THE DERIVED SHAPES, because structure() builds the symbol render
  // context from the union of the two: supplying the rank from a new place does not make the
  // choice determined, and nothing reports a candidate that was never enumerated.
  test('both arms are enumerated, and they are genuinely different spellings', () => {
    const cands = enumerateCandidates('f', RANK2, ARMV4T_AGBCC);
    expect(cands.map((c) => c.label)).toEqual(['unsigned', 'unsigned/flat-rank', 'signed', 'signed/flat-rank']);
    const on = cands.filter((c) => !c.label.includes('flat-rank'));
    const off = cands.filter((c) => c.label.includes('flat-rank'));
    expect(on.every((c) => c.source.includes('gPtrTbl[a0][a1]'))).toBe(true);
    expect(off.every((c) => c.source.includes('(u32)&gPtrTbl'))).toBe(true);
    expect(off.every((c) => !c.source.includes('gPtrTbl[a0]'))).toBe(true);
  });

  test('a rank-1 derivation opens no arm — the axis has nothing to turn off', () => {
    // The gate is asked of the EVIDENCE, not of the derivation's mere existence: a symbol with no
    // declared rank spells the same tree either way, and the pair would be dedup fodder.
    expect(enumerateCandidates('f', BASE_FIRST, ARMV4T_AGBCC).map((c) => c.label)).toEqual(['unsigned', 'signed']);
  });
});

// ── the per-compiler gate ────────────────────────────────────────────────────────────────────

describe('the licence is a per-compiler behaviour, never a universal', () => {
  test('a target that has not opted in derives nothing', () => {
    // Whether ido/kmc/mwcc fork the subscript on the operand's array-ness is UNMEASURED, so the
    // derivation claims nothing there. Asked through the flag rather than through an ISA, so the
    // first compiler shown to fork the same way opts in with a data field.
    expect(MIPS_IDO.compilerBehaviors.arrayShapeFromStride).toBeUndefined();
    const off = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, arrayShapeFromStride: false },
    };
    expect(inferGlobalArrays(frontendFor(ARMV4T_AGBCC).lift('f', BASE_FIRST, ARMV4T_AGBCC, {}), off).size).toBe(0);
  });
});

// ── the ORDER half, on its own ────────────────────────────────────────────────────────────────
//
// `orderLicensedGlobals` answers the question a VALUE HOME asks — was the base materialized before
// the index was scaled — where `inferGlobalArrays` answers the one a DECLARATION asks. They read
// the same `baseFirst` fact through the same rule objects; the order half simply drops every rule
// that is about the element, which is what lets a struct element (read at a displacement, no
// `intType`, no whole-element subscript) be licensed for a home and still refused for a decl.

describe('the order licence, split out for the value-home consumer', () => {
  test('the declaration derivation asks exactly the rules it always did', () => {
    // The split is a partition of one list, so `inferGlobalArrays`' attribution cannot have moved.
    expect(ADDRESS_GATES.map((g) => g.id)).toEqual([
      'address-escapes',
      'relocation-addend',
      'residual-not-a-sum',
      'address-unused',
      'interior-or-non-access',
    ]);
    expect(ADDRESS_GATES).toEqual([...ELEMENT_ADDRESS_GATES, ...DECLARATION_ADDRESS_GATES]);
    // the shape half is SELECTED, not restated — the same objects, so a predicate edit reaches both
    expect(ORDER_SHAPE_GATES.every((g) => SHAPE_GATES.includes(g))).toBe(true);
  });

  test('a struct element read at a displacement is licensed for a home and refused for a decl', () => {
    // The `bgarr` shape: a 28-byte element read 2 bytes in (`gBgInfo[i].field_16`), pool word
    // FIRST. No array declaration describes it — and none is needed to know where the base lived.
    const structElem = thumb(
      'f',
      '\tldr\tr2, .L3\n\tlsl\tr1, r0, #0x3\n\tsub\tr1, r1, r0\n\tlsl\tr1, r1, #0x2\n\tadd\tr1, r1, r2\n\tldrh\tr0, [r1, #0x10]',
      '.word\tgBgInfo',
    );
    expect(derive('f', structElem).size).toBe(0);
    expect([...licensed('f', structElem)]).toEqual(['gBgInfo']);
  });

  test('base-first licenses, index-first does not — the same minimal pair', () => {
    expect([...licensed('f', BASE_FIRST)]).toEqual(['gTbl']);
    expect([...licensed('f', INDEX_FIRST)]).toEqual([]);
  });

  test('the addend belongs to the base, so `arrbias` is refused here too', () => {
    // `relocation-addend` stays in the ELEMENT half: a constant baked into the pool word says the
    // address the source named is not `&gTbl`, whatever order it was materialized in.
    expect([...licensed('f', fixture('relocation-addend'))]).toEqual([]);
  });

  test('every name the declaration derivation shapes is licensed for a home', () => {
    // The superset claim, measured on the fixtures rather than argued: a shaped name has no
    // interior consumer, so both derivations see the same accesses and this one asks fewer rules.
    for (const [, asm] of [...GATE_FIXTURES, ['licence', BASE_FIRST] as const]) {
      for (const name of derive('f', asm).keys()) {
        expect([...licensed('f', asm)]).toContain(name);
      }
    }
  });

  test('a target that has not opted in licenses nothing', () => {
    const off = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, arrayShapeFromStride: false },
    };
    expect(orderLicensedGlobals(lift('f', BASE_FIRST), off).size).toBe(0);
  });
});
