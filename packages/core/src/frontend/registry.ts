// asmlift — target→frontend dispatch. The entry points (pipeline / rank / report) ask for a
// frontend BY TARGET, never by importing a concrete lift. Registering a second ISA is a one-
// line addition here plus its own frontend module — not an edit to every entry point.
import type { TargetDescription } from '../target';
import type { Frontend } from './frontend';
import { mipsFrontend } from './mips';
import { ppcFrontend } from './ppc';
import { thumbFrontend } from './thumb';

// Keyed by TargetDescription.id. A target names its ISA; the frontend implements it.
const FRONTENDS: Record<string, Frontend> = {
  armv4t: thumbFrontend,
  mips: mipsFrontend,
  ppc: ppcFrontend,
};

/** The registered ISA ids (registry keys). test/contract-invariant.test.ts reflects over this
 *  so the frontend-contract property test covers EVERY registered frontend — a new ISA added
 *  here without a contract probe fails that test, rather than silently shipping a frontend
 *  that was never held to the "unmodelled ⇒ loud" contract. */
export function registeredFrontendIds(): string[] {
  return Object.keys(FRONTENDS);
}

/** Resolve the frontend for a target, or throw a clear error naming the missing id. */
export function frontendFor(target: TargetDescription): Frontend {
  const f = FRONTENDS[target.id];
  if (!f) {
    throw new Error(
      `no ISA frontend registered for target '${target.id}' (known: ${Object.keys(FRONTENDS).join(', ')})`,
    );
  }
  return f;
}
