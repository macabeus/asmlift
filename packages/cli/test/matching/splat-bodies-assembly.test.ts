// asmlift's OWN ASSEMBLY OF A PROJECT FILE (src/splat-bodies.ts `controlledSources` + `assembleWith`)
// with the real GNU as, against the object fixtures the offline project-asm body tests fake it with
// (offline/splat-bodies-fake.ts). A fixture that said more or less than gas does would make those
// tests prove nothing.
import { TOOLCHAIN } from '@asmlift/toolchains';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { type ElfImage, readElfImage } from '../../src/elf-bodies';
import {
  type BodyAssemble,
  MARKER_PRELUDE,
  assembleWith,
  assemblesToLinked,
  controlledSources,
} from '../../src/splat-bodies';
import { fakeAssembly } from '../offline/splat-bodies-fake';

const OFFLINE = join(import.meta.dirname, '../offline/fixtures');
// the pinned toolchain's assembler, which is what `assembleWith()` defaults to (ASMLIFT_ARM_AS, else
// arm-none-eabi-as)
const GAS = assembleWith(TOOLCHAIN.as);

/** Whether either dialect of `text` assembles (by `assemble`) to `callee`'s linked code. */
const isBody = async (assemble: BodyAssemble, linked: ElfImage, text: string, callee: string) => {
  for (const source of controlledSources(text) ?? []) {
    const object = await assemble(source, callee);
    if (object !== undefined && assemblesToLinked(linked, object, callee)) {
      return true;
    }
  }
  return false;
};

describe('the real assembly reads each fixture as its fake does', () => {
  test('splat-bodies: rd0, rd1, fw and sel are their linked code; the others are not', async () => {
    const dir = join(OFFLINE, 'splat-bodies');
    const linked = readElfImage(readFileSync(join(dir, 'linked.elf')))!;
    const text = (n: string) => readFileSync(join(dir, 'asm/nonmatchings/m', `${n}.s`), 'latin1');
    const got: Record<string, [boolean, boolean]> = {};
    for (const n of ['rd0', 'rd1', 'fw', 'sel', 'stale', 'wk', 'wrongbl']) {
      got[n] = [
        await isBody(GAS, linked, text(n), n),
        await isBody(fakeAssembly(join(dir, 'obj')), linked, text(n), n),
      ];
    }
    expect(got).toEqual({
      rd0: [true, true],
      rd1: [true, true],
      fw: [true, true],
      sel: [true, true],
      stale: [false, false],
      wk: [false, false],
      wrongbl: [false, false],
    });
  });
  test('splat-bodies-probes: every object fixture is what gas writes, and a missing one is a refusal', async () => {
    const dir = join(OFFLINE, 'splat-bodies-probes');
    for (const f of readdirSync(join(dir, 'asm'))) {
      const name = f.replace(/\.s$/, '');
      const sources = controlledSources(readFileSync(join(dir, 'asm', f), 'latin1'));
      if (sources === undefined) {
        // t1-t6 hold macro machinery: never assembled (below)
        expect(name).toMatch(/^t[1-6]$/);
        continue;
      }
      for (const [k, dialect] of ['divided', 'unified'].entries()) {
        const real = await GAS(sources[k], 'cal');
        let fixture: Uint8Array | undefined;
        try {
          fixture = new Uint8Array(readFileSync(join(dir, 'obj', `${name}.${dialect}.o`)));
        } catch {
          fixture = undefined;
        }
        expect(real === undefined ? undefined : Buffer.from(real), `${name} ${dialect}`).toEqual(
          fixture === undefined ? undefined : Buffer.from(fixture),
        );
      }
    }
  });
  // the review's t2 and t5 define `movs` under a name only gas's expansion spells: assembled as they
  // stand they ARE the shadowed link's code, so refusing macro machinery is what keeps them no body
  test('t2 and t5, assembled despite the rule, match the shadowed link', async () => {
    const dir = join(OFFLINE, 'splat-bodies-probes');
    const linked = readElfImage(readFileSync(join(dir, 'elf/shadowed.elf')))!;
    for (const t of ['t2', 't5']) {
      const text = readFileSync(join(dir, 'asm', `${t}.s`), 'latin1');
      expect(controlledSources(text), t).toBeUndefined();
      const either = async (assemble: BodyAssemble) => {
        for (const d of ['divided', 'unified']) {
          const object = await assemble(`${MARKER_PRELUDE}\n.syntax ${d}\n${text}\n`, 'cal');
          if (object !== undefined && assemblesToLinked(linked, object, 'cal')) {
            return true;
          }
        }
        return false;
      };
      expect(await either(GAS), t).toBe(true);
    }
  });
  test('a text that .includes anything is assembled in no dialect', () => {
    expect(controlledSources('\t.include "include/macros.inc"\n')).toBeUndefined();
  });
});
