// asmlift structurer — LOOP-EMISSION HAZARD checks: may this loop's updates be emitted before
// its condition/exit/post-loop reads, or would some read then see a clobbered (post-update)
// value that the original IR read PRE-update? Every check here is PURE — it reads the analysis
// maps and decides; nothing mutates — which is what lets the emission sites call it freely
// before committing to a loop form, and decline loud instead of miscompiling.
//
// The factory takes its dependencies EXPLICITLY (`LoopHazardDeps`), the switch-recover pattern.
// The maps are captured as LIVE REFERENCES, deliberately: `varName` is still being populated by
// the naming pipeline when the factory is created, and each hazard check reads whatever names
// exist at CALL time (emission runs after naming completes). Snapshotting them would break this.
import { Block, Op, Value } from '../ir/core';
import { Stmt } from '../l3/ast';
import type { UseSite } from './analysis';

export interface LoopHazardDeps {
  /** value → defining op (defOpMap) */
  defs: Map<Value, Op>;
  /** value → adopted variable name — LIVE: populated by the naming pipeline, read at call time */
  varName: Map<Value, string>;
  /** every positioned use of a value (analysis.ts) */
  useSitesOf: Map<Value, UseSite[]>;
}

export interface LoopHazards {
  readsClobbered(v: Value, sub: Map<Value, string>, updateWrites: Set<string>): boolean;
  loopEscapeHazard(
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region?: Set<Block> | null,
    loopParams?: Set<Value>,
  ): boolean;
  loopUpdateHazard(
    condV: Value,
    exitArgs: Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region: Set<Block> | null,
    loopParams: Set<Value>,
  ): boolean;
}

/** The names a loop update assigns (its non-identity copies) — the write set every loop-emission
 *  hazard check tests against. Dependency-free, so a plain function, not a factory member. */
export const updateWriteSet = (updates: Stmt[]): Set<string> =>
  new Set(updates.filter((st): st is Extract<Stmt, { k: 'assign' }> => st.k === 'assign').map((st) => st.name));

export function makeLoopHazards(deps: LoopHazardDeps): LoopHazards {
  const { defs, varName, useSitesOf } = deps;

  // Does rendering `v` under `sub` read a variable that a pending loop update (`updateWrites`, the
  // names it assigns) overwrites, via a path OTHER than a `sub`-mapped back-edge arg? Such a read is a
  // PRE-update value the update clobbers → a read-after-write hazard when the update is emitted first.
  // Walks the def-tree exactly like `exprWith`, stopping at `sub` values (intended post-update → safe)
  // and named values (a var: hazard iff its name is a write-target). Pure (no mutation), so it is safe
  // to call before emitting.
  const readsClobbered = (v: Value, sub: Map<Value, string>, updateWrites: Set<string>): boolean => {
    const seen = new Set<Value>();
    const walk = (x: Value): boolean => {
      if (seen.has(x)) {
        return false;
      }
      seen.add(x);
      if (sub.has(x)) {
        return false;
      } // sub-mapped → post-update, safe
      if (varName.has(x)) {
        return updateWrites.has(varName.get(x)!);
      } // a named var: hazard iff clobbered
      const d = defs.get(x);
      return d ? d.operands.some(walk) : false; // inline (mirrors exprWith's recursion)
    };
    return walk(v);
  };

  // A value computed INSIDE a loop and used after it renders post-loop under `sub`, where each
  // updated loop variable already holds its FINAL value. That is only correct when every
  // loop-variable read goes through a sub-mapped back-edge arg (the intended post-update read); a
  // direct read of an updated variable meant the LAST-ITERATION PRE-update value, which the
  // post-loop name no longer holds. Scans every value defined in `body` for a use outside it (or,
  // when `region` is given, inside that specific post-loop region) whose rendering readsClobbered
  // flags. Same hazard test the early-exit path applies to its condition and edge args.
  const loopEscapeHazard = (
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region: Set<Block> | null = null,
    loopParams: Set<Value> = new Set(),
  ): boolean => {
    // Body-block PARAMS escape too: a non-loop-carried param whose adopted name the update writes
    // reads post-loop as the clobbered value. canTakeName prevents that adoption, so this firing
    // means a naming bug — decline loud, never emit. The loop's own carried params (`loopParams`)
    // are exempt: their post-loop read of the updated name is exactly the intended final value.
    const escaped = (v: Value): boolean => {
      for (const s of useSitesOf.get(v) ?? []) {
        if (region ? region.has(s.blk) : !body.has(s.blk)) {
          return true;
        }
      }
      return false;
    };
    for (const bb of body) {
      for (const pv of bb.params) {
        if (loopParams.has(pv)) {
          continue;
        }
        if (escaped(pv) && updateWrites.has(varName.get(pv)!)) {
          return true;
        }
      }
      for (const op of bb.ops) {
        for (const r of op.results) {
          if (escaped(r) && readsClobbered(r, sub, updateWrites)) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // The loop-emission hazard check, in ONE place (shared by the guard-fused, early-exit, and
  // do-while sites): the loop condition, the exit-edge args, and every escaped body value must
  // read loop variables ONLY through sub-mapped back-edge args (post-update); any direct read of
  // an updated name is a pre-update value the emitted C no longer holds. Callers keep their
  // distinct decline behavior.
  const loopUpdateHazard = (
    condV: Value,
    exitArgs: Value[],
    body: Set<Block>,
    sub: Map<Value, string>,
    updateWrites: Set<string>,
    region: Set<Block> | null,
    loopParams: Set<Value>,
  ): boolean =>
    readsClobbered(condV, sub, updateWrites) ||
    exitArgs.some((a) => readsClobbered(a, sub, updateWrites)) ||
    loopEscapeHazard(body, sub, updateWrites, region, loopParams);

  return { readsClobbered, loopEscapeHazard, loopUpdateHazard };
}
