// asmlift — the HIGH HALF of a relocated address, shared by the MIPS and PowerPC frontends.
//
// Both ISAs materialise a global's address in two instructions: a high-half producer (`lis
// rD,SYM@ha`, `lui rD,%hi(SYM)`) and a low-half consumer (`addi rD,rHi,SYM@l`, `lw rD,%lo(SYM)(rHi)`)
// that completes it. In a RELOCATABLE object neither printed immediate carries the address — it
// lives entirely in the two relocation records — so the high half is NOT A VALUE but a placeholder
// that means nothing until its matching low half completes it. Letting one reach the IR as an
// ordinary number hands the pipeline a plausible address that compiles and is simply wrong, so the
// invariant is absolute: a placeholder is either consumed by its low half or refuses.
//
// KEYED BY VALUE, NOT BY REGISTER, and the difference is the whole point. A register-keyed map
// answers "was a high half put in rX?", which is not the question; the question is "does the half
// reach THIS read?". Those differ whenever a redefinition on any path erases the entry, or a
// sibling path the reader never takes writes the register — and the register-keyed reading then
// falls through to whatever def reached before the producer. Keying by the SSA value makes the
// pairing a PROOF, answered by SSA rather than by a side map with an invalidation discipline every
// future writer must maintain.
//
// WHAT EACH ISA KEEPS FOR ITSELF is the ADDEND, and it is a relocation-format fact, not a
// preference. PowerPC objects are RELA: the addend rides on the relocation record. MIPS objects are
// REL: the record has no addend field and the value is split across the two instruction immediates
// (`(hi_imm << 16) + (s16)lo_imm`), so the MIPS fold computes the high half's contribution itself.
// Either way `addend` is "the part of the address this producer contributed", and the consumer adds
// its own.
import type { Block, Value } from '../ir/core';

/** A pending high half: what it names, what it contributed, and the instruction that produced it,
 *  so a refusal can point a reader at it. Whether it has been consumed is deliberately NOT here: it
 *  is this module's own bookkeeping, set by `pair`, so no frontend can fold a pair and forget to
 *  mark it — forgetting would refuse a well-formed function with nothing to catch it. */
export interface HighHalfInfo {
  sym: string;
  /** This producer's contribution to the address — RELA carries it, REL computes it. */
  addend: number;
  addr: number;
  mnemonic: string;
}

/** How one ISA spells the two halves in a refusal, and how it fails loud. */
export interface HighHalfDialect {
  /** The high-half marker as the ISA's asm spells it: `@ha` (PowerPC), `%hi` (MIPS). */
  hi: string;
  /** The indefinite article `hi` takes, so one shared sentence reads right in both ISAs' asm. */
  hiArticle: string;
  /** The low-half marker: `@l` (PowerPC), `%lo` (MIPS). */
  lo: string;
  /** The frontend's designed loud-failure signal (`PpcUnsupportedError`, `FrontendUnsupportedError`). */
  fail(message: string): never;
}

export interface HighHalves {
  /** Record the placeholder `v` as the high half `info`. The producer writes `v` as an ordinary SSA
   *  definition, which is what lets SSA answer the pairing question later. */
  record(v: Value, info: HighHalfInfo): void;
  /** THE PAIRING. `v` is what the low half's base register holds HERE; it must be the very
   *  placeholder a producer defined, and the two halves must name the same symbol (`alsoMatches`
   *  adds the per-ISA rest of the match — PowerPC's RELA addend). Anything else refuses, naming
   *  `reg` and what it really holds. The half is CONSUMED on the way out, which is why this is a
   *  call and not a public flag: the mark and the proof cannot come apart. */
  pair(site: string, reg: string, v: Value, loSym: string, alsoMatches?: (hi: HighHalfInfo) => boolean): HighHalfInfo;
  /** True when `v` is a placeholder — for a caller that must EXCLUDE one (a call's argument count
   *  must not treat a half parked in an argument register as an argument). */
  has(v: Value): boolean;
  /** Reading a register AS A VALUE. A register holding a high half is not one, so this refuses
   *  rather than handing back a plausible number standing for an address. */
  guardRead(name: string, reg: string, v: Value): Value;
  /** A high half no low half ever completed. Finishing the lift would SILENTLY DROP the address it
   *  was building — every low-half consumer a frontend does not model lands here, which is what
   *  keeps "not modelled" from turning into "not emitted". */
  assertAllConsumed(name: string): void;
  /** The LAST line of defence, because `guardRead` sees only the reads a frontend routes through
   *  it. SSA builds a block parameter's incoming arguments with reads of its own: at a merge of a
   *  path that holds a half and a path that does not, the read returns the PARAMETER — an ordinary
   *  value — while the placeholder is appended to the predecessor's successor arguments. So the
   *  finished function is checked once: a placeholder anywhere in the IR refuses. */
  assertNoneEscaped(name: string, blocks: Block[]): void;
}

export function makeHighHalves(d: HighHalfDialect): HighHalves {
  const halves = new Map<Value, { info: HighHalfInfo; consumed: boolean }>();
  return {
    record: (v, info) => void halves.set(v, { info, consumed: false }),
    has: (v) => halves.has(v),
    pair(site, reg, v, loSym, alsoMatches) {
      const entry = halves.get(v);
      const hi = entry && entry.info.sym === loSym && (alsoMatches?.(entry.info) ?? true) ? entry.info : undefined;
      if (!hi) {
        d.fail(
          `${site} carries the '${d.lo}' half of '${loSym}' but ${reg} ` +
            (entry
              ? `holds the high half of '${entry.info.sym}'`
              : `holds no high half here — a reused register, a missing '${d.hi}', or ${d.hiArticle} ` +
                `'${d.hi}' that reaches this instruction only through a merge or a loop header, where ` +
                `what the register holds is the block parameter standing for the join and not the half`) +
            ` — this frontend will not guess at the pair`,
        );
      }
      entry!.consumed = true;
      return hi;
    },
    guardRead(name, reg, v) {
      const hi = halves.get(v)?.info;
      if (hi) {
        d.fail(
          `cannot lift '${name}': ${reg} holds the high half of '${hi.sym}' (the '${hi.mnemonic}' at ` +
            `0x${hi.addr.toString(16)}) and is read as a value — only its matching '${d.lo}' half may consume it`,
        );
      }
      return v;
    },
    assertAllConsumed(name) {
      // Lowest address first, so a function with several dangling halves names the one a reader
      // meets first in the listing rather than whichever the map happened to iterate to.
      const dangling = [...halves.values()]
        .filter((h) => !h.consumed)
        .map((h) => h.info)
        .sort((a, b) => a.addr - b.addr)[0];
      if (dangling) {
        d.fail(
          `cannot lift '${name}': '${dangling.mnemonic}' at 0x${dangling.addr.toString(16)} carries the ` +
            `'${d.hi}' half of '${dangling.sym}' and no modelled instruction consumes its '${d.lo}' half — ` +
            `the address is never completed`,
        );
      }
    },
    assertNoneEscaped(name, blocks) {
      const escaped = (v: Value): void => {
        const hi = halves.get(v)?.info;
        if (hi) {
          d.fail(
            `cannot lift '${name}': the high half of '${hi.sym}' (the '${hi.mnemonic}' at ` +
              `0x${hi.addr.toString(16)}) reaches a merge with values that are not it — what the register ` +
              `holds there is not a value this frontend can write down`,
          );
        }
      };
      for (const b of blocks) {
        b.params.forEach(escaped);
        for (const op of b.ops) {
          op.operands.forEach(escaped);
          op.results.forEach(escaped);
          for (const s of op.successors) {
            s.args.forEach(escaped);
          }
        }
      }
    },
  };
}
