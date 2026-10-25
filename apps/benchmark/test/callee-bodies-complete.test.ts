// The callee bodies frozen per project (cases/callee-bodies.ts) name every callee a published row's
// lift can select, and nothing else: the set `bench vendor` read is, per project, every direct
// callee its rows' targets do not define (cli `elfBodyCandidates`), which bounds what the CLI's
// selection rule (`elfBodyCallees`) can ever pick.
//
// Read over the COMMITTED artifact's own disassembly, with the current rule: a change to how a
// callee is named, a row added without re-vendoring, or a row that left, fails here by name,
// rather than as a harness that hands a lift fewer bodies than `bench repro` reads (the runner
// refuses such a row at run time too, `selectCalleeBodies`).
import { moduleOf } from '@asmlift/bench-schema';
import { elfBodyCandidates } from '@asmlift/cli/elf-bodies';
import { parseAsmData } from '@asmlift/core/frontend/asmdata';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { readVendoredCalleeBodies } from '../src/cases/callee-bodies';
import { REAL_DIR, vendoredMapFile } from '../src/cases/manifests';

interface PublishedRow {
  id: string;
  sym: string;
  addr?: string;
  tier: string;
  project: string;
  isa?: string;
  targetAsm: string;
  asmDump?: string;
}

const rows = (
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'results', 'results.json'), 'utf8')) as {
    results: PublishedRow[];
  }
).results.filter((r) => r.tier === 'real' && moduleOf(r.addr) === undefined);

const projects = [...new Set(rows.map((r) => r.project))].sort();

describe('the vendored callee bodies name every callee a published row can ask', () => {
  test.each(projects)('%s', (project) => {
    const dir = join(REAL_DIR, 'tu', project);
    const vendored = readVendoredCalleeBodies(project, dir, existsSync(vendoredMapFile(dir, undefined)));
    if (vendored === undefined) {
      return; // no linked ELF: the CLI reads no bodies either
    }
    const asked = new Set<string>();
    for (const r of rows.filter((x) => x.project === project)) {
      // a MIPS call names its callee only in the object's relocations, which the row publishes
      const relocs =
        r.asmDump === undefined ? undefined : parseAsmData(r.asmDump, r.asmDump, r.asmDump, r.isa !== 'arm').relocs;
      for (const callee of elfBodyCandidates(r.targetAsm, r.sym, relocs)) {
        asked.add(callee);
      }
    }
    const frozen = [...Object.keys(vendored.bodies), ...vendored.unread].sort();
    expect(frozen).toEqual([...asked].sort());
  });
});
