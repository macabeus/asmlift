// agbcc Thumb jump-table (Regime B) recovery — the frontend collapses a bounds guard plus a
// `mov pc, rV` dispatch into one `switch_br`. Nothing covered it before; these pin the two bounds
// spellings, the pool addressing, the SSA invariant a shared case body depends on, and — the
// point of the file — that every near-miss shape still DECLINES rather than dispatching somewhere
// plausible. A jump table recovered wrong is not a wrong expression, it is a wrong BLOCK: the
// output looks entirely ordinary and runs the wrong code.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

// The dispatch idiom, shared by every case below: bounds guard → `lsl #2` → pool load of the table
// pointer → indexed load → `mov pc`. `ptr` is the operand of the pointer load, `bounds` the guard.
const fn = (bounds: string, ptr: string, pool: string) =>
  `f:\n${bounds}` +
  `\tlsl\tr0, r1, #0x2\n\tldr\tr1, ${ptr}\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n` +
  `.Lc0:\n\tmov\tr0, #10\n\tbx\tlr\n.Lc1:\n\tmov\tr0, #11\n\tbx\tlr\n.Ldef:\n\tmov\tr0, #99\n\tbx\tlr\n` +
  pool;
const TABLE = '.Ltab:\n\t.word\t.Lc0\n\t.word\t.Lc1\n';
const DIRECT = '\tcmp\tr1, #0x1\n\tbhi\t.Ldef\n';
const LONGJMP = '\tcmp\tr1, #0x1\n\tbls\t.LCB\n\tb\t.Ldef\t@long jump\n.LCB:\n';

const src = (bounds: string, ptr: string, pool: string) => decompile('f', fn(bounds, ptr, pool), ARMV4T_AGBCC).source;
const fails = (bounds: string, ptr: string, pool: string) => () => decompile('f', fn(bounds, ptr, pool), ARMV4T_AGBCC);

test('the DIRECT bounds form (`cmp; bhi DEF`) recovers a switch', () => {
  const out = src(DIRECT, '.Lp', `.Lp:\n\t.word\t.Ltab\n${TABLE}`);
  expect(out).toContain('switch (a0)');
  expect(out).toContain('case 0:');
  expect(out).toContain('case 1:');
});

test('the LONG-JUMP bounds form (`cmp; bls DISP; b DEF`) recovers the same switch', () => {
  // agbcc's spelling whenever the default is out of a conditional branch's ±256-byte reach, which
  // on a real switch it usually is — five of the six benchmark functions with a table use it.
  const out = src(LONGJMP, '.Lp', `.Lp:\n\t.word\t.Ltab\n${TABLE}`);
  expect(out).toContain('switch (a0)');
  expect(out).toContain('case 1:');
  expect(out).toContain('99'); // the long-branched default is still the default arm
});

test('the table pointer is read at ANY pool offset, not just a bare label', () => {
  // A literal pool is a POOL: the dispatch pointer sits wherever emission order put it.
  const pool = `.Lp:\n\t.word\tgOther\n\t.word\t.Ltab\n${TABLE}`;
  expect(src(DIRECT, '.Lp+0x4', pool)).toContain('switch (a0)');
  // …and the slot must actually hold the table: slot 0 here is an unrelated global.
  expect(fails(DIRECT, '.Lp', pool)).toThrow(/indirect\/computed jump/);
});

test('two case values sharing one body lift cleanly (the switch_br block-arg invariant)', () => {
  // Both cases target .Lc0, so the switch_br has two edges to one block. Block args belong to the
  // EDGE; getting that wrong made the verifier reject the function ("passes N args to a block with
  // M params"), which is how this shape used to be unliftable rather than wrong.
  const shared = '.Ltab:\n\t.word\t.Lc0\n\t.word\t.Lc0\n';
  const out = src(DIRECT, '.Lp', `.Lp:\n\t.word\t.Ltab\n${shared}`);
  expect(out).toContain('switch (a0)');
  expect(out).not.toContain('ASMLIFT_ERROR');
  // ONE arm carrying both labels — not the body emitted twice.
  expect(out).toMatch(/case 0:\s*\n\s*case 1:/);
  expect(out.match(/return 10;/g)).toHaveLength(1);
});

// ── arms that are not disjoint: shared bodies, fall-through, and the shapes C cannot spell ────────
// A jump table's arms may overlap in ways an if-tree never does, and `SwitchCase` has always been
// able to say so (`values` stacks labels, `fallsThrough` drops the `break`). These pin WHICH
// overlaps are recovered and which still decline — the boundary is "spellable in C without a goto".

// A switch whose arms converge on a common tail rather than returning: the default target IS that
// tail (agbcc's ordinary "the default just leaves the switch"), so the tail is BOTH the merge and
// the default block. `arms` are the case bodies in table order, `tail` the shared exit.
const conv = (arms: string[], tail = '.Lend:\n\tbx\tlr\n') =>
  `f:\n\tcmp\tr1, #0x${(arms.length - 1).toString(16)}\n\tbhi\t.Lend\n` +
  `\tlsl\tr0, r1, #0x2\n\tldr\tr1, .Lp\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n` +
  `.Lp:\n\t.word\t.Ltab\n.Ltab:\n${arms.map((_, i) => `\t.word\t.Lc${i}\n`).join('')}` +
  arms.map((a, i) => `.Lc${i}:\n${a}`).join('') +
  tail;
const convSrc = (arms: string[]) => decompile('f', conv(arms), ARMV4T_AGBCC).source;
const CALL_A = '\tbl\tsideA\n', // an arm body with a visible side effect
  LEAVE = '\tb\t.Lend\n';

test('a switch whose default is just the end of the switch is not a fall-through', () => {
  // The default target and the merge are the SAME block here. Reading "an arm reaches the default
  // block" as fall-through would decline every ordinary agbcc switch that simply leaves.
  const out = convSrc([CALL_A + LEAVE, '\tbl\tsideB\n' + LEAVE]);
  expect(out).not.toContain('ASMLIFT_ERROR');
  expect(out).toContain('switch (');
  expect(out).toContain('sideA();');
  expect(out).toContain('sideB();');
  // …and its default arm is not emitted at all: an unmatched scrutinee already leaves the switch,
  // so the label would carry no statement — which C89 does not allow.
  expect(out).not.toContain('default:');
  // control: a default with a body of its own still gets its label (the DIRECT fixture above).
  expect(src(DIRECT, '.Lp', `.Lp:\n\t.word\t.Ltab\n${TABLE}`)).toContain('default:');
});

test('an arm that runs into the NEXT arm is recovered as C fall-through', () => {
  // .Lc0 has no terminator of its own: control drops into .Lc1. That is `case 0:` with no `break;`,
  // and it is the only shape of overlap C spells natively.
  const out = convSrc([CALL_A, '\tbl\tsideB\n' + LEAVE]);
  expect(out).not.toContain('ASMLIFT_ERROR');
  // case 0 runs sideA and does NOT break before case 1
  expect(out).toMatch(/case 0:\s*\n\s*a0 = sideA\(\);\s*\n\s*case 1:/);
  // …and the body it falls into is emitted ONCE, under case 1.
  expect(out.match(/sideB\(/g)).toHaveLength(1);
});

test('a fall-through that would carry an effect out of a loop DECLINES', () => {
  // The exit copies of a do-while render AFTER it, while the analysis decided where their values
  // may inline as if they sat on the latch's terminator — inside the loop. An arm ending in a loop
  // whose result is only read by the next arm therefore came out as `do { i = i - 1; } while (…);
  // a0 = sideA();` — the call once instead of once per iteration, in C that looks entirely
  // ordinary. Loud beats plausible.
  const loop = '\tmov\tr4, #3\n.Llp:\n\tbl\tsideA\n\tsub\tr4, #1\n\tcmp\tr4, #0\n\tbne\t.Llp\n';
  expect(() => decompile('f', conv([loop, '\tbl\tsideB\n' + LEAVE]), ARMV4T_AGBCC)).toThrow(
    /inlines a 'call' from inside the loop/,
  );
  // control: the SAME loop in a closed arm keeps the call inside the loop and recovers.
  const closed = convSrc([loop + LEAVE, '\tbl\tsideB\n' + LEAVE]);
  expect(closed).toMatch(/do \{\s*\n\s*v0 = sideA\(\);/);
});

test('overlaps C cannot spell DECLINE instead of being silently closed or duplicated', () => {
  // Emitting these as ordinary `break` arms would drop a real control-flow edge — the output would
  // look entirely normal and run the wrong code, which is the whole hazard of a recovered table.
  // The shared tail CALLS here: a bare `bx lr` tail is duplicated into the arms as a `return`, which
  // legitimately removes the second exit — these fixtures need the exit to survive as an edge.
  const tail = '.Lend:\n\tbl\tsideZ\n\tbx\tlr\n';
  const sw = (arms: string[]) => () => decompile('f', conv(arms, tail), ARMV4T_AGBCC);
  const fallsTo = (n: number) => `\tb\t.Lc${n}\n`;
  const armB = '\tbl\tsideB\n' + LEAVE,
    armC = '\tbl\tsideC\n' + LEAVE;
  // (a) falls into a case that is not the next one emitted: C fall-through can only reach the
  // following case, and reordering the arms would change which values reach which body.
  expect(sw([CALL_A + fallsTo(2), armB, armC])).toThrow(/falls through into a case that is not the next one/);
  // (b) reaches a sibling on one path and leaves the switch on another — that is a goto, not a
  // fall-through: only SOME executions of case 0 continue into case 1.
  expect(sw(['\tcmp\tr2, #0\n\tbeq\t.Lc1\n' + CALL_A + LEAVE, armB])).toThrow(
    /reaches sibling case .* on one path and leaves the switch on another/,
  );
  // (c) reaches two different siblings.
  expect(sw(['\tcmp\tr2, #0\n\tbeq\t.Lc1\n' + fallsTo(2), armB, armC])).toThrow(/reaches several sibling cases/);
});

test('near-miss dispatches DECLINE — a mis-recovered table runs the wrong block', () => {
  const pool = `.Lp:\n\t.word\t.Ltab\n${TABLE}`;
  const jump = /indirect\/computed jump/;
  // table length must equal the bound: `cmp #2` means three cases, the table has two
  expect(fails('\tcmp\tr1, #0x2\n\tbhi\t.Ldef\n', '.Lp', pool)).toThrow(jump);
  // the guard must be an UNSIGNED upper bound — a signed one admits a negative index
  expect(fails('\tcmp\tr1, #0x1\n\tbgt\t.Ldef\n', '.Lp', pool)).toThrow(jump);
  // the index must be the bounds-checked register, scaled only by <<2
  expect(fails('\tcmp\tr2, #0x1\n\tbhi\t.Ldef\n', '.Lp', pool)).toThrow(jump);
  // a pool offset that is not a whole word, or past the end of the pool
  expect(fails(DIRECT, '.Lp+0x2', pool)).toThrow(jump);
  expect(fails(DIRECT, '.Lp+0x40', pool)).toThrow(jump);
  // the long-jump form's `bls` must name THIS dispatch block
  expect(fails('\tcmp\tr1, #0x1\n\tbls\t.Ldef\n\tb\t.Ldef\t@long jump\n.LCB:\n', '.Lp', pool)).toThrow(jump);
});

test('a branch to a DATA label declines — it is not an alias for the code after the pool', () => {
  // Decode starts an empty block at a literal-pool label too. Treating every empty block as an
  // alias for the next code block would silently retarget `beq .Lpool` at whatever follows the
  // pool: marker-free, plausible, and running the wrong code.
  const toData =
    'f:\n\tcmp\tr0, #0\n\tbeq\t.Lpool\n\tmov\tr0, #1\n\tbx\tlr\n.Lpool:\n\t.word\tgFoo\n.Lafter:\n\tmov\tr0, #2\n\tbx\tlr\n';
  expect(() => decompile('f', toData, ARMV4T_AGBCC)).toThrow(/not a code block in this function/);
});

test('two labels on ONE instruction are aliases — a branch to either reaches the code', () => {
  // agbcc drops a long-jump helper label straight onto an existing one. `.LCB80` and `.L7` name the
  // same address, so lifting must be INDIFFERENT to which one the branch names — asserted against
  // the un-aliased control rather than against a spelling, which is the property that matters.
  const body = (target: string, labels: string) =>
    `f:\n\tcmp\tr0, #0\n\tbeq\t${target}\n\tmov\tr0, #1\n\tbx\tlr\n${labels}\tmov\tr0, #2\n\tbx\tlr\n`;
  const control = decompile('f', body('.L7', '.L7:\n'), ARMV4T_AGBCC).source;
  expect(decompile('f', body('.LCB80', '.LCB80:\n.L7:\n'), ARMV4T_AGBCC).source).toBe(control);
  expect(control).toContain('return 2;'); // the branch target's body is reached, not skipped
});
