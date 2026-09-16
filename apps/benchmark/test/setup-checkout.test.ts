// Pins for `bench setup` + checkout pinning: manifest repo/branch validation, and setup's
// NEVER-MUTATE rule for existing checkouts (the maintainer's checkouts carry WIP — a harness
// command must not touch them). Remote lookups are stubbed — no network in CI.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { checkoutStatus } from '../src/cases/checkout';
import { type RealManifest, benchCheckoutsDir, resolveProjectRoot, validateManifest } from '../src/cases/manifests';
import { setupProject } from '../src/cases/setup';
import { WORKSPACE } from '../src/config';

const base: RealManifest = {
  project: 'fakeproj',
  repoDir: 'fakeproj',
  repo: 'macabeus/fakeproj',
  branch: 'asmlift-benchmark',
  cppIncludes: [],
  headers: [],
  units: {
    'src/f.c': {
      toolchain: 'agbcc',
      cflags: ['-mthumb-interwork', '-O2', '-fhex-asm'],
      flagsFrom: {
        from: 'makefile',
        commit: 'a'.repeat(40),
        file: 'Makefile',
        sha256: 'b'.repeat(64),
        command: 'agbcc -mthumb-interwork -O2 -fhex-asm -o f.s -',
      },
    },
  },
  functions: [
    {
      sym: 'f',
      addr: '0x08000000',
      unit: 'src/f.c',
      romDigest: 'c'.repeat(64),
      features: [],
      funcC: 'int f(void) { return 1; }',
      sourceUrl: 'https://github.com/macabeus/fakeproj/blob/0123456/src/f.c#L1-L1',
    },
  ],
};

describe('validateManifest: row identity', () => {
  const GOOD = base.functions[0].sourceUrl;
  // `sourceUrl` is taken from an options bag, not a defaulted parameter: a default would swallow
  // the explicit `undefined` the missing-URL case passes.
  const fn = (sym: string, addr: unknown, aliases?: string[], over: { sourceUrl?: unknown } = { sourceUrl: GOOD }) =>
    ({
      sym,
      addr,
      unit: 'src/f.c',
      romDigest: 'c'.repeat(64),
      aliases,
      features: [],
      funcC: `int ${sym}(void) { return 1; }`,
      sourceUrl: over.sourceUrl,
    }) as RealManifest['functions'][number];

  test('a row must cite a commit-pinned permalink into the repo its manifest pins', () => {
    // `joinArtifacts` keys two rows at one address apart by the repository each cites, and skips
    // that split when either side cites none — so a row with no sourceUrl would join another
    // decompilation's row at its address without a word.
    for (const bad of [undefined, '', 'https://github.com/macabeus/fakeproj/tree/main/src/f.c', 42]) {
      const p = validateManifest(
        { ...base, functions: [fn('f', '0x08000000', undefined, { sourceUrl: bad })] },
        'x.json',
      );
      expect(p.join('\n'), JSON.stringify(bad)).toMatch(/"sourceUrl" must be a commit-pinned/);
    }
    const other = 'https://github.com/Dream-Atelier/kl-eod-decomp/blob/494f499/src/f.c#L1-L1';
    const p = validateManifest(
      { ...base, functions: [fn('f', '0x08000000', undefined, { sourceUrl: other })] },
      'x.json',
    );
    expect(p.join('\n')).toMatch(/cites Dream-Atelier\/kl-eod-decomp, not this manifest's repo macabeus\/fakeproj/);
  });

  test('an addr is a linked address (0x + 8 lowercase hex) or a REL module location', () => {
    for (const bad of [undefined, '0800045c', '0x0800045C', '0x800045c', 0x0800045c, 'm416Dll:.text+0x1f20']) {
      const p = validateManifest({ ...base, functions: [fn('f', bad)] }, 'x.json');
      expect(p.join('\n'), JSON.stringify(bad)).toMatch(/"addr" must be where the function is/);
    }
    // a module location is a row identity like any other — no complaint about `addr`
    const ok = validateManifest({ ...base, functions: [fn('f', 'm416Dll:.text+0x00001f20')] }, 'x.json');
    expect(ok.join('\n')).not.toMatch(/"addr"/);
  });

  test('two rows of one project in one module at one offset are one function listed twice', () => {
    const p = validateManifest(
      { ...base, functions: [fn('f', 'm416Dll:.text+0x00001f20'), fn('g', 'm416Dll:.text+0x00001f20')] },
      'x.json',
    );
    expect(p.join('\n')).toMatch(/shares addr m416Dll:\.text\+0x00001f20/);
  });

  test('two rows of one project at the same address are one function listed twice', () => {
    const p = validateManifest({ ...base, functions: [fn('f', '0x08000000'), fn('g', '0x08000000')] }, 'x.json');
    expect(p.join('\n')).toMatch(/shares addr 0x08000000/);
  });

  test('a name — current or former — may answer to only one row, or a citation of it is ambiguous', () => {
    const p = validateManifest(
      { ...base, functions: [fn('ReadU16', '0x08000000', ['sub_0804B270']), fn('sub_0804B270', '0x08000004')] },
      'x.json',
    );
    expect(p.join('\n')).toMatch(/"sub_0804B270" answers to two rows/);
  });
});

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

describe('checkout resolution order: env override > bench-owned > sibling WORKSPACE', () => {
  const dirs: string[] = [];
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'asmlift-resolve-test-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    delete process.env.ASMLIFT_PROJ_FAKEPROJ;
    delete process.env.ASMLIFT_BENCH_CHECKOUTS;
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('sibling WORKSPACE dir is the fallback when nothing else exists', () => {
    process.env.ASMLIFT_BENCH_CHECKOUTS = scratch(); // empty — no bench-owned checkout
    expect(resolveProjectRoot(base)).toBe(join(WORKSPACE, 'fakeproj'));
  });

  test('a present bench-owned checkout wins over the sibling dir', () => {
    const checkouts = scratch();
    process.env.ASMLIFT_BENCH_CHECKOUTS = checkouts;
    mkdirSync(join(checkouts, 'fakeproj'));
    expect(resolveProjectRoot(base)).toBe(join(checkouts, 'fakeproj'));
    expect(benchCheckoutsDir()).toBe(checkouts);
  });

  test('the ASMLIFT_PROJ_* env override wins over everything', () => {
    const checkouts = scratch();
    process.env.ASMLIFT_BENCH_CHECKOUTS = checkouts;
    mkdirSync(join(checkouts, 'fakeproj'));
    process.env.ASMLIFT_PROJ_FAKEPROJ = '/somewhere/else';
    expect(resolveProjectRoot(base)).toBe('/somewhere/else');
  });
});

describe('bench setup clones into the bench-owned workspace', () => {
  const dirs: string[] = [];
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'asmlift-benchowned-test-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    delete process.env.ASMLIFT_PROJ_FAKEPROJ;
    delete process.env.ASMLIFT_BENCH_CHECKOUTS;
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('with no env override, the clone target is the bench-owned dir — never the sibling', () => {
    const checkouts = scratch();
    process.env.ASMLIFT_BENCH_CHECKOUTS = checkouts;
    const cloned: string[] = [];
    const row = setupProject(
      base,
      () => 'f'.repeat(40),
      (repo, branch, dir) => {
        cloned.push(`${repo}#${branch} -> ${dir}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'decomp.yaml'), 'name: fake\n');
      },
    );
    expect(cloned).toEqual([`macabeus/fakeproj#asmlift-benchmark -> ${join(checkouts, 'fakeproj')}`]);
    expect(row.action).toBe('cloned');
    expect(row.dir).toBe(join(checkouts, 'fakeproj'));
  });

  test('an existing bench-owned checkout with no recipe is kept as-is (no clone, no writes)', () => {
    const checkouts = scratch();
    process.env.ASMLIFT_BENCH_CHECKOUTS = checkouts;
    const owned = join(checkouts, 'fakeproj');
    mkdirSync(owned);
    writeFileSync(join(owned, 'a-file.txt'), 'kept\n');
    const before = readdirSync(owned, { recursive: true }).map(String).sort().join('\n');
    const row = setupProject(
      base,
      () => 'f'.repeat(40),
      () => {
        throw new Error('clone must not run');
      },
    );
    expect(row.action).toBe('kept');
    expect(readdirSync(owned, { recursive: true }).map(String).sort().join('\n')).toBe(before);
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

  // Transient lock files (.git/objects/maintenance.lock, index.lock) come and go under git's
  // OWN background maintenance, racing the before/after comparison — they are not evidence of
  // a write by the code under test.
  const snapshot = (dir: string): string =>
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => !f.endsWith('.lock'))
      .sort()
      .join('\n');

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

  // The harness's `git` is an ARGV array through execFileSync, never a command string through a
  // shell: an `ASMLIFT_PROJ_*` path is a value, not source. Written from the failure the string
  // spelling had — `JSON.stringify(dir)` quotes a path but a shell still EXPANDS inside double
  // quotes, so a checkout under a directory containing `$(...)` was handed to git as a different
  // path and every status read threw.
  test('a checkout path is a value, not shell source', () => {
    const dir = join(scratch(), 'proj $(echo pwned) dir');
    mkdirSync(dir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execFileSync('git', ['-C', dir, 'init', '-q'], { env });
    writeFileSync(join(dir, 'f'), 'x\n');
    execFileSync('git', ['-C', dir, 'add', 'f'], { env });
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'base'], { env });
    process.env.ASMLIFT_PROJ_FAKEPROJ = dir;
    const st = checkoutStatus(base, () => null);
    expect(st.present).toBe(true);
    expect(st.head).toMatch(/^[0-9a-f]{40}$/);
    expect(st.dirty).toBe(false);
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
