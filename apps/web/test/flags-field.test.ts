// The Playground's Flags field: the canonical text each target starts at, and how a typed flag set
// becomes the profile the decompile resolves, the level the field echoes, or the sentence that refuses it.
import { tokenizeFlags } from '@asmlift/core/codegen-flags';
import { type CanonicalToolchainId, TOOLCHAIN_TARGETS, type ToolchainId } from '@asmlift/core/target';
import { describe, expect, test } from 'vitest';

import { canonicalFlagsText, readFlags } from '../src/pages/playground/flags-field';

// The picker's own type: a target with no canonical flags has no canonical text to start at, and
// the registry refuses it at the NAME rather than at the use.
const PLAYGROUND_TARGETS: CanonicalToolchainId[] = ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'];

const LABELS = { mwcc_242_81: 'GC/Wii — mwcc / PPC' };

const read = (id: ToolchainId, text: string) => readFlags(id, text, LABELS);

describe('the Flags field', () => {
  test.each(PLAYGROUND_TARGETS)('starts at %s’s canonical flags, and reads them back word for word', (id) => {
    const text = canonicalFlagsText(id);
    expect(tokenizeFlags(text)).toEqual(TOOLCHAIN_TARGETS[id].canonicalFlags);
    const reading = read(id, text);
    expect('error' in reading ? reading.error : reading.argv).toEqual(TOOLCHAIN_TARGETS[id].canonicalFlags);
  });

  test('echoes the level the compiler acts on, and resolves the profile from the same words', () => {
    const agbcc = read('agbcc', '-mthumb-interwork -O2 -O1');
    expect(agbcc).toMatchObject({ level: '-O1', resolved: { toolchain: 'agbcc' } });
    expect('error' in agbcc ? null : agbcc.notes).toEqual(['-O2 overridden by later -O1']);
    expect(read('agbcc', '-mthumb-interwork -O9')).toMatchObject({
      level: '-O3',
      notes: ['agbcc reads -O9 as -O3'],
    });
    expect(read('ido7.1', '-mips2 -O2 -g')).toMatchObject({ level: '-O1' });
    expect(read('mwcc_242_81', "-proc gekko -O0,p -pragma 'scheduling off'")).toMatchObject({
      argv: ['-proc', 'gekko', '-O0,p', '-pragma', 'scheduling off'],
      level: '-O0,p',
    });
  });

  test('every flag set of a toolchain decompiles against that toolchain’s description', () => {
    const a = read('agbcc', '-O1');
    const b = read('agbcc', canonicalFlagsText('agbcc'));
    expect('error' in a || 'error' in b).toBe(false);
    expect('error' in a ? null : a.resolved.target).toBe(TOOLCHAIN_TARGETS.agbcc.description);
    expect('error' in b ? null : b.resolved.target).toBe(TOOLCHAIN_TARGETS.agbcc.description);
  });

  test('refuses what the CLI refuses, naming the Toolchain choice that reads the level', () => {
    expect(read('agbcc', '   ')).toEqual({ error: "no flags given; ⟲ canonical restores agbcc's" });
    expect(read('agbcc', '-O4,p')).toEqual({
      error:
        '-O4,p is not an optimisation level agbcc accepts; mwcc spells its levels that way; choose GC/Wii — mwcc / PPC under Toolchain',
    });
    expect(readFlags('agbcc', '-O4,p', {})).toEqual({
      error: '-O4,p is not an optimisation level agbcc accepts; mwcc spells its levels that way',
    });
    expect(read('mwcc_242_81', "-pragma 'cats off")).toMatchObject({
      error: expect.stringMatching(/^unterminated ' quote/),
    });
  });
});
