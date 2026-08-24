// Bundle the CLI, and BAKE INTO IT the tree it was built from.
//
// `dist/asmlift.mjs` is the fast loader docs/ranked-repro.md runs (tsx re-reads and re-transforms
// every source each run; the bundle does neither). It also freezes its copy of `packages/` at this
// moment, so the checkout it later runs inside is not evidence about what it contains — hence the
// bake. src/provenance.ts is the reader: it compares this sample against the checkout and calls a
// disagreement STALE.
//
// The reading is src/provenance.ts's OWN sampler, bundled to a throwaway module and called here,
// because the two samples are compared for EXACT equality. Restating the reading in this file
// would put a second copy of it one edit away from disagreeing with the first — and a disagreement
// here does not fail, it reports every run as stale forever.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');

const probe = resolve(pkg, 'dist/.provenance-probe.mjs');
await build({
  entryPoints: [resolve(pkg, 'src/provenance.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: probe,
});
/** The asmlift checkout this script lives in, or the unmeasurable sample when it is not in one —
 *  a bundle built outside a checkout stamps `unversioned`, never a commit it cannot vouch for. */
const { sampleSourceTree } = await import(pathToFileURL(probe).href);
const built = sampleSourceTree(resolve(pkg, 'src'));
rmSync(probe, { force: true });

console.log(
  `asmlift: bundling ${built.commit === null ? 'an unversioned tree' : built.commit.slice(0, 7)}` +
    `${built.dirty ? '+dirty' : ''} into dist/asmlift.mjs`,
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
