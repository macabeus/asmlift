// THE LAYOUT OF A CROSS-JUMPED RETURN TAIL: does the asm show that the compiler merged a return
// tail the source wrote into every arm, where the structurer took the join past early returns?
//
// A compiler that cross-jumps return tails (target.ts `crossJumpsReturnTails`, gcc 2.x jump.c)
// leaves the same CFG for `if (a) { x = 1; tail(); return; } ... tail();` and for `if (a) x = 1;
// ... tail();`: one copy of the tail, which every arm reaches. The two spellings differ in WHERE
// that copy sits and in WHICH arms became one block, because `do_cross_jump` keeps the copy of
// the LATER jumping arm and jumps the earlier one to a new label before it. That label stops
// further merging (`INSN_UID (JUMP_LABEL (insn)) < max_uid`). So the copies spelling leaves one of
// two marks in the object, and the join spelling leaves neither:
//
//   (A) THE TAIL IS NOT LAST. The surviving copy ends in an unconditional jump (A1), and a block of
//       the construct that never reaches the tail is laid out after it (A2). That is an arm that
//       did not use the tail, left where the source wrote it. The join writes the tail after the
//       whole construct, where it falls into what follows it. A bare return block does not count
//       for A2: the epilogue an early `return` reaches is laid out last under either spelling.
//   (B) IDENTICAL ARMS STAYED APART. Two arms that reach the tail and nothing else have the same
//       instructions. Under the join, each arm jumps to the join's one original label, and jump2
//       merges identical bodies before it. Under the copies, the first cross-jump made a new label,
//       and the merge never ran.
//
// MEASURED, not derived. Over the 620 real functions where the join re-spells the default
// (2026-11-05), the bound plus (A1 & A2) | B gave MATCH 44, against 35 for the copies everywhere and
// 40 for the size bound alone, with no match lost. That was a simulation from the two readings'
// scores. The probe pairs in cross-jumped-tail.test.ts show each mark on agbcc.
//
// Read only from the frontend's layout record (ir/core.ts `AsmLayout`). A block with no entry, such
// as one a raise pass made up, is no evidence either way. A function with no record (parsed IR)
// has no mark.
import type { AsmLayout, Block, Fn } from '../ir/core';
import type { JoinPastReturnsSite } from './structure';

const succsOf = (b: Block): Block[] => [...new Set(b.ops[b.ops.length - 1]?.successors.map((s) => s.block) ?? [])];

/** Every block reachable from `from`, `from` included, never entering `avoid`. */
function reach(from: Block, avoid?: Block): Set<Block> {
  const seen = new Set<Block>();
  const stack = [from];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === avoid || seen.has(x)) {
      continue;
    }
    seen.add(x);
    stack.push(...succsOf(x));
  }
  return seen;
}

const isBareReturn = (b: Block): boolean => b.ops.length === 1 && b.ops[0].opcode === 'ret';

/** Does `site` show either mark of a cross-jumped return tail in `fn`'s asm layout? */
export function crossJumpedTail(fn: Fn, site: JoinPastReturnsSite): boolean {
  const layout: AsmLayout | undefined = fn.asmLayout;
  const at = layout?.get(site.join);
  if (layout === undefined || at === undefined) {
    return false;
  }
  return (at.endsInJump && armLaidOutAfter(fn, layout, site, at.index)) || identicalArms(fn, layout, site.join);
}

/** (A2): a block of the construct, reached from its branch short of the join, that never reaches
 *  the join and is laid out after it. A bare return does not count. */
function armLaidOutAfter(fn: Fn, layout: AsmLayout, site: JoinPastReturnsSite, joinIndex: number): boolean {
  const fromJoin = reach(site.join);
  const reachesJoin = new Set<Block>([site.join]);
  const preds = predecessors(fn);
  const stack = [site.join];
  while (stack.length) {
    for (const p of preds.get(stack.pop()!) ?? []) {
      if (!reachesJoin.has(p)) {
        reachesJoin.add(p);
        stack.push(p);
      }
    }
  }
  for (const x of reach(site.branch, site.join)) {
    const xi = layout.get(x)?.index;
    if (xi !== undefined && xi > joinIndex && !fromJoin.has(x) && !reachesJoin.has(x) && !isBareReturn(x)) {
      return true;
    }
  }
  return false;
}

/** (B): two predecessors of the join, each with the join as its only successor, whose asm bodies are
 *  the same non-empty instructions. */
function identicalArms(fn: Fn, layout: AsmLayout, join: Block): boolean {
  const seen = new Set<string>();
  for (const p of predecessors(fn).get(join) ?? []) {
    const body = layout.get(p)?.body;
    if (body === undefined || body.length === 0 || succsOf(p).length !== 1) {
      continue;
    }
    const key = body.join('\n');
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

function predecessors(fn: Fn): Map<Block, Block[]> {
  const preds = new Map<Block, Block[]>(fn.blocks.map((b) => [b, []]));
  for (const b of fn.blocks) {
    for (const s of succsOf(b)) {
      preds.get(s)?.push(b);
    }
  }
  return preds;
}
