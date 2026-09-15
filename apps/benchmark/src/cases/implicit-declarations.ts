// A vendored translation unit must declare every function it calls. A call with no declaration in
// scope compiles as a C89 implicit declaration: an `int` return and promoted arguments, which changes
// the code the compiler emits whenever the real callee returns a narrower type or takes a float.
// The project's own unit declares its callees (in a header, or earlier in the same file), so a
// vendored TU that does not is not the unit the game was built from.
import { spawnSync } from 'node:child_process';

import { CC } from '../config';

/** The functions `tu` (a preprocessed translation unit) calls without declaring, sorted, each once.
 *  Read off the host C compiler's `-Wimplicit-function-declaration`, which gcc and clang both tag. */
export function undeclaredCallees(tu: string): string[] {
  const r = spawnSync(
    CC,
    ['-fsyntax-only', '-std=gnu89', '-Wno-everything', '-Wimplicit-function-declaration', '-x', 'c', '-'],
    { input: tu, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error) {
    throw new Error(`${CC} could not run (set ASMLIFT_CC to a gcc or clang): ${r.error.message}`);
  }
  const names = [...r.stderr.matchAll(/function '([^']+)'.*\[-Wimplicit-function-declaration\]/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}
