// AN EARLY RETURN THAT THE JOIN PAST EARLY RETURNS CANNOT SPELL: a return of the value its branch
// tested equal to a constant, where the object still returns the value and not the constant.
//
// On a compiler whose cse folds a branch-proven constant only into the branch's FALL-THROUGH arm
// (target.ts `foldsBranchConstantOnTakenEdge` false: gcc 2.x at -O1), `if (x == 0) return x;`
// compiles to `return 0`, and so does the same test spelled `if (x != 0) ; else return x;`. The join
// writes the early return one of those two ways. A return of `x` the object left unfolded was
// therefore the jump-target arm of its branch in the source: the `else` of `if (x != 0) { ...tail }
// else { return x; }`, which is the copies' spelling. So this mark publishes the copies.
//
// THE CONSTANT IS NOT REMATERIALISED ON THE EDGE. Read off the lifted IR: the return block's value
// is the very SSA value the comparison reads, not a constant. A delay slot that set the return
// register to the constant (`beqz v0,L; move v0,zero`) lifts as a `const` returned on that edge, and
// is no mark.
//
// MEASURED on the probe pair `corpus/probe-rettail-pg-{copies,join}.c` (unfolded-branch-constant.test.ts)
// and on Mario Party 3's `func_8010BD28_472F98_mgmode`, which it is the shape of: gcc2.7.2 -O1, the
// copies `nop` in the `beqz`'s slot and the join `move v0,zero`. There the join loses the copies'
// match (0 -> 1 line off, really compiled, 2026-11-06).
//
// AN `if` SITE ONLY. The premise is an `if`'s two arms, one of them the fall-through. A switch's case
// arms, read as a switch (`tree`) or a jump table (`switch`), are each a jump target, a case label,
// so no return in one folds the switch value at -O1 whatever the source wrote, and an unfolded one
// says nothing. Compiled at gcc2.7.2 -O1: `switch (x) { case 0: return x; case 5: p[1] = 2; break; }`
// followed by its tail, written with the join, keeps `move v0,a0` in the case-0 jump's slot, and
// the join and the copies both compile byte-exact. A switch the structurer reads as `if`s (three
// cases of that function) is still read, the residue of the rule: no reading of it is exact.
//
// A MARK IS EVIDENCE, NOT PROOF, as structure/cross-jumped-tail.ts says of its own: it moves which
// verified reading is the default, never what is lifted. Read only where the target says its cse
// leaves the taken edge unfolded; elsewhere (`true`, or absent) an unfolded return says nothing.
import type { Block, Fn, Op, Value } from '../ir/core';
import type { JoinPastReturnsSite } from './structure';

const succsOf = (b: Block): Block[] => [...new Set(b.ops[b.ops.length - 1]?.successors.map((s) => s.block) ?? [])];

/** Does an early return of the `if` site `site` give back, unfolded, the value its own branch tested
 *  equal to a constant? The return block holds only its `ret`, has one predecessor, and that
 *  predecessor's `cond_br` takes it on the equal side of an `icmp_eq`/`icmp_ne` of that value against
 *  a `const`. */
export function unfoldedBranchConstant(fn: Fn, site: JoinPastReturnsSite): boolean {
  if (site.kind !== 'if') {
    return false;
  }
  const def = new Map<Value, Op>();
  const preds = new Map<Block, Block[]>(fn.blocks.map((b) => [b, []]));
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        def.set(r, op);
      }
    }
    for (const s of succsOf(b)) {
      preds.get(s)?.push(b);
    }
  }
  const seen = new Set<Block>();
  const stack = [site.branch];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === site.join || seen.has(x)) {
      continue;
    }
    seen.add(x);
    stack.push(...succsOf(x));
  }
  for (const r of seen) {
    const ret = r.ops.length === 1 ? r.ops[0] : undefined;
    const value = ret?.opcode === 'ret' && ret.operands.length === 1 ? ret.operands[0] : undefined;
    const from = preds.get(r) ?? [];
    if (value === undefined || from.length !== 1 || fn.asmLayout?.get(r) === undefined) {
      continue;
    }
    const br = from[0].ops[from[0].ops.length - 1];
    const cmp = br?.opcode === 'cond_br' ? def.get(br.operands[0]) : undefined;
    if (cmp === undefined || br.successors.length !== 2 || br.successors[0].block === br.successors[1].block) {
      continue;
    }
    const equalSide = cmp.opcode === 'icmp_eq' ? 0 : cmp.opcode === 'icmp_ne' ? 1 : -1;
    if (equalSide < 0 || br.successors[equalSide].block !== r || cmp.operands.length !== 2) {
      continue;
    }
    const [a, b] = cmp.operands;
    const isConst = (v: Value) => def.get(v)?.opcode === 'const';
    if ((a === value && isConst(b)) || (b === value && isConst(a))) {
      return true;
    }
  }
  return false;
}
