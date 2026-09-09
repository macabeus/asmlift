// `pnpm bench gates --pass <id>` — the per-id refusal census of an `l3/gates.ts` table, taken off
// a REAL enumeration, with nothing to edit and nothing to revert.
//
// WHY A SUBCOMMAND AND NOT A DOCUMENTED SCRIPT. `tallying()` (packages/core/src/l3/gates.ts) wraps
// a table so a caller outside core counts each rule's refusals, and that is the whole API — but a
// tabled pass's only shipped caller is inside core, and nothing exports a corpus of lifted trees.
// So the census is taken off `enumerateRanked` with the pass's caller-side entry SWAPPED, and for
// a while this file's contents were a ~20-line recipe in `tallying`'s doc comment for a round to
// copy. That recipe carried three hazards, all of them artifacts of being a script:
//
//   - it had to live somewhere the workspace resolves BOTH `@asmlift/core/*` and `@asmlift/cli/*`,
//     which is neither the repo root (`@asmlift/core` is not a root dependency — measured:
//     `ERR_MODULE_NOT_FOUND`) nor outside the repo (`@asmlift/cli/rank` is not resolvable there);
//   - an untracked script is CODE to `apps/benchmark/src/provenance.ts` (only `.claude/commands/`
//     is exempt), so forgetting to delete it stamps the next `bench run` dirty and `bench:merge`
//     refuses the result — after ~2,000 s. That trap has cost two rounds a full run each;
//   - the swap must hit the module instance the enumeration imports, and a standalone script that
//     loads an ESM/CJS duplicate censuses ZERO, silently — which reads exactly like "this rule
//     never fires", the conclusion a census exists to license.
//
// A subcommand has none of the three by construction, and `cli.ts`'s own header is binding here:
// "Every path the harness offers is a subcommand here — there are no other executable scripts."
//
// WHY THE REGISTRY BELOW HAS ONE ENTRY, and why that is not a bar this file failed to clear.
// Fifteen passes in `packages/core/src` take their gate table as an optional parameter, and a
// wave-2 review read that as fifteen inhabitants waiting for this command. It is not: taking the
// table as a parameter is necessary and NOT sufficient. The census needs a CALLER-SIDE SEAM a
// process outside core can reach, and `unmergeJoins` has one only because `rank-axes.ts` holds it
// in `PRE_FAN_PRODUCTS`, a mutable array of records. The other fourteen are reached through static
// import bindings, which are read-only module-namespace properties — measured, not argued:
//
//     import * as retsink from '@asmlift/core/raise/retsink';
//     retsink.sinkReturns = () => false;
//     → TypeError: Cannot assign to read only property 'sinkReturns' of object '[object Module]'
//
// So a second entry costs whatever seam that pass's caller does not have yet, and the registry is
// the place that will say so. `enumerateRanked` is deliberately the only driver: it is the same
// entry `bench fan` and the runner use, so a census here counts the refusals the BENCHMARK'S
// configuration produced rather than a rig's.
import { enumerateRanked } from '@asmlift/cli/rank';
import type { Gate } from '@asmlift/core/l3/gates';
import { tallying } from '@asmlift/core/l3/gates';
import type { UnmergeGates } from '@asmlift/core/l3/unmerge';
import {
  UNMERGE_ARM_GATES,
  UNMERGE_RUNG_GATES,
  UNMERGE_SITE_GATES,
  UNMERGE_TOTALITY_GATES,
  UNMERGE_VALUE_GATES,
  unmergeJoins,
} from '@asmlift/core/l3/unmerge';
import { PRE_FAN_PRODUCTS } from '@asmlift/core/rank-axes';

import { scrubObjectHeader } from '../asm-scrub';
import { realCases } from '../cases/real';
import { syntheticCases } from '../cases/synthetic';
import type { Case } from '../cases/types';
import { rankOptionsFor } from '../eval/asmlift';
import type { ToolchainId } from '../toolchains';
import { TOOLCHAINS } from '../toolchains';
import { selectCases } from './fan';

/** One censusable pass: the tables it judges at, and how to put a wrapped set of them in front of
 *  the enumeration. `install` returns the undo, so a throw anywhere leaves the process's module
 *  state as it found it. */
interface CensusablePass {
  readonly tables: readonly (readonly [string, readonly Gate<never>[]])[];
  readonly install: (wrapped: readonly (readonly Gate<never>[])[]) => () => void;
}

export const PASSES: Record<string, CensusablePass> = {
  unmerge: {
    // The five tables in `UnmergeGates`' own order, which is the order `l3/unmerge.ts` documents
    // them in — SITE, ARM, VALUE, RUNG, then the TOTALITY table that judges the rewritten site.
    tables: [
      ['site', UNMERGE_SITE_GATES as readonly Gate<never>[]],
      ['arm', UNMERGE_ARM_GATES as readonly Gate<never>[]],
      ['value', UNMERGE_VALUE_GATES as readonly Gate<never>[]],
      ['rung', UNMERGE_RUNG_GATES as readonly Gate<never>[]],
      ['totality', UNMERGE_TOTALITY_GATES as readonly Gate<never>[]],
    ],
    install: (w) => {
      // BY SUFFIX, never by index. `PRE_FAN_PRODUCTS` holds one entry today, and a census taken
      // through the wrong one enumerates normally and reports an EMPTY table — the silent-zero
      // failure this file's header names, arriving by a second route.
      const product = PRE_FAN_PRODUCTS.find((p) => p.suffix === '/unmerge');
      if (!product) {
        throw new Error("no PRE_FAN_PRODUCTS entry '/unmerge' — the pass's caller-side seam moved");
      }
      const restore = product.apply;
      const gates: UnmergeGates = {
        site: w[0] as UnmergeGates['site'],
        arm: w[1] as UnmergeGates['arm'],
        value: w[2] as UnmergeGates['value'],
        rung: w[3] as UnmergeGates['rung'],
        totality: w[4] as UnmergeGates['totality'],
      };
      product.apply = (s) => unmergeJoins(s, gates);
      return () => {
        product.apply = restore;
      };
    },
  },
};

export const CENSUSABLE_PASSES = Object.keys(PASSES);

export interface GateCensusOptions {
  readonly pass: string;
  readonly only?: string;
  readonly toolchain?: string;
}

function note(s: string): void {
  console.error(s);
}

/** The rows this census runs over. `--only` reaches BOTH tiers through the same selector
 *  `bench fan` uses, so a real row is censusable one row at a time; without it the population is
 *  the synthetic tier for one toolchain, which is where a corpus-wide count is affordable (the
 *  real tier needs project checkouts and prices the same question in tens of minutes). */
function population(o: GateCensusOptions): { cases: Case[]; what: string } {
  if (o.only) {
    return { cases: selectCases([...syntheticCases(), ...realCases()], o.only), what: `--only ${o.only}` };
  }
  const toolchain = (o.toolchain ?? 'agbcc') as ToolchainId;
  if (!(toolchain in TOOLCHAINS)) {
    return { cases: [], what: `unknown toolchain ${toolchain}` };
  }
  return { cases: syntheticCases({ toolchain }), what: `synthetic tier, toolchain ${toolchain}` };
}

export function gateCensus(o: GateCensusOptions): number {
  const pass = PASSES[o.pass];
  if (!pass) {
    note(`no censusable pass ${JSON.stringify(o.pass)} — have: ${CENSUSABLE_PASSES.join(', ')}`);
    note(
      'a pass is censusable once its caller-side seam is reachable from outside core — see the header of run/gate-census.ts',
    );
    return 2;
  }
  const { cases, what } = population(o);
  if (cases.length === 0) {
    note(`no rows selected (${what})`);
    return 2;
  }
  const wrapped = pass.tables.map(([, t]) => tallying(t));
  const uninstall = pass.install(wrapped.map((w) => w.gates));
  let rows = 0;
  let unlifted = 0;
  try {
    for (const c of cases) {
      if (!c.toolchain.available()) {
        continue;
      }
      rows++;
      // GUARDED, for the reason `run/fan.ts`'s own `enumerateRanked` call is: `enumerateCandidates`
      // has no annotate mode, so a row the frontend cannot lift is a THROW here, and hundreds of
      // corpus rows publish `declined` on exactly such a gap. Unguarded, the FIRST of them ends the
      // census before it prints anything — the defect that made the documented recipe unrunnable.
      // Counted rather than swallowed: a census over a truncated prefix must not look complete.
      try {
        const { obj, asm } = c.build();
        enumerateRanked(
          c.sym,
          scrubObjectHeader(asm),
          c.toolchain.targetDesc,
          rankOptionsFor(c.toolchain, obj, c.proto, c.compile, c.symbols),
        );
      } catch {
        unlifted++;
      }
    }
  } finally {
    uninstall();
  }
  console.log(`asmlift: [gates] ${o.pass} over ${rows} row(s) — ${what}`);
  for (const [i, [name]] of pass.tables.entries()) {
    const counts = wrapped[i].refusals();
    console.log(
      `asmlift: [gates] ${name}: ${counts.length === 0 ? '(never fired)' : counts.map(([id, n]) => `${id} ${n}`).join(', ')}`,
    );
  }
  // WHAT THIS COUNTS IS AN EVALUATION THAT ANSWERED TRUE, not a site, and under `firstRejection`
  // that is the FIRST rejecter — so a rule absent from a table's line is STARVED or REDUNDANT WITH
  // AN EARLIER ONE, and telling those apart takes the same rule run with the rest of the table
  // empty (`grep -n "ON ITS OWN" packages/core/src/raise/globalshape.ts`).
  console.log(`asmlift: [gates] ${unlifted} row(s) did not lift (counted, not censused); first rejecter only`);
  return 0;
}
