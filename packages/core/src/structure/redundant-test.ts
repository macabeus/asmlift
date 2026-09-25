// asmlift structurer — whether a test that READS MEMORY, and whose two arms spell the SAME
// statements, can be left out of the C. It decides nothing (both outcomes run the same code next —
// usually none, or the same edge copy into a join), and leaving it out must drop no access the
// machine made on that path. Without this the `if` reaches `l3/tailmerge.ts` and `l3/dce.ts`,
// which hoist the common statements and keep a condition that reads memory as a bare statement
// (`a1[14] >= 1;`), because they cannot tell a read the machine made there from one it made
// elsewhere.
//
// The IR can. The test is left out when every memory read in its operand cone is a load whose
// value something OUTSIDE the cone also reads, on the test's own path: a reader in a block that
// dominates the test's, or one that post-dominates it. The C then performs that read on every path
// through the test, so the bare statement would be a second read of a value the machine loaded
// once. A reader on a SIBLING path is not one: `if (a1 != 0) *a2 = *a0; else *a0 < 0;` reads `*a0`
// on both paths, and without its test the `a1 == 0` path reads nothing. A load only this test
// reads is the machine's one access there and keeps the statement, as does a call or other effect
// in the cone. A `volatile` load needs nothing more: an on-path reader already performs the one
// access the machine made, and keeping the test beside it would add a second.
//
// A test that reads NO memory is left to the passes after this one: an empty `if` over registers
// is one `l3/dce.ts` already deletes, and one whose two arms are the same non-empty statements
// prints as the lift spelled it. Collapsing those too was measured behaviour-preserving (9 more
// GameCube functions change, 0 benchmark rows) and is left out because nothing in them is read
// twice.
//
// Where the shape comes from: CodeWarrior folds a `case` label into `default:` and keeps its test,
// so `case 1: … case 0: default: …` dispatches `beq case1; bge default; b default` (mwcc_242_81;
// ac-decomp mTG_select_tag_decide_needlework, and aSNMgr_set_appear_info_guest, whose two edges
// carry the same merge value); pikmin UpdateMgr::removeClient keeps an assert's `blt`, whose other
// side held only a dead load.
//
// RENDERING ONLY, and deliberately not a CFG rewrite ahead of the raising tower: a pre-recovery
// pass turning the same `cond_br` into a `br` costs `af:adds:ido7.1` 6/41 -> 18/41. ido guards a
// `div` with `bne v0, at` over the numerator, the MIPS lift keeps that trap check as a branch whose
// arms meet, and that compare is the out-of-block reader that offers `/escape-home` on the
// numerator, the spelling that wins.
import type { Block, Op, Value } from '../ir/core';
import { EFFECTFUL_OPS, opSig } from '../ir/opcodes';
import type { UseSite } from './analysis';

export interface RedundantTestDeps {
  defs: Map<Value, Op>;
  useSitesOf: Map<Value, UseSite[]>;
  dom: Map<Block, Set<Block>>;
  ipdom: Map<Block, Block | null>;
}

/** Whether `branch`, the terminator of `at`, only re-reads what the machine read on its path. */
export function testRereadsOnly(branch: Op, at: Block, deps: RedundantTestDeps): boolean {
  const { defs, useSitesOf, dom, ipdom } = deps;
  const cone = new Set<Op>();
  const loads: Op[] = [];
  const work = [...branch.operands];
  for (let v = work.pop(); v !== undefined; v = work.pop()) {
    const op = defs.get(v);
    if (op === undefined || cone.has(op)) {
      continue;
    }
    if (EFFECTFUL_OPS.has(op.opcode)) {
      return false;
    }
    cone.add(op);
    if (opSig(op.opcode)?.reads === true) {
      loads.push(op);
    }
    work.push(...op.operands);
  }
  const onPath = (b: Block): boolean => {
    if (dom.get(at)?.has(b)) {
      return true;
    }
    for (let p = ipdom.get(at); p; p = ipdom.get(p)) {
      if (p === b) {
        return true;
      }
    }
    return false;
  };
  return (
    loads.length > 0 &&
    loads.every((ld) =>
      ld.results.some((r) =>
        (useSitesOf.get(r) ?? []).some((u) => u.op !== branch && !cone.has(u.op) && onPath(u.blk)),
      ),
    )
  );
}
