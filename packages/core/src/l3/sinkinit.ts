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
// SCOPE (decline over approximate). Only the LEADING run of init-shaped assigns moves, the same
// shape basecse.ts recognizes when it re-orders that run: a ptr-cast of an `addr`/`const` leaf into
// a declared NON-VOLATILE local. Each sinks to immediately before the first TOP-LEVEL statement
// mentioning its name and never INTO a nested scope, so the init still dominates every use —
// planning a hoist inside a scope is `l3/scopebase.ts`'s job and it does the domination work.
// REFUSES: a local the function writes anywhere else (the sink would cross that write), one
// nothing in the remaining body mentions (no first use to sink to), one already sitting
// immediately above its first use, and a `volatile` local — two writes to volatile locals are
// observably ordered, so one at the head simply ends the run.
//
// SEMANTICS BY CONSTRUCTION: the moved value is a pure address leaf — it reads nothing, writes its
// own plain cell and cannot fault — and every statement it crosses mentions the name nowhere, an
// `&p` escape included (mentions.ts counts `addr` as a mention). All later evaluation can change
// is where the allocator puts it.
import type { SFn, Stmt } from './ast';
import { localMentions } from './mentions';

type Assign = Extract<Stmt, { k: 'assign' }>;

const isInitShaped = (s: Stmt, plain: ReadonlySet<string>): s is Assign =>
  s.k === 'assign' &&
  plain.has(s.name) &&
  s.value.k === 'cast' &&
  s.value.to.kind === 'ptr' &&
  (s.value.e.k === 'addr' || s.value.e.k === 'const');

export function sinkInitsToFirstUse(sfn: SFn): SFn | null {
  const plain = new Set(sfn.locals.filter((l) => !l.volatile).map((l) => l.name));
  let head = 0;
  while (head < sfn.body.length && isInitShaped(sfn.body[head], plain)) {
    head++;
  }
  if (head === 0) {
    return null;
  }
  const rest = sfn.body.slice(head);
  const whole = localMentions(sfn);
  const inRest = localMentions({ ...sfn, body: rest });
  const stay: Assign[] = [];
  const sunk: { at: number; init: Assign }[] = [];
  for (const init of sfn.body.slice(0, head) as Assign[]) {
    const at = whole.get(init.name)?.assigns === 1 ? inRest.get(init.name)?.firstAt : null;
    if (at === null || at === undefined || at === 0) {
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
