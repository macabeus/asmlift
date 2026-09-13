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
// counts ARRIVALS rather than predecessors: agbcc's fall-through switch gives case 1's body two
// predecessors — the dispatch's `beq`, and case 2's body running on — which is a fall-IN, not a
// chain. Sinking there tail-duplicates a switch's shared return into all five of its paths.
//
// The third admission is the ONE-SET-ARM diamond. `CONST_SELECT` and `COMPUTED_SELECT` are both
// inside it — constant arms and one-op computed arms alike are one speculatable SET — and the
// fixtures that sit OUTSIDE it are the bodied, empty, three-armed and third-in-edge ones below.
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import type { Value } from '../src/ir/core';
import { firstTrivialPhi, simplifyTrivialPhis } from '../src/ir/simplify';
import { type Gate, without } from '../src/l3/gates';
import { applyIdiomPatterns, decompile, raiseRecovered } from '../src/pipeline';
import { mergeShapes } from '../src/raise/narrowlocal';
import { FALL_IN_GATES, type FallInCandidate, SELECT_GATES, sinkReturns } from '../src/raise/retsink';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC } from '../src/target';

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
  // raise/shortcircuit.ts), so it is the CFG arm of the gate that answers here. Refuse it and the
  // three arms share one merge variable and one `return v0;` — the spelling the compiler does not
  // re-emit, and the reason this pass exists.
  const out = decompile('f', CHAIN, ARMV4T_AGBCC, {}).source;
  expect(out).toContain('return 0;');
  expect(out).toContain('return 1;');
  expect(out).toContain('return 2;');
  expect(out).not.toMatch(/return v\d+;/); // no merge variable
});

test('the same shape with a VOID exit keeps its one exit too', () => {
  // `synthetic:sw_fallmem:agbcc`. Keeping this merge leaves the switch two default candidates —
  // the bare `b .L3` leaf and `.L3` itself — which is what `resolveDefault` (switch-recover.ts)
  // joins back into one.
  const out = decompile('f', SWITCH_ASM, ARMV4T_AGBCC, PROTO).source;
  expect(out).toContain('switch (a0)');
  expect(out.match(/return;/g)).toHaveLength(1);
});

test('a fall-through case arm is a fall-IN, not a chain, and its shared return survives', () => {
  // `.L6` (case 1's body) has two predecessors — the dispatch's `beq .L6` and `.L5` running on —
  // which counting PREDECESSORS reads as the shared early exit of a chain. It is not: only ONE of
  // the two is a condition. Sinking here duplicates the switch's single `return r;` into five
  // paths, which agbcc then constant-folds per arm, and no spelling of the row can match.
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
 *  shared one. Five real-tier sites have this shape, `kleod:EntityItemDrop:agbcc` among them. */
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
  // and ran on" as the fall-in signal refuses this — the pass's own reason to exist — and halves
  // its reach over the real corpus.
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

// ── the gate is about a DISPATCH, so it says nothing where there is none ─────────────────────────

/** agbcc's own output for `if (a) { if (b) { c += 2; } return c; } return 0;` — an `if` with NO
 *  `else`, and not a switch in sight. `.L4` is the inner join: it and the `add r2, r2, #2` block
 *  above it are THE TWO SUCCESSORS OF ONE `cond_br`, and the block above falls into it. Reading
 *  "both are the target of SOME conditional branch" as the fall-in signal subtracts that arrival,
 *  drops `.L4` to one, and refuses to sink — where sinking is what byte-matches. That reading
 *  loses matches across generated switch-free shapes, on a predicate firing where no dispatch
 *  exists at all. */
const IF_NO_ELSE =
  'g0:\n' +
  '\tcmp\tr0, #0\n\tbeq\t.L3\t@cond_branch\n' +
  '\tcmp\tr1, #0\n\tbeq\t.L4\t@cond_branch\n' +
  '\tadd\tr2, r2, #0x2\n' +
  '.L4:\n\tadd\tr0, r2, #0\n\tb\t.L5\n' +
  '.L3:\n\tmov\tr0, #0x0\n' +
  '.L5:\n\tbx\tlr\n';

test('the join of an `if` with no `else` is a decision arriving, not an arm running on', () => {
  // Two successors of ONE test are never siblings of a dispatch: a fall-in needs two DIFFERENT
  // tests on one scrutinee. Nothing is subtracted here, so the merge sinks exactly as it did
  // before any of the switch work — the early returns, not a merge variable.
  const out = decompile('g0', IF_NO_ELSE, ARMV4T_AGBCC, {}).source;
  expect(out).toContain('return 0;');
  expect(out).not.toMatch(/return v\d+;/);
});

/** agbcc's own output for `int r = y; if (y > 0) goto L; switch (x) { case 3: r = 1; case 2: r++;
 *  case 1: r++; } L: return r;` — `sw_fall`'s dispatch, one `goto` away. `.L4` is the shared
 *  return, and the GUARD reaches it too, by a `bgt` that tests `y` and not the scrutinee. The
 *  local pred shape is indistinguishable from `SWITCH_RET`'s (`.L8` has two preds, one of them
 *  `.L7` running on), and the right answer is the opposite one: refusing to sink leaves the merge
 *  standing, Regime-A recovery declines on it, and if-recovery duplicates the tails anyway. */
const GUARDED_SWITCH =
  'w9:\n' +
  '\tadd\tr2, r0, #0\n\tadd\tr0, r1, #0\n' +
  '\tcmp\tr0, #0\n\tbgt\t.L4\t@cond_branch\n' +
  '\tcmp\tr2, #0x2\n\tbeq\t.L7\t@cond_branch\n' +
  '\tcmp\tr2, #0x2\n\tbgt\t.L11\t@cond_branch\n' +
  '\tcmp\tr2, #0x1\n\tbeq\t.L8\t@cond_branch\n' +
  '\tb\t.L4\n' +
  '.L11:\n\tcmp\tr2, #0x3\n\tbne\t.L4\t@cond_branch\n\tmov\tr0, #0x1\n' +
  '.L7:\n\tadd\tr0, r0, #0x1\n' +
  '.L8:\n\tadd\tr0, r0, #0x1\n' +
  '.L4:\n\tbx\tlr\n';

test('a merge the dispatch SHARES with an outside guard is sunk, not kept', () => {
  // `ownedBy`: the guard's `bgt` is a predecessor of the merge that belongs to no test on the
  // scrutinee, so this dispatch does not own its return and nothing is subtracted.
  // `synthetic:sw_fallguard` is the corpus row — MATCH, and diff:6 with the clause dropped.
  const out = decompile('w9', GUARDED_SWITCH, ARMV4T_AGBCC, { prototypes: { w9: { params: 3 } } }).source;
  expect(out).toContain('switch (a0)');
  expect(out.match(/return /g)!.length).toBeGreaterThan(1); // the tails ARE sunk
});

test('ablating the dispatch gate reads an `if` join, and a guarded switch, as fall-ins', () => {
  // Dropping `one-dispatch-owning-the-merge` leaves "both are the target of SOME conditional
  // branch" — the reading that fires where no dispatch exists. Both fixtures stop sinking, which
  // is the wrong answer for both.
  const sinks = (sym: string, asm: string, gates?: readonly Gate<FallInCandidate>[]) => {
    const fn = frontendFor(ARMV4T_AGBCC).lift(sym, asm, ARMV4T_AGBCC, {});
    applyIdiomPatterns(fn, ARMV4T_AGBCC);
    return sinkReturns(fn, { hoistsSingleSetArm: true, mergeShapes: mergeShapes(fn) }, gates ?? FALL_IN_GATES);
  };
  for (const [sym, asm] of [
    ['g0', IF_NO_ELSE],
    ['w9', GUARDED_SWITCH],
  ] as const) {
    expect(sinks(sym, asm)).toBe(true);
    expect(sinks(sym, asm, without(FALL_IN_GATES, 'one-dispatch-owning-the-merge'))).toBe(false);
  }
});

// ── the third admission arm: a CONSTANT-ARM diamond ──────────────────────────────────────────────

/** `kleod:IsSelectButtonPressed`'s shape, with the global load that feeds the compare elided: one
 *  condition, two arms, each a single `mov` of a constant, converging on a bare `bx lr`. */
const CONST_SELECT =
  'sel:\n' +
  '\tcmp\tr0, #0x0\n\tbne\t.L3\t@cond_branch\n' +
  '\tmov\tr0, #0x0\n\tb\t.L4\n' +
  '.L3:\n\tmov\tr0, #0x1\n' +
  '.L4:\n\tbx\tlr\n';

/** The same diamond with ONE-OP COMPUTED arms — agbcc's `if (a > b) return a + b; return b - a;`.
 *  One `add` / one `sub` is ONE speculatable SET, so `armIsOneSet` admits it and this IS sunk — the
 *  committed `selcomp` pair (select-spelling.test.ts) is the evidence: agbcc hoists the `sub` above
 *  the compare in the merge spelling, so a target holding the diamond was written with early
 *  returns. It is the fixture for the half of the predicate a "both arms are constants" reading
 *  would miss. */
const COMPUTED_SELECT =
  'sel2:\n' +
  '\tcmp\tr0, r1\n\tble\t.L2\t@cond_branch\n' +
  '\tadd\tr0, r0, r1\n\tb\t.L3\n' +
  '.L2:\n\tsub\tr0, r1, r0\n' +
  '.L3:\n\tbx\tlr\n';

test('a single-condition diamond whose arms are CONSTANTS is sunk', () => {
  const out = decompile('sel', CONST_SELECT, ARMV4T_AGBCC, { prototypes: { sel: { params: 1 } } }).source;
  expect(out).toContain('return 0;');
  expect(out).toContain('return 1;');
  expect(out).not.toMatch(/return v\d+;/);
});

test('the one-set-arm admission is silent on a compiler the hoist was never measured on', () => {
  // `compilerBehaviors.hoistsSingleSetArm` is the fact's home (target.ts) — the SAME field
  // `raise/narrowlocal.ts` reads, because it is the same `gcc/jump.c` guard. Absent — every target
  // but agbcc — and the admission never fires, whatever the shape. The rest of the pass is
  // compiler-independent and keeps working; only this one arm is conditioned.
  const lift = () => {
    const fn = frontendFor(ARMV4T_AGBCC).lift('sel', CONST_SELECT, ARMV4T_AGBCC, { sel: { params: 1 } });
    applyIdiomPatterns(fn, ARMV4T_AGBCC);
    return fn;
  };
  const shapes = (fn: Parameters<typeof sinkReturns>[0]) => ({ mergeShapes: mergeShapes(fn) });
  const f1 = lift();
  expect(sinkReturns(f1, { hoistsSingleSetArm: true, ...shapes(f1) })).toBe(true);
  const f2 = lift();
  expect(sinkReturns(f2, shapes(f2))).toBe(false);
  expect(sinkReturns(lift())).toBe(false);
  // …and ablating the clause is what puts it back, which is what makes the clause the reason.
  const f3 = lift();
  expect(sinkReturns(f3, shapes(f3), FALL_IN_GATES, without(SELECT_GATES, 'compiler-hoists-single-set-arm'))).toBe(
    true,
  );
});

test('`pre-diamond`: a diamond absent from the pre-recovery map is refused', () => {
  // THE TOWER'S OBLIGATION FOR A BACKWARDS DEFAULT, pinned. `raise/shortcircuit.ts` manufactures
  // two-armed diamonds out of condition trees the ROM never merged, and it runs BEFORE this pass, so
  // the shape is read from `PreRecoveryFacts.mergeShapes` — the CFG as it ENTERED pre-recovery —
  // rather than off `fn` at this pass's turn.
  //
  // THE CORPUS SUPPLIES NO INHABITANT, so the divergence is built by hand, and the header says so:
  // today a fused manufacture takes the short-circuit path (`fusedDiamond` is tested first in the
  // same disjunction) and never reaches this table at all. What the clause buys is that the refusal
  // is STATED rather than a coincidence of evaluation order — this file's own history is that
  // hazard having fired once already.
  const lift = () => {
    const fn = frontendFor(ARMV4T_AGBCC).lift('sel', CONST_SELECT, ARMV4T_AGBCC, { sel: { params: 1 } });
    applyIdiomPatterns(fn, ARMV4T_AGBCC);
    return fn;
  };
  // The merge, as the map sees it: the block that is a diamond and is not the entry.
  const live = lift();
  const real = mergeShapes(live);
  expect([...real.values()].filter((v) => v.diamond).length, 'the fixture has exactly one diamond').toBe(1);
  expect(sinkReturns(live, { hoistsSingleSetArm: true, mergeShapes: real })).toBe(true);

  // The SAME live CFG, with the map saying that merge was not a diamond before pre-recovery.
  const manufactured = lift();
  const stale = new Map([...mergeShapes(manufactured)].map(([b]) => [b, { diamond: false, hoistable: false }]));
  expect(sinkReturns(manufactured, { hoistsSingleSetArm: true, mergeShapes: stale })).toBe(false);
  const abl = lift();
  expect(
    sinkReturns(
      abl,
      {
        hoistsSingleSetArm: true,
        mergeShapes: new Map([...mergeShapes(abl)].map(([b]) => [b, { diamond: false, hoistable: false }])),
      },
      FALL_IN_GATES,
      without(SELECT_GATES, 'pre-diamond'),
    ),
    '`pre-diamond` is what refused it',
  ).toBe(true);

  // NO MAP AT ALL is the refusing direction too — a caller that does not thread the facts gets no
  // one-set-arm admission, rather than one judged on a shape nothing vouched for.
  expect(sinkReturns(lift(), { hoistsSingleSetArm: true })).toBe(false);
});

test('a diamond whose arms are ONE COMPUTED SET is sunk too — `selcomp`, not just a constant', () => {
  const out = decompile('sel2', COMPUTED_SELECT, ARMV4T_AGBCC, { prototypes: { sel2: { params: 2 } } }).source;
  expect(out).toContain('return a0 + a1;');
  expect(out).toContain('return a1 - a0;');
  expect(out).not.toMatch(/return v\d+;/);
});

/** A void diamond: the two arms store a constant and converge on a bare `bx lr`. There is no merge
 *  VARIABLE here, so the hoist the constant-arm admission rests on has nothing to say. */
const VOID_SELECT =
  'sel3:\n' +
  '\tcmp\tr0, #0x0\n\tbne\t.L3\t@cond_branch\n' +
  '\tmov\tr2, #0x0\n\tstr\tr2, [r1]\n\tb\t.L4\n' +
  '.L3:\n\tmov\tr2, #0x1\n\tstr\tr2, [r1]\n' +
  '.L4:\n\tbx\tlr\n';

/** `CONST_SELECT` with a guard branching onto the same `bx lr`. The two arms still carry constants;
 *  the guard carries whatever `r0` held, which is not one. */
const GUARDED_CONST_SELECT =
  'sel4:\n' +
  '\tcmp\tr1, #0x0\n\tbeq\t.L4\t@cond_branch\n' +
  '\tcmp\tr0, #0x0\n\tbne\t.L3\t@cond_branch\n' +
  '\tmov\tr0, #0x0\n\tb\t.L4\n' +
  '.L3:\n\tmov\tr0, #0x1\n' +
  '.L4:\n\tbx\tlr\n';

/** `synthetic:sign`'s own shape — THREE constant arms off two tests, so no one `cond_br` chooses
 *  the pair. Whether agbcc re-emits a ladder this long from a merge variable is a question the
 *  two-armed evidence does not answer, and the gate refuses rather than guess. On real agbcc output
 *  `sign` reaches the table with THREE branch preds and is refused twice over — `two-arms-one-head`
 *  first, `arms-are-one-set` once that is ablated — so neither ablation moves it on its own. */
const THREE_ARM =
  'sel5:\n' +
  '\tcmp\tr0, #0x0\n\tble\t.L2\t@cond_branch\n\tmov\tr0, #0x1\n\tb\t.L5\n' +
  '.L2:\n\tcmp\tr0, #0x0\n\tblt\t.L4\t@cond_branch\n\tmov\tr0, #0x0\n\tb\t.L5\n' +
  '.L4:\n\tmov\tr0, #0x2\n\tb\t.L5\n' +
  '.L5:\n\tbx\tlr\n';

/** A diamond whose arms are EMPTY — the computation is hoisted into the head, so each arm does
 *  nothing but carry a value. `gcc/jump.c:480` runs `single_set` on the arm's OWN insn and an arm
 *  whose only insn is its jump has none, so `armIsOneSet` refuses it: the budget is EXACTLY one
 *  result-producing op, not at most one. It is the only one of the three shapes named in the pass
 *  header as narrower-than-the-optimizer that a fixture can reach; the other two need a compiler. No
 *  corpus row inhabits any of them, and all three are in the refusing direction. */
const EMPTY_ARM_SELECT =
  'sel7:\n' +
  '\tadd\tr2, r0, r1\n\tsub\tr3, r1, r0\n' +
  '\tcmp\tr0, r1\n\tble\t.L2\t@cond_branch\n' +
  '\tmov\tr0, r2\n\tb\t.L3\n' +
  '.L2:\n\tmov\tr0, r3\n' +
  '.L3:\n\tbx\tlr\n';

/** `CONST_SELECT` with a BODY in each arm — one store apiece. Two result-producing ops in each arm,
 *  so `armIsOneSet` refuses: a body pins the constant below the compare and the merge-variable
 *  spelling then emits the diamond too, differing only in ARM ORDER (`selbody`,
 *  select-spelling.test.ts). Five compiled shapes of this kind lose a byte-exact match when the
 *  clause is dropped (`packages/cli/test/matching/shortcircuit-retsink.test.ts`). */
const BODIED_SELECT =
  'sel6:\n' +
  '\tcmp\tr0, #0x0\n\tbne\t.L3\t@cond_branch\n' +
  '\tmov\tr2, #0x2\n\tstr\tr2, [r1]\n\tmov\tr0, #0x0\n\tb\t.L4\n' +
  '.L3:\n\tmov\tr2, #0x1\n\tstr\tr2, [r1]\n\tmov\tr0, #0x1\n' +
  '.L4:\n\tbx\tlr\n';

test('a one-set-arm diamond whose arms have a BODY keeps its merge variable', () => {
  const out = decompile('sel6', BODIED_SELECT, ARMV4T_AGBCC, { prototypes: { sel6: { params: 2 } } }).source;
  expect(out).toMatch(/return v\d+;/);
});

test('every one-set-arm clause refuses a shape the two-armed evidence does not cover', () => {
  const voidProto = { sel3: { returnsVoid: true, params: 2 } };
  const sinks = (sym: string, asm: string, sel = SELECT_GATES) => {
    const fn = frontendFor(ARMV4T_AGBCC).lift(
      sym,
      asm,
      ARMV4T_AGBCC,
      sym === 'sel3'
        ? voidProto
        : sym === 'sel6'
          ? { sel6: { params: 2 } }
          : sym === 'sel7'
            ? { sel7: { params: 2 } }
            : {},
    );
    applyIdiomPatterns(fn, ARMV4T_AGBCC);
    return sinkReturns(fn, { hoistsSingleSetArm: true, mergeShapes: mergeShapes(fn) }, FALL_IN_GATES, sel);
  };
  // ONE CLAUSE, ONE FIXTURE, where a fixture really does have one — a bodied arm is a diamond the
  // ROM held, arrived at by two edges, carrying a value, and the ONLY thing wrong with it is the
  // body.
  expect(sinks('sel6', BODIED_SELECT), 'a bodied arm is refused').toBe(false);
  expect(sinks('sel6', BODIED_SELECT, without(SELECT_GATES, 'arms-are-one-set'))).toBe(true);

  // THE TWO SHAPE CLAUSES REFUSE THE SAME SHAPES, and neither ablation alone moves either fixture —
  // the same subsumption the corpus shows, where `pre-diamond` and `no-arrival-but-the-arms`
  // first-refuse the SAME two agbcc sites and only the table order decides which the census bills.
  // `mergeArms` asks for EXACTLY two predecessors and a shared `cond_br` head; `two-arms-one-head`
  // asks the second question of the `br` preds only, and `no-arrival-but-the-arms` the first. A
  // third in-edge (`sel4`) and a three-armed ladder (`sel5`) each fail more than one of them.
  // Asserting a single clause here would pin a number the next reorder silently invalidates.
  for (const [sym, asm, ids] of [
    ['sel4', GUARDED_CONST_SELECT, ['no-arrival-but-the-arms', 'pre-diamond']],
    ['sel5', THREE_ARM, ['two-arms-one-head', 'pre-diamond']],
  ] as const) {
    expect(sinks(sym, asm), `${sym} is refused`).toBe(false);
    for (const id of ids) {
      expect(sinks(sym, asm, without(SELECT_GATES, id)), `${id} alone does not sink ${sym}`).toBe(false);
    }
    expect(
      sinks(sym, asm, without(without(SELECT_GATES, ids[0]), ids[1])),
      `${ids[0]} and ${ids[1]} together are what refuse ${sym}`,
    ).toBe(true);
  }
  // THE EMPTY ARM is refused by `arms-are-one-set` too — the budget is EXACTLY one result-producing
  // op, and an arm holding nothing has none. Ablating the clause is what sinks it, which is what
  // makes the clause the reason.
  expect(sinks('sel7', EMPTY_ARM_SELECT), 'an emptied arm is not one SET either').toBe(false);
  expect(sinks('sel7', EMPTY_ARM_SELECT, without(SELECT_GATES, 'arms-are-one-set'))).toBe(true);
  // `a-value-is-returned` has NO fixture in this tree that reaches it, and this asserts exactly that
  // rather than pretending otherwise. `VOID_SELECT`'s merge is refused one check EARLIER — the Thumb
  // frontend hands even a void function `ret r0`, so its `ret` carries an operand that is not a
  // param of the merge — and the proof is that the EMPTY table refuses it too. An assertion that
  // passes for any table pins nothing; this one says which table it passes for and why. The clause
  // IS reached on the corpus, by two agbcc rows named in the pass header, where `arms-are-one-set`
  // subsumes it a step later.
  expect(sinks('sel3', VOID_SELECT, without(SELECT_GATES, 'a-value-is-returned'))).toBe(false);
  expect(sinks('sel3', VOID_SELECT, []), 'refused before the table, not by it').toBe(false);
});

test("the SELECT_GATES order is pinned, because the header's reach numbers are true of it alone", () => {
  // THE FAILURE THIS EXISTS FOR: the header's per-clause reach numbers live only in comments, and a
  // census attributes each site to the clause that FIRST refuses it — so every one of those numbers
  // is a claim about THIS order and a reorder silently invalidates all of them. Change the list and
  // re-measure the header's table; do not just update this array.
  expect(SELECT_GATES.map((g) => g.id)).toEqual([
    'two-arms-one-head',
    'pre-diamond',
    'no-arrival-but-the-arms',
    'a-value-is-returned',
    'arms-are-one-set',
    'compiler-hoists-single-set-arm',
  ]);
  // LAST is the load-bearing half of the order. `target.ts` says this admission reaches no non-agbcc
  // row; placed first, the clause collects 28 of the 74 corpus sites and a census then reads the
  // opposite of that sentence — while moving 0 rows either way.
  expect(SELECT_GATES[SELECT_GATES.length - 1].id).toBe('compiler-hoists-single-set-arm');
  // Every clause here trades BYTES, never correctness — see the pass header's FAILURE DIRECTION.
  expect(SELECT_GATES.every((g) => g.sound === false)).toBe(true);
});

test('the hoist is ONE compilerBehaviors field, declared on agbcc alone', () => {
  // ONE GUARD, ONE FIELD, TWO READERS. A second boolean for the same `gcc/jump.c` guard is a drift
  // trap: a round measuring another compiler's `jump_optimize` would set one and leave the other
  // false. `hoistsConstArmSelect` is the name that would be reached for, so it is named here.
  expect(ARMV4T_AGBCC.compilerBehaviors.hoistsSingleSetArm).toBe(true);
  expect('hoistsConstArmSelect' in ARMV4T_AGBCC.compilerBehaviors).toBe(false);
  for (const t of [MIPS_IDO, MIPS_GCC, PPC_MWCC]) {
    expect(t.compilerBehaviors.hoistsSingleSetArm, `${t.id} has not measured the pair`).toBeUndefined();
  }
});
