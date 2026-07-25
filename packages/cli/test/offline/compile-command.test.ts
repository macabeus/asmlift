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

test('the pascal backend writes the raw source (no C prelude, no probe)', () => {
  const raw = 'function f(a0: Integer): Integer;\n';
  const pascal = compileFromCommand('cp {{inputPath}} {{outputPath}}')(raw, 'f', 'pascal');
  expect(readFileSync(pascal, 'utf8')).toBe(raw);
});

// The prelude is PROBED, never configured (no `prelude:` flag exists): a template whose injected
// headers already own u8/u16/… rejects the typedef probe, and the prelude is dropped for every
// candidate — the C89-collision behavior gcc-2.9 projects exhibit, simulated here by a template
// that fails on any input containing `typedef`.
test('a typedef-rejecting template (header-injecting project) drops the prelude automatically', () => {
  const compile = compileFromCommand('! grep -q typedef {{inputPath}} && cp {{inputPath}} {{outputPath}}');
  const obj = compile('u8 f(void) { return gState.timer; }\n', 'f', 'c');
  const written = readFileSync(obj, 'utf8');
  expect(written).not.toContain('typedef'); // prelude dropped — headers own the types
  expect(written).toContain('gState.timer');
});

test('a prelude-tolerant template keeps the prelude (probe verdict cached across candidates)', () => {
  // the counter file records every template execution: 1 probe + 2 candidates = 3, not 4 —
  // the verdict is cached per compiler instance
  const counter = `${process.env.TMPDIR ?? '/tmp'}/asmlift-probe-count-${process.pid}`;
  const compile = compileFromCommand(`echo x >> ${counter} && cp {{inputPath}} {{outputPath}}`);
  const first = compile('s32 f(void) { return 1; }\n', 'f', 'c');
  expect(readFileSync(first, 'utf8').startsWith(C_TYPEDEFS)).toBe(true);
  compile('s32 g(void) { return 2; }\n', 'g', 'c');
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(3);
});

test('a broken template keeps the prelude and fails loudly on the real candidate', () => {
  // both probe variants fail ⇒ the template itself is broken; the candidate compile must throw
  // the template's own error, never a silent prelude decision
  const compile = compileFromCommand('test -f {{inputPath}} && false && cp {{inputPath}} {{outputPath}}');
  expect(() => compile('s32 f(void) { return 1; }\n', 'f', 'c')).toThrow(/compile command failed/);
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

test('a FAILING middle step aborts even when the last step would succeed (sh -e)', () => {
  // The gcc-2.9 partial-output hazard: cc1 exits nonzero on a hard error yet still writes a
  // truncated .s, and the assemble step then "succeeds" — scoring a truncated object is the one
  // forbidden outcome, so any failing step must abort the template, not just the last one.
  const compile = compileFromCommand(
    "sh -c 'echo partial > {{outputPath}}.s; echo undeclared >&2; exit 1' ; cp {{outputPath}}.s {{outputPath}}\ntrue # {{inputPath}}",
  );
  expect(() => compile('int x;', 'f', 'c')).toThrow(/exit 1[\s\S]*undeclared/);
});
