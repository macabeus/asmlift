// ONE version of every shared external dependency, across the whole workspace.
//
// The bug this exists for: `packages/cli` pinned `objdiff-wasm` at 3.7.3 while `apps/web` pinned
// 3.7.0. Both scored the SAME byte-identical object pair and disagreed — 233 in the benchmark,
// 229 in the playground — because the two releases align instruction streams differently. Nothing
// anywhere printed a version, so every score the browser showed was silently incomparable to the
// published one, on every row. A user found it by noticing one number was 4 off.
//
// Neither package was WRONG in isolation; the workspace was wrong. So the invariant is not "pin X
// at Y" (that goes stale on the next bump) and not a hand-written list of consumers (that goes
// stale the day a third package imports the scorer). It is derived twice over:
//   • the package set comes from pnpm-workspace.yaml, expanded here;
//   • the dependency set comes from the manifests — every external dep that MORE THAN ONE
//     workspace package declares is in scope, whatever it is called.
// So a future shared dependency is guarded on the commit that introduces it, with no edit here.
//
// Two independent checks, because they fail at different times:
//   1. DECLARED — the specs in the manifests must be identical. This is what actually diverged,
//      and it fails on the PR that writes the second spelling.
//   2. RESOLVED — each declaring package must resolve the same installed version on disk. Ranges
//      can agree on paper and disagree in node_modules; resolution is what the running code gets.
//
// `workspace:` deps are excluded from the DECLARED check by design: `workspace:^` and
// `workspace:*` name the one local copy in the tree, so they cannot drift into two versions the
// way a registry range can (packages/cli deliberately says `workspace:^` — that is the release
// workflow, not drift). They are still checked on the RESOLVED side, where they must all land on
// that one copy.
//
// Toolchain-free by construction (nothing but fs reads), so it runs in the hosted CI suite
// via `test:offline` — the drift it guards is a packaging fact, not a compiler one. It lives
// beside offline-list.test.ts because that is where the workspace-SCOPE invariants live: checks
// whose subject is the repo's layout rather than any one package's behaviour.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

type Manifest = { dir: string; pkg: Record<string, unknown> };
type Decl = { dir: string; field: string; spec: string };

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** The workspace's package directories, derived from pnpm-workspace.yaml (root included). */
export function workspaceDirs(root: string): string[] {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  // Scanned line by line rather than parsed: @asmlift/core declares nothing, and a `yaml` import
  // from here would be a phantom dependency under pnpm's strict layout. Two things the scan has
  // to get right, because both fail SILENTLY — a package that falls out of `dirs` is a package
  // nothing below compares:
  //   • the block. Only items under `packages:` are directories; other top-level keys take lists
  //     of package NAMES, and feeding one of those to readdirSync is a crash at best and a wrong
  //     scope at worst. A line starting in column 0 ends the block.
  //   • the quoting. pnpm accepts 'x', "x" and bare x for the same entry, so a scan that reads
  //     only one spelling drops a package on the day someone writes another.
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:/.test(line);
      continue;
    }
    const item = /^\s*-\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (inPackages && item) {
      patterns.push(item[1] ?? item[2] ?? item[3]);
    }
  }
  const dirs = ['.'];
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      continue; // an exclusion narrows the set; ignoring one can only widen what is checked
    }
    if (!pattern.endsWith('/*')) {
      if (existsSync(join(root, pattern, 'package.json'))) {
        dirs.push(pattern);
      }
      continue;
    }
    const base = pattern.slice(0, -2);
    for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, base, entry.name, 'package.json'))) {
        dirs.push(`${base}/${entry.name}`);
      }
    }
  }
  return dirs.sort();
}

export function readManifests(root: string, dirs: string[]): Manifest[] {
  return dirs.map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) }));
}

/** Every dependency name declared by two or more workspace packages, with each declaration. */
export function sharedDeps(manifests: Manifest[]): Map<string, Decl[]> {
  const byName = new Map<string, Decl[]>();
  for (const { dir, pkg } of manifests) {
    for (const field of DEP_FIELDS) {
      const deps = pkg[field] as Record<string, string> | undefined;
      for (const [key, spec] of Object.entries(deps ?? {})) {
        // `"objdiff": "npm:objdiff-wasm@3.7.0"` is the same package under another key. Group by
        // what is INSTALLED, not by what it is imported as, or a divergence hides behind a rename.
        const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(spec);
        const [name, version] = alias ? [alias[1], alias[2]] : [key, spec];
        const list = byName.get(name) ?? [];
        list.push({ dir, field, spec: version });
        byName.set(name, list);
      }
    }
  }
  return new Map([...byName].filter(([, decls]) => decls.length > 1).sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * The offenders: shared EXTERNAL deps whose declared specs are not all identical. Pure, so the
 * exact 3.7.3-vs-3.7.0 divergence is reproducible as a fixture rather than only as history.
 */
export function declaredDivergences(shared: Map<string, Decl[]>): string[] {
  const offenders: string[] = [];
  for (const [name, decls] of shared) {
    if (decls.every((d) => d.spec.startsWith('workspace:'))) {
      continue;
    }
    const specs = new Set(decls.map((d) => d.spec));
    if (specs.size > 1) {
      offenders.push(`${name}: ` + decls.map((d) => `${d.dir}[${d.field}] = ${d.spec}`).join('  vs  '));
    }
  }
  return offenders;
}

/** The version actually installed for `name` as seen FROM `dir` — null when nothing is there. */
function resolvedVersion(root: string, dir: string, name: string): string | null {
  // The node_modules walk Node itself does, but by FILE rather than through module resolution.
  // `createRequire(...).resolve(name)` answers a different question — "may this dir IMPORT it" —
  // and a package with a restricted `exports` map answers no: @asmlift/cli maps only `./*`, so
  // both `@asmlift/cli/package.json` and its bare entry throw ERR_PACKAGE_PATH_NOT_EXPORTED. That
  // is the package owning the scorer, and DECLARED exempts it as `workspace:`, so asking the
  // resolver leaves it checked by neither half. Restricted maps are the norm, not an oddity.
  let cur = resolve(root, dir);
  const stop = resolve(root); // the walk ends AT the workspace root; a copy above it is not ours
  for (;;) {
    const manifest = join(cur, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(manifest)) {
      const version: unknown = JSON.parse(readFileSync(manifest, 'utf8')).version;
      return typeof version === 'string' ? version : null;
    }
    const up = dirname(cur);
    if (up === cur || cur === stop) {
      return null;
    }
    cur = up;
  }
}

const DIRS = workspaceDirs(ROOT);
const SHARED = sharedDeps(readManifests(ROOT, DIRS));

// Anti-vacuity. Both checks below are "no offenders found" assertions, which a broken enumeration
// passes by looking at nothing — the exact way a guard dies silently. Pin that the derivation
// still sees a real workspace before trusting either result.
test('the workspace enumeration is not vacuous', () => {
  expect(DIRS).toContain('packages/cli');
  expect(DIRS).toContain('apps/web');
  expect(SHARED.size).toBeGreaterThan(0);
  // Counted a second way, off the filesystem instead of off the manifest, because the failure to
  // fear is a dropped ENTRY rather than an empty list: lose one of two consumers and every check
  // below still passes, on one declaration it has nothing to compare. Every apps/* and packages/*
  // directory holding a package.json is a workspace package here; a deliberate exception would be
  // news worth failing on.
  const onDisk = ['apps', 'packages'].flatMap((base) =>
    readdirSync(join(ROOT, base), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(ROOT, base, e.name, 'package.json')))
      .map((e) => `${base}/${e.name}`),
  );
  expect(DIRS).toEqual(['.', ...onDisk].sort());
});

test('every dependency shared by two workspace packages is declared at ONE version', () => {
  const offenders = declaredDivergences(SHARED);
  expect(
    offenders,
    'Two workspace packages declare DIFFERENT versions of the same dependency. This is how the ' +
      'playground scored 229 where the benchmark published 233: packages/cli had objdiff-wasm ' +
      '3.7.3 and apps/web had 3.7.0, and nothing said so. Pin both to the same version:\n' +
      offenders.join('\n'),
  ).toEqual([]);
});

/**
 * The offenders on the RESOLVED side: shared deps that two declaring packages actually load at
 * different versions. Takes the root so it can be pointed at a fixture tree, not only at this one.
 */
export function resolvedDivergences(
  root: string,
  shared: Map<string, Decl[]>,
): { offenders: string[]; observed: number; unobservable: string[] } {
  const offenders: string[] = [];
  const unobservable: string[] = [];
  let observed = 0;
  for (const [name, decls] of shared) {
    const seen = new Map<string, string[]>(); // version -> dirs that resolve it
    for (const { dir } of decls) {
      const version = resolvedVersion(root, dir, name);
      if (version === null) {
        // Reported, never shrugged off. A skip is indistinguishable from a pass in an
        // "offenders is empty" assertion, and a global "something resolved" floor is satisfied
        // by the deps that still work while the one that matters goes unchecked.
        unobservable.push(`${name} @ ${dir}`);
        continue;
      }
      observed++;
      seen.set(version, [...(seen.get(version) ?? []), dir]);
    }
    if (seen.size > 1) {
      offenders.push(`${name}: ` + [...seen].map(([v, dirs]) => `${v} from ${dirs.join(', ')}`).join('  vs  '));
    }
  }
  return { offenders, observed, unobservable };
}

test('every workspace package RESOLVES a shared dependency to the same installed version', () => {
  const { offenders, unobservable } = resolvedDivergences(ROOT, SHARED);
  expect(
    unobservable,
    'A declared dependency is not installed where its package declares it, so nothing compared ' +
      'it — run `pnpm install`, or fix the reading if the package is on disk:\n' +
      unobservable.join('\n'),
  ).toEqual([]);
  expect(
    offenders,
    `One dependency, two installed copies — the declared specs agree but node_modules does not:\n${offenders.join('\n')}`,
  ).toEqual([]);
});

// The guard's own guard: the detector, run against the divergence that actually shipped. Without
// this the check above is a hypothesis — it has only ever been watched to pass.
test('the detector catches the objdiff-wasm divergence that shipped', () => {
  const bug: Manifest[] = [
    { dir: 'packages/cli', pkg: { dependencies: { 'objdiff-wasm': '3.7.3', '@asmlift/core': 'workspace:^' } } },
    { dir: 'apps/web', pkg: { dependencies: { 'objdiff-wasm': '3.7.0', '@asmlift/core': 'workspace:*' } } },
  ];
  const offenders = declaredDivergences(sharedDeps(bug));
  expect(offenders).toEqual(['objdiff-wasm: packages/cli[dependencies] = 3.7.3  vs  apps/web[dependencies] = 3.7.0']);

  // ...and stays quiet on the fixed shape, so it is a detector and not a tripwire that always fires.
  const fixed: Manifest[] = [
    { dir: 'packages/cli', pkg: { dependencies: { 'objdiff-wasm': '9.9.9', '@asmlift/core': 'workspace:^' } } },
    { dir: 'apps/web', pkg: { dependencies: { 'objdiff-wasm': '9.9.9', '@asmlift/core': 'workspace:*' } } },
  ];
  expect(declaredDivergences(sharedDeps(fixed))).toEqual([]);
});

// `workspace:^` vs `workspace:*` on @asmlift/core is the release workflow, not drift — one local
// copy either way. Pin the exemption so a future "tighten this" cannot quietly delete it, and pin
// that it is scoped to the protocol rather than to a package name.
test('workspace: protocol spellings are exempt, but only when EVERY declaration uses it', () => {
  const workspaceOnly: Manifest[] = [
    { dir: 'packages/cli', pkg: { dependencies: { '@asmlift/core': 'workspace:^' } } },
    { dir: 'apps/web', pkg: { dependencies: { '@asmlift/core': 'workspace:*' } } },
  ];
  expect(declaredDivergences(sharedDeps(workspaceOnly))).toEqual([]);

  const halfPublished: Manifest[] = [
    { dir: 'packages/cli', pkg: { dependencies: { '@asmlift/core': 'workspace:^' } } },
    { dir: 'apps/web', pkg: { dependencies: { '@asmlift/core': '^0.4.0' } } },
  ];
  expect(declaredDivergences(sharedDeps(halfPublished))).toEqual([
    '@asmlift/core: packages/cli[dependencies] = workspace:^  vs  apps/web[dependencies] = ^0.4.0',
  ]);
});

// The RESOLVED check's own guard, on a shape the DECLARED check cannot see: both packages ask for
// the same range and node_modules hands them different builds. Built as a throwaway tree so the
// failure is demonstrated, not asserted — a check nobody has watched fail is a hypothesis.
test('the RESOLVED check catches one range, two installed copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'one-version-'));
  const put = (rel: string, body: unknown) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(body));
  };
  put('package.json', { name: 'fixture-root', private: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  for (const [pkg, installed] of [
    ['alpha', '1.0.0'],
    ['beta', '1.2.3'],
  ]) {
    // IDENTICAL declared specs — the declared check is clean here by construction.
    put(`packages/${pkg}/package.json`, { name: pkg, dependencies: { 'fx-dep': '^1.0.0' } });
    put(`packages/${pkg}/node_modules/fx-dep/package.json`, { name: 'fx-dep', version: installed });
  }

  const dirs = workspaceDirs(root);
  expect(dirs).toEqual(['.', 'packages/alpha', 'packages/beta']);
  const shared = sharedDeps(readManifests(root, dirs));
  expect(declaredDivergences(shared)).toEqual([]); // declared specs agree...

  const { offenders, observed, unobservable } = resolvedDivergences(root, shared);
  expect(unobservable).toEqual([]);
  expect(observed).toBe(2);
  expect(offenders).toEqual(['fx-dep: 1.0.0 from packages/alpha  vs  1.2.3 from packages/beta']); // ...disk does not

  rmSync(root, { recursive: true, force: true });
});

// The enumeration's own guard, on the shapes that silently SHRINK it: a quoting the scan does not
// read, and a list under another key that is not directories at all.
test('the workspace scan reads every quoting, and only the packages: block', () => {
  const root = mkdtempSync(join(tmpdir(), 'one-version-yaml-'));
  const put = (rel: string, body: unknown) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(body));
  };
  put('package.json', { name: 'fixture-root', private: true });
  for (const dir of ['apps/quoted', 'apps/bare', 'packages/globbed', 'tools/excluded']) {
    put(`${dir}/package.json`, { name: dir });
  }
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    [
      'packages:',
      "  - 'packages/*'", // single-quoted, the spelling this repo uses
      '  - "apps/quoted"', // double-quoted
      '  - apps/bare', // bare scalar
      '  - "!tools/excluded"', // an exclusion: ignored, and it is not a directory to read
      'onlyBuiltDependencies:',
      "  - 'react'", // a package NAME under another key — never a directory
      '',
    ].join('\n'),
  );

  expect(workspaceDirs(root)).toEqual(['.', 'apps/bare', 'apps/quoted', 'packages/globbed']);
  rmSync(root, { recursive: true, force: true });
});

// Two versions of one package, declared under two different KEYS. The specs are not even
// comparable as strings — grouping by the installed name is what makes them meet.
test('the detector sees through an npm: alias', () => {
  const aliased: Manifest[] = [
    { dir: 'packages/cli', pkg: { dependencies: { 'objdiff-wasm': '3.8.1' } } },
    { dir: 'apps/web', pkg: { dependencies: { objdiff: 'npm:objdiff-wasm@3.7.0' } } },
  ];
  expect(declaredDivergences(sharedDeps(aliased))).toEqual([
    'objdiff-wasm: packages/cli[dependencies] = 3.8.1  vs  apps/web[dependencies] = 3.7.0',
  ]);
});

// A dependency whose `exports` map refuses `./package.json` and its own bare entry is still
// OBSERVED, because the version is read off disk rather than asked of the resolver. @asmlift/cli
// has exactly this shape, and it is the package that owns the scorer.
test('a restricted exports map does not make a dependency unobservable', () => {
  const root = mkdtempSync(join(tmpdir(), 'one-version-exports-'));
  const put = (rel: string, body: unknown) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(body));
  };
  put('package.json', { name: 'fixture-root', private: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  for (const pkg of ['alpha', 'beta']) {
    put(`packages/${pkg}/package.json`, { name: pkg, dependencies: { 'fx-exports': '^1.0.0' } });
    put(`packages/${pkg}/node_modules/fx-exports/package.json`, {
      name: 'fx-exports',
      version: '1.0.0',
      exports: { './*': './src/*.ts' },
    });
  }

  const shared = sharedDeps(readManifests(root, workspaceDirs(root)));
  const { offenders, observed, unobservable } = resolvedDivergences(root, shared);
  expect(unobservable).toEqual([]);
  expect(observed).toBe(2);
  expect(offenders).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});
