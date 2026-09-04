// M0 — the load-bearing invariant: parse(print) is the identity on canonical text, so
// the textual IR is a trustworthy test oracle. Includes a genuine two-predecessor join,
// which proves block-argument SSA on a real merge.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { ARMV4T_AGBCC } from '../src/target';

const STRAIGHT_LINE = `fn read_u16 {
^bb0(%0: u8*):
  %1: u8 = load %0 {off=0, signed=false, width=8}
  %2: u8 = load %0 {off=1, signed=false, width=8}
  %3: u32 = shl %2 {imm=8}
  %4: u32 = or %1, %3
  ret %4
}
`;

// Diamond with a join: ^bb3 has a block-argument fed from two predecessors.
const DIAMOND = `fn select_nonneg {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_slt %0, %1
  cond_br %2, ^bb1(%1), ^bb2(%0)
^bb1(%3: s32):
  br ^bb3(%3)
^bb2(%4: s32):
  br ^bb3(%4)
^bb3(%5: s32):
  ret %5
}
`;

test('round-trip: straight-line function', () => {
  expect(print(parse(STRAIGHT_LINE))).toBe(STRAIGHT_LINE);
});

test('round-trip: diamond with a two-predecessor join (block-arg SSA)', () => {
  expect(print(parse(DIAMOND))).toBe(DIAMOND);
});

test('round-tripped IR verifies', () => {
  verify(parse(STRAIGHT_LINE));
  verify(parse(DIAMOND));
});

test('double round-trip is a fixed point', () => {
  const once = print(parse(DIAMOND));
  const twice = print(parse(once));
  expect(twice).toBe(once);
});

// THE WRITE-ORDER ANNOTATION is a DUMP feature, not a round-trip one (ir/print.ts `PrintOptions`).
// Two functions with identical `stage:lift` text used to emit different C, because the record that
// decides an edge's copy order — and, on a cycle, which register is spilled — appeared nowhere in
// the artifact the tower's own boundary criterion asks for. It appears now, at `stage:lift`, and it
// deliberately does NOT come back through `parse`: a parsed fn that returned measured would
// structure differently from every other parsed fn. The MEASUREMENT is what does not come back —
// the TEXT still parses, because every stage dump carries the annotation now (pipeline.ts,
// trace.ts) and a dump nobody can paste into `parse` is not the oracle this file is about.
test('the lift dump shows the write-order record; the canonical text still does not', () => {
  const asm = readFileSync(join(import.meta.dirname, 'corpus/agbcc-gcd.s'), 'utf8');
  const fn = frontendFor(ARMV4T_AGBCC).lift('gcd', asm, ARMV4T_AGBCC, {}, undefined, undefined);
  const dump = print(fn, { writeOrder: true });
  // The back edge's own numbers — the ordinals the edge-copy sort reads, in successor-arg order.
  expect(dump).toContain('; order ^bb1(3, 4)');
  expect(dump).toMatch(/\^bb1\(.*\):\s+; writes=5/);
  // …and the default print is unchanged, so `parse(print(fn))` keeps its domain.
  const plain = print(fn);
  expect(plain).not.toContain('; order');
  expect(plain).not.toContain('; writes=');
  expect(print(parse(plain))).toBe(plain);
  expect(parse(plain).writeOrder).toBeUndefined();
});

test('an UNMEASURED fn prints identically with the annotation asked for', () => {
  const fn = parse(DIAMOND);
  expect(print(fn, { writeOrder: true })).toBe(print(fn));
});

test('an ANNOTATED dump parses back — as the same graph, still unmeasured', () => {
  const asm = readFileSync(join(import.meta.dirname, 'corpus/agbcc-gcd.s'), 'utf8');
  const fn = frontendFor(ARMV4T_AGBCC).lift('gcd', asm, ARMV4T_AGBCC, {}, undefined, undefined);
  const annotated = print(fn, { writeOrder: true });
  // Both annotations are on the same dump: the block headers carry `; writes=N` and the
  // terminators `; order ^bbN(…)`, and either alone was enough to make `parse` fail.
  expect(annotated).toMatch(/\):\s+; writes=/);
  expect(annotated).toContain('; order ');
  const back = parse(annotated);
  expect(back.writeOrder).toBeUndefined();
  expect(print(back)).toBe(print(fn));
});

test('a `;` inside an operand is not a comment: the strip is anchored on the two annotations', () => {
  // `opaque` carries the instruction text asmlift could not model, and a list attr prints `[a;b]`.
  // A general trailing-comment strip would eat both.
  const ir = `fn semis {
^bb0(%0: s32):
  opaque %0 {text="swi #0; nop"}
  switch_br %0, ^bb1(), ^bb1(), ^bb1() {cases=[1;2]}
^bb1():
  ret %0
}
`;
  const fn = parse(ir);
  expect(fn.blocks[0].ops[0].attrs.text).toBe('swi #0; nop');
  expect(fn.blocks[0].ops[1].attrs.cases).toEqual([1, 2]);
  expect(print(fn)).toBe(ir);
});
