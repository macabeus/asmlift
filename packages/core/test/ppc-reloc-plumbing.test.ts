// The objdump `-r` relocation record, as the PPC frontend receives it. objdump prints a relocation
// on its own line under the instruction whose operand field it fills; the frontend needs all three
// fields, because each one decides something different:
//   - the TYPE separates an `@ha` immediate half from an `@l` half from an SDA memory base, which
//     the mnemonic alone cannot (an `addi` takes both `@l` and SDA-adjacent forms);
//   - the ADDEND is part of the address — `SLSerialNo` and `SLSerialNo+0x4` are different words,
//     and marioparty4:SLSerialNoCheck carries both on adjacent instructions;
//   - the SYMBOL is the name.
// Losing any of them turns a link-time placeholder into a plausible wrong address.
import { expect, test } from 'vitest';

import { parseDisasm } from '../src/frontend/disasm';

const opts = { relocs: true, hintSuffixes: true };

test('two relocations against the same symbol keep their distinct addends', () => {
  // marioparty4:SLSerialNoCheck's real shape: the same SDA symbol at +0 and +4.
  const asm =
    '   0:\tlwz     r0,0(0)\n\t\t\t0: R_PPC_EMB_SDA21\tSLSerialNo\n' +
    '   4:\tlwz     r3,0(0)\n\t\t\t4: R_PPC_EMB_SDA21\tSLSerialNo+0x4\n';
  const ins = parseDisasm(asm, opts);
  expect(ins.map((i) => i.reloc)).toEqual([
    { type: 'R_PPC_EMB_SDA21', sym: 'SLSerialNo', addend: 0 },
    { type: 'R_PPC_EMB_SDA21', sym: 'SLSerialNo', addend: 4 },
  ]);
});

test('the two halves of one address are distinguishable by relocation type', () => {
  // ac-decomp:mFI_BGDisplayListTop's real shape. Both instructions name `g_fdinfo`; only the type
  // says which half of the address each one carries, and objdump points the offset at the 16-bit
  // immediate FIELD (addr+2), not the instruction.
  const asm =
    '   0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA\tg_fdinfo\n' +
    '   4:\taddi    r3,r3,0\n\t\t\t6: R_PPC_ADDR16_LO\tg_fdinfo\n';
  const ins = parseDisasm(asm, opts);
  expect(ins.map((i) => i.reloc?.type)).toEqual(['R_PPC_ADDR16_HA', 'R_PPC_ADDR16_LO']);
  expect(ins.map((i) => i.reloc?.sym)).toEqual(['g_fdinfo', 'g_fdinfo']);
});

test('a relocation whose offset is outside the preceding instruction FAILS LOUD', () => {
  // The attachment is positional (objdump prints the reloc after its instruction). If the offset
  // does not land inside that instruction's four bytes, the listing is not the shape assumed and
  // attaching anyway would name the wrong instruction's operand.
  const asm = '   0:\tlis     r3,0\n\t\t\t20: R_PPC_ADDR16_HA\tg_fdinfo\n';
  expect(() => parseDisasm(asm, opts)).toThrow(/0x20.*0x0/);
});

test('a second relocation on one instruction FAILS LOUD rather than overwriting the first', () => {
  const asm = '   0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA\tfirstSym\n' + '\t\t\t2: R_PPC_ADDR16_HA\tsecondSym\n';
  expect(() => parseDisasm(asm, opts)).toThrow(/two relocations/);
});

test('a negative addend is read as negative, not dropped', () => {
  const asm = '   0:\tlwz     r0,0(0)\n\t\t\t0: R_PPC_EMB_SDA21\tgSym-0x8\n';
  expect(parseDisasm(asm, opts)[0].reloc).toEqual({ type: 'R_PPC_EMB_SDA21', sym: 'gSym', addend: -8 });
});
