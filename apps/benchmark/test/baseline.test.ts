// What is pinned here is `bench baseline`'s SELECTION — the half that can be wrong without
// erroring. Every other way of finding no row raises (an unreadable ref throws, no match exits 1),
// but a selection that quietly picks the wrong set, or none, prints the empty output a reader takes
// as "this symbol has no benchmark row, so it is measured outside the harness".
import type { FunctionResult } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

import { formatRow, selectRows } from '../src/report/baseline';

const row = (id: string, sym: string, over: Partial<FunctionResult> = {}): FunctionResult =>
  ({
    id,
    sym,
    asmlift: { outcome: 'nonmatch', score: 171, maxScore: 387 },
    m2c: { outcome: 'noncompile', score: null, maxScore: null },
    ...over,
  }) as unknown as FunctionResult;

const rows = [
  row('kleod:CountCollectedGems:agbcc', 'CountCollectedGems'),
  row('af:_MtxF_to_Mtx:ido7.1', '_MtxF_to_Mtx'),
  row('synthetic:add:agbcc', 'add'),
  row('synthetic:addsub:agbcc', 'addsub'),
];

describe('selectRows', () => {
  // The same matcher `bench run --only` uses (`x.sym.includes(...)`), so one typed name cannot
  // select a different set here than in the run the reader is about to do.
  test('a symbol substring selects the same rows --only would', () => {
    expect(selectRows(rows, 'add').map((r) => r.id)).toEqual(['synthetic:add:agbcc', 'synthetic:addsub:agbcc']);
  });

  // The command PRINTS ids and both briefs teach them (`project:sym:toolchain`), so pasting back
  // what it printed must work. Under a plain `.sym` match it would select nothing — and "nothing"
  // is the output that reads as "this symbol is measured outside the harness".
  test('a row id selects its row rather than nothing', () => {
    expect(selectRows(rows, 'kleod:CountCollectedGems:agbcc').map((r) => r.id)).toEqual([
      'kleod:CountCollectedGems:agbcc',
    ]);
  });

  test('a partial id still selects, so a project prefix lists the project', () => {
    expect(selectRows(rows, 'synthetic:').length).toBe(2);
  });

  // A brief's placeholder that reached the command unsubstituted must select nothing, so the
  // caller exits 1 on it — never match by accident.
  test('an unsubstituted <SYM> placeholder matches nothing', () => {
    expect(selectRows(rows, '<SYM>')).toEqual([]);
  });

  // `includes('')` is true for every string, so an empty argument selects the whole artifact and
  // prints a plausible table of every row. The caller rejects it before this is ever reached
  // (`cli.ts`'s usage exit) — this pins WHY that check is load-bearing rather than cosmetic.
  test('the empty argument would select everything, which is why the CLI refuses it', () => {
    expect(selectRows(rows, '').length).toBe(rows.length);
  });
});

describe('formatRow', () => {
  test('an unscored side prints `-`, never `null`', () => {
    expect(formatRow(rows[1])).toBe('af:_MtxF_to_Mtx:ido7.1  asmlift=nonmatch 171/387  m2c=noncompile -/-');
  });

  // The whole `N/M`: `maxScore` is objdiff's row count for the WINNING candidate's alignment, so a
  // different spelling wins and the denominator moves. A round quoting the `N` alone compares
  // nothing.
  test('both halves of the fraction are printed', () => {
    expect(formatRow(rows[0])).toContain('171/387');
  });

  // THE TWO COST FIELDS, in the reader that already exists. They are published on every ranked row
  // and were readable only through a NEW lookup that re-implements the ref read — and does it
  // WITHOUT the CURRENT / NOT CURRENT verdict this command stamps, which is this repo's own answer
  // to quoting a stale artifact number.
  test('a ranked row shows the fan it cost and the seconds it took', () => {
    const ranked = row('p:f:agbcc', 'f', {
      asmlift: { outcome: 'nonmatch', score: 1, maxScore: 2, candidateCount: 5952, rankSeconds: 518.42 },
    } as unknown as Partial<FunctionResult>);
    expect(formatRow(ranked)).toContain('fan=5952 rank=518.4s');
  });

  // …and a row that never ranked records neither, so it stays one line rather than growing two
  // empty fields. Absent is the honest answer: `fan=0` would read as "this row enumerates nothing".
  test('a row that never ranked grows no cost fields', () => {
    expect(formatRow(rows[1])).not.toContain('fan=');
    expect(formatRow(rows[1])).not.toContain('rank=');
  });
});
