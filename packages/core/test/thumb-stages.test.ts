// The stages of the Thumb lift, each driven from asm text through the stages before it as
// `liftOnce` runs them (`thumbFillOf`). `thumb-frontend.test.ts` drives the lift whole.
import { describe, expect, test } from 'vitest';

import { __testing } from '../src/frontend/thumb';
import { mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

const {
  readThumbText,
  thumbCfg,
  assertScratchRegsPartitioned,
  thumbCallDeclarations,
  thumbFillOf,
  openBlockCursor,
  lowerCall,
} = __testing;

// Every stage up to the fill, as the lift runs them: what `fillThumbBlock` reads.
const fillOf = (asm: string, prototypes: Prototypes = {}) =>
  thumbFillOf('f', asm, ARMV4T_AGBCC, prototypes, undefined, undefined);
const measure = (asm: string, prototypes: Prototypes = {}) => fillOf(asm, prototypes).frame;
const labels = (blocks: readonly { label: string }[]) => blocks.map((b) => b.label);

// agbcc's jump-table dispatch behind one of its two bounds spellings (thumb-switch.test.ts); `pool`
// holds the table pointer
const SWITCH = (bounds: string, pool = '.Lp:\n\t.word\t.Ltab\n') =>
  `f:\n${bounds}\tlsl\tr0, r1, #0x2\n\tldr\tr1, .Lp\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n` +
  '.Lc0:\n\tmov\tr0, #10\n\tbx\tlr\n.Lc1:\n\tmov\tr0, #11\n\tbx\tlr\n.Ldef:\n\tmov\tr0, #99\n\tbx\tlr\n' +
  `${pool}.Ltab:\n\t.word\t.Lc0\n\t.word\t.Lc1\n`;
const DIRECT = '\tcmp\tr1, #0x1\n\tbhi\t.Ldef\n';
const LONGJMP = '\tcmp\tr1, #0x1\n\tbls\t.LCB\n\tb\t.Ldef\t@long jump\n.LCB:\n';

// `push {r4, lr}` and an 8-byte local area, one word stored and reloaded
const SLOT =
  'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tldr\tr1, [sp]\n\tadd\tsp, sp, #0x8\n' +
  '\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
// a frame of `words` words whose base is handed to `fill`
const HANDED = (words: number) =>
  `f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-${4 * words}\n\tmov\tr0, sp\n\tbl\tfill\n\tldr\tr0, [sp]\n` +
  `\tadd\tsp, sp, #${4 * words}\n\tpop\t{r1}\n\tbx\tr1\n`;
// one word staged at [sp,#0] before a call to `g`
const STAGED =
  'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tg\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n' +
  '\tpop\t{r2}\n\tbx\tr2\n';

describe('readThumbText', () => {
  test('elides a direct-form dispatch block and keys its table to the bounds block', () => {
    const text = readThumbText('f', SWITCH(DIRECT));
    expect(labels(text.blocks)).toEqual(['f', '.Lc0', '.Lc1', '.Ldef']);
    expect([...text.tables]).toEqual([
      [text.blocks[0], { scrutReg: 'r1', caseLabels: ['.Lc0', '.Lc1'], defaultLabel: '.Ldef' }],
    ]);
  });

  test("elides a long-jump form's lone `b DEF` block with its dispatch", () => {
    const text = readThumbText('f', SWITCH(LONGJMP));
    expect(labels(text.blocks)).toEqual(['f', '.Lc0', '.Lc1', '.Ldef']);
    expect(text.tables.get(text.blocks[0])?.defaultLabel).toBe('.Ldef');
  });

  test('refuses a `mov pc` it recovers no table from', () => {
    // the pool word the dispatch loads is an unrelated global, not the table
    expect(() => readThumbText('f', SWITCH(DIRECT, '.Lp:\n\t.word\tgOther\n'))).toThrow(/indirect\/computed jump/);
  });

  test('refuses a `bl` to a label inside the function', () => {
    expect(() => readThumbText('f', 'f:\n\tbl\t.L2\n\tbx\tlr\n.L2:\n\tbx\tlr\n')).toThrow(
      /'bl \.L2' targets a label inside this function/,
    );
  });

  test('reads which data the pool loads name', () => {
    const text = readThumbText('f', 'f:\n\tldr\tr0, .L3\n\tbx\tlr\n.L3:\n\t.word\tgSym\n');
    expect(text.dataWords.get('.L3')).toEqual(['gSym']);
    expect(text.poolNamesSymbols).toBe(true);
  });
});

describe('thumbCfg', () => {
  // the tight self-loop: block 0 is the loop header
  const SELF_LOOP =
    'f:\n\tldrb\tr2, [r1]\n\tstrb\tr2, [r0]\n\tadd\tr0, r0, #0x1\n\tadd\tr1, r1, #0x1\n\tcmp\tr2, #0\n\tbne\tf\n\tbx\tlr\n';

  test('puts an empty preheader ahead of an entry block that is a loop header', () => {
    const text = readThumbText('f', SELF_LOOP);
    const cfg = thumbCfg('f', text.blocks, text.tables);
    expect(cfg.asmBlocks[0]).toEqual({ label: '.Lasmlift_preheader', instrs: [] });
    expect(cfg.asmBlocks.slice(1)).toEqual(text.blocks);
    expect(cfg.preds[1]).toEqual(expect.arrayContaining([0, 1]));
    expect(cfg.labelIndex.get('f')).toBe(1);
    // the text's own list is left as it was read
    expect(labels(text.blocks)[0]).toBe('f');
  });

  test('adds no preheader where nothing branches to the entry', () => {
    const text = readThumbText('f', SLOT);
    expect(thumbCfg('f', text.blocks, text.tables).asmBlocks).toEqual(text.blocks);
  });

  test('leaves out of the entry-reachable blocks one only dead code reaches', () => {
    const text = readThumbText('f', 'f:\n\tb\t.L2\n.L1:\n\tmov\tr0, #1\n.L2:\n\tbx\tlr\n');
    const cfg = thumbCfg('f', text.blocks, text.tables);
    expect(labels(cfg.asmBlocks)).toEqual(['f', '.L1', '.L2']);
    expect([...cfg.entryReachable].sort()).toEqual([0, 2]);
  });

  test('dispatches a bounds block to its cases and default', () => {
    const text = readThumbText('f', SWITCH(DIRECT));
    const cfg = thumbCfg('f', text.blocks, text.tables);
    expect([1, 2, 3].map((b) => cfg.preds[b])).toEqual([[0], [0], [0]]);
  });
});

describe('assertScratchRegsPartitioned', () => {
  test("returns the target's scratch registers", () => {
    expect([...assertScratchRegsPartitioned(ARMV4T_AGBCC)]).toEqual(['r12', 'ip']);
  });

  test('refuses a scratch register outside the non-argument registers', () => {
    expect(() => assertScratchRegsPartitioned({ ...ARMV4T_AGBCC, scratchRegs: ['r3'] })).toThrow(
      /scratch register r3 is not among the non-argument registers/,
    );
  });
});

describe('thumbCallDeclarations', () => {
  const S4 = { kind: 'struct' as const, members: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u8' })) };
  const ONE = { kind: 'struct' as const, members: [{ name: 'a', type: 's32' }] };

  test('places a `long long` in two argument words, the second one staged', () => {
    const { declaredCall } = thumbCallDeclarations('f', ARMV4T_AGBCC, {
      g: { params: ['s32', 's32', 's32', 'long long'] },
    });
    expect(declaredCall('g')).toEqual({ widths: [32, 32, 32, 64], doubles: new Set(), block: [0], params: 4 });
  });

  test('puts the hidden pointer of a struct returned through memory first', () => {
    const { declaredCall } = thumbCallDeclarations('f', ARMV4T_AGBCC, {
      mk4: { params: ['s32'], returns: 'struct S4', returnLayout: S4 },
    });
    const declared = declaredCall('mk4');
    expect(declared).toMatchObject({ widths: [32, 32], block: null, params: 1 });
    expect(declared?.returned).toMatchObject({ type: { kind: 'struct' } });
  });

  test('answers a struct returned in r0 with no arity stated', () => {
    const calls = thumbCallDeclarations('f', ARMV4T_AGBCC, { mv: { returns: 'struct One', returnLayout: ONE } });
    expect(calls.declaredCall('mv')).toBeNull();
    expect(calls.registerStructReturn('mv')).toBe('register');
  });

  test('declares nothing for a callee no table names', () => {
    const calls = thumbCallDeclarations('f', ARMV4T_AGBCC, {});
    expect(calls.declaredCall('g')).toBeNull();
    expect(calls.returnsPair('g')).toBe(false);
  });

  test("lets a project's re-declaration of a runtime helper disable its pair", () => {
    const declared = thumbCallDeclarations('f', ARMV4T_AGBCC, {});
    expect(declared.wideHelper('__muldi3')).not.toBeNull();
    expect(declared.returnsPair('__muldi3')).toBe(true);
    const redeclared = thumbCallDeclarations('f', ARMV4T_AGBCC, {
      __muldi3: { params: ['s64', 's64'], returns: 's64' },
    });
    expect(redeclared.wideHelper('__muldi3')).toBeNull();
    expect(redeclared.returnsPair('__muldi3')).toBe(false);
  });

  test("answers a project callee's pair return from its declared return width", () => {
    const calls = thumbCallDeclarations('f', ARMV4T_AGBCC, {
      g: { params: ['s32'], returns: 'long long' },
      h: { params: ['s32'], returns: 's32' },
      __divsi3: { params: ['s32', 's32'], returns: 'long long' },
    });
    expect(calls.returnsPair('g')).toBe(true);
    expect(calls.returnsPair('h')).toBe(false);
    // a name the runtime table carries is answered by the table alone
    expect(calls.returnsPair('__divsi3')).toBe(false);
  });

  test("leaves a pair-returning call's high register out of what it clobbers", () => {
    const { callClobbers, pairReturnClobbers } = thumbCallDeclarations('f', ARMV4T_AGBCC, {});
    expect(callClobbers).toContain('r1');
    expect(pairReturnClobbers).toEqual(callClobbers.filter((r) => r !== 'r1'));
  });
});

describe('measureThumbFrame', () => {
  test('measures the reserved local area and the saved registers', () => {
    const frame = measure(SLOT);
    expect(frame.localArea).toBe(8);
    expect([...frame.savedRegs]).toEqual(['r4', 'lr']);
    expect(frame.slotsOffReason).toBeNull();
    expect(frame.partition).toEqual({ ownedLocals: { from: 0, to: 8 }, declaredLocals: { from: 0, to: 8 } });
    expect(frame.isOwnFrameWordSlot('sp', 4, undefined, 4)).toBe(true);
    expect(frame.isOwnFrameWordSlot('sp', 8, undefined, 4)).toBe(false);
  });

  test('measures no local area where a push follows the reservation', () => {
    const pushed =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tpush\t{r0}\n\tldr\tr1, [sp]\n\tpop\t{r0}\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(measure(pushed).localArea).toBe(0);
  });

  test('turns the word-slot model off, naming why', () => {
    const subWord = SLOT.replace('\tldr\tr1, [sp]\n', '\tldrb\tr1, [sp]\n');
    expect(measure(subWord)).toMatchObject({
      slotsOffReason: 'a sub-word sp access aliases the word-slot model',
      slotsOk: false,
    });
    const moved = SLOT.replace('\tldr\tr1, [sp]\n', '\tadd\tsp, sp, #0x4\n\tldr\tr1, [sp]\n').replace(
      '\tadd\tsp, sp, #0x8\n',
      '\tadd\tsp, sp, #0x4\n',
    );
    expect(measure(moved).slotsOffReason).toBe('the frame moves between two accesses that keyed slots against it');
  });

  test('takes a one-word frame whose base a callee is handed as the captured object', () => {
    const frame = measure(HANDED(1));
    expect(frame.capturedObjectIsTheWholeFrame).toBe(true);
    expect(frame.isFrameObjectAccess('sp', 0, undefined, 4)).toBe(true);
    // a wider frame has bytes a one-word model does not describe
    expect(measure(HANDED(2)).capturedObjectIsTheWholeFrame).toBe(false);
  });

  test('takes a one-word frame whose base is published to memory as the captured object', () => {
    const published =
      'f:\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr0, .L3\n\tmov\tr1, sp\n\tstr\tr1, [r0]\n' +
      '\tadd\tsp, sp, #0x4\n\tbx\tlr\n.L3:\n\t.word\t0x040000D4\n';
    expect(measure(published).capturedObjectIsTheWholeFrame).toBe(true);
  });

  test('routes the word a constant capture names to memory', () => {
    const captured =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr4, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tbl\tg\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    const frame = measure(captured);
    expect([...frame.captureOffsetOf.values()]).toEqual([4]);
    expect(frame.isFrameObjectAccess('sp', 4, undefined, 4)).toBe(true);
    expect(frame.isFrameObjectAccess('sp', 0, undefined, 4)).toBe(false);
  });

  test("licenses the outgoing block a callee's declaration asks for", () => {
    for (const g of [{ params: 5 }, { params: ['s32', 's32', 's32', 'long long'] }]) {
      const frame = measure(STAGED, { g });
      expect(frame.slotsOffReason).toBeNull();
      expect(frame.outgoingArgs.area).toBe(4);
      expect(frame.partition.declaredLocals).toEqual({ from: 4, to: 4 });
    }
    // declared with four, the staged word is no argument, and nothing reloads it
    expect(measure(STAGED, { g: { params: 4 } }).outgoingArgs.area).toBe(0);
  });
});

describe('thumbFillOf', () => {
  test('reads a saved callee-saved register before any write as an uninitialised local', () => {
    const { ssa } = fillOf('f:\n\tpush\t{r4, lr}\n\tmov\tr0, r4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n');
    const r4 = ssa.readVar('r4', 0);
    expect(ssa.paramReg.has(r4)).toBe(false);
    expect(ssa.irBlocks[0].ops).toContainEqual(expect.objectContaining({ opcode: 'undef', attrs: { key: 'r4' } }));
  });
});

describe('thumbPairs', () => {
  test('fuses the two halves of one value back into that value, with no op', () => {
    const { pairs, ssa } = fillOf('f:\n\tbx\tlr\n');
    const irb = ssa.irBlocks[0];
    const [at] = readThumbText('f', 'f:\n\tbx\tlr\n').blocks[0].instrs;
    const whole = mkValue(T.unk(64));
    const lo = pairs.projectHalf(irb, whole, 'lo', at);
    const hi = pairs.projectHalf(irb, whole, 'hi', at);
    const ops = irb.ops.length;
    expect(pairs.fuseHalves(irb, lo, hi)).toBe(whole);
    expect(irb.ops.length).toBe(ops);
  });

  test("builds a `concat` of halves that are not one value's, or not in order", () => {
    const { pairs, ssa } = fillOf('f:\n\tbx\tlr\n');
    const irb = ssa.irBlocks[0];
    const [at] = readThumbText('f', 'f:\n\tbx\tlr\n').blocks[0].instrs;
    const [v, w] = [mkValue(T.unk(64)), mkValue(T.unk(64))];
    const fused = [
      pairs.fuseHalves(irb, pairs.projectHalf(irb, v, 'lo', at), pairs.projectHalf(irb, w, 'hi', at)),
      pairs.fuseHalves(irb, pairs.projectHalf(irb, v, 'hi', at), pairs.projectHalf(irb, v, 'lo', at)),
    ];
    expect(fused).not.toContain(v);
    expect(irb.ops.filter((op) => op.opcode === 'concat').map((op) => op.results[0])).toEqual(fused);
  });
});

describe('lowerCall', () => {
  const CALL = 'f:\n\tpush\t{lr}\n\tbl\tg\n\tpop\t{pc}\n';
  const callIn = (prototypes: Prototypes = {}) => {
    const fill = fillOf(CALL, prototypes);
    const ab = fill.cfg.asmBlocks[0];
    const cur = openBlockCursor(fill, ab, 0);
    lowerCall(
      fill,
      cur,
      ab.instrs.find((ins) => ins.mnemonic === 'bl')!,
    );
    const call = cur.irb.ops.find((op) => op.opcode === 'call')!;
    return { fill, cur, call };
  };

  test('passes a declared `long long` as one value of its two words, and splits a pair it returns', () => {
    const { fill, cur, call } = callIn({ g: { params: ['long long'], returns: 'long long' } });
    expect(cur.irb.ops.map((op) => op.opcode)).toEqual(['concat', 'call', 'lo32', 'hi32']);
    const [concat] = cur.irb.ops;
    expect(call.operands).toEqual([concat.results[0]]);
    expect(concat.operands.map((v) => fill.ssa.paramReg.get(v))).toEqual(['r0', 'r1']);
    expect(call.results[0].type).toEqual(T.unk(64));
    expect(fill.pairs.pairCallee.get(call.results[0])).toBe('g');
  });

  test("defines r0 with a word call's result", () => {
    const { fill, call } = callIn({ g: { params: ['s32'] } });
    expect(call.attrs.target).toBe('g');
    expect(call.operands.map((v) => fill.ssa.paramReg.get(v))).toEqual(['r0']);
    expect(fill.ssa.readVar('r0', 0)).toBe(call.results[0]);
    expect(call.results[0].type).toEqual(T.unk(32));
  });
});
