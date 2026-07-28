// `bench setup` — materialize the real tier's external dependencies on a fresh machine, and
// REPORT (never touch) what the harness does not own:
//   - project checkouts: each manifest names its fork (`repo`) + pinned branch (`branch`).
//     Setup owns a BENCH-OWNED workspace (apps/benchmark/checkouts/, gitignored): each fork is
//     cloned there (submodules included — ssh submodule URLs are rewritten to https), baseroms
//     are copied in from the sibling user checkout when found, and the project's preparation
//     recipe runs (toolchains, venvs, generated sources — src/cases/project-setup.ts).
//     `--build` additionally runs each project's full VERIFIED build (+ its `elfMake` target).
//     Resolution everywhere follows manifests.resolveProjectRoot: ASMLIFT_PROJ_* env override
//     > bench-owned checkout > sibling WORKSPACE dir. NON-bench-owned checkouts (env override
//     or sibling) are strictly read-only — the maintainer's checkouts carry WIP and must never
//     be mutated by a harness command (a missing env-override path is still cloned, as before,
//     but no recipe runs there).
//   - the gcc 2.7.2 toolchain: fetched from the decompals releases into a BENCH-OWNED
//     gitignored dir (@asmlift/toolchains prefers it over the marioparty3 checkout's copy),
//     skipped when already present.
// Ends with a per-project status table; nonzero exit when any clone/prepare/build failed or a
// fresh clone failed verification.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { WORKSPACE } from '../config';
import { type RemoteLookup, checkoutStatus, git, provenanceCommit, remoteBranchHead } from './checkout';
import {
  type RealManifest,
  benchCheckoutsDir,
  loadManifestsForVendor,
  projectEnvOverride,
  resolveProjectRoot,
} from './manifests';
import { PROJECT_RECIPES } from './project-setup';

export interface SetupRow {
  project: string;
  dir: string;
  action: 'cloned' | 'kept' | 'clone FAILED';
  head?: string;
  remoteHead?: string | null;
  dirty?: boolean;
  notes: string[];
}

const short = (sha?: string | null): string => (sha ? sha.slice(0, 7) : sha === null ? 'offline' : '-');

/** Injectable clone (tests stub this — no network in CI). */
export type CloneFn = (repo: string, branch: string, dir: string) => void;

/** Shallow clone of the pinned branch + submodules. `-c url…insteadOf` lands in the clone's
 *  config so ssh-URL submodules (sbk2, kleod) resolve over https on machines without git ssh. */
export const cloneProject: CloneFn = (repo, branch, dir) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // --depth 50 keeps the clone light while still containing the provenance base
  // (the pinned branch is base + ONE integration commit)
  execSync(
    `git clone -c url.https://github.com/.insteadOf=git@github.com: --branch ${branch} --depth 50 ` +
      `https://github.com/${repo}.git ${JSON.stringify(dir)}`,
    { stdio: 'inherit', env },
  );
  execSync(`git -C ${JSON.stringify(dir)} submodule update --init --recursive`, { stdio: 'inherit', env });
};

/** One project. Bench-owned mode (no env override): the clone target is the bench-owned
 *  workspace, and baserom copy-in + the preparation recipe run there. With an env override the
 *  legacy behavior holds: clone only when the path is missing, otherwise strictly read-only. */
export function setupProject(
  man: RealManifest,
  lookupRemote: RemoteLookup = remoteBranchHead,
  clone: CloneFn = cloneProject,
): SetupRow {
  const envOverride = projectEnvOverride(man);
  const benchOwned = envOverride === undefined;
  const dir = envOverride ?? join(benchCheckoutsDir(), man.repoDir);
  const notes: string[] = [];
  let action: SetupRow['action'] = 'kept';

  if (!existsSync(dir)) {
    action = 'cloned';
    try {
      mkdirSync(dirname(dir), { recursive: true });
      clone(man.repo, man.branch, dir);
    } catch {
      return {
        project: man.project,
        dir,
        action: 'clone FAILED',
        notes: [`git clone ${man.repo}#${man.branch} failed`],
      };
    }
    // post-clone verification: the tree must look like the project (decomp.yaml is part of the
    // integration commit on every benchmark branch) and contain the vendored provenance base
    if (!existsSync(`${dir}/decomp.yaml`)) {
      notes.push('VERIFY: decomp.yaml missing from the cloned tree');
    }
    const prov = provenanceCommit(man.project);
    if (prov) {
      try {
        git(dir, `cat-file -e ${prov}^{commit}`);
      } catch {
        notes.push(`VERIFY: provenance base ${prov.slice(0, 7)} not within --depth 50`);
      }
    }
  }

  if (benchOwned && existsSync(dir)) {
    copyBaseroms(man, dir, notes);
    const recipe = PROJECT_RECIPES[man.project];
    if (recipe?.prepare) {
      try {
        console.log(`\n[${man.project}] preparing bench-owned checkout at ${dir}`);
        recipe.prepare(dir);
      } catch (e) {
        notes.push(`PREPARE FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }

  const st = checkoutStatus(man, lookupRemote);
  if (st.present && !st.head) {
    notes.push('not a git checkout');
  }
  if (action === 'kept' && st.head && st.remoteHead && st.head !== st.remoteHead) {
    notes.push(
      `HEAD != ${man.repo}#${man.branch} (git fetch && git checkout ${man.branch}, or move it aside and re-run setup)`,
    );
  }
  if (action === 'cloned' && st.head && st.remoteHead && st.head !== st.remoteHead) {
    notes.push('VERIFY: fresh clone HEAD != remote branch head');
  }
  return { project: man.project, dir, action, head: st.head, remoteHead: st.remoteHead, dirty: st.dirty, notes };
}

/** Copy the project's baserom(s) into the bench-owned checkout from the sibling user checkout
 *  (READ-ONLY source). Missing on both sides is a note, not an error — the project's own build
 *  gate fails loudly later, naming the file. */
function copyBaseroms(man: RealManifest, dir: string, notes: string[]): void {
  const recipe = PROJECT_RECIPES[man.project];
  for (const rel of recipe?.baseroms ?? []) {
    const dest = join(dir, rel);
    if (existsSync(dest)) {
      continue;
    }
    const src = join(WORKSPACE, man.repoDir, rel);
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      console.log(`[${man.project}] copied baserom ${rel} from ${src}`);
    } else {
      notes.push(`baserom ${rel} missing (copy it into ${dest})`);
    }
  }
}

function printTable(rows: SetupRow[]): void {
  const cols = ['project', 'action', 'HEAD', 'remote', 'pinned', 'dirty', 'notes'];
  const data = rows.map((r) => [
    r.project,
    r.action,
    short(r.head),
    short(r.remoteHead),
    r.head && r.remoteHead ? (r.head === r.remoteHead ? 'yes' : 'NO') : '?',
    r.dirty === undefined ? '-' : r.dirty ? 'yes' : 'no',
    r.notes.join('; ') || '-',
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n${line(cols)}`);
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const d of data) {
    console.log(line(d));
  }
}

// The decompals releases marioparty3's own tools/Makefile fetches (and CI's .deps/gcc272
// mirrors): the gcc driver + cc1 come from mips-gcc-2.7.2, the assembler/linker from
// mips-binutils-2.6 — the old driver needs both in ONE dir.
const GCC272_URLS = [
  'https://github.com/decompals/mips-gcc-2.7.2/releases/latest/download/gcc-2.7.2-linux.tar.gz',
  'https://github.com/decompals/mips-binutils-2.6/releases/latest/download/binutils-2.6-linux.tar.gz',
];
export const BENCH_GCC272_DIR = join(import.meta.dirname, '..', '..', 'toolchains', 'gcc272-linux');

/** Fetch the bench-owned gcc 2.7.2 toolchain unless it is already there. */
export function fetchGcc272(): string {
  if (existsSync(join(BENCH_GCC272_DIR, 'gcc')) && existsSync(join(BENCH_GCC272_DIR, 'as'))) {
    return `gcc2.7.2 toolchain: present at ${BENCH_GCC272_DIR}`;
  }
  mkdirSync(BENCH_GCC272_DIR, { recursive: true });
  for (const url of GCC272_URLS) {
    console.log(`fetching ${url}`);
    execSync(`curl -fsSL ${JSON.stringify(url)} | tar -xz -C ${JSON.stringify(BENCH_GCC272_DIR)}`, {
      stdio: 'inherit',
    });
  }
  if (!existsSync(join(BENCH_GCC272_DIR, 'gcc')) || !existsSync(join(BENCH_GCC272_DIR, 'as'))) {
    throw new Error(`setup: gcc2.7.2 fetch left no gcc/as in ${BENCH_GCC272_DIR}`);
  }
  return `gcc2.7.2 toolchain: fetched into ${BENCH_GCC272_DIR}`;
}

/** `--build`: the project's full verified build + its `elfMake` target. BENCH-OWNED checkouts
 *  only — an env-override checkout is the user's to build. */
function buildProject(man: RealManifest): string[] {
  const problems: string[] = [];
  if (projectEnvOverride(man) !== undefined) {
    console.log(`[${man.project}] env-override checkout — skipping the bench-owned build`);
    return problems;
  }
  const dir = resolveProjectRoot(man);
  const recipe = PROJECT_RECIPES[man.project];
  if (!recipe) {
    problems.push(`${man.project}: no build recipe (src/cases/project-setup.ts)`);
    return problems;
  }
  try {
    console.log(`\n[${man.project}] building at ${dir}`);
    recipe.build(dir);
    if (man.elfMake) {
      console.log(`[${man.project}] gmake ${man.elfMake}`);
      execSync(`gmake ${man.elfMake}`, { cwd: dir, stdio: 'inherit' });
    }
  } catch (e) {
    problems.push(`${man.project}: BUILD FAILED — ${(e as Error).message.split('\n')[0]}`);
  }
  return problems;
}

export async function setup(filterProject?: string, opts: { build?: boolean } = {}): Promise<void> {
  const manifests = loadManifestsForVendor().filter((m) => !filterProject || m.project === filterProject);
  const rows = manifests.map((m) => setupProject(m));
  printTable(rows);
  console.log(`\n${fetchGcc272()}`);
  const problems: string[] = [];
  if (opts.build) {
    for (const m of manifests) {
      const row = rows.find((r) => r.project === m.project);
      if (row?.action === 'clone FAILED' || row?.notes.some((n) => n.startsWith('PREPARE FAILED'))) {
        problems.push(`${m.project}: skipped build (clone/prepare failed)`);
        continue;
      }
      problems.push(...buildProject(m));
    }
  }
  const failed = rows.filter(
    (r) => r.action === 'clone FAILED' || r.notes.some((n) => n.startsWith('VERIFY') || n.startsWith('PREPARE FAILED')),
  );
  if (failed.length > 0 || problems.length > 0) {
    throw new Error(
      `setup: failures:\n  ${[...failed.map((r) => `${r.project}: ${r.notes.join('; ') || r.action}`), ...problems].join('\n  ')}`,
    );
  }
}
