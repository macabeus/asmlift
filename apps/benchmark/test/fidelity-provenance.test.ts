// FIDELITY CERTIFIES SCRIPTS AGAINST ROWS — AND BOTH COME FROM THE SAME RUN.
//
// That is what makes the gate strong (a published script really does reproduce its published row)
// and what makes it blind in one direction: the pair stays self-consistent however far either has
// drifted from the code. Measured on tier files written at a dangling commit against a DIRTY tree,
// `bench fidelity --only bfword` reported `4 script runs — 4 ok` while running the harness fresh at
// HEAD gave `m2c=noncompile` on both of those rows. Nothing was wrong with the scripts. The rows
// were from code no commit holds — and `bench merge` already REFUSED those same files.
//
// So fidelity borrows merge's refusal rather than re-spelling it, and this pins that it is wired:
// `tierRows` is the seam `loadRows` reads every tier file through.
import { describe, expect, test } from 'vitest';

import { tierRows } from '../src/run/fidelity';

const tier = (asmlift?: { commit: string; dirty: boolean }): string =>
  JSON.stringify({ meta: asmlift ? { asmlift } : {}, results: [{ id: 'x' }] });

const HERE = { commit: 'a'.repeat(40), dirty: false };

describe('fidelity refuses a tier file whose run-time provenance disagrees with now', () => {
  test('a clean tier file at this commit loads', () => {
    expect(tierRows('synthetic.json', tier(HERE), HERE)).toEqual([{ id: 'x' }]);
  });

  test('a tier file RUN against a dirty tree is refused by name', () => {
    expect(() => tierRows('synthetic.json', tier({ ...HERE, dirty: true }), HERE)).toThrow(
      /synthetic\.json was RUN against a dirty working tree/,
    );
  });

  test('a tier file run at a different commit is refused', () => {
    expect(() => tierRows('real.json', tier({ commit: 'b'.repeat(40), dirty: false }), HERE)).toThrow(
      /real\.json was RUN at .* but merge is at/,
    );
  });

  // Same rule merge states: an UNSTAMPED tier file is an old artifact, not a mutated tree, and a
  // loud failure for an absence would make every pre-stamp file unreadable.
  test('a tier file with no stamp still loads', () => {
    expect(tierRows('synthetic.json', tier(undefined), HERE)).toEqual([{ id: 'x' }]);
  });
});
