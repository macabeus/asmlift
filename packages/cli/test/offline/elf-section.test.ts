// Reading one function out of an object whose code lives in several sections, all named `.text`
// and all starting at address 0 — what every CodeWarrior-built GameCube object looks like.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { scopedObjectPath, sectionScopedObject, severalCodeSections } from '../../src/elf-section';
import { multiTextObject, readBack } from './multi-text-object';

const SHF_EXECINSTR = 0x4;
const CODE = [Buffer.from('AAAA'), Buffer.from('BBBBBBBB'), Buffer.from('CCCC')];

describe('sectionScopedObject', () => {
  const object = multiTextObject(CODE, ['ext', 'f0', 'ext']);

  test('an object with several code sections is flagged; one with a single section is not', () => {
    expect(severalCodeSections(object)).toBe(true);
    expect(severalCodeSections(multiTextObject([CODE[0]], ['ext']))).toBe(false);
  });

  test('scoping keeps the bytes of the section that defines the symbol, not the first one', () => {
    // The whole object names three functions at address 0; a name-keyed read of its disassembly
    // cannot tell them apart, and takes the first section's bytes for all three.
    for (const [i, want] of CODE.entries()) {
      const scoped = sectionScopedObject(object, `f${i}`)!;
      const read = readBack(scoped);
      const code = read.sections.filter((s) => (s.flags & SHF_EXECINSTR) !== 0);
      expect(code).toHaveLength(1);
      expect(read.body(code[0]).toString()).toBe(want.toString());
      expect(severalCodeSections(scoped)).toBe(false);
    }
  });

  test("only the kept section's relocations survive, still pointing at their own section", () => {
    const read = readBack(sectionScopedObject(object, 'f1')!);
    const code = read.sections.findIndex((s) => (s.flags & SHF_EXECINSTR) !== 0);
    expect(read.relocationTargets).toEqual([{ section: code, target: 'f0' }]);
  });

  test('a symbol defined in a dropped section becomes undefined, keeping its name for relocations', () => {
    const read = readBack(sectionScopedObject(object, 'f1')!);
    const byName = new Map(read.symbols.map((s) => [s.name, s]));
    expect(byName.get('f0')).toMatchObject({ shndx: 0, value: 0 });
    expect(byName.get('f2')).toMatchObject({ shndx: 0, value: 0 });
    expect(byName.get('f1')!.shndx).toBe(read.sections.findIndex((s) => (s.flags & SHF_EXECINSTR) !== 0));
  });

  test('sections that are not code survive, and the header still finds their names', () => {
    const read = readBack(sectionScopedObject(object, 'f2')!);
    expect(read.sections.map((s) => s.nm)).toEqual([
      '',
      '.text',
      '.rela.text',
      '.rodata',
      '.symtab',
      '.strtab',
      '.shstrtab',
    ]);
    expect(read.body(read.sections[3]).toString()).toBe('ro');
    expect(read.symbols.find((s) => s.name === 'roData')!.shndx).toBe(3);
  });

  test('an object with nothing to disambiguate is left alone', () => {
    expect(sectionScopedObject(multiTextObject([CODE[0]], ['ext']), 'f0')).toBeUndefined();
    expect(sectionScopedObject(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]), 'f0')).toBeUndefined();
    expect(severalCodeSections(new TextEncoder().encode('not an elf'))).toBe(false);
  });

  test('a symbol no code section defines is refused, never answered with other bytes', () => {
    expect(() => sectionScopedObject(object, 'absent')).toThrow(/3 code sections and none of them defines 'absent'/);
  });
});

describe('scopedObjectPath', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'asmlift-elf-section-test-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  test('a multi-section object is copied scoped; a single-section one keeps its own path', () => {
    const dir = scratch();
    const many = join(dir, 'unit.o');
    writeFileSync(many, multiTextObject(CODE, ['ext', 'ext', 'ext']));
    const scoped = scopedObjectPath(many, 'f1', scratch());
    expect(scoped).not.toBe(many);
    expect(
      readBack(readFileSync(scoped))
        .body(readBack(readFileSync(scoped)).sections[1])
        .toString(),
    ).toBe('BBBBBBBB');

    const one = join(dir, 'single.o');
    writeFileSync(one, multiTextObject([CODE[0]], ['ext']));
    expect(scopedObjectPath(one, 'f0', scratch())).toBe(one);
  });

  test('an object that cannot be read passes through, for the disassembler to report on', () => {
    const absent = join(scratch(), 'absent.o');
    expect(scopedObjectPath(absent, 'f0', scratch())).toBe(absent);
  });
});
