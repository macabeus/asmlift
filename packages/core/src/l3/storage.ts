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
// depends on how the asking lever will SPELL the name, so the two questions are two functions
// here instead of one set each caller filters its own way:
//   • it keeps the reference verbatim (`(u8 *)g`) — the shadow is harmless, the spelling denotes
//     whatever the original access denoted: `declaredGlobals`;
//   • it re-spells the reference as an ADDRESS (`&g`) — a shadow then names the LOCAL's storage,
//     silently a different object: `addressableGlobals`.
import type { SFn } from './ast';

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
