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

// --proto validation, at the CLI surface: which exit code each malformed table earns, and that an
// unreadable file stays distinguishable from an unusable one. Why the refusals exist at all is
// validatePrototypes' own contract (core/proto.ts) and is pinned there.
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

// docs/ranked-repro.md's canonical command passes the table INLINE, and so does the `[proto]`
// note's own printed remedy — but the flag used to resolve every value as a path, so following
// either exited 66 on a missing file literally named `{"thunk_HeapFree":{"params":1}}`. Three
// separate scratch proto.json files got invented around that, carrying two different tables for
// what the doc calls one canonical run.
test('--proto: an inline table is read as JSON, and means exactly what the file means', async () => {
  const table = { callee: { params: 1 } };
  const inline = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', JSON.stringify(table));
  expect(inline.code).toBe(0);
  expect(inline.stderr).toBe('');
  const viaFile = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', protoFile(table));
  expect(inline.stdout).toBe(viaFile.stdout);
  // leading whitespace is still inline, not a path
  expect((await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', ' {"callee":{"params":1}}')).code).toBe(0);
});

test('--proto: a malformed inline table says JSON, a missing path says file — both 66', async () => {
  const bad = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', '{"callee":');
  expect(bad.code).toBe(66);
  expect(bad.stderr).toContain('cannot parse --proto JSON');
  const missing = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', join(tmpdir(), 'nope-asmlift.json'));
  expect(missing.code).toBe(66);
  expect(missing.stderr).toContain('cannot read --proto file');
  // an inline table that parses but is unusable is still the entry-level refusal, not 66
  expect((await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', '{"callee":{"params":"1"}}')).code).toBe(64);
});

test('--jobs/--progress belong to the ranked path and are refused elsewhere, not ignored', async () => {
  for (const flag of [['--jobs', '4'], ['--progress']]) {
    const r = await run('agbcc-clamp0.s', '--target', 'agbcc', ...flag);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('--jobs/--progress apply to --score-against runs only');
  }
});

test('--jobs must be a positive integer', async () => {
  for (const bad of ['0', '-2', '2.5', 'six', '']) {
    const r = await run('agbcc-clamp0.s', '--target', 'agbcc', '--score-against', '/nonexistent.o', '--jobs', bad);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('--jobs must be a positive integer');
  }
});

// docs/ranked-repro.md is the repo's ONE canonical ranked command, and the two tests above are
// what its `--proto` spelling has to agree with. Nothing else re-runs the page, so a claim about
// the flag can sit there being false for as long as nobody types it.
// The command BLOCK is checked, not the prose around it: the block is what gets copied. A page
// that quotes the inline form only to call it broken passes a prose-wide check.
// Requiring the block to be inline is deliberate, not incidental — a path means a scratch file,
// and scratch files carrying different tables for "the canonical run" is the drift the page opens
// by describing.
test("docs/ranked-repro.md's canonical command spells --proto a way the CLI accepts", async () => {
  const doc = readFileSync(join(import.meta.dirname, '../../../../docs/ranked-repro.md'), 'utf8');
  const block = doc.match(/```sh\n([\s\S]*?)```/)?.[1];
  const spelled = block?.match(/--proto\s+(\S+)/)?.[1];
  expect(spelled, 'the canonical command block still passes --proto').toBeTruthy();
  // the block writes the callee and the arity as placeholders; make them concrete, spelling intact
  const concrete = spelled!.replace(/^'|'$/g, '').replace('<callee>', 'callee').replace(/\bN\b/, '1');
  const r = await run('agbcc-clamp0.s', '--target', 'agbcc', '--proto', concrete);
  expect(r.code, `docs/ranked-repro.md's command spells --proto ${spelled}`).toBe(0);
});
