// Checkout pinning for the real tier. Every real-project manifest names its GitHub fork
// (`repo`) and pinned integration branch (`branch` — provenance base + one integration
// commit); the vendored dataset is only reproducible when the local checkout sits on that
// branch's remote head. This module answers "where does the checkout stand?" (checkoutStatus)
// and enforces the pin for `bench vendor`/`bench fidelity` (enforceCheckoutPin).
//
// Enforcement policy:
//   - HEAD == remote branch head, clean tree  → ok
//   - HEAD == remote branch head, DIRTY tree  → warning (never an error: the maintainer's
//     machine runs with WIP checkouts, and the current vendored data was produced that way)
//   - HEAD != remote head / remote unreachable AND HEAD not a provenance descendant
//     → loud error naming the remedy — unless ASMLIFT_ALLOW_DIRTY_CHECKOUT=1 downgrades it
//     to a warning (the same WIP-machine escape hatch; CI and fresh setups stay strict)
//   - offline (remote unreachable) fallback: accept a HEAD that DESCENDS from the vendored
//     PROVENANCE commit, warning that remote verification was skipped.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REAL_DIR, type RealManifest, resolveProjectRoot } from './manifests';

/** Injectable remote-head lookup (tests stub this — no network in CI). */
export type RemoteLookup = (repo: string, branch: string) => string | null;

export interface CheckoutStatus {
  project: string;
  dir: string;
  present: boolean;
  /** absent when the dir exists but is not a git checkout */
  head?: string;
  dirty?: boolean;
  /** null ⇒ remote unreachable (offline) */
  remoteHead?: string | null;
  /** offline-fallback evidence: HEAD descends from the vendored PROVENANCE commit */
  descendsFromProvenance?: boolean;
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export function git(dir: string, args: string): string {
  return execSync(`git -C ${JSON.stringify(dir)} ${args}`, { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** The fork's branch head via `git ls-remote`, or null when the remote is unreachable. */
export function remoteBranchHead(repo: string, branch: string): string | null {
  try {
    const out = execSync(`git ls-remote https://github.com/${repo}.git refs/heads/${branch}`, {
      encoding: 'utf8',
      env: GIT_ENV,
      timeout: 30_000,
    });
    const sha = out.split('\t')[0]?.trim();
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The commit the vendored dataset was produced at (dataset/real/tu/<p>/PROVENANCE.json). */
export function provenanceCommit(project: string): string | null {
  const p = join(REAL_DIR, 'tu', project, 'PROVENANCE.json');
  if (!existsSync(p)) {
    return null;
  }
  try {
    return (JSON.parse(readFileSync(p, 'utf8')) as { commit?: string }).commit ?? null;
  } catch {
    return null;
  }
}

/** Read-only: where the project checkout stands relative to its pinned branch. NEVER mutates
 *  the checkout (no fetch — the remote head comes from ls-remote against the fork). */
export function checkoutStatus(man: RealManifest, lookupRemote: RemoteLookup = remoteBranchHead): CheckoutStatus {
  const dir = resolveProjectRoot(man);
  if (!existsSync(dir)) {
    return { project: man.project, dir, present: false };
  }
  if (!existsSync(join(dir, '.git'))) {
    return { project: man.project, dir, present: true }; // present but not a git checkout
  }
  const head = git(dir, 'rev-parse HEAD');
  const dirty = git(dir, 'status --porcelain') !== '';
  const remoteHead = lookupRemote(man.repo, man.branch);
  const st: CheckoutStatus = { project: man.project, dir, present: true, head, dirty, remoteHead };
  if (remoteHead === null) {
    const prov = provenanceCommit(man.project);
    if (prov) {
      try {
        execSync(`git -C ${JSON.stringify(dir)} merge-base --is-ancestor ${prov} HEAD`, { env: GIT_ENV });
        st.descendsFromProvenance = true;
      } catch {
        st.descendsFromProvenance = false;
      }
    }
  }
  return st;
}

/** The WIP-checkout escape hatch: downgrades pin violations to warnings. */
export function allowDirtyCheckout(): boolean {
  return process.env.ASMLIFT_ALLOW_DIRTY_CHECKOUT === '1';
}

export interface EnforceOptions {
  /** what a MISSING checkout means: 'error' (vendor — it needs the checkout anyway) or
   *  'warn' (fidelity — CI runs it checkout-free by design and must stay green) */
  onMissing?: 'error' | 'warn';
  lookupRemote?: RemoteLookup;
}

/** Enforce the branch pin for one project (see the policy at the top of this file). Returns
 *  the observed status so callers can gate follow-up checks on `present`/`head`. */
export function enforceCheckoutPin(man: RealManifest, command: string, opts: EnforceOptions = {}): CheckoutStatus {
  const st = checkoutStatus(man, opts.lookupRemote ?? remoteBranchHead);
  const remedy = `git -C ${st.dir} fetch && git -C ${st.dir} checkout ${man.branch} (or \`pnpm bench setup\` for a fresh clone)`;
  const violate = (msg: string): void => {
    if (allowDirtyCheckout()) {
      console.warn(`WARN ${command}: ${msg} — allowed by ASMLIFT_ALLOW_DIRTY_CHECKOUT=1`);
    } else {
      throw new Error(
        `${command}: ${msg}\n  remedy: ${remedy}\n  (or set ASMLIFT_ALLOW_DIRTY_CHECKOUT=1 to proceed with a WIP checkout)`,
      );
    }
  };
  if (!st.present) {
    const msg = `${man.project}: checkout missing at ${st.dir} — run \`pnpm bench setup\``;
    if ((opts.onMissing ?? 'error') === 'error') {
      throw new Error(`${command}: ${msg}`);
    }
    console.warn(`WARN ${command}: ${msg}`);
    return st;
  }
  if (!st.head) {
    violate(`${man.project}: ${st.dir} exists but is not a git checkout`);
    return st;
  }
  const remoteHead = st.remoteHead ?? null;
  if (remoteHead === null) {
    if (st.descendsFromProvenance) {
      console.warn(
        `WARN ${command}: ${man.project}: remote unreachable — pin NOT verified against ` +
          `${man.repo}#${man.branch}; HEAD descends from the vendored provenance base (accepted offline)`,
      );
    } else {
      violate(
        `${man.project}: remote ${man.repo} unreachable AND HEAD ${st.head.slice(0, 7)} does not descend ` +
          `from the vendored provenance base`,
      );
      return st;
    }
  } else if (st.head !== remoteHead) {
    violate(
      `${man.project}: checkout HEAD ${st.head.slice(0, 7)} != ${man.repo}#${man.branch} head ${remoteHead.slice(0, 7)}`,
    );
    return st;
  }
  if (st.dirty) {
    console.warn(
      `WARN ${command}: ${man.project}: working tree at ${st.dir} is DIRTY — results may not be ` +
        `reproducible from ${man.repo}#${man.branch}`,
    );
  }
  return st;
}
