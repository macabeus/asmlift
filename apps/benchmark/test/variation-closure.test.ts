// The variation registry (`packages/core/src/variation-tokens.ts`) against the names the benchmark
// actually carries.
//
// CLOSURE OVER PUBLISHED AND ENUMERATED NAMES. The mint sites themselves are typed: an unregistered
// variation is a `pnpm typecheck` error, and `packages/core/test/variation-mints.test.ts` proves
// every registered variation is still minted. What those two cannot see is data:
//
//   1. every name the COMMITTED artifact publishes — each winner's and each dropped or withheld
//      candidate's — parses, part by part, in kind order. This runs wherever the suite runs, CI
//      included, and it is the half that reads published data.
//   2. every name ENUMERATION mints parses the same way. The artifact stores the winner and the
//      refused candidates only, a fraction of what enumeration mints, so only an enumeration closes
//      the set — and the bench does that one: `tallyFanVariations` refuses every candidate of every
//      fan it ranks, on both tiers, by the same `variationsDefect` this file uses
//      (`packages/core/test/variation-tokens.test.ts` proves the refusal fires). What the bench
//      never ranks is a row that carries a symbol map, enumerated WITHOUT it: it hands `c.symbols`
//      to every such row (run/runner.ts). That configuration alone is enumerated here. It needs the
//      rows' toolchains to build their targets, so it is SKIPPED where they are absent — CI among
//      them — and reports as skipped, never as passed.
//
// A name that fails here is one the type gate cannot refuse: its parts out of kind order, or, in the
// artifact, a name published before the registry changed.
import { enumerateRanked } from '@asmlift/cli/rank';
import { VARIATION_DEFINITIONS } from '@asmlift/core/variation-definitions';
import {
  joinVariations,
  parseVariation,
  splitVariations,
  variationToken,
  variationsDefect,
} from '@asmlift/core/variation-tokens';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { scrubObjectHeader } from '../src/asm-scrub';
import { syntheticCases } from '../src/cases/synthetic';
import { rankOptionsFor } from '../src/eval/asmlift';

/** What is wrong with one `/`-joined name, or `undefined` (core `variationsDefect`). */
const nameDefect = (name: string): string | undefined => variationsDefect(splitVariations(name));

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
    // A floor, so a larger corpus never fails it: most of the names are winners', and a corpus
    // that names fewer has stopped exercising the closure below.
    expect(winners.length).toBeGreaterThanOrEqual(800);
    expect(names.size).toBeGreaterThanOrEqual(120);
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

describe('closure over the names a symbol-map row mints without its map', () => {
  // Every other enumeration is the bench's own (see the header); a toolchain this machine lacks is
  // skipped.
  const rows = syntheticCases().filter((c) => c.symbols !== undefined);
  const toolchains = [...new Set(rows.map((c) => c.toolchain))];
  const absent = toolchains.filter((tc) => !tc.available()).map((tc) => tc.id);

  test.skipIf(absent.length > 0)(
    `the ${rows.length} rows that carry a map enumerate without it, every name well-formed`,
    async () => {
      const names = new Set<string>();
      let fans = 0;
      for (const c of rows) {
        // vitest's worker answers its runner over an RPC with a fixed 60 s timeout that the poll
        // phase cannot serve while this loop holds the thread. Yielding once per row lets the reply
        // be read (`setImmediate` runs after poll).
        await new Promise<void>((resolve) => setImmediate(resolve));
        const built = c.build();
        const opts = rankOptionsFor(
          c.toolchain,
          c.codegen,
          built.obj,
          c.sym,
          c.proto,
          c.compile,
          undefined,
          c.contextGlobals,
        );
        let cands: { variations: readonly string[] }[];
        try {
          cands = enumerateRanked(c.sym, scrubObjectHeader(built.asm), c.codegen.target, {
            ...opts,
            onEnumerationError: () => {},
          });
        } catch {
          continue; // a row that declines mints nothing to check
        }
        fans++;
        for (const x of cands) {
          names.add(joinVariations(x.variations));
        }
      }
      // At f9389ba4: 33 rows, 32 fans and 327 distinct names. The floors sit under those, so a
      // selection that silently shrank to a handful of rows does not pass.
      expect(rows.length).toBeGreaterThanOrEqual(30);
      expect(fans).toBeGreaterThan(25);
      expect(names.size).toBeGreaterThan(250);
      expect([...names].flatMap((n) => nameDefect(n) ?? [])).toEqual([]);
    },
    600_000,
  );
});
