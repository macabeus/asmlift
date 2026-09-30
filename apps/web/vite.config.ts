import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';

// objdiff-wasm's real directory, for `server.fs.allow`: with match-kit linked from a local checkout,
// it lies outside this workspace.
const scoring = realpathSync(join(import.meta.dirname, 'node_modules/@match-kit/scoring'));
const objdiffWasm = dirname(createRequire(join(scoring, 'package.json')).resolve('objdiff-wasm'));

export default defineConfig({
  // GitHub Pages project-site subpath (e.g. VITE_BASE_URL=/asmlift/); "/" for local dev.
  base: process.env.VITE_BASE_URL ?? '/',
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // @asmlift/core is a workspace symlink of plain .ts sources — serve/transform it directly
    // instead of prebundling (esbuild handles the TS in both dev and build).
    // objdiff-wasm (reached through @match-kit/scoring) + agbcc are WASM packages: objdiff-wasm uses
    // a module-level top-level `await` ($init) and both fetch their .wasm via `import.meta.url`.
    // esbuild's dep pre-bundler targets old browsers (chrome87…) that reject TLA and can mangle the
    // import.meta.url asset URLs, so exclude them and let Vite serve them as native ESM
    // (workers/modern browsers do TLA natively).
    exclude: ['@asmlift/core', '@match-kit/scoring', 'objdiff-wasm', 'agbcc'],
  },
  // The ranking worker is a module worker (dynamic-imports the wasm), so its chunk must be ESM.
  worker: { format: 'es' },
  // The production bundle must allow top-level await (objdiff-wasm) — ES2022 is the TLA baseline
  // and is satisfied by every browser that can run WebAssembly components anyway.
  build: { target: 'es2022' },
  // Dev server reads the symlinked core sources + the corpus examples outside the app root, and
  // objdiff-wasm from wherever it resolves.
  server: { fs: { allow: ['../..', objdiffWasm] } },
});
