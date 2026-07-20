// Static, build-time import of the merged benchmark output. No fetch, no server.
import type { BenchOutput } from '@asmlift/bench-schema';

import raw from '../data/results.json';

export const bench = raw as unknown as BenchOutput;
export const results = bench.results;
export const meta = bench.meta;
