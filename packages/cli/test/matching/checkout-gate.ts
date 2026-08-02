// Shared BENCH-OWNED-CHECKOUT gate — docker-gate.ts's sibling for suites bound to a real
// project checkout (apps/benchmark/checkouts/) and its native toolchain binaries instead of
// Docker. The gate OWNS the console.warn, so a suite cannot skip silently: with any piece
// missing it announces itself once (naming every missing piece and the setup remedy) and
// `describe.runIf(...)` skips green. offline-list.test.ts recognizes this import as the
// marker that a matching/ suite is toolchain-bound (hosted CI never runs it).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The bench-owned klonoa (kleod) checkout — created by `pnpm bench setup --project kleod --build`. */
export const KLEOD_CHECKOUT = resolve(
  import.meta.dirname,
  '../../../../apps/benchmark/checkouts/klonoa-empire-of-dreams',
);

const haveBinary = (cmd: string): boolean => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error === undefined;

/** True when every checkout-relative path exists AND every named binary runs; otherwise warn
 *  once (all missing pieces + the remedy) and return false. */
export function kleodCheckoutGate(tag: string, paths: string[], binaries: string[]): boolean {
  const missing = [
    ...paths.filter((p) => !existsSync(join(KLEOD_CHECKOUT, p))),
    ...binaries.filter((b) => !haveBinary(b)).map((b) => `${b} (PATH)`),
  ];
  if (missing.length > 0) {
    console.warn(
      `[${tag}] klonoa checkout/toolchain incomplete — skipping ` +
        `(pnpm bench setup --project kleod --build): missing ${missing.join(', ')}`,
    );
    return false;
  }
  return true;
}
