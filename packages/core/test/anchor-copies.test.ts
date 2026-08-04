// Def-site anchoring of constant merge copies (structure.ts anchorConstCopies): an edge copy
// `v = K` whose constant the asm materialized EARLIER — `movs r9, #0` at entry ahead of a
// single-armed overwrite — is emitted at the const op's original position and the edge copy is
// suppressed. Off by default; rank.ts enumerates it as the `/defsite` axis.
//
// The refusal conditions are what make it sound, so they are what these tests pin hardest:
// in-loop shapes decline outright (per-iteration precedence is not dominance — the /preinit
// sticky-arm class), and a const whose write could clobber another anchored arg on a path to its
// edge keeps the edge placement.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string, anchor: boolean): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { anchorConstCopies: anchor }));
};

// v = 0 at entry, conditionally overwritten to 1 — the asm shape `movs r9, #0` … `bne skip;
// movs r9, #1`. Anchored: the pre-initialization above a single-armed POSITIVE if (the emptied
// arm flips the condition). Unanchored: the two-armed spelling.
const PREINIT = `fn preinit {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=7}
  %3: u32 = icmp_ne %0, %2
  cond_br %3, ^bb2(%1), ^bb1()
^bb1():
  %4: s32 = const {value=1}
  br ^bb2(%4)
^bb2(%5: s32):
  ret %5
}
`;

test('an entry const anchors above the if; the emptied arm flips it single-armed positive', () => {
  expect(emit(PREINIT, true)).toBe(
    's32 preinit(s32 a0) {\n    s32 v0;\n    v0 = 0;\n    if (a0 == 7) v0 = 1;\n    return v0;\n}\n',
  );
});

test('off by default: the same IR keeps the two-armed edge placement', () => {
  const off = emit(PREINIT, false);
  expect(off).toContain('if (a0 != 7)');
  expect(off).toContain('v0 = 0;');
  expect(off).toContain('v0 = 1;');
  expect(emit(PREINIT, false)).toBe(off); // and the option default matches anchor:false
});

// v = 1 at the TOP of an arm, ahead of a nested if whose both exits carry it — the asm shape
// `movs r5, #1` before the inner branch. Anchored, the assignment opens the arm instead of
// tail-merging to its end.
const ARMTOP = `fn armtop {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %0, %2
  cond_br %3, ^bb1(), ^bb4(%2)
^bb1():
  %4: s32 = const {value=1}
  %5: s32 = const {value=99}
  %6: u32 = icmp_sle %0, %5
  cond_br %6, ^bb4(%4), ^bb2()
^bb2():
  %7: s32 = const {value=3}
  store %1, %7 {off=0, width=4}
  br ^bb4(%4)
^bb4(%8: s32):
  ret %8
}
`;

test('an arm-top const opens its arm, ahead of the nested if', () => {
  const out = emit(ARMTOP, true);
  const arm = out.indexOf('v0 = 1;');
  const inner = out.indexOf('if (a0 > 99)');
  expect(arm).toBeGreaterThan(-1);
  expect(inner).toBeGreaterThan(-1);
  expect(arm).toBeLessThan(inner); // the write PRECEDES the nested if, as the asm placed it
  expect(out).toContain('v0 = 0;\n    if (a0 == 0)'); // and the entry const still pre-initializes
});

// CLOBBER REFUSAL: two anchorable consts of the same variable where one's write lies on a path
// from the other to the other's edge (bb0's 0 → bb1's 1 → bb2 → the edge carrying 0). Anchoring
// both would deliver 1 where the SSA says 0, so the threatened one keeps its edge placement.
const CLOBBER = `fn clobber {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=7}
  %3: u32 = icmp_ne %0, %2
  cond_br %3, ^bb2(), ^bb1()
^bb1():
  %4: s32 = const {value=1}
  %5: s32 = const {value=9}
  %6: u32 = icmp_ne %0, %5
  cond_br %6, ^bb3(%4), ^bb2()
^bb2():
  br ^bb3(%1)
^bb3(%7: s32):
  ret %7
}
`;

test('a const whose edge another anchored write could reach keeps its edge placement', () => {
  const out = emit(CLOBBER, true);
  // the threatened 0-copy stays ON its edge (inside an arm), never as a function-top pre-init
  expect(out.startsWith('s32 clobber(s32 a0) {\n    s32 v0;\n    v0 = 0;')).toBe(false);
  expect(out).toContain('v0 = 0;');
  expect(out).toContain('v0 = 1;');
});

// LOOP REFUSAL: the same diamond INSIDE a loop body declines outright — block-level dominance
// does not give per-iteration precedence, so an anchored write could go stale across iterations
// (the /preinit sticky-arm class). Output must be byte-identical to the unanchored spelling.
const IN_LOOP = `fn loopy {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(), ^bb5(%2)
^bb2():
  %4: s32 = const {value=5}
  %5: u32 = icmp_eq %2, %4
  cond_br %5, ^bb4(%4), ^bb3()
^bb3():
  %6: s32 = const {value=9}
  br ^bb4(%6)
^bb4(%7: s32):
  %8: s32 = add %2, %7
  br ^bb1(%8)
^bb5(%9: s32):
  ret %9
}
`;

test('an in-loop merge declines anchoring entirely', () => {
  expect(emit(IN_LOOP, true)).toBe(emit(IN_LOOP, false));
});
