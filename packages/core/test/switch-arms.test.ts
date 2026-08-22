// Regime-A switch recovery — what decides whether a four-way agbcc dispatch comes back as ONE
// `switch`. The fact underneath is gcc 2.9-arm's own `stmt.c`: `expand_end_case` builds the
// dispatch with `balance_case_nodes`/`emit_case_nodes` (a comparison TREE, not a jump table, for
// a dense 0..3 switch) and gives every subtree that runs out of case values its OWN jump to the
// default — so a four-case tree reaches the default through two `b .Ldefault` blocks.
import { expect, test } from 'vitest';

import { emitCFamily } from '../src/backend/cfamily';
import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC } from '../src/target';

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
  // The collapse claims only that a BARE jump has no body to differ in. Give the HIGH leaf a
  // different value for the merge's parameter and the two are genuinely different defaults —
  // recovery must go back to if-nesting rather than pick one and give the other's path its value.
  const out = of(dispatch([0, 1, 2, 3]).replace(/\tb\t\.Lend\n(?=\.Lc0:)/, '\tmov\tr2, #0x9\n\tb\t.Lend\n'));
  expect(out).toContain('else'); // declined to if-recovery
  expect(out).toMatch(/default:\s+v0 = 9;/); // the high leaf's own write…
  expect(out).toMatch(/else \{\s+v0 = 0;/); // …and the low leaf's, which the collapse would overwrite with 9
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
  expect(out).toMatch(/else \{\s+v0 = 9;/); // 9 stays on the path that writes it
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
  // third, which is this fixture. Emitting the label last instead moves every instruction after it
  // — recompiling the layout spelling with agbcc reproduces the target exactly, the last spelling
  // differs by 6 instructions. A default that is not last needs a `break;` of its own, or control
  // would drop into the case below it.
  const out = of(dispatch([0, 1, 'D', 2, 3], '.Ldef'));
  expect(out).toMatch(/case 1:\s+v0 = a1 \+ 2;\s+break;\s+default:\s+v0 = 99;\s+break;\s+case 2:/);
  expect(armOrder(out)).toEqual([0, 1, 2, 3]);
});

test('a default the dispatch FALLS INTO keeps the last position', () => {
  // Scope. `emit_case_nodes` reaches the default by a jump from each exhausted subtree, but when
  // the tests simply run out the fall-through block IS the default's first block — placed there by
  // the dispatch, not by the arm. agbcc emits exactly this for a two-case switch, and it emits it
  // whether the source wrote `default:` first or last (both compile to the same instructions), so
  // the layout is no evidence at all. Recovery keeps C's conventional last position.
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
});

// ── Regime B: the jump table ─────────────────────────────────────────────────────────────────────
// agbcc's own output for a 5-arm dense switch whose source wrote the arms 3, 0, 4, 1, 2 with a
// `default:` last. The TABLE's slots are ascending by construction (slot i is case i), so grouping
// them in table order spells the arms 0..4 — while the bodies are laid out in the order the arms
// were written, exactly as in the comparison tree above. Recompiling the layout spelling with agbcc
// reproduces the target; the ascending spelling differs by 10 to 26 instructions depending on the
// permutation.
const table = (tail = '\tb\t.L3\n') =>
  'f:\n\tadd\tr2, r1, #0\n' +
  '\tcmp\tr0, #0x4\n\tbhi\t.L9\t@cond_branch\n' +
  '\tlsl\tr0, r0, #0x2\n\tldr\tr1, .L11\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n' +
  '.L12:\n\t.align\t2, 0\n.L11:\n\t.word\t.L10\n\t.align\t2, 0\n' +
  '.L10:\n\t.word\t.L5\n\t.word\t.L7\n\t.word\t.L8\n\t.word\t.L4\n\t.word\t.L6\n' + // cases 0..4
  `.L4:\n\tadd\tr1, r2, #0x4\n${tail}` + // case 3 — written FIRST, so laid out first
  '.L5:\n\tadd\tr1, r2, #0x1\n\tb\t.L3\n' + // case 0
  '.L6:\n\tadd\tr1, r2, #0x5\n\tb\t.L3\n' + // case 4
  '.L7:\n\tadd\tr1, r2, #0x2\n\tb\t.L3\n' + // case 1
  '.L8:\n\tadd\tr1, r2, #0x3\n\tb\t.L3\n' + // case 2
  '.L9:\n\tmov\tr1, #0x63\n' + // the default
  '.L3:\n\tmov\tr0, #0x80\n\tlsl\tr0, r0, #0x13\n\tstr\tr1, [r0]\n\tbx\tlr\n';

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

test('a jump-table arm that FALLS THROUGH is not reordered', () => {
  // Regime B's emission order is load-bearing where Regime A's is not: a falling arm must be
  // emitted directly above the one it falls into (the l3/ast.ts note), so its position is not free.
  // Drop case 3's `b .L3` and it falls into case 0 — which layout order would put next, but that is
  // the reordering this refuses. Table order keeps case 3 next to case 4, so the shape declines
  // LOUD instead. Recovering it is a separate capability with its own evidence to gather.
  expect(() => of(table(''))).toThrow(/falls through into an arm that is not the next one emitted/);
});
