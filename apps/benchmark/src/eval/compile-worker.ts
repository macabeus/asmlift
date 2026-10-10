// One compile worker process of a row's ranked pass (compile-pool.ts): it rebuilds the row's case and
// compiles each candidate it is sent with the compiler the ranked pass itself uses, in its own small
// process. The pool sends a worker its next candidate only once this one's reply is back.
import { cacheStats } from '@asmlift/cli/candcache';
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';

import { realCases } from '../cases/real';
import { syntheticCases } from '../cases/synthetic';
import { rowCompiler } from './asmlift';
import type { CompileReply, CompileRequest, RowRef } from './compile-pool';

const row = JSON.parse(process.argv[2]) as RowRef;
const c = (row.tier === 'real' ? realCases({ only: row.sym }) : syntheticCases({ only: row.sym })).find(
  (x) => x.id === row.id,
);
if (c === undefined) {
  throw new Error(`compile worker: no case ${row.id}`);
}
const compile = rowCompiler(c.toolchain, c.codegen, c.compile);

// the pool is this worker's only reason to exist: when it goes, so does the worker
process.on('disconnect', () => process.exit(0));

process.on('message', async (m: CompileRequest) => {
  let reply: CompileReply;
  if (m.kind === 'stats') {
    reply = { kind: 'stats', stats: cacheStats() };
  } else {
    try {
      reply = { kind: 'object', seq: m.seq, obj: await compile(m.source, m.symbol, m.backendId, m.declarations) };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      reply = {
        kind: 'error',
        seq: m.seq,
        message: error.message,
        ...(e instanceof CompilerRejection ? { diagnostic: e.diagnostic } : {}),
      };
    }
  }
  process.send!(reply);
});
