// What a process keys as the code it loaded (src/loaded-code.ts): with the load hook, the bytes each
// module was compiled from; without it, the file on disk while nothing has changed it since the
// process started. Each edit below lands in the window an ES module graph opens — after Node
// fetched a module, before any of it runs — by pausing the child there (loaded-code-child.ts).
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { runnerPackageDir } from '../../src/compile-command';
import { loadedCodeArgv, loadedCodeDigest, withLoadedCodeArgv } from '../../src/loaded-code';
import { benchAgbcc } from './bench-command-double';
import { TSX_ONLY, runChild } from './loaded-code-child';

vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});
const scratch = (prefix: string, under = tmpdir()): string => {
  const d = realpathSync(mkdtempSync(join(under, prefix)));
  roots.push(d);
  return d;
};
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const LOADED_CODE = pathToFileURL(fileURLToPath(new URL('../../src/loaded-code.ts', import.meta.url))).href;

/** A child, in `dir` as an ES module package, that imports each of `modules`, then prints the `x`
 *  each exports and `loadedCodeDigest` of each of `digests` (or what it threw). */
const probe = (dir: string): string => {
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  const p = join(dir, 'probe.ts');
  writeFileSync(
    p,
    [
      'const [loadedCode, modules, digests] = JSON.parse(process.argv[2]) as [string, string[], string[]];',
      'const { loadedCodeDigest } = await import(loadedCode);',
      'const values: unknown[] = [];',
      'for (const m of modules) values.push((await import(m)).x);',
      'const digest = (p: string): string => {',
      '  try {',
      '    return loadedCodeDigest(p);',
      '  } catch (e) {',
      "    return 'THROW ' + (e as Error).message;",
      '  }',
      '};',
      'console.log(JSON.stringify({ values, digests: digests.map(digest) }));',
      '',
    ].join('\n'),
  );
  return p;
};
type Probed = { values: unknown[]; digests: string[] };

describe('with the load hook', () => {
  test.each(['mod.ts', 'mod.js'])(
    'R310-43: keys the bytes %s was compiled from, not the ones on disk when it runs',
    async (name) => {
      const d = scratch('loaded-code-');
      const mod = join(d, name);
      const before = 'export const x = 1;\n';
      writeFileSync(mod, before);
      const out = JSON.parse(
        await runChild(probe(d), [LOADED_CODE, [pathToFileURL(mod).href], [mod]], {
          pause: { at: pathToFileURL(mod).href, edit: () => writeFileSync(mod, 'export const x = 2;\n') },
        }),
      ) as Probed;
      expect(out.values, 'the child ran the text it fetched').toEqual([1]);
      expect(out.digests).toEqual([sha(before)]);
    },
  );

  test('keys a file replaced by rename the same way', async () => {
    const d = scratch('loaded-code-');
    const mod = join(d, 'mod.js');
    writeFileSync(mod, 'export const x = 1;\n');
    writeFileSync(join(d, 'next.js'), 'export const x = 2;\n');
    const out = JSON.parse(
      await runChild(probe(d), [LOADED_CODE, [pathToFileURL(mod).href], [mod]], {
        pause: { at: pathToFileURL(mod).href, edit: () => renameSync(join(d, 'next.js'), mod) },
      }),
    ) as Probed;
    expect(out).toEqual({ values: [1], digests: [sha('export const x = 1;\n')] });
  });

  test('refuses a file it did not see loaded', async () => {
    const d = scratch('loaded-code-');
    writeFileSync(join(d, 'never.js'), 'export const x = 1;\n');
    const out = JSON.parse(await runChild(probe(d), [LOADED_CODE, [], [join(d, 'never.js')]])) as Probed;
    expect(out.digests[0]).toMatch(/^THROW .*never\.js is namespace code this process's load hook did not see loaded/);
  });

  test('refuses a file loaded twice from two texts', async () => {
    const d = scratch('loaded-code-');
    const mod = join(d, 'mod.mjs');
    writeFileSync(mod, 'export const x = 1;\n');
    const url = pathToFileURL(mod).href;
    const out = JSON.parse(
      await runChild(probe(d), [LOADED_CODE, [`${url}?a`, `${url}?b`], [mod]], {
        pause: { at: `${url}?a`, edit: () => writeFileSync(mod, 'export const x = 2;\n') },
      }),
    ) as Probed;
    expect(out.values).toEqual([1, 2]);
    expect(out.digests[0]).toMatch(/^THROW .*mod\.mjs was loaded twice, from two texts/);
  });

  test('R310-43: a process whose runner changed while its graph loaded keys the runner it runs', async () => {
    // This package's sources and a copy of the runner beside them, which they resolve first, and a
    // child per stamp; the edit is the runner's `sh -ec` made `sh -c`, by rename as an install
    // writes it, in the window between the fetch of `run.js` and the first line that runs.
    const pkg = fileURLToPath(new URL('../..', import.meta.url));
    const root = scratch('.r310-43-', pkg);
    cpSync(join(pkg, 'src'), join(root, 'src'), { recursive: true });
    const runner = join(root, 'node_modules/@match-kit/compiler');
    mkdirSync(runner, { recursive: true });
    cpSync(runnerPackageDir(), runner, { recursive: true, dereference: true });
    const runJs = join(runner, 'dist/process/run.js');
    const original = readFileSync(runJs, 'utf8');
    expect(original).toContain("spawn('sh', ['-ec', command]");
    const edit = (): void => {
      writeFileSync(`${runJs}.next`, original.replace("spawn('sh', ['-ec', command]", "spawn('sh', ['-c', command]"));
      renameSync(`${runJs}.next`, runJs);
    };
    const stamper = join(root, 'stamp.ts');
    writeFileSync(
      stamper,
      [
        'const [command, cwd] = JSON.parse(process.argv[2]) as [string, string];',
        "const { commandStaticStamp, runnerPackageDir } = await import('./src/compile-command');",
        'console.log(JSON.stringify([runnerPackageDir(), commandStaticStamp(command, cwd)]));',
        '',
      ].join('\n'),
    );
    const bench = benchAgbcc();
    const cwd = scratch('loaded-code-cwd-');
    const stamp = async (pause?: { at: string; edit: () => void }): Promise<string> => {
      const [dir, s] = JSON.parse(await runChild(stamper, [bench.command, cwd], { pause })) as [string, string];
      expect(dir, 'the copy resolves its own runner').toBe(runner);
      return s;
    };
    const loaded = await stamp();
    expect(await stamp({ at: pathToFileURL(runJs).href, edit }), 'it ran the -ec it fetched, and keys that').toBe(
      loaded,
    );
    expect(await stamp(), 'a process that fetched the -c is another namespace').not.toBe(loaded);
  });
});

describe('without the load hook', () => {
  test('keys a file unchanged since the process started by its bytes', () => {
    const source = fileURLToPath(new URL('../../src/shell-text.ts', import.meta.url));
    expect(loadedCodeDigest(source)).toBe(sha(readFileSync(source)));
  });

  test('refuses a file changed after the process started, and one it cannot read', () => {
    const d = scratch('loaded-code-');
    writeFileSync(join(d, 'fresh.ts'), 'export const x = 1;\n');
    expect(() => loadedCodeDigest(join(d, 'fresh.ts'))).toThrow(/fresh\.ts changed after this process started/);
    expect(() => loadedCodeDigest(join(d, 'absent.ts'))).toThrow(/cannot read .*absent\.ts/);
  });

  test('R310-43: refuses a file renamed over in the window, and keys it when nothing moved', async () => {
    const d = scratch('loaded-code-');
    const mod = join(d, 'mod.js');
    writeFileSync(mod, 'export const x = 1;\n');
    writeFileSync(join(d, 'next.js'), 'export const x = 2;\n');
    const script = probe(d);
    // Older than the child's start by more than the slack a coarse file system gets.
    await new Promise((r) => setTimeout(r, 2_100));
    const args = [LOADED_CODE, [pathToFileURL(mod).href], [mod]];
    const still = JSON.parse(await runChild(script, args, { flags: TSX_ONLY })) as Probed;
    expect(still).toEqual({ values: [1], digests: [sha('export const x = 1;\n')] });
    const moved = JSON.parse(
      await runChild(script, args, {
        flags: TSX_ONLY,
        pause: { at: pathToFileURL(mod).href, edit: () => renameSync(join(d, 'next.js'), mod) },
      }),
    ) as Probed;
    expect(moved.values).toEqual([1]);
    expect(moved.digests[0]).toMatch(/^THROW .*mod\.js changed after this process started/);
  });
});

describe('withLoadedCodeArgv', () => {
  test('puts the hook ahead of tsx, in place of either preload a process held', () => {
    const tsxCli = [
      '--require',
      '/r/node_modules/tsx/dist/preflight.cjs',
      '--import',
      'file:///r/node_modules/tsx/dist/loader.mjs',
      '--max-old-space-size=4096',
    ];
    expect(withLoadedCodeArgv(tsxCli)).toEqual([...loadedCodeArgv(), '--max-old-space-size=4096']);
    expect(withLoadedCodeArgv(loadedCodeArgv())).toEqual(loadedCodeArgv());
    expect(withLoadedCodeArgv(['--conditions=development'])).toEqual([...loadedCodeArgv(), '--conditions=development']);
  });
});
