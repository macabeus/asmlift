// L3 re-spelling lever: declare a recovered WORD field a POINTER (`void *field_4;` rather than
// `s32 field_4;`), and cast at each read.
//
// raise/structs.ts recovers a field's type from the ACCESS WIDTH alone — a 4-byte load is `s32`,
// because that is all a load says. On a 32-bit target `void *` fits the same evidence exactly:
// the two spellings load the same word with the same instruction, so the asm cannot referee them
// and the struct recovery's own byte-neutrality note applies to the field TYPE as much as to the
// `->field_N` vs `[idx]` question it was written about.
//
// IT IS NOT NEUTRAL TO THE COMPILER, which is the whole reason to spell it. A pointer and an `s32`
// are different alias sets, so under strict aliasing the loop optimizer may hoist a pointer field's
// load past an `s32`-typed store it must otherwise keep behind — and on synthetic:dmaptrsrc that
// hoist is the difference between a byte-exact match and a 32-point diff, once the accumulator is
// un-reduced back into the loop. Which side matches is per-field knowledge nothing in the asm
// carries, so both are enumerated and the differ referees.
//
// WHERE THE FLAG IS, because two readers have now looked for `-fstrict-aliasing` in the benchmark's
// agbcc line and not found it: it is not there, and it does not need to be. `-O2` turns it on
// (gcc 2.9 sets `flag_strict_aliasing` from `optimize >= 2`), which is why the CITATION is a
// behaviour rather than a flag. Verified in BOTH directions on this row's own shape, objects
// compared byte-for-byte:
//     `void *` field, harness flags        → the field load is HOISTED above the loop label
//     `s32`    field, harness flags        → it STAYS in the loop body
//     `void *` field, + -fno-strict-aliasing → byte-IDENTICAL to the `s32` build
//     `s32`    field, + -fstrict-aliasing    → byte-IDENTICAL to itself (the flag was already on)
// So adding the flag proves nothing and REMOVING it proves everything, which is the direction a
// reader checking this note should take. The stores the load is hoisted past are the loop's own
// `*(volatile s32 *)0x040000D4/D8/DC` device writes — `volatile` restricts what may be done with
// THOSE accesses and does not merge their type into the pointer's alias set.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION on a target whose pointers are 32 bits: the declaration
// changes, and every read is wrapped in a cast back to the field's own recovered integer type, so
// each use computes the same value it did. Nothing else moves. THE 32-BIT ASSUMPTION IS ASSERTED,
// NOT CHECKED — there is no pointer-width field on TargetDescription to check it against, and the
// assumption is already tower-wide (`l3/typing.ts`'s `ptrElemBytes` returns 4 for any pointee). On
// a 64-bit target this lever would change a struct's LAYOUT rather than only its spelling, so the
// width field is what that target's first row must add, and this note is where to start.
//
// IT FLIPS EVERY ADMITTED FIELD AT ONCE, and its own paragraph above says the knowledge is
// PER-FIELD — so the subset enumeration `l3/volatileptr.ts` does for exactly this reason
// (`volatileSubsetCandidates`, capped at three locals) is the shape this lever will eventually
// want. It is not built yet because nothing demands it: swept over 834 corpus trees, the lever
// fires on 42, and 34 of those have a single admitted field. The six 2-field trees and the two
// 4-field ones (`sa3:sa2__sub_8083504` flips Struct0.field_8/12 and Struct2.field_8/12 together)
// are where 1 of 3 and 1 of 15 non-empty subsets is reachable. A row that needs one of the missing
// subsets is what earns the enumeration — and it will cost candidates, which is why "it might
// help" is not enough.
//
// GATE (PTR_FIELD_GATES, read once per field): the field's recovered type must be a 32-bit
// integer; it must never be a store LVALUE (the write side would need a cast on the value, which
// is a second question); and it must never stand as the BASE of another access (a field the tree
// already dereferences is one the recovery typed from its own use, not from a width). Nothing
// qualifying ⇒ decline (null).
//
// SCOPE, because both of this table's blind spots look exactly like a gate refusing. First, only
// fields the tree ACCESSES are ever built, so "a field nothing reaches is a pad" is not a rule
// here — it cannot arise. It was one, ordered above `written`, and every case it fired on was a
// WRITE-ONLY field: 78 corpus refusals carrying a reason ("no access reaches it") that was false
// for all 78, while the sound gate that owns them sat below and fired never. Second, a field whose
// BASE TYPE does not resolve is dropped by `plan` before any gate reads it — 151 of the corpus's
// 820 field nodes, on 20 trees, all of them `[map]` configurations (kleod:CheckTileCollisionVertical,
// FreeAllDecompBuffers, TransformSingleEntityToScreen and ConfigureEntityBehavior among them).
// Declining there is right; being unable to say which of the two happened is the defect.
import { type IrType, T } from '../ir/types';
import { type Expr, type SFn, type Stmt, type StructType, mapExprChildren, mapStmtExprs, walkExprs } from './ast';
import { type Gate, firstRejection } from './gates';
import { declaredTypes, exprCType } from './typing';

/** One recovered field as the gates read it. Only fields the tree ACCESSES are ever built — a
 *  declared field nothing reaches never reaches the table, so "is this a pad" is not a gate. */
interface FieldCtx {
  /** the recovered type is a 32-bit integer — the width a pointer also fits */
  word: boolean;
  written: boolean;
  /** the field's value stands as the base of an `index` or another `field` */
  dereferenced: boolean;
}

export const PTR_FIELD_GATES: readonly Gate<FieldCtx>[] = [
  {
    id: 'not-word',
    why: 'only a word-wide field fits a pointer as well as it fits an integer',
    sound: true,
    guardedBy: 'ptrfield.test.ts: a halfword field declines',
    rejects: (c) => !c.word,
  },
  {
    id: 'written',
    why: 'the write side needs a cast on the stored value, which is a separate question',
    sound: true,
    guardedBy: 'ptrfield.test.ts: a field the tree stores through declines',
    rejects: (c) => c.written,
  },
  {
    id: 'dereferenced',
    why: 'a field the tree already dereferences was typed from its use, not from a width',
    sound: true,
    guardedBy: 'ptrfield.test.ts: a field standing as an access base declines',
    rejects: (c) => c.dereferenced,
  },
];

/** the struct a `field` node selects from, or null */
function structOf(base: Expr, vt: ReturnType<typeof declaredTypes>): Extract<IrType, { kind: 'struct' }> | null {
  const t = exprCType(base, vt);
  const st = t?.kind === 'ptr' ? t.to : t;
  return st?.kind === 'struct' ? st : null;
}

/** `<struct>.<field>` as one key — two structs may both carry a `field_4`. */
const keyOf = (structName: string, field: string): string => `${structName}.${field}`;

/** The fields PTR_FIELD_GATES admits, keyed by struct and name, each with the integer type its
 *  reads cast back to. */
function plan(sfn: SFn): Map<string, IrType> {
  const vt = declaredTypes(sfn);
  const seen = new Map<string, FieldCtx & { type: IrType }>();
  const note = (base: Expr, name: string, edit: (c: FieldCtx) => void): void => {
    const st = structOf(base, vt);
    const declared = st?.fields.find((f) => f.name === name)?.type;
    if (st === null || declared === undefined) {
      return;
    }
    const key = keyOf(st.name, name);
    const cur = seen.get(key) ?? {
      word: declared.kind === 'int' && declared.width === 32,
      written: false,
      dereferenced: false,
      type: declared,
    };
    edit(cur);
    seen.set(key, cur);
  };
  for (const e of walkExprs(sfn.body)) {
    if (e.k === 'field') {
      note(e.base, e.name, () => {});
    }
    // a field standing as an access base is one the recovery typed from its own use
    const inner = e.k === 'index' ? e.base : e.k === 'field' ? e.base : null;
    if (inner?.k === 'field') {
      note(inner.base, inner.name, (c) => (c.dereferenced = true));
    }
  }
  for (const s of stores(sfn.body)) {
    if (s.lval.k === 'field') {
      note(s.lval.base, s.lval.name, (c) => (c.written = true));
    }
  }
  const out = new Map<string, IrType>();
  for (const [key, ctx] of seen) {
    if (firstRejection(PTR_FIELD_GATES, ctx) === null) {
      out.set(key, ctx.type);
    }
  }
  return out;
}

function* stores(body: readonly Stmt[]): Generator<Extract<Stmt, { k: 'store' }>> {
  for (const s of body) {
    if (s.k === 'store') {
      yield s;
    }
    yield* stores(stmtLists(s));
  }
}

const stmtLists = (s: Stmt): Stmt[] => {
  switch (s.k) {
    case 'if':
      return [...s.then, ...s.else];
    case 'while':
    case 'dowhile':
      return s.body;
    case 'for':
      return [s.init, s.inc, ...s.body];
    case 'switch':
      return [...s.cases.flatMap((c) => c.body), ...(s.default ?? [])];
    default:
      return [];
  }
};

/** The `/ptr-field` candidate, or null when no field qualifies. Read-only: returns a fresh SFn.
 *
 *  The struct type appears TWICE in a tree — inline in each `(struct S *)` cast and again in
 *  `SFn.structs`, which is what a backend prints — so both are re-typed here. Letting them drift
 *  would print a declaration the expressions' own types contradict. */
export function pointerFields(sfn: SFn): SFn | null {
  const admitted = plan(sfn);
  if (admitted.size === 0) {
    return null;
  }
  const flipStruct = <S extends { name: string; fields: { name: string; type: IrType }[] }>(st: S): S => ({
    ...st,
    fields: st.fields.map((f) => (admitted.has(keyOf(st.name, f.name)) ? { ...f, type: T.ptr(T.void()) } : f)),
  });
  const flip = (t: IrType): IrType => {
    switch (t.kind) {
      case 'struct':
        return flipStruct(t);
      case 'ptr':
        return T.ptr(flip(t.to));
      case 'array':
        return T.array(flip(t.elem), t.count);
      default:
        return t;
    }
  };
  const vt = declaredTypes(sfn);
  const sub = (e: Expr): Expr => {
    if (e.k === 'field') {
      const st = structOf(e.base, vt);
      const back = st === null ? undefined : admitted.get(keyOf(st.name, e.name));
      const inner = mapExprChildren(e, sub);
      return back === undefined ? inner : { k: 'cast', to: back, e: inner };
    }
    const m = mapExprChildren(e, sub);
    return m.k === 'cast' ? { ...m, to: flip(m.to) } : m;
  };
  return {
    ...sfn,
    params: sfn.params.map((p) => ({ ...p, type: flip(p.type) })),
    locals: sfn.locals.map((l) => ({ ...l, type: flip(l.type) })),
    ...(sfn.globals ? { globals: sfn.globals.map((g) => ({ ...g, type: flip(g.type) })) } : {}),
    ...(sfn.structs ? { structs: sfn.structs.map((s): StructType => flipStruct(s)) } : {}),
    // `mapStmtExprs` already recurses into nested statement lists, so ONE call per top-level
    // statement rewrites the whole subtree — a second walk over its children would apply `sub`
    // twice and cast each read back to an integer twice over.
    body: sfn.body.map((s) => mapStmtExprs(s, sub)),
  };
}
