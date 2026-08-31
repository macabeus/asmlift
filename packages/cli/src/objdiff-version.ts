// The pinned scorer's own version, read off the package that is actually installed.
//
// Kept apart from objdiff.ts so that asking WHICH engine is here costs nothing: that module
// initialises the wasm engine in a top-level await, and a cache key has no business loading it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

let memo: string | undefined;

/**
 * The installed `objdiff-wasm` version. Throws rather than degrading to a placeholder: the callers
 * are cache keys, and a key that silently loses the engine's identity serves one version's scores
 * to another — the shape of the bug where 3.7.3 and 3.7.0 disagreed by 4 on one byte-identical pair.
 */
export function objdiffVersion(): string {
  if (memo === undefined) {
    const req = createRequire(import.meta.url);
    const version: unknown = JSON.parse(readFileSync(req.resolve('objdiff-wasm/package.json'), 'utf8')).version;
    if (typeof version !== 'string') {
      throw new Error('objdiff-wasm resolves to a package.json with no version');
    }
    memo = version;
  }
  return memo;
}
