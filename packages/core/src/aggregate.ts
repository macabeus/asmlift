// asmlift — a declared struct or union on a target: its size, and whether a function returning it
// by value hands it back through a hidden pointer. The members come from a declaration
// (`proto.ts` AggregateLayout); the layout rules and the return rule are the target's
// (`compilerBehaviors.aggregateBoundary`, `largestAlignment`, `aggregateReturn`).
import { type AggregateLayout, type AggregateMember, type FnProto, declaredWidth } from './proto';
import type { TargetDescription } from './target';

/** The size and alignment of a laid-out aggregate in bytes, or undefined where the declaration or
 *  the target leaves either open: a member not laid out, a bitfield (whose packing is not modelled
 *  here), or a target that states no largest alignment. */
export function aggregateSize(
  layout: AggregateLayout,
  target: TargetDescription,
): { size: number; align: number } | undefined {
  const { aggregateBoundary, largestAlignment } = target.compilerBehaviors;
  if (layout.members === undefined || aggregateBoundary === undefined || largestAlignment === undefined) {
    return undefined;
  }
  let size = 0;
  let align = aggregateBoundary;
  for (const m of layout.members) {
    const one = memberSize(m, target);
    if (one === undefined) {
      return undefined;
    }
    align = Math.max(align, one.align);
    if (layout.kind === 'struct') {
      size = roundUp(size, one.align) + one.size;
    } else {
      size = Math.max(size, one.size);
    }
  }
  return { size: roundUp(size, align), align };
}

function memberSize(m: AggregateMember, target: TargetDescription): { size: number; align: number } | undefined {
  if (m.bits !== undefined) {
    return undefined;
  }
  const count = (m.dims ?? []).reduce((n, d) => n * d, 1);
  if (typeof m.type !== 'string') {
    const inner = aggregateSize(m.type, target);
    return inner === undefined ? undefined : { size: inner.size * count, align: inner.align };
  }
  const bits = declaredWidth(m.type);
  if (bits === undefined) {
    return undefined;
  }
  const bytes = bits / 8;
  return { size: bytes * count, align: Math.min(bytes, target.compilerBehaviors.largestAlignment!) };
}

const roundUp = (n: number, to: number): number => Math.ceil(n / to) * to;

/** The aggregate a declaration says `p` returns by value (`declaresAggregateReturn`): its stated
 *  layout, or the bare kind its `returns` spells. */
export function returnedAggregate(p: FnProto): AggregateLayout {
  return p.returnLayout ?? { kind: /\bunion\b/.test(p.returns ?? '') ? 'union' : 'struct' };
}

/** Whether a function declared to return `layout` by value hands it back through memory — so its
 *  caller passes the address as argument 0 — or `undefined` where the target states no rule or the
 *  rule needs a size the layout does not give. */
export function returnsInMemory(layout: AggregateLayout, target: TargetDescription): boolean | undefined {
  const rule = target.compilerBehaviors.aggregateReturn;
  if (rule === undefined) {
    return undefined;
  }
  if (rule === 'memory') {
    return true;
  }
  if (rule === 'svr4') {
    const size = aggregateSize(layout, target)?.size;
    return size === undefined ? undefined : size > 8;
  }
  // agbcc thumb.c:1423-1493: a struct's second member that is not a bitfield puts it in memory
  // whatever its size; otherwise anything over a word does
  const members = layout.members;
  if (layout.kind === 'struct' && members?.slice(1).some((m) => m.bits === undefined)) {
    return true;
  }
  const size = aggregateSize(layout, target)?.size;
  if (size === undefined) {
    return undefined;
  }
  if (size > 4 || layout.kind === 'struct') {
    return size > 4;
  }
  // a union: in memory as soon as one member would be on its own — an array member is an aggregate
  // that is neither a struct nor a union, which thumb.c puts in memory (line 1491)
  let answer: boolean | undefined = false;
  for (const m of members!) {
    const own = m.dims !== undefined ? true : typeof m.type === 'string' ? false : returnsInMemory(m.type, target);
    if (own === true) {
      return true;
    }
    if (own === undefined) {
      answer = undefined;
    }
  }
  return answer;
}
