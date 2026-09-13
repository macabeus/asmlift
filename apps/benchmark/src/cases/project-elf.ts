// Resolve (and, when possible, BUILD) the ELF a project's own decomp.yaml names
// (`tools.asmlift.elf`) — the symbol-map source. Shared by `bench vendor` (vendorSymbols) and
// the fidelity map-drift check: when the file is missing but the project Makefile exposes an
// `asmlift-elf` target (the DWARF types-sidecar projects), run it — building the derived ELF
// is the checkout's own documented recipe, not a harness invention.
//
// What that fallback is NOT licensed to do is build the project. `asmlift-elf` depends on the
// project's own linked ELF, so on a checkout that is merely CLONED the same command fires the
// whole ROM build — here, under whatever `make` and preprocessor the harness has, instead of
// under the project recipe (`src/cases/project-setup.ts`), which for several projects is the
// only spelling that works (kleod: `gmake compare CPP=arm-none-eabi-cpp`). It fails loud rather
// than producing a wrong ELF, but the failure names the wrong thing. Hence the precondition
// below, and `gmake` where there is one.
import { loadDecompConfig } from '@asmlift/cli/config';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ELF_MAKE_TARGET = 'asmlift-elf';

export function makefileHasAsmliftElf(root: string): boolean {
  const mk = join(root, 'Makefile');
  return existsSync(mk) && new RegExp(`^${ELF_MAKE_TARGET}\\s*:`, 'm').test(readFileSync(mk, 'utf8'));
}

/** GNU make under the name these projects' own INSTALL docs use. macOS `make` is GNU make 3.81,
 *  which kleod's INSTALL.md explicitly refuses ("use `gmake` instead of `make`"); `gmake` is the
 *  Homebrew 4.x. Falls back to `make` where no `gmake` exists (Linux/CI, where `make` IS GNU
 *  make 4.x), so this is a no-op everywhere it does not matter. */
let gnuMakeCache: string | undefined;
export function gnuMake(): string {
  gnuMakeCache ??= spawnSync('gmake', ['--version'], { stdio: 'ignore' }).status === 0 ? 'gmake' : 'make';
  return gnuMakeCache;
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
  const setupCmd = `pnpm bench setup --project ${project} --build`;
  if (!existsSync(elfPath) && makefileHasAsmliftElf(root)) {
    // The derived ELF's prerequisite is the project's own linked ELF. Where decomp.yaml declares
    // that path (3 of the 6 real projects today) and it is absent, the target would build the
    // project rather than graft a sidecar — refuse, and name the command that builds it the
    // project's own way. Where it is undeclared the precondition cannot be checked and the
    // target still runs, exactly as before.
    const baseRel = loaded!.config.versions?.[0]?.paths?.elf;
    if (baseRel && !existsSync(resolve(dirname(loaded!.path), baseRel))) {
      return {
        elf: null,
        elfRel,
        reason:
          `${elfRel} is not built and its prerequisite ${baseRel} is missing too — ` +
          `\`${ELF_MAKE_TARGET}\` would build the whole project with the harness's make/preprocessor ` +
          `instead of the project recipe; run \`${setupCmd}\``,
      };
    }
    const make = gnuMake();
    console.log(`${project}: ${elfRel} not built — running \`${make} ${ELF_MAKE_TARGET}\` in ${root}`);
    try {
      execSync(`${make} ${ELF_MAKE_TARGET}`, { cwd: root, stdio: 'inherit', timeout: 600_000 });
    } catch {
      return {
        elf: null,
        elfRel,
        reason: `\`${make} ${ELF_MAKE_TARGET}\` failed in ${root} (output above) — run \`${setupCmd}\``,
      };
    }
  }
  if (!existsSync(elfPath)) {
    const hint = makefileHasAsmliftElf(root) ? '' : ` (no \`${ELF_MAKE_TARGET}\` Makefile target — build the project)`;
    return { elf: null, elfRel, reason: `${elfRel} is not built${hint}` };
  }
  return { elf: elfPath, elfRel };
}
