// The files `bench vendor` writes for a project's rows (cases/vendor.ts `writeVendoredBlobs`): one TU blob
// per row, one context blob per distinct context, and nothing else left behind in the directory.
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { writeVendoredBlobs } from '../src/cases/vendor';

describe('writeVendoredBlobs', () => {
  test('writes a TU per row and a context per distinct text, and indexes both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-blobs-'));
    const { index, contexts } = writeVendoredBlobs(dir, [
      { sym: 'f', tuI: 'int f(void) { return 1; }\n', ctxI: 'typedef int s32;\n' },
      { sym: 'g', tuI: 'int g(void) { return 2; }\n', ctxI: 'typedef int s32;\n' },
    ]);
    expect(contexts).toBe(1);
    expect(index.f.ctx).toBe(index.g.ctx);
    expect(readdirSync(dir).sort()).toEqual(['f.i.gz', 'g.i.gz', index.f.ctx].sort());
  });

  // A re-vendor whose contexts changed wrote new `ctx-<sha>` files beside the old ones, which then sat
  // committed with nothing reading them: 7 across pokeemerald, sa3 and snowboardkids2 today.
  test('removes a blob the rows no longer read, and nothing that is not a blob', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-blobs-'));
    writeFileSync(join(dir, 'ctx-000000000000.i.gz'), 'stale');
    writeFileSync(join(dir, 'gone.i.gz'), 'stale');
    writeFileSync(join(dir, 'PROVENANCE.json'), '{}');
    const { index } = writeVendoredBlobs(dir, [{ sym: 'f', tuI: 'int f(void);\n', ctxI: '\n' }]);
    expect(readdirSync(dir).sort()).toEqual(['PROVENANCE.json', 'f.i.gz', index.f.ctx].sort());
  });
});
