// frontend/dead-reads.ts: a read the lifted function never uses was `volatile` in the source, so the
// lift stamps it `volatile` before the IR's dead-code pass can delete it.
//
// The objects are committed (`corpus/probe-dead-read.c`, `scripts/regen-dead-read-probes.ts`), one
// per compiler family, because the claim is the compilers': each of them deletes a plain read
// nobody uses, and keeps a qualified one — agbcc into a register the next statement overwrites,
// IDO into `$zero`, gcc 2.7.2 (KMC) into a register it then reloads, mwcc into `r0`. Without the
// stamp every one of these reads is gone from every candidate. The address plays no part: a
// literal, a pointer parameter and an extern symbol are all the same read.
//
// The gate table's refusals each have a test that ablates the gate and watches the read get
// stamped, so neither is a comment that nothing exercises.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { DEAD_READ_GATES, pinDeadReads } from '../src/frontend/dead-reads';
import { type Block, type Op, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { tallying, without } from '../src/l3/gates';
import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '../src/target';

const fixture = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');

const TOOLCHAINS: readonly { fixture: string; target: TargetDescription; fns: readonly string[] }[] = [
  { fixture: 'agbcc-deadread.s', target: ARMV4T_AGBCC, fns: ['readback', 'dmaburst', 'lone', 'sym', 'param'] },
  // objdump without relocations: `sym`'s `lui`/`addiu` pair is an unrelocated placeholder, which
  // the MIPS frontend refuses on its own grounds
  { fixture: 'ido71-deadread.txt', target: MIPS_IDO, fns: ['readback', 'dmaburst', 'lone', 'param'] },
  { fixture: 'gcc272kmc-deadread.txt', target: MIPS_GCC, fns: ['readback', 'dmaburst', 'lone', 'param'] },
  // `dmaburst` builds its control word with `oris`, which the PPC frontend does not model
  { fixture: 'mwcc242-deadread.txt', target: PPC_MWCC, fns: ['readback', 'lone', 'sym', 'param'] },
];

/** each function's own read, the one whose value nothing uses */
const READ: Readonly<Record<string, RegExp>> = {
  readback: /^\s*(\*\(volatile s32 \*\)67109080|\(\(volatile s32 \*\)67108864\)\[54\]);$/m,
  dmaburst: /^\s*\(\(volatile s32 \*\)\w+\)\[(2|55)\];$/m,
  lone: /^\s*(\*\(volatile u16 \*\)67108868|\(\(volatile u16 \*\)67108864\)\[2\]);$/m,
  sym: /^\s*gR;$/m,
  param: /^\s*\*\(volatile s32 \*\)a0;$/m,
};

const lift = (name: string, asm: string, target: TargetDescription) =>
  decompile(name, asm, target, { prototypes: { [name]: { returnsVoid: true } } }).source;

describe.each(TOOLCHAINS)('$fixture', ({ fixture: f, target, fns }) => {
  test.each(fns)('%s keeps the read nothing uses, qualified', (name) => {
    expect(lift(name, fixture(f), target)).toMatch(READ[name]);
  });
});

// `long long pairhi(long long *p) { return *p; }`, lifted with no declaration: the second word of
// the return pair is unused only because the lift guessed a one-word return, so it is no
// `volatile` read of RAM. agbcc and mwcc lift the one word their ABI returns first; O32 refuses the
// v0:v1 pair outright, before this rule is asked.
describe("pairhi: the return pair's second word is no dead read", () => {
  const unproto = (f: string, target: TargetDescription) => () => decompile('pairhi', fixture(f), target).source;
  test.each([
    ['agbcc-deadread.s', ARMV4T_AGBCC],
    ['mwcc242-deadread.txt', PPC_MWCC],
  ] as const)('%s', (f, target) => {
    expect(unproto(f, target)()).not.toMatch(/volatile/);
  });
  test.each([
    ['ido71-deadread.txt', MIPS_IDO],
    ['gcc272kmc-deadread.txt', MIPS_GCC],
  ] as const)('%s declines', (f, target) => {
    expect(unproto(f, target)).toThrow(/v0:v1/);
  });
});

test('a qualified read of a hoisted base reads through the local the hoist named', () => {
  // `dmaRegs[2];` after the three stores through `dmaRegs`: inline, the qualified cast over the
  // literal makes agbcc load a second pool word with the offset folded in, where the source read
  // `[r4, #0x8]` off the base it already held (l3/basecse.ts `rewrite`).
  expect(lift('dmaburst', fixture('agbcc-deadread.s'), ARMV4T_AGBCC)).toMatch(/^\s*\(\(volatile s32 \*\)p0\)\[2\];$/m);
  expect(lift('dmaburst', fixture('ido71-deadread.txt'), MIPS_IDO)).toMatch(/^\s*\(\(volatile s32 \*\)p0\)\[2\];$/m);
});

test('a symbol read nothing uses is declared volatile where no map declares it', () => {
  // The structurer spells the read by the bare name, whose declaration owns its qualifiers, so the
  // synthesized declaration is what keeps it: `gR;` under a plain `extern u32 gR;` compiles to no
  // read at all.
  const [c] = enumerateCandidates('sym', fixture('agbcc-deadread.s'), ARMV4T_AGBCC, {
    prototypes: { sym: { returnsVoid: true } },
  });
  expect(c.symbolRefs?.find((r) => r.name === 'gR')?.info.volatile).toBe(true);
});

/** One block reading `width` bytes at `base` into a value nothing uses, then returning. */
const deadLoad = (base: Op, attrs: Op['attrs']): { blocks: Block[]; load: Op } => {
  const v = mkValue(T.unk(32));
  const load = mkOp('load', { operands: [base.results[0]], results: [v], attrs });
  return { blocks: [{ params: [], ops: [base, load, mkOp('ret')] }], load };
};
const constAt = (addr: number) => mkOp('const', { results: [mkValue(T.unk(32))], attrs: { value: addr } });

describe('the gates', () => {
  test('a read of a literal nothing uses is stamped', () => {
    const { blocks, load } = deadLoad(constAt(0x02000100), { off: 0, width: 4, signed: false });
    pinDeadReads(blocks, ARMV4T_AGBCC);
    expect(load.attrs.volatile).toBe(true);
  });

  test('a read something uses is not', () => {
    const v = mkValue(T.unk(32));
    const base = constAt(0x02000100);
    const load = mkOp('load', {
      operands: [base.results[0]],
      results: [v],
      attrs: { off: 0, width: 4, signed: false },
    });
    pinDeadReads([{ params: [], ops: [base, load, mkOp('ret', { operands: [v] })] }], ARMV4T_AGBCC);
    expect(load.attrs.volatile).toBeUndefined();
  });

  test('a read only a dead extension uses is as dead as the read', () => {
    const base = constAt(0x02000100);
    const raw = mkValue(T.unk(32));
    const load = mkOp('load', {
      operands: [base.results[0]],
      results: [raw],
      attrs: { off: 0, width: 2, signed: false },
    });
    const ext = mkOp('sext', { operands: [raw], results: [mkValue(T.unk(32))], attrs: { width: 16 } });
    pinDeadReads([{ params: [], ops: [base, load, ext, mkOp('ret')] }], ARMV4T_AGBCC);
    expect(load.attrs.volatile).toBe(true);
  });

  test('frame-object: a dead read of a frame object stays deletable', () => {
    const object = () =>
      mkOp('laddr', { results: [mkValue(T.unk(32))], attrs: { off: 0, width: 4, signed: false, count: 1 } });
    const kept = deadLoad(object(), { off: 0, width: 4, signed: false });
    pinDeadReads(kept.blocks, ARMV4T_AGBCC);
    expect(kept.load.attrs.volatile).toBeUndefined();
    const ablated = deadLoad(object(), { off: 0, width: 4, signed: false });
    pinDeadReads(ablated.blocks, ARMV4T_AGBCC, undefined, without(DEAD_READ_GATES, 'frame-object'));
    expect(ablated.load.attrs.volatile).toBe(true);
  });

  test('unmodelled-instruction: a read an unmodelled instruction may consume stays plain', () => {
    // mwcc's bit insert: `lbz r0, 76(r3)` + `rlwimi r0, r4, 7, 24, 24` + `stb r0, 76(r3)`. The
    // `rlwimi` reads the byte it inserts into, and the opaque that stands for it does not say so.
    const withOpaque = (gates?: Parameters<typeof pinDeadReads>[3]) => {
      const { blocks, load } = deadLoad(constAt(0x02000100), { off: 76, width: 1, signed: false });
      const insert = mkOp('opaque', {
        results: [mkValue(T.unk(32))],
        attrs: { reason: "unmodelled instruction 'rlwimi'" },
      });
      blocks[0].ops.splice(2, 0, insert);
      pinDeadReads(blocks, PPC_MWCC, undefined, gates);
      return load;
    };
    expect(withOpaque().attrs.volatile).toBeUndefined();
    expect(withOpaque(without(DEAD_READ_GATES, 'unmodelled-instruction')).attrs.volatile).toBe(true);
  });

  test('not-a-volatile-read: a dead sign-extending narrow read stays plain on agbcc', () => {
    // agbcc reads a qualified `s16` with `ldrh` and extends in a register (target.ts
    // `volatileReadsExtendInRegister`), so an `ldsh` was a plain read in the source.
    const kept = deadLoad(constAt(0x04000004), { off: 0, width: 2, signed: true });
    pinDeadReads(kept.blocks, ARMV4T_AGBCC);
    expect(kept.load.attrs.volatile).toBeUndefined();
    const ablated = deadLoad(constAt(0x04000004), { off: 0, width: 2, signed: true });
    pinDeadReads(ablated.blocks, ARMV4T_AGBCC, undefined, without(DEAD_READ_GATES, 'not-a-volatile-read'));
    expect(ablated.load.attrs.volatile).toBe(true);
    // …where a compiler that extends in the load itself was given no such rule
    const ido = deadLoad(constAt(0x04000004), { off: 0, width: 2, signed: true });
    pinDeadReads(ido.blocks, MIPS_IDO);
    expect(ido.load.attrs.volatile).toBe(true);
  });

  test('held-at-word-return: a leaf 64-bit return from memory keeps no volatile high word', () => {
    // The value in the return pair's second register at a return the lift guessed one word wide.
    const held = deadLoad(constAt(0x02000100), { off: 4, width: 4, signed: false });
    pinDeadReads(held.blocks, ARMV4T_AGBCC, new Set(held.load.results));
    expect(held.load.attrs.volatile).toBeUndefined();
    const ablated = deadLoad(constAt(0x02000100), { off: 4, width: 4, signed: false });
    pinDeadReads(
      ablated.blocks,
      ARMV4T_AGBCC,
      new Set(ablated.load.results),
      without(DEAD_READ_GATES, 'held-at-word-return'),
    );
    expect(ablated.load.attrs.volatile).toBe(true);
    // …and an extension of the read the pair holds is the read held
    const base = constAt(0x02000100);
    const raw = mkValue(T.unk(32));
    const load = mkOp('load', {
      operands: [base.results[0]],
      results: [raw],
      attrs: { off: 4, width: 2, signed: false },
    });
    const ext = mkOp('zext', { operands: [raw], results: [mkValue(T.unk(32))], attrs: { width: 16 } });
    pinDeadReads([{ params: [], ops: [base, load, ext, mkOp('ret')] }], ARMV4T_AGBCC, new Set(ext.results));
    expect(load.attrs.volatile).toBeUndefined();
  });

  test('the refusals are REPORTED: a tallied table counts each one by its gate', () => {
    const t = tallying(DEAD_READ_GATES);
    const frame = mkOp('laddr', {
      results: [mkValue(T.unk(32))],
      attrs: { off: 0, width: 4, signed: false, count: 1 },
    });
    pinDeadReads(deadLoad(frame, { off: 0, width: 4, signed: false }).blocks, ARMV4T_AGBCC, undefined, t.gates);
    pinDeadReads(
      deadLoad(constAt(0x04000004), { off: 0, width: 2, signed: true }).blocks,
      ARMV4T_AGBCC,
      undefined,
      t.gates,
    );
    expect(t.refusals()).toEqual([
      ['frame-object', 1],
      ['not-a-volatile-read', 1],
    ]);
  });
});
