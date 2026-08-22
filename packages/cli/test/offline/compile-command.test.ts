// The candidate-compile command factory (src/compile-command.ts) — the seam a project fills
// with its own toolchain. Offline: the "compilers" here are plain sh commands.
import { C_TYPEDEFS } from '@asmlift/core/target';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from 'vitest';

import { compileFromCommand, compilersFromCommand } from '../../src/compile-command';

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

// ── self-declaring candidates: the generalized world probe (declarations ride the prelude) ──

test('self-declared world: the synthesized declaration block joins the typedef prelude', () => {
  const compile = compileFromCommand('cp {{inputPath}} {{outputPath}}');
  const decls = 'extern volatile u16 gMmio;\nvoid DoThing(void);\n';
  const obj = compile('u16 f(void) { return gMmio; }\n', 'f', 'c', decls);
  const written = readFileSync(obj, 'utf8');
  expect(written.startsWith(C_TYPEDEFS)).toBe(true);
  expect(written.indexOf(decls)).toBe(C_TYPEDEFS.length); // prelude first, then the decls
  expect(written).toContain('return gMmio;');
});

test('headers world: the declaration block drops WITH the prelude (headers own everything)', () => {
  // the typedef-rejecting template simulates a header-injecting project (C89 duplicate-typedef
  // collision); the synthesized decls would equally collide (duplicate struct/extern), so both go
  const compile = compileFromCommand('! grep -q typedef {{inputPath}} && cp {{inputPath}} {{outputPath}}');
  const obj = compile('u16 f(void) { return gMmio; }\n', 'f', 'c', 'extern volatile u16 gMmio;\n');
  const written = readFileSync(obj, 'utf8');
  expect(written).not.toContain('typedef');
  expect(written).not.toContain('extern volatile u16 gMmio;');
  expect(written).toContain('return gMmio;');
});

test('the probe itself carries a representative decl block (struct/volatile/const/prototype vocabulary)', () => {
  // capture every input the template sees: the probe must exercise the same declaration
  // vocabulary synthesis emits, so a world that accepts the probe accepts any real block —
  // and it IS synthesis output (renderDeclarations over a fixed synthetic ref set), so the
  // vocabulary below is pinned as rendered: signed narrow member, interior/tail pads,
  // volatile member, pointer member, volatile scalar, const array, void prototype
  const log = `${process.env.TMPDIR ?? '/tmp'}/asmlift-probe-decls-${process.pid}`;
  const compile = compileFromCommand(`cat {{inputPath}} >> ${log} && cp {{inputPath}} {{outputPath}}`);
  compile('s32 f(void) { return 1; }\n', 'f', 'c');
  const seen = readFileSync(log, 'utf8');
  expect(seen).toContain(
    'struct AsmliftProbeShape { s8 lvl; u8 asmlift_pad_0[1]; volatile u16 gain; void *next; u8 asmlift_pad_1[4]; };',
  );
  expect(seen).toContain('extern volatile struct AsmliftProbeShape gAsmliftProbeShape;');
  expect(seen).toContain('extern volatile u16 gAsmliftProbeMmio;');
  expect(seen).toContain('extern const u16 gAsmliftProbeTable[];');
  expect(seen).toContain('void AsmliftProbeFn(void);');
});

test('no declarations argument ⇒ exactly the historical prelude behavior', () => {
  const compile = compileFromCommand('cp {{inputPath}} {{outputPath}}');
  const obj = compile('s32 f(void) { return 1; }\n', 'f', 'c');
  const written = readFileSync(obj, 'utf8');
  expect(written).toBe(C_TYPEDEFS + 's32 f(void) { return 1; }\n');
});

// ── the pooled flavour: `worker()` mints an independent async compiler per pool worker ──

test('an async worker compiles exactly like the sync compiler', async () => {
  const { compile, worker } = compilersFromCommand('cp {{inputPath}} {{outputPath}}');
  const src = 's32 f(s32 a0) { return a0; }\n';
  const sync = readFileSync(compile(src, 'f', 'c'), 'utf8');
  const async1 = readFileSync(await worker()(src, 'f', 'c'), 'utf8');
  expect(async1).toBe(sync);
  expect(async1.startsWith(C_TYPEDEFS)).toBe(true);
});

test('the world is probed ONCE across every worker, not once per worker', async () => {
  // N workers starting together each see an unset probe verdict; without a shared in-flight
  // promise they all probe, and a slow template pays for it N times
  const counter = `${process.env.TMPDIR ?? '/tmp'}/asmlift-worker-probe-${process.pid}`;
  const { worker } = compilersFromCommand(`echo x >> ${counter} && cp {{inputPath}} {{outputPath}}`);
  const workers = [worker(), worker(), worker(), worker()];
  await Promise.all(workers.map((w, i) => w(`s32 f${i}(void) { return ${i}; }\n`, `f${i}`, 'c')));
  // 1 probe + 4 candidates, not 4 probes + 4 candidates
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(5);
});

test('each worker gets its OWN scratch slot, so concurrent compiles cannot clobber each other', async () => {
  const { worker } = compilersFromCommand('cp {{inputPath}} {{outputPath}}');
  const a = worker(),
    b = worker();
  const [oa, ob] = await Promise.all([
    a('s32 f(void) { return 1; }\n', 'f', 'c'),
    b('s32 g(void) { return 2; }\n', 'g', 'c'),
  ]);
  expect(dirname(oa)).not.toBe(dirname(ob));
  expect(readFileSync(oa, 'utf8')).toContain('return 1;');
  expect(readFileSync(ob, 'utf8')).toContain('return 2;');
});

test('ONE scratch dir per worker across candidates — emptied, so a lying compiler still fails loud', async () => {
  const { worker } = compilersFromCommand('test ! -e {{outputPath}} && cp {{inputPath}} {{outputPath}}');
  const w = worker();
  const first = await w('s32 f(void) { return 1; }\n', 'f', 'c');
  const second = await w('s32 g(void) { return 2; }\n', 'g', 'c');
  // same directory reused (the leak fix) — and the `test ! -e` above only passes because it was
  // EMPTIED, which is what keeps "exited 0 but produced no object" reachable
  expect(dirname(second)).toBe(dirname(first));
  expect(readFileSync(second, 'utf8')).toContain('return 2;');
});

test('an async worker reports a failed compile as a THROW, exactly like the sync one', async () => {
  const { compile, worker } = compilersFromCommand(
    "echo 'version 2.4.2 required' >&2; false # {{inputPath}} {{outputPath}}",
  );
  expect(() => compile('int x;', 'f', 'c')).toThrow(/exit 1[\s\S]*version 2\.4\.2 required/);
  await expect(worker()('int x;', 'f', 'c')).rejects.toThrow(/exit 1[\s\S]*version 2\.4\.2 required/);
});
