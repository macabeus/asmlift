// A bench process compiles its ES module `.ts` files without tsx's `keepNames`
// (src/ts-transform-hook.mjs): a named closure a module creates costs no `name` redefinition. tsx
// alone, the control, wraps each one in a `__name` call. The hook keys the bytes it compiled the
// way loaded-code-hook.mjs does, which loaded-code.test.ts pins for a `.ts` module. Save
// `keepNames`, the hook emits what tsx emits: over the repo's own modules, beside a tsconfig that
// sets an option esbuild reads, and for a dynamic import tsx rewrites.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { loadedCodeArgv } from '../../src/loaded-code';
import { tsconfigStandDown, tsxTsconfigPath } from '../../src/ts-transform.mjs';
import { TSX_ONLY, runChild } from './loaded-code-child';

vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

/** A child whose `count.ts` counts each `name` property defined after it ran, then imports
 *  `mod.ts`, whose function binds a named arrow on each of its three calls. */
const tempDir = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ts-transform-')));
  roots.push(d);
  return d;
};

const child = (): string => {
  const d = tempDir();
  writeFileSync(join(d, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(d, 'count.ts'),
    [
      'let n = 0;',
      'export function names(): number {',
      '  return n;',
      '}',
      'const define = Object.defineProperty;',
      'Object.defineProperty = ((o: object, k: PropertyKey, a: PropertyDescriptor) => {',
      "  if (k === 'name') n++;",
      '  return define(o, k, a);',
      '}) as typeof Object.defineProperty;',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(d, 'mod.ts'),
    [
      'function twice(v: number): number {',
      '  const add = (w: number): number => w + v;',
      '  return add(v);',
      '}',
      'export const x = twice(1) + twice(2) + twice(3);',
      '',
    ].join('\n'),
  );
  const main = join(d, 'main.ts');
  writeFileSync(
    main,
    [
      "import { names } from './count.ts';",
      "import { x } from './mod.ts';",
      'console.log(JSON.stringify([x, names()]));',
      '',
    ].join('\n'),
  );
  return main;
};

describe('ts-transform-hook', () => {
  test('a bench process binds a named closure without redefining its name', async () => {
    expect(JSON.parse(await runChild(child(), null, { flags: loadedCodeArgv() }))).toEqual([12, 0]);
  });

  test('tsx alone, the control, redefines it on every call', async () => {
    // `add` on each of three calls, and `twice` once as the module runs
    expect(JSON.parse(await runChild(child(), null, { flags: TSX_ONLY }))).toEqual([12, 4]);
  });

  test('it emits what tsx emits for every repo module it compiles, keepNames aside', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    expect(tsconfigStandDown(tsxTsconfigPath(process.env, root))).toBeUndefined();
    const files = execFileSync('git', ['ls-files', '*.ts', '*.mts', ':!:*.d.ts'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /^(packages\/[^/]+\/(src|test)|apps\/benchmark\/(src|test)|scripts)\//.test(f))
      .map((f) => join(root, f));
    const out = join(tempDir(), 'capture.jsonl');
    const capture = new URL('./fixtures/tsx-capture-hook.mjs', import.meta.url).href;
    const importEach = fileURLToPath(new URL('./fixtures/import-each.mjs', import.meta.url));
    await runChild(importEach, files, {
      flags: [...TSX_ONLY, '--import', capture],
      env: { CAPTURE_OUT: out },
      cwd: root,
    });
    const lines = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { path: string; format: string; hooked: boolean; same: boolean });
    const hooked = lines.filter((l) => l.hooked);
    expect(lines.length).toBeGreaterThanOrEqual(files.length);
    expect(hooked.length).toBeGreaterThan(files.length / 2);
    expect(hooked.filter((l) => !l.same || l.format !== 'module').map((l) => l.path)).toEqual([]);
  });

  test('a tsconfig option esbuild reads leaves every file to tsx', async () => {
    const d = tempDir();
    writeFileSync(join(d, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(d, 'tsconfig.json'),
      '{\n  // a class field over a base setter assigns through it\n  "compilerOptions": { "target": "ESNext", "useDefineForClassFields": false, },\n}\n',
    );
    const main = join(d, 'main.ts');
    writeFileSync(
      main,
      [
        'class Base {',
        '  set x(v: number) {',
        '    console.log(`set ${v}`);',
        '  }',
        '}',
        'class Derived extends Base {',
        '  x = 1;',
        '}',
        "console.log(JSON.stringify(Object.getOwnPropertyDescriptor(new Derived(), 'x') ?? null));",
        '',
      ].join('\n'),
    );
    expect(tsconfigStandDown(join(d, 'tsconfig.json'))).toMatch(/useDefineForClassFields/);
    const expected = 'set 1\nnull';
    expect(await runChild(main, null, { flags: TSX_ONLY, cwd: d })).toBe(expected);
    expect(await runChild(main, null, { cwd: d })).toBe(expected);
    // the tsconfig named by TSX_TSCONFIG_PATH, tsx's override, here one that is not `tsconfig.json`
    const other = tempDir();
    writeFileSync(join(other, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(join(other, 'main.ts'), readFileSync(main));
    mkdirSync(join(other, 'cfg'));
    const config = readFileSync(join(d, 'tsconfig.json'), 'utf8').replace('{', '{ "files": ["../main.ts"],');
    writeFileSync(join(other, 'cfg', 'tsx.json'), config);
    const env = { TSX_TSCONFIG_PATH: join(other, 'cfg', 'tsx.json') };
    expect(await runChild(join(other, 'main.ts'), null, { flags: TSX_ONLY, env, cwd: other })).toBe(expected);
    expect(await runChild(join(other, 'main.ts'), null, { env, cwd: other })).toBe(expected);
  });

  test("a dynamic import spelled with a space gets tsx's interop", async () => {
    const d = tempDir();
    writeFileSync(join(d, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(d, 'c.cjs'),
      'Object.defineProperty(exports, "__esModule", { value: true });\nexports.default = "inner";\n',
    );
    const main = join(d, 'main.ts');
    // prettier-ignore
    writeFileSync(main, 'const m = await import ("./c.cjs");\nconsole.log(JSON.stringify(m.default));\n');
    expect(await runChild(main, null, { flags: TSX_ONLY })).toBe('"inner"');
    expect(await runChild(main, null)).toBe('"inner"');
  });
});
