// The MACHINE the PowerPC disassembly names. CodeWarrior compiles for Gekko (`-proc gekko`), the
// GameCube's 750CL, whose paired-single opcodes REUSE encodings that later POWER chips spend on
// VSX/AltiVec. objdump's generic PowerPC dialect therefore decodes Gekko code into a DIFFERENT
// instruction rather than failing, and re-reads its fields as that instruction's: a `psq_l
// f30,120(r1),0,0` prints as `lq r30,112(r1)`, another register file at another offset. Both sides
// of that are asserted here, on real CodeWarrior output.
//
// What goes wrong downstream is a decline, not a silent miscompile — the PPC frontend models
// neither spelling, so either way the instruction becomes an `opaque` or throws (frontend/
// opaque.ts). The cost is that the decline names an instruction that is NOT in the reader's own
// object, and that m2c — which models `psq_l`/`psq_st` and nothing called `lq`/`xxsel`/`xscmpeqdp`
// — is handed text it cannot recognise.
//
// The fixture is the smallest function that reaches it: a float held across a call forces mwcc to
// callee-save f31, and the GameCube ABI saves such a register as a PAIR — `stfd` for the low half,
// `psq_st` for the high one. Five Mario Party 4 picks carry this prologue. (The `psq_l` half of
// THIS pair survives the generic dialect: `lq` needs an even destination register, and f31 is odd.
// The `lq` misread above is measured on the even-register restores real objects are full of.)
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { MWCC_PPC_TOOLCHAIN, compilePpcTarget } from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';

const HAVE = ppcDockerGate('ppc-gekko', 'mwcc_242_81');

// A float argument returned after a call: `x` must survive `side()`, so it lands in f31 and the
// prologue saves f31's two halves.
const FLOAT_CALLEE_SAVE = `extern int side(int);
float keepf(float x, int n) {
  side(n);
  return x + 1.0f;
}`;

/** The same object through the same image's objdump at the GENERIC PowerPC dialect — spelled out
 *  rather than derived from MWCC_PPC_TOOLCHAIN, so this stays the before-picture of the flag. */
function disasmWithoutMachine(obj: string): string {
  const t = MWCC_PPC_TOOLCHAIN;
  const r = spawnSync(
    t.docker,
    // prettier-ignore
    ['run', '--rm', '--platform', 'linux/386', '-v', `${dirname(obj)}:/work:ro`, t.image,
     t.objdump, '-d', '-r', '--no-show-raw-insn', `/work/${basename(obj)}`],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`objdump (no machine flag) failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

describe.runIf(HAVE)('PowerPC disassembly names the Gekko machine', () => {
  test('a float callee-save prologue decodes as psq_st/psq_l — and as VSX without -M gekko', () => {
    const { obj, asm } = compilePpcTarget(
      'mwcc_242_81',
      FLOAT_CALLEE_SAVE,
      'keepf',
      TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags,
    );

    // What the harness feeds the frontend, at the toolchain's flags. The stack offset is mwcc's
    // frame layout, not this flag's business, so it is left open.
    expect(asm).toMatch(/psq_st\s+f31,\d+\(r1\),0,0/);
    expect(asm).toMatch(/psq_l\s+f31,\d+\(r1\),0,0/);
    expect(asm).not.toContain('vs31');

    // The before-picture: a plausible instruction at the wrong operands, not a refusal. WHICH VSX
    // instruction the encoding lands on is a property of the image's binutils, so only the
    // register file it names is pinned.
    const generic = disasmWithoutMachine(obj);
    expect(generic).toMatch(/vs31/);
    expect(generic).not.toContain('psq_st');
  });
});
