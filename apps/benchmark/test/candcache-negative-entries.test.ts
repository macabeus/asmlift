// WHICH failures the candidate-object cache is allowed to remember, on the bench's own agbcc
// pipeline (src/compile/agbcc.ts).
//
// A negative entry is sound only for a DETERMINISTIC rejection: the compiler ran, exited nonzero,
// and said what was wrong. Everything else is this machine having a bad minute, and a transient
// stored as a rejection drops that candidate from EVERY future run under the namespace — a
// spelling silently missing from the row's fan, which is the failure mode this repo bans.
//
// Reproduced on the shipped code before this guard existed: `status !== 0` is ALSO true when
// `status === null` because the process was killed by a signal (an OOM kill, a stray `pkill`, a
// shard reaped under load — `util.ts run()` only throws for `error`, which covers ENOENT and the
// 120 s timeout but not a signal). A SIGKILLed agbcc produced literally `"agbcc failed: "`, the
// old `/^(cpp|agbcc|as) failed: /` matched it, and the next perfectly healthy run under the same
// namespace threw the stored transient without invoking agbcc at all.
import { describe, expect, test } from 'vitest';

import { DETERMINISTIC_REJECTION, stepFailed } from '../src/compile/agbcc';

const thrown = (r: { status: number | null; signal?: NodeJS.Signals | null; stderr: string }): string => {
  try {
    stepFailed('agbcc', r);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('stepFailed must always throw');
};

describe('the verdict is read off the SPAWN RESULT, never off the message text', () => {
  test('a real diagnostic is a rejection, and it is storable', () => {
    const m = thrown({ status: 1, stderr: "c.c:3: conflicting types for `f'\n" });
    expect(m).toMatch(/^agbcc failed: /);
    expect(DETERMINISTIC_REJECTION.test(m), 'a compiler that ran and said no may be remembered').toBe(true);
  });

  test('a SIGNAL is a transient — the exact shape that stored `"agbcc failed: "`', () => {
    const m = thrown({ status: null, signal: 'SIGKILL', stderr: '' });
    expect(m).toContain('killed by SIGKILL');
    expect(DETERMINISTIC_REJECTION.test(m), 'one OOM kill must not drop this candidate forever').toBe(false);
  });

  test('a nonzero exit with NO diagnostic is a transient too — it did not diagnose anything', () => {
    const m = thrown({ status: 137, stderr: '   \n' });
    expect(m).toContain('no diagnostic');
    expect(DETERMINISTIC_REJECTION.test(m)).toBe(false);
  });

  test('the predicate alone would have been fooled: the old guard matched the empty message', () => {
    // Kept as the record of what went wrong. `\S` is the difference between the two.
    expect(/^(cpp|agbcc|as) failed: /.test('agbcc failed: ')).toBe(true);
    expect(DETERMINISTIC_REJECTION.test('agbcc failed: ')).toBe(false);
  });

  test('a spawn failure message (util.ts run) is not a rejection either', () => {
    expect(DETERMINISTIC_REJECTION.test('agbcc: spawn failed (ENOENT)')).toBe(false);
  });
});
