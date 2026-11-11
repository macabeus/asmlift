// `pnpm bench gates --pass <id>` — the per-id refusal census of an `l3/gates.ts` table, taken off
// a REAL enumeration, with nothing to edit and nothing to revert.
//
// WHY A SUBCOMMAND AND NOT A DOCUMENTED SCRIPT. `tallying()` (packages/core/src/l3/gates.ts) wraps
// a table so a caller outside core counts each rule's refusals, and that is the whole API — but a
// tabled pass's only shipped caller is inside core, and nothing exports a corpus of lifted trees.
// So the census is taken off `enumerateRanked` with the pass's caller-side entry SWAPPED — which a
// round can do from a script of its own, at three hazards this file does not have:
//
//   - the script has to live somewhere the workspace resolves BOTH `@asmlift/core/*` and
//     `@asmlift/cli/*`, which is neither the repo root (`@asmlift/core` is not a root dependency — measured:
//     `ERR_MODULE_NOT_FOUND`) nor outside the repo (`@asmlift/cli/rank` is not resolvable there);
//   - an untracked script is CODE to `apps/benchmark/src/provenance.ts` (only `.claude/commands/`
//     is exempt), so forgetting to delete it stamps the next `bench run` dirty and `bench:merge`
//     refuses the result — after ~2,000 s;
//   - the swap must hit the module instance the enumeration imports, and a standalone script that
//     loads an ESM/CJS duplicate censuses ZERO, silently — which reads exactly like "this rule
//     never fires", the conclusion a census exists to license.
//
// A subcommand has none of the three by construction, and `cli.ts`'s own header is binding here:
// "Every path the harness offers is a subcommand here — there are no other executable scripts."
//
// WHAT PUTS A PASS IN THE REGISTRY BELOW. Taking the gate table as a parameter is necessary and
// NOT sufficient — `git grep -lE "gates\??: readonly Gate<" packages/core/src` lists the files
// that do, and carrying the count here instead would be the smallest possible copy of that list.
// The census also needs a CALLER-SIDE SEAM a process outside core can reach: a MUTABLE RECORD
// holding the call. Fifteen passes have one — `unmergeJoins` and `jumpToCaseEnds` in `rank-variations.ts`'s `PRE_RESPELL_VARIATIONS`, six passes in
// `raise/pre-recovery.ts`'s `PRE_RECOVERY_PASSES`: the branch short-circuit fold (this registry's
// `arm-reread` and `shared-value`, one entry per table), `truncload`, `member-arrays`, `narrowlocal`, `paramwidth` and `displaced`, the five folds
// in `raise/pre-structure.ts`'s `PRE_STRUCTURE_FOLDS` (`latchfold`, `trampoline`, `unthread`, `reroll`, `unpre`), whose
// entries a script outside core swaps and the driver then calls, and `nameOffsetAddresses` and the
// frame-object audit, whose records stand alone (`OFFSET_NAME_PASS`,
// `FRAME_OBJECT_AUDIT`) because each has one seat rather than a position in a list. A
// LIST is not what makes a pass censusable; a record is. Being in `raise/` is not the seam either —
// `raise/retsink.ts` is not in any of them — and a pass reached through a static import binding has
// none, because the binding is a read-only module-namespace property — measured, not argued:
//
//     import * as retsink from '@asmlift/core/raise/retsink';
//     retsink.sinkReturns = () => false;
//     → TypeError: Cannot assign to read only property 'sinkReturns' of object '[object Module]'
//
// So a further pass with a seam costs a driver here, and any other pass first costs the seam its
// caller does not have yet. WHICH TABLES a pass counts, and the label each line prints, are not
// kept here: each table's `census` seat in `packages/core/src/gate-registry.ts` names them, the
// same list the contract test iterates, and `PASSES` is built from it below. A driver only says
// the order its `install` reads them in. A table seated in the registry under a pass with no
// driver, or a driver whose labels the registry does not seat, throws when this module loads.
// `enumerateRanked` is
// deliberately the only driver: it is the same entry `bench fan` and the runner use, so a census
// here counts the refusals the BENCHMARK'S configuration produced rather than a rig's.
import { enumerateRanked } from '@asmlift/cli/rank';
import {
  FRAME_OBJECT_AUDIT,
  type FrameEscape,
  type HandBack,
  auditFrameObjects,
} from '@asmlift/core/frontend/frame-objects';
import { GATE_TABLES } from '@asmlift/core/gate-registry';
import type { Fn } from '@asmlift/core/ir/core';
import { type CaseEndSite, jumpToCaseEnds } from '@asmlift/core/l3/caseendgoto';
import type { Gate } from '@asmlift/core/l3/gates';
import { tallying } from '@asmlift/core/l3/gates';
import type { UnmergeGates } from '@asmlift/core/l3/unmerge';
import { unmergeJoins } from '@asmlift/core/l3/unmerge';
import { declaresVoidReturn } from '@asmlift/core/proto';
import {
  type ExitTrampoline,
  type LatchCandidate,
  foldEmptyLatches,
  foldExitTrampolines,
} from '@asmlift/core/raise/latch';
import { type MemberArrayCandidate, recognizeMemberArrays } from '@asmlift/core/raise/memberarrays';
import { type NarrowLocalCandidate, narrowBlockLocals } from '@asmlift/core/raise/narrowlocal';
import { OFFSET_NAME_PASS, type OffsetAddress, nameOffsetAddresses } from '@asmlift/core/raise/offsetnames';
import type { NarrowParamCandidate } from '@asmlift/core/raise/paramwidth';
import { PRE_RECOVERY_PASSES, narrowParamWidths } from '@asmlift/core/raise/pre-recovery';
import { PRE_STRUCTURE_FOLDS } from '@asmlift/core/raise/pre-structure';
import { type FoldedTopTest, type PeeledTest, rerollPeeledTests } from '@asmlift/core/raise/reroll';
import type { ArmRereadSite, SharedValueSite } from '@asmlift/core/raise/shortcircuit';
import { type DisplacedBase, type DisplacedRoot, foldDisplacedAccesses } from '@asmlift/core/raise/structs';
import { type TruncatedLoad, foldTruncatedLoads } from '@asmlift/core/raise/truncload';
import { type RedundantParam, recomputeRedundantParams } from '@asmlift/core/raise/unpre';
import { type ThreadedExit, unthreadLoopExits } from '@asmlift/core/raise/unthread';
import { PRE_RESPELL_VARIATIONS } from '@asmlift/core/rank-variations';

import { scrubObjectHeader } from '../asm-scrub';
import { StaleCalleeBodies } from '../cases/callee-bodies';
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

/** A pass's driver: the labels of the tables its `install` reads, in the order it reads them
 *  (`w[0]` is the first label's table). The tables themselves come from the registry. */
interface CensusDriver {
  readonly tables: readonly string[];
  readonly install: CensusablePass['install'];
}

/** Swap a `PRE_STRUCTURE_FOLDS` entry's call for one through the census's tables, BY ID. */
function installFold(id: string, run: (fn: Fn) => number): () => void {
  const fold = PRE_STRUCTURE_FOLDS.find((f) => f.id === id);
  if (!fold) {
    throw new Error(`no PRE_STRUCTURE_FOLDS entry '${id}' — the fold's caller-side seam moved`);
  }
  const restore = fold.run;
  fold.run = run;
  return () => {
    fold.run = restore;
  };
}

const DRIVERS: Record<string, CensusDriver> = {
  unmerge: {
    // The five tables in `UnmergeGates`' own order, which is the order `l3/unmerge.ts` documents
    // them in — SITE, ARM, VALUE, RUNG, then the TOTALITY table that judges the rewritten site.
    tables: ['site', 'arm', 'value', 'rung', 'totality'],
    install: (w) => {
      // BY NAME, never by index. `PRE_RESPELL_VARIATIONS` holds one entry today, and a census taken
      // through the wrong one enumerates normally and reports an EMPTY table — the silent-zero
      // failure this file's header names, arriving by a second route.
      const unmergeVariation = PRE_RESPELL_VARIATIONS.find((p) => p.name === 'unmerge');
      if (!unmergeVariation) {
        throw new Error("no PRE_RESPELL_VARIATIONS entry 'unmerge' — the pass's caller-side seam moved");
      }
      const restore = unmergeVariation.apply;
      const gates: UnmergeGates = {
        site: w[0] as UnmergeGates['site'],
        arm: w[1] as UnmergeGates['arm'],
        value: w[2] as UnmergeGates['value'],
        rung: w[3] as UnmergeGates['rung'],
        totality: w[4] as UnmergeGates['totality'],
      };
      unmergeVariation.apply = (s) => unmergeJoins(s, gates);
      return () => {
        unmergeVariation.apply = restore;
      };
    },
  },
  'case-end-goto': {
    // l3/caseendgoto.ts's `CASE_END_GOTO_GATES` — which rule keeps a search loop's hit flag rather
    // than the case-end goto. ONE table, asked once per flag read after its loop, per structured
    // tree the enumeration respells.
    tables: ['site'],
    install: (w) => {
      // BY NAME, never by index, for the reason the `unmerge` entry gives.
      const entry = PRE_RESPELL_VARIATIONS.find((p) => p.name === 'case-end-goto');
      if (!entry) {
        throw new Error("no PRE_RESPELL_VARIATIONS entry 'case-end-goto' — the pass's caller-side seam moved");
      }
      const restore = entry.apply;
      entry.apply = (s) => jumpToCaseEnds(s, w[0] as readonly Gate<CaseEndSite>[]);
      return () => {
        entry.apply = restore;
      };
    },
  },
  'arm-reread': {
    // raise/shortcircuit.ts's `ARM_REREAD_GATES` — the branch fold's re-read admission. ONE table,
    // asked only at a site where nothing cheaper refused (below `sameArgs` and the negatability
    // check). The pass list runs once per LIFT, and `enumerateRanked` lifts a row more than once
    // (the shared lift, then each lift), so a count here is per evaluation, as the footer
    // says, and a site can be counted once per lift that reaches it.
    tables: ['site'],
    install: (w) => {
      // BY ID, never by index, for the reason the `unmerge` entry gives.
      const pass = PRE_RECOVERY_PASSES.find((p) => p.id === 'branch-shortcircuit');
      if (!pass) {
        throw new Error("no PRE_RECOVERY_PASSES entry 'branch-shortcircuit' — the pass's caller-side seam moved");
      }
      const restore = pass.run;
      const armReread = w[0] as readonly Gate<ArmRereadSite>[];
      pass.run = (fn, self, opts, target, lifted) =>
        restore(fn, self, { ...opts, shortCircuit: { ...opts.shortCircuit, armReread } }, target, lifted);
      return () => {
        pass.run = restore;
      };
    },
  },
  'shared-value': {
    // raise/shortcircuit.ts's `SHARED_VALUE_GATES` — the same fold's use-count refusals, asked once
    // per value the second condition block reads 2+ times itself, below every refusal but tree
    // ownership. Same seam and same per-lift counting as `arm-reread` above.
    tables: ['value'],
    install: (w) => {
      // BY ID, never by index, for the reason the `unmerge` entry gives.
      const pass = PRE_RECOVERY_PASSES.find((p) => p.id === 'branch-shortcircuit');
      if (!pass) {
        throw new Error("no PRE_RECOVERY_PASSES entry 'branch-shortcircuit' — the pass's caller-side seam moved");
      }
      const restore = pass.run;
      const sharedValue = w[0] as readonly Gate<SharedValueSite>[];
      pass.run = (fn, self, opts, target, lifted) =>
        restore(fn, self, { ...opts, shortCircuit: { ...opts.shortCircuit, sharedValue } }, target, lifted);
      return () => {
        pass.run = restore;
      };
    },
  },
  truncload: {
    // raise/truncload.ts's `TRUNC_LOAD_GATES` — which narrow reads may become a cast of a wider
    // one. ONE table, asked once per narrow load a strictly wider access at the same base already
    // covers, so a base with no overlap contributes nothing and the count is a population of
    // OVERLAPS rather than of loads.
    tables: ['read'],
    install: (w) => {
      // BY ID, never by index, for the reason the `unmerge` entry gives.
      const pass = PRE_RECOVERY_PASSES.find((p) => p.id === 'truncload');
      if (!pass) {
        throw new Error("no PRE_RECOVERY_PASSES entry 'truncload' — the pass's caller-side seam moved");
      }
      const gates = w[0] as readonly Gate<TruncatedLoad>[];
      const restore = pass.run;
      pass.run = (fn, _self, _opts, target) =>
        foldTruncatedLoads(fn, target.capabilities.endianness === 'little', gates);
      return () => {
        pass.run = restore;
      };
    },
  },
  displaced: {
    // raise/structs.ts's two tables for the displaced-access fold: `DISPLACED_BASE_GATES`, asked
    // once per materialised base `add(p, K)` that carries a constant-offset access, and
    // `DISPLACED_ROOT_GATES`, asked once per root over the bases that passed. On every lift that
    // reaches the pass, `/far-cast`'s included, which skips a base carrying a store before either
    // table sees it.
    tables: ['base', 'root'],
    install: (w) => {
      // BY ID, never by index, for the reason the `unmerge` entry gives.
      const pass = PRE_RECOVERY_PASSES.find((p) => p.id === 'displaced');
      if (!pass) {
        throw new Error("no PRE_RECOVERY_PASSES entry 'displaced' — the pass's caller-side seam moved");
      }
      const base = w[0] as readonly Gate<DisplacedBase>[];
      const root = w[1] as readonly Gate<DisplacedRoot>[];
      const restore = pass.run;
      pass.run = (fn, self, opts, target) =>
        foldDisplacedAccesses(fn, opts.displaced, target.compilerBehaviors, declaresVoidReturn(self), base, root);
      return () => {
        pass.run = restore;
      };
    },
  },
  paramwidth: {
    // raise/paramwidth.ts's two tables: `PARAM_WIDTH_GATES`, which entry parameters take the width
    // of their prologue extension, asked once per extension of an entry parameter in the entry
    // block, so a parameter read through two extensions is counted twice; and `/narrow-param`'s
    // `PARAM_READER_WIDTH_GATES`, asked once per parameter some extension reads, on the lift that
    // asks whether the variation reaches as well as on its own. Both once per lift that reaches them.
    tables: ['param', 'reader'],
    install: (w) => {
      // BY ID, never by index, for the reason the `unmerge` entry gives.
      const pass = PRE_RECOVERY_PASSES.find((p) => p.id === 'paramwidth');
      if (!pass) {
        throw new Error("no PRE_RECOVERY_PASSES entry 'paramwidth' — the pass's caller-side seam moved");
      }
      const prologue = w[0] as readonly Gate<NarrowParamCandidate>[];
      const reader = w[1] as readonly Gate<NarrowParamCandidate>[];
      const restore = pass.run;
      pass.run = (fn, self, opts, target, lifted) =>
        narrowParamWidths(fn, self, opts.paramWidth, target, lifted, prologue, reader);
      return () => {
        pass.run = restore;
      };
    },
  },
  offsetnames: {
    // raise/offsetnames.ts's `OFFSET_NAME_GATES` — which walked-to addresses the symbol map is
    // allowed to name. ONE table, asked once per site the walk resolves, and a site is only built
    // where the address already bottoms out at a `gaddr` plus a non-zero constant, so the rows with
    // no symbol map and the rows whose arithmetic stands on a parameter contribute nothing.
    tables: ['offset'],
    install: (w) => {
      const restore = OFFSET_NAME_PASS.run;
      const gates = w[0] as readonly Gate<OffsetAddress>[];
      OFFSET_NAME_PASS.run = (fn, symbols, behaviors) => nameOffsetAddresses(fn, symbols, behaviors, gates);
      return () => {
        OFFSET_NAME_PASS.run = restore;
      };
    },
  },
  latchfold: {
    // raise/latch.ts's `LATCH_GATES` — which back-edge blocks fold into their edge. Asked once per block
    // with one successor, on every round of the fold's fixpoint, so a block refused twice counts twice.
    tables: ['latch'],
    install: (w) => installFold('latchfold', (fn) => foldEmptyLatches(fn, w[0] as readonly Gate<LatchCandidate>[])),
  },
  trampoline: {
    // raise/latch.ts's `EXIT_TRAMPOLINE_GATES` — which blocks on a loop's way out fold into their edge.
    // Asked once per block with a successor, on every round of the fold's fixpoint, so most counts
    // are blocks that were never trampolines (`trampoline-not-a-second-exit`).
    tables: ['trampoline'],
    install: (w) => installFold('trampoline', (fn) => foldExitTrampolines(fn, w[0] as readonly Gate<ExitTrampoline>[])),
  },
  unthread: {
    // raise/unthread.ts's `UNTHREAD_GATES` — which jump-threaded loop exits go back to the re-test they
    // skipped. Asked once per (exit edge, other exit target, arg proposal) whose shape admits one — the
    // target ends in a `cond_br`, or in a `br` to an out-of-loop block that does (gcc2.7.2's forwarder
    // in front of the re-test, `retestOf`), and each of its params has a value, handed it by an
    // in-loop edge, that is defined at the exit — until one is admitted, on every round.
    tables: ['unthread'],
    install: (w) => installFold('unthread', (fn) => unthreadLoopExits(fn, w[0] as readonly Gate<ThreadedExit>[])),
  },
  reroll: {
    // raise/reroll.ts's `REROLL_GATES` — which loops with a peeled entry test rotate back. Asked once per
    // loop whose SHAPE admits a re-roll (the untabled residue its header names), per round. Then
    // `TOP_TEST_GATES`, once per rotated loop whose shape `restoreTopTest` reads: does its top test
    // come back.
    tables: ['loop', 'top'],
    install: (w) =>
      installFold('reroll', (fn) =>
        rerollPeeledTests(fn, w[0] as readonly Gate<PeeledTest>[], w[1] as readonly Gate<FoldedTopTest>[]),
      ),
  },
  unpre: {
    // raise/unpre.ts's `UNPRE_GATES` — the scope of the parameter recompute. Asked once per block
    // parameter the fold's precondition admits (every in-edge hands one pure expression over
    // dominating leaves), per sweep.
    tables: ['unpre'],
    install: (w) => installFold('unpre', (fn) => recomputeRedundantParams(fn, w[0] as readonly Gate<RedundantParam>[])),
  },
  'member-arrays': {
    // raise/memberarrays.ts's `MEMBER_ARRAY_GATES` — which bases read as a struct whose member is an
    // array. ONE table, asked once per base group the candidate walk builds, per lift that
    // reaches the pass.
    tables: ['base'],
    install: (w) => {
      // BY ID, never by index, for the reason the `unmerge` entry gives.
      const pass = PRE_RECOVERY_PASSES.find((p) => p.id === 'member-arrays');
      if (!pass) {
        throw new Error("no PRE_RECOVERY_PASSES entry 'member-arrays' — the pass's caller-side seam moved");
      }
      const gates = w[0] as readonly Gate<MemberArrayCandidate>[];
      const restore = pass.run;
      pass.run = (fn) => recognizeMemberArrays(fn, gates);
      return () => {
        pass.run = restore;
      };
    },
  },
  narrowlocal: {
    // raise/narrowlocal.ts's `NARROW_LOCAL_GATES` — which block parameters take the width of their
    // sole reading extension. ONE table, asked once per carrier the candidate walk builds, per
    // lift that reaches the pass. The swapped call is the entry's own, with the table passed
    // where the entry leaves the default.
    tables: ['carrier'],
    install: (w) => {
      // BY ID, never by index, for the reason the `unmerge` entry gives.
      const pass = PRE_RECOVERY_PASSES.find((p) => p.id === 'narrowlocal');
      if (!pass) {
        throw new Error("no PRE_RECOVERY_PASSES entry 'narrowlocal' — the pass's caller-side seam moved");
      }
      const gates = w[0] as readonly Gate<NarrowLocalCandidate>[];
      const restore = pass.run;
      pass.run = (fn, _self, _opts, target, lifted) =>
        narrowBlockLocals(
          fn,
          gates,
          { hoistsSingleSetArm: target.compilerBehaviors.hoistsSingleSetArm },
          lifted.mergeShapes,
        );
      return () => {
        pass.run = restore;
      };
    },
  },
  'frame-objects': {
    // frontend/frame-objects.ts's `FRAME_ESCAPE_GATES` — what an escaped frame address retracts.
    // Asked once per escape in a lift that reaches it, rule-major, and the first rejection
    // DECLINES the lift, so a row contributes at most one count per lift. And
    // `RELIFT_HAND_BACK_GATES`, once per end word a first audit asks to hand back to the slot
    // model, where the first rejection keeps that word in the one object.
    tables: ['escape', 'relift'],
    install: (w) => {
      const restore = FRAME_OBJECT_AUDIT.run;
      const gates = w[0] as readonly Gate<FrameEscape>[];
      const reliftGates = w[1] as readonly Gate<HandBack>[];
      FRAME_OBJECT_AUDIT.run = (audit) => auditFrameObjects({ ...audit, gates, reliftGates });
      return () => {
        FRAME_OBJECT_AUDIT.run = restore;
      };
    },
  },
};

/** Each driver with its tables, taken from the registry's census seats in the driver's order. */
function censusablePasses(): Record<string, CensusablePass> {
  const seated = new Map<string, Map<string, readonly Gate<never>[]>>();
  for (const t of GATE_TABLES) {
    if (!t.census) {
      continue;
    }
    if (!(t.census.pass in DRIVERS)) {
      throw new Error(
        `gate-registry seats ${t.name} in census pass '${t.census.pass}', which has no driver in run/gate-census.ts`,
      );
    }
    const tables = seated.get(t.census.pass) ?? new Map<string, readonly Gate<never>[]>();
    tables.set(t.census.table, t.table);
    seated.set(t.census.pass, tables);
  }
  return Object.fromEntries(
    Object.entries(DRIVERS).map(([id, d]) => {
      const tables = seated.get(id) ?? new Map<string, readonly Gate<never>[]>();
      const labels = [...tables.keys()].sort();
      if (labels.join() !== [...d.tables].sort().join()) {
        throw new Error(
          `census pass '${id}' reads tables [${d.tables.join(', ')}] but gate-registry seats [${labels.join(', ')}]`,
        );
      }
      return [id, { tables: d.tables.map((l) => [l, tables.get(l)!] as const), install: d.install }];
    }),
  );
}

export const PASSES: Record<string, CensusablePass> = censusablePasses();

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
 *  `bench fan` uses, which matches a SUBSTRING of the row id — so a bare symbol selects every
 *  toolchain that spec targets and pools their counts, and `--toolchain` does not apply on this
 *  path. Name the full `tier:sym:toolchain` id for one row. Without `--only` the population is the
 *  synthetic tier for one toolchain, which is where a corpus-wide count is affordable (the real
 *  tier needs project checkouts and prices the same question in tens of minutes). */
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
      // A STALE VENDORING is not such a gap and is rethrown: `selectCalleeBodies` refuses a row whose
      // lift asks a callee body the vendored file never froze, and counting that as "did not lift"
      // would report a harness input older than its rule as a decompiler lift gap.
      try {
        const built = c.build();
        const asm = scrubObjectHeader(built.asm);
        const vendored = c.calleeBodies?.();
        enumerateRanked(
          c.sym,
          asm,
          c.codegen.target,
          rankOptionsFor(
            c.toolchain,
            c.codegen,
            built.obj,
            c.sym,
            c.proto,
            c.compile,
            c.symbols,
            c.contextGlobals,
            vendored && { asm, vendored },
          ),
        );
      } catch (e) {
        if (e instanceof StaleCalleeBodies) {
          throw e;
        }
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
