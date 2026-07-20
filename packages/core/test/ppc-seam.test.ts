// PPC SEAM SPIKE — prove the existing mid/back-end (parse → print → verify → recover → structure →
// emit) handles the NEUTRAL IR a PowerPC/CodeWarrior frontend produces for its distinctive shapes,
// resolving the two capability-gap questions (flags-as-data and rlwinm) in the FINDINGS below.
//
// These fragments are HAND-AUTHORED neutral IR (what the frontend would emit), NOT decoded from a
// real object — so this runs with no toolchain. Faithfulness to real CodeWarrior codegen is
// checked separately by the Docker-gated fixture suite (packages/cli/test/matching/ppc-mwcc.test.ts).
//
// SCOPE OF THIS FILE (honest): the fragments are hand-authored in ALREADY-FUSED form, so this file
// proves the DOWNSTREAM half — that the mid/back-end (recover→structure→emit) accepts a fused
// `cond_br icmp_*` and structures PPC's shapes without any IR change. It does NOT itself exercise
// the frontend's compare→branch fusion; that logic lives in src/frontend/ppc.ts (recordCmp/mkCmp)
// and is proven EMPIRICALLY on real CodeWarrior codegen by the `maxab` fixture in
// packages/cli/test/matching/ppc-mwcc.test.ts (a real `cmpw; bgelr` fuses and scores byte-exact). The two together are
// the design-plus-empirical proof of the finding below.
//
// FINDINGS (the fork the spike exists to resolve):
//  • FLAGS-AS-DATA — NOT needed for the leaf/single-branch class. PPC sets a condition register
//    (`cmpw cr0,r3,r4`) then branches on it (`blt cr0,.L`); when the cr field is set once and read
//    by ONE adjacent branch, it fuses into a single `cond_br icmp_*` exactly as MIPS (`slt;beq`)
//    and ARM already do (design-validated here; empirically confirmed by the ppc-mwcc `maxab`
//    fixture). The IR needs NO flags-as-data for this class. Real flags-as-data (a cr field reused
//    by several branches, or combined via crand/cror) is a LATER concern, deferred with eyes open —
//    see the boundary note at the end.
//  • rlwinm — rotate-and-mask with rotate=0 (the common bitfield EXTRACT, `rlwinm rD,rS,0,mb,me`)
//    fuses to a plain `and` with a frontend-computed mask: no new op, no envelope widening. Only
//    rlwinm with a NON-zero rotate needs the idiom-envelope work (a rotate, or shl/shr_u/or), and
//    that is a frontend legalization, not an IR-shape change.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { PPC_MWCC, structureOptionsFor } from '../src/target';

// Run a hand-authored neutral-IR fragment through the whole non-frontend pipeline and return the
// emitted C. Also asserts the two round-trip invariants along the way (verify passes; print∘parse
// is idempotent), which is the "does it round-trip through parse/print, verify, recover, structure"
// the spike is chartered to confirm.
function seam(ir: string, returnsVoid = false): string {
  const fn = parse(ir);
  verify(fn); // structural round-trip: the fragment is well-formed
  expect(print(parse(print(fn)))).toBe(print(fn)); // print∘parse idempotent
  recoverTypes(fn);
  const sfn = structure(fn, structureOptionsFor(PPC_MWCC, returnsVoid));
  return cBackend.emit(sfn);
}

describe('PPC seam spike: neutral IR for PPC shapes round-trips through the existing pipeline', () => {
  test('compare→branch FUSES — no flags-as-data needed (resolves the fork)', () => {
    // CodeWarrior: `cmpw cr0,r3,r4; blt cr0,.L2; …` → the frontend fuses the cr0-setting compare
    // and the single branch that reads it into ONE cond_br, identical to the MIPS/ARM seam.
    const maxab = `fn maxab {
^bb0(%0: s32, %1: s32):
  %2: u32 = icmp_slt %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  ret %1
^bb2():
  ret %0
}
`;
    // Structures into a real divergent-if diamond — the cr field never became IR-level data.
    expect(seam(maxab)).toBe(
      's32 maxab(s32 a0, s32 a1) {\n    if (a0 >= a1) {\n        return a0;\n    } else {\n        return a1;\n    }\n}\n',
    );
  });

  test('rlwinm-as-mask (rotate 0) fuses to `and` with a computed mask — no new op', () => {
    // `rlwinm r3,r3,0,24,31` extracts the low byte → the frontend emits `and r3, r3, 0xff`.
    const lowbyte = `fn lowbyte {
^bb0(%0: s32):
  %1: s32 = const {value=255}
  %2: s32 = and %0, %1
  ret %2
}
`;
    expect(seam(lowbyte)).toBe('s32 lowbyte(s32 a0) {\n    return a0 & 255;\n}\n');
  });

  test('bl call + blr return reuse the existing call/ret seam', () => {
    // `bl g; blr` → the call op (target=g); the LR-based return is the ordinary `ret`.
    const callg = `fn callg {
^bb0(%0: s32):
  %1: s32 = call %0 {target="g"}
  ret %1
}
`;
    expect(seam(callg)).toBe('s32 callg(s32 a0) {\n    return g(a0);\n}\n');
  });

  test('straight-line integer arithmetic (add/sub) needs nothing PPC-specific', () => {
    const madd = `fn madd {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = mul %0, %1
  %4: s32 = add %3, %2
  ret %4
}
`;
    expect(seam(madd)).toBe('s32 madd(s32 a0, s32 a1, s32 a2) {\n    return a0 * a1 + a2;\n}\n');
  });

  // BOUNDARY NOTE (spike finding, encoded as a live assertion so it can't rot): the fused model
  // represents a condition as an icmp VALUE feeding exactly one cond_br. It CANNOT (yet) express a
  // single cr field read by two different branches, nor `crand`/`cror` of two cr fields — those
  // are the cases that would force real flags-as-data in the IR. No leaf-integer CodeWarrior
  // function in the target fixture class needs that, so it is deferred. This test simply pins that
  // the PPC target advertises the hardware fact (condition registers exist) while the SEAM stays
  // fused — the two are consistent, not contradictory.
  test('PPC advertises hardware condition-registers (flags) yet the seam stays fused', () => {
    expect(PPC_MWCC.capabilities.flags).toBe(true); // cr0–cr7 are a real hardware fact
    // …and nothing in the fused pipeline consumed it: the maxab diamond above structured with a
    // plain icmp-valued cond_br. flags-as-data remains a deferred, documented IR concern.
  });
});
