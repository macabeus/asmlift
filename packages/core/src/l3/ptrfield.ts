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
// are different alias sets, so under `-fstrict-aliasing` the loop optimizer may hoist a pointer
// field's load past an `s32` store it must otherwise keep behind — and on synthetic:dmaptrsrc that
// hoist is the difference between a byte-exact match and a 32-point diff, once the accumulator is
// un-reduced back into the loop. Which side matches is per-field knowledge nothing in the asm
// carries, so both are enumerated and the differ referees.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION on a target whose pointers are 32 bits: the declaration
// changes, and every read is wrapped in a cast back to the field's own recovered integer type, so
// each use computes the same value it did. Nothing else moves.
//
// GATE (PTR_FIELD_GATES, read once per field): the field's recovered type must be a 32-bit
// integer; the field must be READ somewhere (a field the function never touches is a pad, and
// re-typing one asserts a layout the accesses do not support); it must never be a store LVALUE
// (the write side would need a cast on the value, which is a second question); and it must never
// stand as the BASE of another access (a field the tree already dereferences is one the recovery
// typed from its own use, not from a width). Nothing qualifying ⇒ decline (null).
import { type IrType, T } from '../ir/types';
import { type Expr, type SFn, type Stmt, type StructType, mapExprChildren, mapStmtExprs, walkExprs } from './ast';
import { type Gate, firstRejection } from './gates';
import { declaredTypes, exprCType } from './typing';

/** One recovered field as the gates read it. */
interface FieldCtx {
  /** the recovered type is a 32-bit integer — the width a pointer also fits */
  word: boolean;
  reads: number;
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
    id: 'untouched',
    why: 'a field no access reaches is a pad, and re-typing one asserts a layout with no evidence',
    sound: false,
    rejects: (c) => c.reads === 0,
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
      reads: 0,
      written: false,
      dereferenced: false,
      type: declared,
    };
    edit(cur);
    seen.set(key, cur);
  };
  for (const e of walkExprs(sfn.body)) {
    if (e.k === 'field') {
      note(e.base, e.name, (c) => c.reads++);
    }
    // a field standing as an access base is one the recovery typed from its own use
    const inner = e.k === 'index' ? e.base : e.k === 'field' ? e.base : null;
    if (inner?.k === 'field') {
      note(inner.base, inner.name, (c) => (c.dereferenced = true));
    }
  }
  for (const s of stores(sfn.body)) {
    if (s.lval.k === 'field') {
      note(s.lval.base, s.lval.name, (c) => {
        c.written = true;
        c.reads--; // the walk above counted the lvalue as a read
      });
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
    body: sfn.body.map(function rewrite(s: Stmt): Stmt {
      const mapped = mapStmtExprs(s, sub);
      switch (mapped.k) {
        case 'if':
          return { ...mapped, then: mapped.then.map(rewrite), else: mapped.else.map(rewrite) };
        case 'while':
        case 'dowhile':
          return { ...mapped, body: mapped.body.map(rewrite) };
        case 'for':
          return { ...mapped, init: rewrite(mapped.init), inc: rewrite(mapped.inc), body: mapped.body.map(rewrite) };
        case 'switch':
          return {
            ...mapped,
            cases: mapped.cases.map((c) => ({ ...c, body: c.body.map(rewrite) })),
            ...(mapped.default ? { default: mapped.default.map(rewrite) } : {}),
          };
        default:
          return mapped;
      }
    }),
  };
}
