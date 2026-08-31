// The address-home axis (structure.ts homeSharedAddresses, rank.ts `/addr-home`): a pure computed
// address dereferenced at 2+ sites materializes into a local, and so do the multi-render loads
// through it — the source's `u8 *entry = ...; type = entry[1]; idx = entry[0];` spelling, where
// the default re-derives the address (a pool literal per folded offset) and re-reads per use.
// Off by default.
//
// The scope conditions are what these tests pin — base-slot-only consumption, 2+ distinct memory
// accesses, no gaddr/laddr in the cone, loads homed only through an axis-homed base — plus the
// enumeration gate's two contracts: a void `ret` phantom never disqualifies a base, and a symbol
// map never blinds the `/raw-globals` sibling's own gate.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { mergeClasses } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { enumerateCandidates } from '../src/rank';
import { hasHomeableSharedAddress, sharedBaseClasses } from '../src/structure/analysis';
import { structure } from '../src/structure/structure';
import { type SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const emit = (ir: string, on: boolean): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { homeSharedAddresses: on }));
};

const count = (s: string, needle: string): number => s.split(needle).length - 1;

// The entry-pair shape: one computed address, two byte loads through it (offsets 1 and 0), each
// loaded value read again past the branch.
const PAIR = `fn pair {
^bb0(%0: u32, %1: u32):
  %2: s32 = const {value=2}
  %3: u32 = shl %0, %2
  %4: s32 = const {value=1}
  %5: u32 = shl %1, %4
  %6: u32 = add %3, %5
  %7: s32 = const {value=134576844}
  %8: u32 = add %6, %7
  %9: s32 = load %8 {off=1, signed=false, width=1}
  %10: s32 = load %8 {off=0, signed=false, width=1}
  %11: u32 = icmp_ne %9, %2
  cond_br %11, ^bb1(), ^bb2()
^bb1():
  %12: s32 = add %9, %10
  br ^bb3(%12)
^bb2():
  %13: s32 = sub %10, %9
  br ^bb3(%13)
^bb3(%14: s32):
  ret %14
}
`;

test('a shared computed address homes into a local, and the loads through it home too', () => {
  const on = emit(PAIR, true);
  // the address derives once, into a named local
  expect(count(on, '134576844')).toBe(1);
  expect(on).toMatch(/v\d+ = \(a0 << 2\) \+ \(a1 << 1\) \+ 134576844;/);
  // both loads render as named pre-branch temps through the homed base
  expect(on).toMatch(/v\d+ = \(\(u8 \*\)v\d+\)\[1\];/);
  expect(on).toMatch(/v\d+ = \*\(u8 \*\)v\d+;/);
});

test('off by default: the same IR keeps the re-derive spelling', () => {
  const off = emit(PAIR, false);
  expect(count(off, '134576844')).toBeGreaterThanOrEqual(2);
  expect(emit(PAIR, false)).toBe(off);
});

test('the enumeration gate sees the pair shape', () => {
  expect(hasHomeableSharedAddress(parse(PAIR))).toBe(true);
});

// The base ALSO escapes into arithmetic (returned as a value) — not base-slot-only, so the axis
// must stay silent: the home is justified by shared-base reuse alone.
const ESCAPES = PAIR.replace('  %12: s32 = add %9, %10', '  %12: s32 = add %8, %10');

test('a base that escapes into arithmetic is not homed', () => {
  const on = emit(ESCAPES, true);
  expect(count(on, '134576844')).toBeGreaterThanOrEqual(2);
  expect(hasHomeableSharedAddress(parse(ESCAPES))).toBe(false);
});

// One deref only: a single access re-materializes as cheaply as a named local would.
const SINGLE = `fn single {
^bb0(%0: u32, %1: u32):
  %2: s32 = const {value=2}
  %3: u32 = shl %0, %2
  %4: s32 = const {value=1}
  %5: u32 = shl %1, %4
  %6: u32 = add %3, %5
  %7: s32 = const {value=134576844}
  %8: u32 = add %6, %7
  %9: s32 = load %8 {off=1, signed=false, width=1}
  %10: s32 = add %9, %9
  ret %10
}
`;

test('a base with one access is not homed', () => {
  expect(emit(SINGLE, true)).toBe(emit(SINGLE, false));
  expect(hasHomeableSharedAddress(parse(SINGLE))).toBe(false);
});

// A gaddr in the cone: rendered standalone, the address computation loses the memAccess's
// byte-stride cast — those stay with the cast-aware base machinery (the addressCone refusal).
const GADDR = `fn withsym {
^bb0(%0: u32):
  %1: u16* = gaddr {sym="gTable"}
  %2: u32 = add %1, %0
  %3: s32 = load %2 {off=0, signed=false, width=2}
  %4: s32 = load %2 {off=2, signed=false, width=2}
  %5: s32 = icmp_ne %3, %4
  cond_br %5, ^bb1(), ^bb2()
^bb1():
  br ^bb2()
^bb2():
  %6: s32 = add %3, %4
  ret %6
}
`;

test('a base whose cone holds a gaddr is not homed', () => {
  expect(emit(GADDR, true)).toBe(emit(GADDR, false));
  expect(hasHomeableSharedAddress(parse(GADDR))).toBe(false);
});

// A base that is ALSO the `ret` operand. For a void-prototyped function the ret operand is a
// phantom (the register just happens to hold the base at `bx lr` — common agbcc output), so the
// gate must not count it: analyze() skips it under returnsVoid, which the gate cannot know. For
// a non-void function the axis's own rule still refuses — the gate's true is then the documented
// duplicate-collapsed-candidate over-approximation.
const RETBASE = `fn retbase {
^bb0(%0: u32):
  %1: s32 = const {value=2}
  %2: u32 = shl %0, %1
  %3: s32 = const {value=134576844}
  %4: u32 = add %2, %3
  %5: s32 = load %4 {off=1, signed=false, width=1}
  store %4, %5 {off=2, width=1}
  %6: s32 = load %4 {off=0, signed=false, width=1}
  store %4, %6 {off=3, width=1}
  ret %4
}
`;

test('a ret-operand base still passes the gate, and the axis homes it under returnsVoid', () => {
  expect(hasHomeableSharedAddress(parse(RETBASE))).toBe(true);
  const emitVoid = (on: boolean): string => {
    const fn = parse(RETBASE);
    verify(fn);
    recoverTypes(fn);
    return cBackend.emit(structure(fn, { returnsVoid: true, homeSharedAddresses: on }));
  };
  const on = emitVoid(true);
  expect(count(on, '134576844')).toBe(1);
  expect(count(emitVoid(false), '134576844')).toBeGreaterThanOrEqual(2);
});

test('the same base genuinely returned is refused by the axis — gate over-approximates only', () => {
  const emitRet = (on: boolean): string => {
    const fn = parse(RETBASE);
    verify(fn);
    recoverTypes(fn);
    return cBackend.emit(structure(fn, { homeSharedAddresses: on }));
  };
  expect(emitRet(true)).toBe(emitRet(false));
});

// The per-variant enumeration gate: a symbol map naming the base constant makes the MAP-lifted
// fn's cone hold a gaddr (axis refused), while the `/raw-globals` sibling lifts the plain const
// the axis serves. A probe-level gate would blind the raw sibling — every `/addr-home` candidate
// must therefore ride the raw variant, and at least one must exist.
const PAIR_ASM =
  'f:\n' +
  '\tlsls\tr0, r0, #0x2\n\tlsls\tr1, r1, #0x1\n\tadds\tr0, r0, r1\n' +
  '\tldr\tr1, .L1\n\tadds\tr0, r0, r1\n' +
  '\tldrb\tr2, [r0, #0x1]\n\tldrb\tr1, [r0]\n' +
  '\tcmp\tr2, #0x2\n\tbeq\t.L2\n' +
  '\tsubs\tr0, r2, #0x2\n\tadds\tr0, r0, r1\n\tbx\tlr\n' +
  '.L2:\n\tadds\tr0, r2, r1\n\tbx\tlr\n' +
  '.L1:\n\t.word\t0x8057acc\n';

test('a symbol map does not blind the raw sibling: /addr-home rides /raw-globals', () => {
  const symbols: SymbolMap = new Map([[0x8057acc, [{ name: 'gEntries', kind: 'data' }]]]);
  const cands = enumerateCandidates('f', PAIR_ASM, ARMV4T_AGBCC, { symbols });
  const homed = cands.filter((c) => c.label.includes('/addr-home'));
  expect(homed.length).toBeGreaterThan(0);
  expect(homed.every((c) => c.label.includes('/raw-globals'))).toBe(true);
});

// ── THE MERGE CLASS ────────────────────────────────────────────────────────────────────────
// The axis's scope counts base uses over the merge class (ir/core.ts `mergeClasses`), not over
// the SSA value: a base each arm derives and the join then dereferences is one register spelled
// as N values, and per value none of them reaches the 2-access threshold — while the edge
// argument that makes it shared is itself a non-memory consumer, so the per-value rule refuses on
// the very evidence it needs. `synthetic:bgshare` and `synthetic:bgswitch` are the rows.
const MERGED = `fn armshare {
^bb0(%0: u32, %1: u32):
  %2: s32 = const {value=2}
  %3: u32 = shl %0, %2
  %4: s32 = const {value=134576640}
  cond_br %1, ^bb1(), ^bb2()
^bb1():
  %5: u32 = add %3, %4
  %6: s32 = load %5 {off=16, signed=false, width=2}
  br ^bb3(%5, %6)
^bb2():
  %7: u32 = add %3, %4
  %8: s32 = load %7 {off=12, signed=false, width=2}
  br ^bb3(%7, %8)
^bb3(%9: u32, %10: s32):
  %11: s32 = load %9 {off=18, signed=false, width=2}
  %12: s32 = add %10, %11
  ret %12
}
`;

test('a base the arms derive and the join dereferences homes over the merge class', () => {
  expect(hasHomeableSharedAddress(parse(MERGED))).toBe(true);
  // off, each arm re-derives the address inline at its own deref
  expect(emit(MERGED, false)).toMatch(/\(\(u16 \*\)\(\(a0 << 2\) \+ 134576640\)\)\[/);
  // on, every deref in the function reads a name
  const on = emit(MERGED, true);
  expect(on).not.toMatch(/\(\(u16 \*\)\(\(a0 << 2\)/);
  expect(on.match(/\(\(u16 \*\)v\d+\)\[\d+\]/g)?.length).toBe(3);
});

// ONE member escaping refuses the WHOLE class — here the join parameter, which the per-value rule
// never looks at (the axis only ever homes a def). The home is justified by shared-base reuse
// alone, exactly as before the scope widened.
const MERGED_ESCAPES = MERGED.replace(
  '  %12: s32 = add %10, %11\n  ret %12',
  '  %12: s32 = add %10, %11\n  %13: s32 = add %12, %9\n  ret %13',
);

test('a merge class with one escaping member is not homed', () => {
  expect(hasHomeableSharedAddress(parse(MERGED_ESCAPES))).toBe(false);
  expect(emit(MERGED_ESCAPES, true)).toBe(emit(MERGED_ESCAPES, false));
});

// The 2-access threshold is over the class too, not dissolved by it: one deref through a merged
// value re-materializes as cheaply as a named local, same as one deref through an unmerged one.
const MERGED_ONCE = `fn onederef {
^bb0(%0: u32):
  %1: s32 = const {value=2}
  %2: u32 = shl %0, %1
  %3: s32 = const {value=134576640}
  %4: u32 = add %2, %3
  br ^bb1(%4)
^bb1(%5: u32):
  %6: s32 = load %5 {off=18, signed=false, width=2}
  ret %6
}
`;

test('a merge class reached at one access is not homed', () => {
  expect(hasHomeableSharedAddress(parse(MERGED_ONCE))).toBe(false);
  expect(emit(MERGED_ONCE, true)).toBe(emit(MERGED_ONCE, false));
});

test('mergeClasses unions an edge argument with the parameter it binds, transitively', () => {
  const fn = parse(MERGED);
  const classes = mergeClasses(fn);
  const [bb0, bb1, bb2, bb3] = fn.blocks;
  const armBase = (b: (typeof fn.blocks)[number]) => b.ops.find((o) => o.opcode === 'add')!.results[0];
  const cls = classes.get(armBase(bb1));
  expect(cls).toBeDefined();
  expect(new Set(cls)).toEqual(new Set([armBase(bb1), armBase(bb2), bb3.params[0]]));
  // the shift feeding both arms rides no edge, so it is its own class and absent from the map
  expect(classes.get(bb0.ops.find((o) => o.opcode === 'shl')!.results[0])).toBeUndefined();
});

// ── the two refusals the widened scope rests on, pinned rather than asserted ────────────────
// The plan for this scope mandated a `loop-header-class` gate — refuse a class that reaches a LOOP
// HEADER parameter, on the ground that a loop variable's name means different things at different
// points. It is NOT shipped, and these are the measurements that stand in for it.
//
// A corrected census (the shipped one asked only inside functions whose ENUMERATION GATE flipped,
// which is a strictly smaller population than the functions where a new VALUE is admitted) over
// the four checkouts, both symbol-map configurations: 1487 lifting functions, 25 with newly
// admitted values map-less and 8 map-ful; ONE has a class touching a loop-header parameter
// (marioparty3, 2 values, map-less only), and ZERO of those values are ones the axis could
// materialize. The two tests below say why that is structural rather than lucky.

// A loop-carried pointer INDUCTION — the shape the guard was written for. The walk's own `+ 4` is
// a non-base use of a class member, so the class is refused by the rule that was already there.
const LOOP_WALK = `fn walk {
^bb0(%0: u32, %1: u32):
  %2: s32 = const {value=0}
  br ^bb1(%0, %2)
^bb1(%3: u32, %4: s32):
  %5: s32 = load %3 {off=0, signed=false, width=2}
  %6: s32 = load %3 {off=2, signed=false, width=2}
  %7: s32 = add %5, %6
  %8: s32 = add %4, %7
  %9: s32 = const {value=4}
  %10: u32 = add %3, %9
  %11: u32 = icmp_ne %10, %1
  cond_br %11, ^bb1(%10, %8), ^bb2(%8)
^bb2(%12: s32):
  ret %12
}
`;

test('a loop-carried pointer induction is refused by its own increment, not by a loop gate', () => {
  expect(sharedBaseClasses(parse(LOOP_WALK), true).size).toBe(0);
  expect(hasHomeableSharedAddress(parse(LOOP_WALK))).toBe(false);
  expect(emit(LOOP_WALK, true)).toBe(emit(LOOP_WALK, false));
});

// The loop-header class that DOES survive: the back-edge value is read from memory, so no member
// feeds arithmetic. All three values are in scope — and nothing homes, because the axis only ever
// materializes a DEF and the only def here is a `load`, which its enumeration gate excludes. A
// name therefore never spans two iterations: every home the axis mints is a def's own local.
const LOOP_CHASE = `fn chase {
^bb0(%0: u32):
  %1: s32 = const {value=0}
  br ^bb1(%0, %1)
^bb1(%2: u32, %3: s32):
  %4: s32 = load %2 {off=0, signed=false, width=2}
  %5: s32 = load %2 {off=2, signed=false, width=2}
  %6: s32 = add %4, %5
  %7: s32 = add %3, %6
  %8: u32 = load %2 {off=8, signed=false, width=4}
  %9: u32 = icmp_ne %7, %1
  cond_br %9, ^bb1(%8, %7), ^bb2(%7)
^bb2(%10: s32):
  ret %10
}
`;

test('a loop-header class fed from memory is in scope and still homes nothing', () => {
  expect(sharedBaseClasses(parse(LOOP_CHASE), true).size).toBe(3);
  expect(hasHomeableSharedAddress(parse(LOOP_CHASE))).toBe(false);
  expect(emit(LOOP_CHASE, true)).toBe(emit(LOOP_CHASE, false));
});

// THE ESCAPE IS KEPT OUT BY THE `otherUse` SWEEP, and by nothing else. `sharedBaseClasses` used to
// carry a clause excusing a base-slot use when the same op used the value again as data
// (`store p, p`) — measured over 1487 lifted corpus functions, the shape occurs at 10 sites and
// the clause changed the predicate's answer at none of them, because the j>0 pass over the same
// operand list already puts the value in `otherUse`. The clause is gone; this is what replaces it.
const STORE_SELF = `fn escape {
^bb0(%0: u32):
  %1: s32 = const {value=2}
  %2: u32 = shl %0, %1
  %3: s32 = const {value=134576640}
  %4: u32 = add %2, %3
  %5: s32 = load %4 {off=4, signed=false, width=4}
  store %4, %4 {off=0, width=4}
  ret %5
}
`;

test('an address stored as its own data escapes the scope', () => {
  expect(sharedBaseClasses(parse(STORE_SELF), true).size).toBe(0);
  expect(hasHomeableSharedAddress(parse(STORE_SELF))).toBe(false);
});
