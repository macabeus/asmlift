// The variation registry (`packages/core/src/variation-tokens.ts`) against the names the benchmark
// actually carries.
//
// CLOSURE, POINTS 2 AND 3 OF 3 (point 1, the mint literals, is `packages/core/test/variation-tokens.
// test.ts`):
//
//   2. every name the COMMITTED artifact publishes — each winner's and each dropped or withheld
//      candidate's — parses, part by part, in kind order. This runs wherever the suite runs, CI
//      included, and it is the half that reads published data.
//   3. every name the ENUMERATED synthetic tier mints parses the same way. The artifact stores the
//      winner and the refused candidates only, which is a fraction of the variations enumeration
//      mints, so only an enumeration closes the set. It needs agbcc to build the rows' targets, so
//      it is SKIPPED where agbcc is absent — CI among them — and reports as skipped, never as
//      passed.
//
// A name that fails here is either a variation minted without a registry entry, or a registry entry
// spelled differently from its mint site. Both are fixed in `variation-tokens.ts` or at the mint.
import { enumerateRanked } from '@asmlift/cli/rank';
import { VARIATION_KINDS, parseVariation, variationToken } from '@asmlift/core/variation-tokens';
import { agbccAvailable } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { scrubObjectHeader } from '../src/asm-scrub';
import { syntheticCases } from '../src/cases/synthetic';
import { rankOptionsFor } from '../src/eval/asmlift';

/** What is wrong with one candidate's name, or `undefined`: an unregistered part, a part out of
 *  kind order, or a first part that is not a signedness. */
function nameDefect(name: string): string | undefined {
  const parts = name.split('/');
  let previous = -1;
  for (const [i, part] of parts.entries()) {
    let kind: number;
    try {
      kind = VARIATION_KINDS.indexOf(variationToken(parseVariation(part).name).variationKind);
    } catch (e) {
      return `${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (i === 0 && VARIATION_KINDS[kind] !== 'signedness') {
      return `${name}: the first variation is '${part}', not a signedness`;
    }
    if (kind < previous) {
      return `${name}: '${part}' (${VARIATION_KINDS[kind]}) after a ${VARIATION_KINDS[previous]} variation`;
    }
    previous = kind;
  }
  return undefined;
}

describe('closure over the names the committed artifact publishes', () => {
  const rows = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'results', 'results.json'), 'utf8')).results as {
    id: string;
    asmlift?: {
      candidateLabel?: string;
      droppedCandidates?: { label: string }[];
      withheldCandidates?: { label: string }[];
    };
  }[];
  const winners = rows.flatMap((r) => (r.asmlift?.candidateLabel === undefined ? [] : [r.asmlift.candidateLabel]));
  const names = new Set([
    ...winners,
    ...rows
      .flatMap((r) => [...(r.asmlift?.droppedCandidates ?? []), ...(r.asmlift?.withheldCandidates ?? [])])
      .map((c) => c.label),
  ]);

  test('the artifact names candidates at all (the floor every assertion below rests on)', () => {
    // 821 winners and 336 distinct names at b1be5321; a floor, so a larger corpus never fails it.
    expect(winners.length).toBeGreaterThanOrEqual(800);
    expect(names.size).toBeGreaterThanOrEqual(300);
  });

  test('every published name parses into registered variations, signedness first, in kind order', () => {
    expect([...names].flatMap((n) => nameDefect(n) ?? [])).toEqual([]);
  });

  test('no published name uses `winner` or `best`, the words `bench fan --show` reserves', () => {
    expect([...names].filter((n) => n.split('/').some((p) => p === 'winner' || p === 'best'))).toEqual([]);
  });
});

describe.skipIf(!agbccAvailable())('closure over the names the enumerated synthetic tier mints', () => {
  test('every enumerated name parses into registered variations, signedness first, in kind order', () => {
    const names = new Set<string>();
    let fans = 0;
    for (const c of syntheticCases()) {
      if (!c.toolchain.available()) {
        continue;
      }
      const built = c.build();
      const asm = scrubObjectHeader(built.asm);
      for (const symbols of c.symbols === undefined ? [undefined] : [undefined, c.symbols]) {
        const opts = rankOptionsFor(c.toolchain, built.obj, c.proto, c.compile, symbols);
        let cands: { label: string }[];
        try {
          cands = enumerateRanked(c.sym, asm, c.toolchain.targetDesc, { ...opts, onLeverError: () => {} });
        } catch {
          continue; // a row that declines mints nothing to check
        }
        fans++;
        for (const x of cands) {
          names.add(x.label);
        }
      }
    }
    // At b1be5321: 707 fans and 3,037 distinct names with every synthetic toolchain present, 334 and
    // 2,915 of them agbcc's. The floor sits under the agbcc-only figures, so a shell with agbcc and
    // nothing else still passes, and a selection that silently shrank to a handful of rows does not.
    expect(fans).toBeGreaterThan(200);
    expect(names.size).toBeGreaterThan(2000);
    expect([...names].flatMap((n) => nameDefect(n) ?? [])).toEqual([]);
    expect([...names].filter((n) => n.split('/').some((p) => p === 'winner' || p === 'best'))).toEqual([]);
  }, 600_000);
});
