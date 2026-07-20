// Shared Docker availability gates for suites that need the dockerized toolchains (KMC-GCC
// linux/386, mwcc-PPC via wibo). The gate OWNS the console.warn, so a suite cannot skip silently:
// with the daemon (or image/toolchain dir) missing, every gated suite announces itself once and
// `describe.runIf(...)` skips green. All dockerized suites must gate through this helper.
import { dockerAvailable, ppcDockerAvailable } from '@asmlift/toolchains';

/** KMC-GCC/MIPS path (public base image, daemon check only). */
export function dockerGate(tag: string): boolean {
  const ok = dockerAvailable();
  if (!ok) {
    console.warn(`[${tag}] Docker not available — skipping dockerized fixtures.`);
  }
  return ok;
}

/** mwcc-PPC path (daemon + locally-built image + proprietary CodeWarrior dir). */
export function ppcDockerGate(tag: string): boolean {
  const ok = ppcDockerAvailable();
  if (!ok) {
    console.warn(
      `[${tag}] Docker/mwcc toolchain not available — skipping CodeWarrior fixtures. ` +
        `(image is a local build: docker build -t asmlift-ppc:latest packages/toolchains/ppc-docker; ` +
        `compiler dir: ASMLIFT_MWCC_DIR)`,
    );
  }
  return ok;
}
