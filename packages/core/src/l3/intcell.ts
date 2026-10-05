// L3 respell variation: a pointer cell spelled as the integer a project may have declared it.
//
// A global the body stores a pointer into is spelled as a pointer (l3/ptrcell.ts): the store is
// `g = (void *)((u8 *)g + K)` or `g = (void *)X`, the integer uses convert it, `(u32)g`, and the
// candidate's own world declares it `void *`. A project that declares the cell an INTEGER
// (`u32 g; … g += 4;`) wrote none of those conversions, and two compilers tell: CodeWarrior rejects
// a pointer stored into the integer, and IDO allocates registers differently around a `(u32)g` it
// takes as a conversion. Under a pointer declaration `g = g + K` scales K by the pointee instead,
// so which of the two is right is a fact about the project's declaration, which nothing in the asm
// states.
//
// So the spelling is a PROOF-CARRYING candidate (`needsProof`, Candidate.matchOnly): published
// only at a byte-exact score, where the bytes are the evidence that the declaration it compiled
// against gives K the asm's stride. Its own self-declared world declares the cell an integer,
// because no pointer store is left in it.
//
// SCOPE (decline over approximate): a cell no declaration in the tree types, and of its uses only
// the ones the pointer spelling made: the `(void *)` stores into it and a `(u32)` conversion of its
// bare value. A global the body only reads converted is not this question.
import type { IrType } from '../ir/types';
import { T } from '../ir/types';
import { type Expr, type SFn, type Stmt, mapExprChildren, mapStmtExprs } from './ast';
import { pointerCellStore, pointerCells } from './ptrcell';
import { declaredTypes } from './typing';

const isPtrTo = (t: IrType, to: 'void' | 'u8'): boolean =>
  t.kind === 'ptr' && (to === 'void' ? t.to.kind === 'void' : t.to.kind === 'int' && t.to.width === 8);
const isWord = (t: IrType): boolean => t.kind === 'int' && t.width === 32;

/** `g`, `(u8 *)g`, `(u32)g` or `(u32)(u8 *)g` for the bare name `name`. */
const isCell = (x: Expr, name: string): boolean =>
  (x.k === 'var' && x.name === name) || (x.k === 'cast' && (isWord(x.to) || isPtrTo(x.to, 'u8')) && isCell(x.e, name));

/** The integer a `(void *)` store into the cell `name` stores: its own arithmetic for a self-store,
 *  a bare value as it stands, anything else converted. */
function integerValue(value: Expr, name: string): Expr {
  const stored = value.k === 'cast' ? value.e : value;
  // `(u8 *)((u32)g + r)`: the integer sum the operand-order rule restores to a byte pointer
  const sum = stored.k === 'cast' && isPtrTo(stored.to, 'u8') ? stored.e : stored;
  if (sum.k === 'bin' && (sum.op === '+' || sum.op === '-') && isCell(sum.l, name)) {
    return { ...sum, l: { k: 'var', name } };
  }
  return stored.k === 'var' ? stored : { k: 'cast', to: T.u(32), e: stored };
}

/** The `/int-cell` candidate: every pointer cell no declaration types, spelled as an integer. */
export function integerCells(sfn: SFn): { sfn: SFn; needsProof: boolean } | null {
  const vt = declaredTypes(sfn);
  const cells = new Set([...pointerCells(sfn)].filter((n) => vt(n) === undefined));
  if (cells.size === 0) {
    return null;
  }
  const expr = (e0: Expr): Expr => {
    const e = mapExprChildren(e0, expr);
    if (e.k === 'cast' && isWord(e.to)) {
      const inner = e.e.k === 'cast' && isPtrTo(e.e.to, 'u8') ? e.e.e : e.e;
      if (inner.k === 'var' && cells.has(inner.name)) {
        return inner;
      }
    }
    return e;
  };
  const stmt = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'assign': {
        const value = expr(s.value);
        return cells.has(s.name) && pointerCellStore(s) !== undefined
          ? { ...s, value: integerValue(value, s.name) }
          : { ...s, value };
      }
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
          scrutinee: expr(s.scrutinee),
          cases: s.cases.map((c) => ({ ...c, body: c.body.map(stmt) })),
          default: s.default?.map(stmt),
        };
      default:
        return mapStmtExprs(s, expr);
    }
  };
  return { sfn: { ...sfn, body: sfn.body.map(stmt) }, needsProof: true };
}
