// asmlift's OWN ASSEMBLY OF A PROJECT FILE (src/splat-bodies.ts `controlledSources` + `assembleWith`)
// with the real GNU as, against the object fixtures the offline project-asm body tests fake it with
// (offline/splat-bodies-fake.ts). A fixture that said more or less than gas does would make those
// tests prove nothing.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { type ElfImage, readElfImage } from '../../src/elf-bodies';
import { type BodyAssemble, assembleWith, assemblesToLinked, controlledSources } from '../../src/splat-bodies';
import { fakeAssembly } from '../offline/splat-bodies-fake';

const OFFLINE = join(import.meta.dirname, '../offline/fixtures');
const GAS = assembleWith();

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
  test('splat-bodies: rd0, rd1 and sel are their linked code; the others are not', async () => {
    const dir = join(OFFLINE, 'splat-bodies');
    const linked = readElfImage(readFileSync(join(dir, 'linked.elf')))!;
    const text = (n: string) => readFileSync(join(dir, 'asm/nonmatchings/m', `${n}.s`), 'latin1');
    const got: Record<string, [boolean, boolean]> = {};
    for (const n of ['rd0', 'rd1', 'sel', 'stale', 'wk', 'wrongbl']) {
      got[n] = [
        await isBody(GAS, linked, text(n), n),
        await isBody(fakeAssembly(join(dir, 'obj')), linked, text(n), n),
      ];
    }
    expect(got).toEqual({
      rd0: [true, true],
      rd1: [true, true],
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
      const sources = controlledSources(readFileSync(join(dir, 'asm', f), 'latin1'))!;
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
  test('a text that .includes anything is assembled in no dialect', () => {
    expect(controlledSources('\t.include "include/macros.inc"\n')).toBeUndefined();
  });
});
