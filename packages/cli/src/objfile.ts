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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { codeSections, sectionScopedObject } from './elf-section';

/** ELF magic: 0x7f 'E' 'L' 'F'. The one sniff the CLI needs — every toolchain here emits ELF. */
export const isElfObject = (b: Uint8Array): boolean =>
  b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;

/** Thrown when a target's frontend cannot consume disassembled objects (agbcc reads .s text). */
export class ObjectInputUnsupportedError extends Error {}

/** Thrown when the object cannot be read without being told which function to read: a usage
 *  condition the caller reports as one, not an unreadable input. */
export class SymbolRequiredError extends Error {}

// Env reads are LAZY (call time, not module load) so tests can vary them. These two env names
// are also read by the pinned-toolchain config (@asmlift/toolchains) for its asmdata
// extraction — keep the names in sync.
const mipsObjdump = () => process.env.ASMLIFT_MIPS_OBJDUMP ?? 'mips-linux-gnu-objdump';
const ppcObjdump = () => process.env.ASMLIFT_PPC_OBJDUMP ?? 'powerpc-eabi-objdump';

// PPC keeps `-r`: an unresolved `bl` encodes a placeholder offset, so the callee NAME lives
// only in the interleaved relocation lines the frontend parses.
//
// `-M gekko` names the MACHINE. The only PowerPC asmlift reads is CodeWarrior's GameCube/Wii
// output, and the Gekko (750CL) paired-single opcodes share encodings with POWER's VSX/AltiVec:
// without the flag objdump's generic PowerPC dialect prints a float callee-save `psq_st f31,…`
// as `xscmpeqdp vs31,…` and its `psq_l` as `lq` — a decode that is not merely unmodelled but
// WRONG, so the frontend would lift a plausible instruction at the wrong operands. It is the
// same machine `-proc gekko` compiles for, and what every GC/Wii decomp project disassembles
// with (dtk's `powerpc-eabi-objdump -M gekko`).
const MIPS_DISASM_FLAGS = ['-d', '--no-show-raw-insn'];
const PPC_DISASM_FLAGS = ['-d', '-r', '-M', 'gekko', '--no-show-raw-insn'];

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

/** Run objdump over the object a read of `sym` may legitimately see. An object holding several code
 *  sections — CodeWarrior emits many, all named `.text` and all starting at address 0 — is replaced
 *  by a copy holding only the section `sym`'s `st_shndx` names, with only that section's
 *  relocations. Every single-code-section object goes through untouched.
 *
 *  Without a symbol to scope by, a dump whose code sections overlap labels two functions with one
 *  address and the read is refused rather than answered with another section's bytes; one whose
 *  sections lie at distinct addresses still labels each function uniquely and is read whole. */
function overObject<T>(obj: string, sym: string | undefined, use: (path: string) => T): T {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(obj);
  } catch {
    return use(obj); // an unreadable object is objdump's to report, in its own words
  }
  if (sym === undefined) {
    const { count, ambiguous } = codeSections(bytes);
    if (ambiguous) {
      throw new SymbolRequiredError(
        `${obj} holds ${count} code sections sharing addresses, so a function name in its ` +
          'disassembly does not say which bytes to read — pass --name <symbol>',
      );
    }
    return use(obj);
  }
  const scoped = sectionScopedObject(bytes, sym);
  if (scoped === undefined) {
    return use(obj);
  }
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-section-'));
  try {
    // the object's own basename, so objdump's header line names what the user passed
    const path = join(dir, basename(obj));
    writeFileSync(path, scoped);
    return use(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `objdump -d` text for the object, using the target family's disassembler — exactly the
 *  text the frontend reads. `objdumpBin` (a decomp.yaml `tools.asmlift.objdump`) overrides
 *  the PATH/env-resolved binary; `sym` is the function being read (`--name`). */
export function disasmObject(obj: string, target: TargetDescription, objdumpBin?: string, sym?: string): string {
  const choice = objdumpFor(target, objdumpBin);
  return overObject(obj, sym, (path) => run(choice, choice.disasmFlags, path, 'disassemble'));
}

/** The `objdump -s -r -t` side-table (AsmData) for jump-table recovery; undefined when the
 *  target has no extractor. Failures here are the CALLER's to soften — the side-table is
 *  optional (without it a dense-switch dispatch declines loudly downstream). */
export function asmDataForObject(
  obj: string,
  target: TargetDescription,
  objdumpBin?: string,
  sym?: string,
): AsmData | undefined {
  if (target.compiler === 'agbcc') {
    return undefined;
  }
  const choice = objdumpFor(target, objdumpBin);
  const dump = overObject(obj, sym, (path) => run(choice, ['-s', '-r', '-t'], path, 'asmdata'));
  return parseAsmData(dump, dump, dump, true);
}
