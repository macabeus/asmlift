// CONTRACT-AS-INVARIANT — the structural property test for the project's most-recurring defect.
//
// The contract every ISA frontend must honor: an instruction it does not model must degrade to a
// LOUD failure — an `opaque` value that trips the boundary contract (`assertResolved`), or a thrown
// unsupported-error — NEVER a silent drop that leaves a stale/absent register value surfacing as
// confidently-wrong source. Every fresh frontend has violated this at least once (Thumb decode,
// PPC decode, PPC frame), because the guard was a per-frontend convention re-typed and
// re-forgotten. This test makes the convention an INVARIANT: a bare silent drop in ANY present or
// future frontend becomes a build failure.
//
// It is oracle-free (no reference compiler): it never asserts the output is *correct*, only that an
// unmodelled construct fails loud, and that a DEAD unmodelled op is harmless (so the guard is
// precise, not a blunt "throw on anything unfamiliar"). Fully offline.
//
// SCOPE — read this before trusting the name. This test makes the DEFAULT/unmodelled-mnemonic path
// structural: a bare silent drop in ANY frontend's decode default becomes a build failure (Layers
// 1–4 + the lint). It does NOT prove the *absence* of every possible silent miscompile — a silent
// drop hidden inside a *modelled* `case` (one that handles the mnemonic but mishandles an operand
// shape, or drops an IMPLICIT destination like a call's return register) is not reachable from the
// default path. Those classes are covered by the curated `mustFailLoud` list per ISA (Layer 5),
// which regression-locks specific known silent miscompiles
// (MIPS `jal`/`jalr` call-drop, `jr <non-ra>` misclassification, Thumb `rsb #N`) — but that list is
// enumerated, not exhaustive. The honest claim: the recurring *default-path* defect is retired
// structurally; specific known modelled-case defects are pinned; new modelled-case defects still
// need their own probe.
//
// Layers:
//   1. Registry completeness — every registered frontend MUST have a probe whose target routes to
//      THAT frontend, so adding an ISA without proving it fails loud breaks the build.
//   2. Per-frontend live/dead behavioral probes — the canonical shape of the contract, with a raw-IR
//      check that the DEAD case genuinely emitted an opaque (present-then-DCE'd, not never-emitted).
//   3. Negative-space corpus — real, plausible, UNMODELLED opcodes per ISA (the near-miss class the
//      audits actually found), each with a live destination, all must fail loud.
//   4. Seeded garbage fuzz — `zz`-prefixed random mnemonics (guaranteed unmodelled in every ISA).
//   5. mustFailLoud — ISA-specific constructs OUTSIDE the default path (calls, indirect jumps, bad
//      operand shapes) that must fail loud; regression-locks known modelled-case defects.
//   + Structural lint — every frontend routes its decode default to the shared opaque emitter and
//     contains no silent-drop default form; the file list is derived from the registry, not hardcoded.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { ContractError } from '../src/contracts';
import { FrontendUnsupportedError } from '../src/frontend/errors';
import { frontendFor, registeredFrontendIds } from '../src/frontend/registry';
import { print } from '../src/ir/print';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '../src/target';

// The DESIGNED loud-failure classes. A degradation must be ONE of these — not an incidental crash
// (TypeError/RangeError/…), which would mean the frontend blew up by accident rather than failing
// the contract on purpose. `expectLoud` fails the test on any other error, so a parse/indexing bug
// can never masquerade as "it threw, so the contract holds." Checked by `instanceof` (not name
// strings), so a frontend that subclasses FrontendUnsupportedError — as PpcUnsupportedError does —
// is loud by construction rather than by remembering to extend a whitelist.
const isDesignedLoud = (e: unknown) => e instanceof FrontendUnsupportedError || e instanceof ContractError;
function expectLoud(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    if (!isDesignedLoud(e)) {
      throw new Error(
        `expected a designed loud failure (FrontendUnsupportedError/ContractError), got ${(e as Error)?.name}: ${(e as Error)?.message}`,
      );
    }
    return;
  }
  throw new Error('expected a loud failure, but decompile succeeded (silent miscompile risk)');
}

// A probe knows how to build, in one ISA's assembly, a function whose body is a single instruction
// with mnemonic `m` writing the RETURN register (a LIVE destination) — and a companion DEAD case
// where an unmodelled op writes a throwaway register and the real return is a plain modelled value.
interface Probe {
  target: TargetDescription;
  /** wrap an assembly body into the full text `decompile` expects for this ISA. */
  wrap: (sym: string, body: string) => string;
  /** an unmodelled instruction `m` writing the return register → its result is returned (LIVE). */
  live: (m: string) => string;
  /** a DEAD case: `m` writes a throwaway reg; the return is an ordinary modelled value. */
  dead: string;
  /** the exact source the DEAD case must still produce (proving the opaque was harmless). */
  deadSource: string;
  /** real, plausible, UNMODELLED opcodes in this ISA, each with a register destination. */
  negativeSpace: string[];
  /** ISA-specific constructs OUTSIDE the shared default path (calls, indirect jumps, bad operand
   *  shapes) that must fail loud. Each is `[label, asm-body]`. Regression-locks silent miscompiles
   *  the operand-destination guard alone cannot see. May be empty. */
  mustFailLoud: [string, string][];
}

const PROBES: Record<string, Probe> = {
  // Thumb / agbcc — no address prefixes; `bx lr` returns r0. `reg,reg` operand shape.
  armv4t: {
    target: ARMV4T_AGBCC,
    wrap: (sym, body) => `${sym}:\n${body}`,
    live: (m) => `\t${m}\tr0, r0\n\tbx\tlr\n`,
    dead: `\tclz\tr1, r0\n\tadd\tr0, r0, #1\n\tbx\tlr\n`,
    deadSource: 's32 clzdead(s32 a0) {\n    return a0 + 1;\n}\n',
    negativeSpace: ['clz', 'rev', 'rev16', 'revsh', 'sxtb', 'sxth', 'uxtb', 'uxth', 'adc', 'sbc'],
    // A modelled `rsb` with a non-#0 immediate must not silently leave rD unwritten.
    mustFailLoud: [
      ['rsb #5 (modelled case, unmodelled operand)', '\trsb\tr0, r0, #5\n\tbx\tlr\n'],
      // F7 modelled-case guards: ldmia/stmia/bic gained decodes; the MALFORMED shapes stay loud
      // (the no-writeback `ldmia rN, {…}` is a VALID form now modelled, not malformed — not here).
      ['ldmia with an empty reglist', '\tldmia\tr0!, {}\n\tadd\tr0, r0, #1\n\tbx\tlr\n'],
      ['1-operand bic (malformed)', '\tbic\tr0\n\tbx\tlr\n'],
    ],
  },
  // MIPS / IDO — objdump-style `addr:\tmnem\tops`; `jr ra` returns v0. Delay slot follows.
  mips: {
    target: MIPS_IDO,
    wrap: (_sym, body) => body,
    live: (m) => `0:\t${m}\tv0,a0\n4:\tjr\tra\n8:\tnop\n`,
    dead: `0:\tclz\tt0,a0\n4:\tjr\tra\n8:\taddiu\tv0,a0,1\n`,
    deadSource: 's32 clzdead(s32 a0) {\n    return a0 + 1;\n}\n',
    negativeSpace: ['clz', 'clo', 'seb', 'seh', 'rotr', 'wsbh'],
    // A call's return register is an IMPLICIT destination the operand guard cannot see; an
    // indirect `jr` is not a plain return. All must fail loud, not vanish.
    mustFailLoud: [
      ['jal (call return reg dropped)', '0:\tjal\t100 <foo>\n4:\tnop\n8:\taddiu\tv0,v0,1\nc:\tjr\tra\n10:\tnop\n'],
      ['jalr (indirect call)', '0:\tjalr\tt9\n4:\tnop\n8:\taddiu\tv0,v0,1\nc:\tjr\tra\n10:\tnop\n'],
      ['jr <non-ra> (indirect jump / jump table)', '0:\tlw\tt9,0(a0)\n4:\tjr\tt9\n8:\tnop\n'],
    ],
  },
  // PPC / mwcc — objdump-style; `blr` returns r3. `rD,rA,rB` operand shape.
  ppc: {
    target: PPC_MWCC,
    wrap: (sym, body) => `0 <${sym}>:\n${body}`,
    live: (m) => `0:\t${m}\tr3,r3,r4\n4:\tblr\n`,
    // `rlwnm` (unmodelled: rotate-by-register-then-mask) is the DEAD opaque generator — `mulhw` does not qualify: it is
    // MODELLED (→ transient `mulh` for magic-division). `mulhw`/`mulhwu` STAY in negativeSpace: a
    // LIVE one lifts to `mulh`/`mulhu`, which have no C spelling → still loud-fails at the
    // structurer boundary.
    dead: `0:\trlwnm\tr5,r3,r4,0,31\n4:\tadd\tr3,r3,r4\n8:\tblr\n`,
    deadSource: 's32 clzdead(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
    // `divw`/`divwu` are MODELLED (→ sdiv/udiv), so they are not in this corpus.
    negativeSpace: ['mulhw', 'mulhwu', 'rlwnm'],
    // Shapes the operand guard cannot see: an indirect/CTR branch (no data dest) and an
    // SDA/global access (fabricated pointer param). Both fail loud — pin them so they stay so.
    mustFailLoud: [
      ['bctr (indirect / CTR branch)', '0:\tbctr\n'],
      ['stw to SDA/global (non-register base)', '0:\tstw\tr3,0(0)\n4:\tblr\n'],
    ],
  },
};

const decodes = (p: Probe, sym: string, body: string) => decompile(sym, p.wrap(sym, body), p.target);

// ── Layer 1: registry completeness ──────────────────────────────────────────────────────────────
// Reflect over the registry: any frontend without a probe here is a frontend never held to the
// contract. This is the teeth — a new ISA can't ship without proving it degrades loud.
describe('CONTRACT-AS-INVARIANT: every registered frontend is covered', () => {
  test('each registered frontend has a contract probe', () => {
    const registered = registeredFrontendIds().sort();
    const probed = Object.keys(PROBES).sort();
    expect(probed).toEqual(registered);
  });

  // A probe whose `target.id` differs from its key would exercise a DIFFERENT frontend (decompile
  // routes purely by target.id) — a future ISA could then be "covered" by a probe pointing at an
  // already-passing frontend and never actually be tested. Bind key ↔ target so that can't happen.
  test("each probe's target routes to the frontend it is keyed under", () => {
    for (const [id, p] of Object.entries(PROBES)) {
      expect(p.target.id).toBe(id);
    }
  });
});

// ── Layer 2: the canonical live/dead contract ───────────────────────────────────────────────────
describe('CONTRACT-AS-INVARIANT: live unmodelled op fails loud, dead one is harmless', () => {
  for (const [id, p] of Object.entries(PROBES)) {
    test(`${id}: an unmodelled op reaching the output FAILS LOUD`, () => {
      // `clz` is unmodelled in every one of these ISAs; writing the return register makes it LIVE.
      expectLoud(() => decodes(p, 'liveprobe', p.live('clz')).source);
    });

    test(`${id}: a DEAD unmodelled op does NOT fail loud (guard is precise)`, () => {
      // The raw IR must actually CONTAIN an `opaque` — proving the frontend emitted the honest
      // "unknown" and it was then DCE'd, NOT that it silently dropped the op (a blunt dropper would
      // produce the same clean source, so the source alone can't distinguish the two).
      const raw = print(frontendFor(p.target).lift('clzdead', p.wrap('clzdead', p.dead), p.target, {}));
      expect(raw).toContain('opaque');
      // And the final source is still the correct, clean result (the opaque was harmless).
      expect(decodes(p, 'clzdead', p.dead).source).toBe(p.deadSource);
    });
  }
});

// ── Layer 3: the negative-space corpus (real, plausible, unmodelled) ─────────────────────────────
describe('CONTRACT-AS-INVARIANT: real unmodelled opcodes with a live dest all fail loud', () => {
  for (const [id, p] of Object.entries(PROBES)) {
    for (const m of p.negativeSpace) {
      test(`${id}: '${m}' (unmodelled, live dest) fails loud`, () => {
        expectLoud(() => decodes(p, 'neg', p.live(m)).source);
      });
    }
  }
});

// ── Layer 4: seeded garbage fuzz ─────────────────────────────────────────────────────────────────
// Deterministic PRNG (mulberry32) so CI is reproducible — the repo treats nondeterminism as hostile
// (Math.random/Date.now are banned in workflow scripts for the same reason). Every mnemonic is
// `zz`-prefixed: no real ISA opcode starts with `zz`, so it is guaranteed unmodelled in ALL
// frontends and can never be a false failure, while still exercising the shared default path with
// varied inputs across the registry.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('CONTRACT-AS-INVARIANT: garbage fuzz — every unmodelled mnemonic fails loud', () => {
  const rnd = mulberry32(0xa5c1f70d);
  const alpha = 'abcdefghijklmnopqrstuvwxyz';
  const garbage = (): string => {
    const len = 4 + Math.floor(rnd() * 4); // 4..7 trailing chars
    let s = 'zz';
    for (let i = 0; i < len; i++) {
      s += alpha[Math.floor(rnd() * alpha.length)];
    }
    return s;
  };

  for (const [id, p] of Object.entries(PROBES)) {
    test(`${id}: 40 random unmodelled mnemonics all fail loud`, () => {
      for (let i = 0; i < 40; i++) {
        const m = garbage();
        expectLoud(() => decodes(p, 'fuzz', p.live(m)).source);
      }
    });
  }
});

// ── Layer 5: mustFailLoud — constructs OUTSIDE the shared default path ────────────────────────────
// Calls (implicit destination), indirect jumps (no data destination), and modelled cases that
// mishandle an operand shape are invisible to the operand-destination guard. Pin each to fail loud
// so the specific silent miscompiles can't return.
describe('CONTRACT-AS-INVARIANT: known non-default-path constructs fail loud', () => {
  for (const [id, p] of Object.entries(PROBES)) {
    for (const [label, body] of p.mustFailLoud) {
      test(`${id}: ${label} fails loud`, () => {
        expectLoud(() => decodes(p, 'mfl', body).source);
      });
    }
  }
});

// ── Structural lint: the recurring default-path defect is unwriteable ─────────────────────────────
// The recurring bug lives in the decode DEFAULT (a bare `default: break`, or a
// default that drops the destination). Assert at the source level that every frontend (a) routes
// through the single shared opaque policy, (b) its decode default reaches `emitOpaqueDest` (a
// POSITIVE check — stronger than banning one spelling), and (c) contains no silent-drop default
// form (`break`/`return`/`continue` with no opaque). The file list is DERIVED FROM THE REGISTRY
// (frontend.id === filename), so a new frontend is auto-linted — it can't ship un-checked by a
// human forgetting to append it here.
describe('CONTRACT-AS-INVARIANT: frontends route their decode default to the shared opaque policy', () => {
  const files = registeredFrontendIds().map((id) => frontendFor({ id } as TargetDescription).id);
  for (const f of files) {
    test(`${f}.ts routes its decode default through the shared opaque emitter`, () => {
      const src = readFileSync(new URL(`../src/frontend/${f}.ts`, import.meta.url), 'utf8');
      expect(src).toContain("from './opaque'");
      // POSITIVE: every `default:` in the file reaches `emitOpaqueDest` within a short window (the
      // decode default may guard terminators first, but must end at the opaque emitter, not a drop).
      for (const m of src.matchAll(/default:/g)) {
        const window = src.slice(m.index!, m.index! + 240);
        expect(window).toContain('emitOpaqueDest');
      }
      // NEGATIVE: no silent-drop default spelling (belt-and-braces with the positive check above).
      expect(src).not.toMatch(/default:\s*(break|return|continue)\b/);
    });
  }
});
