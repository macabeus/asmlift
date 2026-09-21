// A NONZERO EXIT IS THE COMPILER'S VERDICT ONLY WHEN THE COMPILER GAVE ONE. `refused` reads a
// direct spawn, where a killed process is `status: null`; `containerRefused` reads a `docker run` /
// `docker exec`, where docker reports its own failures and a killed contained command as exit
// statuses of its own (125–127, 128+signal). Core's stillborn rule compares `CompilerRejection`s
// only, so a transient minted as one could declare a fan stillborn on this machine's bad minute.
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { expect, test } from 'vitest';

import { containerRefused, refused } from '../src/compile';

const STDERR = "c.c:3: too many arguments to function `g'";
const r = (status: number | null) => ({ status, stderr: STDERR, stdout: '' });

test('a direct spawn that exited nonzero is a rejection carrying its whole stderr', () => {
  const e = refused('agbcc', r(1));
  expect(e).toBeInstanceOf(CompilerRejection);
  expect((e as CompilerRejection).diagnostic).toBe(STDERR);
  expect(e.message).toBe(`agbcc failed: ${STDERR}`);
});

test('a direct spawn killed by a signal is not a rejection, whatever it printed', () => {
  expect(refused('agbcc', r(null))).not.toBeInstanceOf(CompilerRejection);
});

test.each([1, 4, 124])('a container exit of %i is the compiler’s verdict', (status) => {
  expect(containerRefused('kmc gcc (docker)', r(status))).toBeInstanceOf(CompilerRejection);
});

test.each([125, 126, 127, 137, null])('a container exit of %s is docker’s, not the compiler’s', (status) => {
  const e = containerRefused('kmc gcc (docker)', r(status));
  expect(e).not.toBeInstanceOf(CompilerRejection);
  expect(e.message).toContain('transient');
});
