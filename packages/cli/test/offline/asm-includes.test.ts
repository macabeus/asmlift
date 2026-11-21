// The CLI reads the files an assembly input `.include`s only where gas finds them with no `-I`:
// relative to the directory gas runs in (the decomp.yaml directory, else the input's), by a plain
// path whose realpath stays inside that directory (asm-includes.ts). Every other include is left out
// of the map, so the reader keeps the reading it has with none.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { isPlainIncludePath, readAsmIncludes } from '../../src/asm-includes';
import { runCli } from '../../src/main';

const NOP_MACRO = '.macro nop\n.set reorder\n.word 0\n.endm\n';
// MERGE462 d24's function: gas, with m2.inc's `.macro nop` read, gives a0 + 1; read as written, a0 + 1 + 4
const FN =
  'glabel f\n    /* 0FC 800000FC 00000000 */  nop\n    /* 100 80000100 24820001 */  addiu      $v0, $a0, 1\n' +
  '    /* 104 80000104 03E00008 */  jr         $ra\n    /* 108 80000108 24420004 */   addiu $v0, $v0, 4\nendlabel f\n';

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-inc-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
};

describe('readAsmIncludes', () => {
  test('reads a plain include and the ones it includes, relative to the one directory', () => {
    const root = tree({ 'a.inc': '.include "sub/b.inc"\n', 'sub/b.inc': '.include "c.inc"\n', 'c.inc': 'x\n' });
    expect(readAsmIncludes('.include "a.inc"\n', root)).toEqual(
      new Map([
        ['a.inc', '.include "sub/b.inc"\n'],
        ['sub/b.inc', '.include "c.inc"\n'],
        ['c.inc', 'x\n'],
      ]),
    );
  });
  test('a nested include is not looked for beside the including file (gas does not)', () => {
    const root = tree({ 'sub/b.inc': '.include "c.inc"\n', 'sub/c.inc': 'x\n' });
    expect([...readAsmIncludes('.include "sub/b.inc"\n', root).keys()]).toEqual(['sub/b.inc']);
  });
  test('a cycle is read once and left in the map for the reader to decline', () => {
    const root = tree({ 'cyc.inc': '.include "cyc.inc"\n' });
    expect(readAsmIncludes('.include "cyc.inc"\n', root)).toEqual(new Map([['cyc.inc', '.include "cyc.inc"\n']]));
  });
  test('a missing file, a `..`, an absolute path and a directory are not resolved', () => {
    const outside = tree({ 'm.inc': NOP_MACRO });
    const root = tree({ 'in/m.inc': NOP_MACRO, 'd/x': '' });
    const text = `.include "missing.inc"\n.include "../m.inc"\n.include "in/../in/m.inc"\n.include "${join(outside, 'm.inc')}"\n.include "d"\n`;
    expect(readAsmIncludes(text, join(root, 'in')).size).toBe(0);
    expect(readAsmIncludes(text, root).size).toBe(0);
  });
  test('a symlink whose target leaves the directory is not followed; one that stays inside is', () => {
    const outside = tree({ 'm.inc': NOP_MACRO });
    const root = tree({ 'real.inc': NOP_MACRO });
    symlinkSync(join(outside, 'm.inc'), join(root, 'esc.inc'));
    symlinkSync(join(root, 'real.inc'), join(root, 'in.inc'));
    expect([...readAsmIncludes('.include "esc.inc"\n.include "in.inc"\n', root).keys()]).toEqual(['in.inc']);
  });
  test('isPlainIncludePath', () => {
    for (const p of ['m.inc', 'include/macro.inc', './m.inc', 'a-b+c_d.inc']) {
      expect(isPlainIncludePath(p)).toBe(true);
    }
    for (const p of ['', '/abs.inc', '../m.inc', 'a/../m.inc', 'a//m.inc', 'a/', 'm inc', '$X.inc', 'm\\.inc']) {
      expect(isPlainIncludePath(p)).toBe(false);
    }
  });
});

describe('the CLI hands the reader the includes gas finds', () => {
  const lift = async (file: string) => runCli([file, '--target', 'ido7.1', '--name', 'f'], (p) => readFileSync(p));
  test('d24: m2.inc beside an input with no decomp.yaml is read, and the `nop` macro call declines', async () => {
    const root = tree({ 'm2.inc': NOP_MACRO, 'd24.s': `.include "m2.inc"\n.set noreorder\n.text\n${FN}` });
    const r = await lift(join(root, 'd24.s'));
    expect(r.stdout).toContain("calls 'nop', a name a `.macro` in this file or a file it includes defines");
    expect(r.stdout).not.toContain('return a0 + 1 + 4');
  });
  test('an include gas does not find keeps the reading with no map (the known gap)', async () => {
    const root = tree({ 'inc/m2.inc': NOP_MACRO, 'asm/d24.s': `.include "m2.inc"\n.set noreorder\n.text\n${FN}` });
    expect((await lift(join(root, 'asm/d24.s'))).stdout).toContain('return a0 + 1 + 4;');
  });
  test("under a decomp.yaml the include is found from its directory, not the input's", async () => {
    const yaml =
      'name: p\nplatform: n64\nversions:\n  - name: us\n    fullname: us\n    paths:\n      target: t.z64\n' +
      '      build_dir: build\n      map: b.map\n      compiled_target: b.z64\ntools:\n  asmlift:\n    target: ido7.1\n';
    const root = tree({
      'decomp.yaml': yaml,
      'inc/m2.inc': NOP_MACRO,
      'asm/beside.inc': NOP_MACRO,
      'asm/r1.s': `.include "inc/m2.inc"\n.set noreorder\n.text\n${FN}`,
      'asm/r2.s': `.include "beside.inc"\n.set noreorder\n.text\n${FN}`,
    });
    expect((await lift(join(root, 'asm/r1.s'))).stdout).toContain("calls 'nop'");
    expect((await lift(join(root, 'asm/r2.s'))).stdout).toContain('return a0 + 1 + 4;');
  });
});
