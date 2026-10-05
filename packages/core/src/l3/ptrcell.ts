// L3: a POINTER CELL — a global the body stores a pointer into, and the one place that spelling is
// recognised.
//
// structure() spells a pointer value stored into a word global as `g = (void *)X` (structure.ts
// `intoPtrCell`), the store every pointer declaration of `g` takes. Three readers act on it, and
// all three ask `pointerCellStore` rather than re-reading the cast:
//
//   • l3/symbol-refs.ts declares a name-only cell `void *` in the candidate's own world, the type
//     that store needs;
//   • `legalizePointerCells` below converts the cell's other uses to match that declaration;
//   • l3/intcell.ts spells the cell as the integer a project may have declared instead.
//
// The fact is derived from the final tree at each reader rather than carried on SFn, for the reason
// l3/symbol-refs.ts's header gives: a rewrite that drops the store must drop the fact with it.
import { T } from '../ir/types';
import { type Prototypes, declaredWidth } from '../proto';
import { type Expr, type SFn, type Stmt, mapExprChildren, stmtChildren } from './ast';
import { declaredTypes, exprCType } from './typing';

/** The bare name an `assign` stores a `(void *)` value into: a pointer cell, when no local binds
 *  it. */
export function pointerCellStore(s: Stmt): string | undefined {
  return s.k === 'assign' && s.value.k === 'cast' && s.value.to.kind === 'ptr' && s.value.to.to.kind === 'void'
    ? s.name
    : undefined;
}

/** The globals `sfn` stores a pointer into. */
export function pointerCells(sfn: SFn): Set<string> {
  const bound = new Set([...sfn.params.map((p) => p.name), ...sfn.locals.map((l) => l.name)]);
  const out = new Set<string>();
  const visit = (s: Stmt): void => {
    const name = pointerCellStore(s);
    if (name !== undefined && !bound.has(name)) {
      out.add(name);
    }
    stmtChildren(s).forEach(visit);
  };
  sfn.body.forEach(visit);
  return out;
}

const COMPARE = new Set(['<', '<=', '>', '>=', '==', '!=']);

/** Whether a declared parameter spelling is an integer of at most a word: the conversion a pointer
 *  argument needs to reach it. A spelling this cannot read is no opinion. */
const integerParam = (t: string): boolean => {
  const w = declaredWidth(t);
  return w !== undefined && w <= 32 && !t.includes('*') && !t.includes('(');
};

/** `sfn` with every integer use of a pointer cell converted to the integer it reads as, and every
 *  integer stored into one converted to a pointer.
 *
 *  A cell the body stores a pointer into is a pointer under every declaration that store compiles
 *  against, so the cell's integer readers (`return g;`, `if (g >= gLimit)`, `gOut = g;`, an
 *  integer parameter's argument) and its integer writers (`g = gBase;`) need the conversion C
 *  leaves implicit and CodeWarrior and IDO reject: `(u32)g`, `g = (void *)gBase`. The conversion of
 *  a word is no instruction, so the bytes are the implicit one's.
 *
 *  SCOPE: a use whose context states an integer type. A call argument converts only where the
 *  callee's prototype reads as an integer parameter, a store or a return only where its slot is an
 *  integer, an assignment where its target is an integer or a global the tree does not type;
 *  elsewhere the use is left as the structurer spelled it. A truth test, a comparison with a
 *  pointer or with 0, and an additive operand (the structurer's own pointer-value rules) are left
 *  alone. */
export function legalizePointerCells(sfn: SFn, prototypes: Prototypes): SFn {
  const cells = pointerCells(sfn);
  if (cells.size === 0) {
    return sfn;
  }
  const vt = declaredTypes(sfn);
  const isCell = (e: Expr): boolean => e.k === 'var' && cells.has(e.name);
  const word = (e: Expr): Expr => ({ k: 'cast', to: T.u(32), e });
  const asInt = (e: Expr): Expr => (isCell(e) ? word(e) : e);
  const pointerTyped = (e: Expr): boolean =>
    isCell(e) || e.k === 'addr' || (e.k === 'const' && e.value === 0) || exprCType(e, vt)?.kind === 'ptr';
  // a global no declaration here types, read bare: an integer in this candidate's own world
  const untypedGlobal = (e: Expr): boolean => e.k === 'var' && !cells.has(e.name) && vt(e.name) === undefined;

  const expr = (e0: Expr): Expr => {
    const e = mapExprChildren(e0, expr);
    switch (e.k) {
      case 'bin':
        if (e.op === '&&' || e.op === '||' || e.op === '+' || e.op === '-') {
          return e;
        }
        if (COMPARE.has(e.op)) {
          // A cell against a global no declaration types compares as two words, which that
          // global is under its own world's integer declaration and a pointer one alike. Against
          // a pointer or 0 the cell stays a pointer.
          if ((isCell(e.l) && untypedGlobal(e.r)) || (isCell(e.r) && untypedGlobal(e.l))) {
            return { ...e, l: word(e.l), r: word(e.r) };
          }
          return { ...e, l: pointerTyped(e.r) ? e.l : asInt(e.l), r: pointerTyped(e.l) ? e.r : asInt(e.r) };
        }
        return { ...e, l: asInt(e.l), r: asInt(e.r) };
      case 'un':
        return e.op === '-' || e.op === '~' ? { ...e, e: asInt(e.e) } : e;
      case 'call': {
        const params =
          typeof e.fn === 'string' && Object.hasOwn(prototypes, e.fn) ? prototypes[e.fn].params : undefined;
        if (!Array.isArray(params)) {
          return e;
        }
        return { ...e, args: e.args.map((a, i) => (i < params.length && integerParam(params[i]) ? asInt(a) : a)) };
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
        const slot = vt(s.name);
        return { ...s, value: slot === undefined || slot.kind === 'int' ? asInt(value) : value };
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
