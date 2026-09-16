// THE TWO POWERPC OBJDUMP FLAG LISTS ARE ONE DECISION, WRITTEN TWICE. `@asmlift/cli`'s
// `objfile.ts` is self-contained by design — it knows objdump binary names and flags and takes no
// toolchain dependency — so the mwcc toolchain's `objdumpFlags` and the CLI's `PPC_DISASM_FLAGS`
// are separate literals that must agree: the CLI's `--score-against` compares a user's object
// against a harness-built one, and a one-sided edit would disassemble them at different dialects.
//
// Neither site's own test can see that. Each is proven by a mutation that leaves the other green,
// so the drift this forbids is exactly the drift nothing else would catch. The list is per IMAGE,
// not per CodeWarrior build: all three builds disassemble with the image's one objdump, so there is
// one list to keep in step however many builds are mounted.
//
// TOOLCHAIN-FREE: both imports are plain constant arrays — no spawn, no Docker, no CodeWarrior.
import { PPC_DISASM_FLAGS } from '@asmlift/cli/objfile';
import { expect, test } from 'vitest';

import { MWCC_PPC_TOOLCHAIN } from '../src/toolchain';

test('the CLI and the mwcc toolchain disassemble PowerPC with identical flags', () => {
  expect(PPC_DISASM_FLAGS).toEqual(MWCC_PPC_TOOLCHAIN.objdumpFlags);
  // Pinned positively too, so a matching pair of WRONG lists cannot pass: `-r` carries the
  // relocation a `bl`'s callee name lives in, `-M gekko` names CodeWarrior's machine.
  expect(PPC_DISASM_FLAGS).toEqual(['-d', '-r', '-M', 'gekko', '--no-show-raw-insn']);
});
