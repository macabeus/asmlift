// L3 respell variation: a pointer stored back into the global cell it was read from, spelled as
// the cell's own arithmetic.
//
// The structurer spells a global's value advanced and stored back as `g = (void *)((u8 *)g + K)`
// (or, with a runtime offset, `g = (void *)(u8 *)((u32)g + x)`): the byte the asm addressed,
// assignable under every pointer declaration of g. A project that declares the cell an INTEGER
// (`u32 g; … g += 4;`) takes that store as an integer from a pointer, which CodeWarrior rejects
// and agbcc and KMC gcc warn about. `g = g + K` is the source under that declaration, and the
// pointer one scales K by the pointee instead, so which of the two is right is a fact about the
// project's declaration, which nothing in the asm states.
//
// So the spelling is a PROOF-CARRYING candidate (`needsProof`, Candidate.matchOnly): published
// only at a byte-exact score, where the bytes are the evidence that the declaration it compiled
// against gives K the asm's stride. Its own self-declared world declares the cell an integer,
// because no `(void *)` store is left in it (l3/symbol-refs.ts `pointerCell`).
//
// SCOPE (decline over approximate): an assignment to a bare name whose value is a `(void *)` cast
// of that SAME name's byte sum, `(u8 *)g ± r` or `(u8 *)((u32)g + r)`. Any other pointer stored
// into a cell is not this question.
import type { IrType } from '../ir/types';
import { type Expr, type SFn, type Stmt, mapStmtLists } from './ast';

const isPtrTo = (t: IrType, to: 'void' | 'u8'): boolean =>
  t.kind === 'ptr' && (to === 'void' ? t.to.kind === 'void' : t.to.kind === 'int' && t.to.width === 8);

/** `g`, `(u8 *)g`, `(u32)g` or `(u32)(u8 *)g` for the bare name `name`. */
const isCell = (x: Expr, name: string): boolean =>
  (x.k === 'var' && x.name === name) ||
  (x.k === 'cast' && ((x.to.kind === 'int' && x.to.width === 32) || isPtrTo(x.to, 'u8')) && isCell(x.e, name));

/** The cell's own arithmetic for a `(void *)` self-store's value, or null when it is not one. */
function cellArithmetic(value: Expr, name: string): Expr | null {
  if (value.k !== 'cast' || !isPtrTo(value.to, 'void')) {
    return null;
  }
  // `(u8 *)((u32)g + r)`: the integer sum the operand-order rule restores to a byte pointer
  const sum = value.e.k === 'cast' && isPtrTo(value.e.to, 'u8') ? value.e.e : value.e;
  if (sum.k !== 'bin' || (sum.op !== '+' && sum.op !== '-') || !isCell(sum.l, name)) {
    return null;
  }
  return { ...sum, l: { k: 'var', name } };
}

/** The `/int-cell` candidate: every `(void *)` self-store of a bare global as `g = g ± r`. */
export function integerCellStores(sfn: SFn): { sfn: SFn; needsProof: boolean } | null {
  const local = new Set([...sfn.params.map((p) => p.name), ...sfn.locals.map((l) => l.name)]);
  let changed = false;
  const one = (s: Stmt): Stmt => {
    if (s.k === 'assign' && !local.has(s.name)) {
      const value = cellArithmetic(s.value, s.name);
      if (value !== null) {
        changed = true;
        return { ...s, value };
      }
    }
    const inner = mapStmtLists(s, (list) => list.map(one));
    return inner.k === 'for' ? { ...inner, init: one(inner.init), inc: one(inner.inc) } : inner;
  };
  const body = sfn.body.map(one);
  return changed ? { sfn: { ...sfn, body }, needsProof: true } : null;
}
