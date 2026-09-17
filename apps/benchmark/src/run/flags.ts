// `bench flags`: every real unit's compiler flags, derived from its project's own build at the checkout's HEAD
// (cases/derive-flags.ts), one table per project. Columns:
//   flags         the derived flags, in core's normal form
//   status        `ok`, `DRIFT <what changed>`, `MISSING` (the manifest stores none) or `UNPARSEABLE`
//   unclassified  the codegen words core's flag table does not name
//   rom           how many of the unit's rows compile, from their vendored TU at the derived flags, to the
//                 function the project's linked ELF holds at their address — a REL row's module ELF at its
//                 module location — with relocations masked
// Every DIFF row, and every unit that could not be derived, is named under its table. `--write` stores the
// derived units, and each row's unit, in the manifest. Exit 1 unless every unit is derived and `ok` (or
// written) and every row is EQ.
import { unitLanguage } from '@asmlift/core/codegen-flags';
import { UnreadableLevelError, parseFlags } from '@asmlift/core/codegen-flags';
import { TOOLCHAIN_TARGETS, type ToolchainId } from '@asmlift/core/target';
import { existsSync, readFileSync } from 'node:fs';

import { provenanceCommit } from '../cases/checkout';
import { flagsStatus, unitDeriver } from '../cases/derive-flags';
import {
  type BuildUnit,
  type RealFunction,
  type RealManifest,
  loadManifestsForFlags,
  resolveProjectRoot,
  rewriteManifest,
  withVendoredInputs,
} from '../cases/manifests';
import { placedModuleElves, resolveProjectElf } from '../cases/project-elf';
import { compareWithRom, romLocation } from '../cases/rom-function';
import { buildRealTarget } from '../compile/real';

export interface FlagsOptions {
  project?: string;
  only?: string;
  write: boolean;
  /** the toolchain of a Makefile project's unit when the manifest stores none to take it from */
  toolchain?: ToolchainId;
}

export function flagsReport(opts: FlagsOptions): boolean {
  let clean = true;
  let reported = 0;
  for (const man of loadManifestsForFlags().filter((m) => opts.project === undefined || m.project === opts.project)) {
    const rows = man.functions.filter((f) => opts.only === undefined || f.sym.includes(opts.only));
    if (rows.length > 0) {
      reported++;
      clean = reportProject(man, rows, opts) && clean;
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

/** The one toolchain every stored unit of the project shares, if there is one. */
function sharedToolchain(man: RealManifest): ToolchainId | undefined {
  const toolchains = new Set(Object.values(man.units ?? {}).map((u) => u.toolchain));
  return toolchains.size === 1 ? [...toolchains][0] : undefined;
}

function reportProject(man: RealManifest, rows: readonly RealFunction[], opts: FlagsOptions): boolean {
  const root = resolveProjectRoot(man);
  if (!existsSync(root)) {
    console.log(`${man.project}: no checkout at ${root}`);
    return false;
  }
  // the linked ELF first: a project whose ELF is missing builds it, and the build writes the objects a
  // Makefile unit is found by
  const elf = resolveProjectElf(man.project, root);
  const deriver = unitDeriver(man.project, root);
  const vendoredAt = provenanceCommit(man.project);
  const linked = elf.elf === null || vendoredAt !== deriver.commit ? undefined : readFileSync(elf.elf);
  const vendored = withVendoredInputs(man);
  const placedModule = placedModuleElves(man.project, root);

  const units = new Map<string, RealFunction[]>();
  for (const fn of rows) {
    const unit = deriver.unitOf(fn);
    units.set(unit, [...(units.get(unit) ?? []), fn]);
  }
  const table: string[][] = [];
  const notes: string[] = [];
  const written = new Map<string, BuildUnit>();
  let clean = linked !== undefined;
  if (elf.elf === null) {
    notes.push(`no linked ELF to compare with: ${elf.reason}`);
  } else if (linked === undefined) {
    notes.push(
      `the TUs were vendored at ${vendoredAt ?? 'no commit'} and the checkout is at ${deriver.commit}: ` +
        `run \`pnpm bench vendor --project ${man.project}\`, which proves every row against the ROM`,
    );
  }
  for (const [unit, fns] of units) {
    const stored = man.units?.[unit];
    let derived: BuildUnit;
    try {
      derived = deriver.derive(unit, stored?.toolchain ?? opts.toolchain ?? sharedToolchain(man));
    } catch (e) {
      clean = false;
      table.push([
        unit,
        stored?.toolchain ?? '',
        '',
        e instanceof UnreadableLevelError ? 'UNPARSEABLE' : 'not derived',
        '',
        '',
      ]);
      notes.push(`${unit}: ${(e as Error).message}`);
      continue;
    }
    written.set(unit, derived);
    const status = flagsStatus(stored, derived);
    clean &&= opts.write || status.kind === 'ok';
    const unclassified = parseFlags(TOOLCHAIN_TARGETS[derived.toolchain].family, derived.cflags).unclassified;
    let equal = 0;
    for (const fn of fns) {
      if (linked === undefined) {
        break;
      }
      try {
        const target = buildRealTarget(
          derived.toolchain,
          fn.sym,
          derived.cflags,
          vendored.vendored(fn.sym).tuI,
          unitLanguage(unit, derived.cflags),
        );
        const { elf: romElf, at } = romLocation(fn.addr, linked, placedModule);
        const rom = compareWithRom(readFileSync(target.obj), fn.sym, romElf, at);
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
      status.kind === 'DRIFT' ? `DRIFT ${status.changes.join('; ')}` : status.kind,
      unclassified.length > 0 ? unclassified.join(' ') : '-',
      linked === undefined ? '-' : `${equal === fns.length ? 'EQ' : 'DIFF'} ${equal}/${fns.length}`,
    ]);
  }

  console.log(
    `${man.project} (${deriver.build === 'makefile' ? 'Makefile' : 'objdiff.json'} @ ${deriver.commit.slice(0, 8)})`,
  );
  printTable(['unit', 'toolchain', 'flags', 'status', 'unclassified', 'rom'], table);
  for (const note of notes) {
    console.log(`  ${note}`);
  }
  if (opts.write && written.size > 0) {
    const selected = new Set(rows.map((f) => f.sym));
    rewriteManifest(man.project, (m) => ({
      ...m,
      units: { ...m.units, ...Object.fromEntries(written) },
      functions: m.functions.map((f) =>
        selected.has(f.sym) && written.has(deriver.unitOf(f)) ? { ...f, unit: deriver.unitOf(f) } : f,
      ),
    }));
    console.log(`  wrote ${written.size} unit(s) to dataset/real/${man.project}.json`);
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
