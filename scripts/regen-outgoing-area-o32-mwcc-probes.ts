// Regenerate the committed O32 and mwcc outgoing-area probe objects read by
// `packages/core/test/outgoing-area-probes.test.ts`.
//
// WHY A SCRIPT AND NOT A NOTE. `compilerBehaviors.outgoingAreaNeverLoadedFrom` (target.ts) is a
// universal emission fact the MIPS and PPC frontends read backwards — a word the function loads
// at or above the offset is a local, and so is every word above it — and a universal wrong for
// some producer costs an ANSWER, an argument dropped from a call. So it owes the compiled objects
// it rests on, re-measurable and not only re-readable (`docs/level-tower.md`, RE-READABLE IS NOT
// RE-MEASURABLE). Each compiler is compiled at the level its rows use and at -O0, the level that
// spills the most; mwcc_242_81 also at Animal Crossing's -O4,s.
//
//   ASMLIFT_IDO_CC=… ASMLIFT_KMC_DIR=… ASMLIFT_GCC272_DIR=… ASMLIFT_MWCC_ROOT=… \
//     npx tsx scripts/regen-outgoing-area-o32-mwcc-probes.ts
//
// Rewrites the `*-outarea.txt` fixtures in place, each with a provenance header naming the
// compiler as an `ASMLIFT_*` env name, its flags, and the objdump command.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOOLCHAIN_TARGETS } from '../packages/core/src/target';
import {
  GCC272_TOOLCHAIN,
  GCC_KMC_TOOLCHAIN,
  IDO_TOOLCHAIN,
  MWCC_PPC_TOOLCHAIN,
  type MwccToolchainId,
  compileMipsGcc272Target,
  compileMipsGccTarget,
  compileMipsTarget,
  compilePpcTarget,
} from '../packages/toolchains/src/index';

const CORPUS = join(import.meta.dirname, '..', 'packages', 'core', 'test', 'corpus');
const SOURCE = 'probe-outgoing-area.c';
const FIRST = 'nested';

const atO0 = (flags: readonly string[], level: string): string[] => flags.map((f) => (f === level ? '-O0' : f));

const BASE = ['-proc', 'gekko', '-align', 'powerpc', '-enum', 'int', '-fp', 'hardware', '-Cpp_exceptions', 'off'];
/** Mario Party 4's DOL unit flags as its rows store them (the later `-O0,p` is the level acted on). */
const MP4 = [
  ...BASE,
  ...['-O4,p', '-inline', 'auto', '-pragma', 'cats off', '-RTTI', 'off', '-fp_contract', 'on', '-str', 'reuse'],
  ...['-O0,p', '-char', 'unsigned', '-fp_contract', 'off', '-lang=c'],
];
/** Pikmin's unit flags as its rows store them, in C. */
const PIKMIN_C = [
  ...BASE,
  ...['-O4,p', '-inline', 'auto', '-pragma', 'cats off', '-RTTI', 'off', '-fp_contract', 'off', '-str', 'reuse'],
  ...['-RTTI', 'on', '-char', 'unsigned', '-lang=c'],
];
/** Animal Crossing's unit flags, at its -O4,s. */
const ACD = [
  ...['-proc', 'gekko', '-align', 'powerpc', '-enum', 'int', '-char', 'unsigned', '-fp', 'hardware'],
  ...['-Cpp_exceptions', 'off', '-pragma', 'cats off', '-sdata', '0', '-sdata2', '0', '-O4,s', '-lang=c'],
];

interface Probe {
  slug: string;
  description: string;
  harness: readonly string[];
  flags: readonly string[];
  objdump: string;
  compile: (source: string, flags: readonly string[]) => string;
}

const ido = TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags;
const kmc = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags;
const gcc272 = TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags;
const mips = (
  slug: string,
  description: string,
  t: { harnessFlags: readonly string[]; objdump: string; objdumpFlags: readonly string[] },
  flags: readonly string[],
  compile: typeof compileMipsTarget,
): Probe => ({
  slug,
  description,
  harness: t.harnessFlags,
  flags,
  objdump: `${t.objdump} ${t.objdumpFlags.join(' ')}`,
  compile: (s, f) => compile(s, FIRST, f).asm,
});
const mwcc = (slug: string, id: MwccToolchainId, label: string, flags: readonly string[]): Probe => ({
  slug,
  description: `${id} at ${label}, binary under $ASMLIFT_MWCC_ROOT`,
  harness: MWCC_PPC_TOOLCHAIN.harnessFlags,
  flags,
  objdump: `${MWCC_PPC_TOOLCHAIN.objdump} ${MWCC_PPC_TOOLCHAIN.objdumpFlags.join(' ')}`,
  compile: (s, f) => compilePpcTarget(id, s, FIRST, f).asm,
});

const PROBES: Probe[] = [
  mips('ido71', 'MIPS_IDO (ido7.1), binary from $ASMLIFT_IDO_CC', IDO_TOOLCHAIN, ido, compileMipsTarget),
  mips(
    'ido71-O0',
    'MIPS_IDO (ido7.1) at -O0, binary from $ASMLIFT_IDO_CC',
    IDO_TOOLCHAIN,
    atO0(ido, '-O2'),
    compileMipsTarget,
  ),
  mips(
    'gcc272kmc',
    'MIPS_GCC (gcc2.7.2kmc), binary from $ASMLIFT_KMC_DIR',
    GCC_KMC_TOOLCHAIN,
    kmc,
    compileMipsGccTarget,
  ),
  mips(
    'gcc272kmc-O0',
    'MIPS_GCC (gcc2.7.2kmc) at -O0, binary from $ASMLIFT_KMC_DIR',
    GCC_KMC_TOOLCHAIN,
    atO0(kmc, '-O2'),
    compileMipsGccTarget,
  ),
  mips(
    'gcc272',
    'MIPS_GCC (gcc2.7.2), binary from $ASMLIFT_GCC272_DIR',
    GCC272_TOOLCHAIN,
    gcc272,
    compileMipsGcc272Target,
  ),
  mips(
    'gcc272-O0',
    'MIPS_GCC (gcc2.7.2) at -O0, binary from $ASMLIFT_GCC272_DIR',
    GCC272_TOOLCHAIN,
    atO0(gcc272, '-O1'),
    compileMipsGcc272Target,
  ),
  mwcc('mwcc242', 'mwcc_242_81', 'canonical flags', TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags),
  mwcc('mwcc242mp4', 'mwcc_242_81', "Mario Party 4's flags (-O0,p)", MP4),
  mwcc('mwcc242acd', 'mwcc_242_81', "Animal Crossing's flags (-O4,s)", ACD),
  mwcc('mwcc247mp4', 'mwcc_247_107', "Mario Party 4's flags (-O0,p)", MP4),
  mwcc('mwcc233', 'mwcc_233_163n', "Pikmin's flags, in C", PIKMIN_C),
  mwcc(
    'mwcc233-O0',
    'mwcc_233_163n',
    "Pikmin's flags at -O0,p, in C",
    PIKMIN_C.map((f) => (f === '-O4,p' ? '-O0,p' : f)),
  ),
];

const source = readFileSync(join(CORPUS, SOURCE), 'utf8');
for (const p of PROBES) {
  // objdump prints the object's PATH, and the compile runs in a per-content temp dir — normalised
  // so a regeneration is no diff and no local directory reaches the repo.
  const body = p.compile(source, p.flags).replace(/^\S*ref\.o:(\s+file format)/m, 'probe.o:$1');
  const header =
    `# GENERATED by scripts/regen-outgoing-area-o32-mwcc-probes.ts — do not hand-edit.\n` +
    `# source    : packages/core/test/corpus/${SOURCE}\n` +
    `# toolchain : ${p.description}\n` +
    `# cc flags  : ${[...p.harness, ...p.flags].join(' ')}\n` +
    `# objdump   : ${p.objdump.replace(/^\S*\//, '')}\n` +
    `# read by   : packages/core/test/outgoing-area-probes.test.ts\n`;
  const out = join(CORPUS, `${p.slug}-outarea.txt`);
  writeFileSync(out, header + body);
  console.log(`wrote ${out}`);
}
