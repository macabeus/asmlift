// asmlift — the admission tables a variation's definition names, so a reader sees the rules
// enumeration applies rather than a paraphrase of them.
//
// A `VariationDefinition.offeredWhen` names a table by its key here, and the drawer renders each
// table's own `why` strings. The key IS the exported binding's name (object shorthand), and
// `packages/core/test/variation-offers.test.ts` holds each key to the export of that name in the
// file the definition's `implementedIn` names.
//
// Kept apart from `variation-definitions.ts`, which stays pure data: that module takes only the
// TYPE of a key, so a consumer reading a title or a summary does not load the passes.
import { ADVANCE_HEAD_GATES, ADVANCE_MEMBER_GATES } from './l3/advance';
import { BASEFOLD_GATES, LIVEBASE_BLOCK_GATES, LIVEBASE_GATES, ORDERBASE_GATES, UNFOLDED_GATES } from './l3/basecse';
import { ARM_DISJOINT_GATES, COALESCE_GATES } from './l3/coalesce';
import type { Gate } from './l3/gates';
import { HOMESPLIT_FAN_GATES, HOMESPLIT_GATES } from './l3/homesplit';
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
import { ARM_REREAD_GATES } from './raise/shortcircuit';
import { NAME_COALESCE_GATES } from './structure/namecoalesce';
import { FRESH_MERGE_GATES } from './structure/structure';

/** One rule as a reader sees it: what it refuses and whether removing it would make a candidate wrong. */
export interface ReaderRule {
  id: string;
  why: string;
  sound: boolean;
}

export const VARIATION_GATE_TABLES = {
  ADVANCE_HEAD_GATES,
  ADVANCE_MEMBER_GATES,
  ARM_DISJOINT_GATES,
  ARM_REREAD_GATES,
  BASEFOLD_GATES,
  COALESCE_GATES,
  COUNTDOWN_GATES,
  FRESH_MERGE_GATES,
  HOMESPLIT_FAN_GATES,
  HOMESPLIT_GATES,
  INLINEBASE_GATES,
  LIVEBASE_BLOCK_GATES,
  LIVEBASE_GATES,
  NAME_COALESCE_GATES,
  OFFMEMBER_GATES,
  ORDERBASE_GATES,
  PTR_FIELD_GATES,
  REGIONBASE_GATES,
  SCOPEBASE_ELIGIBILITY,
  SCOPEBASE_GATES,
  UNFOLDED_GATES,
  UNMERGE_ARM_GATES,
  UNMERGE_RUNG_GATES,
  UNMERGE_SITE_GATES,
  UNMERGE_TOTALITY_GATES,
  UNMERGE_VALUE_GATES,
  UNREDUCE_GATES,
  VOL_SLOT_GATES,
  VOL_STORE_GATES,
} as const satisfies Record<string, readonly Gate<never>[]>;

/** A table a variation's definition can name. */
export type GateTableName = keyof typeof VARIATION_GATE_TABLES;

/** The rules of `tables`, in table order, each once: a rule two tables word alike is listed once. */
export function readerRules(tables: readonly GateTableName[]): ReaderRule[] {
  const seen = new Set<string>();
  return tables.flatMap((t) =>
    VARIATION_GATE_TABLES[t].flatMap(({ id, why, sound }) => {
      if (seen.has(why)) {
        return [];
      }
      seen.add(why);
      return [{ id, why, sound }];
    }),
  );
}
