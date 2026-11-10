// asmlift structurer — the block-argument copies an edge writes: the order the predecessor wrote
// their destinations in (`NO_RECORD`, `NO_WRITTEN_DESTINATIONS`, and `edgeCopyOrdersDiffer`, the
// `/copy-defpos` enumeration gate), and their sequentialisation into assignments that never
// clobber a value a later one still reads (`sequentialize`, `copySetIsCyclic`).
import { Fn, Value, defOpMap } from '../ir/core';
import type { IrType } from '../ir/types';
import { Expr, Stmt } from '../l3/ast';
import { exprVars, substVar } from './ast-rewrites';
import { StructureError } from './structure-error';

/** No evidence about where this copy goes — NOT "written before everything". A destination the
 *  predecessor never wrote is an argument passing through, and both orders put those first, so the
 *  record answers no question the assembly put to it. Priced where the sort runs. */
export const NO_RECORD = -1;
/** A MEASURED predecessor that recorded no destination of this edge — it wrote registers, none of
 *  them a key this edge copies. Distinct from an UNMEASURED pred, which has no record at all and
 *  falls back to the def-position proxy. */
export const NO_WRITTEN_DESTINATIONS: ReadonlyMap<Value, number> = new Map<Value, number>();

/** Does the write-order record order some edge's copies differently from the def-position proxy?
 *  rank.ts's enumeration gate for `/copy-defpos`: where the two orders agree, the sibling is the
 *  same tree and the fan does not grow.
 *
 *  A SUPERSET of the real sort, on purpose and in the safe direction — and the direction only
 *  holds because rank asks this of the SAME fn it then structures (a `perLiftGate`, evaluated on
 *  that lift's own fully-raised fn). Two gaps remain, both of which only say YES where the sort
 *  says nothing: `keepSlot`/`suppressedArgs` drop copies this still counts, and this asks of every
 *  edge where `preferDefPosCopyOrder` reorders only the acyclic ones (`copySetIsCyclic` needs the
 *  built copy list, which is not available here). So it can answer true for a pair that later
 *  collapses — the tree dedup then eats it — but never false for one that does not.
 *
 *  ASKED ANY EARLIER THE CLAIM FAILS, in both directions. The answer moves with the SYMBOL MAP
 *  (klonoa's `UpdateHUDCollectibleCount` answers false under the map and true without it, off one
 *  asm — test/corpus/agbcc-hudcount.s) and with the STAGE, because `raise/latch.ts` rewrites the
 *  record this reads (klonoa's `EntityGravityAndFloorCheck`: false after `recoverTypes`, true
 *  after `foldEmptyLatches` — a RECORD of a measurement, not a live check: that function is in no
 *  corpus row and no fixture here, so the claim cannot be re-run from this repo).
 *
 *  A SECOND, HAND-WRITTEN SPELLING of `edgeCopyRecords`' two comparators — including the stability
 *  that decides ties — not a call into them, and nothing forces the two to agree. A change to that
 *  sort has to be mirrored here BY HAND, or this gate keeps answering about an ordering the pass no
 *  longer produces. Unified deliberately not: this is `/copy-defpos`'s perLiftGate, so it decides
 *  which candidates are ENUMERATED and its predicate cannot move without moving rows. */
export function edgeCopyOrdersDiffer(fn: Fn): boolean {
  const order = fn.writeOrder;
  if (order === undefined) {
    return false;
  }
  const defs = defOpMap(fn);
  for (const pred of fn.blocks) {
    if (!order.writes.has(pred)) {
      continue;
    }
    const rec = order.lastWrite.get(pred) ?? NO_WRITTEN_DESTINATIONS;
    const opAt = new Map(pred.ops.map((o, i) => [o, i] as const));
    for (const op of pred.ops) {
      for (const succ of op.successors) {
        if (succ.args.length < 2) {
          continue;
        }
        const slots = succ.args.map((_, i) => i);
        const proxyPos = (i: number) => {
          const d = defs.get(succ.args[i]);
          return d !== undefined && opAt.has(d) ? opAt.get(d)! : NO_RECORD;
        };
        const byRecord = [...slots].sort(
          (a, b) => (rec.get(succ.block.params[a]) ?? NO_RECORD) - (rec.get(succ.block.params[b]) ?? NO_RECORD),
        );
        const byProxy = [...slots].sort((a, b) => proxyPos(a) - proxyPos(b));
        if (byRecord.some((v, i) => v !== byProxy[i])) {
          return true;
        }
      }
    }
  }
  return false;
}

// Sequentialise a parallel copy: order the assignments so none writes a variable that a
// still-pending assignment reads; break a cycle by spilling one destination to a temp.
// `tmp` is the per-FUNCTION temp counter (threaded from structure()) so two independent
// parallel copies never reuse a temp name against conflicting types.
/** Does this edge's copy set contain a CYCLE — no copy emittable without overwriting a destination
 *  another still reads, so `sequentialize` has to spill one into a temp? `sequentialize`'s own
 *  emittability loop, run without emitting, so the two can never disagree about which sets are
 *  which.
 *
 *  It is the LICENCE BOUNDARY the edge-copy sort draws: on a cyclic set an instruction names the
 *  compiler's temp and the write-order record reproduces it, while on an acyclic one the record is
 *  only an assumption about layout order. `preferDefPosCopyOrder` asks for the proxy on the second
 *  kind only. */
export function copySetIsCyclic(copies: { name: string; value: Expr }[]): boolean {
  const pending = copies.map((c) => ({ name: c.name, reads: exprVars(c.value) }));
  for (;;) {
    const i = pending.findIndex((a) => !pending.some((b) => b !== a && b.reads.has(a.name)));
    if (i < 0) {
      return pending.length > 0;
    }
    pending.splice(i, 1);
  }
}

export function sequentialize(
  copies: { name: string; value: Expr }[],
  varType: Map<string, IrType>,
  tmp: { n: number },
  fnName: string,
): Stmt[] {
  // Two writes to one destination have no correct order — that is two phi params coalesced onto
  // one name, which canTakeName prevents upstream. Fail loud, never pick one.
  const dests = new Set<string>();
  for (const c of copies) {
    if (dests.has(c.name)) {
      throw new StructureError(`cannot structure '${fnName}': parallel copy writes '${c.name}' twice (coalescing bug)`);
    }
    dests.add(c.name);
  }
  const pending = copies.map((c) => ({ ...c, reads: exprVars(c.value) }));
  const out: Stmt[] = [];
  while (pending.length) {
    const i = pending.findIndex((a) => !pending.some((b) => b !== a && b.reads.has(a.name)));
    if (i >= 0) {
      const a = pending.splice(i, 1)[0];
      out.push({ k: 'assign', name: a.name, value: a.value });
      continue;
    }
    // All remaining form a cycle: spill one destination into a temp, rewrite its readers, and
    // RECOMPUTE their read-sets — with stale sets the spilled copy never becomes emittable and
    // the loop mints fresh temps forever.
    const a = pending[0];
    const t = `t${tmp.n++}`;
    varType.set(t, varType.get(a.name)!);
    out.push({ k: 'assign', name: t, value: { k: 'var', name: a.name } });
    for (const b of pending) {
      if (b !== a) {
        b.value = substVar(b.value, a.name, t);
        b.reads = exprVars(b.value);
      }
    }
  }
  return out;
}
