// asmlift — ARRAY SHAPE FOR A GLOBAL NO SYMBOL MAP DESCRIBES, derived from the assembly's own
// stride evidence.
//
// WHAT IS MISSING WITHOUT THIS. asmlift can already spell a named global's element access two
// ways: `((u16 *)&gTbl)[i]` (always available, valid under any declaration) and the bare
// `gTbl[i]` (only when a SYMBOL MAP declares `gTbl` an array — structure/globalaccess.ts
// `bareArrayElement`). Map-less, only the first exists. On agbcc the two are DIFFERENT OBJECTS,
// and the difference is visible in the input assembly:
//
//     gTbl[i]            ldr r1, .L3 ; lsl r0, r0, #1 ; add r0, r0, r1 ; ldrh   <- BASE first
//     ((u16 *)gTbl)[i]   lsl r0, r0, #1 ; ldr r1, .L3 ; add r0, r0, r1 ; ldrh   <- INDEX first
//
// The mechanism is agbcc's own `build_array_ref` (gcc/c-typeck.c), which forks on
// `TREE_CODE (TREE_TYPE (array)) == ARRAY_TYPE && TREE_CODE (array) != INDIRECT_REF`: an
// array-typed OBJECT expands its base ahead of the subscript, every other base takes the pointer
// path and is expanded last. So the instruction order is EVIDENCE about how the source spelled
// the base, and this module reads it.
//
// THE LICENCE IS THE ASSEMBLY, NEVER A PREFERENCE. Deriving a shape here changes the DEFAULT
// spelling of every access to that symbol (it does not add a candidate), so a shape is minted
// only where the asm says the source subscripted a declared array, and the fallback everywhere
// else is the cast form — byte-identical under any declaration. Two independent kinds of
// evidence license it, and they answer at different element widths:
//
//   ORDER — the pool load precedes every scaling of the index. Observable only at element width
//     > 1: at width 1 there is nothing to scale, so the base `ldr` comes first whatever the
//     source wrote, and the order says nothing.
//   A CONSTANT ON THE INDEX — the address adds a constant to the INDEX at run time while the
//     pool word's relocation addend stays zero. agbcc folds a constant added to any pointer or
//     cast base into that addend (`gcc/explow.c plus_constant_wide`, and gcc/thumb.h's
//     `LEGITIMIZE_ADDRESS` is empty, so nothing splits it back), so a runtime `add` against a bare
//     `.word gSym` is a shape only the array subscript produces. Available at every width.
//
// WHAT REFUSES, and each refusal falls back to today's cast spelling rather than guessing:
//
//   1. THE RELOCATION ADDEND IS NON-ZERO — the frontend spells `.word gSym+N` as an explicit
//      `add(gaddr, const)` (frontend/thumb.ts's pool grammar), so the refusal is "the gaddr is
//      consumed by an add with a constant operand". This is the `arrbias` direction: the
//      constant belongs in the BASE there, and three different spellings reach that pool word,
//      so nothing licenses an array.
//   2. THE ADDRESS ESCAPES — any use of the symbol's address that is not "one add, feeding
//      loads/stores at offset 0". A call argument, a comparison, a direct load off the base, a
//      non-zero displacement: all say the symbol is being used as something this spelling does
//      not model, and one such use refuses the WHOLE symbol (a declaration is per symbol, not
//      per access).
//   3. THE ACCESSES DISAGREE — two widths or two load signednesses under one name. The bare
//      spelling carries no cast, so the declared element type is the only thing in the emitted C
//      that says how a sub-word read extends; a symbol read two ways has no single answer.
//   4. THE STRIDE IS NOT THE ACCESS WIDTH — the innermost stride in the address is not the width
//      the load read (a 28-byte struct element read 2 bytes at a time, the `bgarr` shape). A
//      declaration minted here would say `elemSize` 28 while the spelling reads 2, and the
//      SUBSCRIPT would then scale by the wrong thing — the same conjunct `bareArrayElement`
//      (structure/globalaccess.ts) enforces on the access side, asked once more where the
//      declaration is invented. Reaching that shape needs an element TYPE this derivation has no
//      way to name, which is a second capability, not a relaxation of this one.
//   5. THE STRIDES DO NOT NEST — two strides where the outer is not a whole multiple, at least
//      2x, of the one below it. An extent of 1 makes two positions in the array
//      indistinguishable, and a non-multiple is not a rank at all.
//
//      This is also why the element half and the RANK half are ONE derivation rather than two
//      commits: a multi-stride address spelled through a rank-1 declaration is a FLAT subscript,
//      and compiled against `tblrank2`'s target the flat spelling scores 4 (the other operand
//      order 6) where the declared rank scores 0 and the cast form it would replace scores 3. So
//      a shape is minted with every dimension it needs or not at all. NOTE what this refusal is
//      and is not: on that row a SECOND, independent gate also refuses the flat form —
//      `elementIndex` (structure/globalaccess.ts) divides a residual into elements only when it is
//      already one scaled term, never a sum — so the refusal here is the rule stated where the
//      shape is decided, not the only thing standing between that row and the worse spelling.
//   6. NO POSITIVE EVIDENCE — no order fact and no index-side constant. At element width 1 with
//      no constant term the two spellings are BYTE-IDENTICAL, so there is nothing to gain and a
//      derivation without evidence is a guess.
//
// LEVEL. L1-derived, L2-shaped, L3-consumed: it runs on the LIFTED function, because the fact it
// needs — the order the compiler materialized the base in — is destroyed by the raising tower
// (the array-idiom fold rewrites `gaddr; shl; add; load` into one `aload` and the two orders
// become the same IR; `harr` and `arrcast` lift to different IR and recover to byte-identical
// IR, which is why this cannot live any later). Its output is a name-keyed `SymbolInfo` map, the
// same shape a symbol map supplies, consumed by `StructureOptions.inferredSymbols` and by the
// declaration synthesis — and it NEVER claims a name a real map describes, which knows more.
// That precedence is enforced TWICE, and both are needed: `structure()` asks the map first, and
// rank.ts DELETES a map-known name from this map before structuring, because the `/raw-globals`
// arm structures with no map and declares with one (see the filter's own note there).
//
// PER-COMPILER. The fork above is agbcc's. Whether ido/kmc/mwcc distinguish the two spellings at
// all was not measured, so the gate is a `compilerBehaviors` opt-in rather than a universal:
// a compiler earns it by showing the same compiled divergence.
import { type Fn, type Op, type Value, defOpMap } from '../ir/core';
import type { SymbolInfo } from '../symbols';
import type { TargetDescription } from '../target';

/** One additive term of an address residual: `v` scaled by `scale`, or a pure constant.
 *  `scaleOp` is the op that DID the scaling (a `shl`/`mul`), which is what carries the position
 *  the order licence reads; a term at scale 1 has none. */
interface Term {
  scale: number;
  /** null ⇒ a constant term, whose value is `konst` */
  v: Value | null;
  konst: number;
  scaleOp: Op | null;
}

/** One access of a global's address: the byte residual's terms plus how the cell was read.
 *  `signed` is the extension the BARE spelling would have to carry — a load's own signedness, and
 *  `false` for a store, which is what structure.ts passes when it asks whether the bare form is
 *  spellable. Keeping the store's answer in the same set is what makes "every access of this
 *  symbol spells bare" a single `size === 1` test. */
interface Access {
  width: number;
  signed: boolean;
  isLoad: boolean;
  terms: Term[];
  gaddr: Op;
}

/** REFUSAL, spelled as a value so every refusing path is one `return null`. */
type Refusal = null;

/** Op → (block index, op index), for the order comparison. */
function positions(fn: Fn): Map<Op, { b: number; i: number }> {
  const pos = new Map<Op, { b: number; i: number }>();
  fn.blocks.forEach((blk, b) => blk.ops.forEach((op, i) => pos.set(op, { b, i })));
  return pos;
}

/** Every op that reads `v` as an operand. Successor arguments count as uses too — a value handed
 *  across an edge leaves this function's address arithmetic, which refusal 2 covers. */
function useIndex(fn: Fn): Map<Value, Op[]> {
  const uses = new Map<Value, Op[]>();
  const add = (v: Value, op: Op): void => {
    uses.set(v, [...(uses.get(v) ?? []), op]);
  };
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.operands.forEach((o) => add(o, op));
      op.successors.forEach((s) => s.args.forEach((a) => add(a, op)));
    }
  }
  return uses;
}

/** `x * K` / `x << k` read as a scale, or scale 1 for anything else. A CONSTANT operand makes the
 *  whole term constant instead (`const << 2` is a displacement, not a subscript). */
function scaleOf(v: Value, defs: Map<Value, Op>): Term {
  const d = defs.get(v);
  const constOf = (x: Value): number | null => {
    const dx = defs.get(x);
    return dx?.opcode === 'const' ? (dx.attrs.value as number) : null;
  };
  if (d?.opcode === 'const') {
    return { scale: 0, v: null, konst: d.attrs.value as number, scaleOp: null };
  }
  if (d?.opcode === 'shl' && d.operands.length === 1 && typeof d.attrs.imm === 'number') {
    const k = d.attrs.imm;
    const inner = constOf(d.operands[0]);
    if (inner !== null) {
      return { scale: 0, v: null, konst: inner << k, scaleOp: null };
    }
    return k > 0 && k < 31
      ? { scale: 1 << k, v: d.operands[0], konst: 0, scaleOp: d }
      : { scale: 1, v, konst: 0, scaleOp: null };
  }
  if (d?.opcode === 'mul') {
    for (const [a, b] of [
      [d.operands[0], d.operands[1]],
      [d.operands[1], d.operands[0]],
    ] as const) {
      const k = constOf(b);
      if (k !== null && k > 0 && constOf(a) === null) {
        return { scale: k, v: a, konst: 0, scaleOp: d };
      }
    }
  }
  return { scale: 1, v, konst: 0, scaleOp: null };
}

/** The additive terms of a byte residual. Only `add` is opened: a `sub` at the top of the tree
 *  makes a term's sign depend on the walk, and a NEGATIVE stride is not an array subscript this
 *  spelling can express, so it refuses rather than dropping the sign. */
function residualTerms(root: Value, defs: Map<Value, Op>): Term[] | Refusal {
  const out: Term[] = [];
  const walk = (v: Value, depth: number): boolean => {
    if (depth > 16) {
      return false; // a pathological address tree: refuse rather than walk it
    }
    const d = defs.get(v);
    if (d?.opcode === 'sub') {
      return false;
    }
    if (d?.opcode === 'add') {
      return walk(d.operands[0], depth + 1) && walk(d.operands[1], depth + 1);
    }
    out.push(scaleOf(v, defs));
    return true;
  };
  return walk(root, 0) ? out : null;
}

/** Every access of every named data global in `fn`, keyed by symbol — or, for a symbol any of
 *  whose uses refuses (see refusals 1 and 2 in the module note), NO entry at all. */
function accessesBySymbol(fn: Fn): Map<string, Access[] | Refusal> {
  const defs = defOpMap(fn);
  const uses = useIndex(fn);
  const out = new Map<string, Access[] | Refusal>();
  const refuse = (sym: string): void => void out.set(sym, null);
  const record = (sym: string, a: Access): void => {
    const cur = out.get(sym);
    if (cur === null) {
      return; // already refused: a refusal is per SYMBOL and never withdrawn
    }
    out.set(sym, [...(cur ?? []), a]);
  };
  for (const b of fn.blocks) {
    for (const g of b.ops) {
      if (g.opcode !== 'gaddr' || typeof g.attrs.sym !== 'string' || g.attrs.code === true) {
        continue;
      }
      const sym = g.attrs.sym;
      const base = g.results[0];
      const gUses = uses.get(base) ?? [];
      if (gUses.length === 0) {
        continue; // a dead address: no evidence either way, and nothing to spell
      }
      for (const u of gUses) {
        // REFUSAL 2 — the address is used as anything but the base of one address `add`.
        if (u.opcode !== 'add') {
          refuse(sym);
          break;
        }
        const other = u.operands[0] === base ? u.operands[1] : u.operands[0];
        // REFUSAL 1 — a constant added straight to the address IS the relocation addend.
        if (defs.get(other)?.opcode === 'const') {
          refuse(sym);
          break;
        }
        const terms = residualTerms(other, defs);
        if (terms === null) {
          refuse(sym);
          break;
        }
        const addrUses = uses.get(u.results[0]) ?? [];
        if (addrUses.length === 0) {
          refuse(sym);
          break;
        }
        let ok = true;
        for (const m of addrUses) {
          const isLoad = m.opcode === 'load' && m.operands[0] === u.results[0];
          const isStore = m.opcode === 'store' && m.operands[0] === u.results[0];
          // REFUSAL 2, continued: a non-zero displacement reads an INTERIOR of the element, which
          // the whole-element subscript has no place to put.
          if ((!isLoad && !isStore) || (m.attrs.off as number) !== 0) {
            ok = false;
            break;
          }
          record(sym, {
            width: m.attrs.width as number,
            signed: isLoad && (m.attrs.signed as boolean) === true,
            isLoad,
            terms,
            gaddr: g,
          });
        }
        if (!ok) {
          refuse(sym);
          break;
        }
      }
    }
  }
  return out;
}

/** The distinct STRIDES of an access's non-constant terms, ascending; null when the access has
 *  no non-constant term (a pure constant address — `&gSym + K` — which names no subscript). */
function stridesOf(a: Access): number[] | Refusal {
  const s = [...new Set(a.terms.filter((t) => t.v !== null).map((t) => t.scale))].sort((x, y) => x - y);
  return s.length === 0 ? null : s;
}

/** THE ORDER LICENCE for one access, as a three-valued answer: `true` = every scaling of the
 *  index happens AFTER the base was materialized (the array-subscript shape), `false` = at least
 *  one happens before or in another block (the pointer shape, or evidence this walk cannot
 *  compare), `undefined` = nothing is scaled, so the order says nothing at all. */
function baseFirst(a: Access, pos: Map<Op, { b: number; i: number }>): boolean | undefined {
  const scalers = a.terms.map((t) => t.scaleOp).filter((o): o is Op => o !== null);
  if (scalers.length === 0) {
    return undefined;
  }
  const g = pos.get(a.gaddr);
  return scalers.every((o) => {
    const p = pos.get(o);
    return g !== undefined && p !== undefined && p.b === g.b && p.i > g.i;
  });
}

/** The shape one symbol's accesses evidence, or null for every refusal in the module note. Every
 *  refusal here is decided over ALL of the symbol's accesses at once, because what is being
 *  derived is a DECLARATION: one element type and one rank for the name, or none. */
function shapeOf(sym: string, accs: Access[], pos: Map<Op, { b: number; i: number }>): SymbolInfo | Refusal {
  const widths = new Set(accs.map((a) => a.width));
  if (widths.size !== 1) {
    return null; // REFUSAL 3, the width half
  }
  const width = [...widths][0];
  // REFUSAL 3, the signedness half — and it is asked only where it CHANGES the emitted bytes. A
  // 4-byte element extends nothing, so `bareArrayElement` ignores signedness there (a width-4
  // array read and written would otherwise refuse for a distinction the compiler cannot see); at
  // widths 1 and 2 the declared element type is the only thing in the emitted C saying how a
  // sub-word read fills, so every access — a store's implicit `false` included — must agree.
  const signs = new Set(accs.map((a) => a.signed));
  if (width < 4 && signs.size !== 1) {
    return null;
  }
  const loadSigns = new Set(accs.filter((a) => a.isLoad).map((a) => a.signed));
  const signed = loadSigns.size === 1 ? [...loadSigns][0] : false;
  let strides: number[] = [];
  let orderNo = false;
  let orderYes = false;
  let constOnIndex = false;
  for (const a of accs) {
    const s = stridesOf(a);
    if (s === null) {
      return null; // no subscript in this access — refusal 6, and it refuses the symbol
    }
    strides = [...new Set([...strides, ...s])].sort((x, y) => x - y);
    const bf = baseFirst(a, pos);
    orderNo ||= bf === false;
    orderYes ||= bf === true;
    // REFUSAL 4/6 support: a constant that is not a whole number of elements is a mid-element
    // displacement, which no subscript spells.
    for (const t of a.terms) {
      if (t.v === null) {
        if (t.konst % width !== 0) {
          return null;
        }
        constOnIndex ||= t.konst !== 0;
      }
    }
  }
  // REFUSAL 4 — the innermost stride IS the element, and the access reads it whole.
  if (strides[0] !== width) {
    return null;
  }
  // REFUSAL 5 — the declared rank, or nothing.
  const dims = extentsOf(strides);
  if (dims === null) {
    return null;
  }
  // REFUSAL 6 — no positive evidence, and evidence AGAINST is decisive.
  if (orderNo || !(orderYes || constOnIndex)) {
    return null;
  }
  return {
    name: sym,
    kind: 'data',
    shape: 'array',
    elemSize: width,
    elemSigned: signed,
    ...(dims.length ? { dims: [null, ...dims] } : {}),
  };
}

/** The INNER extents of a declared rank, read out of ascending strides: each stride must be a
 *  whole multiple — at least 2× — of the one below it, or two positions in the array would be
 *  indistinguishable and the split would be a guess. Rank 1 is `[]`. */
function extentsOf(strides: number[]): number[] | Refusal {
  const extents: number[] = [];
  for (let i = 1; i < strides.length; i++) {
    const k = strides[i] / strides[i - 1];
    if (!Number.isInteger(k) || k < 2) {
      return null;
    }
    extents.unshift(k);
  }
  return extents;
}

/** The array shapes `fn`'s own assembly evidences for the globals it names, keyed by name.
 *
 *  Runs on the LIFTED function (see the module note: the raising tower destroys the order the
 *  licence reads). Empty for every target that has not opted in, and empty where nothing is
 *  evidenced — never a partial guess. */
export function inferGlobalArrays(fn: Fn, target: TargetDescription): Map<string, SymbolInfo> {
  const out = new Map<string, SymbolInfo>();
  if (target.compilerBehaviors.arrayShapeFromStride !== true) {
    return out;
  }
  const pos = positions(fn);
  for (const [sym, accs] of accessesBySymbol(fn)) {
    const si = accs === null ? null : shapeOf(sym, accs, pos);
    if (si !== null) {
      out.set(sym, si);
    }
  }
  return out;
}
