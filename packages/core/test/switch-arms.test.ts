// Regime-A switch recovery — what decides whether a four-way agbcc dispatch comes back as ONE
// `switch`. The fact underneath is gcc 2.9-arm's own `stmt.c`: `expand_end_case` builds the
// dispatch with `balance_case_nodes`/`emit_case_nodes` (a comparison TREE, not a jump table, for
// a dense 0..3 switch) and gives every subtree that runs out of case values its OWN jump to the
// default — so a four-case tree reaches the default through two `b .Ldefault` blocks.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC } from '../src/target';

// agbcc's own output for `switch (mode) { case 0..3 }` with the arms in `order`, reduced to the
// shape that matters: the balanced comparison tree, four one-instruction bodies, a merge that
// takes the result as a block parameter, and — the point — TWO jumps to the fall-out.
// `out` is where a subtree that runs out of case values jumps: `.Lend` (the merge — the source
// wrote no `default:`) or `.Ldef` (a real default arm, emitted by `tail`).
const dispatch = (order: readonly number[], out = '.Lend', tail = '') =>
  'f:\n\tmov\tr2, #0x0\n' +
  '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
  '\tcmp\tr0, #0x1\n\tbgt\t.Lhi\t@cond_branch\n' +
  '\tcmp\tr0, #0\n\tbeq\t.Lc0\t@cond_branch\n' +
  `\tb\t${out}\n` + // fall-out #1
  '.Lhi:\n\tcmp\tr0, #0x2\n\tbeq\t.Lc2\t@cond_branch\n' +
  '\tcmp\tr0, #0x3\n\tbeq\t.Lc3\t@cond_branch\n' +
  `\tb\t${out}\n` + // fall-out #2 — a SECOND block jumping to the same place
  order.map((k) => `.Lc${k}:\n\tadd\tr2, r1, #0x${k + 1}\n\tb\t.Lend\n`).join('') +
  tail +
  '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n';

const of = (asm: string) => decompile('f', asm, ARMV4T_AGBCC, { prototypes: { f: { returnsVoid: true } } }).source;
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
  // The collapse claims only that a BARE jump has no body to differ in. Give the second leaf a
  // different value for the merge's parameter and the two are genuinely different defaults —
  // recovery must go back to if-nesting rather than pick one and drop the other's write.
  const out = of(dispatch([0, 1, 2, 3]).replace(/\tb\t\.Lend\n(?=\.Lc0:)/, '\tmov\tr2, #0x9\n\tb\t.Lend\n'));
  expect(out).toContain('else'); // declined to if-recovery
  expect(out).toContain('9'); // …and the second leaf's write survives
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
