// Reading one function out of an object whose code lives in several sections, all named `.text`
// and all starting at address 0 — what every CodeWarrior-built GameCube object looks like.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { codeSections, scopedObjectPath, sectionScopedObject } from '../../src/elf-section';
import { multiTextObject, readBack } from './multi-text-object';

const SHF_EXECINSTR = 0x4;
const CODE = [Buffer.from('AAAAAAAA'), Buffer.from('BBBBBBBBBBBB'), Buffer.from('CCCCCCCC')];

describe('codeSections', () => {
  test('sections sharing addresses are ambiguous; a single section, or distinct ones, are not', () => {
    expect(codeSections(multiTextObject(CODE, ['ext', 'f0', 'ext']))).toEqual({ count: 3, ambiguous: true });
    expect(codeSections(multiTextObject([CODE[0]], ['ext']))).toEqual({ count: 1, ambiguous: false });
    // a linked ELF's code sections lie at distinct addresses, so each label is still unique
    expect(codeSections(multiTextObject(CODE, ['ext', 'ext', 'ext'], { addrs: [0, 0x100, 0x200] }))).toEqual({
      count: 3,
      ambiguous: false,
    });
    // ...and touching ranges do not overlap, while an address inside another section's extent does
    expect(codeSections(multiTextObject(CODE, ['ext', 'ext', 'ext'], { addrs: [0, 8, 20] }))).toEqual({
      count: 3,
      ambiguous: false,
    });
    expect(codeSections(multiTextObject(CODE, ['ext', 'ext', 'ext'], { addrs: [0, 4, 0x200] }))).toEqual({
      count: 3,
      ambiguous: true,
    });
    expect(codeSections(new TextEncoder().encode('not an elf'))).toEqual({ count: 0, ambiguous: false });
  });
});

describe('sectionScopedObject', () => {
  const object = multiTextObject(CODE, ['ext', 'f0', 'ext']);

  test('scoping keeps the bytes of the section that defines the symbol, not the first one', () => {
    // The whole object names three functions at address 0; a name-keyed read of its disassembly
    // cannot tell them apart, and takes the first section's bytes for all three.
    for (const [i, want] of CODE.entries()) {
      const scoped = sectionScopedObject(object, `f${i}`)!;
      const read = readBack(scoped);
      const code = read.sections.filter((s) => (s.flags & SHF_EXECINSTR) !== 0);
      expect(code).toHaveLength(1);
      expect(read.body(code[0]).toString()).toBe(want.toString());
      expect(codeSections(scoped)).toEqual({ count: 1, ambiguous: false });
    }
  });

  test("only the kept section's relocations survive, still pointing at their own section", () => {
    const read = readBack(sectionScopedObject(object, 'f1')!);
    const code = read.sections.findIndex((s) => (s.flags & SHF_EXECINSTR) !== 0);
    expect(read.relocationTargets).toEqual([{ section: code, target: 'f0' }]);
  });

  test('a symbol defined in a dropped section becomes undefined, keeping its name for relocations', () => {
    // and loses the value and size that described bytes the scoped object no longer holds: that
    // value is what `objdump -t` prints and what the AsmData side-table resolves a jump table's
    // base against, so leaving it behind would point the base into a section that is gone.
    const whole = new Map(readBack(object).symbols.map((s) => [s.name, s]));
    expect(whole.get('f0')!.value).toBeGreaterThan(0);
    expect(whole.get('f0')!.size).toBeGreaterThan(0);

    const read = readBack(sectionScopedObject(object, 'f1')!);
    const byName = new Map(read.symbols.map((s) => [s.name, s]));
    expect(byName.get('f0')).toMatchObject({ shndx: 0, value: 0, size: 0 });
    expect(byName.get('f2')).toMatchObject({ shndx: 0, value: 0, size: 0 });
    expect(byName.get('f1')).toMatchObject({ value: whole.get('f1')!.value, size: whole.get('f1')!.size });
    expect(byName.get('f1')!.shndx).toBe(read.sections.findIndex((s) => (s.flags & SHF_EXECINSTR) !== 0));
    // a symbol in a section that survived keeps everything
    expect(byName.get('roData')).toMatchObject({ value: whole.get('roData')!.value, size: whole.get('roData')!.size });
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
    ).toBe(CODE[1].toString());

    const one = join(dir, 'single.o');
    writeFileSync(one, multiTextObject([CODE[0]], ['ext']));
    expect(scopedObjectPath(one, 'f0', scratch())).toBe(one);
  });

  test('two symbols never share a copy, however long or alike their names, and leave no partial file', () => {
    // The harness writes into the object's OWN directory, keyed on the translation unit alone, and
    // shard processes reach it at once — so the name has to separate symbols, and the file has to
    // appear whole.
    const dir = scratch();
    const many = join(dir, 'unit.o');
    // two mangled names that agree for 400 characters, and two that sanitize to one string
    const long = (n: number) => `_Z${'N9Namespace7Wrapper'.repeat(20)}${n}Ev`;
    const names = [long(0), long(1), 'f::g', 'f__g'];
    writeFileSync(many, multiTextObject([...CODE, CODE[0]], ['ext', 'ext', 'ext', 'ext'], { names }));
    const paths = names.map((sym) => scopedObjectPath(many, sym, dir));
    expect(new Set(paths).size).toBe(names.length);
    for (const p of paths) {
      expect(basename(p).length).toBeLessThanOrEqual(255);
    }
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  test('an object that cannot be read passes through, for the disassembler to report on', () => {
    const absent = join(scratch(), 'absent.o');
    expect(scopedObjectPath(absent, 'f0', scratch())).toBe(absent);
  });
});
