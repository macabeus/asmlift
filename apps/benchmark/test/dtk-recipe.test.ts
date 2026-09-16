// The GameCube projects' place in `bench setup --build` (cases/project-setup.ts, cases/setup.ts):
// they are dtk/ninja rather than gmake, they copy no baserom in (a disc image is the maintainer's
// to place), and their build is asynchronous because it supervises ninja — which `buildProject`
// has to await for a failure to be reported at all.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';

import type { RealManifest } from '../src/cases/manifests';
import { PROJECT_RECIPES } from '../src/cases/project-setup';
import { buildProject } from '../src/cases/setup';

const scratch = mkdtempSync(join(tmpdir(), 'dtk-recipe-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Every GameCube project and the disc version its rows are keyed to. */
const GAMECUBE: Record<string, string> = { 'ac-decomp': 'GAFE01_00', marioparty4: 'GMPE01_00', pikmin: 'GPIE01_01' };

describe('the GameCube recipes', () => {
  test.each(Object.keys(GAMECUBE))('%s copies no baserom in: its disc image is placed by hand', (project) => {
    expect(PROJECT_RECIPES[project].baseroms).toEqual([]);
  });

  test.each(Object.entries(GAMECUBE))('%s prepares only a checkout that still builds %s', (project, version) => {
    const root = join(scratch, project);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'configure.py'), 'DEFAULT_VERSION = 0\nVERSIONS = [\n    "ZZZZ01_00",\n]\n');
    expect(() => PROJECT_RECIPES[project].prepare?.(root)).toThrow(`builds ZZZZ01_00 by default, not ${version}`);
  });
});

const manifest = (project: string): RealManifest => ({
  project,
  repoDir: project,
  repo: 'o/n',
  branch: 'main',
  cppIncludes: [],
  headers: [],
  units: {},
  functions: [],
});

describe('an asynchronous build', () => {
  afterEach(() => delete PROJECT_RECIPES.asyncprobe);

  test('is awaited, so its failure is this project’s BUILD FAILED', async () => {
    PROJECT_RECIPES.asyncprobe = { baseroms: [], build: () => Promise.reject(new Error('ninja gave up\nlog: x')) };
    expect(await buildProject(manifest('asyncprobe'))).toEqual(['asyncprobe: BUILD FAILED — ninja gave up']);
  });
});
