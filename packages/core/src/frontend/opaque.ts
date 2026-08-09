// asmlift — the single place that decides how an unmodelled instruction degrades its register
// destination. Every ISA frontend routes its decode `default` (and any case it chooses not to
// model) through `opaqueDest`, so the contract — "an unmodelled instruction/operand degrades to a
// LOUD failure, never a silent drop" — has ONE implementation. Every registered frontend is held
// to it in test/contract-invariant.test.ts.
//
// This module owns only the POLICY (which token is the destination, which are register sources).
// The frontend still owns the SSA plumbing (how to `read` a source and `write`/emit the result),
// because that is block-local state the policy must not touch.
//
// ─── A NOTE ON ALTERNATIVE MNEMONIC SPELLINGS ──────────────────────────────────────────────────
//
// Every ISA here accepts more than one spelling for some instructions, and the frontends handle
// that in two DIFFERENT ways on purpose. Which one is right is decided by the operands, not by
// taste:
//
//   * PURE SYNONYM — same operands, same semantics, different name. Normalise it in a name→name
//     table at the parse site, so every consumer of the mnemonic sees one name. Thumb does this
//     for `ldsh`/`ldrsh`, `ldsb`/`ldrsb`, `ldm`/`ldmfd`/`ldmia`, `stm`/`stmea`/`stmia`, which
//     ARM DDI 0029G Figure 1-6 gives a single encoding apiece.
//
//     The table is the right shape THERE because the mnemonic is read by more than the decode
//     switch — Thumb's `classifyXfer` matches it to tell a return from an indirect jump, the
//     `storeClass` below matches it to decide whether an unmodelled op may be skipped, and the
//     instruction-size walk tests it for `bl`. An alias arm on one `case` fixes one of those.
//
//   * EXTENDED MNEMONIC / PSEUDO-INSTRUCTION — different operand GRAMMAR, so no rename can
//     express it. Give it its own decode arm. MIPS `move rD,rS` (2 operands) is `addu rD,rS,zero`
//     (3); PPC `mr rD,rS` is `or rD,rS,rS`; PPC `slwi rD,rS,n` (3) is `rlwinm rD,rS,n,mb,me` (5,
//     with mask fields computed from n). Routing these through a table would be a category error.
//
// There is deliberately NO shared alias helper. As of writing, MIPS and PPC have no pure-synonym
// gap at all — every `unmodelled instruction` decline they produce across the whole benchmark is
// a genuinely unmodelled opcode (`lwc1`, `fmuls`, `fctiwz`, `subfe`, …), not a spelling — so such
// a helper would have exactly one caller. The bar for extracting one is the bar this module itself
// met: several frontends hand-copying the same policy AND observed drift between the copies.
//
// One thing that IS shared, and should stay shared: `display` below. A frontend that normalises
// spellings must still REPORT the one its input actually used, or a decline sends the reader
// looking for an instruction their disassembly does not contain.
import { FrontendUnsupportedError } from './errors';

export interface OpaquePolicy {
  /** true iff the token is a WRITABLE register destination in this ISA (post-`normalize`). */
  isReg: (s: string | undefined) => s is string;
  /** token cleanup before classification — e.g. Thumb strips `[`/`]` off a memory operand.
   *  Default: identity. */
  normalize?: (s: string) => string;
  /** true iff the register is hardwired-zero (MIPS `$zero`/`$0`): writing it is a no-op, so it is
   *  NOT a real destination and the instruction is safe to skip. Default: nothing is zero. */
  isZero?: (r: string) => boolean;
  /** Mnemonics that WRITE MEMORY in this ISA: the "no register destination ⇒ safe to fall
   *  through" premise is FALSE for stores — skipping one silently deletes the write (Thumb
   *  `stmia r0!, {…}`), and a store whose FIRST token is a register (MIPS `swl rt, off(base)`)
   *  would otherwise fabricate an opaque write to what is actually a SOURCE. An unmodelled
   *  instruction matching this pattern throws instead. Default: none (a frontend that models
   *  every store may omit it, but registered frontends are held to supplying one). */
  storeClass?: RegExp;
  /** attribution for thrown declines: the function being lifted (optionally "+ site"). */
  context?: string;
  /** How to SPELL the mnemonic in messages, when that differs from the name used to classify it.
   *  A frontend that normalises legacy spellings (Thumb `ldsh` -> `ldrsh`) classifies on the
   *  canonical name but must report the one the input file actually contains — otherwise a decline
   *  names an instruction the reader cannot find in their own .s. Defaults to `mnemonic`. */
  display?: string;
  /** Mnemonics PROVABLY effect-free — or deliberately transparent (Thumb push/pop frame ops) —
   *  in this ISA: the ONLY unmodelled no-destination instructions that may be skipped. Any other
   *  no-destination unmodelled instruction THROWS: a side-effect-only instruction (swi, syscall,
   *  sync, cache…) skipped silently is a deleted effect — a silent miscompile. Default: none. */
  skipSafe?: RegExp;
}

export interface OpaqueDest {
  /** the destination register token to make `opaque` (guaranteed a writable, non-zero reg). */
  dst: string;
  /** the register source-operand tokens, in order, to feed the `opaque` op (already normalized). */
  srcRegs: string[];
}

/** Decide the opaque destination + register source operands for an unmodelled instruction
 *  `mnemonic` with operand list `ops` (operands in objdump order — destination first). Returns
 *  `null` only when the instruction is provably skippable: a write to a hardwired-zero register,
 *  or a policy.skipSafe mnemonic. An unmodelled STORE-CLASS instruction (policy.storeClass)
 *  throws loud (a skipped memory write is a silent miscompile) — and so does any OTHER
 *  no-destination instruction not in skipSafe: with no register to degrade to a live-`?`
 *  sentinel, skipping would silently delete a side effect (swi/syscall/sync/cache).
 *
 *  When non-null, the caller MUST emit an `opaque` op that writes `dst` and consumes `srcRegs`
 *  (read through the frontend's own SSA): a DEAD opaque is DCE'd away harmlessly, while a LIVE one
 *  reaches structuring as the sentinel `?` and trips `assertResolved` — the loud failure the
 *  contract requires, instead of a stale/absent value surfacing as confidently-wrong source. */
export function opaqueDest(mnemonic: string, ops: string[], policy: OpaquePolicy): OpaqueDest | null {
  const shown = policy.display ?? mnemonic;
  if (policy.storeClass?.test(mnemonic)) {
    // `context` names the function (and, where the ISA has addresses, the site) — this message
    // lands verbatim in annotate-mode stub headers, where an un-attributed decline is
    // unactionable in a multi-function run.
    const where = policy.context ? `cannot lift '${policy.context}': ` : '';
    throw new FrontendUnsupportedError(
      `${where}unmodelled store-class instruction '${shown}' — a memory write cannot be skipped or degraded to a register opaque`,
    );
  }
  const norm = policy.normalize ?? ((s) => s);
  const dst = norm(ops[0] ?? '');
  if (!policy.isReg(dst)) {
    if (policy.skipSafe?.test(mnemonic)) {
      return null;
    } // explicitly transparent for this ISA
    const where = policy.context ? `cannot lift '${policy.context}': ` : '';
    throw new FrontendUnsupportedError(
      `${where}unmodelled effect instruction '${shown}' — no register destination to degrade, and skipping it would silently delete its effect`,
    );
  }
  if (policy.isZero?.(dst)) {
    return null;
  } // writes hardwired zero → a genuine no-op
  const srcRegs = ops.slice(1).map(norm).filter(policy.isReg);
  return { dst, srcRegs };
}
