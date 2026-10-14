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
const ppcSwitch = (between: string[], dispatch?: string[]) => ppcBoundsWindow(['cmplwi  r3,3', ...between], dispatch);

/** The same dispatch with `bounds` written out whole before the bounds branch. */
const ppcBoundsWindow = (bounds: string[], dispatch?: string[]) =>
  listing([
    ...bounds,
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

test('…nor past a branch that lands after the compare, which brings a compare of its own', () => {
  const bctr = /unmodelled control transfer 'bctr'/;
  // `cmplwi r3,1 ; bge- L` reaches the bounds branch with cr0 from a compare against 1: f(2) and
  // f(3) take the default there, so the switch bounded by `cmplwi r3,3` would be wrong C.
  for (const window of [
    ['cmplwi  r3,1', 'bge-    @L', 'cmplwi  r3,3', 'L:'],
    ['cmplwi  r3,1', 'bge-    @L', 'cmplwi  r3,3', 'li      r6,0', 'L:'],
    ['cmplwi  r3,1', 'bge-    @L', 'cmplwi  r3,3', 'L:', 'li      r6,0'],
  ]) {
    const { asm, at } = ppcBoundsWindow(window);
    expect(() => liftPpc({ asm, at })).toThrow(bctr);
  }
  // a table's case landing there is a branch target too
  const { asm, at } = ppcBoundsWindow(['cmplwi  r3,3', 'L:', 'li      r6,0']);
  expect(() =>
    decompile('f', asm, PPC_MWCC, { asmData: ppcTable([at.get('L')!, at.get('C1')!, at.get('C2')!, at.get('C3')!]) }),
  ).toThrow(bctr);
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
const mipsTable = (luiAddr: number, cases: number[], loAddr?: number): AsmData => {
  const bytes = new Uint8Array(cases.length * 4);
  cases.forEach((a, k) => new DataView(bytes.buffer).setUint32(k * 4, a));
  return {
    sections: new Map([['.rodata', bytes]]),
    relocs: [
      { section: '.text', offset: luiAddr, type: 'R_MIPS_HI16', sym: 'jt', addend: 0 },
      ...(loAddr === undefined
        ? []
        : [{ section: '.text', offset: loAddr, type: 'R_MIPS_LO16', sym: 'jt', addend: 0 }]),
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

/** mwcc 2.3.3's loop-hoisted table base: `lis r5 ; addi r5,r5` ahead of the dispatch, `before` the
 *  pair and `after` it, `between` inside it. */
const ppcHoisted = (before: string[], after: string[] = [], base = 'r5', between: string[] = []) =>
  listing([
    ...before,
    `lis     ${base},0 #HA tbl`,
    ...between,
    `addi    ${base},${base},0 #LO tbl`,
    ...after,
    'cmplwi  r3,3',
    'bgt-    @DEF',
    'slwi    r0,r3,2',
    `lwzx    r0,${base},r0`,
    'mtctr   r0',
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

test('a PPC table base formed outside the dispatch block lifts when it reaches the dispatch on every path', () => {
  // the `@N` pool name mwcc gives the table never reaches the naming policy: the pair is the base
  const src = liftPpc(ppcHoisted([], ['li      r6,0']));
  expect(src).toContain('switch (a0)');
  for (const k of [10, 20, 30, 40]) {
    expect(src).toContain(`return ${k};`);
  }
  // in whatever register the allocator chose — a callee-saved one, or an argument register whose
  // argument is dead (mwcc 2.3.3 puts a second loop's base in r4) — and with its halves apart
  for (const shape of [
    ppcHoisted([], [], 'r31'),
    ppcHoisted([], [], 'r4'),
    ppcHoisted([], [], 'r5', ['li      r6,0']),
  ]) {
    expect(liftPpc(shape)).toContain('switch (a0)');
  }
});

test('…and refuses a base some path does not bring, or anything else reads', () => {
  const proof =
    /reads the base of jump table 'tbl'\+0 from r5, and r5 does not hold that table's address on every path/;
  // a rewrite of the base after the pair
  expect(() => liftPpc(ppcHoisted([], ['li      r5,4']))).toThrow(proof);
  // a path around the pair reaches the dispatch with the caller's r5
  expect(() => liftPpc(ppcHoisted(['cmpwi   r4,0', 'beq-    @AROUND'], ['AROUND:']))).toThrow(proof);
  // another reader: the base is no value
  expect(() => liftPpc(ppcHoisted([], ['stw     r5,0(r4)']))).toThrow(
    /'tbl'\+0's base, formed at 0x4, is read from r5 as a value/,
  );
});

test('a `bgtlr` bound sends the default to a return of what r3 holds', () => {
  // mwcc bounds a leaf switch whose default falls straight out with a conditional return; the
  // out-of-range value is returned unchanged here, as `return x;` after the switch compiles.
  const { asm, at } = ppcSwitch([]);
  const src = liftPpc({ asm: asm.replace(/bgt-\s+\S+ <f\+0x\w+>/, 'bgtlr-'), at });
  expect(src).toContain('switch (a0)');
  expect(src).toMatch(/default:\s*\n\s*return a0;/);
  for (const k of [10, 20, 30, 40]) {
    expect(src).toContain(`return ${k};`);
  }
  // the bound is still the `cmplwi` the conditional return reads
  const cr1 = asm.replace(/bgt-\s+\S+ <f\+0x\w+>/, 'bgtlr-').replace('cmplwi  r3,3', 'cmplwi  cr1,r3,3');
  expect(() => liftPpc({ asm: cr1, at })).toThrow(/unmodelled control transfer 'bctr'/);
});

test('a return nothing wrote r3 for still returns r3, when another return hands back a word', () => {
  // `int f(int a, unsigned x) { switch (x) { case 0: return 10; … default: return a; } }`: the
  // `bgtlr` default never touches r3, so it returns the caller's r3 — the first argument.
  const { asm, at } = ppcBoundsWindow(
    ['cmplwi  r4,3'],
    ['lis     r5,0 #HA tbl', 'slwi    r0,r4,2', 'addi    r5,r5,0 #LO tbl', 'lwzx    r0,r5,r0', 'mtctr   r0'],
  );
  const src = liftPpc({ asm: asm.replace(/bgt-\s+\S+ <f\+0x\w+>/, 'bgtlr-'), at });
  expect(src).toContain('switch (a1)');
  expect(src).toMatch(/default:\s*\n\s*return a0;/);
  // `if (x) return a; … return 5;` — the same conditional return, outside a switch
  const condret = listing(['cmpwi   r4,0', 'bnelr-', 'li      r0,1', 'stw     r0,0(r5)', 'li      r3,5', 'blr']);
  const cond = decompile('f', condret.asm, PPC_MWCC).source;
  expect(cond).toContain('return a0;');
  expect(cond).toContain('return 5;');
  expect(cond).not.toMatch(/return;/);
  // a function no return hands a word back stays void
  const bare = listing(['cmpwi   r4,0', 'bnelr-', 'li      r0,1', 'stw     r0,0(r5)', 'blr']);
  expect(decompile('f', bare.asm, PPC_MWCC).source).toMatch(/^void f\(/m);
});

test('a return nothing wrote r3 for mints no parameter the caller never passed', () => {
  // `void f(void) { int *p = &gB; if (gA & 2) return; *p = *p + 1; }`: mwcc's temporary `lwz r3`
  // makes the other path return a word, but no argument register is live in, so r3 is no argument.
  const lines = [
    'lis     r4,0 #HA gB',
    'lis     r5,0 #HA gA',
    'addi    r4,r4,0 #LO gB',
    'addi    r5,r5,0 #LO gA',
    'lwz     r0,0(r5)',
    'rlwinm. r0,r0,0,30,30',
    'bnelr-',
    'lwz     r3,0(r4)',
    'addi    r0,r3,1',
    'stw     r0,0(r4)',
    'blr',
  ];
  const noArg = decompile('f', listing(lines).asm, PPC_MWCC).source;
  expect(noArg).toMatch(/^\w+ f\(void\)/m);
  expect(noArg).not.toContain('a0');
  // the declared `void f(void)` decides it too
  const declared = { prototypes: { f: { params: [], returnsVoid: true } } };
  expect(decompile('f', listing(lines).asm, PPC_MWCC, declared).source).toMatch(/^void f\(void\)/m);
  // a declared first parameter makes r3 an argument, read or not
  const withArg = { prototypes: { f: { params: ['s32'], returns: 's32' } } };
  expect(decompile('f', listing(lines).asm, PPC_MWCC, withArg).source).toContain('return a0;');
});

/** KMC's / gcc 2.7.2's loop with the table base hoisted into the preheader: `lui t6 ; addiu t6,t6`
 *  before the loop, the dispatch adding t6 inside it. `pre` runs before the pair, `mid` inside it,
 *  `post` after it,
 *  `arm` is case 3's body. */
const mipsLoop = (o: { pre?: string[]; mid?: string[]; post?: string[]; arm?: string[]; base?: string } = {}) => {
  const b = o.base ?? 't6';
  return listing(
    [
      'blez\ta0,@END',
      'sll\tv0,a0,0x2',
      ...(o.pre ?? []),
      'LUI:',
      `lui\t${b},0x0`,
      ...(o.mid ?? []),
      'LO:',
      `addiu\t${b},${b},0`,
      ...(o.post ?? []),
      'addu\ta0,v0,a1',
      'LOOP:',
      'lw\tv1,0(a1)',
      'sltiu\tv0,v1,4',
      'beqz\tv0,@NEXT',
      'sll\tv0,v1,0x2',
      `addu\tv0,v0,${b}`,
      'lw\tv0,0(v0)',
      'jr\tv0',
      'nop',
      'C0:',
      'j\t@NEXT',
      'sw\ta2,0(a1)',
      'C1:',
      'j\t@NEXT',
      'sw\ta3,0(a1)',
      'C2:',
      'j\t@NEXT',
      'sw\tzero,0(a1)',
      'C3:',
      ...(o.arm ?? ['sw\ta2,4(a1)']),
      'NEXT:',
      'addiu\ta1,a1,4',
      'slt\tv0,a1,a0',
      'bnez\tv0,@LOOP',
      'nop',
      'END:',
      'jr\tra',
      'nop',
    ],
    MIPS_HEAD,
  );
};

const liftMipsLoop = ({ asm, at }: ReturnType<typeof listing>) =>
  decompile('f', asm, MIPS_GCC, {
    asmData: mipsTable(
      at.get('LUI')!,
      ['C0', 'C1', 'C2', 'C3'].map((k) => at.get(k)!),
      at.get('LO')!,
    ),
  }).source;

test('a MIPS table base hoisted into the loop preheader lifts when it reaches the dispatch on every path', () => {
  // a temporary or a saved register, the halves apart
  for (const shape of [{}, { base: 's1' }, { mid: ['nop'] }]) {
    const src = liftMipsLoop(mipsLoop(shape));
    expect(src).toContain('switch (');
    expect(src).toMatch(/case 2:\s*\n\s*\*\w+ = 0;/);
  }
});

test('…and refuses a base some path does not bring, or anything else reads', () => {
  const proof = /reads the base of jump table 'jt'\+0 from t6, and t6 does not hold that table's address on every path/;
  // a path around the pair reaches the dispatch with whatever t6 held
  expect(() => liftMipsLoop(mipsLoop({ pre: ['bnez\ta3,@LOOP', 'nop'] }))).toThrow(proof);
  // a rewrite of the base on one path round the loop
  expect(() => liftMipsLoop(mipsLoop({ arm: ['li\tt6,4'] }))).toThrow(proof);
  // (a call that destroys a temporary base is the SSA's `noteCall`: test/ssa-every-reaching-def.test.ts)
  // another reader: the base is no value. Read in the loop, it is read through the join the loop
  // header makes, which is then what reaches the dispatch.
  expect(() => liftMipsLoop(mipsLoop({ arm: ['sw\tt6,4(a1)'] }))).toThrow(proof);
});

/** IDO's rotated `while` loop: the bounds `sltiu` in the delay slot of the loop-entry `beqz` and in
 *  the likely slot of the latch `bnezl`, none in the bounds block itself. `entry`/`latch` replace
 *  the two slots. */
const idoWhile = (o: { entry?: string; latch?: string; latchOp?: string } = {}) =>
  listing(
    [
      'lw\tv0,0(a0)',
      'move\tv1,zero',
      'beqz\tv0,@END',
      o.entry ?? 'sltiu\tat,v0,4',
      'BOUND:',
      'beqz\tat,@NEXT',
      'addiu\ta0,a0,4',
      'sll\tt6,v0,0x2',
      'LUI:',
      'lui\tat,0x0',
      'addu\tat,at,t6',
      'lw\tt6,0(at)',
      'jr\tt6',
      'nop',
      'C0:',
      'b\t@NEXT',
      'addiu\tv1,v1,1',
      'C1:',
      'b\t@NEXT',
      'addiu\tv1,v1,5',
      'C2:',
      'b\t@NEXT',
      'xori\tv1,v1,0x6',
      'C3:',
      'addiu\tv1,v1,7',
      'NEXT:',
      'lw\tv0,0(a0)',
      `${o.latchOp ?? 'bnezl'}\tv0,@BOUND`,
      o.latch ?? 'sltiu\tat,v0,4',
      'END:',
      'jr\tra',
      'move\tv0,v1',
    ],
    MIPS_HEAD,
  );

test('an IDO bound in the delay slots of the edges into its block lifts', () => {
  const src = liftMips(idoWhile(), MIPS_IDO);
  expect(src).toMatch(/switch \(\w+\)/);
  expect(src).toMatch(/case 1:\s*\n\s*\w+ = \w+ \+ 5;/);
});

test('…and refuses an edge that does not run the same bound', () => {
  const jr = /indirect jump 'jr t6'/;
  // the latch bounds by another count
  expect(() => liftMips(idoWhile({ latch: 'sltiu\tat,v0,5' }), MIPS_IDO)).toThrow(jr);
  // the entry edge runs something else in that slot
  expect(() => liftMips(idoWhile({ entry: 'nop' }), MIPS_IDO)).toThrow(jr);
  // an ordinary latch branch runs its slot on the not-taken edge too, but the likely one is what
  // keeps the fall-through edge out: here the entry edge is a likely branch's not-taken edge, which
  // annuls the slot
  const annulled = idoWhile();
  expect(() =>
    liftMips({ ...annulled, asm: annulled.asm.replace(/beqz\tv0,(\S+ <f\+0x\w+>)\n/, 'beqzl\tv0,$1\n') }, MIPS_IDO),
  ).toThrow(jr);
});
