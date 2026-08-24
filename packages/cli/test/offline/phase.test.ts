// The ranked run's phase clock (src/phase.ts). Two things need pinning: that a phase containing
// another one reports only its OWN work — the serial driver compiles inside the call it scores in,
// and a `score` that quietly counted the compile would be the whole profile wrong — and that a
// caller who mints no clock is charged nothing.
import { expect, test } from 'vitest';

import { PhaseClock, timed, timedAsync } from '../../src/phase';

/** Busy-wait, so the elapsed time is the process's and not a timer's. */
const burn = (ms: number): number => {
  const until = performance.now() + ms;
  let n = 0;
  while (performance.now() < until) {
    n++;
  }
  return n;
};

test('a nested phase is charged to the inner one only', () => {
  const clock = new PhaseClock();
  clock.time('score', () => clock.time('compile', () => burn(40)));

  expect(clock.charged('compile').ms).toBeGreaterThanOrEqual(35);
  expect(clock.charged('score').calls).toBe(1);
  // score's frame did nothing but hold the compile
  expect(clock.charged('score').ms).toBeLessThan(clock.charged('compile').ms / 2);
});

test('sibling phases each keep their own time', () => {
  const clock = new PhaseClock();
  clock.time('enumerate', () => burn(20));
  clock.time('rank', () => burn(20));
  expect(clock.charged('enumerate').ms).toBeGreaterThanOrEqual(15);
  expect(clock.charged('rank').ms).toBeGreaterThanOrEqual(15);
});

test('a phase that throws is still charged', () => {
  const clock = new PhaseClock();
  expect(() =>
    clock.time('score', () => {
      burn(20);
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(clock.charged('score').ms).toBeGreaterThanOrEqual(15);
});

test('awaited phases are flat — several are in flight at once', async () => {
  const clock = new PhaseClock();
  clock.workers = 2;
  await Promise.all([
    clock.timeAsync('compile', () => new Promise((r) => setTimeout(r, 40))),
    clock.timeAsync('compile', () => new Promise((r) => setTimeout(r, 40))),
  ]);
  // summed across the two, so it exceeds the ~40 ms of wall they took together
  expect(clock.charged('compile').calls).toBe(2);
  expect(clock.charged('compile').ms).toBeGreaterThanOrEqual(60);
  expect(clock.report()).toContain('over 2 workers');
});

test('the report names every phase charged, and no other', () => {
  const clock = new PhaseClock();
  clock.time('enumerate', () => burn(1));
  const line = clock.report();
  expect(line).toMatch(/^asmlift: \[phase] wall \d+\.\d+s · enumerate \d+\.\d+s \(1 call\) · main-thread idle\+other/);
  expect(line).not.toContain('compile');
  expect(line.endsWith('\n')).toBe(true);
});

test('no clock, no timing — the helpers still run the work', async () => {
  expect(timed(undefined, 'score', () => 7)).toBe(7);
  expect(await timedAsync(undefined, 'compile', () => Promise.resolve(9))).toBe(9);
});
