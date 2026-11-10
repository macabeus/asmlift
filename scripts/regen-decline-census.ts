// Regenerate the committed decline census read by `apps/web/test/declines.test.ts` and cited by the
// header of `apps/web/src/pages/benchmark/lib/declines.ts`.
//
// WHY A GENERATED FILE AND NOT PROSE. The figures it holds — how many distinct decline messages
// core can throw, how many of them no class claims, and which files those sit in — move whenever a
// throw is reworded, added or moved, or a class lands. Spelt in a comment and pinned by `toContain`, each one was typed
// two or three times and edited by hand in most rounds, and those edits were the file's merge
// conflicts. Here they are written by the harvester the test itself runs
// (`apps/web/scripts/decline-census.ts`), and the test fails, naming this command, when the
// committed file is not what the tree computes.
//
//   pnpm regen:declines-census
//
// Reads only `packages/core/src` and the classes in `declines.ts` — not the benchmark artifact, so a
// bench regen never owes a census regen. The JSON is passed through
// the repo's prettier config, so a regeneration that changes no figure is no diff.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';

import { CENSUS_PATH, ROOT, currentCensus } from '../apps/web/scripts/decline-census';

const out = join(ROOT, CENSUS_PATH);
const census = currentCensus();
const text = await format(JSON.stringify(census, null, 2), { ...(await resolveConfig(out)), filepath: out });
writeFileSync(out, text);
console.log(
  `wrote ${CENSUS_PATH}: ${census.distinctMessages} distinct messages, ` +
    `${census.residueTotal} in "other" over ${census.residueByFile.length} files`,
);
