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
//   ORDER — the pool load precedes every scaling of the index, in EVERY access of the name. agbcc
//     CSEs the pool word, so a function that subscripts one global twice has ONE `ldr` and both
//     accesses are ordered against it; the earliest scaling is what decides, which is why one
//     index-first access refuses the whole symbol (`index-materialized-first`). Compiled, that is
//     the right reading: `gTbl[i] + ((u16 *)gTbl)[j]` is the SAME object as `gTbl[i] + gTbl[j]`,
//     while `((u16 *)gTbl)[i] + ((u16 *)gTbl)[j]` is a different one — so a mixed function is
//     decided by its first access and nothing after it is observable
//     (cli/test/matching/array-shape-licence.test.ts compiles all three).
//
//     Observable only at element width > 1: at width 1 there is nothing to scale, so the base
//     `ldr` comes first whatever the source wrote — measured, `extern u8 g[]; g[i]` and
//     `((u8 *)g)[i]` are byte-identical — and the order says nothing.
//   A CONSTANT ON THE INDEX — the address adds a constant to the INDEX at run time while the
//     pool word's relocation addend stays zero. agbcc folds a constant added to any pointer or
//     cast base into that addend (`gcc/explow.c plus_constant_wide`, and gcc/thumb.h's
//     `LEGITIMIZE_ADDRESS` is empty, so nothing splits it back), so a runtime `add` against a bare
//     `.word gSym` is a shape only the array subscript produces. Available at every width.
//
// WHAT REFUSES — and the list is DOWN THERE, not here. The refusals are two `Gate<Ctx>` tables
// (`ADDRESS_GATES` and `SHAPE_GATES`, below), each rule carrying its own `why` and the test that
// fails without it, because an enumeration in a header is prose that nothing re-checks: this
// module's first version numbered six refusals in this spot and TWO of the numbers were attached
// to the wrong rule. Every rejection falls back to today's cast spelling rather than guessing.
//
// One thing about them belongs here rather than on a table entry, because it is about the pair.
// THE ELEMENT HALF AND THE RANK HALF ARE ONE DERIVATION, not two commits: a multi-stride address
// spelled through a rank-1 declaration is a FLAT subscript, and compiled against `tblrank2`'s
// target the flat spelling scores 4 (the other operand order 6) where the declared rank scores 0
// and the cast form it would replace scores 3. So a shape is minted with every dimension it needs
// or not at all. On that row a SECOND, independent gate also refuses the flat form —
// `elementIndex` (structure/globalaccess.ts) divides a residual into elements only when it is
// already one scaled term, never a sum — so `strides-do-not-nest` is the rule stated where the
// shape is decided, not the only thing standing between that row and the worse spelling.
//
// WHAT THE DERIVATION GIVES UP, stated because it is the fallback's whole value. `((T *)&gSym)[i]`
// reproduces the target's bytes under ANY declaration of `gSym`; the bare `gSym[i]` means what the
// declaration says it means. asmlift's answer is therefore the source PLUS the declaration it
// derived, and the two are only right together — which is why the shape travels out of every entry
// path (`DecompileResult.assumedSymbols`, `TraceReport.assumedSymbols`, the cli's `[assumed]` and
// `[declared]` blocks) rather than being applied and forgotten.
//
// The element WIDTH is forced by the evidence: a wrong width would have strided differently in the
// asm, and at width 1 `relocation-addend` covers the remaining case. The element SIGNEDNESS is NOT — it is a
// PICK, and the two readings are the same object. Compiled through the benchmark's own agbcc
// command (`-mthumb-interwork -Wimplicit -O2 -fhex-asm -fprologue-bugfix`):
//
//     u32 f(s32 i) { return (u16)gS[i]; }   over  extern const s16 gS[];   ldr / lsl / add / ldrh
//     u32 f(s32 i) { return gS[i]; }        over  extern const u16 gS[];   ldr / lsl / add / ldrh
//
// — byte-identical objects. So a project whose own header says `s16` compiles this module's bare
// spelling to `ldrsh` and gets different bytes, while the cast form it replaced would have been
// right beside either header. `pokeemerald:Sin2` and `sa3:sa2__sub_8083504` are two real benchmark
// rows in exactly that position. This is a fitted declaration in declare.ts's sense — a sound
// ARTIFACT (the decls and the source really do compile to those bytes) and an unsound CLAIM if the
// decls are hidden — so it is minted, and it is never hidden.
//
// LEVEL. L1-derived, L2-shaped, L3-consumed: it runs on the LIFTED function, because the fact it
// needs — the order the compiler materialized the base in — is destroyed by the raising tower
// (array LEGALIZATION — `recognizeArrays`, raise/arrays.ts, run as pre-recovery.ts's `arrays`
// step, and NOT the patterns-as-data idiom fold, which cannot state the `1 << shiftImm ==
// accessWidth` relation the match needs — rewrites `gaddr; shl; add; load` into one `aload` and
// the two orders become the same IR; `harr` and `arrcast` lift to different IR and recover to
// byte-identical IR, which is why this cannot live any later). Its output is a name-keyed
// `SymbolInfo` map, the same shape a symbol map supplies, consumed by
// `StructureOptions.inferredSymbols` and by the declaration synthesis — and it NEVER claims a
// name a real map describes, which knows more.
// That precedence is enforced TWICE, and both are needed: `structure()` asks the map first, and
// rank.ts DELETES a map-known name from this map before structuring, because the `/raw-globals`
// arm structures with no map and declares with one (see the filter's own note there).
//
// PER-COMPILER. The fork above is agbcc's. Whether ido/kmc/mwcc distinguish the two spellings at
// all was not measured, so the gate is a `compilerBehaviors` opt-in rather than a universal:
// a compiler earns it by showing the same compiled divergence.
import { type Fn, type Op, type Value, defOpMap } from '../ir/core';
import { type Gate, firstRejection } from '../l3/gates';
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

// ── the refusals, as DATA ────────────────────────────────────────────────────────────────────
//
// Two tables, because the decision has two stages with different subjects. `ADDRESS_GATES` runs
// per USE of the symbol's address and answers "is this an element address at all"; one rejection
// there refuses the WHOLE symbol, because what is being derived is a DECLARATION. `SHAPE_GATES`
// then runs once over everything the surviving accesses evidence and answers "does one array
// declaration describe them all". Both are `Gate<Ctx>` tables (l3/gates.ts) rather than an `||`
// chain for the reason that file exists: a refusal a pass's soundness rests on has to be
// ABLATABLE — `without(GATES, id)` re-runs the real predicate on real input — and attributable,
// so `firstRejection` names the one rule that decided rather than the set that co-occurred.
//
// THAT DISTINCTION IS NOT COSMETIC HERE, and the three readings of "what is this rule worth" pull
// apart. Instrumented over the 359 benchmark agbcc target functions that lift (7 of which derive a
// shape), per rule: how many symbols it would reject ON ITS OWN, how many it is the FIRST to
// reject, and how many functions' derived maps change when it alone is removed from the table —
//
//     address-escapes            141    137    0
//     interior-or-non-access      33     24    1
//     relocation-addend           27     17    0
//     stride-is-not-the-element    25      0    0
//     no-positive-evidence         23      6    4
//     no-subscript                 21      0    0
//     index-materialized-first      8      5    0
//     residual-not-a-sum            3      2    0
//     mixed-access-width            2      0    0
//     (the other five)              0      0    0
//
// — so twelve of the fourteen rules change nothing on this corpus when removed, and the rule the
// first column nominates loudest is one of them: `address-escapes` rejects 141 symbols, is FIRST
// for 137, and moves NOTHING. On this corpus the uses it rejects are the symbol's only ones, so
// with the rule gone they simply contribute no access and the name ends with nothing to shape —
// same outcome, and the rule's value there is the ATTRIBUTION. It is still `sound`, because a
// symbol that has a good access ALONGSIDE an escaping one does derive without it, which is a wrong
// answer and is the fixture the ablation test uses. Co-occurrence is not reach either:
// `no-subscript` would reject 21 symbols and is first for none of them. That does NOT make the twelve
// decoration — each is right about a shape, and the ablation test beside this module ablates every
// rule on a fixture that DOES reach it, where eight of the thirteen are the only thing standing
// between that fixture and a derivation. What it does mean is that "which refusal protects which
// row" has to be asked of `arrayShapeRefusals` and never read off a comment: this module's first
// version enumerated six refusals in prose and put two of them on the wrong rule.

/** One USE of a symbol's address, reduced to the facts `ADDRESS_GATES` decide over. */
interface AddressUse {
  /** the use is the `add` that forms an element address */
  readonly isAdd: boolean;
  /** the add's other operand is a constant — the relocation addend, which the frontend's pool
   *  grammar spells out as `add(gaddr, const)` */
  readonly addendIsConst: boolean;
  /** the residual's additive terms, or null when the tree is not a plain sum this walk can read */
  readonly terms: Term[] | null;
  /** every consumer of the computed address: whether each is a whole-element load/store at
   *  displacement 0 */
  readonly consumers: readonly { readonly isElementAccess: boolean }[];
}

/** Is this use of `&gSym` an element address, and only that? Order is the attribution: the first
 *  rejection is the rule that decided. */
export const ADDRESS_GATES: readonly Gate<AddressUse>[] = [
  {
    id: 'address-escapes',
    why: 'the address is used as something other than the base of one element-address add',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: the address escaping to a callee refuses the whole symbol',
    rejects: (u) => !u.isAdd,
  },
  {
    // ATTRIBUTING, NOT UNIQUELY LOAD-BEARING, and provably so: `other` is a constant here, so the
    // residual is a lone constant term and `no-subscript` refuses the same symbol with this rule
    // removed. It is FIRST because it names the real cause — this is the `arrbias` control, whose
    // pool word is `.word gTbl+0x1` — and a refusal that names the wrong cause is how this module
    // shipped two wrong attributions.
    id: 'relocation-addend',
    why: 'a constant added straight to the address IS the relocation addend, and belongs to the base',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: a non-zero relocation addend refuses the symbol outright',
    rejects: (u) => u.addendIsConst,
  },
  {
    // Attributing: with it removed the whole residual reduces to one scaled term and
    // `stride-is-not-the-element` refuses the same symbol.
    id: 'residual-not-a-sum',
    why: 'a `sub` makes a term’s sign depend on the walk, and a negative stride is not a subscript',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: a subtracted term in the residual refuses',
    rejects: (u) => u.isAdd && u.terms === null,
  },
  {
    id: 'address-unused',
    why: 'a computed element address nothing reads evidences nothing either way',
    sound: false,
    rejects: (u) => u.isAdd && u.consumers.length === 0,
  },
  {
    // Attributing: the `bgarr` shape it names — a 28-byte element read 2 bytes at a time — is also
    // refused by `stride-is-not-the-element` one table later. THIS is the rule that decides it,
    // which the module note used to credit to the stride rule.
    id: 'interior-or-non-access',
    why: 'a non-zero displacement reads an INTERIOR of the element, which a whole-element subscript cannot spell',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: an element read at a displacement INSIDE it keeps the cast spelling',
    rejects: (u) => u.consumers.some((c) => !c.isElementAccess),
  },
];

/** Everything one symbol's surviving accesses evidence, reduced to the facts `SHAPE_GATES` decide
 *  over. Per-access fields stay per-access on purpose: a rank is a property of ONE address
 *  expression, never of the union of several (see `ranks-disagree`). */
interface ShapeEvidence {
  /** distinct access widths under this name */
  readonly widths: number[];
  /** distinct extensions, a store's implicit `false` included */
  readonly signs: boolean[];
  readonly perAccess: readonly {
    /** ascending distinct strides of the non-constant terms; `[]` = the address names no subscript */
    readonly strides: number[];
    /** the inner extents those strides nest into, or null when they do not nest */
    readonly extents: number[] | null;
    /** a constant term that is not a whole number of elements — a mid-element displacement */
    readonly midElementConst: boolean;
    /** the order licence for this access (see `baseFirst`) */
    readonly baseFirst: boolean | undefined;
  }[];
  /** some access adds a non-zero constant on the INDEX side */
  readonly constOnIndex: boolean;
}

/** Does ONE array declaration describe every access of this name? Each rejection falls back to
 *  `((T *)&gSym)[i]`, which is byte-identical under any declaration. */
export const SHAPE_GATES: readonly Gate<ShapeEvidence>[] = [
  {
    // Attributing on the fixture below: two widths normally come with two strides, so
    // `stride-is-not-the-element` refuses too. It is first because "one name, two element types"
    // is the reason, and the stride disagreement is its symptom.
    id: 'mixed-access-width',
    why: 'two widths under one name have no single element type to declare',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: two access widths under one name refuse',
    rejects: (e) => e.widths.length !== 1,
  },
  {
    // Asked only where it CHANGES the emitted bytes. A 4-byte element extends nothing, so
    // `bareArrayElement` ignores signedness there and a width-4 array both read and written would
    // otherwise refuse for a distinction the compiler cannot see.
    id: 'mixed-extension',
    why: 'the declared element type is the only thing in the emitted C saying how a sub-word read fills',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: one name read signed and unsigned refuses',
    rejects: (e) => e.widths[0] < 4 && e.signs.length !== 1,
  },
  {
    // Attributing: an address with no variable term also has no stride, so
    // `stride-is-not-the-element` refuses it. It is stated separately because "there is no
    // subscript here at all" and "the subscript scales by the wrong thing" are different facts.
    id: 'no-subscript',
    why: 'an address with no variable term names no element, so it evidences no array',
    sound: false,
    guardedBy: 'global-array-shape.test.ts: an access with no variable term refuses',
    rejects: (e) => e.perAccess.some((a) => a.strides.length === 0),
  },
  {
    id: 'stride-is-not-the-element',
    why: 'the innermost stride must BE the element the access reads whole, or the subscript scales by the wrong thing',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: an index pre-scaled past the element refuses',
    rejects: (e) => e.perAccess.some((a) => a.strides[0] !== e.widths[0]),
  },
  {
    id: 'strides-do-not-nest',
    why: 'strides that are not whole multiples of one another are not a declared rank at all',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: a stride that is not a whole multiple of the element refuses entirely',
    rejects: (e) => e.perAccess.some((a) => a.extents === null),
  },
  {
    // `build_array_ref` recurses once per subscript WITHIN one access, so nesting is a property of
    // a single address. Two accesses at strides 4 and 16 on a flat `extern s32 g[]` (`g[i]` and
    // `g[j * 4]`) are not a rank; unioning them declares `extern s32 g[][4]` and spells `g[0][i]`,
    // a positive claim about the object that the assembly does not make and that no longer
    // compiles against the project's own header.
    id: 'ranks-disagree',
    why: 'a rank is read off ONE address expression; two accesses must agree or there is no one declaration',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: two accesses at different strides are not a rank',
    rejects: (e) => new Set(e.perAccess.map((a) => JSON.stringify(a.extents))).size > 1,
  },
  {
    id: 'mid-element-constant',
    why: 'a constant that is not a whole number of elements is a displacement no subscript spells',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: a constant that is not a whole element refuses',
    rejects: (e) => e.perAccess.some((a) => a.midElementConst),
  },
  {
    // ONE index-first access refuses the WHOLE symbol, and that is where this rule is uniquely
    // load-bearing: on a single-access function `no-positive-evidence` would refuse anyway, but a
    // function that subscripts the name twice with only ONE of them index-first has positive
    // evidence and still must not derive. Compiled: `gTbl[i] + gTbl[j]` and
    // `gTbl[i] + ((u16 *)gTbl)[j]` are the SAME object, while `((u16 *)gTbl)[i] + ((u16 *)gTbl)[j]`
    // is a different one — and agbcc CSEs the pool word, so the first access's order is the only
    // place that difference shows.
    id: 'index-materialized-first',
    why: 'the index was scaled BEFORE the base was materialized — the pointer path, which is the cast spelling',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: one index-first access refuses a symbol the others license',
    rejects: (e) => e.perAccess.some((a) => a.baseFirst === false),
  },
  {
    id: 'no-positive-evidence',
    why: 'no order fact and no index-side constant: the two spellings are the same object, so a shape would be a guess',
    sound: true,
    guardedBy: 'global-array-shape.test.ts: no evidence at all — width 1, no constant — claims nothing',
    rejects: (e) => !(e.perAccess.some((a) => a.baseFirst === true) || e.constOnIndex),
  },
];

/** The two tables together, so a caller ablates one rule by name without knowing which stage owns
 *  it. Defaulted on `inferGlobalArrays`; a test passes an ablated pair. */
export interface ArrayShapeGates {
  readonly address: readonly Gate<AddressUse>[];
  readonly shape: readonly Gate<ShapeEvidence>[];
}
export const ARRAY_SHAPE_GATES: ArrayShapeGates = { address: ADDRESS_GATES, shape: SHAPE_GATES };

/** Op → (block index, op index), for the order comparison. */
function positions(fn: Fn): Map<Op, { b: number; i: number }> {
  const pos = new Map<Op, { b: number; i: number }>();
  fn.blocks.forEach((blk, b) => blk.ops.forEach((op, i) => pos.set(op, { b, i })));
  return pos;
}

/** Every op that reads `v` as an operand. Successor arguments count as uses too — a value handed
 *  across an edge leaves this function's address arithmetic, which `address-escapes` covers. */
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
function residualTerms(root: Value, defs: Map<Value, Op>): Term[] | null {
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
 *  whose uses `ADDRESS_GATES` rejects, the ID OF THE RULE that rejected it. The rejection is per
 *  SYMBOL and never withdrawn: what is being derived is a DECLARATION, and one use this spelling
 *  does not model makes the name keep the cast form everywhere. The id is carried rather than a
 *  bare null so a census asks which rule decided instead of re-deriving the predicates. */
function accessesBySymbol(fn: Fn, gates: readonly Gate<AddressUse>[]): Map<string, Access[] | { refusedBy: string }> {
  const defs = defOpMap(fn);
  const uses = useIndex(fn);
  const out = new Map<string, Access[] | { refusedBy: string }>();
  const refuse = (sym: string, id: string): void => void out.set(sym, { refusedBy: id });
  const record = (sym: string, a: Access): void => {
    const cur = out.get(sym);
    if (cur !== undefined && !Array.isArray(cur)) {
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
        const isAdd = u.opcode === 'add';
        const other = isAdd ? (u.operands[0] === base ? u.operands[1] : u.operands[0]) : undefined;
        const terms = other === undefined ? null : residualTerms(other, defs);
        const consumers = (isAdd ? (uses.get(u.results[0]) ?? []) : []).map((m) => {
          const isLoad = m.opcode === 'load' && m.operands[0] === u.results[0];
          const isStore = m.opcode === 'store' && m.operands[0] === u.results[0];
          return { m, isLoad, isStore, isElementAccess: (isLoad || isStore) && (m.attrs.off as number) === 0 };
        });
        const use: AddressUse = {
          isAdd,
          addendIsConst: other !== undefined && defs.get(other)?.opcode === 'const',
          terms,
          consumers,
        };
        const rejected = firstRejection(gates, use);
        if (rejected !== null) {
          refuse(sym, rejected);
          break;
        }
        // Only the whole-element accesses are evidence. Filtered rather than assumed: with
        // `interior-or-non-access` ABLATED (a test does exactly that) an interior read would
        // otherwise be recorded with an undefined width, and an ablation must remove a REFUSAL,
        // never manufacture a fact.
        for (const c of consumers.filter((x) => x.isElementAccess)) {
          record(sym, {
            width: c.m.attrs.width as number,
            signed: c.isLoad && (c.m.attrs.signed as boolean) === true,
            isLoad: c.isLoad,
            terms: terms ?? [],
            gaddr: g,
          });
        }
      }
    }
  }
  return out;
}

/** The distinct STRIDES of an access's non-constant terms, ascending. EMPTY when the access has
 *  no non-constant term (a pure constant address — `&gSym + K` — which names no subscript);
 *  `no-subscript` is the gate that reads that. Deduped and sorted, which is the precondition
 *  `extentsOf` relies on. */
function stridesOf(a: Access): number[] {
  return [...new Set(a.terms.filter((t) => t.v !== null).map((t) => t.scale))].sort((x, y) => x - y);
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

/** The shape one symbol's accesses evidence, or null where `SHAPE_GATES` rejects. Decided over
 *  ALL of the symbol's accesses at once, because what is being derived is a DECLARATION: one
 *  element type and one rank for the name, or none.
 *
 *  The ELEMENT SIGNEDNESS this returns is a PICK, not a reading — see the module note's compiled
 *  pair. It travels out as an assumption (`DecompileResult.assumedSymbols`) rather than being
 *  applied silently. */
function evidenceOf(accs: Access[], pos: Map<Op, { b: number; i: number }>): ShapeEvidence {
  const perAccess = accs.map((a) => {
    const strides = stridesOf(a);
    // `width` is only meaningful once `mixed-access-width` has admitted; that gate runs first,
    // so a mid-element test computed against the first width is never the one that decides.
    const width = accs[0].width;
    return {
      strides,
      extents: extentsOf(strides),
      midElementConst: a.terms.some((t) => t.v === null && t.konst % width !== 0),
      baseFirst: baseFirst(a, pos),
    };
  });
  return {
    widths: [...new Set(accs.map((a) => a.width))],
    signs: [...new Set(accs.map((a) => a.signed))],
    perAccess,
    constOnIndex: accs.some((a) => a.terms.some((t) => t.v === null && t.konst !== 0)),
  };
}

function shapeOf(
  accs: Access[],
  pos: Map<Op, { b: number; i: number }>,
  gates: readonly Gate<ShapeEvidence>[],
): SymbolInfo | null {
  if (accs.length === 0 || firstRejection(gates, evidenceOf(accs, pos)) !== null) {
    return null;
  }
  const perAccess = evidenceOf(accs, pos).perAccess;
  // The DECLARED signedness is the loads' — a store extends nothing, and `mixed-extension` has
  // already refused a name whose loads disagree at a width where it shows.
  const loadSigns = new Set(accs.filter((a) => a.isLoad).map((a) => a.signed));
  const dims = perAccess[0].extents ?? [];
  return {
    name: (accs[0].gaddr.attrs.sym as string) ?? '',
    kind: 'data',
    shape: 'array',
    elemSize: accs[0].width,
    elemSigned: loadSigns.size === 1 ? [...loadSigns][0] : false,
    ...(dims.length ? { dims: [null, ...dims] } : {}),
  };
}

/** The INNER extents of a declared rank, read out of ascending strides: each stride must be a
 *  whole multiple — at least 2× — of the one below it, or two positions in the array would be
 *  indistinguishable and the split would be a guess. Rank 1 is `[]`. */
function extentsOf(strides: number[]): number[] | null {
  const extents: number[] = [];
  for (let i = 1; i < strides.length; i++) {
    const k = strides[i] / strides[i - 1];
    // NOT AN INTEGER is the live half; `k < 2` is belt-and-braces on a precondition `stridesOf`
    // already establishes (it dedups through a Set and sorts, so consecutive strides are strictly
    // ascending and an integer ratio is at least 2). Kept as an assertion of what this function
    // needs from its caller, not as a rule with an inhabitant — an extent of 1 would make two
    // positions in the array name one cell.
    if (!Number.isInteger(k) || k < 2) {
      return null;
    }
    extents.unshift(k);
  }
  return extents;
}

/** Do two `SymbolInfo`s say the same thing about the ONE question the bare subscript asks — which
 *  object the name denotes, cell by cell? Every field `bareArrayElement` / `bareArrayLead` /
 *  `declaredSubscripts` (structure/globalaccess.ts) and the array branch of the declaration
 *  renderer (declare.ts) read, and nothing else: two entries agreeing here spell and declare the
 *  same addresses whichever one a consumer picked up.
 *
 *  This exists because the SPELLING and the DECLARATION are decided from different derivations —
 *  rank.ts derives the declaration dictionary once off the probe's lift and the spelling per
 *  symbol variant off that variant's own — and a candidate that spells from one and declares from
 *  the other addresses a different object than the assembly did, compiling either way. */
export function sameDerivedShape(a: SymbolInfo | undefined, b: SymbolInfo | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const dims = (i: SymbolInfo): string => JSON.stringify(i.shape === 'array' ? (i.dims ?? null) : null);
  return (
    a.shape === b.shape &&
    a.elemSize === b.elemSize &&
    (a.elemSigned ?? false) === (b.elemSigned ?? false) &&
    dims(a) === dims(b)
  );
}

/** The array shapes `fn`'s own assembly evidences for the globals it names, keyed by name.
 *
 *  Runs on the LIFTED function (see the module note: the raising tower destroys the order the
 *  licence reads). Empty for every target that has not opted in, and empty where nothing is
 *  evidenced — never a partial guess. */
export function inferGlobalArrays(
  fn: Fn,
  target: TargetDescription,
  gates: ArrayShapeGates = ARRAY_SHAPE_GATES,
): Map<string, SymbolInfo> {
  const out = new Map<string, SymbolInfo>();
  if (target.compilerBehaviors.arrayShapeFromStride !== true) {
    return out;
  }
  const pos = positions(fn);
  for (const [sym, accs] of accessesBySymbol(fn, gates.address)) {
    const si = Array.isArray(accs) ? shapeOf(accs, pos, gates.shape) : null;
    if (si !== null) {
      out.set(sym, si);
    }
  }
  return out;
}

/** Which rule refused each name this function's pool spells, or null where a shape was derived —
 *  the attribution `firstRejection` exists for. NOT on the shipped path: a caller instrumenting a
 *  refusal (a census, a plan that needs the FIRST guard rather than the co-occurring set) asks
 *  here instead of re-deriving the predicates, which is how the two wrong attributions this
 *  module's prose used to carry were found. */
export function arrayShapeRefusals(
  fn: Fn,
  target: TargetDescription,
  gates: ArrayShapeGates = ARRAY_SHAPE_GATES,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (target.compilerBehaviors.arrayShapeFromStride !== true) {
    return out;
  }
  const pos = positions(fn);
  for (const [sym, accs] of accessesBySymbol(fn, gates.address)) {
    out.set(
      sym,
      Array.isArray(accs)
        ? accs.length === 0
          ? 'no-accesses'
          : firstRejection(gates.shape, evidenceOf(accs, pos))
        : accs.refusedBy,
    );
  }
  return out;
}
