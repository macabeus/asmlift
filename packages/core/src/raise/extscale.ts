// A NARROWING EXTENSION FUSED WITH THE LEFT SHIFT THAT SCALES IT.
//
// agbcc lowers `(u8)x` to a shift pair, `lsl #24; lsr #24` (the CAST_PATTERNS idiom,
// pattern/engine.ts). Scale the narrowed value and gcc's combiner merges the right half of the pair
// with the scale, so `(u8)x << 3` is TWO instructions, not three:
//
//     lsl  r0, r0, #0x18        %1 = shl %x {imm=24}
//     lsr  r0, r0, #0x15        %2 = shr_u %1 {imm=21}      == zext8(x) << 3
//
// Exactly: `(x << L) >>u R` for `0 < R < L` keeps x's low `32 - L` bits and lands them at bit
// `L - R`, which is `zext(x, 32 - L) << (L - R)`; `>>s` is the same with `sext`. What the fold buys
// is the two facts the raw pair hides from every pass below — and ONLY those: the spelling it
// prints when neither is claimed is not byte-neutral, so that spelling never ships (WHAT NOBODY
// CLAIMED, below):
//
//   • THE WIDTH. A declared `u8 idx` is extended in the prologue, and that extension is what
//     raise/paramwidth.ts reads to type the parameter. When the extension is fused, the prologue
//     holds a bare `shl` instead: paramwidth sees no extension of this parameter, AND its prologue
//     scan stops at that `shl`, so every LATER parameter's extension reads as body code too. Typed
//     `u32`, the function recompiles with both shifts at the use and the whole schedule moves.
//   • THE SCALE. `shl(ext(x), k)` is the element-scaled index raise/arrays.ts and
//     raise/struct-arrays.ts legalize; `shr_u(shl(x, 24), 21)` is an opaque byte offset to both.
//
// WHERE THE EXTENSION GOES is the one real decision here, and it is read off the machine, not
// chosen. The two halves of the pair are not scheduled together. Compiled with this benchmark's
// agbcc, the same body over a narrow and a wide parameter:
//
//     void pa(u8 a, u8 b)  { gA |= 4; gB = (u32)&gT + a * 4;      gC = b; }
//         lsl r0,#24 / lsl r1,#24 / lsr r1,#24 / …body… / lsr r0,#22 / add …
//     void pb(u32 a, u8 b) { gA |= 4; gB = (u32)&gT + (u8)a * 4;  gC = b; }
//         lsl r1,#24 / lsr r1,#24 / …body… / lsl r0,#24 / lsr r0,#22 / add …
//
// The declaration's extension starts in the prologue and only its SECOND half is merged into the
// use; a cast in the body is lowered at the use, both halves together. So the extension is placed
// where its `shl` stood and the scale where the right shift stood: a prologue `lsl` yields a
// prologue extension, which paramwidth's own gates then judge. Those gates keep a body cast wide
// only when body code that READS a value comes first — `not-prologue` steps over materializations,
// a pool-loaded address among them — which is why the fold records a pair it finds behind one
// (THE BODY CAST BEHIND A POOL LOAD, below). Placing both at the right shift instead throws `pa`'s
// prologue evidence away, so `pa` reads as `pb` and stays wide — measured on the benchmark's sa3
// rows whose first parameter is a declared `u8` scaled this way:
// `sa2__sub_8007858` 39/60 anchored against 44/61 at the right shift, and `sa2__sub_8007958` 64/87
// against 66/88.
//
// The SIGNED form does not carry that evidence on agbcc: `void pd(s16 a, …) { … a * 2 … }` and its
// wide twin `(s16)a * 2` compile to the SAME object, both halves at the use — the ambiguity of
// paramwidth's `pc` pair — so the placement rule is the same either way, and where the pair sits the
// judgement is paramwidth's.
//
// REFUSES — the pair is left as it is — when:
//   • `R >= L`. `R == L` is the plain cast, which CAST_PATTERNS already folded; `R > L` keeps
//     `32 - R` bits of `x << L` and scales nothing — a bitfield EXTRACT, structure/bitfields.ts's
//     shape — so the two readings are disjoint by the shift amounts alone;
//   • `32 - L` is not a C cast width (8 or 16) — `lsl #28; lsr #26` is `(x & 15) << 2`, which no
//     cast spells;
//   • either shift is the two-register form (no `imm`) or `R` is 0;
//   • the target is not one CAST_PATTERNS applies to. Same predicate, because the fused pair is
//     that cast's lowering with a scale merged in: where `(u8)x` is not a shift pair (IDO and GCC
//     `andi`), `(u8)x << k` is not one either, and a `sll; srl` there is some other arithmetic.
//
//   • another narrowing of the same value, at the same width and with the same SIGN, sits in the
//     pair's block — a second right shift of a `shl(x, L)`, fused or plain, or the extension
//     CAST_PATTERNS made of a plain one. agbcc extends a value once per block per signedness:
//     `p[(u8)a * 4] = 1; return (u8)a;` is one `lsl #24; lsr #24` and a `lsl #4` at the use, and no
//     fused pair. So a same-sign sibling means the source wrote the shift itself —
//
//         u32 r6(u32 a, u32 *p) { u32 t = a << 24; p[t >> 22] = 1; return t >> 24; }
//             lsl r0,#24 / lsr r2,r0,#20 / … / lsr r0,r0,#24
//
//     which folded, struct-arrays spelled `a1[(u8)a0].field_0`: objdiff 3 where the raw pair is
//     byte-exact. Opposite signs share only the `lsl` — `p[(u8)a] = (s8)a` is `lsl #24; lsr #22 …
//     asr #24` — and both of those ARE casts, so they fold. The test is per BLOCK because the
//     sharing is: the same two casts in two blocks lower twice, each with its own `lsl`
//     (`if (c) p[1] = (u8)a; return p[(u8)a];`), and the fused one folds; and a `shl` shared
//     ACROSS blocks is a declaration too — sa3's `sub_8010184` indexes `s->hitboxes[hbIndex]`
//     twice over an `s16 hbIndex`: one `lsl #16`, read by an `asr #13` in each of two blocks. The
//     idiom patterns turn a plain pair into its extension in place, so the test reads the same
//     before them as after, and raise/globalshape.ts, which reads the lift, agrees with the fold
//     about every pair.
//
// THE BODY CAST BEHIND A POOL LOAD folds, and the fold records it: the pair's `shl` reads an entry
// parameter and the machine ran it after a pool-loaded address. Compiled with this benchmark's
// agbcc, a body cast whose only predecessors are pool loads puts nothing between them and the
// extension that paramwidth's scan stops at, so the extension reads as a declaration:
//
//     void pc1(u32 a) { gB = (u32)&gT + (u8)a * 4; }     ldr r2,=gB / lsl r0,#24 / lsr r0,#22
//
// narrowed to `u8 a0` (objdiff 2) where the raw pair is MATCH. An UNSIGNED declared parameter's
// `lsl` comes before any pool load, symbol or numeric: all 44 over the benchmark's agbcc
// references. A signed one need not (27 before, 2 after): the signed form carries no placement
// evidence (above), and its narrow and wide spellings compile to the same object. So only the
// WIDTH is refused, by raise/paramwidth.ts's `fused-behind-pool` reading the record; the SCALE stays
// for the array passes: `gB = gW[(u8)a]` is objdiff 2 as the raw pair and byte-exact as
// `gW[(u8)a0]`, and sa3's `DemoPlayAlloc` (`gDemoRecordings[demoIndex]` over an `s16`) is spelled
// as the subscript it is.
// The order is read off the LIFTED function (`poolOrderOf`, which says why). NOT caught: a NUMERIC
// pool word lifts to `const`, the same op a `movs` does, and paramwidth's own header says why a
// `movs` ahead of the pair decides nothing — so a body cast behind only a numeric pool load
// (`& 0xfff` over a wide parameter in a loop) still narrows.
//
// One extension per (`shl`, signedness): two folded scales of one sign off one `shl` — in two
// blocks, `sub_8010184`'s shape — share it, and opposite signs get one each. The `shl` dies when
// every reader was folded; one that keeps a raw reader (`p[t >> 22] = 1; return t;`) stays beside
// the extension.
//
// WHAT NOBODY CLAIMED goes back (`restoreUnclaimedScales`, the last pre-recovery pass). An
// extension no width pass took and a scale no array pass took print as `(u8)a1 << 12`, and that is
// NOT the same object as the lifted `a1 << 24 >> 12`: straight-line they compile alike (the `pb`
// pair above), but kleod's `SetWorldMapTilePalette` — two `u8` parameters, the first used in agbcc's
// shifted domain so paramwidth's scan stops at its `shl` and refuses the second's extension — scores
// 54/93 with the raw pair and 59/91 with the cast, the loop's r4/r6 allocation swapped. So every
// scale the fold made that still reads its extension is rewritten in place to the pair it replaced;
// what survives the pass is exactly what a consumer claimed, and everywhere else the output is the
// one the lift alone produces.
//
// That is a choice of DEFAULT, not a finding that the raw spelling is better: the unclaimed cast
// has both signs. Over the 55 corpus functions the fold fires on, scored on the benchmark's own
// path, restoring moves four scores — `SetWorldMapTilePalette` 59/91 → 54/93 and sa3
// `UnpackSaveSector` 347 → 346 better, sa3 `ClearSave` 189 → 191 and `CompleteSave` 185 → 187
// worse, all four to what the lift alone scores (and sa3 `ValidateSave`'s denominator, 213/378 →
// 213/379). A spelling with both signs is the differ's to referee (a ranked axis), and none is
// built; the default is the one that asserts nothing the lift did not.
import { type Block, type Fn, type Op, type Value, defOpMap, mkOp, mkValue, replaceAllUsesWith } from '../ir/core';
import { CAST_WIDTHS } from '../ir/opcodes';
import { CAST_PATTERNS, patternApplies } from '../pattern/engine';
import type { TargetDescription } from '../target';

/** `shr_{u,s}(shl(src, L), R)` read as `ext(src, 32 - L) << (L - R)`. */
export interface ScaledExtension {
  /** the value being narrowed — the `shl`'s operand */
  src: Value;
  /** the cast width, `32 - L` */
  width: number;
  /** `shr_s` (sign-extend) rather than `shr_u` */
  signed: boolean;
  /** the scale's shift amount, `L - R` */
  shift: number;
  /** the `shl` — where the extension begins */
  inner: Op;
}

/** The fused pair's SHAPE rooted at `op`, or null — the header's refusals on the amounts and the
 *  two-register form. The sibling refusal is {@link foldablePairs}', the target's the caller's. */
export function scaledExtensionOf(op: Op | undefined, defs: Map<Value, Op>): ScaledExtension | null {
  if (!op || (op.opcode !== 'shr_u' && op.opcode !== 'shr_s') || op.operands.length !== 1) {
    return null;
  }
  const inner = defs.get(op.operands[0]);
  const r = op.attrs.imm;
  const l = inner?.attrs.imm;
  if (inner?.opcode !== 'shl' || inner.operands.length !== 1 || typeof r !== 'number' || typeof l !== 'number') {
    return null;
  }
  if (!CAST_WIDTHS.has(32 - l) || r <= 0 || r >= l) {
    return null;
  }
  return { src: inner.operands[0], width: 32 - l, signed: op.opcode === 'shr_s', shift: l - r, inner };
}

/** Does `target` lower a narrowing cast to a shift pair — the gate the fold shares with the cast
 *  idiom itself. */
export const foldsShiftPairCasts = (target: TargetDescription): boolean =>
  CAST_PATTERNS.every((p) => patternApplies(p, target));

/** Where the MACHINE put each entry-block op relative to its first pool-loaded address, read off a
 *  function whose entry block is still in lifted order. See THE BODY CAST BEHIND A POOL LOAD. */
export interface PoolOrder {
  /** the function's parameters */
  entryParams: ReadonlySet<Value>;
  /** the entry block's ops that come after a `gaddr` */
  afterPoolLoad: ReadonlySet<Op>;
}

/** Read {@link PoolOrder} off `fn`. Valid only BEFORE raise/gvn.ts's `addrnum` runs: that pass
 *  hoists a duplicated address to the head of the entry block, after which a `gaddr`'s position no
 *  longer says where the machine loaded it. The idiom patterns before it leave both a `gaddr` and a
 *  fused pair's `shl` where they were — a plain cast's pair is folded at its right half, which is
 *  why this fact is read for the FUSED form only. */
export function poolOrderOf(fn: Fn): PoolOrder {
  const entry = fn.blocks[0];
  const afterPoolLoad = new Set<Op>();
  let seen = false;
  for (const op of entry?.ops ?? []) {
    if (seen) {
      afterPoolLoad.add(op);
    }
    seen ||= op.opcode === 'gaddr';
  }
  return { entryParams: new Set(entry?.params ?? []), afterPoolLoad };
}

/** Is `o` a narrowing of `m.src` at `m.width` with `m`'s signedness — a right shift of a
 *  `shl(src, 32 - width)`, fused or plain, or the extension CAST_PATTERNS made of a plain one? The
 *  answer is the same before the idiom patterns and after them: they turn a plain pair into its
 *  extension at the pair's own position. */
function narrowsLike(o: Op, m: ScaledExtension, defs: Map<Value, Op>): boolean {
  if (o.opcode === (m.signed ? 'sext' : 'zext')) {
    return o.operands[0] === m.src && o.attrs.width === m.width;
  }
  if (o.opcode !== (m.signed ? 'shr_s' : 'shr_u') || o.operands.length !== 1) {
    return false;
  }
  const l = 32 - m.width;
  const r = o.attrs.imm;
  const d = defs.get(o.operands[0]);
  return (
    d?.opcode === 'shl' &&
    d.operands.length === 1 &&
    d.operands[0] === m.src &&
    d.attrs.imm === l &&
    typeof r === 'number' &&
    r > 0 &&
    r <= l
  );
}

/** Every fused pair in `fn` AS THE FOLD TAKES IT, keyed by its right shift: the shape, minus a pair
 *  with a same-sign sibling in its block. THE ONE READING — the fold and raise/globalshape.ts's
 *  stride reader both ask here, and both before any pair is rewritten; a reader that took a pair the
 *  fold leaves raw would license an element scale that no pass below legalizes. The TARGET half of
 *  the gate is the caller's: the pass list gates the fold, and globalshape asks
 *  {@link foldsShiftPairCasts} before it reads. */
export function foldablePairs(fn: Fn, defs: Map<Value, Op> = defOpMap(fn)): Map<Op, ScaledExtension> {
  const out = new Map<Op, ScaledExtension>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const m = scaledExtensionOf(op, defs);
      if (m !== null && !b.ops.some((o) => o !== op && narrowsLike(o, m, defs))) {
        out.set(op, m);
      }
    }
  }
  return out;
}

/** What the fold made, for the two passes that read it later: raise/paramwidth.ts's
 *  `fused-behind-pool` gate and {@link restoreUnclaimedScales}. One per pre-recovery run
 *  (`PreRecoveryFacts.scales`), keyed by op identity. */
export interface ScaleRecord {
  /** each scale the fold made → the extension it reads and the pair it replaced */
  folded: Map<Op, { ext: Op; l: number; r: number }>;
  /** the extensions over an entry parameter whose `shl` the machine ran behind a pool load */
  behindPool: Set<Op>;
}

export const emptyScaleRecord = (): ScaleRecord => ({ folded: new Map(), behindPool: new Set() });

/** Rewrite every fused pair to `shl(ext(src), shift)`, the extension spliced in at the `shl`'s
 *  position and the scale at the right shift's, and write what it made into `record`. Returns the
 *  number of pairs folded; the `shl`s left without a reader are the pass driver's DCE. `order` is
 *  the lifted-order fact the driver read before `addrnum` (`PreRecoveryFacts.poolOrder`); the
 *  default reads it off `fn` itself, which is right only while `fn`'s entry block is still in lifted
 *  order — a test's parsed IR. */
export function foldScaledExtensions(
  fn: Fn,
  order: PoolOrder = poolOrderOf(fn),
  record: ScaleRecord = emptyScaleRecord(),
): number {
  const defs = defOpMap(fn);
  const blockOf = new Map<Op, Block>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      blockOf.set(op, b);
    }
  }
  const exts = new Map<Op, Map<boolean, Op>>();
  let folded = 0;
  for (const [op, m] of foldablePairs(fn, defs)) {
    const bySign = exts.get(m.inner) ?? exts.set(m.inner, new Map()).get(m.inner)!;
    let ext = bySign.get(m.signed);
    if (ext === undefined) {
      ext = mkOp(m.signed ? 'sext' : 'zext', {
        operands: [m.src],
        results: [mkValue(m.inner.results[0].type)],
        attrs: { width: m.width },
      });
      const home = blockOf.get(m.inner)!;
      home.ops.splice(home.ops.indexOf(m.inner), 0, ext);
      if (order.entryParams.has(m.src) && order.afterPoolLoad.has(m.inner)) {
        record.behindPool.add(ext);
      }
      bySign.set(m.signed, ext);
    }
    const scaled = mkOp('shl', {
      operands: [ext.results[0]],
      results: [mkValue(op.results[0].type)],
      attrs: { imm: m.shift },
    });
    const b = blockOf.get(op)!;
    b.ops.splice(b.ops.indexOf(op), 1, scaled);
    replaceAllUsesWith(fn, op.results[0], scaled.results[0]);
    record.folded.set(scaled, { ext, l: 32 - m.width, r: 32 - m.width - m.shift });
    folded++;
  }
  return folded;
}

/** Put back the machine's own pair wherever no pass below claimed what the fold exposed. Returns
 *  the number of scales restored; an extension left without a reader is the driver's DCE.
 *
 *  A scale is CLAIMED when it no longer reads the fold's extension — raise/paramwidth.ts or
 *  raise/narrowlocal.ts retyped the value and dropped the extension, so the scale now reads that
 *  value — or when it is gone, legalized into an element index by raise/arrays.ts or
 *  raise/struct-arrays.ts. Anything else still reads the extension, and is rewritten in place (same
 *  result value, same position) to `shr(shl(src, L), R)`, with the `shl` where the extension stood:
 *  the ops the frontend lifted, in the order it lifted them. */
export function restoreUnclaimedScales(fn: Fn, record: ScaleRecord): number {
  const shls = new Map<Op, Op>();
  let restored = 0;
  for (const b of fn.blocks) {
    for (const op of [...b.ops]) {
      const f = record.folded.get(op);
      if (f === undefined || op.opcode !== 'shl' || op.operands[0] !== f.ext.results[0]) {
        continue;
      }
      // The pair is rebuilt from the amounts RECORDED at the fold, so they must still be the ones
      // the two ops carry: a pass that re-scaled the `shl` or re-widened the extension in place
      // would make the recorded pair compute a different value. None does today; refuse, not guess.
      const extended = f.ext.opcode === 'zext' || f.ext.opcode === 'sext';
      if (!extended || f.ext.attrs.width !== 32 - f.l || op.attrs.imm !== f.l - f.r) {
        continue;
      }
      let shl = shls.get(f.ext);
      if (shl === undefined) {
        const home = fn.blocks.find((x) => x.ops.includes(f.ext))!;
        shl = mkOp('shl', {
          operands: [f.ext.operands[0]],
          results: [mkValue(f.ext.results[0].type)],
          attrs: { imm: f.l },
        });
        home.ops.splice(home.ops.indexOf(f.ext), 0, shl);
        shls.set(f.ext, shl);
      }
      op.opcode = f.ext.opcode === 'sext' ? 'shr_s' : 'shr_u';
      op.operands = [shl.results[0]];
      op.attrs = { imm: f.r };
      record.folded.delete(op);
      restored++;
    }
  }
  return restored;
}
