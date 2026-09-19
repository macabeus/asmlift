// MIPS branch-likely (`beql`/`bnel`/`b*zl`): the delay slot is NULLIFIED when the branch is not
// taken, so it is CONDITIONAL code, not the ordinary always-executed slot. Reading it as ordinary
// emits C that compiles and is wrong (`absi` would return `-x` for every `x >= 0`), which is why
// every shape this frontend cannot place refuses loudly instead.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { MIPS_GCC } from '../src/target';

/** Wrap objdump-shaped body lines (already `addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (...lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

const lift =
  (...lines: string[]) =>
  () =>
    decompile('f', obj(...lines), MIPS_GCC).source;

test('each unmodelled MIPS control transfer names ITS OWN gap, not a shared catch-all', () => {
  // A branch-likely and an FP condition-code branch are different gaps: the first needs the
  // nullified-slot model, the second needs `fcc`. One message for both misattributes whichever is
  // not being worked on.
  expect(lift('0:\tbc1t\t8 <f+0x8>', '4:\tnop', '8:\tjr\tra', 'c:\tnop')).toThrow(
    /floating-point condition-code branch 'bc1t' at 0x0 — the FP condition code is not modelled/,
  );
  expect(lift('0:\tbc1fl\t8 <f+0x8>', '4:\tnop', '8:\tjr\tra', 'c:\tnop')).toThrow(
    /floating-point condition-code branch 'bc1fl' at 0x0 — the FP condition code is not modelled/,
  );
  // `bltzall` is branch-likely AND link: it is a call, and calls have their own refusal.
  expect(lift('0:\tbltzall\ta0,8 <f+0x8>', '4:\tnop', '8:\tjr\tra', 'c:\tnop')).toThrow(
    /unmodelled control transfer 'bltzall' at 0x0/,
  );
});

test('a branch-likely refusal names the nullified slot, separately from the FP gap', () => {
  expect(lift('0:\tmove\tv0,a0', '4:\tbltzl\tv0,c <f+0xc>', '8:\tnegu\tv0,v0', 'c:\tjr\tra', '10:\tnop')).toThrow(
    /branch-likely 'bltzl' at 0x4/,
  );
});
