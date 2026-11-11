// Every gate table core ships, in one list, with what each reader of that list needs to know.
//
// Two places read it. `test/gate-contract.test.ts` holds every table to the `l3/gates.ts`
// contract: the table is well-formed, and each guard a sound rule names is a test that still
// exists. `apps/benchmark/src/run/gate-census.ts` counts each rule's refusals over a real
// enumeration (`pnpm bench gates --pass <id>`). Both used to keep a hand list of their own, so a
// new table could reach one of them and not the other. Now each reader takes its tables from here.
// `test/gate-registry.test.ts` scans `src/` and fails when a table is exported that this file
// does not list.
//
// NOTHING SHIPPED IMPORTS THIS FILE. Only tests and `apps/benchmark` do. It imports every pass
// module that owns a table, so if a shipped entry imported it, every bundle would load all of
// them. Keep it that way: the CLI bundle must not change when a table is added here.
//
// An entry is the table's export name, the module that exports it (a path under `src/`, with no
// extension; the registry test checks that the module exports that very object), the table, and
// `census` when `pnpm bench gates` can count it. `census.pass` is the census's pass id, and
// `census.table` is the label its report line prints. A table with no `census` has no caller-side
// seam that code outside core can swap. `run/gate-census.ts`'s header says what a seam is.
import { DEAD_READ_GATES } from './frontend/dead-reads';
import { FRAME_ESCAPE_GATES, RELIFT_HAND_BACK_GATES } from './frontend/frame-objects';
import { ADVANCE_HEAD_GATES, ADVANCE_MEMBER_GATES } from './l3/advance';
import { ARGCOPY_GATES, ARGCOPY_REGION_GATES } from './l3/argcopy';
import {
  BASECSE_GATES,
  BASEFOLD_GATES,
  LIVEBASE_BLOCK_GATES,
  LIVEBASE_GATES,
  ORDERBASE_GATES,
  UNFOLDED_GATES,
} from './l3/basecse';
import { CASE_END_GOTO_GATES } from './l3/caseendgoto';
import { ARM_DISJOINT_GATES, COALESCE_GATES } from './l3/coalesce';
import type { Gate } from './l3/gates';
import { HOMESPLIT_FAN_GATES, HOMESPLIT_GATES, withholdingKey } from './l3/homesplit';
import { INLINEBASE_GATES } from './l3/inlinebase';
import { OFFMEMBER_GATES } from './l3/offmember';
import { PTR_FIELD_GATES } from './l3/ptrfield';
import { COUNTDOWN_GATES } from './l3/reindex';
import { REGIONBASE_GATES, SCOPEBASE_ELIGIBILITY, SCOPEBASE_GATES } from './l3/scopebase';
import {
  UNMERGE_ARM_GATES,
  UNMERGE_RUNG_GATES,
  UNMERGE_SITE_GATES,
  UNMERGE_TOTALITY_GATES,
  UNMERGE_VALUE_GATES,
} from './l3/unmerge';
import { UNREDUCE_GATES } from './l3/unreduce';
import { VOL_SLOT_GATES } from './l3/volatileval';
import { VOL_STORE_GATES } from './l3/volstore';
import {
  ADDRESS_GATES,
  ARRAY_SHAPE_GATES,
  DECLARATION_ADDRESS_GATES,
  ELEMENT_ADDRESS_GATES,
  ORDER_LICENCE_GATES,
  ORDER_SHAPE_GATES,
  SHAPE_GATES,
} from './raise/globalshape';
import { EXIT_TRAMPOLINE_GATES, LATCH_GATES } from './raise/latch';
import { MEMBER_ARRAY_GATES } from './raise/memberarrays';
import { NARROW_LOCAL_GATES } from './raise/narrowlocal';
import { OFFSET_NAME_GATES } from './raise/offsetnames';
import { PARAM_READER_WIDTH_GATES, PARAM_WIDTH_GATES } from './raise/paramwidth';
import { REROLL_GATES, TOP_TEST_GATES } from './raise/reroll';
import { FALL_IN_GATES, SELECT_GATES } from './raise/retsink';
import { ARM_REREAD_GATES, SHARED_VALUE_GATES } from './raise/shortcircuit';
import { DISPLACED_BASE_GATES, DISPLACED_ROOT_GATES } from './raise/structs';
import { TRUNC_LOAD_GATES } from './raise/truncload';
import { UNPRE_GATES } from './raise/unpre';
import { UNTHREAD_GATES } from './raise/unthread';
import { CARRIER_NAME_GATES, ENCLOSING_CARRIER_GATES, FRESH_MERGE_GATES } from './structure/carrier-gates';
import { PREUPDATE_COND_GATES, PREUPDATE_SINK_GATES } from './structure/hazards';
import {
  BREAK_TAIL_GATES,
  BYPASS_TAIL_GATES,
  EXIT_TAIL_GATES,
  FOR_BOUND_GATES,
  FOR_PLAN_GATES,
  FOR_PLAN_IV_GATES,
  OUTWARD_EXIT_GATES,
  TWO_LEVEL_BREAK_GATES,
  TWO_LEVEL_EXIT_GATES,
  TWO_LEVEL_REGION_GATES,
} from './structure/loop-gates';
import { NAME_COALESCE_GATES } from './structure/namecoalesce';

/** Where `pnpm bench gates` counts a table: the census pass id, and the label of its line. */
export interface GateCensusSeat {
  readonly pass: string;
  readonly table: string;
}

/** One gate table core ships. */
export interface GateTableEntry {
  /** The export name, or for a `composed` entry a name no export has. */
  readonly name: string;
  /** The module under `src/` that exports it, with no extension (for a `composed` entry, the
   *  module whose function composes it). */
  readonly module: string;
  readonly table: readonly Gate<never>[];
  readonly census?: GateCensusSeat;
  /** The table is built at runtime from another, so no module exports it. The registry test
   *  checks its module and skips the export check. */
  readonly composed?: true;
}

const entry = (name: string, module: string, table: readonly Gate<never>[], census?: GateCensusSeat): GateTableEntry =>
  census ? { name, module, table, census } : { name, module, table };

/** Every gate table, DERIVED tables included. LIVEBASE_GATES is basecse's admission with the
 *  placement heuristics ablated, and LIVEBASE_BLOCK_GATES is that table plus a selectivity rule.
 *  They inherit well-formedness, but listing them keeps this list the one place that answers
 *  "what tables ship?". The order is the contract test's describe order. */
export const GATE_TABLES: readonly GateTableEntry[] = [
  entry('ARGCOPY_GATES', 'l3/argcopy', ARGCOPY_GATES as readonly Gate<never>[]),
  entry('ARGCOPY_REGION_GATES', 'l3/argcopy', ARGCOPY_REGION_GATES as readonly Gate<never>[]),
  entry('COALESCE_GATES', 'l3/coalesce', COALESCE_GATES as readonly Gate<never>[]),
  entry('ARM_DISJOINT_GATES', 'l3/coalesce', ARM_DISJOINT_GATES as readonly Gate<never>[]),
  entry('BASECSE_GATES', 'l3/basecse', BASECSE_GATES as readonly Gate<never>[]),
  entry('BASEFOLD_GATES', 'l3/basecse', BASEFOLD_GATES as readonly Gate<never>[]),
  entry('LIVEBASE_GATES', 'l3/basecse', LIVEBASE_GATES as readonly Gate<never>[]),
  entry('LIVEBASE_BLOCK_GATES', 'l3/basecse', LIVEBASE_BLOCK_GATES as readonly Gate<never>[]),
  entry('UNFOLDED_GATES', 'l3/basecse', UNFOLDED_GATES as readonly Gate<never>[]),
  entry('ORDERBASE_GATES', 'l3/basecse', ORDERBASE_GATES as readonly Gate<never>[]),
  entry('PREUPDATE_SINK_GATES', 'structure/hazards', PREUPDATE_SINK_GATES as readonly Gate<never>[]),
  entry('PREUPDATE_COND_GATES', 'structure/hazards', PREUPDATE_COND_GATES as readonly Gate<never>[]),
  entry('LATCH_GATES', 'raise/latch', LATCH_GATES as readonly Gate<never>[], { pass: 'latchfold', table: 'latch' }),
  entry('EXIT_TRAMPOLINE_GATES', 'raise/latch', EXIT_TRAMPOLINE_GATES as readonly Gate<never>[], {
    pass: 'trampoline',
    table: 'trampoline',
  }),
  entry('REROLL_GATES', 'raise/reroll', REROLL_GATES as readonly Gate<never>[], { pass: 'reroll', table: 'loop' }),
  entry('UNTHREAD_GATES', 'raise/unthread', UNTHREAD_GATES as readonly Gate<never>[], {
    pass: 'unthread',
    table: 'unthread',
  }),
  entry('UNPRE_GATES', 'raise/unpre', UNPRE_GATES as readonly Gate<never>[], { pass: 'unpre', table: 'unpre' }),
  entry('TOP_TEST_GATES', 'raise/reroll', TOP_TEST_GATES as readonly Gate<never>[], { pass: 'reroll', table: 'top' }),
  entry('FALL_IN_GATES', 'raise/retsink', FALL_IN_GATES as readonly Gate<never>[]),
  entry('SELECT_GATES', 'raise/retsink', SELECT_GATES as readonly Gate<never>[]),
  entry('ARM_REREAD_GATES', 'raise/shortcircuit', ARM_REREAD_GATES as readonly Gate<never>[], {
    pass: 'arm-reread',
    table: 'site',
  }),
  entry('SHARED_VALUE_GATES', 'raise/shortcircuit', SHARED_VALUE_GATES as readonly Gate<never>[], {
    pass: 'shared-value',
    table: 'value',
  }),
  entry('TRUNC_LOAD_GATES', 'raise/truncload', TRUNC_LOAD_GATES as readonly Gate<never>[], {
    pass: 'truncload',
    table: 'read',
  }),
  // raise/structs.ts's displaced-access fold: one table per materialised base, one per root
  entry('DISPLACED_BASE_GATES', 'raise/structs', DISPLACED_BASE_GATES as readonly Gate<never>[], {
    pass: 'displaced',
    table: 'base',
  }),
  entry('DISPLACED_ROOT_GATES', 'raise/structs', DISPLACED_ROOT_GATES as readonly Gate<never>[], {
    pass: 'displaced',
    table: 'root',
  }),
  entry('ADDRESS_GATES', 'raise/globalshape', ADDRESS_GATES as readonly Gate<never>[]),
  entry('SHAPE_GATES', 'raise/globalshape', SHAPE_GATES as readonly Gate<never>[]),
  // the two halves `ORDER_LICENCE_GATES` ships — an address table minus the declaration rule, and
  // the shape rules that read the order fact
  entry('ELEMENT_ADDRESS_GATES', 'raise/globalshape', ELEMENT_ADDRESS_GATES as readonly Gate<never>[]),
  entry('DECLARATION_ADDRESS_GATES', 'raise/globalshape', DECLARATION_ADDRESS_GATES as readonly Gate<never>[]),
  entry('ORDER_SHAPE_GATES', 'raise/globalshape', ORDER_SHAPE_GATES as readonly Gate<never>[]),
  entry('MEMBER_ARRAY_GATES', 'raise/memberarrays', MEMBER_ARRAY_GATES as readonly Gate<never>[], {
    pass: 'member-arrays',
    table: 'base',
  }),
  entry('NARROW_LOCAL_GATES', 'raise/narrowlocal', NARROW_LOCAL_GATES as readonly Gate<never>[], {
    pass: 'narrowlocal',
    table: 'carrier',
  }),
  entry('OFFSET_NAME_GATES', 'raise/offsetnames', OFFSET_NAME_GATES as readonly Gate<never>[], {
    pass: 'offsetnames',
    table: 'offset',
  }),
  entry('PARAM_WIDTH_GATES', 'raise/paramwidth', PARAM_WIDTH_GATES as readonly Gate<never>[], {
    pass: 'paramwidth',
    table: 'param',
  }),
  entry('PARAM_READER_WIDTH_GATES', 'raise/paramwidth', PARAM_READER_WIDTH_GATES as readonly Gate<never>[], {
    pass: 'paramwidth',
    table: 'reader',
  }),
  entry('NAME_COALESCE_GATES', 'structure/namecoalesce', NAME_COALESCE_GATES as readonly Gate<never>[]),
  entry('INLINEBASE_GATES', 'l3/inlinebase', INLINEBASE_GATES as readonly Gate<never>[]),
  entry('OFFMEMBER_GATES', 'l3/offmember', OFFMEMBER_GATES as readonly Gate<never>[]),
  entry('VOL_SLOT_GATES', 'l3/volatileval', VOL_SLOT_GATES as readonly Gate<never>[]),
  entry('COUNTDOWN_GATES', 'l3/reindex', COUNTDOWN_GATES as readonly Gate<never>[]),
  entry('VOL_STORE_GATES', 'l3/volstore', VOL_STORE_GATES as readonly Gate<never>[]),
  entry('UNREDUCE_GATES', 'l3/unreduce', UNREDUCE_GATES as readonly Gate<never>[]),
  entry('CASE_END_GOTO_GATES', 'l3/caseendgoto', CASE_END_GOTO_GATES as readonly Gate<never>[], {
    pass: 'case-end-goto',
    table: 'site',
  }),
  // l3/unmerge.ts's five, one per context it judges — see its header for which is which
  entry('UNMERGE_SITE_GATES', 'l3/unmerge', UNMERGE_SITE_GATES as readonly Gate<never>[], {
    pass: 'unmerge',
    table: 'site',
  }),
  entry('UNMERGE_ARM_GATES', 'l3/unmerge', UNMERGE_ARM_GATES as readonly Gate<never>[], {
    pass: 'unmerge',
    table: 'arm',
  }),
  entry('UNMERGE_VALUE_GATES', 'l3/unmerge', UNMERGE_VALUE_GATES as readonly Gate<never>[], {
    pass: 'unmerge',
    table: 'value',
  }),
  entry('UNMERGE_RUNG_GATES', 'l3/unmerge', UNMERGE_RUNG_GATES as readonly Gate<never>[], {
    pass: 'unmerge',
    table: 'rung',
  }),
  entry('UNMERGE_TOTALITY_GATES', 'l3/unmerge', UNMERGE_TOTALITY_GATES as readonly Gate<never>[], {
    pass: 'unmerge',
    table: 'totality',
  }),
  entry('PTR_FIELD_GATES', 'l3/ptrfield', PTR_FIELD_GATES as readonly Gate<never>[]),
  // l3/advance.ts's two: the chain's head, and each successor against the member before it. The
  // same two address rules appear in both, as separate rule objects — a head re-spelled at a
  // second site is wrong for the member table's reason, and gates.ts's header says a second
  // consumer shares the PREDICATE rather than the rule.
  entry('ADVANCE_HEAD_GATES', 'l3/advance', ADVANCE_HEAD_GATES as readonly Gate<never>[]),
  entry('ADVANCE_MEMBER_GATES', 'l3/advance', ADVANCE_MEMBER_GATES as readonly Gate<never>[]),
  entry('FRESH_MERGE_GATES', 'structure/carrier-gates', FRESH_MERGE_GATES as readonly Gate<never>[]),
  entry('CARRIER_NAME_GATES', 'structure/carrier-gates', CARRIER_NAME_GATES as readonly Gate<never>[]),
  entry('ENCLOSING_CARRIER_GATES', 'structure/carrier-gates', ENCLOSING_CARRIER_GATES as readonly Gate<never>[]),
  // structure/exit-arms.ts's `earlyReturnArm`: when an arm writes a copy of a tail the exit path also runs
  entry('EXIT_TAIL_GATES', 'structure/loop-gates', EXIT_TAIL_GATES as readonly Gate<never>[]),
  // ... and when an arm writes a copy of a return tail a path that bypasses the loop also enters
  entry('BYPASS_TAIL_GATES', 'structure/loop-gates', BYPASS_TAIL_GATES as readonly Gate<never>[]),
  // structure.ts's two-level exit: which edge `foreverShape` takes for one, and the two places it
  // is spelled (the loop's region, and the `break` out of a block)
  entry('TWO_LEVEL_EXIT_GATES', 'structure/loop-gates', TWO_LEVEL_EXIT_GATES as readonly Gate<never>[]),
  entry('TWO_LEVEL_REGION_GATES', 'structure/loop-gates', TWO_LEVEL_REGION_GATES as readonly Gate<never>[]),
  entry('TWO_LEVEL_BREAK_GATES', 'structure/loop-gates', TWO_LEVEL_BREAK_GATES as readonly Gate<never>[]),
  // ... and when an edge out of an inner loop's body is that loop's outward exit, handed out
  entry('OUTWARD_EXIT_GATES', 'structure/loop-gates', OUTWARD_EXIT_GATES as readonly Gate<never>[]),
  entry('BREAK_TAIL_GATES', 'structure/loop-gates', BREAK_TAIL_GATES as readonly Gate<never>[]),
  // structure.ts's `forPlanAt`: a `while (1)` read as a `for` past the loop's shape, and the rules
  // over the update's and the init's copies, and over each reading of the latch's test as a compare
  entry('FOR_PLAN_GATES', 'structure/loop-gates', FOR_PLAN_GATES as readonly Gate<never>[]),
  entry('FOR_PLAN_IV_GATES', 'structure/loop-gates', FOR_PLAN_IV_GATES as readonly Gate<never>[]),
  entry('FOR_BOUND_GATES', 'structure/loop-gates', FOR_BOUND_GATES as readonly Gate<never>[]),
  entry('SCOPEBASE_ELIGIBILITY', 'l3/scopebase', SCOPEBASE_ELIGIBILITY as readonly Gate<never>[]),
  entry('SCOPEBASE_GATES', 'l3/scopebase', SCOPEBASE_GATES as readonly Gate<never>[]),
  entry('REGIONBASE_GATES', 'l3/scopebase', REGIONBASE_GATES as readonly Gate<never>[]),
  entry('HOMESPLIT_GATES', 'l3/homesplit', HOMESPLIT_GATES as readonly Gate<never>[]),
  entry('HOMESPLIT_FAN_GATES', 'l3/homesplit', HOMESPLIT_FAN_GATES as readonly Gate<never>[]),
  // A table COMPOSED at runtime — `withholdingKey` prepends its rejection to a caller's own
  // admission, so the shipped table is neither of the two consts. Registered over a representative
  // composition: without it, a `withheld-key` id appearing in the table it wraps is a duplicate
  // nothing checks, and `without()` would then ablate whichever came first.
  {
    name: 'WITHHELD_KEY_OVER_LIVEBASE_BLOCK',
    module: 'l3/homesplit',
    table: withholdingKey(LIVEBASE_BLOCK_GATES, 'c:0 4 true') as readonly Gate<never>[],
    composed: true,
  },
  // frontend/frame-objects.ts: the retractions an escaped frame address costs
  entry('FRAME_ESCAPE_GATES', 'frontend/frame-objects', FRAME_ESCAPE_GATES as readonly Gate<never>[], {
    pass: 'frame-objects',
    table: 'escape',
  }),
  // frontend/frame-objects.ts: what keeps a frame's end word in the one object
  entry('RELIFT_HAND_BACK_GATES', 'frontend/frame-objects', RELIFT_HAND_BACK_GATES as readonly Gate<never>[], {
    pass: 'frame-objects',
    table: 'relift',
  }),
  // frontend/dead-reads.ts: the dead reads the lift must not stamp `volatile`
  entry('DEAD_READ_GATES', 'frontend/dead-reads', DEAD_READ_GATES as readonly Gate<never>[]),
];

/** An exported `*_GATES` const that is not itself a table but a record of tables, each of which
 *  `GATE_TABLES` lists under its own name. The contract holds through the parts. */
export interface GateTableBundle {
  readonly name: string;
  readonly module: string;
  readonly bundle: Readonly<Record<string, readonly Gate<never>[]>>;
  /** For each key of `bundle`, the `GATE_TABLES` name of the table it holds. */
  readonly parts: Readonly<Record<string, string>>;
}

export const GATE_TABLE_BUNDLES: readonly GateTableBundle[] = [
  // raise/globalshape.ts's `ArrayShapeGates`: what `recognizeArrays` reads by default, and the
  // `/order` licence
  {
    name: 'ARRAY_SHAPE_GATES',
    module: 'raise/globalshape',
    bundle: ARRAY_SHAPE_GATES as unknown as GateTableBundle['bundle'],
    parts: { address: 'ADDRESS_GATES', shape: 'SHAPE_GATES' },
  },
  {
    name: 'ORDER_LICENCE_GATES',
    module: 'raise/globalshape',
    bundle: ORDER_LICENCE_GATES as unknown as GateTableBundle['bundle'],
    parts: { address: 'ELEMENT_ADDRESS_GATES', shape: 'ORDER_SHAPE_GATES' },
  },
];
