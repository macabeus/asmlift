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
      // BOUNDED, because an unbounded syntax probe does not fail — it HANGS. `spawnSync` waits on
      // the stdio PIPES, not merely on the child, so a compiler that exits promptly still blocks
      // this call for as long as anything it forked holds stderr open. That is the clang
      // driver/`-cc1` shape: measured, a probe whose child exited instantly while a forked process
      // kept the pipe never returned at all, and the same probe with this deadline returns in
      // 2.0 s. One wedged probe held a whole vitest run for two and a half hours while the suite
      // reported nothing, so the gate it was meant to be did not run.
      //
      // The default SIGTERM, NOT SIGKILL. Measured both ways against real clang: `-cc1` survives
      // either signal (4 runs, 1 orphan each), so SIGKILL buys nothing there — while against a
      // driver that traps SIGTERM to tear its child down, SIGTERM reaped the grandchild and
      // SIGKILL left it running. SIGKILL is strictly worse on the only shape where the signal
      // makes a difference.
      timeout,
    },
  );
  const read = (): string[] => {
    const names = [...r.stderr.matchAll(/function '([^']+)'.*\[-Wimplicit-function-declaration\]/g)].map((m) => m[1]);
    return [...new Set(names)].sort();
  };
  if (r.error) {
    // A DEADLINE IS NOT ALWAYS A MISSING ANSWER. What `spawnSync` waits on is the pipes, so a
    // compiler that answered and exited 0 still trips the timeout if anything it forked is holding
    // stderr — and the diagnostics are already in hand. Read them rather than failing a run over a
    // process that was never the point.
    if ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' && r.status === 0) {
      return read();
    }
    throw new Error(
      (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? `${cc} did not finish within ${timeout / 1000}s on a ${tu.length}-byte unit and was killed — ` +
            `either the compiler is wedged, or something it forked is still holding its output open`
        : `${cc} could not run (set ASMLIFT_CC to a gcc or clang): ${r.error.message}`,
    );
  }
  // A COMPILER THAT REFUSED THE UNIT MATCHES NOTHING, and "nothing" is this gate's PASSING answer.
  // `-fsyntax-only` exits 0 on a unit whose only complaints are warnings, so a non-zero status
  // means the front end rejected it outright — a wrong `ASMLIFT_CC`, a dialect it cannot read, a
  // hard error. Refusing loudly is the difference between a gate and a gate-shaped no-op.
  if (r.status !== 0) {
    throw new Error(
      `${cc} rejected the unit (exit ${r.status}) instead of syntax-checking it, so no implicit ` +
        `declaration could be found — the answer would have been a vacuous pass:\n${r.stderr.trim().slice(0, 2000)}`,
    );
  }
  return read();
}
