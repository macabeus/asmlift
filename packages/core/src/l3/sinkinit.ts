// L3 re-spelling lever: sink each leading pointer-base INIT to the statement that first uses it.
//
// `l3/basecse.ts` emits every base hoist at the head of `sfn.body`, so a base first touched
// halfway down the function is live across everything above it — a live range the original never
// had, and agbcc pays for it with a callee-saved register. Compiled pair on `synthetic:basehome`:
// assigning at the top adds `push {r4, lr}` / `pop {r4}` / `pop {r0}` / `bx r0` where assigning at
// the first use keeps a plain `bx lr`. The ladder that row records is the argument for the lever
// being a PLACEMENT rather than a wider hoist — top-placed 11, not hoisted at all 9, placed at
// first use 0. A hoist at the wrong place is worse than no hoist.
//
// A LEVER, NOT THE DEFAULT. Which placement the source used is per-function knowledge the asm does
// not carry: moving basecse's own head placement to first use moves 8 benchmark rows, 4 better and
// 4 worse, two of the losses being matches. As a candidate the head-placed spelling always rides
// beside this one and the differ referees, so it can never cost a match.
//
// SCOPE (decline over approximate). Only the LEADING run of base inits moves — the run basecse.ts
// re-orders, split by the same `l3/hoist.ts` mechanism so the two passes cannot disagree about
// where it ends. Each sinks to immediately before the first TOP-LEVEL statement mentioning its
// name and never INTO a nested scope, so the init still dominates every use — planning a hoist
// inside a scope is `l3/scopebase.ts`'s job and it does the domination work. REFUSES: a local the
// function writes anywhere else (the sink would cross that write), one nothing in the remaining
// body mentions (no first use to sink to), and one already sitting immediately above its first use.
//
// SEMANTICS BY CONSTRUCTION: the moved value is a pure address leaf — it reads nothing, writes its
// own plain cell and cannot fault — and every statement it crosses mentions the name nowhere, an
// `&p` escape included (mentions.ts counts `addr` as a mention). All later evaluation can change
// is where the allocator puts it.
import type { SFn } from './ast';
import { type BaseInit, firstUseIn, splitLeadingBaseInits } from './hoist';
import { localMentions } from './mentions';

export function sinkInitsToFirstUse(sfn: SFn): SFn | null {
  const { inits: head, rest } = splitLeadingBaseInits(sfn, sfn.body);
  if (head.length === 0) {
    return null;
  }
  const whole = localMentions(sfn);
  const firstUse = firstUseIn(sfn, rest);
  const stay: BaseInit[] = [];
  const sunk: { at: number; init: BaseInit }[] = [];
  for (const init of head) {
    const at = whole.get(init.name)?.assigns === 1 ? firstUse.get(init.name) : undefined;
    if (at === undefined || at === 0) {
      stay.push(init);
    } else {
      sunk.push({ at, init });
    }
  }
  if (sunk.length === 0) {
    return null;
  }
  const body = [...rest];
  // Descending by index, so an earlier insertion does not shift the position a later one was
  // computed against. Two inits sharing a target come out reversed; both are pure address assigns,
  // so the order among them means the same thing.
  for (const { at, init } of [...sunk].sort((a, b) => b.at - a.at)) {
    body.splice(at, 0, init);
  }
  return { ...sfn, body: [...stay, ...body] };
}
