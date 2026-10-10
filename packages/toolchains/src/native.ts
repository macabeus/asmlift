// Native execution of the three 32-bit Linux toolchains — KMC GCC, Mario Party 3's GCC 2.7.2, and
// CodeWarrior through wibo — on a host that can run them directly, instead of through a linux/386
// container.
//
// WHY. Those binaries are 32-bit x86 Linux ELFs: statically linked gcc drivers, and the static
// `wibo` release. An x86 Linux host executes them as they are, so the container adds nothing but
// its round trip: a pooled `docker exec` costs ~55 ms on a laptop where the compile itself costs
// ~6 ms, and a candidate fan is hundreds of them. macOS (and any non-x86 host) cannot run a Linux
// ELF at all, which is what the Docker path is for — it stays, as the fallback.
//
// WHAT IS EQUAL. The compiler binaries and their inputs are the same files either way, so the
// code they emit is the same: the native and container objects of a CodeWarrior compile are
// byte-identical, and a gcc object differs only in the absolute source path its file symbol
// records (`/tmp/…` against the container's `/host-tmp/…`), which no scorer reads. The toolchain
// parity suite (packages/cli/test/matching/native-parity.test.ts) pins this per compiler.
//
// WHEN. `ASMLIFT_NATIVE` decides, read on every call:
//   unset / `auto`  native wherever the probe below succeeds, Docker elsewhere (the default)
//   `0` / `off`     always Docker — the A/B switch, and the escape hatch
//   `1` / `on`      native, or a loud error naming the probe that failed — never a silent Docker
// The probe runs each binary once per process (`--version` for gcc, a bare `wibo`, which prints
// its usage) and caches the answer: one spawn per toolchain per process, against one per compile.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { GCC272_TOOLCHAIN, GCC_KMC_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, type MwccToolchainId, mwccDir } from './toolchain';

export type NativeMode = 'auto' | 'off' | 'on';

/** `ASMLIFT_NATIVE` parsed. An unrecognized value is an error, not a guess: a typo of `off` that
 *  silently ran natively would be an A/B run measuring the wrong arm. */
export function nativeMode(value: string | undefined = process.env.ASMLIFT_NATIVE): NativeMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'auto') {
    return 'auto';
  }
  if (v === '0' || v === 'off' || v === 'false' || v === 'no') {
    return 'off';
  }
  if (v === '1' || v === 'on' || v === 'true' || v === 'yes') {
    return 'on';
  }
  throw new Error(`ASMLIFT_NATIVE="${value}" — say auto (the default), 0/off, or 1/on`);
}

/** Can this host execute a 32-bit x86 Linux ELF at all? Only Linux on x86, where the kernel runs
 *  i386 binaries natively; everywhere else the probe would only fail, so it is not spawned. */
export const hostRunsI386Elf = (platform: string = process.platform, arch: string = process.arch): boolean =>
  platform === 'linux' && (arch === 'x64' || arch === 'ia32');

/** Did `bin args…` run, and print what `expect` matches? `error` set means the kernel could not
 *  execute it (missing, not executable, a dynamic binary without its loader). The exit status is
 *  deliberately not read: a bare `wibo` prints its usage and exits 1. */
export function binaryRuns(bin: string, args: readonly string[], expect: RegExp): boolean {
  const r = spawnSync(bin, [...args], { encoding: 'utf8', timeout: 10_000 });
  return r.error === undefined && expect.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
}

const probed = new Map<string, string | undefined>();

/** The probe's verdict for one toolchain, cached per process: undefined when it can run natively,
 *  else why not. */
function probe(key: string, check: () => string | undefined): string | undefined {
  if (!probed.has(key)) {
    probed.set(
      key,
      hostRunsI386Elf() ? check() : `this host (${process.platform}/${process.arch}) cannot run i386 ELFs`,
    );
  }
  return probed.get(key);
}

const gccProbe = (dir: string) => (): string | undefined => {
  const gcc = join(dir, 'gcc');
  if (!existsSync(gcc)) {
    return `${gcc} does not exist`;
  }
  return binaryRuns(gcc, ['--version'], /2\.7\.2/) ? undefined : `${gcc} --version did not run or did not say 2.7.2`;
};

const wiboProbe = (): string | undefined =>
  binaryRuns(MWCC_PPC_TOOLCHAIN.nativeWibo, [], /usage/i)
    ? undefined
    : `${MWCC_PPC_TOOLCHAIN.nativeWibo} did not run (a static wibo build is needed: the release asset, or ASMLIFT_NATIVE_WIBO)`;

/** Should this toolchain compile natively right now? Applies `ASMLIFT_NATIVE`: `off` is never,
 *  `auto` is the probe, `on` is the probe or a thrown error naming why it failed. */
function decide(what: string, why: string | undefined): boolean {
  const mode = nativeMode();
  if (mode === 'off') {
    return false;
  }
  if (why !== undefined && mode === 'on') {
    throw new Error(`ASMLIFT_NATIVE=on, but ${what} cannot run natively: ${why}`);
  }
  return why === undefined;
}

/** KMC GCC natively? */
export const kmcNative = (): boolean =>
  decide('KMC GCC', probe(`kmc|${GCC_KMC_TOOLCHAIN.dir}`, gccProbe(GCC_KMC_TOOLCHAIN.dir)));

/** Mario Party 3's GCC 2.7.2 natively? */
export const gcc272Native = (): boolean =>
  decide('GCC 2.7.2', probe(`gcc272|${GCC272_TOOLCHAIN.dir}`, gccProbe(GCC272_TOOLCHAIN.dir)));

/** This CodeWarrior build natively, through the host's wibo? The PowerPC objdump is not part of
 *  it: it ships in the container image only, so a dump still goes through Docker. */
export const mwccNative = (mwcc: MwccToolchainId): boolean =>
  decide(
    `CodeWarrior ${mwcc}`,
    probe(`wibo|${MWCC_PPC_TOOLCHAIN.nativeWibo}`, wiboProbe) ??
      (existsSync(join(mwccDir(mwcc), 'mwcceppc.exe')) ? undefined : `${mwccDir(mwcc)}/mwcceppc.exe does not exist`),
  );
