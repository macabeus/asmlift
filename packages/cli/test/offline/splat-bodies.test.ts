// A GUESSED THUMB CALLEE'S BODY READ OFF THE PROJECT'S OWN ASSEMBLY (src/splat-bodies.ts), where the
// project's own compile command shows the file assembles to the linked code.
//
// fixtures/splat-bodies is a project: linked.elf is built from linked.s, and each
// asm/nonmatchings/m/<name>.s assembles to obj/<name>.o:
//   arm-none-eabi-as -mcpu=arm7tdmi -o linked.o linked.s
//   arm-none-eabi-ld -T arm.ld -e rd0 -o linked.elf linked.o
//   arm-none-eabi-as -mcpu=arm7tdmi -o obj/<name>.o asm/nonmatchings/m/<name>.s
// rd0 reads no argument (a `bl helper` and a `.4byte gp` pool word, both relocated), and rd1 reads r0.
// sel dispatches through a jump table, and selstale's file is sel with the table's second word one
// instruction past the case the linked table enters. stale's file moves 2 into r0 where the linked
// code moves 1. wk's file marks it `.weak`. wrongbl's
// file calls helper2 where the linked code calls helper. dup is included by two units. The compile
// command copies the object of the name its unit includes, as the project's assembler would write it.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { readElfImage } from '../../src/elf-bodies';
import { runCli } from '../../src/main';
import { assemblesToLinked, definesOnce, includingUnit, projectAsm } from '../../src/splat-bodies';

const FIXTURE = join(import.meta.dirname, 'fixtures/splat-bodies');
const LINKED = readElfImage(readFileSync(join(FIXTURE, 'linked.elf')))!;
const object = (name: string) => readFileSync(join(FIXTURE, 'obj', `${name}.o`));

const scratchDirs: string[] = [];
afterAll(() => scratchDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A copy of the fixture project whose decomp.yaml states `compiler`, or none. */
const project = (compiler: string | undefined, asm: string) => {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-splat-bodies-test-'));
  scratchDirs.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    elf: linked.elf\n' +
      (compiler === undefined ? '' : `    compiler: ${JSON.stringify(compiler)}\n`),
  );
  writeFileSync(join(root, 'f.s'), asm);
  writeFileSync(join(root, 'copy.sh'), COPY_SH);
  return join(root, 'f.s');
};
// the name the generated unit includes, and its object copied to the output, by a script the
// command runs: the command itself must be shell-literal (asm-includes.ts)
const COPY = 'sh copy.sh {{inputPath}} {{outputPath}}';
const COPY_SH = 'n=$(sed -n \'s/^INCLUDE_ASM(.*, \\(.*\\));$/\\1/p\' "$1"); cp obj/$n.o "$2"\n';

describe('a project file is a body only where its object is the linked code', () => {
  test('the one unit and the one header', () => {
    const asm = projectAsm(FIXTURE);
    expect(asm.header).toBe(join(FIXTURE, 'include/include_asm.h'));
    expect(includingUnit(asm.sites, 'rd0')).toEqual({
      unit: join(FIXTURE, 'src/m.c'),
      dir: 'asm/nonmatchings/m',
      asm: join(FIXTURE, 'asm/nonmatchings/m/rd0.s'),
    });
    expect(includingUnit(asm.sites, 'dup')).toBeUndefined();
    expect(includingUnit(asm.sites, 'helper')).toBeUndefined();
  });
  test('relocated words aside, every byte agrees', () => {
    expect(assemblesToLinked(LINKED, object('rd0'), 'rd0')).toBe(true);
    expect(assemblesToLinked(LINKED, object('rd1'), 'rd1')).toBe(true);
    // one halfword differs
    expect(assemblesToLinked(LINKED, object('stale'), 'stale')).toBe(false);
    // the `bl` is relocated against helper2, and the linked one enters helper
    expect(assemblesToLinked(LINKED, object('wrongbl'), 'wrongbl')).toBe(false);
    // a weak definition in the object
    expect(assemblesToLinked(LINKED, object('wk'), 'wk')).toBe(false);
    // another function's object
    expect(assemblesToLinked(LINKED, object('rd0'), 'stale')).toBe(false);
  });
  test('a relocated word is masked only where it is the word the link wrote', () => {
    // sel's jump table is relocated against its own section, its pool word against gp
    expect(assemblesToLinked(LINKED, object('sel'), 'sel')).toBe(true);
    // every instruction agrees, and the table's second word enters one instruction past case 1's
    // `str r2`: that body reads no r2, and a caller's bound would drop the argument the linked one reads
    expect(assemblesToLinked(LINKED, object('selstale'), 'sel')).toBe(false);
  });
  test('a label defined once and nowhere weak', () => {
    const text = (n: string) => readFileSync(join(FIXTURE, 'asm/nonmatchings/m', `${n}.s`), 'latin1');
    expect(definesOnce(text('rd0'), 'rd0')).toBe(true);
    expect(definesOnce(text('wk'), 'wk')).toBe(false);
    expect(definesOnce(`${text('rd0')}${text('rd0')}`, 'rd0')).toBe(false);
  });
});

describe('CLI (agbcc): a guessed Thumb callee is bounded by its proven body in the project asm', () => {
  // `extern int gp; f() { gp = 3; g(); }`: the store leaves its 3 in r0 and gp's address in r1
  const stored = (callee: string) =>
    '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tldr\tr1, .L3\n\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n' +
    `\tbl\t${callee}\n\tpop\t{r1}\n\tbx\tr1\n.L3:\n\t.word\tgp\n`;
  // a run with the project's root spelt `<root>`, and without the `[flags]` notes a compile command
  // adds whether or not any body is read
  const run = async (compiler: string | undefined, callee: string) => {
    const input = project(compiler, stored(callee));
    const r = await runCli([input]);
    const root = join(input, '..');
    const stderr = r.stderr
      .split('\n')
      .filter((l) => !l.startsWith('asmlift: [flags]'))
      .join('\n')
      .replaceAll(root, '<root>');
    return { ...r, stderr };
  };
  test.each([
    ['rd0', 'return rd0();'],
    ['rd1', 'return rd1(3);'],
  ])('%s', async (callee, proven) => {
    expect((await run(undefined, callee)).stdout).toContain(`return ${callee}(3, &gp);`);
    expect((await run(COPY, callee)).stdout).toContain(proven);
  });
  // the note names the project file a body was read from, not the ELF whose halfwords bound nothing
  test('the [proto] note names the project file that bounded the guess', async () => {
    const { stderr } = await run(COPY, 'rd1');
    expect(stderr).toContain(
      "checked against what its body in the project's asm reads, where that file assembles to the code in " +
        'tools.asmlift.elf: rd1 (asm/nonmatchings/m/rd1.s, at most 1 argument word)',
    );
    expect(stderr).not.toContain('what its body in tools.asmlift.elf reads');
  });
  // each refusal leaves the run as it is with no compile command to prove a body by
  test.each(['stale', 'wk', 'wrongbl', 'dup'])('%s keeps today\u2019s output', async (callee) => {
    expect(await run(COPY, callee)).toEqual(await run(undefined, callee));
  });
  test('a compile command whose assembler is not there keeps today\u2019s output', async () => {
    const missing = 'asmlift-no-such-assembler {{inputPath}} -o {{outputPath}}';
    expect(await run(missing, 'rd0')).toEqual(await run(undefined, 'rd0'));
  });
});
