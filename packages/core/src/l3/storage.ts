// Which STORAGE CLASS an L3 name denotes.
//
// `assign` names its target with a bare string, and structure.ts spells a store to a local, to a
// param and to a bare scalar global identically — so every pass that must tell them apart has to
// re-derive the distinction from `SFn`'s three declaration lists. Four did, privately, and the one
// that got it wrong (l3/reindex.ts) read a plausible type off a global and re-spelled away a write
// another translation unit observes.
//
// SHADOWING is what the copies disagreed on, and the disagreement is REAL rather than drift: a
// name can be declared both a global and a local, because `SFn.globals` records what the code
// REFERENCES (structure.ts `noteGlobal`) independently of what it declares. Which answer is right
// depends on how the asking pass will SPELL the name, so the two questions are two functions
// here instead of one set each caller filters its own way:
//   • it keeps the reference verbatim (`(u8 *)g`) — the shadow is harmless, the spelling denotes
//     whatever the original access denoted: `declaredGlobals`;
//   • it re-spells the reference as an ADDRESS (`&g`) — a shadow then names the LOCAL's storage,
//     silently a different object: `addressableGlobals`;
//   • it asks which of the three classes a bare `assign` name denotes at all: `nameStorage`, the
//     primitive the other two are the shadow-sensitive projections over.
// One question about LOCAL storage sits beside them, because it is asked from the same lists:
// which expressions are a local object's ADDRESS (`localAddresses`), the frame bytes a respelled
// tree must keep reading as integers (contracts.ts `assertLocalStorageStaysInteger`).
import { type Expr, type SFn, assignsIn, dotBase, taintOverAssigns } from './ast';

export type Storage = 'local' | 'param' | 'global';

/** Every declared name, classified. A local or a param SHADOWS a same-named global — that is what
 *  the name binds to. A name absent from the map is declared nowhere. */
export function nameStorage(sfn: SFn): Map<string, Storage> {
  const t = new Map<string, Storage>();
  for (const g of sfn.globals ?? []) {
    t.set(g.name, 'global');
  }
  for (const p of sfn.params) {
    t.set(p.name, 'param');
  }
  for (const l of sfn.locals) {
    t.set(l.name, 'local');
  }
  return t;
}

/** Names declared as globals, INCLUDING one a local or param shadows (see the header). */
export function declaredGlobals(sfn: SFn): Set<string> {
  return new Set((sfn.globals ?? []).map((g) => g.name));
}

/** Names whose ADDRESS is the global's — a shadowed one excluded (see the header). */
export function addressableGlobals(sfn: SFn): Set<string> {
  return new Set([...nameStorage(sfn)].filter(([, s]) => s === 'global').map(([n]) => n));
}

/** The ADDRESSES of a tree's local objects — the frame bytes, which nothing but the function's own
 *  accesses and the callees it hands an address to can reach.
 *
 *  `isAddress(e)`: `e` evaluates to an address inside a local object — a local array (`sp0`,
 *  which decays), a local's address (`&v`), a local ever assigned one (`p0 = (s32 *)sp0;`, a
 *  flow-insensitive taint), under a cast or moved by `+`/`-`. PRECISE in the direction that
 *  matters to its readers: a value READ OUT of the bytes (`((s32 *)sp0)[i]`, a pointer the frame
 *  holds) is not an address of them, so an access through it is not an access to the frame.
 *  Known gap, on the side of answering no: an array MEMBER spelled as a `field` (`s.arr`) is an
 *  address C decays, and this does not follow it.
 *
 *  `accessAddress(e)`: the operand an access node reads its address from — an `index`'s base, an
 *  arrow `field`'s base, a dot `field`'s array element's base, or a struct VALUE's own address
 *  (`s.f` reads at `&s`). A param counts as a local throughout: its home is the frame once its
 *  address is taken, and a param assigned an address holds it as a local would. */
export function localAddresses(sfn: SFn): {
  isAddress: (e: Expr) => boolean;
  accessAddress: (e: Extract<Expr, { k: 'index' } | { k: 'field' }>) => Expr;
} {
  const storage = nameStorage(sfn);
  // a param is a local variable of the callee: its home is the frame once its address is taken
  const isLocal = (n: string): boolean => storage.get(n) === 'local' || storage.get(n) === 'param';
  const addressIn = (e: Expr, tainted: ReadonlySet<string>): boolean => {
    switch (e.k) {
      case 'var':
      case 'postincr':
        return tainted.has(e.name);
      case 'addr':
        return isLocal(e.name);
      case 'cast':
        return addressIn(e.e, tainted);
      case 'bin':
        return (
          (e.op === '+' && (addressIn(e.l, tainted) || addressIn(e.r, tainted))) ||
          (e.op === '-' && addressIn(e.l, tainted))
        );
      default:
        return false;
    }
  };
  const tainted = taintOverAssigns(
    assignsIn(sfn.body),
    sfn.locals.filter((l) => l.type.kind === 'array').map((l) => l.name),
    (a, t) => isLocal(a.name) && addressIn(a.value, t),
  );
  return {
    isAddress: (e) => addressIn(e, tainted),
    accessAddress: (e) =>
      e.k === 'index'
        ? e.base
        : (dotBase(e)?.base ?? (e.dot === true && e.base.k === 'var' ? { k: 'addr', name: e.base.name } : e.base)),
  };
}
