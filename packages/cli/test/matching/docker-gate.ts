// Shared availability gates for suites that need the 32-bit toolchains (KMC GCC, CodeWarrior via
// wibo). The gate OWNS the console.warn, so a suite cannot skip silently: with a piece missing,
// every gated suite announces itself once and `describe.runIf(...)` skips green. All such suites
// must gate through this helper.
import { type MwccToolchainId, kmcAvailable, ppcDockerAvailable } from '@asmlift/toolchains';

/** KMC GCC/MIPS: its compiler dir, and a way to run it — natively on an x86 Linux host, else the
 *  Docker daemon (the public base image pulls itself). */
export function kmcGate(tag: string): boolean {
  const ok = kmcAvailable();
  if (!ok) {
    console.warn(`[${tag}] KMC GCC cannot run here (neither natively nor through Docker) — skipping its fixtures.`);
  }
  return ok;
}

/** mwcc-PPC path (daemon + locally-built image + the proprietary dir of ONE CodeWarrior build). The
 *  image stays required where the compile itself runs natively: the PowerPC objdump ships in it alone.
 *  The build is named by the caller: three of them are mounted at /mwcc by different fixtures, and
 *  a gate that probed one while the fixture compiled with another would skip, or run, for the
 *  wrong reason. */
export function ppcDockerGate(tag: string, mwcc: MwccToolchainId): boolean {
  const ok = ppcDockerAvailable(mwcc);
  if (!ok) {
    console.warn(
      `[${tag}] Docker/${mwcc} not available — skipping CodeWarrior fixtures. ` +
        `(image is a local build: docker build --platform linux/386 -t asmlift-ppc:latest packages/toolchains/ppc-docker; ` +
        `compiler dirs: $ASMLIFT_MWCC_ROOT/${mwcc})`,
    );
  }
  return ok;
}
