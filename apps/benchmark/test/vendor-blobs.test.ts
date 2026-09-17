// The files `bench vendor` writes for a project's rows (cases/vendor.ts `writeVendoredBlobs`): one TU blob
// per row, one context blob per distinct context — a row's candidate context and its m2c context are two
// of those, equal on a project whose context m2c can read as it stands — and nothing else left behind in
// the directory.
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { writeVendoredBlobs } from '../src/cases/vendor';

describe('writeVendoredBlobs', () => {
  test('writes a TU per row and a context per distinct text, and indexes both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-blobs-'));
    const ctxI = 'typedef int s32;\n';
    const { index, contexts } = writeVendoredBlobs(dir, [
      { sym: 'f', tuI: 'int f(void) { return 1; }\n', ctxI, m2cI: ctxI },
      { sym: 'g', tuI: 'int g(void) { return 2; }\n', ctxI, m2cI: ctxI },
    ]);
    expect(contexts).toBe(1);
    expect(index.f.ctx).toBe(index.g.ctx);
    expect(index.f.m2c).toBe(index.f.ctx);
    expect(readdirSync(dir).sort()).toEqual(['f.i.gz', 'g.i.gz', index.f.ctx].sort());
  });

  // A CodeWarrior row's m2c context is its candidate context with every body removed, so the two texts
  // differ and both have to be written — the runner reads one and m2c the other.
  test('writes an m2c context of its own where it differs from the candidate context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-blobs-'));
    const { index, contexts } = writeVendoredBlobs(dir, [
      { sym: 'f', tuI: 'int f(void) { return h(); }\n', ctxI: 'int h(void) { return 1; }\n', m2cI: 'int h(void);\n' },
    ]);
    expect(contexts).toBe(2);
    expect(index.f.m2c).not.toBe(index.f.ctx);
    expect(readdirSync(dir).sort()).toEqual(['f.i.gz', index.f.ctx, index.f.m2c].sort());
  });

  // A re-vendor whose contexts changed wrote new `ctx-<sha>` files beside the old ones, which then sat
  // committed with nothing reading them: 7 across pokeemerald, sa3 and snowboardkids2 today.
  test('removes a blob the rows no longer read, and nothing that is not a blob', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-blobs-'));
    writeFileSync(join(dir, 'ctx-000000000000.i.gz'), 'stale');
    writeFileSync(join(dir, 'gone.i.gz'), 'stale');
    writeFileSync(join(dir, 'PROVENANCE.json'), '{}');
    const { index } = writeVendoredBlobs(dir, [{ sym: 'f', tuI: 'int f(void);\n', ctxI: '\n', m2cI: '\n' }]);
    expect(readdirSync(dir).sort()).toEqual(['PROVENANCE.json', 'f.i.gz', index.f.ctx].sort());
  });
});
