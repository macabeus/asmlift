// decomp.yaml (decomp_settings) loading + target resolution — offline. Fixtures are written
// to per-test temp dirs; nothing depends on the repo's own tree (asmlift has no decomp.yaml).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

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
  writeFileSync(join(root, 'decomp.yaml'), 'platform: gba\ntools:\n  asmlift:\n    target: ido-mips\n');
  const loaded = loadDecompConfig(undefined, root);
  expect(resolveTarget('mwcc-ppc', loaded)).toEqual({ targetKey: 'mwcc-ppc', trace: '--target flag' });
  const viaTool = resolveTarget(undefined, loaded);
  expect('targetKey' in viaTool && viaTool.targetKey).toBe('ido-mips');
  const platformOnly = loadDecompConfig(
    undefined,
    (() => {
      const r = tmp();
      writeFileSync(join(r, 'decomp.yaml'), 'platform: gba\n');
      return r;
    })(),
  );
  const viaPlatform = resolveTarget(undefined, platformOnly);
  expect('targetKey' in viaPlatform && viaPlatform.targetKey).toBe('agbcc-arm');
});

test('ambiguous and unknown platforms DECLINE naming the candidates, never guess', () => {
  const n64 = tmp();
  writeFileSync(join(n64, 'decomp.yaml'), 'platform: n64\n');
  const amb = resolveTarget(undefined, loadDecompConfig(undefined, n64));
  expect('error' in amb && amb.error).toMatch(/ido-mips or gcc-mips/);

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
  expect(r.stderr).toContain('[config] target agbcc-arm');
});

test('CLI: ambiguous platform without --target is a usage error naming both', async () => {
  const root = tmp();
  writeFileSync(join(root, 'decomp.yaml'), 'platform: n64\n');
  const file = join(root, 'f.asm');
  writeFileSync(file, '00000000 <f>:\n   0:\tjr\tra\n   4:\tnop\n');
  const r = await runCli([file]);
  expect(r.code).toBe(64);
  expect(r.stderr).toContain('ido-mips or gcc-mips');
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
