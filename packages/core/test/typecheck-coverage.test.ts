// A local gate that disagrees with CI is worse than no gate — it teaches people to trust a green
// run that does not mean what they think. The repo has four tsconfigs and no single project that
// spans them, so `pnpm typecheck` is a hand-written chain of `tsc` invocations; this file is what
// keeps that chain from falling behind the configs on disk and behind the commands CI runs.
//
// Both checks read the root `typecheck` script and resolve each invocation to the tsconfig FILE it
// compiles, so a project named by its directory and one named by its file path are the same entry.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

// Tracked files only: the benchmark's project checkouts and toolchains are gitignored (and are
// symlinks in a worktree), and third-party tsconfigs under them are nobody's gate.
const tracked = (pattern: string) =>
  execFileSync('git', ['ls-files', '-z', pattern], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

// `tsc --noEmit` compiles ./tsconfig.json; `-p X` compiles X itself when it names a file and
// X/tsconfig.json when it names a directory.
const projectOf = (invocation: string, cwd: string) => {
  const p = /(?:-p|--project)\s+(\S+)/.exec(invocation)?.[1];
  if (p === undefined) return normalize(join(cwd, 'tsconfig.json'));
  return normalize(p.endsWith('.json') ? join(cwd, p) : join(cwd, p, 'tsconfig.json'));
};

const tscInvocations = (script: string) => script.split('&&').filter((s) => /(^|\s)tsc(\s|$)/.test(s.trim()));

const rootScripts: Record<string, string> = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const typecheckProjects = new Set(tscInvocations(rootScripts.typecheck).map((i) => projectOf(i, '.')));

test('`pnpm typecheck` compiles every tsconfig in the repo', () => {
  const onDisk = tracked('*tsconfig*.json').map(normalize);
  expect(onDisk.length, 'no tsconfig found — this check would assert nothing').toBeGreaterThan(0);
  const unchecked = onDisk.filter((f) => !typecheckProjects.has(f));
  expect(unchecked, `tsconfigs the root \`typecheck\` script never compiles: ${unchecked.join(', ')}`).toEqual([]);
});

// The other direction of the same drift: a package script may type-check a project of its own, and
// CI runs those scripts (the `web` job's build is `tsc --noEmit && tsc --noEmit -p
// tsconfig.test.json && vite build`). Anything CI compiles must be something `pnpm typecheck`
// compiles too, or a branch goes green locally and red on a hosted runner.
test('`pnpm typecheck` compiles every project a package script type-checks', () => {
  const missing: string[] = [];
  for (const manifest of tracked('*package.json')) {
    const scripts: Record<string, string> = JSON.parse(readFileSync(join(root, manifest), 'utf8')).scripts ?? {};
    for (const [name, script] of Object.entries(scripts)) {
      if (manifest === 'package.json' && name === 'typecheck') continue;
      for (const invocation of tscInvocations(script)) {
        const project = projectOf(invocation, dirname(manifest));
        if (!typecheckProjects.has(project)) missing.push(`${manifest} \`${name}\` compiles ${project}`);
      }
    }
  }
  expect(missing, `projects CI type-checks that \`pnpm typecheck\` does not: ${missing.join('; ')}`).toEqual([]);
});
