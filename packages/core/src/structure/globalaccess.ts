// THE GLOBAL-ACCESS ADDRESS DECOMPOSITION — the pure half of the symbol-map access spellings.
//
// Everything here is a function of an `Expr`, a `SymbolInfo` and a width: no structurer state, no
// naming walk, no loop context. It answers three questions the access spellings in structure.ts
// ask over and over — is this address `&gSym` plus something; does that something divide into
// whole elements; and do the terms of it name the DECLARED subscripts of a multidimensional array
// — and it answers them the same way for every caller, which is the point of the split: the
// rank-pinning fallback and the declared-subscript recovery share `bareArrayElement`, so the two
// cannot disagree about what a bare element spelling is.
//
// Extracted from structure.ts under the reviewed refactor plan's rule (safety infra first, then
// only PURE hazards): unit-testable on `Expr` literals, and one less family in a 4,700-line file.
import type { Expr } from '../l3/ast';
import { type SymbolInfo, arrayInnerExtents } from '../symbols';

// `&gSym`, possibly wearing the value-context integer cast the additive lowering adds
// (`(u32)&gSym` — see lowerDef's addr-intify): both spell the same link-time constant, so the
// fold rules match through the cast and every access that CAN spell a named element still does.
// WIDTH 32 ONLY — a NARROWING cast (`(u8)&gSym`, from a zext/sext lowering) is a different
// VALUE (`addr & 0xFF`), and folding through it would read the named global at a wrong address
// (the adversarial round's probe: `*(u8*)(u8)&gSym` must keep its truncation, never become
// `*(u8*)&gSym` — let alone a confidently-named `gSym.field`).
export function addrIn(e: Expr): Extract<Expr, { k: 'addr' }> | null {
  if (e.k === 'addr') {
    return e;
  }
  if (e.k === 'cast' && e.to.kind === 'int' && e.to.width === 32 && e.e.k === 'addr') {
    return e.e;
  }
  return null;
}

// If `e` is a global address `&gSym` (optionally `+ index`), return the global name and the
// element index (byte residual divided by the access width). `&gSym` alone → idx const 0;
// `&gSym + i` → idx `i / width` (exact division only — a non-multiple residual is a mid-element
// access this whole-global spelling can't express, so it declines to null and the caller casts).
export function globalOf(e: Expr, width: number): { name: string; idx: Expr } | null {
  const gb = globalByteBase(e);
  if (gb === null) {
    return null;
  }
  const idx = elementIndex(gb.residual, width);
  return idx ? { name: gb.name, idx } : null;
}

/** The same split ONE step earlier: `&gSym` and the raw BYTE residual added to it, before the
 *  division into elements throws the individual terms away. The multidimensional recovery needs
 *  the terms — a row index is a term at the row's byte stride. */
export function globalByteBase(e: Expr): { name: string; residual: Expr } | null {
  const top = addrIn(e);
  if (top) {
    return { name: top.name, residual: { k: 'const', value: 0 } };
  }
  if (e.k === 'bin' && e.op === '+') {
    for (const [side, other] of [
      [e.l, e.r],
      [e.r, e.l],
    ] as const) {
      const addrSide = addrIn(side);
      if (addrSide) {
        return { name: addrSide.name, residual: other };
      }
    }
  }
  return null;
}

// THE one gate on the BARE-NAME array-global spelling (`gSym[i]` rather than `((T *)&gSym)[i]`),
// shared by the constant-offset and variable-index access paths so the two cannot disagree.
// Returns the `index` node's `lead` fragment when the bare form is spellable, or null to fall
// through to the always-valid `&gSym` cast form.
//
// Two facts are required, not one. The element WIDTH must match, as it always has. And the RANK
// must be SPELLABLE, because one subscript reaches an element only on a rank-1 array: on `u16
// g[4][0x400]`, `g[i]` is a ROW. Against the project's own header that is usually a type error,
// but where the row address flows into an integer context it is merely a warning and the emitted C
// then addresses a different object than the asm did — silently.
//
// A rank > 1 pins the leading dimensions at 0 and puts the whole flat element index in the last
// subscript (`g[0][i]`) — the same address arithmetic, and the idiom decomp sources themselves use
// when the split is not observable in the asm either (`gBgTilemapBufs[0][…]` in kleod,
// `gNatureStatTable[nature][…]` in pokeemerald). A rank the map states but cannot spell (an unknown
// inner extent) gets no bare form at all; `((T *)&gSym)[i]` is byte-identical and valid under ANY
// declaration, which is why it is the safe fallback. See symbols.ts arrayInnerExtents for why an
// ABSENT rank is read as 1 rather than as unknown.
export function bareArrayLead(si: SymbolInfo, width: number, signed: boolean): { lead?: Expr[] } | null {
  if (!bareArrayElement(si, width, signed)) {
    return null;
  }
  const inner = arrayInnerExtents(si);
  return inner === null ? null : inner.length === 0 ? {} : { lead: inner.map((): Expr => ({ k: 'const', value: 0 })) };
}

/** The element half of the bare-name rule: the global is an ARRAY whose declared element the
 *  access reads WHOLE and with the declared extension. Shared by the rank-pinning fallback above
 *  and the declared-subscript recovery below, so the two cannot disagree about what they spell. */
export function bareArrayElement(si: SymbolInfo, width: number, signed: boolean): boolean {
  if (si.shape !== 'array' || si.elemSize !== width) {
    return false;
  }
  // …and the element must EXTEND the way the access does, for the same reason the width must
  // match: the bare spelling carries no cast, so the declared element type is the only thing in
  // the emitted C that says whether a sub-word read sign- or zero-fills. Against the DECLARED
  // signedness, defaulted exactly as the element type registered for the env is (noteGlobal, just
  // below) — a disagreement there makes the deref legalization wrap the base, and a leading
  // subscript has no room for that wrapping.
  //
  // The caller then falls through to `((T *)&gSym)[i]`, byte-identical under any declaration.
  return !(width < 4 && (si.elemSigned ?? false) !== signed);
}

// ── the DECLARED subscripts, recovered from the address arithmetic ───────────────────────────
//
// A rank-2 access the source wrote as `g[r][i]` reaches the element through `&g + r*rowBytes +
// i*elemSize`, and agbcc leaves those two terms SEPARATE (`lsl #0xb` and `lsl #0x1`, added). The
// flat spelling `((u16 *)&g)[r*1024 + i]` does not: it scales once (`lsl #0xa` then `lsl #0x1`),
// so the two are distinguishable in the asm and the term at the declared ROW stride is the
// evidence that the source named the row. bareArrayLead cannot use it — one subscript is all it
// spells, so a residual with a row term falls through to `*(T *)(… + (u32)&g)` — and that cast
// form is what this recovers the subscripts out of.
//
// THE EVIDENCE IS THE BYTE RESIDUAL, AND ONLY THE BYTE RESIDUAL — the refusal that keeps the
// paragraph above from being read backwards. An index ALREADY DIVIDED into elements (what
// arrayAccess holds, when the asm scaled the whole sum once at the end) is what BOTH spellings
// reduce to: `(r<<11) + (i<<1)` and `((r<<10) + i) << 1` differ only in where the element scale
// sits, which is exactly what the division removes. So this runs on the byte residual and
// arrayAccess does not call it — see the note at that site for what the two spellings measure.
// `packages/cli/test/matching/array-rank-axis.test.ts` compiles both halves of that.
//
// The recovered address is the SAME address either way (C scales `[r]` by the declared row size,
// which is the constant the arithmetic multiplied by), so this is a spelling, not a re-addressing.
//
// AND IT IS AN AXIS, NOT A DEFAULT — the evidence above says the residual carries a ROW, and it
// does not say which of the two spellings that reach it wrote one. The cast form this replaces
// (`*(T *)((r<<11) + (i<<1) + (u32)&g)`) compiles to the SAME shift structure and differs only in
// scheduling on agbcc, kmc and mwcc, and is byte-identical on IDO — where the flat sum is
// distributed into those same separate scales, so the premise above is a per-compiler fact and not
// a universal one. `spellDeclaredSubscripts` is the switch and `/flat-rank` the arm; see that
// option for the compiled table.

/** `residual` as a list of additively combined terms with their sign — `a + (b - c)` is
 *  `[+a, +b, -c]`. Only `+`/`-` are opened; anything else is one opaque term. */
function addTerms(e: Expr, sign: 1 | -1, into: { e: Expr; sign: 1 | -1 }[]): void {
  if (e.k === 'bin' && (e.op === '+' || e.op === '-')) {
    addTerms(e.l, sign, into);
    addTerms(e.r, e.op === '+' ? sign : (-sign as 1 | -1), into);
    return;
  }
  into.push({ e, sign });
}

/** `x` when `t` is the NON-CONSTANT value `x` scaled by exactly `stride` (`x * stride` or
 *  `x << log2(stride)`), else null. A constant term is never a recovered subscript: both
 *  spellings of a constant row index compile identically, so nothing referees the choice. */
function scaledBy(t: Expr, stride: number): Expr | null {
  if (t.k !== 'bin') {
    return null;
  }
  if (t.op === '<<' && t.r.k === 'const' && t.r.value < 31 && 1 << t.r.value === stride && t.l.k !== 'const') {
    return t.l;
  }
  if (t.op === '*' && t.r.k === 'const' && t.r.value === stride && t.l.k !== 'const') {
    return t.l;
  }
  return null;
}

/** The leading subscripts of `si` recovered from the BYTE `residual`, plus what is left for the
 *  last one. The parameter is a byte residual by contract, not by convention: a residual already
 *  divided into elements carries no evidence about the row (see the header), so there is no unit
 *  to pass and no caller that could pass one.
 *
 *  REFUSES (falling back to the caller's existing spelling, which is byte-identical) when: the
 *  symbol is not an array of exactly this element; the declared rank is 1 or unspellable; any
 *  leading stride is not strictly larger than the one below it (an extent of 1 makes two
 *  positions indistinguishable, so the split would be a guess); NO term is a non-constant
 *  multiple of a leading stride (there is nothing to recover and today's answer already spells
 *  the same address); or what remains does not divide into whole elements.
 *
 *  It does NOT refuse an unknown OUTERMOST extent (`dims: [null, 0x400]` — 8 symbols across the
 *  six vendored maps), and that is deliberate rather than an omission: only the INNER extents
 *  enter a stride, and declare.ts leaves the outermost dimension unsized in the emitted
 *  declaration either way (`extern u16 gRows[][1024];` for `[4,1024]` and for `[null,1024]`
 *  alike), so the recovered subscripts and the declaration they are read against agree and stride
 *  identically. There is therefore no guard on the outermost extent anywhere below, and its
 *  absence is the rule rather than a gap in it. */
export function declaredSubscripts(
  si: SymbolInfo,
  residual: Expr,
  width: number,
  signed: boolean,
): { lead: Expr[]; idx: Expr } | null {
  if (!bareArrayElement(si, width, signed)) {
    return null;
  }
  const inner = arrayInnerExtents(si);
  if (inner === null || inner.length === 0) {
    return null;
  }
  const strides: number[] = [];
  for (let p = 0; p < inner.length; p++) {
    strides.push(inner.slice(p).reduce((a, b) => a * b, width));
  }
  for (let p = 0; p < strides.length; p++) {
    if (!Number.isSafeInteger(strides[p]) || strides[p] <= (p + 1 < strides.length ? strides[p + 1] : width)) {
      return null;
    }
  }
  const terms: { e: Expr; sign: 1 | -1 }[] = [];
  addTerms(residual, 1, terms);
  const taken = new Set<number>();
  const lead = strides.map((stride): Expr => {
    for (let i = 0; i < terms.length; i++) {
      const x = taken.has(i) || terms[i].sign !== 1 ? null : scaledBy(terms[i].e, stride);
      if (x) {
        taken.add(i);
        return x;
      }
    }
    return { k: 'const', value: 0 };
  });
  if (taken.size === 0) {
    return null;
  }
  let sum: Expr = { k: 'const', value: 0 };
  for (const [i, t] of terms.entries()) {
    sum = taken.has(i)
      ? sum
      : sum.k === 'const' && sum.value === 0 && t.sign === 1
        ? t.e
        : { k: 'bin', op: t.sign === 1 ? '+' : '-', l: sum, r: t.e };
  }
  const idx = elementIndex(sum, width);
  return idx === null ? null : { lead, idx };
}

// A BYTE residual read as an ELEMENT index of `elemSize`-wide elements, or null when it is not one
// — the residual then addresses mid-element and no whole-element spelling can express it, so the
// caller falls through to the honest cast forms. THE one copy of the rule, indexing the
// `&gSym`-based array spelling: width 1 → the byte residual IS the index; wider → a constant
// residual must divide exactly, and a non-constant one must already be element-scaled
// (`i * elemSize` / `i << log2(elemSize)`), which is exactly what the asm's own index scaling
// produced.
export function elementIndex(residual: Expr, elemSize: number): Expr | null {
  if (elemSize === 1) {
    return residual;
  }
  if (residual.k === 'const') {
    return residual.value % elemSize === 0 ? { k: 'const', value: residual.value / elemSize } : null;
  }
  if (residual.k === 'bin' && (residual.op === '*' || residual.op === '<<')) {
    const factor =
      residual.op === '<<'
        ? residual.r.k === 'const'
          ? 1 << residual.r.value
          : 0
        : residual.r.k === 'const'
          ? residual.r.value
          : 0;
    if (factor === elemSize) {
      return residual.l;
    }
  }
  return null;
}

/** `idx + n` with a constant fold, `idx` itself for n 0 — the one place an access's memory-operand
 *  displacement joins the subscript it was always part of. */
export function addOffset(idx: Expr, n: number): Expr {
  if (n === 0) {
    return idx;
  }
  return idx.k === 'const'
    ? { k: 'const', value: idx.value + n }
    : { k: 'bin', op: '+', l: idx, r: { k: 'const', value: n } };
}
