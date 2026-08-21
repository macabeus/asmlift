// L3 re-spelling lever: NEIGHBOR absolute addresses derive from one shared base local.
//
// A cluster of raw-address accesses a few bytes apart is one object's cells: the compiler holds
// the object's base in a register and derives each cell (`add #72` / `add #74` off one pool
// word, a halfword offset beyond the load range forcing the add, the in-range word staying
// `[rN, #112]`), where a per-cell spelling anchors one pool constant per address. This lever
// re-spells every deref base in a cluster as an offset from a `u8 *` base local holding the
// cluster's lowest address, and the differ referees:
//
//     *(u16 *)0x03001048   →   u8 *b = (u8 *)0x03001000;  *(u16 *)(b + 72)
//
// SCOPE (decline over approximate): only CONST deref bases (an integer used in arithmetic is
// not an address and never rewrites); a cluster needs at least two DISTINCT addresses within a
// 255-byte span of its lowest (the single-`add`-immediate derivation reach — beyond it the
// derive costs more than the pool word it saves); every access in the cluster rewrites, so one
// object never splits into mixed spellings. Declines (null) when no cluster forms.
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, mapStmtExprs } from './ast';

const SPAN = 255;

/** The const behind a deref base, looked at through value casts. */
const baseConst = (e: Expr): number | null => (e.k === 'const' ? e.value : e.k === 'cast' ? baseConst(e.e) : null);

export function nearBaseClusters(sfn: SFn): SFn | null {
  // collect every DISTINCT const deref-base address
  const addrs = new Set<number>();
  const collect = (e: Expr): Expr => {
    const m = mapExprChildren(e, collect);
    if (m.k === 'index') {
      const c = baseConst(m.base);
      if (c !== null) {
        addrs.add(c);
      }
    }
    return m;
  };
  for (const s of sfn.body) {
    mapStmtExprs(s, collect);
  }
  // greedy clusters over the sorted addresses; only multi-member clusters rewrite
  const sorted = [...addrs].sort((a, b) => a - b);
  const baseOf = new Map<number, number>();
  for (let i = 0; i < sorted.length;) {
    const lo = sorted[i];
    let j = i;
    while (j < sorted.length && sorted[j] - lo <= SPAN) {
      j++;
    }
    if (j - i >= 2) {
      for (let k = i; k < j; k++) {
        baseOf.set(sorted[k], lo);
      }
    }
    i = j;
  }
  if (baseOf.size === 0) {
    return null;
  }
  const baseName = new Map<number, string>();
  const taken = new Set([...sfn.params, ...sfn.locals].map((d) => d.name));
  for (const lo of new Set(baseOf.values())) {
    let n = 0;
    while (taken.has(`nb${n}`)) {
      n++;
    }
    taken.add(`nb${n}`);
    baseName.set(lo, `nb${n}`);
  }
  const rewrite = (e: Expr): Expr => {
    const m = mapExprChildren(e, rewrite);
    if (m.k === 'index') {
      const c = baseConst(m.base);
      const lo = c !== null ? baseOf.get(c) : undefined;
      if (c !== null && lo !== undefined) {
        const off = c - lo;
        const base: Expr =
          off === 0
            ? { k: 'var', name: baseName.get(lo)! }
            : { k: 'bin', op: '+', l: { k: 'var', name: baseName.get(lo)! }, r: { k: 'const', value: off } };
        return { ...m, base };
      }
    }
    return m;
  };
  const inits: Stmt[] = [...baseName.entries()].map(([lo, name]) => ({
    k: 'assign',
    name,
    value: {
      k: 'cast',
      to: { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } },
      e: { k: 'const', value: lo },
    },
  }));
  return {
    ...sfn,
    locals: [
      ...sfn.locals,
      ...[...baseName.values()].map((name) => ({
        name,
        type: { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } } as SFn['locals'][number]['type'],
      })),
    ],
    body: [...inits, ...sfn.body.map((s) => mapStmtExprs(s, rewrite))],
  };
}
