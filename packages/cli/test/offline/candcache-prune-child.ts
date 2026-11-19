// A child process for candcache-store.test.ts's concurrent-open cases: one process per role, so
// leases, prune marks and pids are the real ones. The store, the cap and the sampling come from
// the environment the parent hands it (candcache.ts reads them once, at load).
//
//   reader: open `ns`, write `ready`, then serve keys k0..k<keys-1> for `holdMs`, reading every
//           served object back, and read each one again at the end. Prints {hits, misses, bad}.
//   pruner: open `ns` (which prunes, the cap being over) and print the counters.
import { readFileSync, writeFileSync } from 'node:fs';

import { cacheStats, candCache } from '../../src/candcache';

interface Args {
  role: 'reader' | 'pruner';
  ns: string;
  keys?: number;
  holdMs?: number;
  ready?: string;
}

const args = JSON.parse(process.argv[2]) as Args;
const c = candCache('t', () => args.ns);
c.warm();
if (args.role === 'pruner') {
  process.stdout.write(`${JSON.stringify(cacheStats())}\n`);
} else {
  if (args.ready !== undefined) {
    writeFileSync(args.ready, 'ready\n');
  }
  const want = (k: number): string => `${args.ns.slice(0, 4)}-${k}`;
  let hits = 0;
  let misses = 0;
  const bad: string[] = [];
  const served = new Map<string, number>();
  const read = (path: string, k: number): void => {
    let got: string;
    try {
      got = readFileSync(path, 'utf8');
    } catch (e) {
      bad.push(`k${k}: served ${path} and it is gone: ${(e as Error).message}`);
      return;
    }
    if (got !== want(k)) {
      bad.push(`k${k}: served ${JSON.stringify(got)}`);
    }
  };
  const until = Date.now() + (args.holdMs ?? 0);
  do {
    for (let k = 0; k < (args.keys ?? 0); k++) {
      const hit = c.get(`k${k}`, 'f');
      if (typeof hit === 'string') {
        hits += 1;
        served.set(hit, k);
        read(hit, k);
      } else {
        misses += 1;
      }
    }
  } while (Date.now() < until);
  for (const [path, k] of served) {
    read(path, k);
  }
  process.stdout.write(`${JSON.stringify({ hits, misses, bad })}\n`);
}
