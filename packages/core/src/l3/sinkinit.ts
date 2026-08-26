// L3 re-spelling lever: sink each leading pointer-base INIT to the statement that first uses it.
//
// `l3/basecse.ts`'s COMMITTED call emits every base hoist at the head of `sfn.body`, so a base
// first touched halfway down the function is live across everything above it — a live range the
// original never had, and agbcc pays for it with a callee-saved register. (Its roster admissions
// can ask for this placement directly, through the same `l3/hoist.ts` mechanism this lever uses;
// what this lever adds is reaching the run on a tree NOTHING re-hoisted.) Compiled pair on `synthetic:basehome`:
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
// mints into, placed by the same `l3/hoist.ts` mechanism under its other policy, so the two passes
// cannot disagree about where the run ends or how a body carrying it is rebuilt. Each init sinks to
// immediately before the first TOP-LEVEL statement mentioning its name and never INTO a nested
// scope, so it still dominates every use — planning a hoist inside a scope is `l3/scopebase.ts`'s
// job and it does the domination work. `placeBaseLocals` carries the refusals; a run where none of
// them moves is this lever declining.
//
// SEMANTICS BY CONSTRUCTION: the moved value is a pure address leaf — it reads nothing, writes its
// own plain cell and cannot fault — and every statement it crosses mentions the name nowhere, an
// `&p` escape included (mentions.ts counts `addr` as a mention). All later evaluation can change
// is where the allocator puts it.
import type { SFn } from './ast';
import { placeBaseLocals } from './hoist';

export function sinkInitsToFirstUse(sfn: SFn): SFn | null {
  const { body, moved } = placeBaseLocals(sfn, sfn.body, [], 'first-use');
  return moved === 0 ? null : { ...sfn, body };
}
