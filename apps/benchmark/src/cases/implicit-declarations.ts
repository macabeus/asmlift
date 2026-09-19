// A vendored translation unit must declare every function it calls. A call with no declaration in
// scope compiles as a C89 implicit declaration: an `int` return and promoted arguments, which changes
// the code the compiler emits whenever the real callee returns a narrower type or takes a float.
// The project's own unit declares its callees (in a header, or earlier in the same file), so a
// vendored TU that does not is not the unit the game was built from.
import { spawnSync } from 'node:child_process';

import { CC } from '../config';

/** The compiler and the deadline, injectable so the BOUND itself is testable — a timeout nothing
 *  exercises is a timeout nobody knows is wired. Both default to the module's values, which is what
 *  every caller uses. */
interface Probe {
  cc?: string;
  timeoutMs?: number;
}

/** How long the host compiler gets to answer. Generous against the largest unit the corpus
 *  vendors (pokeemerald's 410 KB), and finite, which is the entire point. */
const PROBE_TIMEOUT_MS = 120_000;

/** The functions `tu` (a preprocessed translation unit) calls without declaring, sorted, each once.
 *  Read off the host C compiler's `-Wimplicit-function-declaration`, which gcc and clang both tag. */
export function undeclaredCallees(tu: string, probe: Probe = {}): string[] {
  const cc = probe.cc ?? CC;
  const timeout = probe.timeoutMs ?? PROBE_TIMEOUT_MS;
  const r = spawnSync(
    cc,
    ['-fsyntax-only', '-std=gnu89', '-Wno-everything', '-Wimplicit-function-declaration', '-x', 'c', '-'],
    {
      input: tu,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 64 * 1024 * 1024,
      // BOUNDED, because an unbounded syntax probe does not fail — it HANGS, and a hung probe
      // inside a test worker is indistinguishable from a slow suite. Measured: a `clang
      // -fsyntax-only` left running with its `-cc1` child wedged a whole vitest run for two and a
      // half hours, and reaping the child by hand finished the run in seconds. The suite reported
      // nothing at all in the meantime, so the gate it was meant to be simply did not run.
      //
      // SIGKILL rather than the default SIGTERM: the process this is defending against is one
      // that has already stopped behaving, and a driver that ignores SIGTERM leaves the same
      // orphan behind.
      timeout,
      killSignal: 'SIGKILL',
    },
  );
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    throw new Error(
      timedOut
        ? `${cc} did not answer within ${timeout / 1000}s on a ${tu.length}-byte unit and was killed — ` +
            `the syntax probe is bounded so a wedged compiler fails the run instead of hanging it`
        : `${cc} could not run (set ASMLIFT_CC to a gcc or clang): ${r.error.message}`,
    );
  }
  const names = [...r.stderr.matchAll(/function '([^']+)'.*\[-Wimplicit-function-declaration\]/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}
