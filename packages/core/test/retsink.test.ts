// raise/retsink.ts — return-sinking, and the SSA debris it leaves.
//
// Sinking rewrites `br ^merge(v)` into `ret v` in every unconditional predecessor. A merge also
// reached by a `cond_br` keeps that one edge — a conditional branch cannot carry a `ret` — so the
// block survives with a single predecessor, and a block parameter with one in-edge is no longer a
// join. The asm below is agbcc's own output for a fall-through switch: `.L3` is reached by a
// `b .L3`, by falling out of `.L6` — which has two predecessors of its own, the shared arm the
// sinking gate looks for — and by a `bne .L3` that cannot be rewritten.
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import type { Value } from '../src/ir/core';
import { firstTrivialPhi, simplifyTrivialPhis } from '../src/ir/simplify';
import { applyIdiomPatterns, decompile, raiseRecovered } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const ASM =
  'f:\n' +
  '\tcmp\tr0, #0x2\n\tbeq\t.L5\t@cond_branch\n' +
  '\tcmp\tr0, #0x2\n\tbgt\t.L9\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.L6\t@cond_branch\n' +
  '\tb\t.L3\n' +
  '.L9:\n\tcmp\tr0, #0x3\n\tbne\t.L3\t@cond_branch\n' +
  '\tmov\tr0, #0x1\n\tstr\tr0, [r1]\n' +
  '.L5:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x2\n\tstr\tr0, [r1]\n' +
  '.L6:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x3\n\tstr\tr0, [r1]\n' +
  '.L3:\n\tbx\tlr\n';

const PROTO = { prototypes: { f: { returnsVoid: true } } } as const;

test('return-sinking leaves no trivial phi behind', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('f', ASM, ARMV4T_AGBCC, PROTO.prototypes);
  applyIdiomPatterns(fn, ARMV4T_AGBCC);
  raiseRecovered(fn, ARMV4T_AGBCC, {}, PROTO.prototypes.f);
  // The residual `.L3` keeps its `cond_br` in-edge and nothing else, so its parameter is an alias
  // of that edge's argument. Re-running the substrate cleanup must find nothing left to do.
  expect(simplifyTrivialPhis(fn)).toBe(0);
  const oneInEdge = fn.blocks.filter(
    (b) =>
      b !== fn.blocks[0] &&
      b.params.length > 0 &&
      fn.blocks.flatMap((p) => p.ops.flatMap((o) => o.successors)).filter((s) => s.block === b).length === 1,
  );
  expect(oneInEdge).toEqual([]);
});

// The same dispatch, returning the accumulator instead of storing it — so the residual merge's
// parameter is READ, and the structurer has to spell it.
const ASM_RET =
  'g:\n' +
  '\tmov\tr1, #0x0\n' +
  '\tcmp\tr0, #0x2\n\tbeq\t.L5\t@cond_branch\n' +
  '\tcmp\tr0, #0x2\n\tbgt\t.L9\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.L6\t@cond_branch\n' +
  '\tb\t.L3\n' +
  '.L9:\n\tcmp\tr0, #0x3\n\tbne\t.L3\t@cond_branch\n\tmov\tr1, #0x1\n' +
  '.L5:\n\tadd\tr1, r1, #0x1\n' +
  '.L6:\n\tadd\tr1, r1, #0x1\n' +
  '.L3:\n\tadd\tr0, r1, #0\n\tbx\tlr\n';

test('the stranded alias is not spelled as a copy', () => {
  // Left in place, the structurer destroys the alias into a local of its own and emits
  // `v = 0; return v;` — a variable the asm never had, on the one path that reaches the
  // residual block.
  const out = decompile('g', ASM_RET, ARMV4T_AGBCC, {}).source;
  expect(out).toContain('return 0;');
  expect(out).not.toMatch(/v\d+ = 0;\n\s*return v\d+;/);
});

// ── the postcondition, rather than the pass ──────────────────────────────────────────────────────
// The fix above is one line inside `sinkReturns`, and the next pass to retire an in-edge will
// re-create the same debris three stages from where it surfaces. `raiseRecovered` states it as a
// BOUNDARY rule instead: above that line passes move the CFG, below it the structurer reads a block
// parameter as a JOIN. `verify()` cannot carry the rule — it also runs between the pre-recovery
// passes, which are allowed to leave trivial phis for each other's cleanup.

test('`firstTrivialPhi` is the pass’s own predicate, asked without mutating', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('g', ASM_RET, ARMV4T_AGBCC, {});
  applyIdiomPatterns(fn, ARMV4T_AGBCC);
  raiseRecovered(fn, ARMV4T_AGBCC, {});
  expect(firstTrivialPhi(fn)).toBeNull();
  // …and it agrees with the pass on the same function: neither finds anything to do.
  expect(simplifyTrivialPhis(fn)).toBe(0);
});

test('a stranded alias put BACK is caught at the boundary, not three stages later', () => {
  // Re-create retsink's debris by hand — a second parameter every in-edge feeds the same value —
  // in the `afterRetsink` hook — after every pass that has a cleanup of its own has run, which is
  // where a NEW CFG-motion pass's debris would sit. Injected earlier it is simply cleaned up, which
  // is itself the point: the check fires only on debris nothing collects.
  const fn = frontendFor(ARMV4T_AGBCC).lift('g', ASM_RET, ARMV4T_AGBCC, {});
  applyIdiomPatterns(fn, ARMV4T_AGBCC);
  const strand = () => {
    const edgesOf = (b: (typeof fn.blocks)[number]) =>
      fn.blocks.flatMap((p) => p.ops.flatMap((o) => o.successors)).filter((s) => s.block === b);
    const join = fn.blocks.find((b) => b !== fn.blocks[0] && edgesOf(b).length > 0)!;
    const alias: Value = { type: fn.blocks[0].params[0].type };
    join.params.push(alias);
    for (const e of edgesOf(join)) {
      e.args.push(fn.blocks[0].params[0]);
    }
  };
  expect(() => raiseRecovered(fn, ARMV4T_AGBCC, { afterRetsink: strand })).toThrow(/raising left a trivial phi/);
});
