// Pins for `bench setup` + checkout pinning: manifest repo/branch validation, and setup's
// NEVER-MUTATE rule for existing checkouts (the maintainer's checkouts carry WIP — a harness
// command must not touch them). Remote lookups are stubbed — no network in CI.
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { checkoutStatus } from '../src/cases/checkout';
import { type RealManifest, validateManifest } from '../src/cases/manifests';
import { setupProject } from '../src/cases/setup';

const base: RealManifest = {
  project: 'fakeproj',
  toolchain: 'agbcc',
  repoDir: 'fakeproj',
  repo: 'macabeus/fakeproj',
  branch: 'asmlift-benchmark',
  cppIncludes: [],
  headers: [],
  functions: [{ sym: 'f', features: [], funcC: 'int f(void) { return 1; }' }],
};

describe('validateManifest: repo/branch pins', () => {
  test('a well-formed manifest validates', () => {
    expect(validateManifest(base, 'x.json')).toEqual([]);
  });

  test('repo must be owner/name — URLs and malformed values fail', () => {
    for (const repo of ['https://github.com/macabeus/af', 'github.com/macabeus/af', 'af', 'a/b/c', '', undefined]) {
      const problems = validateManifest({ ...base, repo }, 'x.json');
      expect(problems.join('\n'), JSON.stringify(repo)).toContain('"repo" must be a GitHub owner/name');
    }
  });

  test('branch must be a non-empty string', () => {
    for (const branch of ['', undefined, 42]) {
      const problems = validateManifest({ ...base, branch }, 'x.json');
      expect(problems.join('\n'), JSON.stringify(branch)).toContain('"branch" must be a non-empty string');
    }
  });

  test('elfMake, when present, must be a non-empty string', () => {
    expect(validateManifest({ ...base, elfMake: 'asmlift-elf' }, 'x.json')).toEqual([]);
    expect(validateManifest({ ...base, elfMake: '' }, 'x.json').join('\n')).toContain('"elfMake"');
  });
});

describe('bench setup never mutates an existing checkout', () => {
  const dirs: string[] = [];
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'asmlift-setup-test-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    delete process.env.ASMLIFT_PROJ_FAKEPROJ;
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  const snapshot = (dir: string): string => readdirSync(dir, { recursive: true }).map(String).sort().join('\n');

  test('an existing NON-git dir is reported, not cloned into', () => {
    const dir = join(scratch(), 'fakeproj');
    mkdirSync(dir);
    writeFileSync(join(dir, 'WIP-marker.txt'), 'precious work in progress\n');
    process.env.ASMLIFT_PROJ_FAKEPROJ = dir;
    const before = snapshot(dir);
    const row = setupProject(base, () => 'f'.repeat(40)); // stubbed remote — must not even be needed
    expect(row.action).toBe('kept');
    expect(snapshot(dir)).toBe(before);
    expect(readFileSync(join(dir, 'WIP-marker.txt'), 'utf8')).toContain('precious');
    expect(row.notes.join(' ')).toContain('not a git checkout');
  });

  test('an existing git checkout keeps its HEAD and worktree even when it drifted from the pin', () => {
    const dir = join(scratch(), 'fakeproj');
    mkdirSync(dir);
    const g = (args: string) =>
      execSync(`git -C ${JSON.stringify(dir)} ${args}`, {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      }).trim();
    g('init -q');
    writeFileSync(join(dir, 'file.c'), 'int wip;\n');
    g('add file.c');
    g('commit -qm base');
    const head = g('rev-parse HEAD');
    writeFileSync(join(dir, 'file.c'), 'int wip2; /* uncommitted */\n');
    process.env.ASMLIFT_PROJ_FAKEPROJ = dir;

    const remoteHead = 'a'.repeat(40); // deliberately != local HEAD
    const row = setupProject(base, () => remoteHead);
    expect(row.action).toBe('kept');
    expect(row.head).toBe(head);
    expect(row.remoteHead).toBe(remoteHead);
    expect(row.dirty).toBe(true);
    expect(row.notes.join(' ')).toContain('HEAD !=');
    // the checkout itself is untouched: same HEAD, same uncommitted WIP
    expect(g('rev-parse HEAD')).toBe(head);
    expect(readFileSync(join(dir, 'file.c'), 'utf8')).toContain('uncommitted');
  });

  test('checkoutStatus itself is read-only and reports offline provenance state', () => {
    const dir = join(scratch(), 'fakeproj');
    mkdirSync(dir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execSync(`git -C ${JSON.stringify(dir)} init -q`, { env });
    writeFileSync(join(dir, 'f'), 'x\n');
    execSync(`git -C ${JSON.stringify(dir)} add f`, { env });
    execSync(`git -C ${JSON.stringify(dir)} commit -qm base`, { env });
    process.env.ASMLIFT_PROJ_FAKEPROJ = dir;
    const before = snapshot(dir);
    const st = checkoutStatus(base, () => null); // offline: remote unreachable
    expect(st.present).toBe(true);
    expect(st.remoteHead).toBeNull();
    expect(snapshot(dir)).toBe(before);
  });
});
