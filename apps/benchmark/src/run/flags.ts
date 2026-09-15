// `bench flags`: every real unit's compiler flags, derived from its project's own build
// (cases/derive-flags.ts), one table per project. Columns:
//   flags         the derived flags, in core's normal form
//   status        `ok`, `DRIFT <stored> → <derived>`, `MISSING` (the manifest stores none) or `UNPARSEABLE`
//   unclassified  the codegen words core's flag table does not name
//   rom           how many of the unit's rows compile, from their vendored TU at the derived flags, to the
//                 function the project's linked ELF holds at their address (relocations masked)
// Every DIFF row, and every unit that could not be derived, is named under its table. Exit 1 unless every
// unit is `ok` and every row is EQ.
import { UnreadableLevelError, parseFlags } from '@asmlift/core/codegen-flags';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { existsSync, readFileSync } from 'node:fs';

import { git, provenanceCommit } from '../cases/checkout';
import {
  type DerivedFlags,
  buildSystemOf,
  deriveDtkFlags,
  deriveMakefileFlags,
  flagsClone,
  flagsStatus,
  objectFiles,
  unitObject,
  unitOf,
} from '../cases/derive-flags';
import { type RealFunction, type VendoredManifest, loadManifests, resolveProjectRoot } from '../cases/manifests';
import { resolveProjectElf } from '../cases/project-elf';
import { compareWithRom } from '../cases/rom-function';
import { buildRealTarget } from '../compile/real';

export function flagsReport(opts: { project?: string; only?: string }): boolean {
  let clean = true;
  let reported = 0;
  for (const man of loadManifests().filter((m) => opts.project === undefined || m.project === opts.project)) {
    const rows = man.functions.filter((f) => opts.only === undefined || f.sym.includes(opts.only));
    if (rows.length > 0) {
      reported++;
      clean = reportProject(man, rows) && clean;
    }
  }
  if (reported === 0) {
    const filter = [
      ...(opts.project === undefined ? [] : [`--project ${opts.project}`]),
      ...(opts.only === undefined ? [] : [`--only ${opts.only}`]),
    ].join(' ');
    console.error(`no real row matches ${filter || 'the dataset'}`);
    return false;
  }
  return clean;
}

function reportProject(man: VendoredManifest, rows: readonly RealFunction[]): boolean {
  const root = resolveProjectRoot(man);
  const commit = provenanceCommit(man.project);
  const head = existsSync(root) ? git(root, ['rev-parse', 'HEAD']) : undefined;
  if (commit === null || head !== commit) {
    console.log(
      `${man.project}: flags are derived at the commit the TUs were vendored from (${commit ?? 'none recorded'}), ` +
        `and the checkout at ${root} is ${head === undefined ? 'missing' : `at ${head}`}`,
    );
    return false;
  }
  const build = buildSystemOf(root);
  const elf = resolveProjectElf(man.project, root);
  const linked = elf.elf === null ? undefined : readFileSync(elf.elf);
  const clone = build === 'makefile' ? flagsClone(man.project, root, commit) : '';
  const objects = build === 'makefile' ? objectFiles(root) : [];

  const units = new Map<string, RealFunction[]>();
  for (const fn of rows) {
    units.set(unitOf(fn), [...(units.get(unitOf(fn)) ?? []), fn]);
  }
  const table: string[][] = [];
  const notes: string[] = [];
  let clean = linked !== undefined;
  if (elf.elf === null) {
    notes.push(`no linked ELF to compare with: ${elf.reason}`);
  }
  for (const [unit, fns] of units) {
    let derived: DerivedFlags;
    try {
      derived =
        build === 'makefile'
          ? deriveMakefileFlags({ clone, commit, unit, object: unitObject(unit, objects), toolchain: man.toolchain })
          : deriveDtkFlags(root, commit, unit);
    } catch (e) {
      clean = false;
      table.push([unit, man.toolchain, '', e instanceof UnreadableLevelError ? 'UNPARSEABLE' : 'not derived', '', '']);
      notes.push(`${unit}: ${(e as Error).message}`);
      continue;
    }
    const status = flagsStatus(undefined, derived.cflags);
    clean &&= status.kind === 'ok';
    const unclassified = parseFlags(TOOLCHAIN_TARGETS[derived.toolchain].family, derived.cflags).unclassified;
    let equal = 0;
    for (const fn of fns) {
      if (linked === undefined) {
        break;
      }
      try {
        const target = buildRealTarget(derived.toolchain, derived.cflags, man.vendored(fn.sym).tuI);
        const rom = compareWithRom(readFileSync(target.obj), fn.sym, linked, Number.parseInt(fn.addr, 16));
        if (rom.equal) {
          equal++;
        } else {
          notes.push(`${fn.sym} (${unit}): DIFF, ${rom.detail}`);
        }
      } catch (e) {
        notes.push(`${fn.sym} (${unit}): DIFF, ${(e as Error).message}`);
      }
    }
    clean &&= equal === fns.length;
    table.push([
      unit,
      derived.toolchain,
      derived.cflags.join(' '),
      status.kind === 'DRIFT' ? `DRIFT ${status.stored.join(' ')} → ${derived.cflags.join(' ')}` : status.kind,
      unclassified.length > 0 ? unclassified.join(' ') : '-',
      linked === undefined ? '-' : `${equal === fns.length ? 'EQ' : 'DIFF'} ${equal}/${fns.length}`,
    ]);
  }

  console.log(`${man.project} (${build === 'makefile' ? 'Makefile' : 'objdiff.json'} @ ${commit.slice(0, 8)})`);
  printTable(['unit', 'toolchain', 'flags', 'status', 'unclassified', 'rom'], table);
  for (const note of notes) {
    console.log(`  ${note}`);
  }
  console.log('');
  return clean;
}

function printTable(header: readonly string[], rows: readonly string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const row of [header, ...rows]) {
    console.log(`  ${row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')}`);
  }
}
