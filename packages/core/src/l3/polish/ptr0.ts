// `p[0]`, not `*p`, where the same function also subscripts `p` by a constant: `*v0 + v0[2]` reads
// as two elements of one array only when both are spelled as elements.
//
// THE SAME LVALUE to C — `E1[E2]` is `*((E1) + (E2))` — and the same tree to the compilers, but only
// over a POINTER. Over an ARRAY the two are not one tree to agbcc: `a[0]` is an ARRAY_REF and `*a`
// the INDIRECT_REF of the decayed pointer, and the alias set differs (`Expr.index.subscript`, the
// frame-union case). So it fires only where THIS FUNCTION declares the base a pointer: a parameter
// or a local of pointer type, or a cast to a pointer. Never a global, whatever type the tree gives
// it: the project's header is the declaration the compiler reads, and it may say array. Measured:
// `kleod:VisionSelectUpdateRotationAndEntities` reads `*gSineTable` beside `gSineTable[k]` under
// `extern const s16 gSineTable[];`, and `gSineTable[0]` compiles to other registers there (agbcc -O2
// -mthumb-interwork -g, compiled).
//
// "The same base" is the same base EXPRESSION read at the same width and signedness with the same
// declared element: the printer legalizes the base from exactly those (cfamily.ts
// `legalizedIndexBase`), so two such accesses print the same base text.
import { type IrType, T, typeEquals } from '../../ir/types';
import { type Expr, type SFn, exprEquals, walkExprs } from '../ast';
import { mapFnExprs } from './walk';

type Index = Extract<Expr, { k: 'index' }>;

function pointerBase(ix: Index, own: ReadonlyMap<string, IrType>): boolean {
  if (ix.lead !== undefined && ix.lead.length > 0) {
    return false;
  }
  const b = ix.base;
  return (b.k === 'var' && own.get(b.name)?.kind === 'ptr') || (b.k === 'cast' && b.to.kind === 'ptr');
}

const sameAccess = (a: Index, b: Index): boolean =>
  a.width === b.width &&
  a.signed === b.signed &&
  typeEquals(a.baseElem ?? T.void(), b.baseElem ?? T.void()) &&
  exprEquals(a.base, b.base);

export function subscriptZeroBesideConstants(fn: SFn): SFn {
  // the names this function declares itself; a local shadows a parameter of the same name
  const types = new Map<string, IrType>([...fn.params, ...fn.locals].map((v) => [v.name, v.type]));
  const subscripted: Index[] = [];
  for (const e of walkExprs(fn.body)) {
    if (e.k === 'index' && e.idx.k === 'const' && e.idx.value !== 0 && pointerBase(e, types)) {
      subscripted.push(e);
    }
  }
  if (subscripted.length === 0) {
    return fn;
  }
  return mapFnExprs(fn, (e) =>
    e.k === 'index' &&
    e.idx.k === 'const' &&
    e.idx.value === 0 &&
    e.subscript !== true &&
    pointerBase(e, types) &&
    subscripted.some((s) => sameAccess(s, e))
      ? { ...e, subscript: true }
      : e,
  );
}
