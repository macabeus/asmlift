// THE REVIEW'S PROBES OF A PROJECT-ASM BODY (src/splat-bodies.ts), as regressions: none may lift wrong.
//
// Each probe was a kl2dct-style project (`cc -E -nostdinc -I include`, kl2dct's agbcc, `arm-none-eabi-as`)
// whose linked.elf its own build made from the INCLUDE_ASM header and asm/nonmatchings/m/cal.s, with
// some way of handing gas a macro under an instruction's name (`.macro movs rd, imm` / `adds \rd,
// \imm`): in macros.inc, through the header as C (`#import`, a split string, a hex escape), through
// the command (`-include`, `$X`, `$(…)`, `"-"include`, `--include=`, a `cd` line, `-{{flags}}`),
// through a `..` behind a symlink. Where it worked, the linked cal is `adds r1, #0; str r1, [r2]`: it
// stores the r1 it is handed, and a body read off cal.s (`movs r1, #0`) drops an argument it reads.
//
// The proof no longer reads any of that: it compares asmlift's own assembly of cal.s with the linked
// bytes. So a probe here is its linked ELF and its cal.s, under fixtures/splat-bodies-probes:
//   elf/clean.elf      v0, v8b, h3: no shadow reached gas
//   elf/shadowed.elf   v1-v3d, v5, v7, v8a, w1-w4, x1, x2, h2: the shadow reached gas
//   elf/<v>.elf        v4 (`.req`), v8c (a marker that also pushes), v9 (`.equ` + `.if`), v9b (`.set` +
//                      `.ifndef`), macroproj (a `mov` shadow, the first review's repro)
//   asm/<text>.s       cal.s: kl2dct.s for every probe but v4, v9, v9b and macroproj, which have their own
//   obj/<text>.<dialect>.o   asmlift's assembly of it (src `controlledSources` + `assembleWith`); a missing
//                      one is a dialect gas refused. test/matching/splat-bodies-assembly checks them.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { runCli } from '../../src/main';
import { fakeAssembly, runWithAssembly } from './splat-bodies-fake';

const FIXTURE = join(import.meta.dirname, 'fixtures/splat-bodies-probes');

const scratchDirs: string[] = [];
afterAll(() => scratchDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const HEADER =
  '#define INCLUDE_ASM(DIR, NAME) asm(".pushsection .text\\n.syntax unified\\n.include \\"" DIR "/" #NAME ".s\\"\\n.syntax divided\\n.popsection\\n")\n' +
  'asm(".include \\"include/macros.inc\\"\\n");\n';
const COMMAND =
  'cc -E -x c -nostdinc -undef -I include {{inputPath}} -o {{outputPath}}.i\n' +
  'agbcc {{outputPath}}.i -o {{outputPath}}.s -mthumb-interwork -O2 -fhex-asm\n' +
  'arm-none-eabi-as -mcpu=arm7tdmi {{outputPath}}.s -o {{outputPath}}\n';

/** The probe's project: its linked ELF and cal.s, with the compile command stated or not. */
const lift = async (elf: string, text: string, withBodies: boolean) => {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-splat-bodies-probes-test-'));
  scratchDirs.push(root);
  mkdirSync(join(root, 'asm/nonmatchings/m'), { recursive: true });
  mkdirSync(join(root, 'include'));
  mkdirSync(join(root, 'src'));
  cpSync(join(FIXTURE, 'elf', `${elf}.elf`), join(root, 'linked.elf'));
  cpSync(join(FIXTURE, 'asm', `${text}.s`), join(root, 'asm/nonmatchings/m/cal.s'));
  writeFileSync(join(root, 'include/include_asm.h'), HEADER);
  writeFileSync(join(root, 'src/m.c'), '#include "include_asm.h"\nINCLUDE_ASM("asm/nonmatchings/m", cal);\n');
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    elf: linked.elf\n' +
      (withBodies ? `    compiler: ${JSON.stringify(COMMAND)}\n` : ''),
  );
  // `extern int gp; f() { gp = 3; cal(); }`: the store leaves its 3 in r0 and gp's address in r1
  writeFileSync(
    join(root, 'f.s'),
    '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tldr\tr1, .L3\n\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n' +
      '\tbl\tcal\n\tpop\t{r1}\n\tbx\tr1\n.L3:\n\t.word\tgp\n',
  );
  const input = join(root, 'f.s');
  return withBodies
    ? (await runWithAssembly([input], fakeAssembly(join(FIXTURE, 'obj'), text))).stdout
    : (await runCli([input])).stdout;
};

const SHADOWED = [
  'v1 movs macro in macros.inc',
  'v2 #import',
  'v3 split .include string',
  'v3b split .macro string',
  'v3d hex escape',
  'v5 -include on the command',
  'v7 symlink and ..',
  'v8a nested .purgem and a movs macro',
  'w1 X=-include then $X',
  'w2 $(… | base64 -d)',
  'w3 "-"include',
  'w4 --include=',
  'x1 a cd line',
  'x2 -{{flags}} glued',
  'h2 CRLF header and a movs macro',
].map((v): [string, string, string] => [v, 'shadowed', 'kl2dct']);

describe('CLI (agbcc): no probe lifts wrong', () => {
  test.each<[string, string, string]>([
    ...SHADOWED,
    ['v4 .req in an include', 'v4', 'v4'],
    ['v8c a marker that also pushes', 'v8c', 'kl2dct'],
    ['v9 .equ and .if', 'v9', 'v9'],
    ['v9b .set and .ifndef', 'v9b', 'v9b'],
    ['macroproj mov shadow', 'macroproj', 'macroproj'],
  ])('%s: no body, the lift without one', async (_, elf, text) => {
    const plain = await lift(elf, text, false);
    expect(plain).toContain('return cal(3, &gp);');
    expect(await lift(elf, text, true)).toBe(plain);
  });
  test.each(['v0 kl2dct header and markers', 'v8b a nested include redefining a marker as it was', 'h3 CRLF header'])(
    '%s: the body is read',
    async () => {
      expect(await lift('clean', 'kl2dct', false)).toContain('return cal(3, &gp);');
      expect(await lift('clean', 'kl2dct', true)).toContain('return cal();');
    },
  );
});
