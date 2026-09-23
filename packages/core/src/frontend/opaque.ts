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
  /** true iff the register is hardwired-zero (MIPS `$zero`/`$0`). It is then not a real
   *  destination — so there is nothing to degrade and the instruction is REFUSED, not skipped
   *  (`teq zero, zero` is a trap). Default: nothing is zero. */
  isZero?: (r: string) => boolean;
  /** Registers this ISA HAS and asmlift models no file for — today the FPU's alone (MIPS `$f0`,
   *  PowerPC `f1`). An unmodelled instruction touching one is refused with a message naming that
   *  file, because the missing capability is the FILE, not the instruction: there is no value kind
   *  to hold what it computes, no ABI home to receive it, and no C spelling to print it.
   *
   *  Tested against EVERY operand, not just `ops[0]`, and the two shapes that force it are on
   *  opposite sides: `fcmpo cr0,f1,f2` has a destination `isReg` REJECTS (a condition register) and
   *  `mfc1 v0,$f12` one it ACCEPTS. A destination-only test files the first under "no register
   *  destination to degrade" and lets the second fabricate an opaque whose sources silently drop
   *  the FP operand it actually read. Both are floating point and neither is about the destination.
   *
   *  It is consulted FIRST, ahead of `storeClass`, so `swc1`/`stfs` are named by the file they move
   *  rather than by the fact that they move it to memory. That ordering is what the web report's
   *  decline table already assumes, and it could only assume it by re-deriving "is this floating
   *  point?" from a list of mnemonics this module never told it. Default: none. */
  fpReg?: RegExp;
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
  /** Mnemonics PROVABLY effect-free — or deliberately transparent (Thumb push/pop frame ops) — in
   *  this ISA: the only unmodelled instructions that may be skipped at all. Anything else with no
   *  degradable destination THROWS, because a side-effect-only instruction (swi, syscall, sync,
   *  cache…) skipped silently is a deleted effect. Default: none. */
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
 *  `null` only for a policy.skipSafe mnemonic. Three arms throw instead, in this order: an
 *  instruction naming a register from an UNMODELLED FILE (policy.fpReg) is refused first, because
 *  the file is the capability and the instruction is only where it surfaced; an unmodelled
 *  STORE-CLASS instruction (policy.storeClass) throws next (a skipped memory write is a silent
 *  miscompile); and so does any instruction with no degradable destination: with no register to
 *  carry the live-`?` sentinel, skipping would silently delete a side effect (swi/syscall/sync/
 *  cache).
 *
 *  When non-null, the caller MUST emit an `opaque` op that writes `dst` and consumes `srcRegs`
 *  (read through the frontend's own SSA). It reaches structuring as the sentinel `?` and trips
 *  `assertResolved` — the loud failure the contract requires — WHETHER OR NOT anything reads `dst`;
 *  `opaque` carries `effects: true` (ir/opcodes.ts) for the same reason `call` does.
 *
 *  Two properties of `ops[0]` read as permission to skip and are not. Both describe the
 *  DESTINATION, while the risk is everything else the instruction does:
 *    - nobody reads it — a dead register says nothing about a memory or system effect;
 *    - it is hardwired zero — MIPS `teq zero, zero` is a conditional TRAP.
 *  So `skipSafe`, a short per-ISA list of provably transparent mnemonics, is the only way an
 *  unmodelled instruction leaves no trace.
 *
 *  Neither `fpReg` nor `storeClass` is load-bearing for SOUNDNESS — every instruction that reaches
 *  this function declines whatever arm takes it, because an `opaque` carries `effects: true` and
 *  reaches `assertResolved` whether or not anything reads it. What they buy is WHICH capability the
 *  decline names, and that is the whole content of a decline. `storeClass` is not load-bearing for
 *  soundness — a missed store degrades loudly like anything
 *  else — but it throws naming the memory write instead of an unresolvable value, and it catches
 *  the shape where `ops[0]` is a SOURCE (MIPS `swl rt, off(base)`) before a `dst` is fabricated
 *  from it. It and `skipSafe` match case-INSENSITIVELY: mnemonic case is a property of the
 *  disassembler, not of the instruction. */
export function opaqueDest(mnemonic: string, ops: string[], policy: OpaquePolicy): OpaqueDest | null {
  const shown = policy.display ?? mnemonic;
  const norm = policy.normalize ?? ((s) => s);
  const fpReg = policy.fpReg;
  const fp = fpReg ? ops.map(norm).filter((o) => fpReg.test(o)) : [];
  if (fp.length > 0) {
    const where = policy.context ? `cannot lift '${policy.context}': ` : '';
    throw new FrontendUnsupportedError(
      `${where}unmodelled floating-point instruction '${shown}' — it uses the floating-point ` +
        `register file (${fp.join(', ')}), which this frontend does not model`,
    );
  }
  if (policy.storeClass?.test(mnemonic)) {
    // `context` names the function (and, where the ISA has addresses, the site) — this message
    // lands verbatim in annotate-mode stub headers, where an un-attributed decline is
    // unactionable in a multi-function run.
    const where = policy.context ? `cannot lift '${policy.context}': ` : '';
    throw new FrontendUnsupportedError(
      `${where}unmodelled store-class instruction '${shown}' — a memory write cannot be skipped or degraded to a register opaque`,
    );
  }
  const dst = norm(ops[0] ?? '');
  // No DEGRADABLE destination: `ops[0]` is not a register, or it is the hardwired zero. Same answer
  // for both — a zero write is a genuine no-op only for a MODELLED instruction, and by construction
  // nothing modelled reaches here.
  if (!policy.isReg(dst) || policy.isZero?.(dst)) {
    if (policy.skipSafe?.test(mnemonic)) {
      return null;
    } // explicitly transparent for this ISA
    const where = policy.context ? `cannot lift '${policy.context}': ` : '';
    throw new FrontendUnsupportedError(
      `${where}unmodelled effect instruction '${shown}' — no register destination to degrade, and skipping it would silently delete its effect`,
    );
  }
  const srcRegs = ops.slice(1).map(norm).filter(policy.isReg);
  return { dst, srcRegs };
}
