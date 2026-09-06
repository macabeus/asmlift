// `EnumerateOptions.onAxisGated` and `onTreeDeduped` report the enumeration's two SILENT
// candidate-deleting sites. Nothing in the shipped pipeline passes either one, so a reporting
// channel that had stopped firing would look exactly like one whose sites correctly never trip —
// which is the failure the channels exist to make visible, reproduced one level up.
//
// So this pins that they FIRE, over asm the corpus already carries. It asserts the direction and
// not a count: the counts move with every axis added and with every fixture, and a count is what
// would make this test fail for reasons it is not about.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

describe('the enumeration reports its own silent deletions', () => {
  it('a gated axis and a deduped tree both reach the caller', () => {
    // A NAMED handful rather than the whole agbcc corpus: two signals are the assertion, and
    // sweeping every fixture only buys wall clock against the suite's own timeout.
    const FIXTURES = ['agbcc-clamp0.s', 'agbcc-gcd.s'];
    const gated: string[] = [];
    let deduped = 0;
    let enumerated = 0;
    for (const f of FIXTURES) {
      const asm = readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');
      const m = /^\s*\.global\s+(\w+)/m.exec(asm) ?? /^(\w+):/m.exec(asm);
      if (m === null) {
        continue;
      }
      try {
        enumerateCandidates(m[1], asm, ARMV4T_AGBCC, {
          onAxisGated: (suffix) => gated.push(suffix),
          onTreeDeduped: () => {
            deduped++;
          },
        });
        enumerated++;
      } catch {
        // a row this fixture set cannot lift says nothing either way
      }
    }
    expect(enumerated).toBeGreaterThan(0);
    // several DISTINCT axes stand down, not one gate firing repeatedly on one function
    expect(new Set(gated).size).toBeGreaterThan(1);
    expect(deduped).toBeGreaterThan(0);
  });
});
