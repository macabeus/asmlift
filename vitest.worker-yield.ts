// Run in every test file of both vitest configs. vitest's worker answers its runner over an RPC
// whose deadline is a fixed 60 s, and the runner chains one test to the next through microtasks,
// so the worker's event loop does not poll between two synchronous tests: a file of short blocking
// tests (a compile each) holds the thread for all of them together, and the reply that arrives
// meanwhile is read only after its deadline has fired (`Timeout calling "onTaskUpdate"`). One
// macrotask after each test lets it be read in time. What can still exceed the deadline is a
// single test's own synchronous span.
import { afterEach } from 'vitest';

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
