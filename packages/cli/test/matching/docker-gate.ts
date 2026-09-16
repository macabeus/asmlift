// Shared Docker availability gates for suites that need the dockerized toolchains (KMC-GCC
// linux/386, mwcc-PPC via wibo). The gate OWNS the console.warn, so a suite cannot skip silently:
// with the daemon (or image/toolchain dir) missing, every gated suite announces itself once and
// `describe.runIf(...)` skips green. All dockerized suites must gate through this helper.
import { type MwccToolchainId, dockerAvailable, ppcDockerAvailable } from '@asmlift/toolchains';

/** KMC-GCC/MIPS path (public base image, daemon check only). */
export function dockerGate(tag: string): boolean {
  const ok = dockerAvailable();
  if (!ok) {
    console.warn(`[${tag}] Docker not available — skipping dockerized fixtures.`);
  }
  return ok;
}

/** mwcc-PPC path (daemon + locally-built image + the proprietary dir of ONE CodeWarrior build).
 *  The build is named by the caller: three of them are mounted at /mwcc by different fixtures, and
 *  a gate that probed one while the fixture compiled with another would skip, or run, for the
 *  wrong reason. */
export function ppcDockerGate(tag: string, mwcc: MwccToolchainId): boolean {
  const ok = ppcDockerAvailable(mwcc);
  if (!ok) {
    console.warn(
      `[${tag}] Docker/${mwcc} not available — skipping CodeWarrior fixtures. ` +
        `(image is a local build: docker build -t asmlift-ppc:latest packages/toolchains/ppc-docker; ` +
        `compiler dirs: $ASMLIFT_MWCC_ROOT/${mwcc})`,
    );
  }
  return ok;
}
