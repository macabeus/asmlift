// `bench setup` — materialize the real tier's external dependencies on a fresh machine, and
// REPORT (never touch) what already exists:
//   - project checkouts: each manifest names its fork (`repo`) + pinned branch (`branch`);
//     a missing checkout is shallow-cloned at that branch, an EXISTING checkout is only
//     reported against the remote head — the maintainer's checkouts carry WIP and must never
//     be mutated by a harness command.
// Ends with a per-project status table; nonzero exit when any clone failed or a fresh clone
// failed verification.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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

export async function setup(filterProject?: string): Promise<void> {
  const manifests = loadManifestsForVendor().filter((m) => !filterProject || m.project === filterProject);
  const rows = manifests.map((m) => setupProject(m));
  printTable(rows);
  const failed = rows.filter((r) => r.action === 'clone FAILED' || r.notes.some((n) => n.startsWith('VERIFY')));
  if (failed.length > 0) {
    throw new Error(
      `setup: ${failed.length} project(s) failed to clone/verify: ${failed.map((r) => r.project).join(', ')}`,
    );
  }
}
