// asmlift — toolchain paths + flags for the compile/score harness (score.ts, benchmark).
// Node-only by design: this is the file that keeps @asmlift/core browser-pure — the
// TargetDescriptions live in @asmlift/core/target; the binaries that COMPILE for those
// targets live here.
//
// Toolchain paths are portable, not machine-pinned: every external binary resolves from an env
// var, defaulting to the canonical sibling-checkout layout (`decompiler/{asmlift,transmuter,
// snowboardkids2-decomp,decomp.me}`). Any other layout overrides via env.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// DEPTH INVARIANT: this file must sit exactly three levels below the repo root
// (packages/toolchains/src) — or every sibling-checkout default (and the benchmark
// cache keys derived from them) silently shifts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..'); // .../asmlift
const WORKSPACE = join(REPO_ROOT, '..'); // holds the sibling toolchain checkouts
const env = (key: string, fallback: string) => process.env[key] ?? fallback;

// Shared default for the two MIPS toolchain bags (IDO + KMC-GCC): resolved from PATH,
// overridable via ASMLIFT_MIPS_OBJDUMP.
const MIPS_OBJDUMP = env('ASMLIFT_MIPS_OBJDUMP', 'mips-linux-gnu-objdump');

/** Toolchain paths + flags for the agbcc/GBA target (used by the scoring harness).
 *  Overridable via ASMLIFT_AGBCC / ASMLIFT_ARM_AS. */
export const TOOLCHAIN = {
  agbcc: env('ASMLIFT_AGBCC', join(WORKSPACE, 'transmuter/compilers/agbcc/agbcc')),
  as: env('ASMLIFT_ARM_AS', 'arm-none-eabi-as'),
  asFlags: ['-mthumb', '-mthumb-interwork'],
  agbccFlags: ['-mthumb-interwork', '-Wimplicit', '-O2', '-fhex-asm', '-fprologue-bugfix'],
};

/** IDO toolchain paths.
 *  Flags mirror real N64 IDO 7.1 projects (oot-style): `-non_shared -G 0` compiles non-PIC —
 *  no `$gp`/`$t9` GOT prologue — and `-Xcpluscomm` accepts `//` comments, both as those
 *  projects' Makefiles do. Overridable via ASMLIFT_IDO_CC / ASMLIFT_MIPS_OBJDUMP. */
export const IDO_TOOLCHAIN = {
  cc: env('ASMLIFT_IDO_CC', join(WORKSPACE, 'transmuter/compilers/ido-static-recomp/build/7.1/out/cc')),
  ccFlags: ['-c', '-mips2', '-O2', '-32', '-non_shared', '-Xcpluscomm', '-G', '0'],
  objdump: MIPS_OBJDUMP,
  objdumpFlags: ['-d', '--no-show-raw-insn'],
};

/** KMC GCC toolchain — the Kyoto-Microcomputer N64 GCC vendored by the Snowboard Kids 2 decomp
 *  project. The binaries are Linux/i386 ELFs (won't run on Darwin/arm64), so the compile runs
 *  inside a linux/386 Docker container with the compiler dir mounted; disassembly + scoring use
 *  the native host binutils/scorer on the produced object. Flags mirror that project's Makefile
 *  (`-mips3 -EB -O2 -G0 -mabi=32 …`). Overridable via ASMLIFT_KMC_DIR / ASMLIFT_KMC_IMAGE /
 *  ASMLIFT_DOCKER / ASMLIFT_MIPS_OBJDUMP. */
export const GCC_KMC_TOOLCHAIN = {
  docker: env('ASMLIFT_DOCKER', 'docker'),
  image: env('ASMLIFT_KMC_IMAGE', 'i386/ubuntu:bionic'),
  dir: env('ASMLIFT_KMC_DIR', join(WORKSPACE, 'snowboardkids2-decomp/tools/gcc_kmc')),
  ccFlags: [
    '-mabi=32',
    '-mgp32',
    '-mfp32',
    '-mno-abicalls',
    '-nostdinc',
    '-fno-PIC',
    '-G',
    '0',
    '-funsigned-char',
    '-w',
    '-mips3',
    '-EB',
    '-O2',
    '-fno-builtin',
    '-fno-asm',
  ],
  objdump: MIPS_OBJDUMP,
  objdumpFlags: ['-d', '--no-show-raw-insn'],
};

/** CodeWarrior mwcceppc toolchain — runs the Win32 PE `mwcceppc.exe` through `wibo` inside a
 *  linux/386 Docker image (packages/toolchains/ppc-docker), exactly as decomp.me does. The image bundles a
 *  32-bit `wibo` + a PowerPC objdump; the PROPRIETARY CodeWarrior binaries are NOT baked in —
 *  they are bind-mounted from decomp.me's vendored `mwcc_<version>` dir (never committed). The
 *  version IS the spec: mwcc_242_81 = CodeWarrior 2.4.2 build 81, a widely-used GameCube
 *  compiler. Command mirrors decomp.me's `MWCCEPPC_CC` (compilers.py). Overridable via
 *  ASMLIFT_MWCC_DIR / ASMLIFT_PPC_IMAGE / ASMLIFT_DOCKER. */
export const MWCC_PPC_TOOLCHAIN = {
  docker: env('ASMLIFT_DOCKER', 'docker'),
  image: env('ASMLIFT_PPC_IMAGE', 'asmlift-ppc:latest'),
  dir: env('ASMLIFT_MWCC_DIR', join(WORKSPACE, 'decomp.me/backend/compilers/gc_wii/mwcc_242_81')),
  // decomp.me: `mwcceppc.exe -pragma "msg_show_realref off" -c -proc gekko -nostdinc -stderr`.
  // -O4,p (opt-4 + peephole) + -enum int + -inline auto are the load-bearing GC matching flags.
  ccFlags: [
    '-pragma',
    'msg_show_realref off',
    '-c',
    '-proc',
    'gekko',
    '-nostdinc',
    '-stderr',
    '-O4,p',
    '-enum',
    'int',
    '-inline',
    'auto',
    '-fp',
    'hard',
    '-Cpp_exceptions',
    'off',
  ],
  // The image runs the Win32 PE via the bundled 32-bit wibo — a Win32 API shim, not a CPU
  // emulator; the linux/386 platform layer supplies any x86 emulation the host needs.
  wibo: env('ASMLIFT_WIBO', 'wibo'),
  objdump: env('ASMLIFT_PPC_OBJDUMP', 'powerpc-eabi-objdump'),
  // `-r` interleaves relocation lines (`R_PPC_REL24 <sym>`) after each instruction: an unresolved
  // `bl` in a .o encodes offset 0 (a self-referential placeholder), so the callee's NAME lives only
  // in the relocation — the PPC frontend reads it there to recover the call target (parseDisasm).
  objdumpFlags: ['-d', '-r', '--no-show-raw-insn'],
};
