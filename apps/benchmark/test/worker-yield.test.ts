// vitest.worker-yield.ts: the worker's event loop polls between two tests, so a reply its runner
// is waiting on is read between synchronous tests instead of after their sum. A callback queued
// by one test has run by the next only if the loop turned in between.
import { expect, test } from 'vitest';

let turned = false;

test('a test queues a macrotask', () => {
  setImmediate(() => {
    turned = true;
  });
});

test('the event loop ran it before the next test', () => {
  expect(turned).toBe(true);
});
