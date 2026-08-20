// CLI surface tests — offline (no toolchain: decompile-only via runCli, no compile/score).
// The corpus fixtures live in @asmlift/core's test dir; read cross-package by path.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { detectName, runCli } from '../../src/main';

const corpus = (f: string) => readFileSync(join(import.meta.dirname, '../../../core/test/corpus', f), 'utf8');
const run = (file: string, ...flags: string[]) => runCli([file, ...flags], corpus);

test('decompiles an objdump corpus file end-to-end (name auto-detected)', async () => {
  const r = await run('ido-add1.asm', '--target', 'ido7.1');
  expect(r.code).toBe(0);
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('s32 add1(s32 a0) {\n    return a0 + 1;\n}\n');
});

test('decompiles agbcc .s text (name from .globl)', async () => {
  const r = await run('agbcc-clamp0.s', '--target', 'agbcc');
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('s32 clamp0(s32 a0) {\n    if (a0 < 0) a0 = 0;\n    return a0;\n}\n');
});

test('name detection covers objdump headers, Splat glabel, .globl, and bare labels', async () => {
  expect(detectName('00000000 <add1>:\n   0:\tjr\tra\n')).toBe('add1');
  expect(detectName(corpus('agbcc-clamp0.s'))).toBe('clamp0');
  expect(detectName('foo:\n\tnop\n')).toBe('foo');
  expect(detectName('\t.text\n')).toBeUndefined();
  // Splat `.s`: the `glabel` marker names the function (no --name needed for single-function files)
  expect(detectName('glabel func_80022198_22D98\n    /* 100 80000100 03E00008 */  jr $ra\n')).toBe(
    'func_80022198_22D98',
  );
});

test('usage errors: unknown target, missing input, missing flag value', async () => {
  expect((await run('ido-add1.asm', '--target', 'nope')).code).toBe(64);
  expect((await runCli([], corpus)).code).toBe(64);
  expect((await run('ido-add1.asm', '--target')).code).toBe(64);
});

test('an unknown flag is a usage error, never silently ignored', async () => {
  const r = await run('ido-add1.asm', '--target', 'ido7.1', '--nmae', 'foo');
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('unknown flag --nmae');
  expect((await run('ido-add1.asm', '--target', 'ido7.1', '--backned', 'pascal')).code).toBe(64);
});

test('--flag=value form works; --strict=x rejected', async () => {
  const r = await run('ido-add1.asm', '--target=ido7.1');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('add1');
  expect((await run('ido-add1.asm', '--target=ido7.1', '--strict=yes')).code).toBe(64);
});

test('an unreadable input is exit 66 with a clean message, not a stack trace', async () => {
  const r = await runCli(['/nonexistent/nope.s', '--target', 'ido7.1'], () => {
    throw new Error('ENOENT: no such file');
  });
  expect(r.code).toBe(66);
  expect(r.stderr).toContain('cannot read /nonexistent/nope.s');
  expect(r.stdout).toBe('');
});

test('--name must be a valid identifier (empty and hostile names are usage errors)', async () => {
  expect((await run('ido-add1.asm', '--target', 'ido7.1', '--name', '')).code).toBe(64);
  expect((await run('ido-add1.asm', '--target', 'ido7.1', '--name', 'a; rm -rf /')).code).toBe(64);
});

test('gaps exit 1 with markers; strict declines are tagged, not internal', async () => {
  const swi = '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n\tswi\t5\n\tbx\tlr\n';
  const gap = await runCli(['x.s', '--target', 'agbcc'], () => swi);
  expect(gap.code).toBe(1);
  expect(gap.stdout).toContain('ASMLIFT_ERROR');
  const strict = await runCli(['x.s', '--target', 'agbcc', '--strict'], () => swi);
  expect(strict.code).toBe(1);
  expect(strict.stderr).toContain('[declined]');
  expect(strict.stderr).not.toContain('[internal error]');
});

// --proto validation. `protoArity` falls back to the arg-register heuristic on a malformed
// `params`, which is right for an OMITTED one and silent for a mistyped one — so a table that is
// accepted here decompiles at a guessed arity with nothing said about it. Measured on klonoa's
// LoadBGTilemapData, the difference between a correct table and a mistyped one is 53 objdiff
// points and no output whatsoever.
const protoFile = (table: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-proto-'));
  const p = join(dir, 'p.json');
  writeFileSync(p, typeof table === 'string' ? table : JSON.stringify(table));
  return p;
};

test('--proto: a well-formed table is accepted in both param spellings', async () => {
  for (const params of [1, ['u8']]) {
    const r = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', protoFile({ callee: { params } }));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  }
});

test('--proto: a mistyped params is REFUSED, not silently ignored', async () => {
  const r = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', protoFile({ callee: { params: '1' } }));
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('callee: "params" must be a non-negative integer');
  expect(r.stdout).toBe('');
});

test('--proto: a misspelled key is REFUSED — it would otherwise do nothing at all', async () => {
  const r = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', protoFile({ callee: { paramz: 1 } }));
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('unknown key "paramz"');
});

test('--proto: every bad entry is named, and the file path is in the message', async () => {
  const p = protoFile({ a: { params: -1 }, b: { returnsVoid: 'yes' } });
  const r = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', p);
  expect(r.stderr).toContain(p);
  expect(r.stderr).toContain('a: "params"');
  expect(r.stderr).toContain('b: "returnsVoid"');
});

test('--proto: unreadable file and non-object JSON stay distinguishable (66 vs 64)', async () => {
  const missing = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', join(tmpdir(), 'nope-asmlift.json'));
  expect(missing.code).toBe(66);
  const scalar = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', protoFile('42'));
  expect(scalar.code).toBe(64);
  expect(scalar.stderr).toContain('must be an object mapping a symbol name to its prototype');
});
