// Pin the m2c setup-vs-result boundary: a missing m2c checkout is a THROWN setup error, never
// an m2c `failed` result — otherwise a machine without m2c would publish rows where m2c "lost"
// functions it never saw. Env-driven module state (M2C_DIR is read at import), so the module
// is re-imported fresh under a stubbed ASMLIFT_M2C_DIR.
import { afterEach, expect, test, vi } from 'vitest';

import type { Toolchain } from '../src/toolchains';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// 20s: the fresh module re-import transforms the whole m2c graph, which under full-suite
// contention regularly exceeds the 5s default (a margin flake, not a hang).
test('a missing m2c checkout throws a setup error, never an m2c result', { timeout: 20_000 }, async () => {
  vi.resetModules();
  vi.stubEnv('ASMLIFT_M2C_DIR', '/nonexistent/m2c-checkout');
  const { runM2c } = await import('../src/eval/m2c');
  const tc = { asmKind: 'agbcc-s', isa: 'arm', compiler: 'agbcc' } as Toolchain;
  expect(() => runM2c(tc, 'f', '.thumb_func\nf:\n\tbx lr\n')).toThrow(
    /m2c checkout not found at \/nonexistent\/m2c-checkout.*ASMLIFT_M2C_DIR/s,
  );
});
