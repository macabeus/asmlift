// raise/retsink.ts — return-sinking, its GATE, and the SSA debris it leaves.
//
// Sinking rewrites `br ^merge(v)` into `ret v` in every unconditional predecessor. A merge also
// reached by a `cond_br` keeps that one edge — a conditional branch cannot carry a `ret` — so the
// block survives with a single predecessor, and a block parameter with one in-edge is no longer a
// join.
//
// THE GATE reads the shape it is for: a short-circuit chain's arms converge on a SHARED early
// exit reached from ≥2 CONDITIONS. `CHAIN` below is that shape with a store between the two
// conditions, so raise/shortcircuit.ts cannot fuse them and the unfused arm of the gate is the one
// that answers. `SWITCH_ASM`/`SWITCH_RET` are the shape that is NOT it, and the reason the gate
// counts conditions rather than predecessors: agbcc's fall-through switch gives case 1's body two
// predecessors — the dispatch's `beq`, and case 2's body running on — which is a fall-IN, not a
// chain. Sinking there tail-duplicated a switch's shared return into all five of its paths.
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import type { Value } from '../src/ir/core';
import { firstTrivialPhi, simplifyTrivialPhis } from '../src/ir/simplify';
import { applyIdiomPatterns, decompile, raiseRecovered } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

/** A two-condition chain converging on a shared `return 0` arm, with a store between the
 *  conditions so the two are not fused into one `logic_and`. `.Lend` also keeps a `cond_br`
 *  in-edge, which is what leaves a residual block behind when the two `br` edges are sunk. */
const CHAIN =
  'f:\n' +
  '\tcmp\tr0, #0x0\n\tble\t.Lbad\t@cond_branch\n' +
  '\tstr\tr0, [r2]\n' +
  '\tcmp\tr1, #0x0\n\tble\t.Lbad\t@cond_branch\n' +
  '\tmov\tr0, #0x1\n' +
  '\tcmp\tr3, #0x5\n\tbeq\t.Lend\t@cond_branch\n' +
  '\tmov\tr0, #0x2\n\tb\t.Lend\n' +
  '.Lbad:\n\tmov\tr0, #0x0\n\tb\t.Lend\n' +
  '.Lend:\n\tbx\tlr\n';

/** agbcc's own output for a fall-through switch — `synthetic:sw_fallmem`'s shape. `.L3` is a
 *  return-only merge reached by a `b .L3`, by falling out of `.L6`, and by a `bne .L3`. */
const SWITCH_ASM =
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
  const fn = frontendFor(ARMV4T_AGBCC).lift('f', CHAIN, ARMV4T_AGBCC, {});
  applyIdiomPatterns(fn, ARMV4T_AGBCC);
  raiseRecovered(fn, ARMV4T_AGBCC, {});
  // The residual `.Lend` keeps its `cond_br` in-edge and nothing else, so its parameter is an alias
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

/** The same dispatch, returning the accumulator instead of storing it — `synthetic:sw_fall`'s own
 *  target, where the shared `.L3` is what the source's single `return r;` compiled to. */
const SWITCH_RET =
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
  const out = decompile('f', CHAIN, ARMV4T_AGBCC, {}).source;
  expect(out).toContain('return 0;');
  expect(out).not.toMatch(/v\d+ = 0;\n\s*return v\d+;/);
});

// ── the GATE: ≥2 CONDITIONS, not ≥2 predecessors ─────────────────────────────────────────────────

test('a chain of two conditions converging on one early exit is still sunk', () => {
  // The shape the gate exists for, unfused (the store between the conditions blocks
  // raise/shortcircuit.ts), so it is the CFG arm of the gate that answers here. Without it the
  // three arms share one merge variable and one `return v0;`, which is what regressed the rows
  // `retsink` was written for.
  const out = decompile('f', CHAIN, ARMV4T_AGBCC, {}).source;
  expect(out).toContain('return 0;');
  expect(out).toContain('return 1;');
  expect(out).toContain('return 2;');
  expect(out).not.toMatch(/return v\d+;/); // no merge variable
});

test('the same shape with a VOID exit keeps its one exit too', () => {
  // `synthetic:sw_fallmem:agbcc`, which MATCHES today only because sinking duplicated its
  // `bx lr` away and so removed the second default candidate. Keeping the merge is what the
  // preceding commit's resolve-through pays for.
  const out = decompile('f', SWITCH_ASM, ARMV4T_AGBCC, PROTO).source;
  expect(out).toContain('switch (a0)');
  expect(out.match(/return;/g)).toHaveLength(1);
});

test('a fall-through case arm is a fall-IN, not a chain, and its shared return survives', () => {
  // `.L6` (case 1's body) has two predecessors — the dispatch's `beq .L6` and `.L5` running on —
  // which counting PREDECESSORS reads as the shared early exit of a chain. It is not: only ONE of
  // the two is a condition. Sinking here duplicated the switch's single `return r;` into five
  // paths, which agbcc then constant-folds per arm, and the row could not match at any spelling.
  const out = decompile('g', SWITCH_RET, ARMV4T_AGBCC, {}).source;
  expect(out).toContain('switch (a0)');
  expect(out.match(/return /g)).toHaveLength(1); // ONE return, shared by every path
  expect(out).not.toContain('return 0;'); // …not the sunk default arm
});

/** agbcc's own output for `if (a > 0) { p[0] = 1; return 0; } if (b > 0) { p[1] = 2; return 0; }
 *  return 5;` — TWO ARMS that each compute and then jump to a shared `mov r0, #0`. Both
 *  predecessors of `.L6` have a body, and one of them (`.L4`) even falls straight through into it,
 *  so a gate that subtracts "a predecessor that computed something and ran on" sees no chain here
 *  at all. It is the chain: the two arms are the two conditions' early exits, and `.L6` is the
 *  shared one. Five real-tier sites have this shape. */
const TWO_ARMS =
  'm1:\n' +
  '\tcmp\tr0, #0\n\tble\t.L3\t@cond_branch\n' +
  '\tmov\tr0, #0x1\n\tstr\tr0, [r2]\n\tb\t.L6\n' +
  '.L3:\n\tcmp\tr1, #0\n\tbgt\t.L4\t@cond_branch\n\tmov\tr0, #0x5\n\tb\t.L5\n' +
  '.L4:\n\tmov\tr0, #0x2\n\tstr\tr0, [r2, #0x4]\n' +
  '.L6:\n\tmov\tr0, #0x0\n' +
  '.L5:\n\tbx\tlr\n';

test('two arms that each COMPUTE and converge on a shared exit are still a chain', () => {
  // The discriminator is what a predecessor IS, not what it computed. Reading "computed something
  // and ran on" as the fall-in signal refuses this — and it is the pass's own reason to exist, so
  // that reading halved its reach (measured: 14 firings → 8 over the real corpus, taking
  // `kleod:EntityItemDrop:agbcc`'s recovered `switch` with it).
  const out = decompile('m1', TWO_ARMS, ARMV4T_AGBCC, {}).source;
  expect(out.match(/return 0;/g)).toHaveLength(2); // sunk into BOTH arms
  expect(out).toContain('return 5;');
  expect(out).not.toMatch(/return v\d+;/); // no merge variable
});

/** `SWITCH_RET` with case 2's body EMPTY — the arm is one op, the jump onwards, and it still binds
 *  the accumulator as a block parameter. A fall-in is not "a predecessor holding more than a
 *  jump": the arm below reads the value this one was handed either way. */
const SWITCH_EMPTY_ARM =
  'g:\n' +
  '\tmov\tr1, #0x0\n' +
  '\tcmp\tr0, #0x2\n\tbeq\t.L5\t@cond_branch\n' +
  '\tcmp\tr0, #0x2\n\tbgt\t.L9\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.L6\t@cond_branch\n' +
  '\tb\t.L3\n' +
  '.L9:\n\tcmp\tr0, #0x3\n\tbne\t.L3\t@cond_branch\n\tmov\tr1, #0x1\n' +
  '.L5:\n\tb\t.L6\n' +
  '.L6:\n\tadd\tr1, r1, #0x1\n' +
  '.L3:\n\tadd\tr0, r1, #0x0\n\tbx\tlr\n';

test('an EMPTY fall-through arm is still an arm, and the shared return still survives', () => {
  // `.L5` binds the accumulator and hands it on; only its BODY is empty. Counting a one-op
  // predecessor as an arrival duplicates the shared `return r;` again — the same defect, on the
  // shape a proxy for "computes nothing" cannot see (`ir/core.ts isBodyless` is the parameter-aware
  // spelling that can).
  const out = decompile('g', SWITCH_EMPTY_ARM, ARMV4T_AGBCC, {}).source;
  expect(out).toContain('switch (a0)');
  expect(out.match(/return /g)).toHaveLength(1);
});

// ── the postcondition, rather than the pass ──────────────────────────────────────────────────────
// The fix above is one line inside `sinkReturns`, and the next pass to retire an in-edge will
// re-create the same debris three stages from where it surfaces. `raiseRecovered` states it as a
// BOUNDARY rule instead: above that line passes move the CFG, below it the structurer reads a block
// parameter as a JOIN. `verify()` cannot carry the rule: a trivial phi is well-formed IR, and SSA
// construction and the `addrnum` pass both mint one and clear it inside their own scope.

test('`firstTrivialPhi` is the pass’s own predicate, asked without mutating', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('f', CHAIN, ARMV4T_AGBCC, {});
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
  const fn = frontendFor(ARMV4T_AGBCC).lift('f', CHAIN, ARMV4T_AGBCC, {});
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
