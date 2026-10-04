// tools.asmlift + target resolution — offline. Fixtures are written to per-test temp dirs; nothing
// depends on the repo's own tree (asmlift has no decomp.yaml). Finding and parsing the file is
// @match-kit/decomp-yaml's, and tested there.
import { type LoadedConfig } from '@match-kit/decomp-yaml';
import { loadDecompYaml } from '@match-kit/decomp-yaml/files';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { asmliftBlock, resolveTarget, targetSetting } from '../../src/config';
import { runCli } from '../../src/main';

const tmp = () => mkdtempSync(join(tmpdir(), 'asmlift-cfg-'));

/** `text` as a project's decomp.yaml, loaded. */
function load(text: string): LoadedConfig | null {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), text);
  return loadDecompYaml(undefined, root);
}

const resolveIn = (text: string, flag?: string) => {
  const loaded = load(text);
  return resolveTarget(flag, loaded, asmliftBlock(loaded));
};

test('tools.asmlift is read with every key asmlift knows', () => {
  const loaded = load(
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    compiler: cc {{inputPath}} {{outputPath}}\n    objdump: od\n    elf: a.elf\n',
  );
  expect(asmliftBlock(loaded)).toEqual({
    target: 'agbcc',
    compiler: 'cc {{inputPath}} {{outputPath}}',
    objdump: 'od',
    elf: 'a.elf',
  });
  expect(asmliftBlock(load('name: test\nplatform: gba\nversions: []\n'))).toBeUndefined();
  expect(asmliftBlock(null)).toBeUndefined();
});

test('tools.asmlift refuses a key of the wrong type and a key asmlift does not know, naming each', () => {
  const loaded = load(
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: 3\n    compilier: cc\n',
  );
  expect(() => asmliftBlock(loaded)).toThrow(/tools\.asmlift\.target: Invalid input: expected string, received number/);
  expect(() => asmliftBlock(loaded)).toThrow(/tools\.asmlift: Unrecognized key: "compilier"/);
});

test('target resolution precedence: flag > tools.asmlift.target > platform', () => {
  const both = 'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: ido7.1\n';
  expect(resolveIn(both, 'mwcc_242_81')).toEqual({ targetKey: 'mwcc_242_81', trace: '--target flag' });
  const viaTool = resolveIn(both);
  expect('targetKey' in viaTool && viaTool.targetKey).toBe('ido7.1');
  const viaPlatform = resolveIn('name: test\nplatform: gba\nversions: []\n');
  expect('targetKey' in viaPlatform && viaPlatform.targetKey).toBe('agbcc');
});

test('ambiguous and unknown platforms DECLINE naming the candidates, never guess', () => {
  const amb = resolveIn('name: test\nplatform: n64\nversions: []\n');
  expect('error' in amb && amb.error).toMatch(/ido7.1 or gcc2.7.2kmc/);

  // GameCube and Wii name THREE CodeWarrior builds, and they differ in codegen: Pikmin's
  // `getMainStickX__10ControllerFv` compiled by mwcc_242_81 rather than by its own mwcc_233_163n
  // differs from the ROM at +0x3. A platform that used to name one compiler and now names three
  // is exactly when an inference has to stop being one.
  for (const platform of ['gc', 'gamecube', 'wii']) {
    const res = resolveIn(`name: test\nplatform: ${platform}\nversions: []\n`);
    expect('error' in res && res.error).toMatch(/mwcc_242_81 or mwcc_233_163n or mwcc_247_107/);
  }
  // …so the setting a refusal tells a CodeWarrior user to write is the one that decides the build,
  // never the platform that no longer does.
  expect(targetSetting('mwcc_242_81')).toBe('tools.asmlift.target: mwcc_242_81');
  expect(targetSetting('agbcc')).toBe('platform: gba');

  const unk = resolveIn('name: test\nplatform: dreamcast\nversions: []\n');
  expect('error' in unk && unk.error).toMatch(/no asmlift target mapping/);

  const none = resolveTarget(undefined, null, undefined);
  expect('error' in none && none.error).toMatch(/no --target/);
});

test('CLI: a decomp.yaml that does not meet the decomp_settings spec is exit 66 naming each field', async () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'platform: gba\n');
  const file = join(root, 'clamp0.s');
  writeFileSync(file, '\t.code\t16\n\t.globl\tclamp0\n\t.thumb_func\nclamp0:\n\tbx\tlr\n');
  const r = await runCli([file]);
  expect(r.code).toBe(66);
  expect(r.stderr).toContain(`${join(root, 'decomp.yaml')}: name: Invalid input: expected string, received undefined`);
  expect(r.stderr).toContain(
    `${join(root, 'decomp.yaml')}: versions: Invalid input: expected array, received undefined`,
  );
});

test('CLI: a malformed tools.asmlift is exit 66 naming the key, never a run without it', async () => {
  const root = tmp();
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    compilier: cc\n',
  );
  const file = join(root, 'clamp0.s');
  writeFileSync(file, '\t.code\t16\n\t.globl\tclamp0\n\t.thumb_func\nclamp0:\n\tbx\tlr\n');
  const r = await runCli([file]);
  expect(r.code).toBe(66);
  expect(r.stderr).toContain(`${join(root, 'decomp.yaml')}: tools.asmlift: Unrecognized key: "compilier"`);
});

test('CLI: --target becomes optional inside a configured project (trace on stderr)', async () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'name: test\nplatform: gba\nversions: []\n');
  const asm =
    '\t.code\t16\n\t.globl\tclamp0\n\t.thumb_func\nclamp0:\n\tcmp\tr0, #0\n\tbge\t.L4\n\tmov\tr0, #0x0\n.L4:\n\tbx\tlr\n';
  const file = join(root, 'clamp0.s');
  writeFileSync(file, asm);
  const r = await runCli([file]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('s32 clamp0(s32 a0)');
  expect(r.stderr).toContain('[config] target agbcc');
});

test('CLI: ambiguous platform without --target is a usage error naming both', async () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'name: test\nplatform: n64\nversions: []\n');
  const file = join(root, 'f.asm');
  writeFileSync(file, '00000000 <f>:\n   0:\tjr\tra\n   4:\tnop\n');
  const r = await runCli([file]);
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('ido7.1 or gcc2.7.2kmc');
});

test('CLI: --score-against without tools.asmlift.compiler is a usage error, never a fallback', async () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'name: test\nplatform: gba\nversions: []\n'); // no compiler command
  const file = join(root, 'clamp0.s');
  writeFileSync(file, '\t.code\t16\n\t.globl\tclamp0\n\t.thumb_func\nclamp0:\n\tbx\tlr\n');
  const target = join(root, 't.o');
  writeFileSync(target, 'placeholder');
  const r = await runCli([file, '--score-against', target]);
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('needs tools.asmlift.compiler');
});

test('CLI: --score-against with a missing object is exit 66; bad compile template is usage', async () => {
  const root = tmp();
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    compiler: gcc -c -o out.o\n',
  );
  const file = join(root, 'clamp0.s');
  writeFileSync(file, '\t.code\t16\n\t.globl\tclamp0\n\t.thumb_func\nclamp0:\n\tbx\tlr\n');
  const missing = await runCli([file, '--score-against', join(root, 'no-such.o')]);
  expect(missing.code).toBe(66);
  expect(missing.stderr).toContain('cannot read --score-against');

  const target = join(root, 't.o');
  writeFileSync(target, 'not really an object');
  const badTemplate = await runCli([file, '--score-against', target]);
  expect(badTemplate.code).toBe(64);
  expect(badTemplate.stderr).toContain('{{inputPath}} and {{outputPath}}');
});

// ── tools.asmlift.symbols — a map that is already DERIVED ─────────────────────────────────────
//
// `elf` is the ordinary source: a project has a built ELF and asmlift derives names + declaration
// shapes from it. This key is the case where there is no ELF to derive from and the map is
// authored — the benchmark's synthetic rows hand-write one, and their published reproduction
// scripts have to feed the CLI the same map or they reproduce a different source than the row.
// The tests below pin the CHANNEL (a map that loads changes the output), not just the parse.
const POOL_ASM =
  '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n\t.align 2\n.L1:\n\t.word\t0x03005220\n';
const MAP_JSON = JSON.stringify({
  '0x03005220': [{ name: 'gCell', kind: 'data', declared: true, shape: 'scalar', size: 4, signed: false }],
});

test('CLI: tools.asmlift.symbols loads an authored map — the output NAMES what it declares', async () => {
  const root = tmp();
  writeFileSync(join(root, 'symbols.json'), MAP_JSON);
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    symbols: symbols.json\n',
  );
  const file = join(root, 'f.s');
  writeFileSync(file, POOL_ASM);
  const r = await runCli([file]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('gCell');

  // the same run with the key removed is the control: no map, no name — so the assertion above
  // is about the map being LOADED, not about the address happening to render that way.
  const bare = tmp();
  writeFileSync(
    join(bare, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n',
  );
  const file2 = join(bare, 'f.s');
  writeFileSync(file2, POOL_ASM);
  const r2 = await runCli([file2]);
  expect(r2.code).toBe(0);
  expect(r2.stdout).not.toContain('gCell');
});

test('CLI: declaring BOTH elf and symbols is a usage error — two sources for one map', async () => {
  const root = tmp();
  writeFileSync(join(root, 'symbols.json'), MAP_JSON);
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    elf: game.elf\n    symbols: symbols.json\n',
  );
  const file = join(root, 'f.s');
  writeFileSync(file, POOL_ASM);
  const r = await runCli([file]);
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('BOTH elf and symbols');
});

test('CLI: an unreadable or malformed symbols map is loud, never a silent map-less run', async () => {
  const missing = tmp();
  writeFileSync(
    join(missing, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    symbols: nope.json\n',
  );
  const f1 = join(missing, 'f.s');
  writeFileSync(f1, POOL_ASM);
  const r = await runCli([f1]);
  expect(r.code).toBe(66);
  expect(r.stderr).toContain('cannot load symbols from tools.asmlift.symbols');

  const bad = tmp();
  writeFileSync(join(bad, 'symbols.json'), '{not json');
  writeFileSync(
    join(bad, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    symbols: symbols.json\n',
  );
  const f2 = join(bad, 'f.s');
  writeFileSync(f2, POOL_ASM);
  const r2 = await runCli([f2]);
  expect(r2.code).toBe(66);
});

// THE SHAPE AN EXCEPTION CANNOT REPORT, and the one the key exists to prevent. The check above
// covers a file that is missing or is not JSON — both throw. But `symbolMapFromJson` is a total
// function over `Object.entries`, so `[]`, `{}` and `{"nope": []}` are all VALID JSON that reduce
// to an EMPTY map with no error at all, and an empty map is byte-for-byte the state a map-less run
// is in. Unchecked, each of them exits 0 and scores a DIFFERENT source under DIFFERENT variations
// while a published repro script says the row had a map: a silent wrong answer wearing the
// provenance of a real one. Each shape is asserted separately — a single case would pass on a
// check that only rejected arrays.
test('CLI: a symbols map that PARSES but declares nothing is an input error, not a map-less run', async () => {
  for (const [body, needle] of [
    ['[]', 'is not a symbol map'],
    ['{}', 'declares no symbols'],
    ['{"nope": []}', 'is not a symbol map'],
    ['{"0x03001234": [{"kind": "data"}]}', 'is not a symbol map'],
  ] as const) {
    const root = tmp();
    writeFileSync(join(root, 'symbols.json'), body);
    writeFileSync(
      join(root, 'decomp.yaml'),
      'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    symbols: symbols.json\n',
    );
    const f = join(root, 'f.s');
    writeFileSync(f, POOL_ASM);
    const r = await runCli([f]);
    expect({ body, code: r.code }).toEqual({ body, code: 66 });
    expect(r.stderr).toContain(needle);
  }
});

// A BARE NAME THE MAP NEVER ANSWERED ABOUT. The pool word is `gCell`; the second cell is reached
// by `add r0, #4` and named from `addr(gCell) + 4` (raise/offsetnames.ts), so the base's address
// in the map — not just its name — decides which cell the reader sees spelled bare.
test('CLI: a name reached by arithmetic is published as `[walked]`', async () => {
  const root = tmp();
  writeFileSync(
    join(root, 'symbols.json'),
    JSON.stringify({
      '0x03005220': [{ name: 'gCell', kind: 'data', declared: true, shape: 'scalar', size: 4, signed: false }],
      '0x03005224': [{ name: 'gNext', kind: 'data', declared: true, shape: 'scalar', size: 4, signed: false }],
    }),
  );
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    symbols: symbols.json\n',
  );
  const file = join(root, 'f.s');
  writeFileSync(
    file,
    '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n\tldr\tr0, .L1\n\tadd\tr0, #4\n\tldr\tr0, [r0]\n\tbx\tlr\n\t.align 2\n.L1:\n\t.word\t0x03005220\n',
  );
  const r = await runCli([file]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('return gNext;');
  expect(r.stderr).toContain('[walked] 1 name(s) reached by arithmetic off a named address');
  expect(r.stderr).toContain('gNext');
});

// The absence is the assertion: a line that is always there says nothing.
test('CLI: a pool-loaded name alone prints no `[walked]` line', async () => {
  const root = tmp();
  writeFileSync(join(root, 'symbols.json'), MAP_JSON);
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    symbols: symbols.json\n',
  );
  const file = join(root, 'f.s');
  writeFileSync(file, POOL_ASM);
  const r = await runCli([file]);
  expect(r.code).toBe(0);
  expect(r.stderr).not.toContain('[walked]');
});

// The positive control for the test above: the SAME rig with a real map exits 0. Without it, a
// change that made every symbols-bearing run exit 66 would pass the loudness check.
test('CLI: the loud-rejection rig accepts a well-formed map (the control)', async () => {
  const root = tmp();
  writeFileSync(join(root, 'symbols.json'), MAP_JSON);
  writeFileSync(
    join(root, 'decomp.yaml'),
    'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n    symbols: symbols.json\n',
  );
  const f = join(root, 'f.s');
  writeFileSync(f, POOL_ASM);
  const r = await runCli([f]);
  expect(r.code).toBe(0);
});
