import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages project-site subpath (e.g. VITE_BASE_URL=/asmlift/); "/" for local dev.
  base: process.env.VITE_BASE_URL ?? '/',
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // @asmlift/core is a workspace symlink of plain .ts sources — serve/transform it directly
    // instead of prebundling (esbuild handles the TS in both dev and build).
    // objdiff-wasm + agbcc are WASM packages: objdiff-wasm uses a module-level top-level `await`
    // ($init) and both fetch their .wasm via `import.meta.url`. esbuild's dep pre-bundler targets
    // old browsers (chrome87…) that reject TLA and can mangle the import.meta.url asset URLs, so
    // exclude them and let Vite serve them as native ESM (workers/modern browsers do TLA natively).
    exclude: ['@asmlift/core', 'objdiff-wasm', 'agbcc'],
  },
  // The ranking worker is a module worker (dynamic-imports the wasm), so its chunk must be ESM.
  worker: { format: 'es' },
  // The production bundle must allow top-level await (objdiff-wasm) — ES2022 is the TLA baseline
  // and is satisfied by every browser that can run WebAssembly components anyway.
  build: { target: 'es2022' },
  // Dev server reads the symlinked core sources + the corpus examples outside the app root.
  server: { fs: { allow: ['../..'] } },
});
