// Pin the loud-spawn contract: a binary that cannot RUN (ENOENT) is a named setup error
// carrying the remedy pointer, never `status: null` leaking into "<tool> failed: null".
// Offline by construction — the probed path deliberately doesn't exist.
import { describe, expect, test } from 'vitest';

import { run } from '../src/compile/util';

describe('run() spawn failures (pinned)', () => {
  test('a missing binary throws a setup error naming the command and the env-var remedy', () => {
    expect(() => run('/nonexistent/asmlift-test-binary', ['--version'])).toThrow(
      /cannot run '\/nonexistent\/asmlift-test-binary' \(ENOENT\).*ASMLIFT_\*/s,
    );
  });

  test('a real compile failure still returns for the caller to diagnose', () => {
    // `sh -c "exit 3"` spawns fine and exits nonzero — must NOT throw at the spawn seam
    const r = run('sh', ['-c', 'exit 3']);
    expect(r.status).toBe(3);
  });
});
