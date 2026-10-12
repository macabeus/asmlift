// agbcc Thumb jump-table (Regime B) recovery — the frontend collapses a bounds guard plus a
// `mov pc, rV` dispatch into one `switch_br`. Nothing covered it before; these pin the two bounds
// spellings, the pool addressing, the SSA invariant a shared case body depends on, and — the
// point of the file — that every near-miss shape still DECLINES rather than dispatching somewhere
// plausible. A jump table recovered wrong is not a wrong expression, it is a wrong BLOCK: the
// output looks entirely ordinary and runs the wrong code.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';
import { count } from './helpers';

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
  expect(out).toContain('switch (a1)');
  expect(out).toContain('case 0:');
  expect(out).toContain('case 1:');
});

test('the LONG-JUMP bounds form (`cmp; bls DISP; b DEF`) recovers the same switch', () => {
  // agbcc's spelling whenever the default is out of a conditional branch's ±256-byte reach, which
  // on a real switch it usually is — five of the six benchmark functions with a table use it.
  const out = src(LONGJMP, '.Lp', `.Lp:\n\t.word\t.Ltab\n${TABLE}`);
  expect(out).toContain('switch (a1)');
  expect(out).toContain('case 1:');
  expect(out).toContain('99'); // the long-branched default is still the default arm
});

test('the table pointer is read at ANY pool offset, not just a bare label', () => {
  // A literal pool is a POOL: the dispatch pointer sits wherever emission order put it.
  const pool = `.Lp:\n\t.word\tgOther\n\t.word\t.Ltab\n${TABLE}`;
  expect(src(DIRECT, '.Lp+0x4', pool)).toContain('switch (a1)');
  // …and the slot must actually hold the table: slot 0 here is an unrelated global.
  expect(fails(DIRECT, '.Lp', pool)).toThrow(/indirect\/computed jump/);
});

test('two case values sharing one body lift cleanly (the switch_br block-arg invariant)', () => {
  // Both cases target .Lc0, so the switch_br has two edges to one block. Block args belong to the
  // EDGE; getting that wrong made the verifier reject the function ("passes N args to a block with
  // M params"), which is how this shape used to be unliftable rather than wrong.
  const shared = '.Ltab:\n\t.word\t.Lc0\n\t.word\t.Lc0\n';
  const out = src(DIRECT, '.Lp', `.Lp:\n\t.word\t.Ltab\n${shared}`);
  expect(out).toContain('switch (a1)');
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

test('falling into an arm that takes a value from the switch edge DECLINES', () => {
  // The arm fallen into opens with the copies that hand it its block parameters from the DISPATCH.
  // On the fall-through path those would re-run and overwrite what the falling arm just computed:
  // `case 0: v = 7; case 1: v = 5; sideB(v);` calls sideB(5) where the asm calls sideB(7) — ordinary
  // looking C running the wrong value. Dropping the copies is equally wrong (entering by case 1's
  // own value needs them), so this shape is refused rather than guessed.
  const asm =
    'f:\n\tmov\tr2, #0x5\n\tcmp\tr1, #0x1\n\tbhi\t.Lend\n\tlsl\tr0, r1, #0x2\n\tldr\tr3, .Lp\n\tadd\tr0, r0, r3\n' +
    '\tldr\tr0, [r0]\n\tmov\tpc, r0\n.Lp:\n\t.word\t.Ltab\n.Ltab:\n\t.word\t.Lc0\n\t.word\t.Lc1\n' +
    '.Lc0:\n\tmov\tr2, #0x7\n.Lc1:\n\tmov\tr0, r2\n\tbl\tsideB\n\tb\t.Lend\n.Lend:\n\tbx\tlr\n';
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(/takes a value from the switch edge/);
});

test('the LAST case may fall into a default that has a body — C emits the default last', () => {
  // `default:` is the arm below the last case, so falling into it is ordinary C, not a goto.
  const withDefault = (arms: string[], def: string) =>
    `f:\n\tcmp\tr1, #0x${(arms.length - 1).toString(16)}\n\tbhi\t.Ldef\n` +
    `\tlsl\tr0, r1, #0x2\n\tldr\tr1, .Lp\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n` +
    `.Lp:\n\t.word\t.Ltab\n.Ltab:\n${arms.map((_, i) => `\t.word\t.Lc${i}\n`).join('')}` +
    arms.map((a, i) => `.Lc${i}:\n${a}`).join('') +
    `.Ldef:\n${def}.Lend:\n\tbl\tsideZ\n\tbx\tlr\n`;
  const out = decompile(
    'f',
    withDefault([CALL_A + LEAVE, '\tbl\tsideB\n'], '\tbl\tsideD\n' + LEAVE),
    ARMV4T_AGBCC,
  ).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  expect(out).toMatch(/case 1:\s*\n\s*a0 = sideB\(\);\s*\n\s*default:/);
});

test('a fall-through that would carry an effect out of a loop DECLINES', () => {
  // The exit copies of a do-while render AFTER it, while the analysis decided where their values
  // may inline as if they sat on the latch's terminator — inside the loop. An arm ending in a loop
  // whose result is only read by the next arm therefore came out as `do { i = i - 1; } while (…);
  // a0 = sideA();` — the call once instead of once per iteration, in C that looks entirely
  // ordinary. Loud beats plausible.
  //
  // A CALL no longer reaches it: structure/analysis.ts materializes any call whose value rides a
  // `cond_br` edge, which pins it at the position the asm ran it, so this shape now RECOVERS —
  // with `sideA()` inside the loop, which is what the asm does. What still reaches the decline is
  // an `opaque`, the other member of `REPEATED_EFFECT`, for which no such rule exists.
  const loop = (body: string) => `\tmov\tr4, #3\n.Llp:\n${body}\tsub\tr4, #1\n\tcmp\tr4, #0\n\tbne\t.Llp\n`;
  const recovered = convSrc([loop('\tbl\tsideA\n'), '\tbl\tsideB\n' + LEAVE]);
  expect(recovered).toMatch(/do \{\s*\n\s*v0 = sideA\(\);/);
  expect(recovered.match(/sideA\(/g)).toHaveLength(1);
  expect(() => decompile('f', conv([loop('\tmrs\tr0, cpsr\n'), '\tbl\tsideB\n' + LEAVE]), ARMV4T_AGBCC)).toThrow(
    /inlines a 'opaque' from inside the loop/,
  );
  // control: the SAME loop in a closed arm keeps the call inside the loop and recovers.
  const closed = convSrc([loop('\tbl\tsideA\n') + LEAVE, '\tbl\tsideB\n' + LEAVE]);
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
  // (b) reaches a sibling on one path and the switch's end on another. C CAN spell this — with a
  // switch-scoped `break` in the case body — so the decline names asmlift's own missing piece
  // rather than blaming C.
  expect(sw(['\tcmp\tr2, #0\n\tbeq\t.Lc1\n' + CALL_A + LEAVE, armB])).toThrow(
    /a switch-scoped `break` inside a case body is not emitted yet/,
  );
  // (c) reaches two different siblings.
  expect(sw(['\tcmp\tr2, #0\n\tbeq\t.Lc1\n' + fallsTo(2), armB, armC])).toThrow(/reaches several sibling cases/);
});

test('an arm falling into a case the table does not put next is CHAINED, not declined', () => {
  // Case 0 jumps into case 2. A `case` LABEL carries its own value, so moving an arm changes
  // nothing about which value reaches which body — only fall-through makes a position mean
  // anything, and `chainArms` is what makes the position follow the exit. So the emitted order is
  // 0, 2, 1: the chain, then the arm it displaced, each still under its own label.
  const tail = '.Lend:\n\tbl\tsideZ\n\tbx\tlr\n';
  const out = decompile(
    'f',
    conv([CALL_A + '\tb\t.Lc2\n', '\tbl\tsideB\n' + LEAVE, '\tbl\tsideC\n' + LEAVE], tail),
    ARMV4T_AGBCC,
  ).source;
  expect([...out.matchAll(/case (\d+):/g)].map((m) => Number(m[1]))).toEqual([0, 2, 1]);
  expect(out).toMatch(/case 0:[\s\S]*?\n\s*case 2:/); // no `break;` between them
  expect(out.match(/sideC\(/g)).toHaveLength(1); // emitted once, not duplicated into case 0
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

// ── Regime A (comparison trees) ───────────────────────────────────────────────────────────────────
test('a comparison tree whose default is the merge recovers as a switch, not an if-chain', () => {
  // Regime A shares the arm analysis. Before it, the merge counted as a fall-through target, so the
  // most ordinary shape of all — every arm just leaving the switch, no default body — was refused
  // and fell back to if-recovery (`if (a0 == 1) … else { if (a0 == 2) … }`). Behaviourally identical,
  // but it is not what the source said.
  const asm =
    'f:\n\tpush\t{lr}\n\tcmp\tr0, #0x1\n\tbeq\t.La\n\tcmp\tr0, #0x2\n\tbeq\t.Lb\n\tcmp\tr0, #0x3\n\tbeq\t.Lc\n' +
    '\tb\t.Lend\n.La:\n\tbl\tsideA\n\tb\t.Lend\n.Lb:\n\tbl\tsideB\n\tb\t.Lend\n.Lc:\n\tbl\tsideC\n' +
    '.Lend:\n\tbl\tsideZ\n\tpop\t{r1}\n\tbx\tr1\n';
  const zero = { params: 0 };
  const out = decompile('f', asm, ARMV4T_AGBCC, {
    prototypes: { f: { returnsVoid: true }, sideA: zero, sideB: zero, sideC: zero, sideZ: zero },
  }).source;
  expect(out).toContain('switch (a0)');
  expect(out).toMatch(/case 1:\s*\n\s*sideA\(\);\s*\n\s*break;/);
  expect(out).not.toContain('else');
  expect(out).not.toContain('default:'); // the default IS the merge — no arm of its own
});

// ── mnemonic and immediate SPELLING ─────────────────────────────────────────────────────────────
// The dispatch idiom was matched by comparing operand TEXT: `lsl` but not `lsls`, `add` but not
// `adds`, and `#2`/`#0x2` but not `#0x02`. Those are spellings of the same instruction and the same
// shift, and a disassembler picks whichever it likes — luvdis writes the UAL forms, and on the
// Klonoa: Empire of Dreams corpus all 13 dispatch sites across 11 jump-table functions spell them
// `lsls`/`adds`, so the comparison alone declined every one of them on perfectly well-formed input.
//
// The property asserted is INDIFFERENCE to the spelling, against the pre-UAL output as the control,
// rather than against a fixed string — the same shape the alias test above uses.
const dispatch = (shift: string, sh: string, plus: string) =>
  `f:\n${DIRECT}` +
  `\t${shift}\tr0, r1, ${sh}\n\tldr\tr1, .Lp\n\t${plus}\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n` +
  `.Lc0:\n\tmov\tr0, #10\n\tbx\tlr\n.Lc1:\n\tmov\tr0, #11\n\tbx\tlr\n.Ldef:\n\tmov\tr0, #99\n\tbx\tlr\n` +
  `.Lp:\n\t.word\t.Ltab\n${TABLE}`;
const spelled = (shift: string, sh: string, plus: string) =>
  decompile('f', dispatch(shift, sh, plus), ARMV4T_AGBCC).source;

test('the UAL spelling (`lsls`/`adds`/`#0x02`) recovers the same switch as the pre-UAL one', () => {
  const control = spelled('lsl', '#0x2', 'add');
  expect(control).toContain('switch (a1)');
  // the whole klonoa spelling at once, then each difference on its own
  expect(spelled('lsls', '#0x02', 'adds')).toBe(control);
  expect(spelled('lsls', '#0x2', 'add')).toBe(control);
  expect(spelled('lsl', '#0x2', 'adds')).toBe(control);
  expect(spelled('lsl', '#0x02', 'add')).toBe(control);
  expect(spelled('lsl', '#2', 'add')).toBe(control);
});

test('a shift that is not by two still DECLINES, whatever it is spelled like', () => {
  // The immediate is now compared as a NUMBER, so the guard must reject the same values it always
  // did — the index has to be scaled by exactly 4, or the table is indexed wrong and the switch
  // dispatches to the wrong block.
  const jump = /indirect\/computed jump/;
  expect(() => spelled('lsl', '#0x3', 'add')).toThrow(jump);
  expect(() => spelled('lsls', '#0x03', 'adds')).toThrow(jump);
  expect(() => spelled('lsl', '#3', 'add')).toThrow(jump);
  expect(() => spelled('lsl', '#0x1', 'add')).toThrow(jump);
  // a register-operand shift has no immediate at all
  expect(() => spelled('lsl', 'r2', 'add')).toThrow(jump);
  // An EXPRESSION whose leading token is 2. gas accepts these and assembles `#2*2` to a shift by
  // FOUR, so reading them as two recovers a switch whose stride is wrong by a factor of four and
  // dispatches to the wrong block, silently. The first cut of this guard used `parseInt`, which
  // stops at the first character it cannot consume, and accepted every one of them; the earlier
  // version of THIS test sampled only the values above and passed while the property was false.
  expect(() => spelled('lsl', '#2*2', 'add')).toThrow(jump);
  expect(() => spelled('lsl', '#2<<1', 'add')).toThrow(jump);
  expect(() => spelled('lsl', '#2+1', 'add')).toThrow(jump);
  expect(() => spelled('lsl', '#2-1', 'add')).toThrow(jump);
  expect(() => spelled('lsl', '#2junk', 'add')).toThrow(jump);
  expect(() => spelled('lsl', '#2.0', 'add')).toThrow(jump);
});

test('the indexed load must address the scaled index EXACTLY — no displacement, no register', () => {
  // `ldr rV, [rA, #4]` loads table[i+1]: the recovered switch would say `case 0` while the
  // hardware reaches case 1's block, and the last case would read a word past the table.
  // `ldr rV, [rA, r2]` adds an unrelated register to the address. Both used to recover an
  // ordinary-looking switch. Pre-existing; found by an adversarial probe, and refused despite the
  // function's header having claimed all along that an "extra offset" declines.
  const jump = /indirect\/computed jump/;
  const withLoad = (ld: string, bounds = DIRECT) =>
    `f:\n${bounds}\tlsl\tr0, r1, #0x2\n\tldr\tr1, .Lp\n\tadd\tr0, r0, r1\n\t${ld}\n\tmov\tpc, r0\n` +
    `.Lc0:\n\tmov\tr0, #10\n\tbx\tlr\n.Lc1:\n\tmov\tr0, #11\n\tbx\tlr\n.Ldef:\n\tmov\tr0, #99\n\tbx\tlr\n` +
    `.Lp:\n\t.word\t.Ltab\n${TABLE}`;
  expect(() => decompile('f', withLoad('ldr\tr0, [r0, #0x4]'), ARMV4T_AGBCC)).toThrow(jump);
  expect(() => decompile('f', withLoad('ldr\tr0, [r0, r2]'), ARMV4T_AGBCC)).toThrow(jump);
  // the long-jump bounds form is the same recogniser and must refuse it too
  expect(() => decompile('f', withLoad('ldr\tr0, [r0, #0x4]', LONGJMP), ARMV4T_AGBCC)).toThrow(jump);
  // ...and `#0`, which is how the corpus spells it, still recovers
  expect(decompile('f', withLoad('ldr\tr0, [r0, #0x00]'), ARMV4T_AGBCC).source).toContain('switch (a1)');
});

test('the two address operands must be DISTINCT registers, not one listed twice', () => {
  // If the pointer load targets the index register, the index is destroyed before it is added:
  // the address is 2*table_base and the scrutinee is dead. Membership alone accepts it, because
  // one register satisfies both tests. Pre-existing; found by an adversarial probe.
  const selfAdd =
    `f:\n${DIRECT}\tlsl\tr0, r1, #0x2\n\tldr\tr0, .Lp\n\tadd\tr0, r0, r0\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n` +
    `.Lc0:\n\tmov\tr0, #10\n\tbx\tlr\n.Lc1:\n\tmov\tr0, #11\n\tbx\tlr\n.Ldef:\n\tmov\tr0, #99\n\tbx\tlr\n` +
    `.Lp:\n\t.word\t.Ltab\n${TABLE}`;
  expect(() => decompile('f', selfAdd, ARMV4T_AGBCC)).toThrow(/indirect\/computed jump/);
});

test('the relaxation covers the two dispatch ops only — `movs pc` still declines', () => {
  // Pinning current behaviour, and labelling it honestly: this is a FALSE decline, not a semantic
  // distinction. `movs pc, r0` assembles to 4687 under `.syntax divided`, byte-identical to
  // `mov pc, r0` (checked with arm-none-eabi-as); `.syntax unified` rejects it outright. So it is
  // the same instruction, and the recogniser refuses it only because it matches that slot by exact
  // name. Tolerated because the refusal is LOUD and the shape has no inhabitant — unified rejects
  // it and every disassembler prints `mov pc` — but `classifyXfer` does accept `movs pc`, so the
  // frontend is internally inconsistent about it. Worth resolving with the follow-up, not by
  // widening a jump-table guard on a shape nothing emits.
  const jump = /indirect\/computed jump/;
  const movs =
    `f:\n${DIRECT}\tlsls\tr0, r1, #0x02\n\tldr\tr1, .Lp\n\tadds\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmovs\tpc, r0\n` +
    `.Lc0:\n\tmov\tr0, #10\n\tbx\tlr\n.Lc1:\n\tmov\tr0, #11\n\tbx\tlr\n.Ldef:\n\tmov\tr0, #99\n\tbx\tlr\n` +
    `.Lp:\n\t.word\t.Ltab\n${TABLE}`;
  expect(() => decompile('f', movs, ARMV4T_AGBCC)).toThrow(jump);
});

// A JUMP TABLE WHOSE ARMS RETURN still has an end. Post-dominance gives the dispatch no join when
// one arm can `return` on its own — EXIT is then the only block on every path — and with a null
// merge the default edge's target joins the arms' sibling set, so every arm's plain `break` reads
// as a fall-through INTO it. Three arms "falling into" one default do not linearize, and Regime B
// has no second recovery, so the whole function declined. `sa3:Sio32MultiLoadMain` is that shape
// and its source contains no fall-through and no `default:` label at all.
//
// `ret` is the shared exit: arms leave by `b .Lend`, and `.Lend` is also the default target, so
// "the default" is just where the switch ends. `early` is the arm body that also returns on its own.
const returningArms = (early: string) =>
  'f:\n\tcmp\tr1, #0x2\n\tbhi\t.Lend\n' +
  '\tlsl\tr0, r1, #0x2\n\tldr\tr1, .Lp\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n' +
  '.Lp:\n\t.word\t.Ltab\n.Ltab:\n\t.word\t.Lc0\n\t.word\t.Lc1\n\t.word\t.Lc2\n' +
  '.Lc0:\n\tbl\tsideA\n\tb\t.Lend\n' +
  `.Lc1:\n${early}` +
  '.Lc2:\n\tbl\tsideC\n\tb\t.Lend\n' +
  '.Lend:\n\tbl\tsideEnd\n\tbx\tlr\n';

// the arm that kills post-dominance: it returns without reaching the shared tail
const EARLY_RETURN = '\tcmp\tr2, #0\n\tbeq\t.Lend\t@cond_branch\n\tbl\tsideB\n\tbx\tlr\n';

test('a jump table whose arms return still has an end', () => {
  const out = decompile('f', returningArms(EARLY_RETURN), ARMV4T_AGBCC).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  expect(out).toContain('switch (');
  // one `break;` per arm — the arms end, they do not run on into anything
  expect(count(out, 'break;')).toBe(3);
  // …and no arm is read as running into the next, which is what the null merge made them
  expect(out).not.toContain('fall');
  // THE TAIL IS EMITTED ONCE, AFTER THE SWITCH. Duplicating it into each arm is the other
  // plausible wrong answer here, and it is a different program only by size — so it is asserted
  // by count, not by absence.
  expect(count(out, 'sideEnd(')).toBe(1);
  expect(out.indexOf('sideEnd(')).toBeGreaterThan(out.lastIndexOf('break;'));
  // the arm's own early `return` survives as one
  expect(count(out, 'sideB();')).toBe(1);
});

// AN ARM THAT RETURNS UNCONDITIONALLY — `case 1: sideB(); return 1;` beside arms that `break` to a
// shared tail. Its `ret` is reached by no other successor, so the every-successor reading above has
// nothing to intersect, the merge falls back to the enclosing stop, and the two `break` arms then
// both "fall into" the default block — which does not linearize, so the function declined.
// `pokeemerald:SaveOnMysteryGiftMenu:agbcc` is that shape, and so is a switch compiled from the same
// C by IDO, KMC, gcc 2.7.2 and mwcc. The default-anchored retry leaves the lone arm out and ends the
// switch where the others meet.
const UNCONDITIONAL_RETURN = '\tbl\tsideB\n\tmov\tr0, #1\n\tbx\tlr\n';

test('a jump-table arm that returns on its own leaves the other arms an end', () => {
  const out = decompile('f', returningArms(UNCONDITIONAL_RETURN), ARMV4T_AGBCC).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  expect(out).toContain('switch (');
  // the two arms that reach the tail end in `break`; the returning arm ends in its own `return`
  expect(count(out, 'break;')).toBe(2);
  expect(out).toMatch(/sideB\([^)]*\);\s*return 1;/);
  // the tail runs once, after the switch, and the returning arm does not reach it
  expect(count(out, 'sideEnd(')).toBe(1);
  expect(out.indexOf('sideEnd(')).toBeGreaterThan(out.lastIndexOf('break;'));
  expect(out.indexOf('sideEnd(')).toBeGreaterThan(out.indexOf('return 1;'));
});

test('an arm that returns on its own does not re-spell a switch the stop reading already spells', () => {
  // The retry is read only where the `stop` reading DECLINES. A real fall-through into the shared
  // tail's default (one arm, so it linearizes) keeps the spelling it had before the retry existed:
  // the arm runs on into the default, which carries the tail.
  const oneFalls = returningArms(UNCONDITIONAL_RETURN).replace(
    '.Lc2:\n\tbl\tsideC\n\tb\t.Lend\n',
    '.Lc2:\n\tbl\tsideC\n\tbx\tlr\n',
  );
  const out = decompile('f', oneFalls, ARMV4T_AGBCC).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  expect(out).toContain('default:');
  expect(count(out, 'sideEnd(')).toBe(1);
});

// THE RETRY IS ANCHORED ON THE DEFAULT EDGE, not on an arm being alone. Both shapes below are agbcc
// `-O2` output (`.s` verbatim from the function label) of C with no `default:` label, so the
// dispatch's default edge goes straight to the code after the switch, and the retry keeps exactly
// the arms that share a `ret` with it. The same C declines on main under IDO, KMC and gcc 2.7.2 too.
//
// `int f(int x,int *p){ switch(x){case 0:p[0]=1;break;case 1:p[1]=2;case 2:p[2]=0;return 1;
//   case 3:p[3]=4;break;case 4:p[4]=5;break;case 5:p[5]=6;break;} return 0; }` — two arms share the
// returning `ret`, so dropping only arms that are alone leaves both in and nothing to intersect.
const FALLS_INTO_RETURN =
  'f:\n\tadd\tr2, r1, #0\n\tcmp\tr0, #0x5\n\tbhi\t.L3\t@cond_branch\n\tlsl\tr0, r0, #0x2\n\tldr\tr1, .L13\n' +
  '\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n.L14:\n\t.align\t2, 0\n.L13:\n\t.word\t.L10\n\t.align\t2, 0\n' +
  '\t.align\t2, 0\n.L10:\n\t.word\t.L4\n\t.word\t.L5\n\t.word\t.L6\n\t.word\t.L7\n\t.word\t.L8\n\t.word\t.L9\n' +
  '.L4:\n\tmov\tr0, #0x1\n\tstr\tr0, [r2]\n\tb\t.L3\n.L5:\n\tmov\tr0, #0x2\n\tstr\tr0, [r2, #0x4]\n' +
  '.L6:\n\tmov\tr0, #0x0\n\tstr\tr0, [r2, #0x8]\n\tmov\tr0, #0x1\n\tb\t.L12\n' +
  '.L7:\n\tmov\tr0, #0x4\n\tstr\tr0, [r2, #0xc]\n\tb\t.L3\n.L8:\n\tmov\tr0, #0x5\n\tstr\tr0, [r2, #0x10]\n\tb\t.L3\n' +
  '.L9:\n\tmov\tr0, #0x6\n\tstr\tr0, [r2, #0x14]\n.L3:\n\tmov\tr0, #0x0\n.L12:\n\tbx\tlr\n';

test('a case that falls into a returning case leaves the other arms an end', () => {
  const out = decompile('f', FALLS_INTO_RETURN, ARMV4T_AGBCC).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  // the source's own fall-through, kept: case 1 runs on into case 2, which returns
  expect(out).toMatch(/case 1:\s*\w+\[1\] = 2;\s*case 2:\s*\w+\[2\] = 0;\s*return 1;/);
  expect(count(out, 'break;')).toBe(4);
  expect(out).not.toContain('default:');
  expect(count(out, 'return 0;')).toBe(1);
  expect(out.indexOf('return 0;')).toBeGreaterThan(out.lastIndexOf('break;'));
});

// `int f(int x,int y,int *p){ int v=y*3; switch(x){case 0: v=y+7; break; case 1: p[1]=0; return 1;
//   … case 4: p[4]=0; return 4;} p[0]=v; return 0; }` — the stop reading LINEARIZES this one (case 0
// alone falls into the default block) and declines later, on the switch-edge copy the fall-through
// would re-run. A retry gated on the chain alone never saw that refusal.
const VALUE_PAST_RETURNS =
  'f:\n\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tadd\tr3, r1, #0\n\tlsl\tr0, r3, #0x1\n\tadd\tr0, r0, r3\n' +
  '\tcmp\tr4, #0x4\n\tbhi\t.L3\t@cond_branch\n\tlsl\tr0, r4, #0x2\n\tldr\tr1, .L12\n\tadd\tr0, r0, r1\n' +
  '\tldr\tr0, [r0]\n\tmov\tpc, r0\n.L13:\n\t.align\t2, 0\n.L12:\n\t.word\t.L9\n\t.align\t2, 0\n\t.align\t2, 0\n' +
  '.L9:\n\t.word\t.L4\n\t.word\t.L5\n\t.word\t.L6\n\t.word\t.L7\n\t.word\t.L8\n' +
  '.L4:\n\tadd\tr0, r3, #0x7\n\tb\t.L3\n' +
  '.L5:\n\tmov\tr0, #0x0\n\tstr\tr0, [r2, #0x4]\n\tmov\tr0, #0x1\n\tb\t.L11\n' +
  '.L6:\n\tmov\tr0, #0x0\n\tstr\tr0, [r2, #0x8]\n\tmov\tr0, #0x2\n\tb\t.L11\n' +
  '.L7:\n\tmov\tr0, #0x0\n\tstr\tr0, [r2, #0xc]\n\tmov\tr0, #0x3\n\tb\t.L11\n' +
  '.L8:\n\tmov\tr0, #0x0\n\tstr\tr0, [r2, #0x10]\n\tmov\tr0, #0x4\n\tb\t.L11\n' +
  '.L3:\n\tstr\tr0, [r2]\n\tmov\tr0, #0x0\n.L11:\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';

test('returning arms beside one arm that carries a value past the switch end the switch past them', () => {
  const out = decompile('f', VALUE_PAST_RETURNS, ARMV4T_AGBCC).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  // case 0 sets the value and breaks; the out-of-range path takes `y * 3` in the default arm
  expect(out).toMatch(/case 0:\s*(\w+) = \w+ \+ 7;\s*break;/);
  expect(out).toMatch(/default:\s*\w+ = \w+ \* 3;/);
  for (const k of [1, 2, 3, 4]) {
    expect(out).toMatch(new RegExp(`case ${k}:\\s*\\w+\\[${k}\\] = 0;\\s*return ${k};`));
  }
  // the store of the carried value runs once, after the switch
  expect(count(out, 'return 0;')).toBe(1);
  expect(out).toMatch(/\}\s*\*\w+ = \w+;\s*return 0;/);
});

test('a retry that does not spell either leaves the stop reading its own decline', () => {
  // agbcc's `case 0: a(); case 1: b(); break; case 2: return 1; …` with `g(x)` after the switch:
  // the retry ends the switch where the `break`s meet, and its case 0 → case 1 fall-through then
  // re-runs a switch-edge copy, which it refuses. Adopting it anyway would only swap the reason
  // the function declines for another one; the decline stays the stop reading's.
  const asm =
    'f:\n\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tcmp\tr4, #0x5\n\tbhi\t.L3\t@cond_branch\n\tlsl\tr0, r4, #0x2\n' +
    '\tldr\tr1, .L13\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n.L14:\n\t.align\t2, 0\n.L13:\n' +
    '\t.word\t.L10\n\t.align\t2, 0\n\t.align\t2, 0\n.L10:\n\t.word\t.L4\n\t.word\t.L5\n\t.word\t.L6\n' +
    '\t.word\t.L7\n\t.word\t.L8\n\t.word\t.L9\n.L4:\n\tbl\ta\n.L5:\n\tbl\tb\n\tb\t.L3\n.L6:\n\tmov\tr0, #0x1\n' +
    '\tb\t.L12\n.L7:\n\tbl\tc\n\tb\t.L3\n.L8:\n\tbl\td\n\tb\t.L3\n.L9:\n\tbl\te\n' +
    '.L3:\n\tadd\tr0, r4, #0\n\tbl\tg\n\tmov\tr0, #0x0\n.L12:\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(/case arms do not linearize/);
});

test('a default arm that returns on its own does not name where the switch ends', () => {
  // KMC's and gcc 2.7.2's output for `switch(x){case 0:p[0]=1;break; … case 5:p[5]=6;break;
  // default: p[9]=7; return 5;} return 0;` (case 2 unlisted), transliterated to Thumb block for
  // block: the range check sets the stored value in its delay slot, so the default arm takes it
  // from the switch edge, and case 2 sets it itself and falls into the default. The default edge's
  // `ret` is the default arm's own `return 5`, and the five `break`s reach `return 0`, laid out
  // past it. Anchoring on the default would end the switch inside the default arm and spell every
  // `break` as `return 0;`, so the stop reading's decline stands.
  const asm =
    'f:\n\tmov\tr3, #0x7\n\tcmp\tr0, #0x5\n\tbhi\t.L9\t@cond_branch\n\tlsl\tr0, r0, #0x2\n\tldr\tr2, .L13\n' +
    '\tadd\tr0, r0, r2\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n.L14:\n\t.align\t2, 0\n.L13:\n\t.word\t.L10\n\t.align\t2, 0\n' +
    '\t.align\t2, 0\n.L10:\n\t.word\t.L3\n\t.word\t.L4\n\t.word\t.L8\n\t.word\t.L5\n\t.word\t.L6\n\t.word\t.L7\n' +
    '.L3:\n\tmov\tr0, #0x1\n\tstr\tr0, [r1]\n\tb\t.L11\n.L4:\n\tmov\tr0, #0x2\n\tstr\tr0, [r1, #0x4]\n\tb\t.L11\n' +
    '.L5:\n\tmov\tr0, #0x4\n\tstr\tr0, [r1, #0xc]\n\tb\t.L11\n.L6:\n\tmov\tr0, #0x5\n\tstr\tr0, [r1, #0x10]\n\tb\t.L11\n' +
    '.L7:\n\tmov\tr0, #0x6\n\tstr\tr0, [r1, #0x14]\n\tb\t.L11\n' +
    '.L8:\n\tmov\tr3, #0x7\n.L9:\n\tstr\tr3, [r1, #0x24]\n\tmov\tr0, #0x5\n\tb\t.L12\n' +
    '.L11:\n\tmov\tr0, #0x0\n.L12:\n\tbx\tlr\n';
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(/takes a value from the switch edge/);
});

test('a default arm that returns on its own does not name the end beside one `break` either', () => {
  // KMC's output for `switch(x){case 0:p[0]=1;break; case 1:p[1]=2;return 1; case 2:p[2]=3;return 2;
  // case 3:p[3]=7;return 5; case 4:p[4]=5;return 4; default: p[3]=7; return 5;} return 0;`,
  // transliterated block for block (case 3 cross-jumped into the default). The graph is the one
  // a value carried past returning arms has (`VALUE_PAST_RETURNS` above); what differs is that
  // case 0's `return 0` is laid out PAST the default's `return 5`, and the code after a switch is
  // laid out after every arm, so the default is not where the switch ends.
  const asm =
    'f:\n\tmov\tr3, #0x7\n\tcmp\tr0, #0x4\n\tbhi\t.L64\t@cond_branch\n\tlsl\tr0, r0, #0x2\n\tldr\tr2, .L13\n' +
    '\tadd\tr0, r0, r2\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n.L14:\n\t.align\t2, 0\n.L13:\n\t.word\t.L10\n\t.align\t2, 0\n' +
    '\t.align\t2, 0\n.L10:\n\t.word\t.L24\n\t.word\t.L30\n\t.word\t.L40\n\t.word\t.L60\n\t.word\t.L50\n' +
    '.L24:\n\tmov\tr0, #0x1\n\tstr\tr0, [r1]\n\tb\t.L70\n' +
    '.L30:\n\tmov\tr0, #0x2\n\tstr\tr0, [r1, #0x4]\n\tmov\tr0, #0x1\n\tb\t.L74\n' +
    '.L40:\n\tmov\tr0, #0x3\n\tstr\tr0, [r1, #0x8]\n\tmov\tr0, #0x2\n\tb\t.L74\n' +
    '.L50:\n\tmov\tr0, #0x5\n\tstr\tr0, [r1, #0x10]\n\tmov\tr0, #0x4\n\tb\t.L74\n' +
    '.L60:\n\tmov\tr3, #0x7\n.L64:\n\tstr\tr3, [r1, #0xc]\n\tmov\tr0, #0x5\n\tb\t.L74\n' +
    '.L70:\n\tmov\tr0, #0x0\n.L74:\n\tbx\tlr\n';
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(/takes a value from the switch edge/);
});

test('two returning arms that share a cross-jumped tail still leave the `break` arms an end', () => {
  // agbcc `-O2` for `switch(x){case 0:p[0]=1;break; … case 2:p[2]=1;p[9]=3;return 1; …
  // case 5:p[5]=1;p[9]=3;return 1; case 6:p[6]=7;break; case 7:p[7]=8;break;} return 0;`. The two
  // returning arms meet at their shared `p[9]=3; return 1` (.L15), a block that is no arm's entry,
  // and both are laid out above the code after the switch, so that is still where it ends.
  const asm =
    'f:\n\tadd\tr2, r1, #0\n\tcmp\tr0, #0x7\n\tbhi\t.L3\t@cond_branch\n\tlsl\tr0, r0, #0x2\n\tldr\tr1, .L16\n' +
    '\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n.L17:\n\t.align\t2, 0\n.L16:\n\t.word\t.L12\n\t.align\t2, 0\n' +
    '\t.align\t2, 0\n.L12:\n\t.word\t.L4\n\t.word\t.L5\n\t.word\t.L6\n\t.word\t.L7\n\t.word\t.L8\n\t.word\t.L9\n' +
    '\t.word\t.L10\n\t.word\t.L11\n' +
    '.L4:\n\tmov\tr0, #0x1\n\tstr\tr0, [r2]\n\tb\t.L3\n.L5:\n\tmov\tr0, #0x2\n\tstr\tr0, [r2, #0x4]\n\tb\t.L3\n' +
    '.L6:\n\tmov\tr0, #0x1\n\tstr\tr0, [r2, #0x8]\n\tb\t.L15\n' +
    '.L7:\n\tmov\tr0, #0x4\n\tstr\tr0, [r2, #0xc]\n\tb\t.L3\n.L8:\n\tmov\tr0, #0x5\n\tstr\tr0, [r2, #0x10]\n\tb\t.L3\n' +
    '.L9:\n\tmov\tr0, #0x1\n\tstr\tr0, [r2, #0x14]\n' +
    '.L15:\n\tmov\tr0, #0x3\n\tstr\tr0, [r2, #0x24]\n\tmov\tr0, #0x1\n\tb\t.L14\n' +
    '.L10:\n\tmov\tr0, #0x7\n\tstr\tr0, [r2, #0x18]\n\tb\t.L3\n.L11:\n\tmov\tr0, #0x8\n\tstr\tr0, [r2, #0x1c]\n' +
    '.L3:\n\tmov\tr0, #0x0\n.L14:\n\tbx\tlr\n';
  const out = decompile('f', asm, ARMV4T_AGBCC).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  expect(count(out, 'break;')).toBe(6);
  expect(count(out, 'return 1;')).toBe(2);
  expect(count(out, 'return 0;')).toBe(1);
  expect(out).toMatch(/\}\s*return 0;\s*\}\s*$/);
});

test('a table with no shared `ret` at all still falls back to the enclosing stop', () => {
  // EVERY arm returns by itself, so no `ret` is reachable from every successor and the follow is
  // null. That is the `?? stop` tail, and it must keep the shape it always had: the arms are
  // structured to their own ends. Without the fallback this commit would change four corpus sites.
  const out = decompile(
    'f',
    returningArms(EARLY_RETURN)
      .replace('.Lc0:\n\tbl\tsideA\n\tb\t.Lend\n', '.Lc0:\n\tbl\tsideA\n\tbx\tlr\n')
      .replace('.Lc2:\n\tbl\tsideC\n\tb\t.Lend\n', '.Lc2:\n\tbl\tsideC\n\tbx\tlr\n'),
    ARMV4T_AGBCC,
  ).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  expect(out).toContain('switch (');
  expect(count(out, 'sideA();')).toBe(1);
  expect(count(out, 'sideC();')).toBe(1);
});
