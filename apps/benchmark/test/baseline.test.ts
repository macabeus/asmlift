// `bench baseline` replaced a `git show … | jq` fence that a round pasted into a prompt, and the
// reason it is code now is that every way the fence could go wrong went wrong SILENTLY — an
// unfetched ref, an unsubstituted `<SYM>` placeholder and a pasted row id all printed nothing and
// exited 0, into a doc that reads empty output as "this symbol has no benchmark row". So what is
// pinned here is the selection, which is the half that can be wrong without erroring.
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

  // An unsubstituted placeholder is the failure the fence had no guard for. It must select
  // nothing here so the caller can exit 1 on it — never match by accident.
  test('an unsubstituted <SYM> placeholder matches nothing', () => {
    expect(selectRows(rows, '<SYM>')).toEqual([]);
  });

  // The empty pattern is the original incident: as a jq regex it matched all 1035 rows and printed
  // a plausible table. `includes('')` is true for every string, so the caller rejects the empty
  // argument before this is ever reached (`cli.ts`'s usage exit) — this pins WHY that check is
  // load-bearing rather than cosmetic.
  test('the empty argument would select everything, which is why the CLI refuses it', () => {
    expect(selectRows(rows, '').length).toBe(rows.length);
  });
});

describe('formatRow', () => {
  test('an unscored side prints `-`, never `null`', () => {
    expect(formatRow(rows[1])).toBe('af:_MtxF_to_Mtx:ido7.1  asmlift=nonmatch 171/387  m2c=noncompile -/-');
  });

  // The whole `N/M`, because the denominator moves: #174 changed how scores are printed against
  // the denominator they were measured with, and a round quoting the `N` alone compares nothing.
  test('both halves of the fraction are printed', () => {
    expect(formatRow(rows[0])).toContain('171/387');
  });
});
