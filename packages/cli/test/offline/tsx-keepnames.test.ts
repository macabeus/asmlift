// tsx runs without esbuild's `keepNames` (patches/tsx@4.23.1.patch, which flips the one option tsx
// hardcodes on). With it on, every named function a module creates is wrapped in a `__name(fn,
// "fn")` call that redefines its `name`: a property call per closure, paid wherever a function binds
// a named arrow per call, and about a quarter of `kleod:PauseMenuScreenHandler:agbcc`'s fan
// enumeration. The bundled CLI (`scripts/build.mjs`) has never carried it.
//
// Off, a function's `name` is not always the one the source spells: esbuild renames a local that
// shadows an import (`const memberOf` in core's contracts.ts reads back as `memberOf2`). Nothing
// here reads a function's `name` to decide anything, which is what makes the option free to drop.
// The patch keeps the rest of tsx exact (its tsconfig handling, import interop, disk cache, whose
// key hashes the options, so no entry compiled with `keepNames` is served); a tsx bump the patch
// no longer applies to fails `pnpm install`.
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { loadedCodeArgv } from '../../src/loaded-code';
import { TSX_ONLY, runChild } from './loaded-code-child';

vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

/** A child whose `count.ts` counts each `name` property defined after it ran, then imports
 *  `mod.ts`, whose function binds a named arrow on each of its three calls. Under `keepNames` that
 *  is 4 redefinitions: `add` on each call, and `twice` once as the module runs. */
const child = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'tsx-keepnames-')));
  roots.push(d);
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

describe('tsx without keepNames', () => {
  test('a bench process binds a named closure without redefining its name', async () => {
    expect(JSON.parse(await runChild(child(), null, { flags: loadedCodeArgv() }))).toEqual([12, 0]);
  });

  test('so does any tsx process', async () => {
    expect(JSON.parse(await runChild(child(), null, { flags: TSX_ONLY }))).toEqual([12, 0]);
  });

  test('the installed tsx sets keepNames nowhere', () => {
    const dist = dirname(createRequire(import.meta.url).resolve('tsx'));
    const sets = readdirSync(dist)
      .filter((f) => /\.[cm]?js$/.test(f))
      .flatMap((f) =>
        [...readFileSync(join(dist, f), 'utf8').matchAll(/keepNames:(![01]|true|false)/g)].map((m) => m[1]),
      );
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.filter((v) => v !== '!1' && v !== 'false')).toEqual([]);
  });
});
