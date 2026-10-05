// L3: a POINTER CELL — a global the body stores a pointer into, and the one place that spelling is
// recognised.
//
// structure() spells a pointer value stored into a word global as `g = (void *)X` (structure.ts
// `intoPtrCell`), the store every pointer declaration of `g` takes. Three readers act on it, and
// all three ask `pointerCells` rather than re-reading the cast:
//
//   • l3/symbol-refs.ts declares a name-only cell `void *` in the candidate's own world, the type
//     that store needs, and so each global the cell meets bare (`pointerPartners`);
//   • `legalizePointerCells` below converts the cell's other uses to match that declaration;
//   • l3/intcell.ts spells the cell as the integer a project may have declared instead.
//
// The fact is derived from the final tree at each reader rather than carried on SFn, for the reason
// l3/symbol-refs.ts's header gives: a rewrite that drops the store must drop the fact with it.
import { T } from '../ir/types';
import { declaredWidth } from '../proto';
import { type Expr, type SFn, type Stmt, mapExprChildren, stmtChildren, walkExprs } from './ast';
import { declaredTypes, exprCType } from './typing';

/** The bare name an `assign` stores a `(void *)` value into: a pointer cell, when no local binds
 *  it. */
export function pointerCellStore(s: Stmt): string | undefined {
  return s.k === 'assign' && s.value.k === 'cast' && s.value.to.kind === 'ptr' && s.value.to.to.kind === 'void'
    ? s.name
    : undefined;
}

const COMPARE = new Set(['<', '<=', '>', '>=', '==', '!=']);

const assigns = (body: Stmt[]): Extract<Stmt, { k: 'assign' }>[] => {
  const out: Extract<Stmt, { k: 'assign' }>[] = [];
  const visit = (s: Stmt): void => {
    if (s.k === 'assign') {
      out.push(s);
    }
    stmtChildren(s).forEach(visit);
  };
  body.forEach(visit);
  return out;
};

/** The globals `body` stores a pointer into: a `(void *)` store, or the bare value of another
 *  one. */
export function pointerCells(body: Stmt[], isGlobal: (name: string) => boolean): Set<string> {
  const stores = assigns(body).filter((s) => isGlobal(s.name));
  const out = new Set(stores.filter((s) => pointerCellStore(s) !== undefined).map((s) => s.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const s of stores) {
      if (!out.has(s.name) && s.value.k === 'var' && out.has(s.value.name)) {
        out.add(s.name);
        grew = true;
      }
    }
  }
  return out;
}

/** The bare globals a pointer cell meets bare: compared with one, or stored into one. Each holds a
 *  pointer too, so the candidate's own world declares it `void *` beside the cells, and it is left
 *  as spelled: converting it would convert whatever the project declares it, where bare a float,
 *  an array or a function meets the cell as a constraint violation. */
export function pointerPartners(
  body: Stmt[],
  isGlobal: (name: string) => boolean,
  cells: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  const partner = (e: Expr): void => {
    if (e.k === 'var' && isGlobal(e.name) && !cells.has(e.name)) {
      out.add(e.name);
    }
  };
  const isCell = (e: Expr): boolean => e.k === 'var' && cells.has(e.name);
  for (const s of assigns(body)) {
    if (cells.has(s.name)) {
      partner(s.value);
    }
  }
  for (const e of walkExprs(body)) {
    if (e.k === 'bin' && COMPARE.has(e.op)) {
      if (isCell(e.l)) {
        partner(e.r);
      }
      if (isCell(e.r)) {
        partner(e.l);
      }
    }
  }
  return out;
}

/** Whether a name `sfn` reads is a global: no param or local binds it. */
const globalOf = (sfn: SFn): ((name: string) => boolean) => {
  const bound = new Set([...sfn.params.map((p) => p.name), ...sfn.locals.map((l) => l.name)]);
  return (name) => !bound.has(name);
};

/** The globals `sfn` stores a pointer into (`pointerCells`). */
export function pointerCellsOf(sfn: SFn): Set<string> {
  return pointerCells(sfn.body, globalOf(sfn));
}

/** Whether a declared parameter spelling is an integer of at most a word: the conversion a pointer
 *  argument needs to reach it. A spelling this cannot read is no opinion. */
const integerParam = (t: string | undefined): boolean => {
  if (t === undefined) {
    return false;
  }
  const w = declaredWidth(t);
  return w !== undefined && w <= 32 && !t.includes('*') && !t.includes('(');
};

/** `sfn` with every integer use of a pointer cell converted to the integer it reads as, and every
 *  integer stored into one converted to a pointer.
 *
 *  A cell the body stores a pointer into is a pointer under every declaration that store compiles
 *  against, so the cell's integer readers (`return g;`, `if (g >= a0)`, `v0 = g;`, an integer
 *  parameter's argument) and its integer writers (`g = a0;`) need the conversion C leaves implicit
 *  and CodeWarrior and IDO reject: `(u32)g`, `g = (void *)a0`. The conversion of a word is no
 *  instruction, so the bytes are the implicit one's.
 *
 *  SCOPE: a use whose context states an integer type. A call argument converts only where the
 *  callee's declared parameter (`SFn.declaredArgs`) is an integer, a store or a return only where
 *  its slot is an integer, an assignment only where its target is an integer local; elsewhere the
 *  use is left as the structurer spelled it. A truth test, an additive operand (the structurer's
 *  own pointer-value rules), and a comparison with a pointer, with 0 or with a global the cell
 *  meets bare (`pointerPartners`) are left alone.
 *
 *  Run by the C-family backend's `emit` (backend/cfamily.ts), after every respell variation, so a
 *  respell reads the uses as the structurer spelled them and a store it removes takes the
 *  conversions with it. */
export function legalizePointerCells(sfn: SFn): SFn {
  const isGlobal = globalOf(sfn);
  const cells = pointerCells(sfn.body, isGlobal);
  if (cells.size === 0) {
    return sfn;
  }
  const partners = pointerPartners(sfn.body, isGlobal, cells);
  const vt = declaredTypes(sfn);
  const isCell = (e: Expr): boolean => e.k === 'var' && cells.has(e.name);
  const asInt = (e: Expr): Expr => (isCell(e) ? { k: 'cast', to: T.u(32), e } : e);
  // The structurer's byte sum on a cell's value (`(u8 *)g + 8`) is a pointer too, which an integer
  // parameter takes converted as a bare cell does; the backend converts it at every other integer
  // slot (`legalizePointerWrites`).
  const cellSum = (e: Expr): boolean =>
    (e.k === 'cast' && e.to.kind === 'ptr' && isCell(e.e)) ||
    (e.k === 'bin' && (e.op === '+' || e.op === '-') && (cellSum(e.l) || cellSum(e.r)));
  const asIntArg = (e: Expr): Expr =>
    e.k === 'bin' && cellSum(e) && exprCType(e, vt)?.kind === 'ptr' ? { k: 'cast', to: T.u(32), e } : asInt(e);
  const pointerTyped = (e: Expr): boolean =>
    isCell(e) ||
    (e.k === 'var' && partners.has(e.name)) ||
    e.k === 'addr' ||
    (e.k === 'const' && e.value === 0) ||
    exprCType(e, vt)?.kind === 'ptr';
  const expr = (e0: Expr): Expr => {
    const e = mapExprChildren(e0, expr);
    switch (e.k) {
      case 'bin':
        if (e.op === '&&' || e.op === '||' || e.op === '+' || e.op === '-') {
          return e;
        }
        if (COMPARE.has(e.op)) {
          return { ...e, l: pointerTyped(e.r) ? e.l : asInt(e.l), r: pointerTyped(e.l) ? e.r : asInt(e.r) };
        }
        return { ...e, l: asInt(e.l), r: asInt(e.r) };
      case 'un':
        return e.op === '-' || e.op === '~' ? { ...e, e: asInt(e.e) } : e;
      case 'call': {
        const params =
          typeof e.fn === 'string' && sfn.declaredArgs && Object.hasOwn(sfn.declaredArgs, e.fn)
            ? sfn.declaredArgs[e.fn]
            : undefined;
        if (params === undefined) {
          return e;
        }
        return { ...e, args: e.args.map((a, i) => (integerParam(params[i]) ? asIntArg(a) : a)) };
      }
      case 'index':
        return { ...e, idx: asInt(e.idx), ...(e.lead ? { lead: e.lead.map(asInt) } : {}) };
      default:
        return e;
    }
  };

  const stmt = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'assign': {
        const value = expr(s.value);
        if (cells.has(s.name)) {
          return { ...s, value: pointerTyped(value) ? value : { k: 'cast', to: T.ptr(T.void()), e: value } };
        }
        return { ...s, value: vt(s.name)?.kind === 'int' ? asInt(value) : value };
      }
      case 'store': {
        const value = expr(s.value);
        return { ...s, lval: expr(s.lval), value: exprCType(s.lval, vt)?.kind === 'int' ? asInt(value) : value };
      }
      case 'exprstmt':
        return { ...s, value: expr(s.value) };
      case 'return':
        return s.value ? { ...s, value: sfn.retType.kind === 'int' ? asInt(expr(s.value)) : expr(s.value) } : s;
      case 'if':
        return { ...s, cond: expr(s.cond), then: s.then.map(stmt), else: s.else.map(stmt) };
      case 'while':
      case 'dowhile':
        return { ...s, cond: expr(s.cond), body: s.body.map(stmt) };
      case 'for':
        return { ...s, init: stmt(s.init), cond: expr(s.cond), inc: stmt(s.inc), body: s.body.map(stmt) };
      case 'switch':
        return {
          ...s,
          scrutinee: asInt(expr(s.scrutinee)),
          cases: s.cases.map((c) => ({ ...c, body: c.body.map(stmt) })),
          default: s.default?.map(stmt),
        };
      case 'break':
      case 'continue':
        return s;
    }
  };
  return { ...sfn, body: sfn.body.map(stmt) };
}
