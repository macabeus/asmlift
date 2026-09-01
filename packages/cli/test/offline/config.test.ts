// decomp.yaml (decomp_settings) loading + target resolution — offline. Fixtures are written
// to per-test temp dirs; nothing depends on the repo's own tree (asmlift has no decomp.yaml).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

import { loadDecompConfig, resolveTarget } from '../../src/config';
import { runCli } from '../../src/main';

const tmp = () => mkdtempSync(join(tmpdir(), 'asmlift-cfg-'));

test('upward walk finds decomp.yaml from a nested dir; .yml is the fallback spelling', () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'platform: gba\n');
  const nested = join(root, 'src', 'battle');
  mkdirSync(nested, { recursive: true });
  expect(loadDecompConfig(undefined, nested)?.config.platform).toBe('gba');

  const root2 = tmp();
  writeFileSync(join(root2, 'decomp.yml'), 'platform: gc\n');
  expect(loadDecompConfig(undefined, root2)?.config.platform).toBe('gc');
});

test('no config anywhere is null; an explicit missing --config path throws', () => {
  expect(loadDecompConfig(undefined, tmpdir())).toBeNull();
  expect(() => loadDecompConfig(join(tmp(), 'nope.yaml'))).toThrow(/config not found/);
});

test('malformed YAML and non-mapping top levels throw loud with the file path', () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'platform: [unclosed\n');
  expect(() => loadDecompConfig(undefined, root)).toThrow(/cannot parse/);
  const root2 = tmp();
  writeFileSync(join(root2, 'decomp.yaml'), '- just\n- a list\n');
  expect(() => loadDecompConfig(undefined, root2)).toThrow(/YAML mapping/);
});

test('target resolution precedence: flag > tools.asmlift.target > platform', () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'platform: gba\ntools:\n  asmlift:\n    target: ido7.1\n');
  const loaded = loadDecompConfig(undefined, root);
  expect(resolveTarget('mwcc_242_81', loaded)).toEqual({ targetKey: 'mwcc_242_81', trace: '--target flag' });
  const viaTool = resolveTarget(undefined, loaded);
  expect('targetKey' in viaTool && viaTool.targetKey).toBe('ido7.1');
  const platformOnly = loadDecompConfig(
    undefined,
    (() => {
      const r = tmp();
      writeFileSync(join(r, 'decomp.yaml'), 'platform: gba\n');
      return r;
    })(),
  );
  const viaPlatform = resolveTarget(undefined, platformOnly);
  expect('targetKey' in viaPlatform && viaPlatform.targetKey).toBe('agbcc');
});

test('ambiguous and unknown platforms DECLINE naming the candidates, never guess', () => {
  const n64 = tmp();
  writeFileSync(join(n64, 'decomp.yaml'), 'platform: n64\n');
  const amb = resolveTarget(undefined, loadDecompConfig(undefined, n64));
  expect('error' in amb && amb.error).toMatch(/ido7.1 or gcc2.7.2kmc/);

  const weird = tmp();
  writeFileSync(join(weird, 'decomp.yaml'), 'platform: dreamcast\n');
  const unk = resolveTarget(undefined, loadDecompConfig(undefined, weird));
  expect('error' in unk && unk.error).toMatch(/no asmlift target mapping/);

  const none = resolveTarget(undefined, null);
  expect('error' in none && none.error).toMatch(/no --target/);
});

test('CLI: --target becomes optional inside a configured project (trace on stderr)', async () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'platform: gba\n');
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
  writeFileSync(join(root, 'decomp.yaml'), 'platform: n64\n');
  const file = join(root, 'f.asm');
  writeFileSync(file, '00000000 <f>:\n   0:\tjr\tra\n   4:\tnop\n');
  const r = await runCli([file]);
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('ido7.1 or gcc2.7.2kmc');
});

test('CLI: --score-against without tools.asmlift.compiler is a usage error, never a fallback', async () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'platform: gba\n'); // no compiler command
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
  writeFileSync(join(root, 'decomp.yaml'), 'platform: gba\ntools:\n  asmlift:\n    compiler: gcc -c -o out.o\n');
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

// `tools.asmlift.cacheInputs` existed for one round: a per-project DECLARATION of everything the
// compile command reads, and the gate the candidate-object cache would not start without. It is
// gone — the namespace measures the command's paths instead of being told them — and a config
// still carrying it would otherwise be silently ignored, leaving a reader believing a seatbelt is
// fastened that no longer exists. Loading it must not FAIL (an obsolete key is not a broken
// project, and the cache is now strictly more complete than the declaration was), but it must say
// so once.
test('an obsolete cacheInputs key loads, and says out loud that it does nothing', () => {
  const root = tmp();
  writeFileSync(
    join(root, 'decomp.yaml'),
    'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n    cacheInputs:\n      - inc\n',
  );
  const said: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    said.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  });
  try {
    expect(loadDecompConfig(join(root, 'decomp.yaml'))?.config.tools?.asmlift?.target).toBe('agbcc');
  } finally {
    spy.mockRestore();
  }
  expect(said.join('')).toMatch(/cacheInputs.*no longer/);
});

// `tools.asmlift.candidateCache` is what came back in `cacheInputs`' place, and it is deliberately
// the OTHER shape: a refusal, never an assertion. `cacheInputs` was wrong in the stale-object
// direction when a project under-declared; this one is wrong in the cold-start direction when a
// project over-refuses. There is exactly one value, because there is no value that could turn the
// cache ON — the environment already does that, and a project cannot know more than the
// measurement does.
test("tools.asmlift.candidateCache: off loads as the string 'off', not YAML 1.1's boolean", () => {
  const root = tmp();
  writeFileSync(
    join(root, 'decomp.yaml'),
    'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n    candidateCache: off\n',
  );
  // The `yaml` package parses with the 1.2 core schema, where `off` is a plain string. If that
  // ever changed under us the key would arrive as `false`, the validator below would throw, and
  // every project declaring the refusal would fail to load — so pin the parse, not just the use.
  expect(loadDecompConfig(join(root, 'decomp.yaml'))?.config.tools?.asmlift?.candidateCache).toBe('off');
});

test('any other value is a loud error — a typo must never read as "on"', () => {
  const root = tmp();
  writeFileSync(
    join(root, 'decomp.yaml'),
    'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n    candidateCache: on\n',
  );
  expect(() => loadDecompConfig(join(root, 'decomp.yaml'))).toThrow(/candidateCache must be 'off'/);
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
    'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n    symbols: symbols.json\n',
  );
  const file = join(root, 'f.s');
  writeFileSync(file, POOL_ASM);
  const r = await runCli([file]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('gCell');

  // the same run with the key removed is the control: no map, no name — so the assertion above
  // is about the map being LOADED, not about the address happening to render that way.
  const bare = tmp();
  writeFileSync(join(bare, 'decomp.yaml'), 'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n');
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
    'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n    elf: game.elf\n    symbols: symbols.json\n',
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
    'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n    symbols: nope.json\n',
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
    'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n    symbols: symbols.json\n',
  );
  const f2 = join(bad, 'f.s');
  writeFileSync(f2, POOL_ASM);
  const r2 = await runCli([f2]);
  expect(r2.code).toBe(66);
});
