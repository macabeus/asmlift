// `#fn=` names a benchmark row. Since rows carry an address, the Explorer WRITES a real row's
// identity (`project:0x…:toolchain`) and READS any spelling through bench-schema `resolveRow` —
// so a link shared before the migration (`fn=<project:sym:toolchain>`) and a link naming a symbol
// the upstream has since renamed both still open their row. These pin that over the real artifact.
import { type FunctionResult, resolveRow, rowIdentity } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// the snapshot the Explorer itself renders (`bench merge` publishes it beside the harness artifact)
const ARTIFACT = join(import.meta.dirname, '../src/pages/benchmark/data/results.json');
const rows = (JSON.parse(readFileSync(ARTIFACT, 'utf8')) as { results: FunctionResult[] }).results;

describe('a row permalink', () => {
  test('the link the Explorer writes opens that row, on every row of the artifact', () => {
    const wrong = rows.filter((r) => resolveRow(rows, rowIdentity(r)) !== r).map((r) => r.id);
    expect(wrong).toEqual([]);
  });

  test('an OLD link — the row id, the only spelling before addresses — still opens the same row', () => {
    const wrong = rows.filter((r) => resolveRow(rows, r.id) !== r).map((r) => r.id);
    expect(wrong).toEqual([]);
  });

  test('a real row is linked by its address, so the link survives an upstream rename', () => {
    const r = rows.find((x) => x.tier === 'real');
    expect(r?.addr, 'the artifact has no real row carrying an address').toMatch(/^0x[0-9a-f]{8}$/);
    const renamed: FunctionResult = {
      ...r!,
      sym: 'RenamedUpstream',
      id: `${r!.project}:RenamedUpstream:${r!.toolchain}`,
      aliases: [r!.sym],
    };
    const after = rows.map((x) => (x === r ? renamed : x));
    expect(resolveRow(after, rowIdentity(r!))).toBe(renamed); // the link written before the rename
    expect(resolveRow(after, r!.id)).toBe(renamed); // and the pre-address link, through the alias
  });
});
