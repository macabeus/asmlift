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
import { type IrType, T } from '../ir/types';
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

/** The bare globals a pointer cell meets bare: compared with one, or stored into one. */
function meetsBare(body: Stmt[], isGlobal: (name: string) => boolean, cells: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const meets = (e: Expr): void => {
    if (e.k === 'var' && isGlobal(e.name) && !cells.has(e.name)) {
      out.add(e.name);
    }
  };
  const isCell = (e: Expr): boolean => e.k === 'var' && cells.has(e.name);
  for (const s of assigns(body)) {
    if (cells.has(s.name)) {
      meets(s.value);
    }
  }
  for (const e of walkExprs(body)) {
    if (e.k === 'bin' && COMPARE.has(e.op)) {
      if (isCell(e.l)) {
        meets(e.r);
      }
      if (isCell(e.r)) {
        meets(e.l);
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

/** What `mapIntegerSlots` does at each place a pointer cell meets an integer. */
interface SlotRules {
  /** An operand a cell meets bare, which no conversion takes. */
  pointerTyped: (e: Expr) => boolean;
  /** An operand the context reads as an integer. */
  int: (e: Expr) => Expr;
  /** An argument an integer parameter takes. */
  intArg: (e: Expr) => Expr;
  /** A bare global compared with a cell, which no pointer partners. */
  comparedGlobal: (e: Expr) => Expr;
  /** A value stored into a cell. */
  intoCell: (e: Expr) => Expr;
  /** A global no cell is, stored into: an integer slot. */
  storedGlobal: (name: string) => void;
}

/** `sfn` with `rules` applied at every place its context states an integer type: an operand of a
 *  non-additive operator, of `-`/`~`, an index, a switch, a comparison with no pointer, a call
 *  argument whose callee's declared parameter (`SFn.declaredArgs`) is an integer, and a store, an
 *  assignment or a return into an integer slot. A global no cell is takes an integer when stored
 *  into, which is what the candidate's own world declares it. */
function mapIntegerSlots(sfn: SFn, cells: ReadonlySet<string>, rules: SlotRules): SFn {
  const isGlobal = globalOf(sfn);
  const vt = declaredTypes(sfn);
  const isCell = (e: Expr): boolean => e.k === 'var' && cells.has(e.name);
  const bareGlobal = (e: Expr): boolean => e.k === 'var' && isGlobal(e.name) && !cells.has(e.name);
  const compare = (x: Expr, other: Expr): Expr =>
    isCell(other) && bareGlobal(x) && !rules.pointerTyped(x)
      ? rules.comparedGlobal(x)
      : rules.pointerTyped(other)
        ? x
        : rules.int(x);
  const expr = (e0: Expr): Expr => {
    const e = mapExprChildren(e0, expr);
    switch (e.k) {
      case 'bin':
        if (e.op === '&&' || e.op === '||' || e.op === '+' || e.op === '-') {
          return e;
        }
        if (COMPARE.has(e.op)) {
          return { ...e, l: compare(e.l, e.r), r: compare(e.r, e.l) };
        }
        return { ...e, l: rules.int(e.l), r: rules.int(e.r) };
      case 'un':
        return e.op === '-' || e.op === '~' ? { ...e, e: rules.int(e.e) } : e;
      case 'call': {
        const params =
          typeof e.fn === 'string' && sfn.declaredArgs && Object.hasOwn(sfn.declaredArgs, e.fn)
            ? sfn.declaredArgs[e.fn]
            : undefined;
        if (params === undefined) {
          return e;
        }
        return { ...e, args: e.args.map((a, i) => (integerParam(params[i]) ? rules.intArg(a) : a)) };
      }
      case 'index':
        return { ...e, idx: rules.int(e.idx), ...(e.lead ? { lead: e.lead.map(rules.int) } : {}) };
      default:
        return e;
    }
  };

  const stmt = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'assign': {
        const value = expr(s.value);
        if (cells.has(s.name)) {
          return { ...s, value: rules.pointerTyped(value) ? value : rules.intoCell(value) };
        }
        const t = vt(s.name);
        if (t === undefined && isGlobal(s.name)) {
          rules.storedGlobal(s.name);
          return { ...s, value: rules.int(value) };
        }
        return { ...s, value: t?.kind === 'int' ? rules.int(value) : value };
      }
      case 'store': {
        const value = expr(s.value);
        return {
          ...s,
          lval: expr(s.lval),
          value: exprCType(s.lval, vt)?.kind === 'int' ? rules.int(value) : value,
        };
      }
      case 'exprstmt':
        return { ...s, value: expr(s.value) };
      case 'return':
        return s.value ? { ...s, value: sfn.retType.kind === 'int' ? rules.int(expr(s.value)) : expr(s.value) } : s;
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
          scrutinee: rules.int(expr(s.scrutinee)),
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

/** A sum no operand of which renders a pointer: read as an integer, each bare name in it is. */
const integerSum = (e: Expr, vt: (name: string) => IrType | undefined): e is Extract<Expr, { k: 'bin' }> =>
  e.k === 'bin' &&
  (e.op === '+' || e.op === '-') &&
  exprCType(e.l, vt)?.kind !== 'ptr' &&
  exprCType(e.r, vt)?.kind !== 'ptr';

/** The globals a pointer cell meets bare (compared with it, or stored into it) that hold a pointer
 *  too: the candidate's own world declares each `void *` beside the cells, and they are left as
 *  spelled, since converting one would convert whatever the project declares it, where bare a
 *  float, an array or a function meets the cell as a constraint violation.
 *
 *  A global the body also reads as an integer is not one: `void *` takes none of those reads, so its
 *  own world declares it the integer it is read as, and the cell converts to meet it. */
export function pointerPartners(sfn: SFn): Set<string> {
  const isGlobal = globalOf(sfn);
  const cells = pointerCells(sfn.body, isGlobal);
  const meets = meetsBare(sfn.body, isGlobal, cells);
  if (meets.size === 0) {
    return meets;
  }
  const vt = declaredTypes(sfn);
  const read = new Set<string>();
  const int = (e: Expr): Expr => {
    if (e.k === 'var' && meets.has(e.name)) {
      read.add(e.name);
    } else if (integerSum(e, vt)) {
      int(e.l);
      int(e.r);
    }
    return e;
  };
  mapIntegerSlots(sfn, cells, {
    pointerTyped: (e) => e.k === 'var' && (cells.has(e.name) || meets.has(e.name)),
    int,
    intArg: int,
    comparedGlobal: int,
    intoCell: (e) => e,
    storedGlobal: (name) => {
      if (meets.has(name)) {
        read.add(name);
      }
    },
  });
  return new Set([...meets].filter((n) => !read.has(n)));
}

/** `sfn` with every integer use of a pointer cell converted to the integer it reads as, and every
 *  integer stored into one converted to a pointer.
 *
 *  A cell the body stores a pointer into is a pointer under every declaration that store compiles
 *  against, so the cell's integer readers (`return g;`, `if (g >= a0)`, `v0 = g;`, `g + 4` stored
 *  into an integer, an integer parameter's argument) and its integer writers (`g = a0;`) need the
 *  conversion C leaves implicit and CodeWarrior and IDO reject: `(u32)g`, `g = (void *)a0`. The
 *  conversion of a word is no instruction, so the bytes are the implicit one's.
 *
 *  SCOPE: a use whose context states an integer type (`mapIntegerSlots`); elsewhere the use is left
 *  as the structurer spelled it. A truth test, a sum that renders a pointer (the structurer's own
 *  byte sum, which the backend converts at an integer slot: `legalizePointerWrites`), and a
 *  comparison with a pointer, with 0 or with a partner (`pointerPartners`) are left alone. A global
 *  compared with the cell that is no partner goes `(u32)(u8 *)g` beside the cell's `(u32)g`: under a
 *  float declaration that is no C, as the bare comparison was not.
 *
 *  Run by the C-family backend's `emit` (backend/cfamily.ts), after every respell variation, so a
 *  respell reads the uses as the structurer spelled them and a store it removes takes the
 *  conversions with it. */
export function legalizePointerCells(sfn: SFn): SFn {
  const cells = pointerCellsOf(sfn);
  if (cells.size === 0) {
    return sfn;
  }
  const partners = pointerPartners(sfn);
  const vt = declaredTypes(sfn);
  const isCell = (e: Expr): boolean => e.k === 'var' && cells.has(e.name);
  const returnsPointer = (fn: string | Expr): boolean =>
    typeof fn === 'string' &&
    sfn.declaredReturns !== undefined &&
    Object.hasOwn(sfn.declaredReturns, fn) &&
    sfn.declaredReturns[fn].includes('*');
  const asInt = (e: Expr): Expr =>
    isCell(e)
      ? { k: 'cast', to: T.u(32), e }
      : integerSum(e, vt)
        ? { ...e, l: asInt(e.l), r: asInt(e.r) }
        : e;
  // The structurer's byte sum on a cell's value (`(u8 *)g + 8`) is a pointer too, which an integer
  // parameter takes converted as a bare cell does; the backend converts it at every other integer
  // slot (`legalizePointerWrites`).
  const cellSum = (e: Expr): boolean =>
    (e.k === 'cast' && e.to.kind === 'ptr' && isCell(e.e)) ||
    (e.k === 'bin' && (e.op === '+' || e.op === '-') && (cellSum(e.l) || cellSum(e.r)));
  return mapIntegerSlots(sfn, cells, {
    pointerTyped: (e) =>
      isCell(e) ||
      (e.k === 'var' && partners.has(e.name)) ||
      e.k === 'addr' ||
      (e.k === 'call' && returnsPointer(e.fn)) ||
      (e.k === 'const' && e.value === 0) ||
      exprCType(e, vt)?.kind === 'ptr',
    int: asInt,
    intArg: (e) =>
      e.k === 'bin' && cellSum(e) && exprCType(e, vt)?.kind === 'ptr' ? { k: 'cast', to: T.u(32), e } : asInt(e),
    comparedGlobal: (e) => ({ k: 'cast', to: T.u(32), e: { k: 'cast', to: T.ptr(T.u(8)), e } }),
    intoCell: (e) => ({ k: 'cast', to: T.ptr(T.void()), e }),
    storedGlobal: () => {},
  });
}
