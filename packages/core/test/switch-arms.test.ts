// Regime-A switch recovery — what decides whether a four-way agbcc dispatch comes back as ONE
// `switch`. The fact underneath is gcc 2.9-arm's own `stmt.c`: `expand_end_case` builds the
// dispatch with `balance_case_nodes`/`emit_case_nodes` (a comparison TREE, not a jump table, for
// a dense 0..3 switch) and gives every subtree that runs out of case values its OWN jump to the
// default — so a four-case tree reaches the default through two `b .Ldefault` blocks.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { emitCFamily } from '../src/backend/cfamily';
import { pascalBackend } from '../src/backend/pascal';
import { frontendFor } from '../src/frontend/registry';
import { mkOp } from '../src/ir/core';
import type { Block } from '../src/ir/core';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { stmtChildren } from '../src/l3/ast';
import type { SFn, Stmt } from '../src/l3/ast';
import { applyIdiomPatterns, decompile, raiseRecovered } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { structure } from '../src/structure/structure';
import type { StructureOptions } from '../src/structure/structure';
import { makeSwitchRecovery } from '../src/structure/switch-recover';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, structureOptionsFor } from '../src/target';

// agbcc's own output for `switch (mode) { case 0..3 }` with the arms in `order`, reduced to the
// shape that matters: the balanced comparison tree, four one-instruction bodies, a merge that
// takes the result as a block parameter, and — the point — TWO jumps to the fall-out.
// `out` is where a subtree that runs out of case values jumps: `.Lend` (the merge — the source
// wrote no `default:`) or `.Ldef` (a real default arm, emitted by `tail`).
// `order` may contain 'D', the real `default:` arm's body, laid out among the cases exactly as
// agbcc lays it out when the source wrote `default:` there.
const dispatch = (order: readonly (number | 'D')[], out = '.Lend', tail = '') =>
  'f:\n\tmov\tr2, #0x0\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
  '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n' +
  `\tb\t${out}\n` + // fall-out #1
  '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n' +
  '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n' +
  `\tb\t${out}\n` + // fall-out #2 — a SECOND block jumping to the same place
  order
    .map((k) =>
      k === 'D' ? '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' : `.Lc${k}:\n\tadd\tr2, r1, #0x${k + 1}\n\tb\t.Lend\n`,
    )
    .join('') +
  tail +
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';

const ZERO = { k: 'const', value: 0 } as const;
const of = (asm: string) => decompile('f', asm, ARMV4T_AGBCC, { prototypes: { f: { returnsVoid: true } } }).source;
const count = (s: string, needle: string): number => s.split(needle).length - 1;
/** the case labels in the order they are EMITTED */
const armOrder = (out: string) => [...out.matchAll(/case (\d+):/g)].map((m) => Number(m[1]));

test('a defaultless tree reached by TWO `b .Ldefault` blocks is ONE switch', () => {
  // Comparing default candidates by BLOCK counted agbcc's two fall-out jumps as two different
  // defaults and declined the whole tree to if-nesting — the shape of every dense agbcc switch
  // whose source wrote no `default:`.
  const out = of(dispatch([0, 1, 2, 3]));
  expect(out).toContain('switch (a0)');
  expect(armOrder(out)).toEqual([0, 1, 2, 3]);
  expect(out).not.toContain('else'); // not the if-nesting fallback
});

test('a REAL default arm is still recovered as one, and is not confused with the fall-out', () => {
  // Control: the same tree whose source wrote `default: w = 0;`. That arm has a block of its own,
  // so the two fall-out jumps land on IT — one default, spelled once, with a body.
  const out = of(dispatch([0, 1, 2, 3], '.Ldef', '.Ldef:\n\tmov\tr2, #0x9\n'));
  expect(out).toContain('switch (a0)');
  expect(out).toMatch(/default:\s*\n\s*v0 = 9;/);
  expect(armOrder(out)).toEqual([0, 1, 2, 3]);
});

test('two fall-out leaves passing DIFFERENT values are two defaults and still decline', () => {
  // The collapse claims only that a BARE jump has no body to differ in. Give the HIGH leaf a
  // different value for the merge's parameter and the two are genuinely different defaults —
  // recovery must go back to if-nesting rather than pick one and give the other's path its value.
  const out = of(dispatch([0, 1, 2, 3]).replace(/\tb\t\.Lend\n(?=\.Lc0:)/, '\tmov\tr2, #0x9\n\tb\t.Lend\n'));
  expect(out).toContain('else'); // declined to if-recovery
  expect(out).toMatch(/default:\s+v0 = 9;/); // the high leaf's own write…
  expect(out).toMatch(/if \(a0 != 0\) \{\s+v0 = 0;/); // …and the low leaf's, which the collapse would overwrite with 9
});

// Each half of the identity rule alone. Ablating either one leaves the three tests above green
// while collapsing a pair the assembly distinguishes, so each owes its own falsifying shape:
// the collapse emits the REPRESENTATIVE and discards the rest, and “what the rest could have
// carried” is exactly a body and an edge value.
test('two bare fall-out jumps passing DIFFERENT values are two defaults', () => {
  // The ARGS half. Both leaves are bare jumps to the merge — no body between them to tell them
  // apart — but they hand it different values: the low leaf 9 (the copy rides the edge, so the
  // block holds no op of its own), the high leaf the entry's 0. Collapsing them gives `a0 > 3`
  // the 9 the assembly writes only for `a0 < 0`. Comparing the target block alone cannot see it.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n\tmov\tr3, #0x9\n' +
      '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
      '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
      '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n' +
      '\tmov\tr2, r3\n\tb\t.Lend\n' + // fall-out #1 — bare, carrying 9
      '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n' +
      '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n\tb\t.Lend\n' + // fall-out #2 — bare, carrying 0
      [0, 1, 2, 3].map((k) => `.Lc${k}:\n\tadd\tr2, r1, #0x${k + 1}\n\tb\t.Lend\n`).join('') +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(armOrder(out)).not.toEqual([0, 1, 2, 3]); // not folded into one four-case switch
  expect(out).toMatch(/if \(a0 != 0\) \{\s+v0 = 9;/); // 9 stays on the path that writes it
});

test('a fall-out leaf with a BODY is not a bare jump, and its store is not dropped', () => {
  // The BODY half. Both leaves reach the merge with the same value, so the args agree — but the
  // high one stores on the way. A bare jump has nothing to emit and the collapse emits only the
  // representative, so accepting this pair drops the store from the output entirely.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n\tmov\tr3, #0xa0\n\tlsl\tr3, r3, #0x13\n' +
      '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
      '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
      '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n\tb\t.Lend\n' + // fall-out #1 — bare
      '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n' +
      '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n\tstr\tr1, [r3]\n\tb\t.Lend\n' + // #2 — stores first
      [0, 1, 2, 3].map((k) => `.Lc${k}:\n\tadd\tr2, r1, #0x${k + 1}\n\tb\t.Lend\n`).join('') +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(armOrder(out)).not.toEqual([0, 1, 2, 3]);
  expect(out).toContain('*(s32 *)(160 << 19) = a1;'); // the leaf's store survives
});

// ── one default, reached through a bare jump ─────────────────────────────────────────────────────
// `forwardingTarget` (ir/core.ts) refuses to see through a `br` that carries block ARGUMENTS,
// because skipping it would drop the values it supplies. So a subtree that runs out of case values
// into `b .Ldefault(v)` and the `.Ldefault` block itself arrive as TWO default candidates whenever
// the default takes a parameter — and `sameBareExit` cannot join them, since one of the two has a
// body. They are one default: the jumping leaf emits nothing of its own, and what its `br` hands
// the other's parameters is what the DISPATCH hands them, so it is one more hoisted edge.

/** `sw_fall`'s own dispatch with the accumulator STORED rather than returned, so no return-sink
 *  rewrites the shape: the low subtree runs out into a bare `b .Lend` carrying the accumulator,
 *  while the high subtree's `bne` branches to `.Lend` directly. `hi` writes the accumulator inside
 *  the high test block, so the two paths hand `.Lend`'s parameter different values. */
const defaultThroughJump = (hi: string) =>
  'f:\n\tmov\tr2, #0x0\n\tmov\tr3, #0x9\n' +
  '\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n' +
  '\tcmp\tr0, #0x2\n\tbgt\t.Lhi\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tb\t.Lend\n' +
  `.Lhi:\n${hi}\tcmp\tr0, #0x3\n\tbne\t.Lend\t@cond_branch\n\tmov\tr2, #0x1\n` +
  '.Lc2:\n\tadd\tr2, r2, #0x1\n' +
  '.Lc1:\n\tadd\tr2, r2, #0x1\n' +
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';

test('a default reached through a bare jump that CARRIES its value is one default', () => {
  const out = defaultThroughJump('');
  expect(of(out)).toContain('switch (a0)');
  expect(armOrder(of(out))).toEqual([3, 2, 1]); // the falling chain, in layout order
  expect(of(out)).not.toContain('default:'); // one default, and it is where the switch ends
  expect(of(out)).toMatch(/v2 = 0;\s*\n\s*switch \(a0\)/); // the jump's value, hoisted above
});

test('…and two paths into it carrying DIFFERENT values still decline', () => {
  // The refusal that keeps the resolution honest, and it is the hoist's own: `.Lhi` writes the
  // accumulator, so the two dispatch paths bind `.Lend`'s parameter to 9 and to 0, and no single
  // statement above the tree says both.
  const out = of(defaultThroughJump('\tmov\tr2, r3\n'));
  expect(out).not.toContain('switch (');
  expect(out).toContain('v2 = 9;'); // 9 stays on the path that writes it
});

// ── arm ORDER ────────────────────────────────────────────────────────────────────────────────────
// The dispatch tree above the bodies is the same whatever order the arms were written in, so the
// only evidence of that order is where agbcc laid the bodies out — and it lays them out as it
// walks the arms (`stmt.c`: `before_case` is taken after the bodies, and the closing
// `reorder_insns` moves only the dispatch to the front; the Makefile compiles neither sched.c nor
// reorg.c). Emitting the arms sorted by case value instead moves every instruction after the first.
test('the arms come back in the ASSEMBLY’s layout order, not sorted by case value', () => {
  expect(armOrder(of(dispatch([2, 0, 3, 1])))).toEqual([2, 0, 3, 1]);
  expect(armOrder(of(dispatch([3, 2, 1, 0])))).toEqual([3, 2, 1, 0]);
  expect(armOrder(of(dispatch([0, 1, 2, 3])))).toEqual([0, 1, 2, 3]);
  // …and the arm KEEPS its own body: this is a reordering, not a relabelling. `case k` adds k+1.
  expect(of(dispatch([2, 0, 3, 1]))).toMatch(/case 2:\s*\n\s*v0 = a1 \+ 3;/);
  expect(of(dispatch([2, 0, 3, 1]))).toMatch(/case 1:\s*\n\s*v0 = a1 \+ 2;/);
});

test('a compiler that has not declared layout-order arms keeps the ascending spelling', () => {
  // The rule is agbcc's, from agbcc's sources. IDO/KMC-GCC/CodeWarrior all have schedulers and
  // none has been put through that evidence, so they take the ascending order until they declare.
  const undeclared = { ...ARMV4T_AGBCC, compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors } };
  delete undeclared.compilerBehaviors.switchArmsFollowLayout;
  const out = decompile('f', dispatch([2, 0, 3, 1]), undeclared, { prototypes: { f: { returnsVoid: true } } }).source;
  expect(armOrder(out)).toEqual([0, 1, 2, 3]);
  for (const t of [MIPS_IDO, MIPS_GCC, PPC_MWCC]) {
    expect(t.compilerBehaviors.switchArmsFollowLayout).toBeUndefined();
  }
});

// ── THE DISPATCH HOIST ───────────────────────────────────────────────────────────────────────────
// Collapsing a comparison tree discards its edges, and an edge's only emission is its parallel
// copy — so an entry the DISPATCH hands values to used to decline the whole recovery, at three
// separate sites (a case entry with a phi, a default entry with parameters, an arm fallen into
// with parameters). All three now read one rule: merge those copies and emit them ONCE above the
// `switch`, which is where the target's own layout puts them. The pair below is the shape and its
// refusal; `hoistedDispatchAssigns` (structure.ts) states what the refusal is.

/** `bne` branches straight to the merge, so the default entry is a block with a PARAMETER and the
 *  edge into it carries `w = 0` — the exact shape the three refusals shared. */
const hoistedDefault =
  'f:\n\tmov\tr2, #0x0\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tcmp\tr0, #0x2\n\tbne\t.Lend\t@cond_branch\n' +
  '.Lc2:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
  '.Lc1:\n\tadd\tr2, r1, #0x1\n' +
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';

test('a default entry the DISPATCH hands a value to is recovered, with the write hoisted above', () => {
  const out = of(hoistedDefault);
  expect(out).toContain('switch (a0)');
  // the write the collapsed edge carried, re-emitted ONCE and ABOVE the switch
  expect(out).toMatch(/v0 = 0;\s*\n\s*switch \(a0\)/);
  expect(count(out, 'v0 = 0;')).toBe(1);
  expect(out).toContain('v0 = a1 + 2;');
  expect(out).toContain('v0 = a1 + 1;');
});

test('two dispatch edges handing one entry DIFFERENT values decline — no hoisted statement says both', () => {
  // The refusal that makes the admission an admission. Both `bne`s land on the merge, whose
  // parameter they bind to 0 on one path and to 9 on the other. Which one runs depends on which
  // test fell through, and one statement above the tree cannot depend on that — so recovery goes
  // back to if-nesting, which spells both.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n\tmov\tr3, #0x9\n' +
      '\tcmp\tr0, #0x2\n\tbgt\t.Lhi\t@cond_branch\n' +
      '\tcmp\tr0, #0x1\n\tbne\t.Lend\t@cond_branch\n' +
      '.Lc1:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
      '.Lhi:\n\tmov\tr2, r3\n\tcmp\tr0, #0x3\n\tbne\t.Lend\t@cond_branch\n' +
      '.Lc3:\n\tadd\tr2, r1, #0x3\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).not.toContain('switch (');
  expect(out).toContain('= 9;'); // both values survive, each on the path that writes it
  expect(out).toContain('= 0;');
});

test('a hoisted argument computed INSIDE the collapsed tree declines — the hoist may not speculate', () => {
  // The availability rule. `.Lt` is a test block the tree would collapse, and it computes the
  // value its own dispatch edge hands the merge. Evaluating that at the ROOT runs it on every path
  // through the dispatch, including the ones the original never took it on — so recovery declines
  // rather than move it. (PRE4 licenses re-rendering a collapsed op AT ITS USE, which is dominated
  // by the def; the hoist's position is not, which is why it asks separately.)
  const out = of(
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
      '.Lt:\n\tlsl\tr2, r1, #0x2\n\tcmp\tr0, #0x2\n\tbne\t.Lend\t@cond_branch\n' +
      '.Lc2:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
      '.Lc1:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).not.toContain('switch (');
  expect(out).toContain('a1 << 2'); // the shift stays on the path that reaches it
});

test('a hoisted write that would CLOBBER a name still live in an arm declines', () => {
  // The third refusal, and the one whose absence is a miscompile rather than a nonmatch. The
  // merge's parameter adopts the name `a1` (case 1's edge hands it exactly that value), and the
  // fall-out edge binds the same parameter to 0 — so the hoist would write `a1 = 0;` above the
  // switch, where `case 2:` still reads the PARAMETER: `a1 + 2` would compute `2`. The naming
  // walk's own interference check cannot see it, because it judged a write ON THE EDGE and the
  // hoist moves that write above the dispatch. Declining gives back the if-nesting, which writes
  // the name only on the path that reaches it.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
      '\tcmp\tr0, #0x2\n\tbne\t.Lend\t@cond_branch\n' +
      '.Lc2:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
      '.Lc1:\n\tmov\tr2, r1\n\tb\t.Lend\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).not.toContain('switch (');
  expect(out).toContain('a1 = a1 + 2;'); // the parameter is still the parameter where it is read
  expect(out).not.toMatch(/a1 = 0;\s*\n\s*switch/);
});

/** `synthetic:sw_fall`'s own agbcc dispatch: a three-deep fall-through chain whose accumulator
 *  crosses every arm, so the hoist merges copies from FOUR different edges under three names. */
const sw_fall =
  'g:\n' +
  '\tmov\tr1, #0x0\n' +
  '\tcmp\tr0, #0x2\n\tbeq\t.L5\t@cond_branch\n' +
  '\tcmp\tr0, #0x2\n\tbgt\t.L9\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.L6\t@cond_branch\n' +
  '\tb\t.L3\n' +
  '.L9:\n\tcmp\tr0, #0x3\n\tbne\t.L3\t@cond_branch\n\tmov\tr1, #0x1\n' +
  '.L5:\n\tadd\tr1, r1, #0x1\n' +
  '.L6:\n\tadd\tr1, r1, #0x1\n' +
  '.L3:\n\tadd\tr0, r1, #0x0\n\tbx\tlr\n';

test('copies merged from SEVERAL edges are emitted in one fixed order', () => {
  // ORDER ACROSS EDGES IS UNLICENSED — no compiler measured a write order spanning writes that
  // different predecessors performed, so the union keeps tree-walk order. This pins the order the
  // walk produces on the round's own row, where three names arrive from four edges: a change to
  // the walk that re-spells it must fail here rather than move a match silently.
  const out = decompile('g', sw_fall, ARMV4T_AGBCC, {}).source;
  expect(out).toMatch(/v0 = 0;\s*\n\s*v1 = 0;\s*\n\s*v2 = 0;\s*\n\s*switch \(a0\)/);
});

test('a param-carrying dispatch INSIDE a loop hoists to the head of the switch, not out of it', () => {
  // `anchorConstCopies` declines every in-loop shape, because it moves a write to the const's DEF
  // site, which may sit outside the loop. This mechanism moves a write from a dispatch's edges to
  // the head of that same dispatch — inside the same loop body, on the same iteration — so the
  // clause does not transfer, and the absence of a loop test is a claim rather than an oversight.
  // The accumulator is loop-carried (`case 1:` reads the PREVIOUS iteration's value), which is
  // what a write hoisted one level too far would destroy.
  const out = of(
    'f:\n\tmov\tr5, #0x0\n\tmov\tr2, #0x0\n\tmov\tr4, #0x0\n' +
      '.Lloop:\n\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
      '\tmov\tr2, r5\n\tcmp\tr0, #0x2\n\tbne\t.Lnext\t@cond_branch\n' +
      '\tadd\tr2, r2, #0x2\n\tb\t.Lnext\n' +
      '.Lc1:\n\tadd\tr2, r2, #0x1\n' +
      '.Lnext:\n\tadd\tr4, r4, #0x1\n\tcmp\tr4, #0x5\n\tblt\t.Lloop\t@cond_branch\n' +
      '\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).toContain('do {');
  expect(out).toMatch(/do \{\s*\n\s*v2 = 0;\s*\n\s*switch \(a0\)/); // inside the loop, above the switch
  expect(out).toContain('v2 = v0 + 1;'); // the loop-carried value still reaches `case 1:`
});

test('two case values sharing ONE body have the same layout index, and stay in value order', () => {
  // Two case values branching to the same label share a layout index, so layout cannot order those
  // two — the one thing the ordering rule cannot read off the assembly. Ascending value is the
  // declared tie-break, so they keep the spelling they already had instead of inheriting whichever
  // the tree walk reached first. The dispatch below tests 3 BEFORE 2 for exactly that reason: the
  // walk records 3 first, so a sort without the tie-break returns [3, 2, 1, 0] and only the
  // tie-break puts them back in value order. (The two shared values are ONE arm with stacked
  // labels, as in the jump-table path, so what the tie-break orders is that arm against the others.)
  const shared =
    'f:\n\tmov\tr2, #0x0\n' +
    '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
    '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
    '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n\tb\t.Lend\n' +
    '.Lhi:\n\tcmp\tr0, #0x3\n\tbeq\t.Lsh\t@cond_branch\n' + // 3 tested FIRST, so the walk records it first
    '\tcmp\tr0, #0x2\n\tbeq\t.Lsh\t@cond_branch\n\tb\t.Lend\n' +
    '.Lsh:\n\tadd\tr2, r1, #0x7\n\tb\t.Lend\n' + // laid out FIRST, reached by both 2 and 3
    '.Lc1:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
    '.Lc0:\n\tadd\tr2, r1, #0x1\n' +
    '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';
  expect(armOrder(of(shared))).toEqual([2, 3, 1, 0]);
});

test('an arm with NO body of its own has no layout evidence, and falls to the end', () => {
  // The other tie the assembly cannot break. `case 1: break;` compiles to a dispatch edge straight
  // to the merge — there is no body laid out anywhere for it — so it inherits the merge's index and
  // lands after every arm that has one, whatever the source wrote. Pinned as the FALLBACK it is:
  // arms 0, 2 and 3 keep their layout order and the bodiless arm follows them.
  const emptyArm =
    'f:\n\tmov\tr3, #0x80\n\tlsl\tr3, r3, #0x13\n' +
    '\tcmp\tr0, #0x1\n\tbeq\t.Lend\t@cond_branch\n' + // case 1 — straight to the merge
    '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
    '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n\tb\t.Ldef\n' +
    '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n' +
    '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n\tb\t.Ldef\n' +
    [0, 2, 3].map((k) => `.Lc${k}:\n\tmov\tr2, #0x${k + 1}\n\tstr\tr2, [r3]\n\tb\t.Lend\n`).join('') +
    '.Ldef:\n\tmov\tr2, #0x9\n\tstr\tr2, [r3]\n' +
    '.Lend:\n\tbx\tlr\n';
  expect(armOrder(of(emptyArm))).toEqual([0, 2, 3, 1]);
});

// ── the `default:` arm's own position ────────────────────────────────────────────────────────────
test('a `default:` laid out among the cases is spelled there, with the `break;` that needs', () => {
  // The default is an arm, and gcc 2.9-arm expands its body in source order like any other:
  // `case 0, case 1, default, case 2, case 3` compiles to a block layout with the default's body
  // third, which is this fixture. Recompiling the layout spelling with agbcc reproduces the target
  // exactly and the last spelling does not. A default that is not last needs a `break;` of its own,
  // or control would drop into the case below it.
  const out = of(dispatch([0, 1, 'D', 2, 3], '.Ldef'));
  expect(out).toMatch(/case 1:\s+v0 = a1 \+ 2;\s+break;\s+default:\s+v0 = 99;\s+break;\s+case 2:/);
  expect(armOrder(out)).toEqual([0, 1, 2, 3]);
});

test('a default the dispatch RAN OUT into, and nothing else names, keeps the last position', () => {
  // A two-case chain: the tests run out into the default's block, and that fall-through is the only
  // reference to it. agbcc then lays that block right after the tests whatever the source wrote —
  // compiled both ways, `default:` first and `default:` last give identical instructions — so the
  // layout is no evidence and C's conventional last position stands.
  const out = of(
    'f:\n\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n' +
      '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
      '\tmov\tr2, #0x63\n\tb\t.Lend\n' + // the default arm, where the dispatch ran out
      '.Lc0:\n\tmov\tr2, #0x1\n\tb\t.Lend\n' +
      '.Lc1:\n\tmov\tr2, #0x2\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).toMatch(/case 1:\s+v0 = 2;\s+break;\s+default:\s+v0 = 99;/);
});

test('a default a SECOND subtree still jumps to is spelled where it is laid out, even first', () => {
  // The same fall-through, with the tree's other exhausted subtree still jumping to the label. That
  // second reference is what pins the block: `emit_case_nodes` gives each exhausted subtree its own
  // `emit_jump_if_reachable (default_label)` and `expand_end_case` reorders the whole dispatch ahead
  // of the arm bodies, so the surviving fall-through means the default's body is the arm the source
  // wrote FIRST. Compiled: at 3 through 8 cases the default's block lands where the source wrote it
  // at every position, and this fixture is the one position the dispatch runs into.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
      '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
      '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n\tb\t.Ldef\n' + // the subtree that JUMPS
      '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n' +
      '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n' + // …and the one that runs out
      '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' +
      [0, 1, 2, 3].map((k) => `.Lc${k}:\n\tadd\tr2, r1, #0x${k + 1}\n\tb\t.Lend\n`).join('') +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).toMatch(/switch \(a0\) \{\s+default:\s+v0 = 99;\s+break;\s+case 0:/);
  expect(armOrder(out)).toEqual([0, 1, 2, 3]);
});

test('which of two identical fall-out jumps the collapse keeps does not decide the label', () => {
  // The collapse emits ONE representative for several bare jumps, and which one it keeps is a walk
  // order accident. A bare jump is a block the dispatch minted, so its index is that accident and
  // not a layout: reading it moved the label when the two jumps merely swapped addresses.
  const jump = (n: number) => `.Lfo${n}:\n\tb\t.Lend\n`;
  const twoFallOuts = (first: string, second: string) =>
    'f:\n\tmov\tr2, #0x0\n' +
    '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
    '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
    '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n\tb\t.Lfo1\n' +
    '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n' +
    '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n\tb\t.Lfo2\n' +
    `.Lc0:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n${first}` +
    '.Lc1:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
    `.Lc2:\n\tadd\tr2, r1, #0x3\n\tb\t.Lend\n${second}` +
    '.Lc3:\n\tadd\tr2, r1, #0x4\n\tb\t.Lend\n' +
    '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';
  const early = of(twoFallOuts(jump(1), jump(2)));
  const late = of(twoFallOuts(jump(2), jump(1)));
  expect(early).toEqual(late);
  expect(early).toMatch(/case 3:[\s\S]*default:/); // the label the assembly does not place goes last
});

test('two fall-out leaves the RETURN sink rewrote are still one default', () => {
  // jump.c's cross-jump merges two arms with identical bodies into one block both `beq`s reach —
  // and that multi-pred block is exactly what makes raise/retsink.ts sink the merge's return into
  // every leaf, the bare fall-out jumps included. Matching only `br` here declined the whole tree
  // to if-nesting on the very switches the cross-jump had already tied.
  const out = decompile(
    'f',
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0x3\n\tbeq\t.Lsh\t@cond_branch\n' +
      '\tcmp\tr0, #0x3\n\tbgt\t.Lhi\t@cond_branch\n' +
      '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n\tb\t.Lend\n' +
      '.Lhi:\n\tcmp\tr0, #0x4\n\tbeq\t.Lsh\t@cond_branch\n' + // 4 and 3 share ONE body
      '\tcmp\tr0, #0x5\n\tbeq\t.Lc5\t@cond_branch\n\tb\t.Lend\n' +
      '.Lc0:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
      '.Lc5:\n\tadd\tr2, r1, #0x5\n\tb\t.Lend\n' +
      '.Lsh:\n\tadd\tr2, r1, #0x9\n' +
      '.Lend:\n\tadd\tr0, r2, #0\n\tbx\tlr\n',
    ARMV4T_AGBCC,
  ).source;
  expect(out).toContain('switch (a0)');
  expect(out).not.toContain('else'); // not the if-nesting fallback
  expect(armOrder(out)).toEqual([0, 5, 3, 4]);
  expect(out).toMatch(/default:\s+return 0;/); // the sunk return the leaves now hold
});

test('a default placed after a FALLING case is refused by the printer, not silently emitted', () => {
  // `defaultAt` is a spelling, and this is the one placement that is not: moving the label in
  // front of an arm that falls through diverts that arm into the default instead of into the case
  // below. Recovery only positions a default among closed arms, so reaching the printer with one
  // is a producer bug — it fails loud rather than emitting C that runs a different program.
  const arm = (v: number, to: number, fallsThrough: boolean) => ({
    values: [v],
    body: [{ k: 'assign', name: 'w', value: { k: 'const', value: to } } as Stmt],
    fallsThrough,
  });
  const sw = (defaultAt: number): SFn => ({
    name: 'f',
    params: [{ name: 'x', type: T.s(32) }],
    locals: [{ name: 'w', type: T.s(32) }],
    retType: T.void(),
    body: [
      {
        k: 'switch',
        scrutinee: { k: 'var', name: 'x' },
        cases: [arm(0, 1, true), arm(1, 2, false)],
        default: [{ k: 'assign', name: 'w', value: { k: 'const', value: 9 } } as Stmt],
        defaultAt,
      },
    ],
  });
  expect(() => emitCFamily('void f(s32 x)', sw(1))).toThrow(/falls through/);
  expect(emitCFamily('void f(s32 x)', sw(2))).toMatch(/case 1:[\s\S]*default:/); // after both: fine
  // A count past the arms matches no position, so the label would simply not be printed and the
  // default arm would vanish. Refused for the same reason, rather than silently dropped.
  expect(() => emitCFamily('void f(s32 x)', sw(3))).toThrow(/places its default at arm 3 of 2/);
});

test('a loop-scoped `break` inside a case arm is refused, and `continue` is not', () => {
  // L3's `{k:'break'}` is the innermost LOOP's (l3/ast.ts); C's, printed between `case` labels, is
  // the switch's. Nothing produces one today — a loop-exiting arm is declined first, by loop
  // recovery for a comparison tree and by `analyzeArmExit` for a jump table — but the rebinding
  // happens in the PRINTER, so the refusal belongs there, for every producer rather than for the
  // two switch regimes.
  //
  // `continue` is the CONTROL on that refusal's premise: C binds it to the smallest enclosing
  // iteration statement, and a `switch` is not one, so it already means what L3 means and printing
  // it is correct. Compiled both ways, `for(...){switch(i){case 2: continue;} n++;}` and
  // `for(...){if(i==2) continue; n++;}` leave the same counter.
  const armed = (body: Stmt[]): SFn => ({
    name: 'f',
    params: [{ name: 'x', type: T.s(32) }],
    locals: [{ name: 'w', type: T.s(32) }],
    retType: T.void(),
    body: [
      {
        k: 'while',
        cond: { k: 'var', name: 'x' },
        body: [
          { k: 'switch', scrutinee: { k: 'var', name: 'x' }, cases: [{ values: [0], body, fallsThrough: false }] },
        ],
      },
    ],
  });
  const set: Stmt = { k: 'assign', name: 'w', value: ZERO };
  expect(() => emitCFamily('void f(s32 x)', armed([set, { k: 'break' }]))).toThrow(/loop-scoped `break;`/);
  expect(emitCFamily('void f(s32 x)', armed([set, { k: 'continue' }]))).toContain('continue;');
  // …including one nested in an `if`, which is the shape a guarded loop exit actually takes.
  expect(() =>
    emitCFamily('void f(s32 x)', armed([{ k: 'if', cond: { k: 'var', name: 'x' }, then: [{ k: 'break' }], else: [] }])),
  ).toThrow(/loop-scoped `break;`/);
  // …and one nested a second switch deep, where the outer walk deliberately does not look: the
  // inner switch prints it itself, and must reach the same verdict.
  const nested = (inner: Stmt[]): Stmt[] => [
    { k: 'switch', scrutinee: { k: 'var', name: 'x' }, cases: [{ values: [1], body: inner, fallsThrough: false }] },
  ];
  expect(() => emitCFamily('void f(s32 x)', armed(nested([{ k: 'break' }])))).toThrow(/loop-scoped `break;`/);
  expect(emitCFamily('void f(s32 x)', armed(nested([{ k: 'continue' }])))).toContain('continue;');
  // CONTROL: an ordinary arm, and a loop OPENED INSIDE the arm, which captures its own `break`.
  expect(emitCFamily('void f(s32 x)', armed([set]))).toContain('case 0:');
  expect(
    emitCFamily('void f(s32 x)', armed([{ k: 'while', cond: { k: 'var', name: 'x' }, body: [set, { k: 'break' }] }])),
  ).toContain('case 0:');
});

test('`stmtChildren` lists a mid-placed default where the backend prints it', () => {
  // The walkers' document order and the printer's are the same order — `collectMarkers` reports one
  // per marker in it, so an ASMLIFT_ERROR inside a default that prints second must not be reported
  // after the arms that print below it.
  const arm = (v: number) => ({
    values: [v],
    body: [{ k: 'assign', name: `c${v}`, value: ZERO } as Stmt],
    fallsThrough: false,
  });
  const sw: Stmt = {
    k: 'switch',
    scrutinee: { k: 'var', name: 'x' },
    cases: [arm(0), arm(1)],
    default: [{ k: 'assign', name: 'd', value: ZERO } as Stmt],
    defaultAt: 1,
  };
  expect(stmtChildren(sw).map((c) => (c.k === 'assign' ? c.name : c.k))).toEqual(['c0', 'd', 'c1']);
});

// ── Regime B: the jump table ─────────────────────────────────────────────────────────────────────
// agbcc's own output for a 5-arm dense switch whose source wrote the arms 3, 0, 4, 1, 2 with a
// `default:` last. The TABLE's slots are ascending by construction (slot i is case i), so grouping
// them in table order spells the arms 0..4 — while the bodies are laid out in the order the arms
// were written, exactly as in the comparison tree above. Recompiling the layout spelling with agbcc
// reproduces the target and the ascending spelling does not.
const table = (tail = '\tb\t.L3\n', defaultAfter = 5, c3 = '\tadd\tr1, r2, #0x4\n') => {
  const bodies = [
    `.L4:\n${c3}${tail}`, // case 3 — written FIRST, so laid out first
    '.L5:\n\tadd\tr1, r2, #0x1\n\tb\t.L3\n', // case 0
    '.L6:\n\tadd\tr1, r2, #0x5\n\tb\t.L3\n', // case 4
    '.L7:\n\tadd\tr1, r2, #0x2\n\tb\t.L3\n', // case 1
    '.L8:\n\tadd\tr1, r2, #0x3\n\tb\t.L3\n', // case 2
  ];
  bodies.splice(defaultAfter, 0, '.L9:\n\tmov\tr1, #0x63\n\tb\t.L3\n'); // the default
  return (
    'f:\n\tadd\tr2, r1, #0\n' +
    '\tcmp\tr0, #0x4\n\tbhi\t.L9\t@cond_branch\n' +
    '\tlsl\tr0, r0, #0x2\n\tldr\tr1, .L11\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n' +
    '.L12:\n\t.align\t2, 0\n.L11:\n\t.word\t.L10\n\t.align\t2, 0\n' +
    '.L10:\n\t.word\t.L5\n\t.word\t.L7\n\t.word\t.L8\n\t.word\t.L4\n\t.word\t.L6\n' + // cases 0..4
    bodies.join('').replace(/\tb\t\.L3\n$/, '') + // the last body falls into the merge
    '.L3:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr1, [r0]\n\tbx\tlr\n'
  );
};

test('jump-table arms come back in layout order too, not in TABLE order', () => {
  // The lever is declared per compiler, not per regime: the fact underneath (bodies expand in source
  // order, only the dispatch moves) is the same one, and agbcc's tables carry it — 8 dense arms
  // written 5,2,0,4,1,3,6,7 lay their bodies out in that order under an ascending table.
  expect(armOrder(of(table()))).toEqual([3, 0, 4, 1, 2]);
  expect(of(table())).toMatch(/case 3:\s+v0 = a1 \+ 4;/); // each arm keeps its own body
});

test('a jump table under a compiler without the declaration keeps table order', () => {
  const undeclared = { ...ARMV4T_AGBCC, compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors } };
  delete undeclared.compilerBehaviors.switchArmsFollowLayout;
  const out = decompile('f', table(), undeclared, { prototypes: { f: { returnsVoid: true } } }).source;
  expect(armOrder(out)).toEqual([0, 1, 2, 3, 4]);
});

test('a jump-table `default:` is spelled where its body is laid out, at every position', () => {
  // The default is an arm here too, and the table's range check BRANCHES to it (`bhi .Ldefault`) —
  // never a block the dispatch ran into. Compiled: a 5-arm dense table lays the default's body at
  // each of the six positions the source can write it in exactly there, and recompiling asmlift's
  // own spelling reproduces the target at every one of them.
  for (const at of [0, 1, 2, 3, 4, 5]) {
    const out = of(table('\tb\t.L3\n', at));
    const arms = [...out.matchAll(/case (\d+):|(default):/g)].map((m) => m[1] ?? m[2]);
    expect(arms).toEqual([
      ...['3', '0', '4', '1', '2'].slice(0, at),
      'default',
      ...['3', '0', '4', '1', '2'].slice(at),
    ]);
  }
});

test('a default the table also reaches as a CASE has that arm\u2019s index, not a position', () => {
  // The slots an unwritten value falls to point at the default's own block, so grouping gives that
  // block a `case` arm as well. Its layout index is then where that ARM sits and says nothing about
  // where `default:` was written — the same "no evidence" rule the bodiless arm gets. Slot 4 here
  // names `.L9`, so the arms are 3, 0, 1, 2 and 4, and the label stays last rather than landing
  // where case 4 was laid out.
  const shared = table()
    .replace('\t.word\t.L6\n', '\t.word\t.L9\n')
    .replace('.L6:\n\tadd\tr1, r2, #0x5\n\tb\t.L3\n', '');
  const out = of(shared);
  expect([...out.matchAll(/case (\d+):|(default):/g)].map((m) => m[1] ?? m[2])).toEqual([
    '3',
    '0',
    '1',
    '2',
    '4',
    'default',
  ]);
});

// A case-3 body with a LIVE effect — a store, so nothing downstream can delete it. Case 3's own
// `add r1, r2, #4` would be dead under the fall-through (case 0 overwrites r1 immediately), which
// makes the two slots one arm with stacked labels instead of a chain: a correct spelling, and the
// wrong fixture for reading arm ORDER off.
const liveFall = '\tmov\tr3, #0x80\n\tlsl\tr3, r3, #0x13\n\tstr\tr2, [r3]\n';

test('a jump-table arm that FALLS THROUGH is chained, like a comparison tree\u2019s', () => {
  // Drop case 3's `b .L3` and it falls into case 0. Both regimes read the arm-order policy for the
  // chain HEADS and let the chain place the rest — ONE definition (`chainArms`), so a jump table is
  // no longer strictly behind a tree on the same shape. Here layout order already puts case 0 right
  // after case 3, so the chain leaves the order alone and only the `break;` moves.
  const out = of(table('', 5, liveFall));
  expect(armOrder(out)).toEqual([3, 0, 4, 1, 2]);
  expect(out).toMatch(/case 3:[\s\S]*?\n\s*case 0:/);
  expect(out).not.toMatch(/case 3:[\s\S]*?break;[\s\S]*?case 0:/);
  expect(out).toContain('*(s32 *)(128 << 19) = a1;'); // the falling arm's own effect, emitted once
});

test('\u2026and on a compiler with no layout rule the CHAIN re-threads the table order', () => {
  // Table order is ascending — 0, 1, 2, 3, 4 — which writes case 3 BELOW the arm it falls into.
  // The chain forces 3 directly above 0 and the untouched arms keep their policy positions, so the
  // emitted order is 1, 2, 3, 0, 4: the re-threading branch, on a jump table.
  const undeclared = { ...ARMV4T_AGBCC, compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors } };
  delete undeclared.compilerBehaviors.switchArmsFollowLayout;
  const out = decompile('f', table('', 5, liveFall), undeclared, {
    prototypes: { f: { returnsVoid: true } },
  }).source;
  expect(armOrder(out)).toEqual([1, 2, 3, 0, 4]);
  expect(out).toMatch(/case 3:[\s\S]*?\n\s*case 0:/);
});

test('TWO jump-table arms falling into ONE still fails LOUD', () => {
  // Regime B has no second recovery, so a shape no linear order spells is an error, not a
  // fallback — the same three refusals `chainArms` states for the comparison tree.
  const twoIntoOne = table('', 5, liveFall).replace(
    '.L6:\n\tadd\tr1, r2, #0x5\n\tb\t.L3\n',
    '.L6:\n' + liveFall + '\tb\t.L5\n',
  );
  expect(() => of(twoIntoOne)).toThrow(/do not linearize/);
});

// ── the case a RELATIONAL test pins ──────────────────────────────────────────────────────────────
// `emit_case_nodes` tests a subtree's BOUND rather than its value once the remaining range has
// collapsed to one, so agbcc spells `case 0:` of an unsigned switch as `cmp r0, #1 / bcc` — the
// shape `synthetic:armdef:agbcc` and `synthetic:armfall:agbcc` both carry. Read as pure
// navigation that arm's body is a second default candidate and the whole tree declines to
// if-nesting, which compiles to a different compare AND a different arm layout.
//
// An `if (x < 1) … else if …` chain compiles to the same asm, so the reading is held to what
// `emit_case_nodes` can emit: the BRANCH of a test BELOW the root, on a compiler that declared
// `switchAllowsBoundCase`. Each of those three refusals has a fixture of its own below, and PRE3
// closes the fourth question — a singleton an ancestor already ruled out.

/** agbcc's own `switch (x) { case 0..2 }`: the dispatch verbatim from `-O2 -mthumb-interwork
 *  -fhex-asm -fprologue-bugfix`, where `case 0:` is the bound test `cmp r0, #1 / bcc` under the
 *  root's `== 1`, over one-instruction bodies. */
const boundCase =
  'f:\n\tmov\tr2, #0x0\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbcc\t.Lc0\t@cond_branch\n' + // x < 1, unsigned ⇒ exactly {0}
  '\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n\tb\t.Lend\n' +
  [0, 1, 2].map((k) => `.Lc${k}:\n\tadd\tr2, r1, #0x${k + 1}\n\tb\t.Lend\n`).join('') +
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';

test('a relational test whose branch admits ONE value routes that case, not the default', () => {
  const out = of(boundCase);
  expect(out).toContain('switch (a0)');
  expect(armOrder(out)).toEqual([0, 1, 2]);
  expect(out).not.toContain('else'); // not the if-nesting fallback
});

test('the FALL side of a relational test is navigation, whatever it admits', () => {
  // `emit_case_nodes` reaches a case body from a relational test only by BRANCHING to it; its
  // fall-through always continues into more dispatch. So `cmp r0, #0 / bhi`, whose fall side is
  // exactly {0}, did not come from a dispatch, and the tree stays the comparison chain it reads
  // as.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0\n\tbhi\t.Lhi\t@cond_branch\n' +
      '\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
      '.Lhi:\n\tcmp\tr0, #0x5\n\tbeq\t.Lc5\t@cond_branch\n\tb\t.Ldef\n' +
      '.Lc5:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
      '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).not.toContain('switch (');
  // the relational test survives as an ordinary `if` — spelled with the arms swapped, which is
  // the joined-if sense (structure.ts negateJoinedBranchSense)
  expect(out).toContain('a0 <= 0');
});

test('a bound test that OPENS the dispatch is an ordinary `if`, not a case', () => {
  // A single-valued node emits its own `do_jump_if_equal` before either descent test, so a bound
  // test always sits UNDER another test of the tree, and one that opens the region has no producer
  // in this dispatch. Root position is where the shape actually turns up — 15 of the 16 sites the
  // reading is considered at over 15712 lifted functions — and none of them is a dispatch.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0x1\n\tbcc\t.Lc0\t@cond_branch\n' +
      '\tcmp\tr0, #0x5\n\tbeq\t.Lc5\t@cond_branch\n\tb\t.Ldef\n' +
      '.Lc0:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
      '.Lc5:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
      '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).not.toContain('switch (');
  expect(out).toContain('a0 >= 1'); // the bound test as an `if`, at the joined sense
});

test('a bound branch onto another TEST is the search descending, and still recovers', () => {
  // `cmp r0, #1 / bcc` reaching a block that pins the value with `== 0` is the dispatch walking
  // down, not an arm: reading it as a case body would decline the whole tree, because a test is
  // not a body. Navigation recovers the switch.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0x1\n\tbcc\t.Lsub\t@cond_branch\n' +
      '\tcmp\tr0, #0x5\n\tbeq\t.Lc5\t@cond_branch\n\tb\t.Ldef\n' +
      '.Lsub:\n\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n\tb\t.Ldef\n' +
      '.Lc0:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
      '.Lc5:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
      '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).toContain('switch (a0)');
  expect(armOrder(out)).toEqual([0, 5]);
});

test('a compiler that has not declared bound cases reads the branch as navigation', () => {
  // The rule is agbcc's, from agbcc's `stmt.c`. The same asm is a plain if-else chain on a
  // compiler whose dispatch never elides the remaining value's test, and IDO already pays for
  // that mis-recognition once (`switchAllowsNeqCase: false`), so nobody inherits this one.
  const undeclared = { ...ARMV4T_AGBCC, compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors } };
  delete undeclared.compilerBehaviors.switchAllowsBoundCase;
  const out = decompile('f', boundCase, undeclared, { prototypes: { f: { returnsVoid: true } } }).source;
  expect(out).not.toContain('switch (');
  for (const t of [MIPS_IDO, MIPS_GCC, PPC_MWCC]) {
    expect(t.compilerBehaviors.switchAllowsBoundCase).toBeUndefined();
  }
});

test('a singleton an ancestor already excluded is DEAD, and PRE3 declines rather than resurrect it', () => {
  // The reading is over the whole 32-bit domain, so `x < 1` still says `{0}` under an ancestor
  // that sent every x < 5 elsewhere. Simulating the original tree for the recovered value is what
  // catches it: x == 0 reaches `.Ldef`, not `.Lc0`.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0x5\n\tbcc\t.Ldef\t@cond_branch\n' +
      '\tcmp\tr0, #0x1\n\tbcc\t.Lc0\t@cond_branch\n' + // unreachable under x >= 5
      '\tcmp\tr0, #0x6\n\tbeq\t.Lc6\t@cond_branch\n' +
      '\tcmp\tr0, #0x7\n\tbeq\t.Lc7\t@cond_branch\n\tb\t.Ldef\n' +
      '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' +
      '.Lc0:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
      '.Lc6:\n\tadd\tr2, r1, #0x7\n\tb\t.Lend\n' +
      '.Lc7:\n\tadd\tr2, r1, #0x8\n\tb\t.Lend\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).not.toContain('switch (');
  expect(out).not.toContain('case 0:'); // x == 0 must still reach the 0x63 arm, not .Lc0's
  expect(out).toContain('else');
});

// ── a test block that carries a STATEMENT ────────────────────────────────────────────────────────
// Collapsing the tree re-renders a test block's ops at their uses and emits no side effects for the
// block, so an op that renders as a statement of its OWN loses it. PRE4 is where that is refused,
// and a MATERIALIZED def is the second producer beside the anchored merge copy: its `v = …` is the
// only place the value is written, while its uses read the bare name.

/** lift + structure with an axis forced on — `decompile` only offers the target's own defaults. */
const homed = (asm: string, opts: StructureOptions): string => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('f', asm, ARMV4T_AGBCC, {}, undefined, undefined);
  verify(fn);
  applyIdiomPatterns(fn, ARMV4T_AGBCC);
  raiseRecovered(fn, ARMV4T_AGBCC);
  return cBackend.emit(structure(fn, { ...structureOptionsFor(ARMV4T_AGBCC, true), ...opts }));
};

/** `switch (x) { case 1, 2, 5 }` whose SECOND test block computes `a1 << 2` — read by the case-5
 *  loop and by case 2, which is `/expr-home`'s scope. */
const homeInTest =
  'f:\n\tpush\t{r4, lr}\n\tmov\tr2, #0x0\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tlsl\tr3, r1, #0x2\n' +
  '\tcmp\tr0, #0x5\n\tbeq\t.Lc0\t@cond_branch\n' +
  '\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n\tb\t.Ldef\n' +
  '.Lc0:\n\tmov\tr4, #0x0\n' +
  '.Lloop:\n\tadd\tr2, r2, r3\n\tadd\tr4, r4, #0x1\n\tcmp\tr4, #0x3\n\tbne\t.Lloop\t@cond_branch\n\tb\t.Lend\n' +
  '.Lc1:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
  '.Lc2:\n\tadd\tr2, r3, #0x3\n\tb\t.Lend\n' +
  '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' +
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';

test('a materialized def in a test block keeps its assignment — the tree declines around it', () => {
  const out = homed(homeInTest, { homeLoopExprs: true });
  const home = out.match(/(\w+) = a1 << 2;/);
  expect(home).not.toBeNull();
  // every read of the home is preceded by the write, on every path
  expect(out.indexOf(`${home![1]} = a1 << 2;`)).toBeLessThan(out.indexOf(`+ ${home![1]}`));
  expect(out).toContain('if (a0 != 1)'); // the block holding it is no longer a test of the tree
});

test('the same tree recovers whole when nothing homes in the test block', () => {
  // Control: `/expr-home` off, so `a1 << 2` re-renders at its two uses and the test block is pure.
  const out = homed(homeInTest, {});
  expect(out).toContain('switch (a0)');
  expect(armOrder(out)).toEqual([5, 1, 2]);
  expect(count(out, 'a1 << 2')).toBe(2);
});

// TWO VALUES, ONE BODY. agbcc routes `case 0` and `case 2` to the same block whenever the source
// stacked their labels, AND when it wrote the body out once per label — it merges the copies, at
// the last one's position. IDO does not merge at all (224 bytes against the grouped 144). So a
// shared block never means two arms on either compiler, and emitting the body once per label is a
// duplication rather than a spelling — see switch-recover.ts for the measurements.
const shared02 =
  'f:\n\tmov\tr2, #0x0\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
  '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n' +
  '\tb\t.Ldef\n' +
  '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc0\t@cond_branch\n' + // case 2 lands on case 0's body
  '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n' +
  '\tb\t.Ldef\n' +
  '.Lc0:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
  '.Lc1:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
  '.Lc3:\n\tadd\tr2, r1, #0x4\n\tb\t.Lend\n' +
  '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' +
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';

test('two case values reaching one body are ONE arm with stacked labels', () => {
  const out = of(shared02);
  expect(out).toContain('switch (a0)');
  expect(armOrder(out)).toEqual([0, 2, 1, 3]); // 0 and 2 adjacent — one arm, two labels
  expect(count(out, 'a1 + 1')).toBe(1); // the body is emitted ONCE, not once per label
  expect(out).toMatch(/case 0:\s*\n\s*case 2:/);
});

// The same tree with the `default:` arm laid out BETWEEN two case bodies — where the arm-array
// index `defaultLayoutPos` returns is observable. The index and the array it indexes have to be
// the SAME list: counting the ungrouped entries (which hold `.Lc0` twice) against the grouped arm
// array puts the label one arm too late. A PAIRING guard — it fails when the two lists are crossed,
// not when either alone changes.
const shared02MidDefault =
  'f:\n\tmov\tr2, #0x0\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
  '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n' +
  '\tb\t.Ldef\n' +
  '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc0\t@cond_branch\n' +
  '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n' +
  '\tb\t.Ldef\n' +
  '.Lc0:\n\tadd\tr2, r1, #0x1\n\tb\t.Lend\n' +
  '.Lc1:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
  '.Ldef:\n\tmov\tr2, #0x63\n\tb\t.Lend\n' +
  '.Lc3:\n\tadd\tr2, r1, #0x4\n\tb\t.Lend\n' +
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';

// The counter-case for the grouping's KEY. Two case values whose bodies are DISTINCT blocks holding
// the same statements: `sameBareExit` — this file's equivalence for "indistinguishable at emission",
// used for `default:` candidates — would call these one arm, and block identity does not. Block
// identity is right on both compilers measured: agbcc merges two written-out copies, so it never
// emits this ROM, and IDO does not merge, so this ROM is exactly what two arms compile to.
const twinBodies =
  'f:\n\tmov\tr2, #0x0\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
  '\tcmp\tr0, #0\n\tbeq\t.Le0\t@cond_branch\n\tb\t.Ldef\n' +
  '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Le2\t@cond_branch\n' +
  '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n\tb\t.Ldef\n' +
  '.Le0:\n\tmov\tr0, #0x7\n\tb\t.Lend\n' +
  '.Lc1:\n\tmov\tr0, #0x2\n\tb\t.Lend\n' +
  '.Le2:\n\tmov\tr0, #0x7\n\tb\t.Lend\n' +
  '.Lc3:\n\tmov\tr0, #0x4\n\tb\t.Lend\n' +
  '.Ldef:\n\tmov\tr0, #0x63\n\tb\t.Lend\n' +
  '.Lend:\n\tbx\tlr\n';

test('two case values with EQUAL bodies in DIFFERENT blocks stay two arms', () => {
  const out = decompile('f', twinBodies, ARMV4T_AGBCC, { prototypes: {} }).source;
  expect(out).toContain('switch (a0)');
  expect(armOrder(out)).toEqual([0, 1, 2, 3]);
  expect(count(out, 'return 7;')).toBe(2); // two blocks, two arms — NOT stacked labels
  expect(out).not.toMatch(/case 0:\s*\n\s*case 2:/);
});

test('…and `default:` still lands where the LAYOUT puts it, counted in arms', () => {
  const out = of(shared02MidDefault);
  expect(armOrder(out)).toEqual([0, 2, 1, 3]);
  expect(out.indexOf('default:')).toBeGreaterThan(out.indexOf('case 1:'));
  expect(out.indexOf('default:')).toBeLessThan(out.indexOf('case 3:'));
});

// ── fall-through arms ────────────────────────────────────────────────────────────────────────────
// The two fixtures here are agbcc's own output for the C in their comments, compiled at
// TOOLCHAIN.agbccFlags; the declining shapes further down are hand-built, because no C produces
// them. A falling arm is spelled by OMITTING the `break;`, which is a positional fact — control
// drops into whatever arm is emitted NEXT (the l3/ast.ts non-neutrality note) — so recovery is not
// free to order the arms by layout or by case value where a chain says otherwise.
//
// `switch (x) { case 3: *p = 1; case 2: *p += 2; case 1: *p += 3; }` — no `break` anywhere.
const fallChain =
  'f:\n' +
  '\tcmp\tr0, #0x2\n\tbeq\t.L5\t@cond_branch\n' +
  '\tcmp\tr0, #0x2\n\tbgt\t.L9\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.L6\t@cond_branch\n' +
  '\tb\t.L3\n' +
  '.L9:\n\tcmp\tr0, #0x3\n\tbne\t.L3\t@cond_branch\n\tmov\tr0, #0x1\n\tstr\tr0, [r1]\n' +
  '.L5:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x2\n\tstr\tr0, [r1]\n' +
  '.L6:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x3\n\tstr\tr0, [r1]\n' +
  '.L3:\n\tbx\tlr\n';

test('a chain of falling arms is ONE switch, and the fallen-into arm is emitted once', () => {
  const out = of(fallChain);
  expect(out).toContain('switch (a0)');
  expect(out).not.toContain('else'); // not the if-recovery fallback
  expect(armOrder(out)).toEqual([3, 2, 1]);
  // Each body appears exactly once — if-recovery reaches `case 1`'s body on three paths and emits
  // it three times, which is what the fall-through spelling replaces.
  expect(count(out, '*a1 = v0 + 3;')).toBe(1);
  // The last arm CLOSES: the epilogue is the switch's merge and every arm reaches it. It used to
  // end in `return;` instead, because `raise/retsink.ts` duplicated that epilogue into each arm —
  // which it no longer does on a fall-through switch (see retsink.test.ts).
  expect(count(out, 'break;')).toBe(1);
});

test('the CHAIN orders the arms, not the case values, on a compiler with no layout rule', () => {
  // Ascending case value is the neutral order for a compiler that has not declared
  // `switchArmsFollowLayout`, and it would emit 1, 2, 3 — which reverses the chain and makes
  // `case 3` fall into `case 2` by writing it BELOW it. The order is forced by the exits.
  const undeclared = { ...ARMV4T_AGBCC, compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors } };
  delete undeclared.compilerBehaviors.switchArmsFollowLayout;
  const out = decompile('f', fallChain, undeclared, { prototypes: { f: { returnsVoid: true } } }).source;
  expect(armOrder(out)).toEqual([3, 2, 1]);
});

// `switch (x) { case 0: *p = 1; case 1: *p += 2; break; case 2: *p += 3; default: *p += 4; }`
const fallIntoDefault =
  'f:\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.L5\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbgt\t.L9\t@cond_branch\n' +
  '\tcmp\tr0, #0\n\tbeq\t.L4\t@cond_branch\n' +
  '\tb\t.L7\n' +
  '.L9:\n\tcmp\tr0, #0x2\n\tbeq\t.L6\t@cond_branch\n\tb\t.L7\n' +
  '.L4:\n\tmov\tr0, #0x1\n\tstr\tr0, [r1]\n' +
  '.L5:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x2\n\tb\t.L10\n' +
  '.L6:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x3\n\tstr\tr0, [r1]\n' +
  '.L7:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x4\n' +
  '.L10:\n\tstr\tr0, [r1]\n\tbx\tlr\n';

test('an arm falling into the DEFAULT is emitted directly above it', () => {
  // C prints `default:` where `defaultAt` says, and an arm falling into it needs it directly
  // below — so the chain that ends in the default takes the LAST position and the label keeps C's
  // conventional one. `case 1` closes in the middle, which is what makes the placement observable.
  const out = of(fallIntoDefault);
  expect(out).toContain('switch (a0)');
  expect(armOrder(out)).toEqual([0, 1, 2]);
  // `case 2` runs straight on into the default — no `break;` between the two…
  expect(out).toMatch(/case 2:[\s\S]*?\n\s*default:/);
  expect(out).not.toMatch(/case 2:[\s\S]*?break;[\s\S]*?default:/);
  // …while the closed arm between the two chains keeps the only `break;` in the switch.
  expect(count(out, 'break;')).toBe(1);
});

// agbcc's own output for
// `switch (x) { case 0: *p = 1; break; default: *p = 9; break; case 1: *p += 2; case 2: *p += 3; break; }`
// — a `default:` written BETWEEN two closed arms, with a chain two arms below it.
const defaultAmongClosed =
  'f:\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.L6\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbgt\t.L9\t@cond_branch\n' +
  '\tcmp\tr0, #0\n\tbeq\t.L4\t@cond_branch\n' +
  '\tb\t.L5\n' +
  '.L9:\n\tcmp\tr0, #0x2\n\tbeq\t.L7\t@cond_branch\n\tb\t.L5\n' +
  '.L4:\n\tmov\tr0, #0x1\n\tb\t.L10\n' +
  '.L5:\n\tmov\tr0, #0x9\n\tb\t.L10\n' +
  '.L6:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x2\n\tstr\tr0, [r1]\n' +
  '.L7:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x3\n' +
  '.L10:\n\tstr\tr0, [r1]\n\tbx\tlr\n';

test('a chain elsewhere does not delete the evidence for where `default:` was written', () => {
  // Where the label goes is a POSITION, and the two arms it sits between are both closed — it
  // diverts nothing. Withholding it for any switch that carries a chain anywhere is a per-SWITCH
  // predicate answering a per-POSITION question; measured against this row's own object, the label
  // last scores 6 and the label here MATCHES (`synthetic:sw_defmid:agbcc`).
  const out = of(defaultAmongClosed);
  expect(out).toContain('switch (a0)');
  expect([...out.matchAll(/case (\d+):|(default):/g)].map((m) => m[1] ?? m[2])).toEqual(['0', 'default', '1', '2']);
  // …and the chain below it is still a chain: `case 1` runs on into `case 2`.
  expect(out).not.toMatch(/case 1:[\s\S]*?break;[\s\S]*?case 2:/);
});

// ── the shapes that still decline ────────────────────────────────────────────────────────────────
// Regime A's fallback is if-recovery, which spells every edge the assembly has — so each of these
// comes back as if-nesting rather than as a `switch` that guesses. What the assertions read is that
// the arm at the far end of the offending edge never gets a `case` label of the recovered switch,
// and that its body is DUPLICATED into the arms reaching it — the honest, costly spelling.
const threeCase = (c0: string, c1: string, c2: string) =>
  'f:\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
  '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n\tb\t.Lend\n' +
  '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n\tb\t.Lend\n' +
  `.Lc0:\n${c0}` +
  `.Lc1:\n${c1}` +
  `.Lc2:\n${c2}` +
  // The merge has a BODY — statements after the switch. An arm leaving to it is therefore a
  // switch-scoped `break;` rather than a `return`, which is what the END-on-another-path shape
  // below rests on: `analyzeArmExit` counts a `ret` as leaving, so an arm returning on one path
  // still falls through on the other and is not the shape that fixture wants.
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr1, [r0]\n\tbx\tlr\n';

test('TWO arms falling into ONE decline — C reaches an arm from above only once', () => {
  const out = of(
    threeCase(
      '\tmov\tr0, #0x1\n\tstr\tr0, [r1]\n\tb\t.Lc1\n',
      '\tmov\tr0, #0x2\n\tstr\tr0, [r1]\n\tb\t.Lend\n',
      '\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n\tb\t.Lc1\n',
    ),
  );
  expect(armOrder(out)).not.toContain(1);
  expect(count(out, '*a1 = 2;')).toBeGreaterThan(1);
});

test('a body reaching TWO sibling arms declines — C fall-through reaches only one', () => {
  const out = of(
    threeCase(
      '\tcmp\tr1, #0\n\tbeq\t.Lc1\t@cond_branch\n\tb\t.Lc2\n',
      '\tmov\tr0, #0x2\n\tstr\tr0, [r1]\n\tb\t.Lend\n',
      '\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n\tb\t.Lend\n',
    ),
  );
  expect(armOrder(out)).not.toContain(1);
  expect(count(out, '*a1 = 2;')).toBeGreaterThan(1);
});

test('a body reaching a sibling on one path and the switch END on another declines', () => {
  // The shape that needs a switch-scoped `break;` inside a case body, which l3 does not emit
  // (`{k:'break'}` is loop-scoped). Widening fall-through to swallow it would divert the exiting
  // path into the next arm.
  const out = of(
    threeCase(
      '\tcmp\tr1, #0\n\tbeq\t.Lend\t@cond_branch\n\tb\t.Lc1\n',
      '\tmov\tr0, #0x2\n\tstr\tr0, [r1]\n\tb\t.Lend\n',
      '\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n\tb\t.Lend\n',
    ),
  );
  expect(armOrder(out)).not.toContain(1);
  expect(count(out, '*a1 = 2;')).toBeGreaterThan(1);
});

// ── what the TARGET LANGUAGE can spell is a recovery input ───────────────────────────────────────
// Regime A has TWO behaviourally identical recoveries of a fall-through tree: the `switch` with a
// falling arm, and plain if-nesting. Pascal's `case-of` prints only the second, and its backend
// loud-fails a `fallsThrough` arm (l3/ast.ts's non-neutrality note) — so minting one for that
// backend does not cost the `switch`, it costs the whole FUNCTION. The recovery asks first.

test('a language with no case fall-through gets the if-recovery, not a stub', () => {
  const out = decompile('f', fallChain, ARMV4T_AGBCC, {
    prototypes: { f: { returnsVoid: true } },
    backend: pascalBackend,
  }).source;
  expect(out).toContain('procedure f(');
  expect(out).toContain('if (');
  expect(out).not.toContain('case ');
  // the body is really there — an if-recovery duplicates the fallen-into arms rather than losing them
  expect(count(out, 'a1^ := (v0 + 3);')).toBeGreaterThan(1);
});

test('…and the SAME assembly still recovers the falling switch for C', () => {
  expect(of(fallChain)).toContain('switch (a0)');
});

test('a candidate fan for that backend is not empty', () => {
  const cands = enumerateCandidates('f', fallChain, ARMV4T_AGBCC, {
    prototypes: { f: { returnsVoid: true } },
    backend: pascalBackend,
  });
  expect(cands.length).toBeGreaterThan(0);
  expect(cands.every((c) => !c.source.includes('could not decompile'))).toBe(true);
});

/** A dense 0..2 table over a pointer parameter, with a `default:`, whose every arm the Pascal
 *  backend can print — so the refusal a falling one draws is the fall-through's and not the
 *  fixture's. `fall` drops case 0's `b .Le`, running it on into case 1. */
const pasTable = (fall: boolean) =>
  'f:\n' +
  '\tcmp\tr0, #0x2\n\tbhi\t.Ld\t@cond_branch\n' +
  '\tlsl\tr0, r0, #0x2\n\tldr\tr3, .Lp\n\tadd\tr0, r0, r3\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n' +
  '.Lq:\n\t.align\t2, 0\n.Lp:\n\t.word\t.Lt\n\t.align\t2, 0\n' +
  '.Lt:\n\t.word\t.La\n\t.word\t.Lb\n\t.word\t.Lc\n' +
  '.La:\n\tmov\tr0, #0x1\n\tstr\tr0, [r1]\n' +
  (fall ? '' : '\tb\t.Le\n') +
  '.Lb:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x2\n\tstr\tr0, [r1]\n\tb\t.Le\n' +
  '.Lc:\n\tldr\tr0, [r1]\n\tadd\tr0, r0, #0x3\n\tstr\tr0, [r1]\n\tb\t.Le\n' +
  '.Ld:\n\tmov\tr0, #0x63\n\tstr\tr0, [r1]\n' +
  '.Le:\n\tbx\tlr\n';

test('\u2026and a jump table that falls through fails LOUD for it, naming the table', () => {
  // Regime B has no second recovery — the arms ARE the table's slots — so the same question gets an
  // error rather than a fallback. Asked in the recovery so the message names the shape: the backend
  // refuses the printed arm too, with a message of its own, and both end the whole function, so
  // nothing downstream would notice this rule going missing.
  const pas = { prototypes: { f: { returnsVoid: true } }, backend: pascalBackend };
  expect(() => decompile('f', pasTable(true), ARMV4T_AGBCC, pas)).toThrow(/no fall-through in its case statement/);
  // CONTROLS: every arm of the closed table prints for that backend, and the SAME falling assembly
  // recovers the falling switch for C.
  expect(decompile('f', pasTable(false), ARMV4T_AGBCC, pas).source).toContain('case a0 of');
  expect(of(pasTable(true))).toMatch(/case 0:[\s\S]*?\n\s*case 1:/);
});

// ── where the `default:` label may be read off the layout ───────────────────────────────
// `defaultLayoutPos` is the one definition both regimes read, and it states SEVEN withholdings.
// Three of them decide no call the benchmark makes, so they have no row to guard them and are
// pinned here instead — at the seam itself, one call each, beside the four that do.

test('every withholding on the `default:` position, one call each', () => {
  const body = (): Block => ({ params: [], ops: [mkOp('const', { attrs: { value: 0 } }), mkOp('br')] });
  const [a0, a1, dflt, a2] = [body(), body(), body(), body()];
  // Layout: a0, a1, default, a2 — so a default read off the layout sits after TWO arms.
  const deps = {
    fn: { name: 'f', blocks: [a0, a1, dflt, a2], writeOrder: undefined },
    defs: new Map(),
    dom: new Map(),
    ipdom: new Map(),
    opBlock: new Map(),
    isNamed: () => false,
    isCmpOpcode: () => false,
    switchAllowsNeqCase: false,
    switchAllowsBoundCase: false,
    switchArmsFollowLayout: true,
    spellSwitchFallthrough: true,
    emitsOwnStatement: () => false,
    blockOf: () => undefined,
    hoistDispatchCopies: () => [],
    expr: () => ZERO,
    structureRegion: () => [],
  };
  const rec = makeSwitchRecovery(deps);
  const arms = (falls: number) => [a0, a1, a2].map((entry, i) => ({ entry, fallsThrough: i === falls }));
  const intact = { placedByDispatch: false, orderIntact: true };
  expect(rec.defaultLayoutPos(dflt, arms(-1), intact)).toBe(2);
  // The four that decide the tier's calls. A bare exit is a block the dispatch minted rather than
  // an arm body, and is the one that decides most of them.
  expect(rec.defaultLayoutPos({ params: [], ops: [mkOp('br')] }, arms(-1), intact)).toBeUndefined();
  expect(
    makeSwitchRecovery({ ...deps, switchArmsFollowLayout: false }).defaultLayoutPos(dflt, arms(-1), intact),
  ).toBeUndefined();
  expect(rec.defaultLayoutPos(dflt, arms(-1), { ...intact, placedByDispatch: true })).toBeUndefined();
  expect(rec.defaultLayoutPos(dflt, arms(2), intact)).toBeUndefined(); // the LAST arm falls
  // …and the three that decide none of them: a default the walk also read as an arm (which never
  // even co-occurs), a re-threaded order, and a position landing after a falling arm.
  expect(rec.defaultLayoutPos(dflt, [...arms(-1), { entry: dflt, fallsThrough: false }], intact)).toBeUndefined();
  expect(rec.defaultLayoutPos(dflt, arms(-1), { ...intact, orderIntact: false })).toBeUndefined();
  expect(rec.defaultLayoutPos(dflt, arms(1), intact)).toBeUndefined(); // the label would land after a1
});
