// asmlift — object-file (.o) input for the CLI. Sniff ELF, disassemble with the target's
// objdump, and extract the AsmData side-table (jump-table bytes + relocations) so dense
// switches recover without the user knowing the side-table exists.
//
// SELF-CONTAINED by design: this module knows only objdump BINARY NAMES and FLAGS — never
// compiler paths or Docker images (those are pinned-toolchain infrastructure, not user
// surface). The objdump binaries resolve from PATH, overridable per call (a decomp.yaml
// `tools.asmlift.objdump`) or via env; a missing binary is a loud error naming every remedy.
import { type AsmData, parseAsmData } from '@asmlift/core/frontend/asmdata';
import type { TargetDescription } from '@asmlift/core/target';
import { spawnSync } from 'node:child_process';

/** ELF magic: 0x7f 'E' 'L' 'F'. The one sniff the CLI needs — every toolchain here emits ELF. */
export const isElfObject = (b: Uint8Array): boolean =>
  b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;

/** Thrown when a target's frontend cannot consume disassembled objects (agbcc reads .s text). */
export class ObjectInputUnsupportedError extends Error {}

// Env reads are LAZY (call time, not module load) so tests can vary them. These two env names
// are also read by the pinned-toolchain config (@asmlift/toolchains) for its asmdata
// extraction — keep the names in sync.
const mipsObjdump = () => process.env.ASMLIFT_MIPS_OBJDUMP ?? 'mips-linux-gnu-objdump';
const ppcObjdump = () => process.env.ASMLIFT_PPC_OBJDUMP ?? 'powerpc-eabi-objdump';

// PPC keeps `-r`: an unresolved `bl` encodes a placeholder offset, so the callee NAME lives
// only in the interleaved relocation lines the frontend parses.
const MIPS_DISASM_FLAGS = ['-d', '--no-show-raw-insn'];
const PPC_DISASM_FLAGS = ['-d', '-r', '--no-show-raw-insn'];

interface ObjdumpChoice {
  bin: string;
  disasmFlags: string[];
  remedy: string;
}

function objdumpFor(target: TargetDescription, objdumpBin?: string): ObjdumpChoice {
  if (target.compiler === 'agbcc') {
    throw new ObjectInputUnsupportedError(
      `object-file input for target '${target.id}/${target.compiler}' is not supported — its frontend reads agbcc .s text, not objdump output`,
    );
  }
  const ppc = target.compiler === 'mwcc';
  const fallback = ppc ? ppcObjdump() : mipsObjdump();
  const envVar = ppc ? 'ASMLIFT_PPC_OBJDUMP' : 'ASMLIFT_MIPS_OBJDUMP';
  const arch = ppc ? 'PowerPC' : 'MIPS';
  return {
    bin: objdumpBin ?? fallback,
    disasmFlags: ppc ? PPC_DISASM_FLAGS : MIPS_DISASM_FLAGS,
    remedy: `no ${arch} objdump — install ${fallback} on PATH, point ${envVar} at one, or set tools.asmlift.objdump in decomp.yaml`,
  };
}

const run = (choice: ObjdumpChoice, args: string[], obj: string, what: string): string => {
  const r = spawnSync(choice.bin, [...args, obj], { encoding: 'utf8' });
  if (r.error) {
    throw new Error(`cannot run ${choice.bin} (${what}): ${choice.remedy}`);
  }
  if (r.status !== 0) {
    throw new Error(`${choice.bin} (${what}) failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
};

/** `objdump -d` text for the object, using the target family's disassembler — exactly the
 *  text the frontend reads. `objdumpBin` (a decomp.yaml `tools.asmlift.objdump`) overrides
 *  the PATH/env-resolved binary. */
export function disasmObject(obj: string, target: TargetDescription, objdumpBin?: string): string {
  const choice = objdumpFor(target, objdumpBin);
  return run(choice, choice.disasmFlags, obj, 'disassemble');
}

/** The `objdump -s -r -t` side-table (AsmData) for jump-table recovery; undefined when the
 *  target has no extractor. Failures here are the CALLER's to soften — the side-table is
 *  optional (without it a dense-switch dispatch declines loudly downstream). */
export function asmDataForObject(obj: string, target: TargetDescription, objdumpBin?: string): AsmData | undefined {
  if (target.compiler === 'agbcc') {
    return undefined;
  }
  const choice = objdumpFor(target, objdumpBin);
  const dump = run(choice, ['-s', '-r', '-t'], obj, 'asmdata');
  return parseAsmData(dump, dump, dump, true);
}
