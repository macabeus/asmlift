// Resolve (and, when possible, BUILD) the ELF a project's own decomp.yaml names
// (`tools.asmlift.elf`) — the symbol-map source. Shared by `bench vendor` (vendorSymbols) and
// the fidelity map-drift check: when the file is missing but the project Makefile exposes an
// `asmlift-elf` target (the DWARF types-sidecar projects), run it — building the derived ELF
// is the checkout's own documented recipe, not a harness invention.
import { loadDecompConfig } from '@asmlift/cli/config';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ELF_MAKE_TARGET = 'asmlift-elf';

export function makefileHasAsmliftElf(root: string): boolean {
  const mk = join(root, 'Makefile');
  return existsSync(mk) && new RegExp(`^${ELF_MAKE_TARGET}\\s*:`, 'm').test(readFileSync(mk, 'utf8'));
}

export type ElfResolution =
  | { elf: string; elfRel: string } // exists on disk (possibly after `make asmlift-elf`)
  | { elf: null; elfRel: string | null; reason: string };

/** Resolve the declared ELF for the checkout at `root`; if it is not built and the Makefile
 *  has an `asmlift-elf` target, run it (logged). Never throws — the CALLER decides whether a
 *  missing ELF is a warn-and-skip (vendor) or a loud failure (fidelity). */
export function resolveProjectElf(project: string, root: string): ElfResolution {
  const loaded = loadDecompConfig(undefined, root);
  const elfRel = loaded?.config.tools?.asmlift?.elf;
  if (!elfRel) {
    return { elf: null, elfRel: null, reason: 'decomp.yaml declares no tools.asmlift.elf' };
  }
  const elfPath = resolve(dirname(loaded!.path), elfRel);
  if (!existsSync(elfPath) && makefileHasAsmliftElf(root)) {
    console.log(`${project}: ${elfRel} not built — running \`make ${ELF_MAKE_TARGET}\` in ${root}`);
    try {
      execSync(`make ${ELF_MAKE_TARGET}`, { cwd: root, stdio: 'inherit', timeout: 600_000 });
    } catch {
      return { elf: null, elfRel, reason: `\`make ${ELF_MAKE_TARGET}\` failed` };
    }
  }
  if (!existsSync(elfPath)) {
    const hint = makefileHasAsmliftElf(root) ? '' : ` (no \`${ELF_MAKE_TARGET}\` Makefile target — build the project)`;
    return { elf: null, elfRel, reason: `${elfRel} is not built${hint}` };
  }
  return { elf: elfPath, elfRel };
}
