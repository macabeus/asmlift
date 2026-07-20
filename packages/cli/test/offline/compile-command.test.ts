// The candidate-compile command factory (src/compile-command.ts) — the seam a project fills
// with its own toolchain. Offline: the "compilers" here are plain sh commands.
import { C_TYPEDEFS } from '@asmlift/core/target';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import { compileFromCommand } from '../../src/compile-command';

test('missing {{inputPath}}/{{outputPath}} placeholders is a construction-time error', () => {
  expect(() => compileFromCommand('cc -O2 -o out.o')).toThrow(/\{\{inputPath\}\} and \{\{outputPath\}\}/);
  expect(() => compileFromCommand('cc {{inputPath}}')).toThrow(/\{\{inputPath\}\} and \{\{outputPath\}\}/);
});

test('an unknown {{...}} placeholder (e.g. {{functionName}}) is named loudly', () => {
  expect(() => compileFromCommand('cc {{inputPath}} -o {{outputPath}} -f {{functionName}}')).toThrow(
    /unknown placeholder \{\{functionName\}\}/,
  );
});

test('happy path: command runs via sh, {in} carries the typedef prelude, {out} is returned', () => {
  const compile = compileFromCommand('cp {{inputPath}} {{outputPath}}');
  const obj = compile('s32 f(s32 a0) { return a0; }\n', 'f', 'c');
  const written = readFileSync(obj, 'utf8');
  expect(written.startsWith(C_TYPEDEFS)).toBe(true);
  expect(written).toContain('s32 f(s32 a0)');
});

test('prelude: false and the pascal backend both write the raw source', () => {
  const raw = 'function f(a0: Integer): Integer;\n';
  const noPrelude = compileFromCommand('cp {{inputPath}} {{outputPath}}', { prelude: false })('int x;', 'f', 'c');
  expect(readFileSync(noPrelude, 'utf8')).toBe('int x;');
  const pascal = compileFromCommand('cp {{inputPath}} {{outputPath}}')(raw, 'f', 'pascal');
  expect(readFileSync(pascal, 'utf8')).toBe(raw);
});

test('{symbol} substitutes raw; a shell-unsafe symbol REFUSES (injection guard)', () => {
  const compile = compileFromCommand('echo {{symbol}} > {{outputPath}} && test -f {{inputPath}}');
  const obj = compile('int x;', 'my_func', 'c');
  expect(readFileSync(obj, 'utf8').trim()).toBe('my_func');
  // detectName-derived labels are unvalidated — a hostile one must never reach sh
  expect(() => compile('int x;', 'pwn; rm -rf /', 'c')).toThrow(/shell-unsafe/);
  expect(() => compile('int x;', 'a$(reboot)', 'c')).toThrow(/shell-unsafe/);
});

test('the template owns quoting: placeholders inside quotes and word-concatenations work', () => {
  // the kleod-style template shape: {{outputPath}} embedded in a larger double-quoted word
  const compile = compileFromCommand('P="{{outputPath}}.tmp" && cp {{inputPath}} "$P" && mv "$P" {{outputPath}}');
  const obj = compile('int x;', 'f', 'c');
  expect(readFileSync(obj, 'utf8')).toContain('int x;');
});

test('non-zero exit throws LOUD with the command and its stderr', () => {
  const compile = compileFromCommand("echo 'version 2.4.2 required' >&2; false # {{inputPath}} {{outputPath}}");
  expect(() => compile('int x;', 'f', 'c')).toThrow(/exit 1[\s\S]*version 2\.4\.2 required/);
});

test('exit 0 without producing {out} throws (a compiler that lies about success)', () => {
  const compile = compileFromCommand('true # {{inputPath}} {{outputPath}}');
  expect(() => compile('int x;', 'f', 'c')).toThrow(/produced no object/);
});
