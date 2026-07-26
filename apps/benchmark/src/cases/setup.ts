// `bench setup` — materialize the real tier's external dependencies on a fresh machine, and
// REPORT (never touch) what already exists:
//   - project checkouts: each manifest names its fork (`repo`) + pinned branch (`branch`);
//     a missing checkout is shallow-cloned at that branch, an EXISTING checkout is only
//     reported against the remote head — the maintainer's checkouts carry WIP and must never
//     be mutated by a harness command.
//   - the gcc 2.7.2 toolchain: fetched from the decompals releases into a BENCH-OWNED
//     gitignored dir (@asmlift/toolchains prefers it over the marioparty3 checkout's copy),
//     skipped when already present.
// Ends with a per-project status table; nonzero exit when any clone failed or a fresh clone
// failed verification.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { type RemoteLookup, checkoutStatus, git, provenanceCommit, remoteBranchHead } from './checkout';
import { type RealManifest, loadManifestsForVendor, resolveProjectRoot } from './manifests';

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

/** One project: clone when the checkout dir is MISSING; otherwise strictly read-only. */
export function setupProject(man: RealManifest, lookupRemote: RemoteLookup = remoteBranchHead): SetupRow {
  const dir = resolveProjectRoot(man);
  const notes: string[] = [];
  let action: SetupRow['action'] = 'kept';

  if (!existsSync(dir)) {
    action = 'cloned';
    try {
      // --depth 50 keeps the clone light while still containing the provenance base
      // (the pinned branch is base + ONE integration commit)
      execSync(
        `git clone --branch ${man.branch} --depth 50 https://github.com/${man.repo}.git ${JSON.stringify(dir)}`,
        { stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      );
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

export async function setup(filterProject?: string): Promise<void> {
  const manifests = loadManifestsForVendor().filter((m) => !filterProject || m.project === filterProject);
  const rows = manifests.map((m) => setupProject(m));
  printTable(rows);
  console.log(`\n${fetchGcc272()}`);
  const failed = rows.filter((r) => r.action === 'clone FAILED' || r.notes.some((n) => n.startsWith('VERIFY')));
  if (failed.length > 0) {
    throw new Error(
      `setup: ${failed.length} project(s) failed to clone/verify: ${failed.map((r) => r.project).join(', ')}`,
    );
  }
}
