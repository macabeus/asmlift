// A bench process compiles its ES module `.ts` files without tsx's `keepNames`
// (src/ts-transform-hook.mjs): a named closure a module creates costs no `name` redefinition. tsx
// alone, the control, wraps each one in a `__name` call. The hook keys the bytes it compiled the
// way loaded-code-hook.mjs does, which loaded-code.test.ts pins for a `.ts` module.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 *  `mod.ts`, whose function binds a named arrow on each of its three calls. */
const child = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ts-transform-')));
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

describe('ts-transform-hook', () => {
  test('a bench process binds a named closure without redefining its name', async () => {
    expect(JSON.parse(await runChild(child(), null, { flags: loadedCodeArgv() }))).toEqual([12, 0]);
  });

  test('tsx alone, the control, redefines it on every call', async () => {
    // `add` on each of three calls, and `twice` once as the module runs
    expect(JSON.parse(await runChild(child(), null, { flags: TSX_ONLY }))).toEqual([12, 4]);
  });
});
