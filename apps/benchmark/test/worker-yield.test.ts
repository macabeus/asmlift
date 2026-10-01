// vitest.worker-yield.ts: the worker's event loop polls between two tests, so a reply its runner
// is waiting on is read between synchronous tests instead of after their sum. A callback queued
// by one test has run by the next only if the loop turned in between.
import { describe, expect, test } from 'vitest';

import root from '../../../vitest.config';
import matching from '../../../vitest.matching.config';

// the second test reads what the first left, so a filter selects the describe
describe('the event loop turns between two tests', () => {
  let queued = false;
  let turned = false;

  test('a test queues a macrotask', () => {
    queued = true;
    setImmediate(() => {
      turned = true;
    });
  });

  test('the event loop ran it before the next test', () => {
    expect(queued, 'the test that queues it did not run; filter on the describe').toBe(true);
    expect(turned).toBe(true);
  });
});

test('both vitest configs run it in every file', () => {
  for (const config of [root, matching]) {
    expect(config.test?.setupFiles).toContain('./vitest.worker-yield.ts');
  }
});
