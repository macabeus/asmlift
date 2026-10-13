// The Regime-B jump-table recognizers (frontend/ppc.ts `recoverPpcJumpTables`, frontend/mips.ts
// `recoverMipsJumpTables`) against the shapes compilers schedule around the dispatch. Each fixture is
// hand-written objdump text in the compiled shape, and each refusal is a one-instruction edit of an
// accepted fixture, so what declines is the edit and nothing else.
import { expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';

/** An objdump listing of `f` from instruction lines, four bytes apart. `L:` on its own line labels the
 *  next instruction; `@L` in an operand is that label's address; `#HA sym` / `#LO sym` after an
 *  instruction attaches that relocation. Returns the listing and the label addresses. */
function listing(lines: string[]): { asm: string; at: Map<string, number> } {
  const at = new Map<string, number>();
  let pc = 0;
  for (const l of lines) {
    if (l.endsWith(':')) {
      at.set(l.slice(0, -1), pc);
    } else {
      pc += 4;
    }
  }
  const out = ['00000000 <f>:'];
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
