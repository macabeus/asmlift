// A REAL object whose code lives in several sections all named `.text`, all starting at address 0:
// Animal Crossing's `m_choice.o`, one of the 197 such objects among that project's 4,103. What the
// whole-object disassembly says about a function there is not what the object's symbol table says,
// and `sliceSymbol` — the seam every objdump-reading frontend goes through — believes the text.
import { sliceSymbol } from '@asmlift/core/frontend/disasm';
import { ppcDisasmText } from '@asmlift/toolchains';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { codeSections, scopedObjectPath } from '../../src/elf-section';
import { ppcDockerGate } from './docker-gate';

const OBJECT = resolve(
  import.meta.dirname,
  '../../../../apps/benchmark/checkouts/ac-decomp/build/GAFE01_00/foresta/obj/game/m_choice.o',
);

function gate(): boolean {
  if (!existsSync(OBJECT)) {
    console.warn(
      `[multi-text-object] ${OBJECT} is absent — skipping. Remedy: clone macabeus/ac-decomp into ` +
        'apps/benchmark/checkouts/ac-decomp and build it (python3 configure.py && ninja).',
    );
    return false;
  }
  return ppcDockerGate('multi-text-object', 'mwcc_242_81');
}

describe.runIf(gate())('m_choice.o, eight `.text` sections', () => {
  // The pooled container reaches the host's /tmp, so the object and its scoped copy live there.
  const dir = mkdtempSync('/tmp/asmlift-multitext-');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(OBJECT, join(dir, 'm_choice.o'));
  const whole = ppcDisasmText('mwcc_242_81', dir, 'm_choice.o');
  const scoped = (sym: string) =>
    ppcDisasmText('mwcc_242_81', dir, basename(scopedObjectPath(join(dir, 'm_choice.o'), sym, dir)));

  test('the object really does hold several code sections, and the dump one block each', () => {
    expect(codeSections(readFileSync(OBJECT))).toEqual({ count: 8, ambiguous: true });
    expect(whole.match(/^Disassembly of section \.text:$/gm)).toHaveLength(8);
    expect(scoped('mChoice_dt').match(/^Disassembly of section \.text:$/gm)).toHaveLength(1);
  });

  test('mChoice_dt — `blr` in the first section — reads as itself and stops there', () => {
    // The whole-object slice runs off the end of the block it started in, because the next `<sym>:`
    // line is in the NEXT section.
    expect(sliceSymbol(whole, 'mChoice_dt')).toContain('Disassembly of section');
    expect(sliceSymbol(scoped('mChoice_dt'), 'mChoice_dt')).toBe('000001d8 <mChoice_dt>:\n 1d8:\tblr\n');
  });

  test('a function the whole-object dump labels in the wrong section reads as itself', () => {
    // `mChoice_MainSetup_Hide` is at 0x20 of the FOURTH section; the first section has no symbol at
    // 0x20, so objdump hangs the name on a `bge` in the middle of `mChoice_MainSetup`.
    expect(sliceSymbol(whole, 'mChoice_MainSetup_Hide')).toContain('bge');
    const own = sliceSymbol(scoped('mChoice_MainSetup_Hide'), 'mChoice_MainSetup_Hide');
    expect(own).toContain('stwu    r1,-16(r1)');
    expect(own).toContain('R_PPC_REL24\tmChoice_init');
    expect(own.trimEnd().endsWith('blr')).toBe(true);
  });

  test('a function the whole-object dump never labels becomes readable', () => {
    // Another symbol shares its address in its own section, so the name appears nowhere in the dump
    // and the lift declines on a function the object plainly defines.
    expect(() => sliceSymbol(whole, 'mChoice_sound_SENTAKU_OPEN')).toThrow(/not found in the disassembly/);
    expect(sliceSymbol(scoped('mChoice_sound_SENTAKU_OPEN'), 'mChoice_sound_SENTAKU_OPEN')).toContain(
      'R_PPC_REL24\tsAdo_SysTrgStart',
    );
  });
});
