// L3 re-spelling lever: NEIGHBOR absolute addresses derive from one shared base local.
//
// A cluster of raw-address accesses a few bytes apart is one object's cells: the compiler holds
// the object's base in a register and derives each cell (`add #72` / `add #74` off one pool
// word, a halfword offset beyond the load range forcing the add, the in-range word staying
// `[rN, #112]`), where a per-cell spelling anchors one pool constant per address. This lever
// re-spells every deref base in a cluster as an offset from a `u8 *` base local holding the
// cluster's lowest address, and the differ referees:
//
//     *(u16 *)0x0300104A   →   u8 *b = (u8 *)0x03001048;  *(u16 *)(b + 2)
//
// SCOPE (decline over approximate): cluster MEMBERSHIP comes from CONST deref bases only (a
// struct-pointer cast base and everything inside a dot-form field subtree keep their spelling —
// their stride is the struct's, not a byte's); a cluster needs at least two DISTINCT addresses
// within the target's declared derivation reach of its lowest (TargetDescription nearBaseSpan —
// beyond it the derive costs more than the pool word it saves); every access the walk visits
// rewrites, so a cluster splits only across the field-subtree and struct-pointer-cast
// boundaries. A member basecse
// already hoisted arrives as a `var` base and is invisible here — the reused-base and
// neighbor-base spellings stay separate candidates. Once a cluster HAS formed, a bare const
// VALUE inside its window re-spells too, as `(s32)(b + off)` — the address of a cell handed to
// something (a DMA source register) is the same derived add in the original, and the two
// spellings are value-equal by construction, so the differ referees — including an integer that
// only coincidentally lands in the window, which is the stated cost of the lever (the `s32` cast
// assumes addresses below 2^31, true of every target that declares nearBaseSpan today). Declines
// (null) when no cluster forms.
import type { Expr, SFn } from './ast';
import { mapExprChildren, mapStmtExprs } from './ast';
import { type BaseInit, nameAllocator, placeBaseLocals } from './hoist';

/** The const behind a deref base, looked at through SCALAR value casts only — a cast to a
 *  struct pointer is the struct-arrays dot-form's base, whose stride the raw `u8 *` re-spelling
 *  would collapse, so it is never a cluster member. */
const baseConst = (e: Expr): number | null =>
  e.k === 'const'
    ? e.value
    : e.k === 'cast' && !(e.to.kind === 'ptr' && e.to.to.kind === 'struct')
      ? baseConst(e.e)
      : null;

/** `span` is the target's single-add-immediate derivation reach
 *  (TargetDescription.compilerBehaviors.nearBaseSpan) — a target that declares none never runs
 *  this lever. */
export function nearBaseClusters(sfn: SFn, span: number): SFn | null {
  if (!Number.isFinite(span) || span < 0) {
    return null; // a hostile span stalls the cluster window instead of shrinking it
  }
  // collect every DISTINCT const deref-base address
  const addrs = new Set<number>();
  const collect = (e: Expr): Expr => {
    if (e.k === 'field') {
      return e; // a dot-form subtree keeps its struct base — never collected, never rewritten
    }
    if (e.k === 'cast' && e.to.kind === 'ptr' && e.to.to.kind === 'struct') {
      return e; // rewrite refuses these subtrees, so collecting under them would seed a cluster
    }
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
    while (j < sorted.length && sorted[j] - lo <= span) {
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
  const fresh = nameAllocator(sfn); // the shared minting mechanism — collides with nothing in sfn
  for (const lo of new Set(baseOf.values())) {
    baseName.set(lo, fresh());
  }
  const derived = (lo: number, off: number): Expr =>
    off === 0
      ? { k: 'var', name: baseName.get(lo)! }
      : { k: 'bin', op: '+', l: { k: 'var', name: baseName.get(lo)! }, r: { k: 'const', value: off } };
  // the cluster (if any) whose window covers a bare const value
  const windows = [...new Set(baseOf.values())];
  const coveringLo = (v: number): number | undefined => windows.find((lo) => v >= lo && v - lo <= span);
  const rewrite = (e: Expr): Expr => {
    if (e.k === 'field') {
      return e;
    }
    if (e.k === 'index') {
      const c = baseConst(e.base);
      const lo = c !== null ? baseOf.get(c) : undefined;
      if (c !== null && lo !== undefined) {
        // the base is replaced wholesale — its inner const must not reach the value path below
        return { ...e, base: derived(lo, c - lo), idx: rewrite(e.idx) };
      }
      return { ...e, base: rewrite(e.base), idx: rewrite(e.idx) };
    }
    if (e.k === 'cast' && e.to.kind === 'ptr' && e.to.to.kind === 'struct') {
      return e; // the struct-arrays base keeps its spelling — same refusal as baseConst's
    }
    if (e.k === 'const') {
      const lo = coveringLo(e.value);
      if (lo !== undefined) {
        return {
          k: 'cast',
          to: { kind: 'int', width: 32, signed: true },
          e: derived(lo, e.value - lo),
        };
      }
      return e;
    }
    return mapExprChildren(e, rewrite);
  };
  const inits: BaseInit[] = [...baseName.entries()].map(([lo, name]) => ({
    k: 'assign',
    name,
    value: {
      k: 'cast',
      to: { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } },
      e: { k: 'const', value: lo },
    },
  }));
  const locals = [
    ...sfn.locals,
    ...[...baseName.values()].map((name) => ({
      name,
      type: { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } } as SFn['locals'][number]['type'],
    })),
  ];
  // The body rebuild is `l3/hoist.ts`'s, shared with the two other passes that place into the
  // leading base-init run — this pass is the THIRD, and it used to own a private copy of the
  // rebuild, which is exactly the drift that put the mechanism in one file.
  //
  // The POLICY stays this pass's own, and it is `prepend`: the cluster bases go ABOVE a run
  // already there rather than being merged into it in first-use order. That is not `l3/basecse.ts`
  // blindly-prepending hazard read backwards — it is what this lever's demanding row says. Placing
  // them in first-use order instead turns `synthetic:dmafield` (won by
  // `signed/livebase/volatile/nearbase/initfirst`) from a MATCH into diff:5: its cluster base is
  // reached at 2+ addresses by construction, so its pool word is not "first touched late", and the
  // bytes say it was loaded before the hoist run beneath it.
  const rewritten = sfn.body.map((s) => mapStmtExprs(s, rewrite));
  const { body } = placeBaseLocals({ ...sfn, locals, body: rewritten }, inits, 'prepend');
  return { ...sfn, locals, body };
}
