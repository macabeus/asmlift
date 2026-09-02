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
import { decompile } from '../src/pipeline';
import { inferGlobalArrays } from '../src/raise/globalshape';
import { enumerateCandidates } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
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

const derive = (name: string, asm: string) =>
  inferGlobalArrays(frontendFor(ARMV4T_AGBCC).lift(name, asm, ARMV4T_AGBCC, {}, undefined, undefined), ARMV4T_AGBCC);

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

  test('the two lift to DIFFERENT IR and would otherwise recover to the same', () => {
    // Why the derivation has to run on the lifted fn: the array-idiom fold turns both into the
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

// ── the refusals that keep a loud fallback instead of a silent wrong answer ───────────────────

describe('refusals', () => {
  test('an element stride wider than the access width claims nothing', () => {
    // A 28-byte element read 2 bytes at a time (`gBgInfo[i].hLength`). Relaxing this conjunct is
    // what emits a flat 16-bit subscript on a 28-byte-element array — out of bounds against the
    // project's own header. The cast spelling stands instead.
    const structElem = thumb(
      'f',
      '	ldr	r2, .L3\n	lsl	r1, r0, #0x3\n	sub	r1, r1, r0\n	lsl	r1, r1, #0x2\n	add	r1, r1, r2\n	ldrh	r0, [r1, #0x10]',
      '.word	gBgInfo',
    );
    expect(derive('f', structElem).size).toBe(0);
    expect(sourceOf('f', structElem)).toContain('&gBgInfo');
  });

  test('no evidence at all — width 1, no constant — claims nothing', () => {
    // Both spellings are byte-identical here, so there is nothing to win and a derivation would
    // be a guess. It stays the cast form.
    const noEvidence = thumb('f', '	ldr	r1, .L3\n	add	r0, r0, r1\n	ldrb	r0, [r0]', '.word	gTbl');
    expect(derive('f', noEvidence).size).toBe(0);
  });

  test('the address escaping to a callee refuses the whole symbol', () => {
    // A declaration is per SYMBOL, not per access: one use this spelling does not model and the
    // name keeps the cast form everywhere.
    const escapes = `	.code	16
.text
	.align	2, 0
	.globl	f
	.type	 f,function
	.thumb_func
f:
	push	{r4, lr}
	ldr	r4, .L3
	lsl	r0, r0, #0x1
	add	r0, r0, r4
	ldrh	r0, [r0]
	mov	r0, r4
	bl	sink
	pop	{r4}
	pop	{r1}
	bx	r1
.L4:
	.align	2, 0
.L3:
	.word	gTbl
.Lfe1:
	.size	 f,.Lfe1-f
`;
    expect(derive('f', escapes).size).toBe(0);
  });

  test('two access widths under one name refuse: the element type would be a guess', () => {
    const twoWidths = thumb(
      'f',
      '	ldr	r2, .L3\n	lsl	r1, r0, #0x1\n	add	r1, r1, r2\n	ldrh	r1, [r1]\n	lsl	r0, r0, #0x2\n' +
        '	add	r0, r0, r2\n	ldr	r0, [r0]\n	add	r0, r0, r1',
      '.word	gTbl',
    );
    expect(derive('f', twoWidths).size).toBe(0);
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
