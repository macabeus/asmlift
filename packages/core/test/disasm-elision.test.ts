// The shared objdump reader accounts for every word the listing carries. Two lines could take one
// away silently, and both are program text: objdump's `...` — a run of ZERO words it declined to
// print, which on MIPS is GCC's `mflo` hazard pad, i.e. `nop`s — and a line whose mnemonic column
// holds an encoding the reader cannot name. Dropping either leaves the instruction list one word
// short while every later address keeps its value, and the readers of that list ask about
// addresses: the delay slot at `branch + 4` above all, where the answer decides whether a
// nullified slot is conditional code or an arm the function always runs.
import { expect, test } from 'vitest';

import { parseDisasm } from '../src/frontend/disasm';

const mips = { zeroWord: 'nop' };

test("objdump's `...` comes back as the zero words it stands for", () => {
  const ins = parseDisasm('   0:\tmult\ta2,a0\n   4:\tmflo\ta2\n\t...\n  10:\tbnezl\tv0,14 <f+0x14>\n', mips);
  expect(ins.map((i) => [i.addr, i.mnemonic])).toEqual([
    [0, 'mult'],
    [4, 'mflo'],
    [8, 'nop'],
    [0xc, 'nop'],
    [0x10, 'bnezl'],
  ]);
});

test('a TRAILING `...` bounds nothing, so nothing is invented for it', () => {
  // The run after the last word objdump printed is the padding to the next symbol: its length is
  // not in the listing, and no reader asks about an address past the function's last instruction.
  expect(parseDisasm('   0:\tjr\tra\n   4:\tnop\n\t...\n', mips).map((i) => i.addr)).toEqual([0, 4]);
});

test('an elision whose extent cannot be known refuses by name, rather than losing the words', () => {
  // A zero word is `sll zero,zero,0` on MIPS but not an instruction at all on PowerPC, whose
  // frontend supplies no decoding — so there the run cannot be spelled.
  expect(() => parseDisasm('   0:\tlis\tr3,0\n\t...\n  10:\tblr\n', { relocs: true })).toThrow(
    /elided a run of zero words \('\.\.\.'\) at 0x4, but a zero word is not a decodable instruction/,
  );
  // Where the run BEGINS is the word after the last instruction parsed; with no instruction before
  // it, the listing does not say.
  expect(() => parseDisasm('\t...\n  10:\tjr\tra\n', mips)).toThrow(
    /elided a run of zero words \('\.\.\.'\) before the first instruction of the listing, ending at 0x10/,
  );
  // A gap that is not a whole number of words is not a run of words.
  expect(() => parseDisasm('   0:\tnop\n\t...\n   6:\tnop\n', mips)).toThrow(
    /elided a run of zero words \('\.\.\.'\) between 0x4 and 0x6, which is not a whole number of instruction words/,
  );
});

test('a line that carries an address but no readable instruction refuses', () => {
  expect(() => parseDisasm('   0:\tnop\n   4:\t0x4500ffff\n   8:\tjr\tra\n', mips)).toThrow(
    /objdump line '4:\t0x4500ffff' carries an address but no instruction this reader can decode/,
  );
  // Lines that carry no address carry no word: the listing's own prologue and headers pass through.
  expect(parseDisasm('a.o:     file format elf32-tradbigmips\n\n00000000 <f>:\n   0:\tjr\tra\n', mips)).toHaveLength(1);
});
