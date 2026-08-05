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
