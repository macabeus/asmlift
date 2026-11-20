// A PROJECT FILE IS A BODY ONLY WHERE ITS TEXT READS AS THE BYTES IT ASSEMBLES TO (src/splat-bodies.ts
// `readsAsAssembled`): a macro the header's include chain defines under an instruction's name makes
// gas assemble the line as another instruction.
//
// fixtures/splat-bodies-macro is a project whose header includes include/macros.s, which defines
// kl2dct's thumb_func_start/thumb_func_end and `.macro mov rd, imm` / `add \rd, \imm`. cal's file is
// `mov r1, #0x0; str r1, [gp]`, which gas assembles as `adds r1, #0`: the linked cal stores the r1
// it is handed. kfn's file opens with thumb_func_start and reads r0 only.
//   arm-none-eabi-as -mcpu=arm7tdmi -o linked.o linked.s
//   arm-none-eabi-ld -T arm.ld -e cal -o linked.elf linked.o
//   obj/<name>.o: arm-none-eabi-as -mcpu=arm7tdmi of `.include "include/macros.s"` and
//   `.include "asm/nonmatchings/m/<name>.s"`
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { runCli } from '../../src/main';

const FIXTURE = join(import.meta.dirname, 'fixtures/splat-bodies-macro');

const scratchDirs: string[] = [];
afterAll(() => scratchDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// the name the generated unit includes, and its object copied to the output, by a script the
// command runs: the command itself must be shell-literal (asm-includes.ts)
const COPY = 'sh copy.sh {{inputPath}} {{outputPath}}';
const COPY_SH = 'n=$(sed -n \'s/^INCLUDE_ASM(.*, \\(.*\\));$/\\1/p\' "$1"); cp obj/$n.o "$2"\n';

/** A copy of the fixture with `edit` applied, whose decomp.yaml states `compiler` (or none). */
const project = (compiler: string | undefined, callee: string, edit?: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-splat-bodies-macro-test-'));
  scratchDirs.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  edit?.(root);
  writeFileSync(join(root, 'copy.sh'), COPY_SH);
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    elf: linked.elf\n' +
      (compiler === undefined ? '' : `    compiler: ${JSON.stringify(compiler)}\n`),
  );
  // `extern int gp; f() { gp = 3; g(); }`: the store leaves its 3 in r0 and gp's address in r1
  writeFileSync(
    join(root, 'f.s'),
    '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tldr\tr1, .L3\n\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n' +
      `\tbl\t${callee}\n\tpop\t{r1}\n\tbx\tr1\n.L3:\n\t.word\tgp\n`,
  );
  return join(root, 'f.s');
};
const lift = async (compiler: string | undefined, callee: string, edit?: (root: string) => void) =>
  (await runCli([project(compiler, callee, edit)])).stdout;

/** The header including the macros as `path`, where `-I include` finds `macros.s`. */
const headerIncludes = (path: string) => (root: string) => {
  const h = join(root, 'include/include_asm.h');
  writeFileSync(h, readFileSync(h, 'latin1').replace('include/macros.s', path));
};

describe('CLI (agbcc): a body whose text calls an included macro is no body', () => {
  test('cal: the shadowed mov gives no body, and the lift is the one without a compile command', async () => {
    expect(await lift(undefined, 'cal')).toContain('return cal(3, &gp);');
    expect(await lift(COPY, 'cal')).toBe(await lift(undefined, 'cal'));
  });
  test('kfn: the func_start markers keep its body', async () => {
    expect(await lift(undefined, 'kfn')).toContain('kfn(3, &gp);');
    expect(await lift(COPY, 'kfn')).toContain('kfn(3);');
  });
  test('a marker macro holding an instruction is a shadow', async () => {
    const edit = (root: string) => {
      const m = join(root, 'include/macros.s');
      writeFileSync(m, readFileSync(m, 'latin1').replace('\t.thumb_func\n', '\t.thumb_func\n\tnop\n'));
    };
    expect(await lift(COPY, 'kfn', edit)).toBe(await lift(undefined, 'kfn'));
  });
  test('an include no directory holds gives no body', async () => {
    expect(await lift(COPY, 'kfn', headerIncludes('include/missing.inc'))).toBe(await lift(undefined, 'kfn'));
  });
  test('an include found through the command\u2019s -I is read', async () => {
    const viaI = `true -I include\n${COPY}`;
    // without the -I, macros.s is not found: no body
    expect(await lift(COPY, 'kfn', headerIncludes('macros.s'))).toBe(await lift(undefined, 'kfn'));
    expect(await lift(viaI, 'kfn', headerIncludes('macros.s'))).toContain('kfn(3);');
    // and its mov macro is seen there
    expect(await lift(viaI, 'cal', headerIncludes('macros.s'))).toBe(await lift(undefined, 'cal'));
  });
});
