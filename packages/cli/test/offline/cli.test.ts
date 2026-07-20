// CLI surface tests — offline (no toolchain: decompile-only via runCli, no compile/score).
// The corpus fixtures live in @asmlift/core's test dir; read cross-package by path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { detectName, runCli } from '../../src/main';

const corpus = (f: string) => readFileSync(join(import.meta.dirname, '../../../core/test/corpus', f), 'utf8');
const run = (file: string, ...flags: string[]) => runCli([file, ...flags], corpus);

test('decompiles an objdump corpus file end-to-end (name auto-detected)', async () => {
  const r = await run('ido-add1.asm', '--target', 'ido-mips');
  expect(r.code).toBe(0);
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('s32 add1(s32 a0) {\n    return a0 + 1;\n}\n');
});

test('decompiles agbcc .s text (name from .globl)', async () => {
  const r = await run('agbcc-clamp0.s', '--target', 'agbcc-arm');
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('s32 clamp0(s32 a0) {\n    if (a0 < 0) a0 = 0;\n    return a0;\n}\n');
});

test('name detection covers objdump headers, .globl, and bare labels', async () => {
  expect(detectName('00000000 <add1>:\n   0:\tjr\tra\n')).toBe('add1');
  expect(detectName(corpus('agbcc-clamp0.s'))).toBe('clamp0');
  expect(detectName('foo:\n\tnop\n')).toBe('foo');
  expect(detectName('\t.text\n')).toBeUndefined();
});

test('usage errors: unknown target, missing input, missing flag value', async () => {
  expect((await run('ido-add1.asm', '--target', 'nope')).code).toBe(64);
  expect((await runCli([], corpus)).code).toBe(64);
  expect((await run('ido-add1.asm', '--target')).code).toBe(64);
});

test('an unknown flag is a usage error, never silently ignored', async () => {
  const r = await run('ido-add1.asm', '--target', 'ido-mips', '--nmae', 'foo');
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('unknown flag --nmae');
  expect((await run('ido-add1.asm', '--target', 'ido-mips', '--backned', 'pascal')).code).toBe(64);
});

test('--flag=value form works; --strict=x rejected', async () => {
  const r = await run('ido-add1.asm', '--target=ido-mips');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('add1');
  expect((await run('ido-add1.asm', '--target=ido-mips', '--strict=yes')).code).toBe(64);
});

test('an unreadable input is exit 66 with a clean message, not a stack trace', async () => {
  const r = await runCli(['/nonexistent/nope.s', '--target', 'ido-mips'], () => {
    throw new Error('ENOENT: no such file');
  });
  expect(r.code).toBe(66);
  expect(r.stderr).toContain('cannot read /nonexistent/nope.s');
  expect(r.stdout).toBe('');
});

test('--name must be a valid identifier (empty and hostile names are usage errors)', async () => {
  expect((await run('ido-add1.asm', '--target', 'ido-mips', '--name', '')).code).toBe(64);
  expect((await run('ido-add1.asm', '--target', 'ido-mips', '--name', 'a; rm -rf /')).code).toBe(64);
});

test('gaps exit 1 with markers; strict declines are tagged, not internal', async () => {
  const swi = '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n\tswi\t5\n\tbx\tlr\n';
  const gap = await runCli(['x.s', '--target', 'agbcc-arm'], () => swi);
  expect(gap.code).toBe(1);
  expect(gap.stdout).toContain('ASMLIFT_ERROR');
  const strict = await runCli(['x.s', '--target', 'agbcc-arm', '--strict'], () => swi);
  expect(strict.code).toBe(1);
  expect(strict.stderr).toContain('[declined]');
  expect(strict.stderr).not.toContain('[internal error]');
});
