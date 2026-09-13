// The retired-row register (`dataset/retired-rows.json`), read once for everything that joins it:
// the regression gate (a registered row is `retired`, not `missing`) and the citation gates (a dated
// measurement may keep naming a row that no longer exists). bench-schema `retirementKeys` says what
// the register is keyed by and why.
import { ADDR_PATTERN, type RetiredRow } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RETIRED_PATH = join(import.meta.dirname, '..', '..', 'dataset', 'retired-rows.json');

/** Every retired row, across every retirement. A malformed entry THROWS: an entry without an address
 *  or a source URL has no retirement key, so it would excuse nothing while reading as if it did. */
export function retiredRows(path = RETIRED_PATH): RetiredRow[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { retirements?: { rows?: Partial<RetiredRow>[] }[] };
  if (!Array.isArray(parsed.retirements)) {
    throw new Error(`${path}: no top-level \`retirements\` array`);
  }
  return parsed.retirements.flatMap((t) =>
    (t.rows ?? []).map((r) => {
      if (
        typeof r.id !== 'string' ||
        r.id.split(':').length < 3 ||
        typeof r.addr !== 'string' ||
        !ADDR_PATTERN.test(r.addr) ||
        typeof r.sourceUrl !== 'string' ||
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[0-9a-f]{7,40}\//.test(r.sourceUrl)
      ) {
        throw new Error(`${path}: malformed retired row ${JSON.stringify(r)} — needs id, addr and a pinned sourceUrl`);
      }
      return { id: r.id, addr: r.addr, sourceUrl: r.sourceUrl };
    }),
  );
}
