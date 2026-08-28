// The parameter-merge-home rule (structure.ts freshParamMerge): a merge that conditionally
// overwrites a function PARAMETER takes its own local instead of assigning back into the
// parameter's name. Off by default.
//
// What these tests pin is the SCOPE, since the carrier is the whole evidence: an entry parameter,
// or a home this rule itself minted — and nothing else, so a merge over ordinary locals keeps the
// adoption the rest of the naming walk rests on. The refusals are here too — a redundant phi, which
// overwrites the parameter on no path, and a loop header, which `seedLoopParams` has already named
// — and so is the axis that enumerates the spelling, with the function it costs nothing.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { enumerateCandidates } from '../src/rank';
import { FRESH_MERGE_GATES, type StructureHooks, type StructureOptions, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';

const emit = (ir: string, on: boolean, extra: StructureOptions = {}, hooks: StructureHooks = {}): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { freshParamMerge: on, ...extra }, hooks));
};

// ── the isolate: `int m = a>b?a:b; return m>c?m:c;` at agbcc -O2 ──────────────────────────────
// Two merges in a row. The first is over the parameters `a1`/`a0`; the second is over `a2` and the
// first merge's own result, which is what makes the rule's second clause observable.
const MAX3 = `fn max3 {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: u32 = icmp_sge %1, %0
  cond_br %3, ^bb2(%1), ^bb1()
^bb1():
  br ^bb2(%0)
^bb2(%4: s32):
  %5: u32 = icmp_sge %2, %4
  cond_br %5, ^bb4(%2), ^bb3()
^bb3():
  br ^bb4(%4)
^bb4(%6: s32):
  ret %6
}
`;

test('a merge over parameters takes its own home instead of writing one of them', () => {
  expect(emit(MAX3, false)).toMatch(/a1 = a0;/);
  const on = emit(MAX3, true);
  expect(on).not.toMatch(/a[012] = /);
  expect(on).toMatch(/v0 = a0;/);
});

test('…and the merge above it does not take that home either — two values, two homes', () => {
  // `%6` merges the parameter `a2` with `%4`, the home the rule just minted. Adopting it would
  // chain both values through one register; the rule refuses its own homes for that reason.
  const on = emit(MAX3, true);
  expect(on).toMatch(/s32 v1;/);
  expect(on).toMatch(/return v1;/);
});

// ── a REDUNDANT phi is not an overwrite ──────────────────────────────────────────────────────
// Every edge passes `%0`, so the merge is a pure alias of the parameter: a fresh home would buy a
// copy and move nothing.
const ALIAS = `fn aliasmerge {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %0, %2
  cond_br %3, ^bb2(%0), ^bb1()
^bb1():
  store %1, %2 {off=0, width=4}
  br ^bb2(%0)
^bb2(%4: s32):
  ret %4
}
`;

test('a redundant phi over one parameter keeps the parameter', () => {
  expect(emit(ALIAS, true)).toBe(emit(ALIAS, false));
  expect(emit(ALIAS, true)).toMatch(/return a0;/);
});

// ── an ordinary LOCAL still lends its name ───────────────────────────────────────────────────
// Two merges again, but the first is over constants — so its home is one the naming walk minted on
// its own, not one this rule did. The second merge adopts it exactly as before.
const CHAINLOCAL = `fn chainlocal {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: s32 = const {value=7}
  %4: u32 = icmp_eq %0, %2
  cond_br %4, ^bb2(%3), ^bb1()
^bb1():
  store %1, %3 {off=0, width=4}
  br ^bb2(%2)
^bb2(%5: s32):
  %6: u32 = icmp_sgt %5, %2
  cond_br %6, ^bb4(%5), ^bb3()
^bb3():
  %7: s32 = const {value=9}
  br ^bb4(%7)
^bb4(%8: s32):
  ret %8
}
`;

test('a merge over ordinary locals is untouched — the second clause is not "every local"', () => {
  expect(emit(CHAINLOCAL, true)).toBe(emit(CHAINLOCAL, false));
  expect(emit(CHAINLOCAL, true)).toMatch(/if \(v0 <= 0\) v0 = 9;/);
});

// ── a LOOP HEADER keeps its seat ─────────────────────────────────────────────────────────────
// `seedLoopParams` names header params before this walk runs, and on a coalesceLoopInit target it
// deliberately keeps the induction variable in the parameter's register — the init copy vanishes.
// That decision is the loop's, and this rule never reaches it.
const LOOPHDR = `fn loopsum {
^bb0(%0: s32, %1: s32):
  br ^bb1(%0, %1)
^bb1(%2: s32, %3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %2, %4
  %6: s32 = add %3, %2
  %7: u32 = icmp_sgt %5, %4
  cond_br %7, ^bb1(%5, %6), ^bb2(%6)
^bb2(%8: s32):
  ret %8
}
`;

test('a loop header still coalesces onto its init parameter', () => {
  const on = emit(LOOPHDR, true, { coalesceLoopInit: true });
  expect(on).toBe(emit(LOOPHDR, false, { coalesceLoopInit: true }));
  expect(on).toMatch(/a0 = a0 - 1;/);
});

// ── the axis, and what it costs a function that has no such merge ────────────────────────────
test('/fresh-merge is enumerated where a merge slot mixes a parameter with something else', () => {
  // `max3` at agbcc -O2: two `cmp`/conditional-copy pairs over the three argument registers.
  const MAX3_ASM =
    'max3:\n\tcmp\tr1, r0\n\tbge\t.L3\n\tadd\tr1, r0, #0\n.L3:\n\tadd\tr0, r2, #0\n' +
    '\tcmp\tr0, r1\n\tbge\t.L4\n\tadd\tr0, r1, #0\n.L4:\n\tbx\tlr\n';
  const all = enumerateCandidates('max3', MAX3_ASM, ARMV4T_AGBCC, {});
  expect(all.some((c) => c.label.includes('/fresh-merge'))).toBe(true);
  // A spelling of its own, not a duplicate the dedup would have collapsed.
  const sources = (cs: typeof all) => new Set(cs.map((c) => c.source)).size;
  expect(sources(all)).toBeGreaterThan(sources(all.filter((c) => !c.label.includes('/fresh-merge'))));
});

test('…and a function whose only merge carries the SAME parameter on every edge pays nothing', () => {
  // The redundant-phi refusal, read off the gate rather than the rule: `r0` reaches the join
  // unchanged on both paths, so there is no conditional overwrite to re-home.
  const ALIAS_ASM = 'f:\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tmov\tr2, #0\n\tstr\tr2, [r1]\n.L2:\n\tbx\tlr\n';
  const all = enumerateCandidates('f', ALIAS_ASM, ARMV4T_AGBCC, {});
  expect(all.some((c) => c.label.includes('/fresh-merge'))).toBe(false);
});

// ── a NARROWER carrier is never adopted, under either setting ─────────────────────────────────
// Adoption declares the merged value with the CARRIER's type and refusal with the merge's own, so a
// carrier narrower than the merge would make this axis two PROGRAMS — every assignment truncates on
// one side — rather than two spellings, and `scoreObjects` has no standing to referee that. It
// cannot happen, and the guard is `canTakeName`'s carrier width/sign check running on the same
// carrier one step earlier, NOT anything in this rule: the merge takes a fresh home either way.
// Pinned here because the rule's header used to rest this on an incidental fact — every corpus row
// that could reach it is a loop header `seedLoopParams` names first — instead of on the guard.
const NARROWCARRIER = `fn narrowcarrier {
^bb0(%0: u8, %1: s32*):
  %2: s32 = load %1 {off=0, width=4, signed=true}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %2, %3
  cond_br %4, ^bb2(%0), ^bb1()
^bb1():
  %5: u16 = const {value=7}
  br ^bb2(%5)
^bb2(%6: u16):
  %7: s32 = zext %6 {width=2}
  ret %7
}
`;

test('a merge WIDER than its parameter carrier takes a fresh home under BOTH settings', () => {
  const off = emit(NARROWCARRIER, false);
  expect(emit(NARROWCARRIER, true)).toBe(off);
  expect(off).toMatch(/u16 v0;/);
  expect(off).not.toMatch(/a0 = /);
});

// …and the guard does not swallow the whole axis: at EQUAL width the carrier is adopted by default
// and re-homed under the rule, which is the case the corpus actually inhabits.
const WIDECARRIER = NARROWCARRIER.replace('%0: u8', '%0: u16');

test('…while an equal-width carrier is adopted by default and re-homed by the rule', () => {
  expect(emit(WIDECARRIER, false)).toMatch(/a0 = 7;/);
  expect(emit(WIDECARRIER, true)).toMatch(/v0 = a0;/);
});

// ── each gate, ablated, on the fixture that pins it ───────────────────────────────────────────
// The table is a parameter so the ablation runs the REAL pass rather than a re-implementation of
// its condition; both gates are heuristics, so what dropping one changes is the spelling.
test('dropping `redundant-phi` re-homes the pure alias the rule leaves alone', () => {
  const ablated = emit(ALIAS, true, {}, { freshMergeGates: without(FRESH_MERGE_GATES, 'redundant-phi') });
  expect(ablated).not.toBe(emit(ALIAS, true));
  expect(ablated).toMatch(/return v0;/);
});

test('dropping `param-rooted` re-homes a chain rooted in an ordinary local', () => {
  const ablated = emit(CHAINLOCAL, true, {}, { freshMergeGates: without(FRESH_MERGE_GATES, 'param-rooted') });
  expect(ablated).not.toBe(emit(CHAINLOCAL, true));
  expect(ablated).toMatch(/s32 v1;/);
});
