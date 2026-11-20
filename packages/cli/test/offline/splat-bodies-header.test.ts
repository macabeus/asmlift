// THE HEADER A PROJECT BODY IS COMPILED WITH IS C (src/splat-bodies.ts `headerIncludes`): what gas
// reads of it is what the preprocessor and compiler make of it, so it is an allowlist, and the
// compile command is read fail-closed (src/asm-includes.ts `includeSearchFromCommand`).
//
// fixtures/splat-bodies-header holds the review's probes, built with a kl2dct-style command (`cc -E
// -nostdinc -I include`, kl2dct's agbcc, `arm-none-eabi-as`) from the header each test writes plus
// asm/nonmatchings/m/cal.s, which is `movs r1, #0; str r1, [gp]` under kl2dct's thumb_func_start:
//   - elf/clean.elf, obj/clean.o: header with include/macros.s only; cal stores 0.
//   - elf/shadowed.elf, obj/shadowed.o: a header that also brings in include/evil.s
//     (`.macro movs rd, imm` / `adds \rd, \imm`), so gas assembles `adds r1, #0` and cal stores the
//     r1 it is handed. A body read off cal.s there drops an argument the linked code reads.
// lnk -> sub/d, so the kernel opens `lnk/../m2.s` as sub/m2.s (the shadowing one) while a lexical
// join reads ./m2.s (benign).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { runCli } from '../../src/main';

const FIXTURE = join(import.meta.dirname, 'fixtures/splat-bodies-header');

const scratchDirs: string[] = [];
afterAll(() => scratchDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const DEFINE =
  '#define INCLUDE_ASM(DIR, NAME) asm(".pushsection .text\\n.syntax unified\\n.include \\"" DIR "/" #NAME ".s\\"\\n.syntax divided\\n.popsection\\n")\n';
const HEADER = `${DEFINE}asm(".include \\"include/macros.s\\"\\n");\n`;
// the generated unit is ignored: the object of the probe it stands for is copied
const copy = (obj: string) => `test -f {{inputPath}} && cp obj/${obj}.o {{outputPath}}`;

interface Variant {
  /** lines after the base header */
  header?: string;
  /** the compile command; the object it copies is the linked one */
  command?: string;
  linked: 'clean' | 'shadowed';
  edit?: (root: string) => void;
}

const lift = async ({ header = '', command, linked, edit }: Variant, withCompiler: boolean) => {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-splat-bodies-header-test-'));
  scratchDirs.push(root);
  cpSync(FIXTURE, root, { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(root, 'include/include_asm.h'), HEADER + header);
  edit?.(root);
  const compiler = command ?? copy(linked);
  writeFileSync(
    join(root, 'decomp.yaml'),
    `name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    elf: elf/${linked}.elf\n` +
      (withCompiler ? `    compiler: ${JSON.stringify(compiler)}\n` : ''),
  );
  // `extern int gp; f() { gp = 3; cal(); }`: the store leaves its 3 in r0 and gp's address in r1
  writeFileSync(
    join(root, 'f.s'),
    '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tldr\tr1, .L3\n\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n' +
      '\tbl\tcal\n\tpop\t{r1}\n\tbx\tr1\n.L3:\n\t.word\tgp\n',
  );
  return (await runCli([join(root, 'f.s')])).stdout;
};

describe('CLI (agbcc): a header or command that may bring gas a macro unseen gives no body', () => {
  test.each<[string, Variant]>([
    ['v2 #import', { header: '#import "evil.h"\n', linked: 'shadowed' }],
    ['v3 split .include string', { header: 'asm(".incl" "ude \\"include/evil.s\\"\\n");\n', linked: 'shadowed' }],
    [
      'v3b split .macro string',
      { header: 'asm(".mac" "ro movs rd, imm\\n adds \\\\rd, \\\\imm\\n.endm\\n");\n', linked: 'shadowed' },
    ],
    ['v3d hex escape', { header: 'asm("\\x2einclude \\"include/evil.s\\"\\n");\n', linked: 'shadowed' }],
    [
      'v5 -include on the command',
      { command: `true -include include/evil.h && ${copy('shadowed')}`, linked: 'shadowed' },
    ],
    ['v7 symlink and ..', { header: 'asm(".include \\"lnk/../m2.s\\"\\n");\n', linked: 'shadowed' }],
  ])('%s: no body, the lift without a compile command', async (_, v) => {
    const plain = await lift(v, false);
    expect(plain).toContain('return cal(3, &gp);');
    expect(await lift(v, true)).toBe(plain);
  });
  test.each<[string, Variant]>([
    ['v0 kl2dct header and markers', { linked: 'clean' }],
    [
      'v8b a nested include purging and redefining a marker as it was',
      {
        linked: 'clean',
        edit: (root) => {
          const m = join(root, 'include/macros.s');
          writeFileSync(m, `${readFileSync(m, 'latin1')}\t.include "include/nested.s"\n`);
        },
      },
    ],
  ])('%s: the body is read', async (_, v) => {
    expect(await lift(v, false)).toContain('return cal(3, &gp);');
    expect(await lift(v, true)).toContain('return cal();');
  });
});
