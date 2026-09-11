// asmlift — sink a shared STORE tail into the arms that did not share it in the source.
//
// agbcc's gcse.c PRE finds a trailing store's base partially redundant, INSERTS it at the end of
// every predecessor of the join, and the arms then cross-jump into one `store; ret`:
//
//     if (c) { for (…) …; } else { if (x) { gQ.cur = fnA; return; } }
//     gQ.cur = fnB;
//
// lifts as ONE tail block `^t(v): store gQ.cur, v; ret` that the `fnA` arm and the join the two
// sides reach both branch to. The structurer can spell that tail once, after the `if`, only if the
// `fnA` path returns before it — so this duplicates the tail back into every arm the source wrote
// it in, and leaves it for the one path the source fell into it on. With `structure()`'s
// `followEarlyReturns`, the `if`'s follow is then the kept path and each sunk arm an early
// `return;` (`synthetic:gcsetail`). Under `-fno-gcse` the tail/duplicated pairs compile
// byte-identical, and there is no loop gate: a loop before the join is a sample, not a law.
//
// WHICH PATH KEEPS THE TAIL: the value source reached from BOTH successors of the sources' nearest
// common dominator — the path every side of that `if` falls into when none of its arms fired.
// Every other source is an arm reached from one side, and receives its own copy. A source is the
// block that supplies the tail's arguments: a PURE FORWARDER (`^f(v): br ^t(v)`, reached only by
// `br`) is seen through to its own predecessors, so the arms that branch into the tail through a
// shared base reload are arms like any other (`synthetic:gcsefwd`).
//
// A LIFT VARIANT, NEVER A DEFAULT: `synthetic:gcsepre` and `synthetic:gcsepredup` compile to
// different objects (an r4/r5 swap) and lift to byte-identical IR, the first written with the
// shared tail and the second with the default duplicated into each arm — no IR rule tells them
// apart, so rank.ts enumerates this beside the unsunk lift and the differ referees.
//
// SOUND BY CONSTRUCTION: tail duplication. Each copy runs on exactly the paths that ran the tail,
// immediately before the same `ret`, with the tail's parameters replaced by the arguments that
// path carried; the stores' other operands dominate the tail and so every predecessor of it.
//
// REFUSES a tail (`TAIL_SINK_GATES`) when
//   - its sources' nearest common dominator is not a two-way `cond_br`, so there are no two sides
//     to be reached;
//   - no source, or more than one, is reached from both sides — nothing says which path the source
//     fell into it on (sinking with no kept path costs the `synthetic:armexpr`/`maskchain`/
//     `mergeu16` controls their match);
//   - an arm that must receive a copy reaches the tail by a CONDITIONAL edge, which cannot carry
//     one. The kept path may: the tail simply stays for it.
import { type Block, type Fn, type Value, dominators, mkOp, predecessors, terminator } from '../ir/core';
import { simplifyTrivialPhis } from '../ir/simplify';
import { type Gate, firstRejection } from '../l3/gates';

/** One edge that supplies the tail its arguments, composed through any forwarder between:
 *  `args` are the values the tail's parameters take on it. A CONDITIONAL edge can keep the tail
 *  and cannot receive a copy of it. */
interface Source {
  readonly from: Block;
  readonly args: readonly Value[];
  readonly conditional: boolean;
}

/** What `TAIL_SINK_GATES` judges: one store tail and the sources that reach it. */
export interface TailSinkSite {
  readonly tail: Block;
  readonly sources: readonly Source[];
  /** the sources' nearest common dominator's two successors, or null when it is not a two-way
   *  `cond_br` */
  readonly sides: readonly [Block, Block] | null;
  /** the sources reached from both sides */
  readonly kept: readonly Source[];
}

export const TAIL_SINK_GATES: readonly Gate<TailSinkSite>[] = [
  {
    id: 'dominator-is-not-a-branch',
    why: 'with no two sides, no path is the one both sides fall into',
    sound: false,
    rejects: (c) => c.sides === null,
  },
  {
    id: 'no-single-path-from-both-sides',
    why: 'nothing says which path the source fell into the tail on',
    sound: false,
    rejects: (c) => c.kept.length !== 1,
  },
  {
    id: 'conditional-arm',
    why: 'an arm that reaches the tail by a conditional branch cannot carry its own copy',
    sound: false,
    rejects: (c) => c.sources.some((s) => s.conditional && s !== c.kept[0]),
  },
];

/** A block whose ops are one or more `store`s and then a void `ret`. */
function isStoreTail(b: Block): boolean {
  const t = b.ops[b.ops.length - 1];
  return (
    b.ops.length >= 2 &&
    t.opcode === 'ret' &&
    t.operands.length === 0 &&
    b.ops.slice(0, -1).every((o) => o.opcode === 'store')
  );
}

/** Blocks reachable from `from` (itself included) without passing through `avoid`. */
function reachAvoiding(from: Block, avoid: Block): Set<Block> {
  const out = new Set<Block>();
  const stack = [from];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === avoid || out.has(x)) {
      continue;
    }
    out.add(x);
    for (const s of terminator(x)?.successors ?? []) {
      stack.push(s.block);
    }
  }
  return out;
}

/** Sink every admissible store tail into the arms reached from one side; returns whether anything
 *  changed. `gates` is the census/ablation seam, the shipped path passes nothing. */
export function sinkStoreTails(fn: Fn, gates: readonly Gate<TailSinkSite>[] = TAIL_SINK_GATES): boolean {
  let changed = false;
  for (const tail of [...fn.blocks]) {
    if (tail === fn.blocks[0] || !fn.blocks.includes(tail) || !isStoreTail(tail)) {
      continue;
    }
    const preds = predecessors(fn);
    // The sources, seen through pure forwarders. `argsOf` sends the args of an edge into the block
    // being walked to the values the tail's parameters take on it.
    const forwarders = new Set<Block>();
    const sources: Source[] = [];
    const walk = (to: Block, argsOf: (edge: readonly Value[]) => readonly Value[]) => {
      for (const p of preds.get(to) ?? []) {
        const t = terminator(p)!;
        for (const e of t.successors.filter((x) => x.block === to)) {
          const args = argsOf(e.args);
          const isForwarder =
            t.opcode === 'br' &&
            p !== fn.blocks[0] &&
            p.ops.length === 1 &&
            !forwarders.has(p) &&
            (preds.get(p) ?? []).every((q) => terminator(q)?.opcode === 'br');
          if (isForwarder) {
            forwarders.add(p);
            walk(p, (inner) => args.map((a) => (p.params.includes(a) ? inner[p.params.indexOf(a)] : a)));
          } else {
            sources.push({ from: p, args, conditional: t.opcode !== 'br' });
          }
        }
      }
    };
    walk(tail, (edge) => edge);
    if (sources.length < 2) {
      continue;
    }
    const dom = dominators(fn);
    // The sources' nearest common dominator — the tail's own immediate dominator unless a
    // forwarder stands between them.
    const common = sources.map((x) => dom.get(x.from)!).reduce((acc, d) => new Set([...acc].filter((b) => d.has(b))));
    const head = [...common].find((d) => [...common].every((x) => dom.get(d)!.has(x)));
    const term = head ? terminator(head) : undefined;
    const [s1, s2] = term?.opcode === 'cond_br' ? term.successors.map((s) => s.block) : [];
    const sides: [Block, Block] | null = s1 && s2 && s1 !== s2 && s1 !== head && s2 !== head ? [s1, s2] : null;
    let kept: Source[] = [];
    if (sides && head) {
      const [r1, r2] = [reachAvoiding(sides[0], head), reachAvoiding(sides[1], head)];
      kept = sources.filter((s) => r1.has(s.from) && r2.has(s.from));
    }
    if (firstRejection(gates, { tail, sources, sides, kept }) !== null) {
      continue;
    }
    const body = tail.ops.slice(0, -1);
    for (const src of sources) {
      if (src === kept[0]) {
        continue;
      }
      const sub = (v: Value) => (tail.params.includes(v) ? src.args[tail.params.indexOf(v)] : v);
      const copies = body.map((o) => mkOp('store', { operands: o.operands.map(sub), attrs: { ...o.attrs } }));
      src.from.ops.splice(src.from.ops.length - 1, 1, ...copies, mkOp('ret'));
    }
    // A forwarder or the tail left with no predecessor is unreachable.
    const live = predecessors(fn);
    fn.blocks = fn.blocks.filter((b) => b === fn.blocks[0] || (live.get(b) ?? []).length > 0);
    changed = true;
  }
  if (changed) {
    simplifyTrivialPhis(fn);
  }
  return changed;
}
