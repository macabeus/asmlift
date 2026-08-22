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
  expect(out).toMatch(/case 0:\s*\n\s*sideA\(\);\s*\n\s*case 1:/);
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
  expect(out).toMatch(/case 1:\s*\n\s*sideB\(\);\s*\n\s*default:/);
});

test('a fall-through that would carry an effect out of a loop DECLINES', () => {
  // The exit copies of a do-while render AFTER it, while the analysis decided where their values
  // may inline as if they sat on the latch's terminator — inside the loop. An arm ending in a loop
  // whose result is read by the next arm therefore came out as `do { i = i - 1; } while (…);
  // sideB(sideA());` — the call once instead of once per iteration, in C that looks entirely
  // ordinary. Loud beats plausible. `sideB`'s arity is DECLARED, because the read has to be a real
  // one: a guessed arity would not pass the loop's result at all (frontend/ssa.ts).
  const loop = '\tmov\tr4, #3\n.Llp:\n\tbl\tsideA\n\tsub\tr4, #1\n\tcmp\tr4, #0\n\tbne\t.Llp\n';
  const oneArg = { prototypes: { sideB: { params: 1 } } };
  expect(() => decompile('f', conv([loop, '\tbl\tsideB\n' + LEAVE]), ARMV4T_AGBCC, oneArg)).toThrow(
    /inlines a 'call' from inside the loop/,
  );
  // control: the SAME loop in a closed arm keeps the call inside the loop and recovers.
  const closed = decompile('f', conv([loop + LEAVE, '\tbl\tsideB\n' + LEAVE]), ARMV4T_AGBCC, oneArg).source;
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
  expect(sw([CALL_A + fallsTo(2), armB, armC])).toThrow(/falls through into an arm that is not the next one emitted/);
  // (b) reaches a sibling on one path and the switch's end on another. C CAN spell this — with a
  // switch-scoped `break` in the case body — so the decline names asmlift's own missing piece
  // rather than blaming C.
  expect(sw(['\tcmp\tr2, #0\n\tbeq\t.Lc1\n' + CALL_A + LEAVE, armB])).toThrow(
    /a switch-scoped `break` inside a case body is not emitted yet/,
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
  expect(control).toContain('switch (a0)');
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
  expect(decompile('f', withLoad('ldr\tr0, [r0, #0x00]'), ARMV4T_AGBCC).source).toContain('switch (a0)');
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
