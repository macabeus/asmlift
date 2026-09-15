// Deriving a real unit's flags from its project's build (cases/derive-flags.ts): a Makefile project in a git
// repository written here, read through a clone at a named commit, and dtk units cut from Mario Party 4.
import { storedFlags, tokenizeFlags } from '@asmlift/core/codegen-flags';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import {
  deriveDtkFlags,
  deriveMakefileFlags,
  flagsClone,
  flagsStatus,
  ninjaCflags,
  objectFiles,
  unitObject,
  unitOf,
} from '../src/cases/derive-flags';

const scratch = mkdtempSync(join(tmpdir(), 'derive-flags-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

/** A pret-style project: a pattern rule, a per-object override, a preprocessor step that names the compiler's
 *  directory, and the object files a build leaves behind. */
function makefileProject(): { checkout: string; first: string; second: string } {
  const checkout = join(scratch, 'checkout');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  const makefile = (level: string) =>
    [
      `CFLAGS := -mthumb-interwork -Wimplicit -Werror ${level} -fhex-asm`,
      'build/src/%.o: src/%.c',
      '\tcpp -I tools/agbcc -nostdinc $< -o build/src/$*.i',
      '\ttools/agbcc/bin/agbcc $(CFLAGS) -o build/src/$*.s build/src/$*.i',
      '\tarm-none-eabi-as build/src/$*.s -o $@',
      'build/src/agb_flash.o: CFLAGS := -O1 -mthumb-interwork',
      '',
    ].join('\n');
  writeFileSync(join(checkout, 'Makefile'), makefile('-O2'));
  writeFileSync(join(checkout, 'src/math.c'), 'int f(void) { return 0; }\n');
  writeFileSync(join(checkout, 'src/agb_flash.c'), 'int g(void) { return 0; }\n');
  execFileSync('git', ['init', '--quiet', checkout]);
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'first');
  const first = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(join(checkout, 'Makefile'), makefile('-O3'));
  git(checkout, 'commit', '--quiet', '-am', 'second');
  const second = git(checkout, 'rev-parse', 'HEAD');
  mkdirSync(join(checkout, 'build/src'), { recursive: true });
  writeFileSync(join(checkout, 'build/src/math.o'), '');
  writeFileSync(join(checkout, 'build/src/agb_flash.o'), '');
  return { checkout, first, second };
}

describe('a Makefile unit', () => {
  const { checkout, first, second } = makefileProject();
  const clones = join(scratch, 'clones');
  const derive = (commit: string, unit: string) =>
    deriveMakefileFlags({
      clone: flagsClone('fixture', checkout, commit, clones),
      commit,
      unit,
      object: unitObject(unit, objectFiles(checkout)),
      toolchain: 'agbcc',
    });

  test("takes the compile recipe's words in normal form, at the commit asked for", () => {
    const math = derive(second, 'src/math.c');
    expect(math.toolchain).toBe('agbcc');
    expect(math.cflags).toEqual(['-mthumb-interwork', '-O3', '-fhex-asm']);
    expect(math.flagsFrom).toEqual({
      from: 'makefile',
      commit: second,
      file: 'Makefile',
      sha256: createHash('sha256')
        .update(readFileSync(join(checkout, 'Makefile')))
        .digest('hex'),
      command:
        'tools/agbcc/bin/agbcc -mthumb-interwork -Wimplicit -Werror -O3 -fhex-asm -o build/src/math.s build/src/math.i',
    });
    const older = derive(first, 'src/math.c');
    expect(older.cflags).toEqual(['-mthumb-interwork', '-O2', '-fhex-asm']);
    expect(older.flagsFrom.commit).toBe(first);
  });

  test("takes an object's own override", () => {
    expect(derive(second, 'src/agb_flash.c').cflags).toEqual(['-O1', '-mthumb-interwork']);
  });

  test('never writes into the checkout', () => {
    expect(git(checkout, 'status', '--porcelain', '--ignored')).toBe('?? build/');
    expect(readdirSync(join(checkout, 'build/src')).sort()).toEqual(['agb_flash.o', 'math.o']);
  });
});

describe("a unit's object", () => {
  const objects = [
    'build/kleod/src/math.o',
    'build/gba/sa3/src/game/math.o',
    'build/src/sprman.c.o',
    'build/asm/data/sprman.data.s.o',
  ];

  test('ends in the unit path, extension replaced or kept', () => {
    expect(unitObject('src/math.c', objects)).toBe('build/kleod/src/math.o');
    expect(unitObject('src/game/math.c', objects)).toBe('build/gba/sa3/src/game/math.o');
    expect(unitObject('src/sprman.c', objects)).toBe('build/src/sprman.c.o');
  });

  test('none, or several, is refused', () => {
    expect(() => unitObject('src/pause.c', objects)).toThrow('no object file for src/pause.c');
    expect(() => unitObject('src/math.c', [...objects, 'build/modern/src/math.o'])).toThrow('several object files');
  });

  test("is named by the row's permalink", () => {
    expect(
      unitOf({
        sym: 'AbsMax',
        addr: '0x080001f8',
        features: [],
        funcC: '',
        sourceUrl: 'https://github.com/macabeus/sa3/blob/a069e81b/src/game/math.c#L10-L20',
      }),
    ).toBe('src/game/math.c');
  });
});

describe('a dtk unit', () => {
  const root = join(import.meta.dirname, 'fixtures/dtk/marioparty4');
  const commit = '147b165a83187ac9e6cfdc3bf52f2e73437b1ffd';

  test("is its objdiff.json unit's flags, which build.ninja's edge agrees with", () => {
    const map = deriveDtkFlags(root, commit, 'src/REL/m427Dll/map.c');
    const objdiff = JSON.parse(readFileSync(join(root, 'objdiff.json'), 'utf8')) as {
      units: { name: string; scratch: { c_flags: string } }[];
    };
    const unit = objdiff.units.find((u) => u.name === 'm427Dll/REL/m427Dll/map')!;
    expect(map.toolchain).toBe('mwcc_242_81');
    expect(map.cflags).toEqual(storedFlags('mwcc', tokenizeFlags(unit.scratch.c_flags)));
    expect(map.cflags).toContain('-O0,p');
    expect(map.cflags).not.toContain('-DVERSION=0');
    expect(map.flagsFrom).toMatchObject({
      from: 'objdiff',
      commit,
      file: 'objdiff.json',
      unit: 'm427Dll/REL/m427Dll/map',
    });
  });

  test('a compiler asmlift has no toolchain for, a source several units compile, and no unit are refused', () => {
    expect(() => deriveDtkFlags(root, commit, 'src/game/main.c')).toThrow(
      'main/game/main is compiled by mwcc_247_107, which is not an asmlift toolchain',
    );
    expect(() => deriveDtkFlags(root, commit, 'src/REL/executor.c')).toThrow(
      'src/REL/executor.c is compiled in 2 objdiff.json units: m403Dll/REL/executor, m427Dll/REL/executor',
    );
    expect(() => deriveDtkFlags(root, commit, 'src/REL/nope.c')).toThrow(
      'objdiff.json has no unit compiled from src/REL/nope.c',
    );
  });

  test('flags build.ninja does not build with are refused', () => {
    const edited = join(scratch, 'dtk-edited');
    cpSync(root, edited, { recursive: true });
    const ninja = readFileSync(join(edited, 'build.ninja'), 'utf8');
    writeFileSync(join(edited, 'build.ninja'), ninja.replaceAll('-sdata 0 -sdata2 0', '-sdata 8 -sdata2 0'));
    expect(() => deriveDtkFlags(edited, commit, 'src/REL/m427Dll/map.c')).toThrow("are not build.ninja's");
  });

  test('build.ninja values join their continuations and undo their escapes', () => {
    const ninja =
      'build out/a.o: cc src/a.c | $\n    dep\n  cflags = -O2 $\n      -DX=$$Y -Dsp=a$ b\nbuild out/b.o: cc src/b.c\n';
    expect(ninjaCflags(ninja, 'out/a.o')).toBe('-O2 -DX=$Y -Dsp=a b');
    expect(ninjaCflags(ninja, 'out/b.o')).toBeUndefined();
  });
});

describe("a unit's stored flags", () => {
  test('are ok, drifted from the derived ones, or missing', () => {
    expect(flagsStatus(['-O2'], ['-O2'])).toEqual({ kind: 'ok' });
    expect(flagsStatus(['-O2'], ['-O1'])).toEqual({ kind: 'DRIFT', stored: ['-O2'] });
    expect(flagsStatus(undefined, ['-O1'])).toEqual({ kind: 'MISSING' });
  });
});
