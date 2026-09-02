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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../src/config';
import { MEASURED_PATHS } from '../src/provenance';
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

// AND THE ONE CASE THE SHA COMPARISON GETS WRONG. Committing the regenerated artifact is the very
// next step in the documented order, and it moves HEAD — so a sha comparison refuses the tier
// files it just certified, with the message "the code moved between run and merge" for a commit
// that moved no code. A loud refusal whose stated cause is false is the same class of wrong answer
// as a published error marker naming a cause the run does not have, which is what the commit two
// before this one removed. Asked of the measured PATHS instead: exempt when none differs, refused
// when one does, and `dirty` refused either way.
describe('a commit that moved no measured code is not "the code moved"', () => {
  const at = (commit: string, dirty = false): string => tier({ commit, dirty });
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  test('different commits, identical measured paths: the rows load', () => {
    expect(tierRows('synthetic.json', at(A), { commit: B, dirty: false }, () => true)).toEqual([{ id: 'x' }]);
  });

  test('different commits, a measured path differs: still refused', () => {
    expect(() => tierRows('synthetic.json', at(A), { commit: B, dirty: false }, () => false)).toThrow(
      /was RUN at .* but merge is at/,
    );
  });

  // The dirty refusal is unconditional on purpose: numbers from code no commit holds are not
  // certifiable however similar two commits look.
  test('a dirty stamp is refused even when no measured path differs', () => {
    expect(() => tierRows('synthetic.json', at(A, true), { commit: B, dirty: false }, () => true)).toThrow(
      /was RUN against a dirty working tree/,
    );
  });

  // git declining to answer is not a yes.
  test('the exemption needs a positive answer, not the absence of a negative', () => {
    expect(() => tierRows('real.json', at(A), { commit: B, dirty: false }, () => false)).toThrow();
  });
});

// TWO COPIES OF ONE LIST DRIFT, and this one decides both whether a tier file is usable and
// whether the committed artifact is valid. The shell gate owns the canonical spelling; this holds
// the TypeScript copy to it, so widening one without the other fails here rather than in a gate
// that quietly stops covering a path.
describe('MEASURED_PATHS agrees with the provenance script', () => {
  const script = readFileSync(join(REPO_ROOT, 'scripts/check-artifact-provenance.sh'), 'utf8');
  const line = /^paths='([^']+)'/m.exec(script);

  test('the script still spells its path list the way this test reads it', () => {
    expect(line).not.toBeNull();
  });

  test('the two lists are the same set', () => {
    expect([...MEASURED_PATHS].sort()).toEqual(line![1].split(/\s+/).filter(Boolean).sort());
  });
});
