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

import { DEAD_READ_GATES, type Declarations, pinDeadReads } from '../src/frontend/dead-reads';
import { type Block, type Op, mkOp, mkValue } from '../src/ir/core';
import { deadOps } from '../src/ir/discipline';
import { T } from '../src/ir/types';
import { tallying, without } from '../src/l3/gates';
import { dce } from '../src/pattern/engine';
import { decompile } from '../src/pipeline';
import { globalsFromContext } from '../src/proto-context';
import { enumerateCandidates } from '../src/rank';
import {
  ARMV4T_AGBCC,
  MIPS_GCC,
  MIPS_IDO,
  PPC_MWCC,
  type TargetDescription,
  keepsUnusedReadsAt,
  targetFor,
} from '../src/target';

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
// Plain reads a compiler KEEPS with nothing using them (probe-dead-read.c, compiled): agbcc's merged
// identical arms, O32's struct copy and long long stored to a frame slot the lift keeps as a
// variable, and KMC's `addu` of a long long's high word.
describe('plain reads a compiler keeps are no dead read', () => {
  test('samearms: agbcc keeps the read its merged arms tested, which a declaration says is plain', () => {
    const asm = fixture('agbcc-deadread.s');
    const declared = decompile('samearms', asm, ARMV4T_AGBCC, {
      contextGlobals: globalsFromContext('extern int gPlain;', 'c'),
    }).source;
    expect(declared).not.toMatch(/gPlain/);
    // RESIDUE: with no declaration in evidence it is the same instructions as `sym`'s `gR;`
    expect(decompile('samearms', asm, ARMV4T_AGBCC).source).toMatch(/^\s*gPlain;$/m);
  });
  test.each([
    ['spill', 'gcc272kmc-deadread.txt', MIPS_GCC],
    ['widesum', 'gcc272kmc-deadread.txt', MIPS_GCC],
    ['widesum', 'ido71-deadread.txt', MIPS_IDO],
  ] as const)('%s on %s', (name, f, target) => {
    expect(decompile(name, fixture(f), target).source).not.toMatch(/volatile/);
  });
});

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

test('…and where the declaration context qualifies it, the declaration synthesized beside it says so too', () => {
  // The context places the read `declared`, not by a cast; a plain synthesized `extern u32 gR;`
  // would still make `gR;` compile to no read (rank-declare.ts `bareGlobalSymbols`).
  const [c] = enumerateCandidates('sym', fixture('agbcc-deadread.s'), ARMV4T_AGBCC, {
    prototypes: { sym: { returnsVoid: true } },
    contextGlobals: globalsFromContext('extern volatile int gR;', 'c'),
  });
  expect(c.source).toMatch(/^\s*gR;$/m);
  expect(c.symbolRefs?.find((r) => r.name === 'gR')?.info.volatile).toBe(true);
});

test('a read only a compare no branch reads consumes is no dead read', () => {
  // mwcc 2.3.3 at -O4,s keeps `lwz; cmpwi` for `extern int g; void f(void){ if (g) { (g != 0); } }`:
  // the compare is fused into a branch that never comes, so the lift has no op for it.
  const asm = '00000000 <f>:\n   0:\tlwz     r0,0(0)\n\t\t\t2: R_PPC_EMB_SDA21\tg\n   4:\tcmpwi   r0,0\n   8:\tblr\n';
  // the read would be spelled `g;`, kept by a synthesized `extern volatile u32 g;`
  expect(decompile('f', asm, PPC_MWCC).source).not.toMatch(/^\s*g;$/m);
});

test('a read the guessed arity leaves in an argument register is no dead read', () => {
  // agbcc of `extern void g(); void f(int a, int *p, int c){ g(a, c ? p[1] : p[2]); }`: r0 holds
  // the incoming `a`, so the guess passes nothing, and the r1 loads are unused by the LIFT only.
  const asm =
    'f:\n\tpush\t{lr}\n\tcmp\tr2, #0\n\tbeq\t.L3\n\tldr\tr1, [r1, #0x4]\n\tb\t.L4\n.L3:\n' +
    '\tldr\tr1, [r1, #0x8]\n.L4:\n\tbl\tg\n\tpop\t{r0}\n\tbx\tr0\n';
  expect(decompile('f', asm, ARMV4T_AGBCC).source).not.toMatch(/volatile/);
  // …and a declaration that passes the argument reads it
  expect(
    decompile('f', asm, ARMV4T_AGBCC, { prototypes: { g: { params: ['s32', 's32'], returnsVoid: true } } }).source,
  ).toMatch(/g\(a0, /);
});

test('dce deletes exactly what deadOps calls dead — the one definition the pin reads', () => {
  const base = constAt(0x02000100);
  const raw = mkValue(T.unk(32));
  const load = mkOp('load', { operands: [base.results[0]], results: [raw], attrs: { off: 0, width: 2 } });
  const ext = mkOp('zext', { operands: [raw], results: [mkValue(T.unk(32))], attrs: { width: 16 } });
  const live = constAt(7);
  const fn = {
    name: 'f',
    blocks: [{ params: [], ops: [base, load, ext, live, mkOp('ret', { operands: live.results })] }],
  };
  expect(new Set(deadOps(fn.blocks))).toEqual(new Set([base, load, ext]));
  dce(fn as unknown as Parameters<typeof dce>[0]);
  expect(fn.blocks[0].ops.map((op) => op.opcode)).toEqual(['const', 'ret']);
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
    pinDeadReads(ablated.blocks, ARMV4T_AGBCC, {}, without(DEAD_READ_GATES, 'frame-object'));
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
      pinDeadReads(blocks, PPC_MWCC, {}, gates);
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
    pinDeadReads(ablated.blocks, ARMV4T_AGBCC, {}, without(DEAD_READ_GATES, 'not-a-volatile-read'));
    expect(ablated.load.attrs.volatile).toBe(true);
    // …where a compiler that extends in the load itself was given no such rule
    const ido = deadLoad(constAt(0x04000004), { off: 0, width: 2, signed: true });
    pinDeadReads(ido.blocks, MIPS_IDO);
    expect(ido.load.attrs.volatile).toBe(true);
  });

  test('held-at-word-return: a leaf 64-bit return from memory keeps no volatile high word', () => {
    // The value in the return pair's second register at a return the lift guessed one word wide.
    const held = deadLoad(constAt(0x02000100), { off: 4, width: 4, signed: false });
    pinDeadReads(held.blocks, ARMV4T_AGBCC, { atWordReturn: new Set(held.load.results) });
    expect(held.load.attrs.volatile).toBeUndefined();
    const ablated = deadLoad(constAt(0x02000100), { off: 4, width: 4, signed: false });
    pinDeadReads(
      ablated.blocks,
      ARMV4T_AGBCC,
      { atWordReturn: new Set(ablated.load.results) },
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
    pinDeadReads([{ params: [], ops: [base, load, ext, mkOp('ret')] }], ARMV4T_AGBCC, {
      atWordReturn: new Set(ext.results),
    });
    expect(load.attrs.volatile).toBeUndefined();
  });

  test('keeps-unused-reads: mwcc -O0 keeps a dead assignment plain', () => {
    // mwcc at -O0 keeps `x = p[5]; x = 0;`'s `lwz r31, 20(r3)` in a register nothing reads
    const o0 = targetFor('mwcc_242_81', ['-O0']).target;
    const kept = deadLoad(constAt(0x80001000), { off: 20, width: 4, signed: false });
    pinDeadReads(kept.blocks, o0);
    expect(kept.load.attrs.volatile).toBeUndefined();
    const ablated = deadLoad(constAt(0x80001000), { off: 20, width: 4, signed: false });
    pinDeadReads(ablated.blocks, o0, {}, without(DEAD_READ_GATES, 'keeps-unused-reads'));
    expect(ablated.load.attrs.volatile).toBe(true);
    // …and at the level the bench's mwcc rows build, the read is stamped
    const o4 = deadLoad(constAt(0x80001000), { off: 20, width: 4, signed: false });
    pinDeadReads(o4.blocks, targetFor('mwcc_242_81', ['-O4,p']).target);
    expect(o4.load.attrs.volatile).toBe(true);
  });

  test('keeps-unused-reads is a fact of the level, per family', () => {
    expect(['0', '0,p', '1', '4,p', '4,s'].map((l) => keepsUnusedReadsAt('mwcc', l))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(['0', '1', '2', '3'].map((l) => keepsUnusedReadsAt('ido', l))).toEqual([true, true, false, false]);
    expect(['0', '1', '2'].map((l) => keepsUnusedReadsAt('agbcc', l))).toEqual([true, false, false]);
    expect(['0', '1', '2'].map((l) => keepsUnusedReadsAt('gcc', l))).toEqual([true, false, false]);
    expect(targetFor('ido7.1', ['-O2']).target.compilerBehaviors.keepsUnusedReads).toBeUndefined();
    expect(targetFor('ido7.1', []).target.compilerBehaviors.keepsUnusedReads).toBe(true); // IDO's default is -O1
  });

  test('the register a keeping level discards an unused read into is a fact of the compiler', () => {
    // compiled at -O0,p (mwcc) and -O1/-O0 (IDO): a volatile `*p;` is `lwz r0` / `lw zero`; agbcc,
    // gcc 2.7.2 and KMC at -O0 load it into a register a `register` local takes as well
    const into = (id: Parameters<typeof targetFor>[0], flags: string[]) =>
      targetFor(id, flags).target.compilerBehaviors.discardsUnusedReadsInto;
    for (const id of ['mwcc_242_81', 'mwcc_247_107', 'mwcc_233_163n'] as const) {
      expect(into(id, ['-O0,p'])).toBe('r0');
    }
    expect(into('ido7.1', ['-O1'])).toBe('zero');
    expect(into('ido7.1', ['-O0'])).toBe('zero');
    for (const id of ['agbcc', 'gcc2.7.2kmc', 'gcc2.7.2'] as const) {
      expect(into(id, ['-O0'])).toBeUndefined();
    }
  });

  test("keeps-unused-reads: a level no flag names keeps, as every family's unflagged compile was measured to", () => {
    // mwcc 2.4.2 with no level, with `-opt off` and with `-opt level=0` keeps `x = p[5]; x = 0;`'s
    // `lwz r31, 20(r3)`; KMC gcc 2.7.2 with no -O emits -O0's object byte for byte
    for (const f of ['mwcc', 'gcc', 'agbcc', 'ido'] as const) {
      expect(keepsUnusedReadsAt(f, undefined)).toBe(true);
    }
    const keeps = (id: Parameters<typeof targetFor>[0], flags: string[]) =>
      targetFor(id, flags).target.compilerBehaviors.keepsUnusedReads;
    expect(keeps('mwcc_242_81', [])).toBe(true);
    expect(keeps('mwcc_242_81', ['-opt', 'off'])).toBe(true);
    expect(keeps('mwcc_242_81', ['-opt', 'level=0'])).toBe(true);
    // an `-opt` word the table cannot read leaves the level unknown even beside a `-O` word
    expect(keeps('mwcc_242_81', ['-O4,p', '-opt', 'off'])).toBe(true);
    expect(keeps('mwcc_242_81', ['-O4,p'])).toBeUndefined();
    expect(keeps('gcc2.7.2kmc', [])).toBe(true);
    expect(keeps('gcc2.7.2kmc', ['-O2'])).toBeUndefined();
  });

  test('held-at-undeclared-call: a read the guessed arity leaves out stays plain', () => {
    const held = deadLoad(constAt(0x02000100), { off: 4, width: 4, signed: false });
    pinDeadReads(held.blocks, ARMV4T_AGBCC, { atUndeclaredCall: new Set(held.load.results) });
    expect(held.load.attrs.volatile).toBeUndefined();
    const ablated = deadLoad(constAt(0x02000100), { off: 4, width: 4, signed: false });
    pinDeadReads(
      ablated.blocks,
      ARMV4T_AGBCC,
      { atUndeclaredCall: new Set(ablated.load.results) },
      without(DEAD_READ_GATES, 'held-at-undeclared-call'),
    );
    expect(ablated.load.attrs.volatile).toBe(true);
  });

  test('compared: a read only a dead compare consumes stays plain', () => {
    const held = deadLoad(constAt(0x02000100), { off: 0, width: 4, signed: false });
    pinDeadReads(held.blocks, PPC_MWCC, { compared: new Set(held.load.results) });
    expect(held.load.attrs.volatile).toBeUndefined();
    const ablated = deadLoad(constAt(0x02000100), { off: 0, width: 4, signed: false });
    pinDeadReads(
      ablated.blocks,
      PPC_MWCC,
      { compared: new Set(ablated.load.results) },
      without(DEAD_READ_GATES, 'compared'),
    );
    expect(ablated.load.attrs.volatile).toBe(true);
  });

  test('spilled: a read whose value was stored to the frame stays plain', () => {
    // KMC `struct S s = *p; return s.a;`: `lw v1, 4(a0); sw v1, 4(sp)`, a slot nothing reloads
    const held = deadLoad(constAt(0x80001000), { off: 4, width: 4, signed: false });
    pinDeadReads(held.blocks, MIPS_GCC, { spilled: new Set(held.load.results) });
    expect(held.load.attrs.volatile).toBeUndefined();
    const ablated = deadLoad(constAt(0x80001000), { off: 4, width: 4, signed: false });
    pinDeadReads(
      ablated.blocks,
      MIPS_GCC,
      { spilled: new Set(ablated.load.results) },
      without(DEAD_READ_GATES, 'spilled'),
    );
    expect(ablated.load.attrs.volatile).toBe(true);
  });

  test('computed: a read a dead add consumes stays plain', () => {
    // KMC `v += 3` on a long long it truncates: `lw a2, 0(a0)` feeds an `addu` nothing reads
    const run = (gates?: Parameters<typeof pinDeadReads>[3]) => {
      const base = constAt(0x80001000);
      const raw = mkValue(T.unk(32));
      const load = mkOp('load', { operands: [base.results[0]], results: [raw], attrs: { off: 0, width: 4 } });
      const carry = mkValue(T.unk(32));
      const sum = mkOp('add', { operands: [raw, carry], results: [mkValue(T.unk(32))] });
      pinDeadReads([{ params: [carry], ops: [base, load, sum, mkOp('ret')] }], MIPS_GCC, {}, gates);
      return load.attrs.volatile;
    };
    expect(run()).toBeUndefined();
    expect(run(without(DEAD_READ_GATES, 'computed'))).toBe(true);
  });

  test('computed: a read that is the address of a read the pin left plain is that read’s use', () => {
    // the outer read sign-extends on agbcc, so `not-a-volatile-read` leaves it plain, and the
    // pointer it read through was the compiler's to compute
    const pp = mkValue(T.unk(32));
    const inner = mkOp('load', { operands: [pp], results: [mkValue(T.unk(32))], attrs: { off: 0, width: 4 } });
    const outer = mkOp('load', {
      operands: [inner.results[0]],
      results: [mkValue(T.unk(32))],
      attrs: { off: 0, width: 2, signed: true },
    });
    pinDeadReads([{ params: [pp], ops: [inner, outer, mkOp('ret')] }], ARMV4T_AGBCC);
    expect(outer.attrs.volatile).toBeUndefined();
    expect(inner.attrs.volatile).toBeUndefined();
  });

  test('declared-plain: a dead read of a global declared plain stays deletable', () => {
    const run = (declarations: Declarations, off = 0, gates?: Parameters<typeof pinDeadReads>[3]) => {
      const { blocks, load } = deadLoad(mkOp('gaddr', { results: [mkValue(T.unk(32))], attrs: { sym: 'gS' } }), {
        off,
        width: 4,
        signed: false,
      });
      pinDeadReads(blocks, ARMV4T_AGBCC, { declarations }, gates);
      return load.attrs.volatile;
    };
    const ctx = (src: string) => ({ context: globalsFromContext(src, 'c') });
    // agbcc merges `if (gS) *q = 1; else *q = 1;`'s arms after flow, and keeps the plain `ldr`
    expect(run(ctx('extern int gS;'))).toBeUndefined();
    expect(run(ctx('extern int gS;'), 0, without(DEAD_READ_GATES, 'declared-plain'))).toBe(true);
    expect(run(ctx('extern volatile int gS;'))).toBe(true);
    expect(run({})).toBe(true); // nothing declares it: no evidence either way
    // a map that lays the object out answers by byte
    const layout = (volatileAt4: boolean): Declarations => ({
      symbols: new Map([
        [
          0x03000000,
          [
            {
              name: 'gS',
              kind: 'data',
              declared: true,
              shape: 'struct',
              layout: [
                { name: 'a', offset: 0, size: 4 },
                { name: 'b', offset: 4, size: 4, volatile: volatileAt4 },
              ],
            },
          ],
        ],
      ]),
    });
    expect(run(layout(true), 0)).toBeUndefined();
    expect(run(layout(true), 4)).toBe(true);
    expect(run(layout(false), 4)).toBeUndefined();
    // an array's map entry carries its element chain's qualifiers and no element layout: only a
    // base-type element (`elemSigned` stated) makes that qualifier the whole answer — klonoa's
    // `gEntityAnimationInfo[]` is an array of structs whose `frame` member is `volatile u8`
    const array = (elem: { elemSigned?: boolean }): Declarations => ({
      symbols: new Map([
        [0x03000000, [{ name: 'gS', kind: 'data', declared: true, shape: 'array', elemSize: 4, ...elem }]],
      ]),
    });
    expect(run(array({ elemSigned: false }), 2)).toBeUndefined();
    expect(run(array({}), 2)).toBe(true);
  });

  test('a read that computes another dead read’s address is decided after it, and is then live', () => {
    // `*(volatile int *)*pp;`: the read of `pp` is the address of the kept read, not a read of its own
    const pp = mkValue(T.unk(32));
    const inner = mkOp('load', { operands: [pp], results: [mkValue(T.unk(32))], attrs: { off: 0, width: 4 } });
    const outer = mkOp('load', {
      operands: [inner.results[0]],
      results: [mkValue(T.unk(32))],
      attrs: { off: 0, width: 4 },
    });
    pinDeadReads([{ params: [pp], ops: [inner, outer, mkOp('ret')] }], ARMV4T_AGBCC);
    expect(outer.attrs.volatile).toBe(true);
    expect(inner.attrs.volatile).toBeUndefined();
  });

  test('a declared void return’s operand is no use: the read it carries is stamped', () => {
    const run = (own?: { returnsVoid: true }) => {
      const base = constAt(0x040000dc);
      const v = mkValue(T.unk(32));
      const load = mkOp('load', { operands: [base.results[0]], results: [v], attrs: { off: 0, width: 4 } });
      pinDeadReads([{ params: [], ops: [base, load, mkOp('ret', { operands: [v] })] }], ARMV4T_AGBCC, { own });
      return load.attrs.volatile;
    };
    expect(run({ returnsVoid: true })).toBe(true);
    expect(run()).toBeUndefined();
  });

  test('the refusals are REPORTED: a tallied table counts each one by its gate', () => {
    const t = tallying(DEAD_READ_GATES);
    const frame = mkOp('laddr', {
      results: [mkValue(T.unk(32))],
      attrs: { off: 0, width: 4, signed: false, count: 1 },
    });
    pinDeadReads(deadLoad(frame, { off: 0, width: 4, signed: false }).blocks, ARMV4T_AGBCC, {}, t.gates);
    pinDeadReads(deadLoad(constAt(0x04000004), { off: 0, width: 2, signed: true }).blocks, ARMV4T_AGBCC, {}, t.gates);
    expect(t.refusals()).toEqual([
      ['frame-object', 1],
      ['not-a-volatile-read', 1],
    ]);
  });
});
