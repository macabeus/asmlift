// Regime-A switch recovery — what decides whether a four-way agbcc dispatch comes back as ONE
// `switch`. The fact underneath is gcc 2.9-arm's own `stmt.c`: `expand_end_case` builds the
// dispatch with `balance_case_nodes`/`emit_case_nodes` (a comparison TREE, not a jump table, for
// a dense 0..3 switch) and gives every subtree that runs out of case values its OWN jump to the
// default — so a four-case tree reaches the default through two `b .Ldefault` blocks.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { emitCFamily } from '../src/backend/cfamily';
import { frontendFor } from '../src/frontend/registry';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { stmtChildren } from '../src/l3/ast';
import type { SFn, Stmt } from '../src/l3/ast';
import { applyIdiomPatterns, decompile, raiseRecovered } from '../src/pipeline';
import { structure } from '../src/structure/structure';
import type { StructureOptions } from '../src/structure/structure';
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

test('a default entry the DISPATCH hands a value to still declines, and keeps the write', () => {
  // The other refusal in the same neighbourhood, pinned. Here `bne` branches straight to the
  // merge, so the default entry is a block with a PARAMETER and the edge into it carries `w = 0`.
  // Collapsing the tree discards that edge, and an edge's only emission is its copy — so a
  // `switch` with no default would drop the write and look entirely ordinary doing it. Recovery
  // declines to if-nesting, which spells every copy the assembly performs.
  //
  // Structural on purpose, not "would this copy elide anyway": it costs nothing, because agbcc
  // reaches its default through a jump of its own (the collapsed `b .Ldefault` blocks above),
  // which carries the copies into the default ARM instead of onto a dispatch branch.
  const out = of(
    'f:\n\tmov\tr2, #0x0\n' +
      '\tcmp\tr0, #0x1\n\tbeq\t.Lc1\t@cond_branch\n' +
      '\tcmp\tr0, #0x2\n\tbne\t.Lend\t@cond_branch\n' +
      '.Lc2:\n\tadd\tr2, r1, #0x2\n\tb\t.Lend\n' +
      '.Lc1:\n\tadd\tr2, r1, #0x1\n' +
      '.Lend:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr2, [r0]\n\tbx\tlr\n',
  );
  expect(out).not.toContain('switch');
  expect(out).toContain('v0 = 0;'); // the write the discarded edge carried
  expect(out).toContain('v0 = a1 + 2;');
});

test('two case values sharing ONE body have the same layout index, and stay in value order', () => {
  // Two case values branching to the same label share a layout index, so layout cannot order those
  // two — the one thing the ordering rule cannot read off the assembly. Ascending value is the
  // declared tie-break, so they keep the spelling they already had instead of inheriting whichever
  // the tree walk reached first. The dispatch below tests 3 BEFORE 2 for exactly that reason: the
  // walk records 3 first, so a sort without the tie-break returns [3, 2, 1, 0] and only the
  // tie-break puts them back in value order. (That Regime A emits the shared body once per label
  // rather than stacking the labels as the jump-table path does is older than this and untouched.)
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
const table = (tail = '\tb\t.L3\n', defaultAfter = 5) => {
  const bodies = [
    `.L4:\n\tadd\tr1, r2, #0x4\n${tail}`, // case 3 — written FIRST, so laid out first
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

test('a jump-table arm that FALLS THROUGH is not reordered', () => {
  // Regime B's emission order is load-bearing where Regime A's is not: a falling arm must be
  // emitted directly above the one it falls into (the l3/ast.ts note), so its position is not free.
  // Drop case 3's `b .L3` and it falls into case 0 — which layout order would put next, but that is
  // the reordering this refuses. Table order keeps case 3 next to case 4, so the shape declines
  // LOUD instead. Recovering it is a separate capability with its own evidence to gather.
  expect(() => of(table(''))).toThrow(/falls through into an arm that is not the next one emitted/);
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
  expect(out).toContain('a0 > 0');
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
  expect(out).toContain('a0 < 1');
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
  expect(out).toContain('if (a0 == 1)'); // the block holding it is no longer a test of the tree
});

test('the same tree recovers whole when nothing homes in the test block', () => {
  // Control: `/expr-home` off, so `a1 << 2` re-renders at its two uses and the test block is pure.
  const out = homed(homeInTest, {});
  expect(out).toContain('switch (a0)');
  expect(armOrder(out)).toEqual([5, 1, 2]);
  expect(count(out, 'a1 << 2')).toBe(2);
});
