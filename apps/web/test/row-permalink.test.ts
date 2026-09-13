// `#fn=` names a benchmark row. The Explorer WRITES the readable row id (`project:sym:toolchain`)
// and READS any spelling through bench-schema `resolveRow` — so a link naming a symbol the upstream
// has since renamed still opens its row, through the row's `aliases`. These pin that over the real
// artifact.
import { type FunctionResult, resolveRow } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// the snapshot the Explorer itself renders (`bench merge` publishes it beside the harness artifact)
const ARTIFACT = join(import.meta.dirname, '../src/pages/benchmark/data/results.json');
const rows = (JSON.parse(readFileSync(ARTIFACT, 'utf8')) as { results: FunctionResult[] }).results;

describe('a row permalink', () => {
  test('the link the Explorer writes — the row id — opens that row, on every row of the artifact', () => {
    const wrong = rows.filter((r) => resolveRow(rows, r.id) !== r).map((r) => r.id);
    expect(wrong).toEqual([]);
  });

  test('a link written before an upstream rename still opens the row, through its alias', () => {
    const r = rows.find((x) => x.tier === 'real');
    expect(r, 'the artifact has no real row').toBeDefined();
    const renamed: FunctionResult = {
      ...r!,
      sym: 'RenamedUpstream',
      id: `${r!.project}:RenamedUpstream:${r!.toolchain}`,
      aliases: [r!.sym],
    };
    const after = rows.map((x) => (x === r ? renamed : x));
    expect(resolveRow(after, r!.id)).toBe(renamed);
  });
});
