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

/** The `main-thread idle+other` figure off one report line. */
const idleOf = (line: string): number => Number(/idle\+other (-?\d+\.\d+)s/.exec(line)?.[1]);

test('only work that HELD the main thread is taken out of idle', async () => {
  // pooled: the compile is an await, so the main thread really was idle through it
  const pooled = new PhaseClock();
  await pooled.timeAsync('compile', () => new Promise((r) => setTimeout(r, 300)));
  expect(idleOf(pooled.report())).toBeGreaterThan(0.2);

  // serial: the same compiling ran ON the main thread, so it is not idle as well as charged
  const serial = new PhaseClock();
  serial.time('score', () => serial.time('compile', () => burn(300)));
  expect(serial.charged('compile').ms).toBeGreaterThan(250);
  expect(idleOf(serial.report())).toBeLessThan(0.1);
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
