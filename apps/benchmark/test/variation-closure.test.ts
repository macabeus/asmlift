// The variation registry (`packages/core/src/variation-tokens.ts`) against the names the benchmark
// actually carries.
//
// CLOSURE OVER PUBLISHED AND ENUMERATED NAMES. The mint sites themselves are typed: an unregistered
// variation is a `pnpm typecheck` error, and `packages/core/test/variation-mints.test.ts` proves
// every registered variation is still minted. What those two cannot see is data:
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
// A name that fails here was published or minted by a tree the type gate did not check — an artifact
// regenerated from an older registry, or a subject shape the registry's pattern no longer admits.
import { enumerateRanked } from '@asmlift/cli/rank';
import { VARIATION_DEFINITIONS } from '@asmlift/core/variation-definitions';
import {
  VARIATION_KINDS,
  joinVariations,
  parseVariation,
  splitVariations,
  variationToken,
} from '@asmlift/core/variation-tokens';
import { agbccAvailable } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { scrubObjectHeader } from '../src/asm-scrub';
import { syntheticCases } from '../src/cases/synthetic';
import { rankOptionsFor } from '../src/eval/asmlift';

/** What is wrong with one candidate's name — its variations, `/`-joined as `name` — or `undefined`:
 *  an unregistered variation, a variation out of kind order, or a first variation that is not a
 *  signedness. */
function nameDefect(name: string): string | undefined {
  const variations = splitVariations(name);
  let previous = -1;
  for (const [i, part] of variations.entries()) {
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
      winnerVariations?: string[];
      droppedCandidates?: { variations: string[] }[];
      withheldCandidates?: { variations: string[] }[];
      fanSize?: number;
      fanVariations?: Record<string, unknown>;
    };
  }[];
  const winners = rows.flatMap((r) => (r.asmlift?.winnerVariations === undefined ? [] : [r.asmlift.winnerVariations]));
  // Distinct names, keyed on the one join: it throws on an entry holding `/`, so two different
  // lists can never collapse into one key here.
  const names = new Set(
    [
      ...winners,
      ...rows
        .flatMap((r) => [...(r.asmlift?.droppedCandidates ?? []), ...(r.asmlift?.withheldCandidates ?? [])])
        .map((c) => c.variations),
    ].map(joinVariations),
  );

  test('the artifact names candidates at all (the floor every assertion below rests on)', () => {
    // 821 winners and 336 distinct names at b1be5321; a floor, so a larger corpus never fails it.
    expect(winners.length).toBeGreaterThanOrEqual(800);
    expect(names.size).toBeGreaterThanOrEqual(300);
  });

  test('every published name is a list of variations, not one `/`-joined string', () => {
    const lists = rows.flatMap((r) => [
      r.asmlift?.winnerVariations,
      ...(r.asmlift?.droppedCandidates ?? []).map((c) => c.variations),
      ...(r.asmlift?.withheldCandidates ?? []).map((c) => c.variations),
    ]);
    expect(lists.filter((v) => v !== undefined && !Array.isArray(v))).toEqual([]);
  });

  test('every published name parses into registered variations, signedness first, in kind order', () => {
    expect([...names].flatMap((n) => nameDefect(n) ?? [])).toEqual([]);
  });

  test('no published name uses `winner`, the word `bench fan --show` reserves', () => {
    expect([...names].filter((n) => splitVariations(n).includes('winner'))).toEqual([]);
  });

  // `tsc` already refuses a registered name without a reader definition; this is the run-time check,
  // and it names what the artifact would show undefined.
  test('every published variation, and every fan roster key, has a reader definition', () => {
    const parts = [...names].flatMap((n) => splitVariations(n));
    // A roster key is a registered name as it stands, never a variation applied to a subject.
    const rosterKeys = [...new Set(rows.flatMap((r) => Object.keys(r.asmlift?.fanVariations ?? {})))];
    expect(rosterKeys.filter((k) => variationToken(k).name !== k)).toEqual([]);
    const undefinedNames = [...new Set([...parts.map((p) => parseVariation(p).name), ...rosterKeys])].filter(
      (n) => !Object.hasOwn(VARIATION_DEFINITIONS, n),
    );
    expect(undefinedNames).toEqual([]);
  });

  // The Fan Explorer counts a win only on a row whose fan was counted, so a ranked row without a
  // roster would vanish from every rate and price without a trace on the page.
  test('a row carries a fan roster exactly when it carries a fan size, and its winner is inside it', () => {
    expect(rows.filter((r) => (r.asmlift?.fanSize === undefined) !== (r.asmlift?.fanVariations === undefined))).toEqual(
      [],
    );
    expect(rows.filter((r) => r.asmlift?.fanVariations !== undefined).length).toBeGreaterThanOrEqual(800);
    const outside = rows.flatMap((r) =>
      (r.asmlift?.winnerVariations ?? [])
        .map((p) => parseVariation(p).name)
        .filter((n) => !Object.hasOwn(r.asmlift?.fanVariations ?? {}, n))
        .map((n) => `${r.id}: ${n}`),
    );
    expect(outside).toEqual([]);
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
        let cands: { variations: readonly string[] }[];
        try {
          cands = enumerateRanked(c.sym, asm, c.toolchain.targetDesc, { ...opts, onEnumerationError: () => {} });
        } catch {
          continue; // a row that declines mints nothing to check
        }
        fans++;
        for (const x of cands) {
          names.add(joinVariations(x.variations));
        }
      }
    }
    // At b1be5321: 707 fans and 3,037 distinct names with every synthetic toolchain present, 334 and
    // 2,915 of them agbcc's. The floor sits under the agbcc-only figures, so a shell with agbcc and
    // nothing else still passes, and a selection that silently shrank to a handful of rows does not.
    expect(fans).toBeGreaterThan(200);
    expect(names.size).toBeGreaterThan(2000);
    expect([...names].flatMap((n) => nameDefect(n) ?? [])).toEqual([]);
    expect([...names].filter((n) => splitVariations(n).includes('winner'))).toEqual([]);
  }, 600_000);
});
