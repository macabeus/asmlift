// The Regime-B jump-table recognizers (frontend/ppc.ts `recoverPpcJumpTables`, frontend/mips.ts
// `recoverMipsJumpTables`) against the shapes compilers schedule around the dispatch. Each fixture is
// hand-written objdump text in the compiled shape, and each refusal is a one-instruction edit of an
// accepted fixture, so what declines is the edit and nothing else.
import { expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO, PPC_MWCC } from '../src/target';

/** An objdump listing of `f` from instruction lines, four bytes apart. `L:` on its own line labels the
 *  next instruction; `@L` in an operand is that label's address; `#HA sym` / `#LO sym` after an
 *  instruction attaches that PPC relocation. Returns the listing and the label addresses. */
function listing(lines: string[], head = '00000000 <f>:'): { asm: string; at: Map<string, number> } {
  const at = new Map<string, number>();
  let pc = 0;
  for (const l of lines) {
    if (l.endsWith(':')) {
      at.set(l.slice(0, -1), pc);
    } else {
      pc += 4;
    }
  }
  const out = [head];
  pc = 0;
  for (const l of lines) {
    if (l.endsWith(':')) {
      continue;
    }
    const [ins, reloc] = l.split(' #');
    const text = ins.replace(
      /@(\w+)/g,
      (_, k: string) => `${at.get(k)!.toString(16)} <f+0x${at.get(k)!.toString(16)}>`,
    );
    out.push(`${pc.toString(16).padStart(4)}:\t${text}`);
    if (reloc) {
      const [kind, sym] = reloc.split(' ');
      out.push(`\t\t\t${(pc + 2).toString(16)}: R_PPC_ADDR16_${kind}\t${sym}`);
    }
    pc += 4;
  }
  return { asm: out.join('\n'), at };
}

/** The `.data` side table of a PPC jump table `tbl` whose entries are the given `.text` addresses. */
const ppcTable = (cases: number[]): AsmData => ({
  sections: new Map([['.data', new Uint8Array(cases.length * 4)]]),
  relocs: cases.map((addend, k) => ({ section: '.data', offset: k * 4, type: 'R_PPC_ADDR32', sym: 'f', addend })),
  symbols: new Map([
    ['tbl', { section: '.data', value: 0, size: cases.length * 4, index: 1 }],
    ['f', { section: '.text', value: 0, size: 0x100, index: 2 }],
  ]),
  symbolCount: 2,
  bigEndian: true,
});

/** mwcc's 4-arm dispatch, `between` scheduled between the bounds compare and its branch. */
const ppcSwitch = (between: string[], dispatch?: string[]) =>
  listing([
    'cmplwi  r3,3',
    ...between,
    'bgt-    @DEF',
    ...(dispatch ?? [
      'lis     r4,0 #HA tbl',
      'slwi    r0,r3,2',
      'addi    r4,r4,0 #LO tbl',
      'lwzx    r0,r4,r0',
      'mtctr   r0',
    ]),
    'bctr',
    'C0:',
    'li      r3,10',
    'blr',
    'C1:',
    'li      r3,20',
    'blr',
    'C2:',
    'li      r3,30',
    'blr',
    'C3:',
    'li      r3,40',
    'blr',
    'DEF:',
    'li      r3,0',
    'blr',
  ]);

const liftPpc = ({ asm, at }: ReturnType<typeof listing>) =>
  decompile('f', asm, PPC_MWCC, { asmData: ppcTable(['C0', 'C1', 'C2', 'C3'].map((k) => at.get(k)!)) }).source;

test('mwcc schedules into the bounds pair, and the compare is still found', () => {
  // `li r6,0` is sw_jtret's default value, `stw r0,20(r1)` callret8's LR save: neither writes a CR
  // field or the scrutinee.
  for (const between of [[], ['li      r6,0'], ['stw     r0,20(r1)', 'li      r5,1']]) {
    const src = liftPpc(ppcSwitch(between));
    expect(src).toContain('switch (a0)');
    for (const k of [10, 20, 30, 40]) {
      expect(src).toContain(`return ${k};`);
    }
  }
});

test('…but not past a CR write, a scrutinee write, or a compare on another field', () => {
  const bctr = /unmodelled control transfer 'bctr'/;
  // a second compare: the `bgt` reads IT, not the bound
  expect(() => liftPpc(ppcSwitch(['cmpwi   r5,0']))).toThrow(bctr);
  // a record form sets cr0
  expect(() => liftPpc(ppcSwitch(['andi.   r5,r5,1']))).toThrow(bctr);
  // the scrutinee changes after it was bounded
  expect(() => liftPpc(ppcSwitch(['addi    r3,r3,1']))).toThrow(bctr);
  expect(() => liftPpc(ppcSwitch(['lwzu    r5,4(r3)']))).toThrow(bctr);
  // a call between them clobbers cr0 and r3
  expect(() => liftPpc(ppcSwitch(['bl      0 <f>']))).toThrow(bctr);
  // the bound is in cr1 and the branch reads cr0
  const cr1 = ppcSwitch([]);
  expect(() => liftPpc({ ...cr1, asm: cr1.asm.replace('cmplwi  r3,3', 'cmplwi  cr1,r3,3') })).toThrow(bctr);
});

test('the PPC dispatch block holds the idiom and nothing else', () => {
  const bctr = /unmodelled control transfer 'bctr'/;
  const idiom = [
    'lis     r4,0 #HA tbl',
    'slwi    r0,r3,2',
    'addi    r4,r4,0 #LO tbl',
    'lwzx    r0,r4,r0',
    'mtctr   r0',
  ];
  // a store between the bounds branch and the idiom would be pruned with the dispatch block
  expect(() => liftPpc(ppcSwitch([], ['stw     r5,0(r6)', ...idiom]))).toThrow(bctr);
  // the table's high half overwrites the scrutinee before the `slwi` scales it
  expect(() =>
    liftPpc(ppcSwitch([], ['lis     r3,0 #HA tbl', 'slwi    r0,r3,2', 'addi    r4,r3,0 #LO tbl', ...idiom.slice(3)])),
  ).toThrow(bctr);
  // a branch into the dispatch block skips the bounds check
  const into = ppcSwitch([], idiom);
  const entered = into.asm.replace('li      r3,0', `b       ${(8).toString(16)} <f+0x8>`);
  expect(() => liftPpc({ ...into, asm: entered })).toThrow(bctr);
});

const MIPS_HEAD = '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:';

/** The `.rodata` side table of a MIPS jump table `jt` addressed by the `lui` at `luiAddr`. */
const mipsTable = (luiAddr: number, cases: number[]): AsmData => {
  const bytes = new Uint8Array(cases.length * 4);
  cases.forEach((a, k) => new DataView(bytes.buffer).setUint32(k * 4, a));
  return {
    sections: new Map([['.rodata', bytes]]),
    relocs: [
      { section: '.text', offset: luiAddr, type: 'R_MIPS_HI16', sym: 'jt', addend: 0 },
      ...cases.map((_, k) => ({ section: '.rodata', offset: k * 4, type: 'R_MIPS_32', sym: '.text', addend: 0 })),
    ],
    symbols: new Map([
      ['jt', { section: '.rodata', value: 0, size: cases.length * 4, index: 1 }],
      ['.text', { section: '.text', value: 0, size: 0, index: 2 }],
    ]),
    symbolCount: 2,
    bigEndian: true,
  };
};

/** KMC's / IDO's 4-arm dispatch: `between` sits between the `sltiu` and the `beqz`, `slot` is the
 *  beqz's delay slot, `dispatch` the block up to the `jr`, `jrSlot` the `jr`'s delay slot. */
const mipsSwitch = (
  o: {
    between?: readonly string[];
    slot?: string;
    dispatch?: readonly string[];
    jrSlot?: string;
    def?: readonly string[];
  } = {},
) =>
  listing(
    [
      'sltiu\tv0,a0,4',
      ...(o.between ?? []),
      'beqz\tv0,@DEF',
      o.slot ?? 'sll\tv0,a0,0x2',
      ...(o.dispatch ?? ['LUI:', 'lui\tat,0x0', 'addu\tat,at,v0', 'lw\tv0,0(at)']),
      'jr\tv0',
      o.jrSlot ?? 'nop',
      'C0:',
      'jr\tra',
      'li\tv0,10',
      'C1:',
      'jr\tra',
      'li\tv0,20',
      'C2:',
      'jr\tra',
      'li\tv0,30',
      'C3:',
      'jr\tra',
      'li\tv0,40',
      'DEF:',
      ...(o.def ?? ['jr\tra', 'move\tv0,zero']),
    ],
    MIPS_HEAD,
  );

const liftMips = ({ asm, at }: ReturnType<typeof listing>, target = MIPS_GCC) =>
  decompile('f', asm, target, {
    asmData: mipsTable(
      at.get('LUI')!,
      ['C0', 'C1', 'C2', 'C3'].map((k) => at.get(k)!),
    ),
  }).source;

test('a MIPS dispatch lifts with what compilers schedule around it', () => {
  // IDO puts `move s0,a1` between the bound and its branch, and the scaled index or another instruction
  // in the branch's delay slot (here a dead temporary)
  for (const [shape, target] of [
    [{}, MIPS_GCC],
    [{ between: ['move\ts0,a1'] }, MIPS_IDO],
    [
      { slot: 'li\tt1,7', dispatch: ['sll\tv0,a0,0x2', 'LUI:', 'lui\tat,0x0', 'addu\tat,at,v0', 'lw\tv0,0(at)'] },
      MIPS_IDO,
    ],
  ] as const) {
    const src = liftMips(mipsSwitch(shape), target);
    expect(src).toContain('switch (a0)');
    for (const k of [10, 20, 30, 40]) {
      expect(src).toContain(`return ${k};`);
    }
  }
});

test('the MIPS dispatch block holds the idiom and nothing else', () => {
  const jr = /indirect jump 'jr v0'/;
  const idiom = ['LUI:', 'lui\tat,0x0', 'addu\tat,at,v0', 'lw\tv0,0(at)'];
  // a store in the dispatch block would be pruned with it
  expect(() => liftMips(mipsSwitch({ dispatch: ['sw\ta1,0(a2)', ...idiom] }))).toThrow(jr);
  // so would the `jr`'s own delay slot
  expect(() => liftMips(mipsSwitch({ jrSlot: 'sw\ta1,0(a2)' }))).toThrow(jr);
  // the scrutinee is rewritten after the bound and before the `sll` scales it
  expect(() => liftMips(mipsSwitch({ slot: 'addiu\ta0,a0,1', dispatch: ['sll\tv0,a0,0x2', ...idiom] }))).toThrow(jr);
  expect(() => liftMips(mipsSwitch({ between: ['addiu\ta0,a0,1'] }))).toThrow(jr);
  // the bound's flag is rewritten before the branch reads it
  expect(() => liftMips(mipsSwitch({ between: ['li\tv0,1'] }))).toThrow(jr);
  // a branch into the dispatch block skips the bounds check
  expect(() => liftMips(mipsSwitch({ def: ['b\t@LUI', 'nop'] }))).toThrow(jr);
});

test('the PPC idiom is found by register, in whatever order the block holds it', () => {
  const [lis, slwi, addi] = ['lis     r4,0 #HA tbl', 'slwi    r0,r3,2', 'addi    r4,r4,0 #LO tbl'];
  const tail = ['lwzx    r0,r4,r0', 'mtctr   r0'];
  // mwcc 2.4.2's order, GC/1.2.5n's (the low half first), and the index scaled ahead of both halves
  for (const order of [
    [lis, slwi, addi],
    [lis, addi, slwi],
    [slwi, lis, addi],
  ]) {
    expect(liftPpc(ppcSwitch([], [...order, ...tail]))).toContain('switch (a0)');
  }
  const bctr = /unmodelled control transfer 'bctr'/;
  // a second, dead `slwi` is not part of the idiom the block may hold
  expect(() => liftPpc(ppcSwitch([], ['slwi    r5,r3,2', lis, slwi, addi, ...tail]))).toThrow(bctr);
  // the index scaled from a register the block wrote first is not the bounded scrutinee
  expect(() => liftPpc(ppcSwitch([], ['lis     r3,0 #HA tbl', 'addi    r4,r3,0 #LO tbl', slwi, ...tail]))).toThrow(
    bctr,
  );
});
