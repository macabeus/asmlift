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
  /** The FPU's register operands in this ISA, and the FPU's ALONE — the message this produces
   *  names the floating-point register file in so many words, so a second unmodelled file (MIPS
   *  CP0, `hi`/`lo`, PowerPC's condition registers and SPRs) needs its own field and its own
   *  sentence rather than one more alternative here. An unmodelled instruction touching one is
   *  refused with a message naming that file, because the missing capability is the FILE, not the
   *  instruction: there is no value kind to hold what it computes, no ABI home to receive it, and
   *  no C spelling to print it. `docs/floating-point.md` measures the gap and prices the layers.
   *
   *  Tested against EVERY operand, not just `ops[0]`, and the two shapes that force it are on
   *  opposite sides: `fcmpo cr0,f1,f2` has a destination `isReg` REJECTS (a condition register) and
   *  `mfc1 v0,$f12` one it ACCEPTS. A destination-only test files the first under "no register
   *  destination to degrade" and lets the second fabricate an opaque whose sources silently drop
   *  the FP operand it actually read. Both are floating point and neither is about the destination.
   *
   *  IT MUST COVER EVERY DIALECT THE FRONTEND READS AND EVERY SPELLING EACH OF THEM USES, because
   *  a frontend can be fed more than one name for the same register: MIPS objdump numbers the file
   *  (`$f12`), the Splat trees use o32 ABI names (`$ft2`), and those names take a trailing `f` for
   *  the odd half of a double-precision pair (`$ft0f`) — so a pattern anchored on a final digit
   *  covers two of the three. Every miss is SILENT in the same way: the reader strips the sigil
   *  off a token it did not recognise, `isMipsReg` ACCEPTS the bare result, and the gap ends as an
   *  opaque on a register in a file nothing models. MIPS answers this with ONE predicate — the
   *  exported `MIPS_FP_REG` in `frontend/splat.ts`, which the reader and the frontend both use —
   *  because which tokens keep their sigil and which tokens are the FPU's are two halves of one
   *  decision, and two copies of it can disagree silently in either direction.
   *
   *  A CONTROL TRANSFER IS NOT THIS MODULE'S, even when the FPU is what it is missing. MIPS
   *  `bc1t`/`bc1f` test an FP condition code, and PowerPC branch targets are bare lower-case hex
   *  that PowerPC's own `fpReg` matches — but a branch has no destination to degrade, so nothing
   *  here could answer one, and both frontends refuse unmodelled control flow in a whole-function
   *  pre-pass before a block is filled. The report keeps them as their own class for the same
   *  reason (`fp-cond-branch` in `apps/web/src/pages/benchmark/lib/declines.ts`): the missing file
   *  is shared, the mechanism is not.
   *
   *  It is consulted FIRST, ahead of `storeClass`, so `swc1`/`stfs` are named by the file they move
   *  rather than by the fact that they move it to memory. That ordering is what the web report's
   *  decline table already assumes, and it could only assume it by re-deriving "is this floating
   *  point?" from a list of mnemonics this module never told it.
   *
   *  REQUIRED, and `null` is the way to say "this ISA has no FPU" — an optional refusal is one the
   *  next frontend switches off by forgetting it, and the symptom is the message this field exists
   *  to remove. */
  fpReg: RegExp | null;
  /** FPU instructions that name no `fpReg` operand at all, matched on the MNEMONIC because there
   *  is nothing else to match: they address the FPU's CONTROL register, which is spelled in the
   *  ISA's OTHER namespace — MIPS `cfc1 rt,$31` / `ctc1 rt,$31` take a GPR and a coprocessor
   *  control number, PowerPC's `mtfsfi`/`mtfsb0`/`mtfsb1`/`mcrfs` take a field number and a
   *  condition register. A register-name predicate cannot see them, so without this they fall to
   *  the general arms and are filed as the generic opaque gap — and `ctc1`'s `ops[0]` is the
   *  instruction's SOURCE, so an opaque would be fabricated on a register it only reads.
   *
   *  The FPU moves that DO name a data register (`mfc1`, `mtc1`, `mffs`, `mtfsf`) are `fpReg`'s,
   *  not this one's. Same message phrase either way, because it is the same missing capability.
   *
   *  REQUIRED for the same reason as `fpReg`; `null` says the ISA has no FPU control register to
   *  reach. */
  fpControl: RegExp | null;
  /** Mnemonics that WRITE MEMORY in this ISA: the "no register destination ⇒ safe to fall
   *  through" premise is FALSE for stores — skipping one silently deletes the write (Thumb
   *  `stmia r0!, {…}`), and a store whose FIRST token is a register (MIPS `swl rt, off(base)`)
   *  would otherwise fabricate an opaque write to what is actually a SOURCE. An unmodelled
   *  instruction matching this pattern throws instead. REQUIRED, with `null` for a frontend that
   *  models every store in its ISA — held to it by the type, because the sentence that said
   *  "registered frontends are held to supplying one" was held to it by nothing. */
  storeClass: RegExp | null;
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
 *  instruction that touches the FLOATING-POINT unit — naming one of its registers (policy.fpReg)
 *  or, for the control-register moves that name none, matching policy.fpControl — is refused
 *  first, because the file is the capability and the instruction is only where it surfaced; an
 *  unmodelled STORE-CLASS instruction (policy.storeClass) throws next (a skipped memory write is a
 *  silent miscompile); and so does any instruction with no degradable destination: with no register
 *  to carry the live-`?` sentinel, skipping would silently delete a side effect (swi/syscall/sync/
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
 *  None of `fpReg`, `fpControl` and `storeClass` is load-bearing for SOUNDNESS — every instruction
 *  that reaches this function declines whatever arm takes it, because an `opaque` carries
 *  `effects: true` and reaches `assertResolved` whether or not anything reads it. What they buy is
 *  WHICH capability the decline names, and that is the whole content of a decline. Two of them buy
 *  one thing more: they catch the shapes where `ops[0]` is a SOURCE (MIPS `swl rt, off(base)`,
 *  `ctc1 rt, $31`) before a `dst` is fabricated from a register the instruction only reads.
 *  They and `skipSafe` match case-INSENSITIVELY: mnemonic case is a property of the disassembler,
 *  not of the instruction. */
export function opaqueDest(mnemonic: string, ops: string[], policy: OpaquePolicy): OpaqueDest | null {
  const shown = policy.display ?? mnemonic;
  const norm = policy.normalize ?? ((s) => s);
  // `context` names the function (and, where the ISA has addresses, the site) — every message
  // below lands verbatim in annotate-mode stub headers, where an un-attributed decline is
  // unactionable in a multi-function run.
  const where = policy.context ? `cannot lift '${policy.context}': ` : '';
  const fpReg = policy.fpReg;
  // DEDUPED: `fadds f1,f1,f2` names two registers, not three, and the message is read by a human
  // asking which file is missing.
  const fp = fpReg ? [...new Set(ops.map(norm).filter((o) => fpReg.test(o)))] : [];
  if (fp.length > 0) {
    throw new FrontendUnsupportedError(
      `${where}unmodelled floating-point instruction '${shown}' — it uses the floating-point ` +
        `register file (${fp.join(', ')}), which this frontend does not model`,
    );
  }
  if (policy.fpControl?.test(mnemonic)) {
    throw new FrontendUnsupportedError(
      `${where}unmodelled floating-point instruction '${shown}' — it uses the floating-point ` +
        `control register, which this frontend does not model`,
    );
  }
  if (policy.storeClass?.test(mnemonic)) {
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
    throw new FrontendUnsupportedError(
      `${where}unmodelled effect instruction '${shown}' — no register destination to degrade, and skipping it would silently delete its effect`,
    );
  }
  const srcRegs = ops.slice(1).map(norm).filter(policy.isReg);
  return { dst, srcRegs };
}
