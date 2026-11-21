// Reading a project's callee bodies off its linked ELF, ONE way for the three readers that need it:
// `bench vendor` freezes them (cases/vendor.ts), `bench fidelity` re-derives them and holds the
// frozen file equal (run/symbol-drift.ts `checkCalleeBodiesDrift`), and `bench target` names the
// same objdump in the decomp.yaml a row's repro script runs the CLI with (decomp-config.ts).
// Spelled per reader, a PowerPC repro could read its listings with another objdump than the
// vendor's, or with none, and read no body where the harness hands it one.
//
// NOT THE PROJECT'S OWN ASSEMBLY. Where decomp.yaml names a compiler, the CLI also reads a Thumb
// callee's body off the project's `.s` the build proves is the linked code (cli splat-bodies.ts),
// which only a compile with that command proves. This reader does not compile, so it freezes none of
// those: it REFUSES a project where that pass has a file to read (`projectAsmCandidates`), rather
// than freezing less than the CLI reads (kleod has no INCLUDE_ASM and names no compiler). A project
// that has one needs those bodies frozen here first.
import { moduleOf } from '@asmlift/bench-schema';
import { asmliftBlock } from '@asmlift/cli/config';
import { calleeBodiesFromElf, readElfImage } from '@asmlift/cli/elf-bodies';
import { disasmRange, objdumpBinaryFor, readsObjdumpText } from '@asmlift/cli/objfile';
import { projectAsmCandidates } from '@asmlift/cli/splat-bodies';
import type { TargetDescription } from '@asmlift/core/target';
import { searchDecompYaml } from '@match-kit/decomp-yaml/files';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { VendoredCalleeBodies } from './callee-bodies';
import { realCases } from './real';

/** The objdump a dtk project's own build fetches (`build/binutils`, configure.py), which a GameCube
 *  project's listing bodies are read with: no PowerPC objdump is on a usual PATH, and the CLI's
 *  environment variable cannot be pointed at it without also reaching the docker-run compiler
 *  wrapper, which reads the same variable inside its container. Undefined for any other target, or
 *  where the checkout has not fetched it: the CLI's own choice (env, then PATH) then reads. */
export function projectObjdump(root: string, target: TargetDescription): string | undefined {
  const dtk = join(root, 'build', 'binutils', 'powerpc-eabi-objdump');
  return target.compiler === 'mwcc' && existsSync(dtk) ? dtk : undefined;
}

/** The target the project's rows read callee bodies as — one per project, or THROWS: the frozen
 *  file is one per project, so rows reading bodies two ways (an objdump listing beside ARM words,
 *  PowerPC beside MIPS) cannot share it. Undefined for a project with no row outside a REL module. */
export function calleeBodiesTarget(project: string): TargetDescription | undefined {
  const families = new Map<string, TargetDescription>();
  for (const c of realCases({ project }).filter((x) => moduleOf(x.addr) === undefined)) {
    const t = c.codegen.target;
    families.set(JSON.stringify([t.compiler === 'mwcc', readsObjdumpText(t)]), t);
  }
  if (families.size > 1) {
    throw new Error(`${project}: its rows read callee bodies as ${families.size} different targets`);
  }
  return [...families.values()][0];
}

/** The `--version` line of `bin` with its package label dropped: `GNU objdump (GNU Binutils for
 *  Ubuntu) 2.42` and `GNU objdump (GNU Binutils) 2.42` are one binutils release, and the label names
 *  the distribution that packaged it, which is the machine's and not the listing's. */
export function objdumpVersion(target: TargetDescription, bin: string | undefined): string {
  const line = spawnSync(objdumpBinaryFor(target, bin), ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  return line.replace(/ \([^)]*\)/, '');
}

/** The bodies of `callees` the ELF at `elf` gives, read as the CLI reads them (`calleeBodiesFromElf`
 *  over `disasmRange`), with the ELF's path in a listing's header written as `elfRel` (decomp.yaml's
 *  spelling, never this machine's). THROWS on a range the objdump could not disassemble, and where the
 *  CLI run in the checkout at `root` would read a Thumb body off the project's own assembly (see the
 *  header), rather than reading less than the CLI reads. */
export function readCalleeBodies(
  project: string,
  root: string,
  elf: { elf: string; elfRel: string },
  callees: readonly string[],
  target: TargetDescription,
  objdump: string | undefined,
): VendoredCalleeBodies {
  const sorted = [...callees].sort();
  const bin = readsObjdumpText(target) ? objdump : undefined;
  const read = calleeBodiesFromElf(elf.elf, readFileSync(elf.elf), sorted, target, (path, t, section, start, stop) =>
    disasmRange(path, t, section, start, stop, bin).split(path).join(elf.elfRel),
  );
  if (read.warnings.length > 0) {
    throw new Error(`${project}: ${read.warnings.map((w) => w.trim()).join('\n  ')}`);
  }
  // the CLI's condition for its project-asm pass (cli main.ts): a Thumb body, and a compiler named
  const thumb = sorted.filter((c) => read.bodies[c]?.kind === 'thumb');
  const image =
    thumb.length > 0 && asmliftBlock(searchDecompYaml(root))?.compiler !== undefined
      ? readElfImage(readFileSync(elf.elf))
      : undefined;
  if (image !== undefined) {
    const own = projectAsmCandidates(root, image, thumb).map((c) => c.callee);
    if (own.length > 0) {
      throw new Error(
        `${project}: the CLI reads ${own.length} callee bodies (${own.slice(0, 5).join(', ')}${own.length > 5 ? ', …' : ''}) ` +
          "off the project's own assembly where its build proves them linked (cli splat-bodies.ts), and this " +
          "reader freezes only the ELF's — nothing written",
      );
    }
  }
  return {
    objdump: readsObjdumpText(target) ? objdumpVersion(target, bin) : null,
    bodies: read.bodies,
    unread: sorted.filter((c) => !Object.hasOwn(read.bodies, c)),
  };
}
