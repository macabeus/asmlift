// Bundle the CLI, and BAKE INTO IT the tree it was built from.
//
// `dist/asmlift.mjs` is the fast loader docs/ranked-repro.md runs (tsx re-reads and re-transforms
// every source each run; the bundle does neither). It also freezes its copy of `packages/` at this
// moment, so the checkout it later runs inside is not evidence about what it contains — hence the
// bake. src/provenance.ts is the reader: it compares this sample against the checkout and calls a
// disagreement STALE.
//
// The reading is the SAME git commands src/provenance.ts takes, against the same repo root, because
// the two are compared for exact equality.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');

/** The asmlift checkout this script lives in, or the unmeasurable sample when it is not in one —
 *  a bundle built outside a checkout stamps `unversioned`, never a commit it cannot vouch for. */
function sampleBuildTree() {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  try {
    const root = git(here, 'rev-parse', '--show-toplevel').trim();
    if (resolve(root, 'packages', 'cli', 'scripts') !== here) {
      return { commit: null, tree: null, status: null };
    }
    return {
      commit: git(root, 'rev-parse', 'HEAD').trim(),
      tree: git(root, 'rev-parse', 'HEAD:packages').trim(),
      status: git(root, 'status', '--porcelain', '--', 'packages'),
    };
  } catch {
    return { commit: null, tree: null, status: null };
  }
}

const built = sampleBuildTree();
console.log(
  `asmlift: bundling ${built.commit === null ? 'an unversioned tree' : built.commit.slice(0, 7)}` +
    `${built.status ? '+dirty' : ''} into dist/asmlift.mjs`,
);

await build({
  entryPoints: [resolve(pkg, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Loaded from node_modules at run time: objdiff-wasm fetches a sibling .wasm by file:// URL, and
  // yaml is a plain runtime dependency.
  external: ['objdiff-wasm', 'yaml'],
  banner: { js: '#!/usr/bin/env node' },
  // No --keep-names. tsx's transform sets it (`keepNames:!0` in its esbuild options) and wraps every
  // arrow function in the shim; this bundle has never carried it, and the two loaders otherwise run
  // the same sources.
  define: { __ASMLIFT_BUILD__: JSON.stringify(built) },
  outfile: resolve(pkg, 'dist/asmlift.mjs'),
});
