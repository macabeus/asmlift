// ALL environment/path resolution for the harness. Defaults resolve from the MODULE dir (not
// process.cwd()) so runs work from any launch directory, following the same sibling-checkout
// convention as @asmlift/toolchains: the workspace dir holding asmlift also holds m2c,
// and the real-tier decomp projects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..'); // .../asmlift
export const WORKSPACE = join(REPO_ROOT, '..'); // siblings (in a git WORKTREE this is not the real workspace — use env overrides)

/** The pinned m2c checkout the benchmark shells out to. */
export const M2C_DIR = env('ASMLIFT_M2C_DIR', join(WORKSPACE, 'm2c'));
/** The ONE m2c pin (apps/benchmark/M2C_COMMIT — plain text so bash and the workflow read the
 *  same file). Enforced against the live checkout before every run; published as provenance
 *  in meta.m2c; embedded in the repro scripts. */
export const M2C_PINNED_COMMIT = readFileSync(join(import.meta.dirname, '..', 'M2C_COMMIT'), 'utf8').trim();

/** GNU cpp for real-project preprocessing (Apple's /usr/bin/cpp ignores -o). */
export const CPP = env('ASMLIFT_CPP', 'cpp');

export const RESULTS_DIR = join(import.meta.dirname, '..', 'results');
export const CACHE_DIR = join(import.meta.dirname, '..', '.cache');
